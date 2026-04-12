export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    const url = new URL(request.url);
    const ean    = url.searchParams.get('ean')    || '';
    const title  = url.searchParams.get('title')  || '';
    const artist = url.searchParams.get('artist') || '';

    // ── Spotify credentials ──────────────────────────────────
    const SPOTIFY_CLIENT_ID     = '9d42a0fa3bb74eada7e6b4659e5fcf0e';
    const SPOTIFY_CLIENT_SECRET = '6989af05077e493088e83f59a05bfb5e';

    // ── Helper: clean search string ──────────────────────────
    const clean = (s: string) =>
      s.replace(/\(.*?\)/g, '').replace(/feat\.?.*/i, '').trim();

    const catno  = url.searchParams.get('catno')  || '';

    // ── 1. Try Deezer by UPC/EAN (exact match, no auth needed) ──
    if (ean) {
      try {
        const r = await fetch(`https://api.deezer.com/album/upc/${ean}`);
        const d = await r.json() as any;
        if (d?.cover_xl && !d.cover_xl.includes('default')) {
          return json(d.cover_xl);
        }
        if (d?.cover_big && !d.cover_big.includes('default')) {
          return json(d.cover_big);
        }
      } catch {}
    }

    // ── 2. Try Spotify by title + artist ────────────────────
    try {
      // Get Spotify token (client credentials)
      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + btoa(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`),
        },
        body: 'grant_type=client_credentials',
      });
      const tokenData = await tokenRes.json() as any;
      const token = tokenData.access_token;

      if (token) {
        // Build query: title + artist + label + year for precision
        const label = url.searchParams.get('label') || '';
        const year  = url.searchParams.get('year')  || '';
        // catno alone is the most precise — try it first
        let q = catno ? catno : `${clean(title)} ${clean(artist)}`;
        if (!catno && label) q += ` ${clean(label)}`;
        if (!catno && year)  q += ` year:${year}`;
        const searchRes = await fetch(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=album&limit=3`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const searchData = await searchRes.json() as any;
        const items = searchData?.albums?.items || [];
        // Prefer exact title match if multiple results
        const match = items.find((i: any) =>
          i.name?.toLowerCase().includes(clean(title).toLowerCase())
        ) || items[0];
        const img = match?.images?.[0]?.url;
        if (img) return json(img);
      }
    } catch {}

    // ── 3. Fallback: Deezer by title + artist search ─────────
    try {
      const label = url.searchParams.get('label') || '';
      const q = encodeURIComponent(`${clean(title)} ${clean(artist)}${label ? ' ' + clean(label) : ''}`);
      const r = await fetch(`https://api.deezer.com/search/album?q=${q}&limit=3`);
      const d = await r.json() as any;
      const items = d?.data || [];
      const match = items.find((i: any) =>
        i.title?.toLowerCase().includes(clean(title).toLowerCase())
      ) || items[0];
      const img = match?.cover_xl || match?.cover_big;
      if (img && !img.includes('default')) return json(img);
    } catch {}

    // ── Nothing found ────────────────────────────────────────
    return json('');
  },
};

function json(imageUrl: string): Response {
  return new Response(JSON.stringify({ imageUrl }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}