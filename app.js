/* Passe-Playlist — copie une playlist Deezer publique dans un compte Spotify.
 * 100 % côté navigateur : aucune donnée ne passe par un serveur tiers.
 * Licence MIT.
 */
(() => {
  'use strict';

  const CFG = window.PP_CONFIG || {};
  const SPOTIFY_API = 'https://api.spotify.com/v1';
  const SPOTIFY_AUTH = 'https://accounts.spotify.com/authorize';
  const SPOTIFY_TOKEN = 'https://accounts.spotify.com/api/token';
  const DEEZER_API = 'https://api.deezer.com';
  const SCOPES = 'playlist-modify-private playlist-modify-public';
  const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
  const MATCH_THRESHOLD = 0.75;

  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- stockage
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
    json(k) { try { return JSON.parse(this.get(k) || 'null'); } catch { return null; } },
  };
  const clientId = () => (CFG.clientId || store.get('pp.clientId') || '').trim();

  class UserError extends Error {
    constructor(message, actions = []) { super(message); this.actions = actions; }
  }

  // ---------------------------------------------------------------- Deezer (JSONP)
  let jsonpSeq = 0;
  let lastDeezer = 0;

  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const cb = `__pp_cb_${Date.now()}_${jsonpSeq++}`;
      const script = document.createElement('script');
      const timer = setTimeout(() => { cleanup(); reject(new UserError('Deezer ne répond pas. Vérifie ta connexion.')); }, 20000);
      function cleanup() { clearTimeout(timer); delete window[cb]; script.remove(); }
      window[cb] = (data) => { cleanup(); resolve(data); };
      script.onerror = () => { cleanup(); reject(new UserError('Impossible de joindre Deezer. Vérifie ta connexion.')); };
      const u = new URL(url);
      u.searchParams.set('output', 'jsonp');
      u.searchParams.set('callback', cb);
      script.src = u.toString();
      document.head.appendChild(script);
    });
  }

  async function deezer(pathOrUrl) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : DEEZER_API + pathOrUrl;
    for (let attempt = 0; attempt < 5; attempt++) {
      const wait = 110 - (performance.now() - lastDeezer); // ~50 requêtes / 5 s
      if (wait > 0) await sleep(wait);
      lastDeezer = performance.now();
      const data = await jsonp(url);
      if (data && data.error) {
        if (data.error.code === 4) { await sleep(2000 * (attempt + 1)); continue; }
        if (data.error.code === 800) throw new UserError("Playlist introuvable sur Deezer. Vérifie qu'elle est bien publique.");
        throw new UserError('Deezer : ' + (data.error.message || 'erreur inconnue'));
      }
      return data;
    }
    throw new UserError('Deezer est saturé, réessaie dans une minute.');
  }

  const PLAYLIST_RE = /deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?playlist\/(\d+)/i;
  const SHORT_RE = /https?:\/\/(?:link\.deezer\.com|deezer\.page\.link|dzr\.page\.link)\/[^\s"'<>]+/i;
  const ANY_LINK_RE = /https?:\/\/[^\s"'<>]*deezer[^\s"'<>]*/i;

  function extractLink(text) {
    if (!text) return '';
    const m = text.match(SHORT_RE) || text.match(ANY_LINK_RE);
    return m ? m[0] : text.trim();
  }

  function matchPlaylistId(text) {
    if (!text) return null;
    const m = text.match(PLAYLIST_RE) || safeDecode(text).match(PLAYLIST_RE);
    return m ? m[1] : null;
  }
  function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

  async function resolvePlaylistId(input) {
    const value = input.trim();
    if (/^\d+$/.test(value)) return value;
    const direct = matchPlaylistId(value);
    if (direct) return direct;

    const short = value.match(SHORT_RE);
    if (!short) throw new UserError("Ce lien ne ressemble pas à une playlist Deezer. Dans Deezer : playlist → Partager → Copier le lien.");
    const link = short[0];

    // 1) Lecture directe (fonctionne seulement si Deezer l'autorise depuis une page web).
    try {
      const r = await fetch(link, { redirect: 'follow' });
      const id = matchPlaylistId(r.url) || matchPlaylistId(await r.text());
      if (id) return id;
    } catch { /* bloqué par le navigateur (CORS) : on passe au résolveur */ }

    // 2) Résolveur personnel (Cloudflare Worker, voir README).
    if (CFG.resolverUrl) {
      try {
        const r = await fetch(CFG.resolverUrl.replace(/\/$/, '') + '/?url=' + encodeURIComponent(link));
        const data = await r.json();
        const id = matchPlaylistId(data.url || '');
        if (id) return id;
        if (data.error === 'not_playlist') throw new UserError("Ce lien Deezer ne mène pas à une playlist (album ou titre ?).");
      } catch (e) {
        if (e instanceof UserError) throw e;
      }
    }

    throw new UserError(
      "Ce lien court Deezer ne peut pas être lu directement par l'appli. Ouvre-le dans un navigateur, " +
      "copie l'adresse complète (deezer.com/…/playlist/…) et colle-la ici.",
      [{ label: 'Ouvrir le lien', href: link }],
    );
  }

  async function fetchPlaylist(id, onProgress) {
    const meta = await deezer(`/playlist/${id}`);
    const total = meta.nb_tracks || 0;
    const tracks = [];
    let next = `/playlist/${id}/tracks?limit=100`;
    while (next) {
      const page = await deezer(next);
      for (const t of page.data || []) {
        if (t.type && t.type !== 'track') continue;
        tracks.push({
          deezerId: t.id,
          title: t.title || '',
          titleShort: t.title_short || t.title || '',
          artist: (t.artist && t.artist.name) || '',
          album: (t.album && t.album.title) || '',
          duration: t.duration || 0,
          isrc: t.isrc || null,
        });
      }
      next = page.next || null;
      onProgress(tracks.length, total || tracks.length);
    }
    const missing = tracks.filter((t) => !t.isrc && t.deezerId > 0);
    let done = 0;
    for (const t of missing) {
      try { t.isrc = (await deezer(`/track/${t.deezerId}`)).isrc || null; } catch { /* on fera une recherche texte */ }
      onProgress(tracks.length, tracks.length, ++done, missing.length);
    }
    return { title: meta.title || `Playlist Deezer ${id}`, creator: (meta.creator && meta.creator.name) || '', tracks };
  }

  // ---------------------------------------------------------------- Spotify (OAuth PKCE)
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function startLogin() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    store.set('pp.pkce', JSON.stringify({ verifier, state, clientId: clientId() }));
    location.assign(SPOTIFY_AUTH + '?' + new URLSearchParams({
      client_id: clientId(),
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    }));
  }

  function saveToken(data, previous) {
    const token = {
      clientId: clientId(),
      access: data.access_token,
      refresh: data.refresh_token || (previous && previous.refresh) || null,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };
    store.set('pp.token', JSON.stringify(token));
    return token;
  }

  async function tokenRequest(params) {
    const r = await fetch(SPOTIFY_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok && !!data.access_token, data };
  }

  async function handleCallback() {
    const params = new URLSearchParams(location.search);
    if (!params.has('code') && !params.has('error')) return false;
    const pkce = store.json('pp.pkce');
    history.replaceState(null, '', REDIRECT_URI);
    store.del('pp.pkce');
    if (params.get('error')) {
      throw new UserError(params.get('error') === 'access_denied'
        ? "Connexion à Spotify annulée."
        : 'Spotify a refusé la connexion : ' + params.get('error'));
    }
    if (!pkce || pkce.state !== params.get('state')) throw new UserError('Réponse de Spotify invalide. Réessaie.');
    const { ok, data } = await tokenRequest({
      grant_type: 'authorization_code',
      code: params.get('code'),
      redirect_uri: REDIRECT_URI,
      client_id: pkce.clientId || clientId(),
      code_verifier: pkce.verifier,
    });
    if (!ok) throw new UserError('Connexion Spotify impossible : ' + (data.error_description || data.error || 'erreur inconnue'));
    saveToken(data);
    return true;
  }

  async function getToken() {
    const t = store.json('pp.token');
    if (!t || t.clientId !== clientId()) return null;
    if (Date.now() < t.expiresAt - 60000) return t.access;
    if (!t.refresh) return null;
    const { ok, data } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: clientId() });
    if (!ok) { store.del('pp.token'); return null; }
    return saveToken(data, t).access;
  }

  async function spotify(method, path, { params, body } = {}) {
    const url = SPOTIFY_API + path + (params ? '?' + new URLSearchParams(params) : '');
    for (let attempt = 0; attempt < 6; attempt++) {
      const token = await getToken();
      if (!token) throw new UserError('Ta session Spotify a expiré. Relance la copie pour te reconnecter.');
      const r = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = r.status === 204 ? null : await r.json().catch(() => null);
      const err = (data && data.error) || {};
      if (r.ok) return data;
      if (r.status === 401 && attempt === 0) {
        const t = store.json('pp.token');
        if (t) { t.expiresAt = 0; store.set('pp.token', JSON.stringify(t)); }
        continue;
      }
      if (r.status === 429) {
        if (err.reason === 'QUOTA_EXCEEDED') throw new UserError("Le quota Spotify de l'application est atteint. Réessaie plus tard.");
        const retry = parseInt(r.headers.get('Retry-After') || '', 10);
        await sleep(Math.min(Number.isFinite(retry) ? retry : 2 * (attempt + 1), 60) * 1000 + 300);
        continue;
      }
      if (r.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
      if (r.status === 403) {
        throw new UserError("Spotify refuse l'accès. Ton compte doit être ajouté dans « User Management » de l'application Spotify, et son propriétaire doit avoir Premium.");
      }
      throw new UserError(`Spotify : ${err.message || 'erreur ' + r.status}`);
    }
    throw new UserError('Spotify ne répond pas correctement, réessaie dans quelques minutes.');
  }

  // ---------------------------------------------------------------- correspondance
  const VERSION_WORDS = 'feat|ft\\.|featuring|with|remaster|remastered|version|edit|radio|mono|stereo|deluxe|bonus|explicit';
  const PAREN_VERSION = new RegExp(`[(\\[][^)\\]]*\\b(${VERSION_WORDS})\\b[^)\\]]*[)\\]]`, 'gi');
  const DASH_VERSION = new RegExp(`\\s+-\\s+[^-]*\\b(${VERSION_WORDS})\\b.*$`, 'i');

  function normalize(text) {
    return (text || '')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(PAREN_VERSION, ' ')
      .replace(DASH_VERSION, ' ')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    let ratio = 1 - prev[n] / Math.max(m, n);
    if (Math.min(m, n) >= 4 && (a.includes(b) || b.includes(a))) ratio = Math.max(ratio, 0.9);
    return ratio;
  }

  function score(track, cand) {
    const name = normalize(cand.name);
    const title = Math.max(similarity(normalize(track.title), name), similarity(normalize(track.titleShort), name));
    const artist = Math.max(0, ...(cand.artists || []).map((a) => similarity(normalize(track.artist), normalize(a.name))));
    const dur = (cand.duration_ms || 0) / 1000;
    const durScore = track.duration ? 1 - Math.min(Math.abs(dur - track.duration) / 30, 1) : 1;
    return 0.55 * title + 0.35 * artist + 0.10 * durScore;
  }

  const queryText = (s) => (s || '').replace(PAREN_VERSION, ' ').replace(/"/g, ' ').replace(/\s+/g, ' ').trim();

  async function findMatch(track) {
    const base = { type: 'track', limit: '10', market: 'from_token' };
    const best = (items) => items.reduce((a, b) => (score(track, b) > score(track, a) ? b : a));
    if (track.isrc) {
      const res = await spotify('GET', '/search', { params: { ...base, q: `isrc:${track.isrc}` } });
      const items = (res && res.tracks && res.tracks.items) || [];
      if (items.length) return { match: best(items), method: 'isrc' };
    }
    const title = queryText(track.titleShort), artist = queryText(track.artist);
    for (const q of [`track:"${title}" artist:"${artist}"`, `${title} ${artist}`]) {
      const res = await spotify('GET', '/search', { params: { ...base, q } });
      const items = (res && res.tracks && res.tracks.items) || [];
      if (items.length) {
        const b = best(items);
        if (score(track, b) >= MATCH_THRESHOLD) return { match: b, method: 'texte' };
      }
    }
    return { match: null, method: '' };
  }

  // ---------------------------------------------------------------- interface
  const ui = {
    form: $('#form'), link: $('#link'), name: $('#name'), isPublic: $('#public'), go: $('#goBtn'),
    paste: $('#pasteBtn'), authHint: $('#authHint'),
    progressCard: $('#progressCard'), bar: $('#bar'), status: $('#status'), detail: $('#detail'),
    resultCard: $('#resultCard'), errorCard: $('#errorCard'), setupCard: $('#setupCard'),
  };

  function show(card) {
    for (const c of [ui.progressCard, ui.resultCard, ui.errorCard]) c.hidden = c !== card;
    ui.form.hidden = card === ui.resultCard;
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function setProgress(pct, status, detail = '') {
    ui.bar.style.width = `${Math.max(2, Math.min(100, pct))}%`;
    ui.status.textContent = status;
    ui.detail.textContent = detail;
  }

  function showError(err) {
    console.error(err);
    const message = err instanceof UserError ? err.message : 'Erreur inattendue : ' + (err && err.message ? err.message : err);
    $('#errorText').textContent = message;
    const actions = $('#errorActions');
    actions.replaceChildren();
    for (const a of (err && err.actions) || []) {
      const el = document.createElement('a');
      el.className = 'btn secondary'; el.href = a.href; el.target = '_blank'; el.rel = 'noopener';
      el.textContent = a.label;
      actions.appendChild(el);
    }
    show(ui.errorCard);
    ui.go.disabled = false;
  }

  function showResult({ name, url, found, total, missing }) {
    $('#resultTitle').textContent = name;
    $('#resultStats').textContent = `${found} titre${found > 1 ? 's' : ''} sur ${total} ajouté${found > 1 ? 's' : ''}.`;
    $('#openLink').href = url;
    $('#resultUrl').value = url;
    const box = $('#missingBox');
    box.hidden = missing.length === 0;
    $('#missingSummary').textContent = `${missing.length} titre${missing.length > 1 ? 's' : ''} introuvable${missing.length > 1 ? 's' : ''} sur Spotify`;
    const list = $('#missingList');
    list.replaceChildren(...missing.map((t) => {
      const li = document.createElement('li');
      li.textContent = `${t.artist} — ${t.title}`;
      return li;
    }));
    $('#shareBtn').hidden = !navigator.share;
    show(ui.resultCard);
    ui.go.disabled = false;
  }

  function refreshAuthHint() {
    const t = store.json('pp.token');
    const logged = t && t.clientId === clientId() && t.refresh;
    ui.authHint.textContent = logged ? '' : 'Au premier usage, tu seras redirigé vers Spotify pour autoriser la création de la playlist.';
    $('#accountState').textContent = logged ? 'Connecté à Spotify sur cet appareil.' : 'Pas encore connecté à Spotify.';
    ui.setupCard.hidden = !!clientId();
  }

  // ---------------------------------------------------------------- traitement
  async function run(input, options) {
    ui.go.disabled = true;
    show(ui.progressCard);
    setProgress(2, 'Connexion à Spotify…');

    if (!clientId()) throw new UserError("Le Client ID Spotify n'est pas configuré. Ouvre les réglages (en haut à droite).");
    if (!/^[0-9a-f]{32}$/i.test(clientId())) {
      throw new UserError(`Le Client ID Spotify semble incomplet (${clientId().length} caractères au lieu de 32). ` +
        "Recopie-le en entier depuis developer.spotify.com/dashboard → ton app → Settings, puis colle-le dans les réglages.");
    }
    if (!(await getToken())) {
      store.set('pp.pending', JSON.stringify({ input, options }));
      setProgress(5, 'Redirection vers Spotify…');
      await startLogin();
      return;
    }

    setProgress(5, 'Lecture du lien Deezer…');
    const id = await resolvePlaylistId(input);

    const { title, tracks } = await fetchPlaylist(id, (got, total, isrcDone, isrcTotal) => {
      if (isrcTotal) setProgress(10 + 10 * (isrcDone / isrcTotal), 'Lecture de la playlist Deezer…', `Identification des titres : ${isrcDone}/${isrcTotal}`);
      else setProgress(5 + 5 * (got / Math.max(total, 1)), 'Lecture de la playlist Deezer…', `${got} titres`);
    });
    if (!tracks.length) throw new UserError('Cette playlist Deezer est vide.');

    const uris = [], missing = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      setProgress(20 + 72 * (i / tracks.length), `Recherche sur Spotify : ${i + 1}/${tracks.length}`, `${t.artist} · ${t.title}`);
      const { match } = await findMatch(t);
      if (match) uris.push(match.uri); else missing.push(t);
    }
    if (!uris.length) throw new UserError("Aucun titre de cette playlist n'a été trouvé sur Spotify.");

    const name = (options.name || title).slice(0, 100);
    setProgress(94, 'Création de la playlist…');
    const playlist = await spotify('POST', '/me/playlists', {
      body: { name, public: !!options.public, description: `Copiée depuis Deezer (${title}) avec Passe-Playlist`.slice(0, 300) },
    });
    for (let i = 0; i < uris.length; i += 100) {
      await spotify('POST', `/playlists/${playlist.id}/items`, { body: { uris: uris.slice(i, i + 100) } });
    }
    setProgress(100, 'Terminé');
    showResult({
      name,
      url: (playlist.external_urls && playlist.external_urls.spotify) || `https://open.spotify.com/playlist/${playlist.id}`,
      found: uris.length, total: tracks.length, missing,
    });
  }

  function start(input, options) {
    run(input, options).catch(showError);
  }

  // ---------------------------------------------------------------- événements
  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = extractLink(ui.link.value);
    if (!input) return;
    ui.link.value = input;
    start(input, { name: ui.name.value.trim(), public: ui.isPublic.checked });
  });

  if (navigator.clipboard && navigator.clipboard.readText) {
    ui.paste.hidden = false;
    ui.paste.addEventListener('click', async () => {
      try { ui.link.value = extractLink(await navigator.clipboard.readText()); ui.link.focus(); } catch { ui.link.focus(); }
    });
  }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch {
      const tmp = document.createElement('textarea'); tmp.value = text; document.body.appendChild(tmp); tmp.select();
      try { document.execCommand('copy'); } catch { /* rien */ } tmp.remove();
    }
    const old = btn.textContent; btn.textContent = 'Copié ✓'; setTimeout(() => { btn.textContent = old; }, 1500);
  }
  $('#copyBtn').addEventListener('click', (e) => copy($('#resultUrl').value, e.currentTarget));
  $('#shareBtn').addEventListener('click', () => {
    navigator.share({ title: $('#resultTitle').textContent, url: $('#resultUrl').value }).catch(() => {});
  });
  $('#againBtn').addEventListener('click', () => {
    ui.link.value = ''; ui.name.value = '';
    show(null); ui.link.focus();
  });

  const dlg = $('#settings');
  function openSettings() {
    $('#clientIdRow').hidden = !!CFG.clientId;
    $('#clientId').value = store.get('pp.clientId') || '';
    $('#redirectUri').value = REDIRECT_URI;
    refreshAuthHint();
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  $('#settingsBtn').addEventListener('click', openSettings);
  document.querySelectorAll('[data-open-settings]').forEach((b) => b.addEventListener('click', openSettings));
  $('#copyRedirect').addEventListener('click', (e) => copy(REDIRECT_URI, e.currentTarget));
  $('#logoutBtn').addEventListener('click', () => { store.del('pp.token'); refreshAuthHint(); });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'save' && !CFG.clientId) {
      const v = $('#clientId').value.replace(/\s+/g, '');
      if (v) store.set('pp.clientId', v); else store.del('pp.clientId');
    }
    refreshAuthHint();
  });

  // ---------------------------------------------------------------- démarrage
  async function boot() {
    refreshAuthHint();
    const params = new URLSearchParams(location.search);

    // Partage depuis l'appli Deezer (Android, appli installée) : ?text=… ou ?url=…
    const shared = extractLink([params.get('url'), params.get('text'), params.get('title')].filter(Boolean).join(' '));
    if (shared && !params.has('code')) {
      history.replaceState(null, '', REDIRECT_URI);
      ui.link.value = shared;
      start(shared, { name: '', public: false });
      return;
    }

    try {
      if (await handleCallback()) {
        refreshAuthHint();
        const pending = store.json('pp.pending');
        store.del('pp.pending');
        if (pending && pending.input) {
          ui.link.value = pending.input;
          ui.name.value = (pending.options && pending.options.name) || '';
          ui.isPublic.checked = !!(pending.options && pending.options.public);
          start(pending.input, pending.options || {});
        }
      }
    } catch (e) {
      store.del('pp.pending');
      showError(e);
    }
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Exposé pour les tests
  window.__pp = { normalize, similarity, score, extractLink, matchPlaylistId };

  boot();
})();
