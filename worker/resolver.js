// Résolveur de liens courts Deezer pour Passe-Playlist (Cloudflare Worker, offre gratuite).
//
// Pourquoi ? Une page web ne peut pas suivre les liens link.deezer.com/s/… (le navigateur bloque).
// Ce worker suit le lien et renvoie l'adresse complète de la playlist. Il ne lit QUE les liens
// courts Deezer (ce n'est pas un proxy ouvert) et ne stocke rien.
//
// GET https://<ton-worker>.workers.dev/?url=https://link.deezer.com/s/xxxx
// → { "url": "https://www.deezer.com/fr/playlist/123456" }

const ALLOWED_HOSTS = ['link.deezer.com', 'deezer.page.link', 'dzr.page.link'];
const PLAYLIST_RE = /deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?playlist\/\d+/i;
const ANY_DEEZER_RE = /https?:\/\/(?:www\.)?deezer\.com\/[^\s"'<>]+/i;

// Mets ici l'adresse de ton GitHub Pages pour restreindre l'usage (ou "*" pour tout autoriser).
const ALLOWED_ORIGIN = '*';

export default {
  async fetch(request) {
    const headers = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers });
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });

    let target;
    try { target = new URL(new URL(request.url).searchParams.get('url') || ''); } catch { return reply({ error: 'bad_url' }, 400); }
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.includes(target.hostname)) return reply({ error: 'forbidden_host' }, 403);

    const res = await fetch(target.toString(), {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PassePlaylist/1.0)' },
    });
    let finalUrl = res.url;
    if (!PLAYLIST_RE.test(decodeURIComponent(finalUrl))) {
      const html = await res.text();
      const m = html.match(PLAYLIST_RE);
      if (m) finalUrl = 'https://www.' + m[0];
      else {
        const other = html.match(ANY_DEEZER_RE);
        return reply({ error: 'not_playlist', url: other ? other[0] : finalUrl });
      }
    }
    return reply({ url: decodeURIComponent(finalUrl) });
  },
};
