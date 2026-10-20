#!/usr/bin/env python3
"""Synchronisation Deezer ⇄ Spotify pour Passe-Playlist.

Exécuté par GitHub Actions (voir .github/workflows/sync.yml), sans dépendance externe.

Règles, pour chaque paire déclarée dans sync/pairs/*.json :
  • Deezer → Spotify (automatique) : un titre ajouté sur Deezer est ajouté sur Spotify,
    un titre retiré de Deezer est retiré de Spotify (miroir).
  • Spotify → Deezer (semi-automatique, l'API Deezer n'accepte plus d'écriture) :
    un titre ajouté sur Spotify est listé « à ajouter sur Deezer » ;
    un titre retiré de Spotify mais encore sur Deezer est listé « à retirer sur Deezer ».
    Dès que le changement est fait sur Deezer, l'entrée disparaît au passage suivant.

L'état est écrit dans sync/state/ (publié avec le site) uniquement quand il change.
"""
from __future__ import annotations

import difflib
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAIRS_DIR = ROOT / "sync" / "pairs"
STATE_DIR = ROOT / "sync" / "state"
TOKEN_FILE = ROOT / ".token.enc"

DEEZER_API = "https://api.deezer.com"
SPOTIFY_API = "https://api.spotify.com/v1"
SPOTIFY_TOKEN = "https://accounts.spotify.com/api/token"
USER_AGENT = "passe-playlist-sync/1.0"
MATCH_THRESHOLD = 0.75
RETRY_UNMATCHED_AFTER = 24 * 3600  # on ne recherche un titre introuvable qu'une fois par jour


class SyncError(Exception):
    pass


def log(msg: str):
    print(msg, flush=True)


# --------------------------------------------------------------------------- HTTP
def http_json(method, url, *, headers=None, data=None, form=None, timeout=30):
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    hdrs.update(headers or {})
    body = None
    if form is not None:
        body = urllib.parse.urlencode(form).encode()
        hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    elif data is not None:
        body = json.dumps(data).encode()
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw, status, rh = resp.read(), resp.status, resp.headers
    except urllib.error.HTTPError as exc:
        raw, status, rh = exc.read(), exc.code, exc.headers
    except urllib.error.URLError as exc:
        raise SyncError(f"connexion impossible à {urllib.parse.urlparse(url).netloc} : {exc.reason}") from exc
    try:
        payload = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        payload = None
    return status, rh, payload


# --------------------------------------------------------------------------- Deezer (lecture publique)
class Deezer:
    def __init__(self):
        self._last = 0.0

    def get(self, path: str) -> dict | None:
        """Renvoie le JSON, ou None si l'objet n'existe pas (erreur 800)."""
        url = path if path.startswith("http") else DEEZER_API + path
        for attempt in range(5):
            wait = 0.11 - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            status, _, payload = http_json("GET", url)
            if isinstance(payload, dict) and "error" in payload:
                code = (payload["error"] or {}).get("code")
                if code == 4:
                    time.sleep(2 * (attempt + 1))
                    continue
                if code == 800:
                    return None
                raise SyncError(f"Deezer : {payload['error'].get('message')}")
            if status >= 500:
                time.sleep(1 + attempt)
                continue
            if status != 200 or not isinstance(payload, dict):
                raise SyncError(f"Deezer : HTTP {status}")
            return payload
        raise SyncError("Deezer : trop de tentatives")

    def playlist(self, pid: str) -> tuple[str, list[dict]]:
        meta = self.get(f"/playlist/{pid}")
        if meta is None:
            raise SyncError(f"playlist Deezer {pid} introuvable (est-elle toujours publique ?)")
        tracks, url = [], f"/playlist/{pid}/tracks?limit=100"
        while url:
            page = self.get(url) or {}
            for t in page.get("data", []):
                if t.get("type", "track") != "track" or not t.get("id"):
                    continue
                tracks.append({
                    "id": str(t["id"]),
                    "title": t.get("title") or "",
                    "title_short": t.get("title_short") or t.get("title") or "",
                    "artist": (t.get("artist") or {}).get("name", ""),
                    "duration": int(t.get("duration") or 0),
                    "isrc": t.get("isrc") or None,
                })
            url = page.get("next")
        return meta.get("title") or "", tracks

    def isrc_of(self, track_id: str) -> str | None:
        data = self.get(f"/track/{track_id}")
        return (data or {}).get("isrc") or None

    def track_by_isrc(self, isrc: str) -> dict | None:
        data = self.get(f"/track/isrc:{urllib.parse.quote(isrc)}")
        return data if data and data.get("id") else None


# --------------------------------------------------------------------------- Spotify
def read_client_id() -> str:
    cid = os.environ.get("SPOTIFY_CLIENT_ID", "").strip()
    if not cid:
        try:
            m = re.search(r'clientId\s*:\s*["\']([0-9a-fA-F]{32})["\']', (ROOT / "config.js").read_text())
            cid = m.group(1) if m else ""
        except OSError:
            pass
    if not re.fullmatch(r"[0-9a-fA-F]{32}", cid):
        raise SyncError("Client ID Spotify absent : renseigne clientId dans config.js ou le secret SPOTIFY_CLIENT_ID.")
    return cid


def _openssl(extra: list[str], data: bytes) -> bytes:
    return subprocess.run(
        ["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-pass", "env:SYNC_KEY", *extra],
        input=data, capture_output=True, check=True,
    ).stdout


def _load_cached_refresh() -> str | None:
    if not (TOKEN_FILE.exists() and os.environ.get("SYNC_KEY")):
        return None
    try:
        return _openssl(["-d"], TOKEN_FILE.read_bytes()).decode().strip() or None
    except (subprocess.CalledProcessError, UnicodeDecodeError):
        return None


def _save_refresh(token: str):
    if not os.environ.get("SYNC_KEY"):
        log("⚠ SYNC_KEY absent : le jeton renouvelé par Spotify ne peut pas être conservé.")
        return
    TOKEN_FILE.write_bytes(_openssl([], token.encode()))


def spotify_access_token(client_id: str) -> str:
    candidates = []
    for tok in (_load_cached_refresh(), os.environ.get("SPOTIFY_REFRESH_TOKEN", "").strip()):
        if tok and tok not in candidates:
            candidates.append(tok)
    if not candidates:
        raise SyncError("Secret SPOTIFY_REFRESH_TOKEN manquant (à générer depuis les réglages de l'appli).")
    detail = ""
    for tok in candidates:
        status, _, payload = http_json("POST", SPOTIFY_TOKEN, form={
            "grant_type": "refresh_token", "refresh_token": tok, "client_id": client_id,
        })
        if status == 200 and payload and payload.get("access_token"):
            _save_refresh(payload.get("refresh_token") or tok)
            return payload["access_token"]
        detail = (payload or {}).get("error_description") or (payload or {}).get("error") or f"HTTP {status}"
    raise SyncError(f"Spotify refuse le jeton de synchro ({detail}). Régénère-le depuis les réglages de l'appli "
                    "et mets à jour le secret SPOTIFY_REFRESH_TOKEN.")


class Spotify:
    def __init__(self, access_token: str):
        self.token = access_token

    def api(self, method: str, path: str, *, params=None, data=None):
        url = (path if path.startswith("http") else SPOTIFY_API + path) + ("?" + urllib.parse.urlencode(params) if params else "")
        for attempt in range(6):
            status, headers, payload = http_json(method, url, data=data,
                                                 headers={"Authorization": f"Bearer {self.token}"})
            err = (payload or {}).get("error") if isinstance(payload, dict) else None
            err = err if isinstance(err, dict) else {}
            if status == 429:
                if err.get("reason") == "QUOTA_EXCEEDED":
                    raise SyncError("quota Spotify atteint")
                retry = (headers.get("Retry-After") if headers else None) or ""
                time.sleep(min(int(retry) if retry.isdigit() else 2 * (attempt + 1), 60) + 0.5)
                continue
            if status >= 500:
                time.sleep(1 + attempt)
                continue
            if status >= 400:
                raise SyncError(f"Spotify {method} {path} : HTTP {status} — {err.get('message') or payload}")
            return payload
        raise SyncError("Spotify ne répond pas correctement")

    def playlist_items(self, pid: str) -> list[dict]:
        items, url, params = [], f"/playlists/{pid}/items", {"limit": 50}
        while url:
            page = self.api("GET", url, params=params) or {}
            params = None
            for it in page.get("items", []):
                tr = it.get("item") or it.get("track") or {}
                uri = tr.get("uri") or ""
                if not uri.startswith("spotify:track:"):
                    continue
                items.append({
                    "uri": uri,
                    "name": tr.get("name") or "",
                    "artist": ", ".join(a.get("name", "") for a in tr.get("artists", [])),
                    "isrc": ((tr.get("external_ids") or {}).get("isrc") or "").upper() or None,
                    "added_by": ((it.get("added_by") or {}).get("id")) or "",
                    "added_at": it.get("added_at") or "",
                })
            url = page.get("next")
        return items

    def add(self, pid: str, uris: list[str]):
        for i in range(0, len(uris), 100):
            self.api("POST", f"/playlists/{pid}/items", data={"uris": uris[i:i + 100]})

    def remove(self, pid: str, uris: list[str]):
        for i in range(0, len(uris), 100):
            self.api("DELETE", f"/playlists/{pid}/items", data={"items": [{"uri": u} for u in uris[i:i + 100]]})


# --------------------------------------------------------------------------- correspondance
VERSION_WORDS = r"feat|ft\.|featuring|with|remaster|remastered|version|edit|radio|mono|stereo|deluxe|bonus|explicit"


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    text = re.sub(rf"[\(\[][^\)\]]*\b({VERSION_WORDS})\b[^\)\]]*[\)\]]", " ", text)
    text = re.sub(rf"\s+-\s+[^-]*\b({VERSION_WORDS})\b.*$", " ", text)
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio() if a and b else 0.0


def score(d: dict, cand: dict) -> float:
    name = normalize(cand.get("name", ""))
    title = max(_ratio(normalize(d["title"]), name), _ratio(normalize(d["title_short"]), name))
    artist = max((_ratio(normalize(d["artist"]), normalize(a.get("name", ""))) for a in cand.get("artists", [])), default=0.0)
    dur = (cand.get("duration_ms") or 0) / 1000
    dscore = 1.0 if not d["duration"] else 1 - min(abs(dur - d["duration"]) / 30, 1.0)
    return 0.55 * title + 0.35 * artist + 0.10 * dscore


def _query_text(text: str) -> str:
    text = re.sub(rf"[\(\[][^\)\]]*\b({VERSION_WORDS})\b[^\)\]]*[\)\]]", " ", text or "", flags=re.I)
    return re.sub(r"\s+", " ", text.replace('"', " ")).strip()


def find_on_spotify(sp: Spotify, d: dict) -> str | None:
    base = {"type": "track", "limit": 10, "market": "from_token"}
    if d.get("isrc"):
        res = sp.api("GET", "/search", params={**base, "q": f"isrc:{d['isrc']}"}) or {}
        items = (res.get("tracks") or {}).get("items") or []
        if items:
            return max(items, key=lambda c: score(d, c))["uri"]
    title, artist = _query_text(d["title_short"]), _query_text(d["artist"])
    for q in (f'track:"{title}" artist:"{artist}"', f"{title} {artist}"):
        res = sp.api("GET", "/search", params={**base, "q": q}) or {}
        items = (res.get("tracks") or {}).get("items") or []
        if items:
            best = max(items, key=lambda c: score(d, c))
            if score(d, best) >= MATCH_THRESHOLD:
                return best["uri"]
    return None


# --------------------------------------------------------------------------- synchronisation d'une paire
def empty_state() -> dict:
    return {"linked": [], "to_deezer": [], "to_remove_deezer": [], "unmatched": []}


def deezer_url(track_id) -> str:
    return f"https://www.deezer.com/track/{track_id}"


def deezer_search_url(artist: str, title: str) -> str:
    return "https://www.deezer.com/search/" + urllib.parse.quote(f"{artist} {title}".strip())


def sync_pair(pair: dict, dz: Deezer, sp: Spotify, state: dict, now: float) -> tuple[dict, list[str]]:
    """Fait un passage de synchro. Renvoie (nouvel état, journal des changements)."""
    events: list[str] = []
    dz_title, D = dz.playlist(pair["deezer"])
    S = sp.playlist_items(pair["spotify"])
    d_by_id = {d["id"]: d for d in D}
    s_by_uri = {s["uri"]: s for s in S}

    linked = state.get("linked", [])
    if linked and not D:
        raise SyncError("la playlist Deezer apparaît vide : synchro suspendue par sécurité")

    # Garde-fou : si plus de la moitié des titres disparaissent d'un coup de Deezer, on ne supprime rien.
    gone = [L for L in linked if L["deezer_id"] not in d_by_id and L["uri"] in s_by_uri]
    allow_delete = not (len(gone) > max(5, len(linked) // 2))
    if not allow_delete:
        events.append(f"⚠ {len(gone)} titres absents de Deezer d'un coup : aucune suppression appliquée par sécurité")

    new_linked, remove_from_spotify = [], []
    to_remove_deezer = {R["deezer_id"]: R for R in state.get("to_remove_deezer", [])}

    for L in linked:
        in_d, in_s = L["deezer_id"] in d_by_id, L["uri"] in s_by_uri
        if in_d and in_s:
            new_linked.append(L)
        elif in_s:  # retiré de Deezer → miroir sur Spotify
            if allow_delete:
                remove_from_spotify.append(L["uri"])
                events.append(f"− Spotify : {L['artist']} — {L['title']} (retiré de Deezer)")
            else:
                new_linked.append(L)
        elif in_d:  # retiré de Spotify mais encore sur Deezer
            if L["deezer_id"] not in to_remove_deezer:
                to_remove_deezer[L["deezer_id"]] = {**L, "deezer_url": deezer_url(L["deezer_id"]), "since": int(now)}
                events.append(f"→ à retirer sur Deezer : {L['artist']} — {L['title']}")

    remaining_remove = []
    for R in to_remove_deezer.values():
        if R["deezer_id"] not in d_by_id:
            events.append(f"✓ retiré sur Deezer : {R['artist']} — {R['title']}")
            continue
        if R["uri"] in s_by_uri:  # remis sur Spotify entre-temps
            new_linked.append({k: R[k] for k in ("deezer_id", "uri", "isrc", "title", "artist")})
            continue
        remaining_remove.append(R)

    linked_d = {L["deezer_id"] for L in new_linked}
    linked_u = {L["uri"] for L in new_linked}
    pending_d = {R["deezer_id"] for R in remaining_remove}
    unmatched = {U["deezer_id"]: U for U in state.get("unmatched", []) if U["deezer_id"] in d_by_id}
    to_add: list[str] = []

    # Titres Deezer pas encore reliés : on cherche/ajoute sur Spotify
    for d in D:
        if d["id"] in linked_d or d["id"] in pending_d:
            continue
        U = unmatched.get(d["id"])
        if U and now - U.get("tried", 0) < RETRY_UNMATCHED_AFTER:
            continue
        if not d.get("isrc"):
            d["isrc"] = dz.isrc_of(d["id"])
        isrc = (d.get("isrc") or "").upper() or None
        uri = None
        if isrc:  # déjà présent sur Spotify (ajouté par un ami puis reporté sur Deezer, ou 1re synchro)
            uri = next((s["uri"] for s in S if s["isrc"] == isrc and s["uri"] not in linked_u), None)
        if not uri:
            uri = find_on_spotify(sp, d)
        if not uri:
            if not U:
                events.append(f"? introuvable sur Spotify : {d['artist']} — {d['title']}")
            unmatched[d["id"]] = {"deezer_id": d["id"], "title": d["title"], "artist": d["artist"],
                                  "deezer_url": deezer_url(d["id"]), "tried": int(now)}
            continue
        unmatched.pop(d["id"], None)
        linked_d.add(d["id"])
        if uri in linked_u:  # doublon côté Deezer d'un titre déjà relié
            continue
        if uri not in s_by_uri and uri not in to_add:
            to_add.append(uri)
            events.append(f"+ Spotify : {d['artist']} — {d['title']}")
        new_linked.append({"deezer_id": d["id"], "uri": uri, "isrc": isrc, "title": d["title"], "artist": d["artist"]})
        linked_u.add(uri)

    # Titres présents seulement sur Spotify → à ajouter sur Deezer
    old_td = {T["uri"]: T for T in state.get("to_deezer", [])}
    to_deezer = []
    removed = set(remove_from_spotify)
    for s in S:
        if (s["uri"] in linked_u or s["uri"] in to_add or s["uri"] in removed
                or any(t["uri"] == s["uri"] for t in to_deezer)):
            continue
        T = old_td.get(s["uri"])
        if not T:
            match = dz.track_by_isrc(s["isrc"]) if s["isrc"] else None
            T = {
                "uri": s["uri"], "title": s["name"], "artist": s["artist"], "isrc": s["isrc"],
                "deezer_id": str(match["id"]) if match else None,
                "deezer_url": deezer_url(match["id"]) if match else deezer_search_url(s["artist"], s["name"]),
                "added_by": s["added_by"], "added_at": s["added_at"],
            }
            events.append(f"→ à ajouter sur Deezer : {s['artist']} — {s['name']}"
                          + ("" if match else " (pas trouvé automatiquement sur Deezer)"))
        to_deezer.append(T)
    for uri, T in old_td.items():
        if uri not in s_by_uri:
            events.append(f"✓ plus à ajouter (retiré de Spotify) : {T['artist']} — {T['title']}")

    if remove_from_spotify:
        sp.remove(pair["spotify"], remove_from_spotify)
    if to_add:
        sp.add(pair["spotify"], to_add)

    new_state = {
        "linked": sorted(new_linked, key=lambda x: x["deezer_id"]),
        "to_deezer": to_deezer,
        "to_remove_deezer": remaining_remove,
        "unmatched": sorted(unmatched.values(), key=lambda x: x["deezer_id"]),
        "deezer_title": dz_title,
    }
    return new_state, events


# --------------------------------------------------------------------------- programme principal
def _strip_volatile(state: dict) -> dict:
    """État comparable : sans horodatage de dernière modification ni dates de tentative."""
    s = {k: v for k, v in state.items() if k != "updated_at"}
    s["unmatched"] = [{k: v for k, v in u.items() if k != "tried"} for u in s.get("unmatched", [])]
    return s


def load_pairs() -> list[dict]:
    pairs = []
    for f in sorted(PAIRS_DIR.glob("*.json")):
        try:
            p = json.loads(f.read_text())
            p["deezer"], p["spotify"] = str(p["deezer"]).strip(), str(p["spotify"]).strip()
            if not (p["deezer"].isdigit() and re.fullmatch(r"[A-Za-z0-9]{10,40}", p["spotify"])):
                raise ValueError("identifiants invalides")
            p["key"] = f.stem
            pairs.append(p)
        except (ValueError, KeyError, json.JSONDecodeError) as exc:
            log(f"⚠ {f.name} ignoré : {exc}")
    return pairs


def write_if_changed(path: Path, data) -> bool:
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if path.exists() and path.read_text() == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return True


def summary_entry(pair: dict, state: dict, error: str | None) -> dict:
    return {
        "key": pair["key"],
        "name": pair.get("name") or state.get("deezer_title") or pair["deezer"],
        "deezer_url": f"https://www.deezer.com/playlist/{pair['deezer']}",
        "spotify_url": f"https://open.spotify.com/playlist/{pair['spotify']}",
        "synced": len(state.get("linked", [])),
        "updated_at": state.get("updated_at"),
        "error": error,
        "to_deezer": [{k: t.get(k) for k in ("title", "artist", "deezer_url", "deezer_id", "added_by")}
                      for t in state.get("to_deezer", [])],
        "to_remove_deezer": [{k: t.get(k) for k in ("title", "artist", "deezer_url")}
                             for t in state.get("to_remove_deezer", [])],
        "unmatched": [{k: t.get(k) for k in ("title", "artist", "deezer_url")} for t in state.get("unmatched", [])],
    }


def main() -> int:
    pairs = load_pairs()
    if not pairs:
        log("Aucune playlist à synchroniser (dossier sync/pairs vide).")
        write_if_changed(STATE_DIR / "index.json", {"pairs": []})
        return 0

    now = time.time()
    sp = Spotify(spotify_access_token(read_client_id()))
    dz = Deezer()
    summary, failures, report = [], 0, []

    for pair in pairs:
        state_path = STATE_DIR / f"{pair['key']}.json"
        try:
            state = json.loads(state_path.read_text())
        except (OSError, json.JSONDecodeError):
            state = empty_state()
        error = None
        try:
            new_state, events = sync_pair(pair, dz, sp, state, now)
            # updated_at ne bouge que sur un vrai changement ; les dates de nouvelle tentative
            # (au plus une fois par jour) sont enregistrées sans le modifier.
            if _strip_volatile(new_state) != _strip_volatile(state):
                new_state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
            else:
                new_state["updated_at"] = state.get("updated_at")
            write_if_changed(state_path, new_state)
            state = new_state
            label = pair.get("name") or state.get("deezer_title") or pair["key"]
            log(f"■ {label} : {len(state['linked'])} titres synchronisés, "
                f"{len(state['to_deezer'])} à ajouter sur Deezer, {len(state['to_remove_deezer'])} à retirer sur Deezer")
            for e in events:
                log("   " + e)
            report += [f"### {label}"] + [f"- {e}" for e in events or ["aucun changement"]]
        except SyncError as exc:
            failures += 1
            error = str(exc)
            log(f"✗ {pair['key']} : {exc}")
            report.append(f"### {pair['key']}\n- ✗ {exc}")
        summary.append(summary_entry(pair, state, error))

    prev_index = {}
    try:
        prev_index = json.loads((STATE_DIR / "index.json").read_text())
    except (OSError, json.JSONDecodeError):
        pass
    if prev_index.get("pairs") != summary:
        write_if_changed(STATE_DIR / "index.json", {"pairs": summary})

    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write("## Synchronisation Passe-Playlist\n\n" + "\n".join(report) + "\n")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SyncError as exc:
        log(f"✗ {exc}")
        sys.exit(1)
