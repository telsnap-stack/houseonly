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
        // Build precise query: title + artist + label + year
        let q = `${clean(title)} ${clean(artist)}`;
        if (label) q += ` ${clean(label)}`;
        if (year)  q += ` year:${year}`;

        const searchRes = await fetch(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=album&limit=5`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const searchData = await searchRes.json() as any;
        const items = searchData?.albums?.items || [];

        // Score results: prefer exact title match + year match
        const scored = items.map((item: any) => {
          let score = 0;
          const itemTitle = item.name?.toLowerCase() || '';
          const itemYear = item.release_date?.slice(0,4) || '';
          if (itemTitle.includes(clean(title).toLowerCase())) score += 3;
          if (year && itemYear === String(year)) score += 2;
          if (item.artists?.[0]?.name?.toLowerCase().includes(clean(artist).toLowerCase())) score += 1;
          return { item, score };
        });
        scored.sort((a: any, b: any) => b.score - a.score);
        const img = scored[0]?.item?.images?.[0]?.url;
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

    // ── 4. iTunes Search API (no auth, broad catalog) ──────────
    try {
      const q = encodeURIComponent(`${clean(title)} ${clean(artist)}`);
      const r = await fetch(
        `https://itunes.apple.com/search?term=${q}&entity=album&limit=5&media=music`
      );
      const d = await r.json() as any;
      const results = (d.results || []).filter((i: any) => i.artworkUrl100);
      // Score by title + artist match
      const scored = results.map((i: any) => {
        let score = 0;
        const t = (i.collectionName || '').toLowerCase();
        const a = (i.artistName || '').toLowerCase();
        if (t.includes(clean(title).toLowerCase())) score += 3;
        if (a.includes(clean(artist).toLowerCase())) score += 2;
        return { i, score };
      });
      scored.sort((a: any, b: any) => b.score - a.score);
      const best = scored[0]?.i;
      if (best?.artworkUrl100) {
        // Get high-res version (replace 100x100 with 600x600)
        const hires = best.artworkUrl100.replace('100x100bb', '600x600bb');
        return json(hires);
      }
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