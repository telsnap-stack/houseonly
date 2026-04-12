interface Env {
  R2: R2Bucket;
}

const R2_PUBLIC         = 'https://pub-7e5c9e2f45b3409383e7f23a2cb7028d.r2.dev';
const SPOTIFY_CLIENT_ID = '9d42a0fa3bb74eada7e6b4659e5fcf0e';
const SPOTIFY_CLIENT_SECRET = '6989af05077e493088e83f59a05bfb5e';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const clean = (s: string) =>
  s.replace(/\(.*?\)/g, '').replace(/feat\.?.*/i, '').trim();

function jsonRes(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    // ── POST: upload file to R2 ──────────────────────────────
    if (request.method === 'POST') {
      const action = url.searchParams.get('action');
      if (action === 'upload') {
        try {
          const fd   = await request.formData();
          const file = fd.get('file') as File;
          const key  = fd.get('key')  as string;
          if (!file || !key) return jsonRes({ error: 'Missing file or key' }, 400);
          await env.R2.put(key, await file.arrayBuffer(), {
            httpMetadata: { contentType: file.type || 'application/octet-stream' },
          });
          return jsonRes({ url: `${R2_PUBLIC}/${key}` });
        } catch (e: any) {
          return jsonRes({ error: e.message }, 500);
        }
      }
      return jsonRes({ error: 'Unknown action' }, 400);
    }

    // ── GET: cover art lookup ────────────────────────────────
    const ean    = url.searchParams.get('ean')    || '';
    const title  = url.searchParams.get('title')  || '';
    const artist = url.searchParams.get('artist') || '';
    const label  = url.searchParams.get('label')  || '';
    const year   = url.searchParams.get('year')   || '';

    // 1. Deezer by EAN/UPC
    if (ean) {
      try {
        const r = await fetch(`https://api.deezer.com/album/upc/${ean}`);
        const d = await r.json() as any;
        if (d?.cover_xl && !d.cover_xl.includes('default')) return jsonRes({ imageUrl: d.cover_xl });
        if (d?.cover_big && !d.cover_big.includes('default')) return jsonRes({ imageUrl: d.cover_big });
      } catch {}
    }

    // 2. Spotify by title + artist + label + year
    try {
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
        let q = `${clean(title)} ${clean(artist)}`;
        if (label) q += ` ${clean(label)}`;
        if (year)  q += ` year:${year}`;
        const searchRes = await fetch(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=album&limit=5`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const searchData = await searchRes.json() as any;
        const items = searchData?.albums?.items || [];
        const scored = items.map((item: any) => {
          let score = 0;
          if (item.name?.toLowerCase().includes(clean(title).toLowerCase())) score += 3;
          if (year && item.release_date?.slice(0, 4) === String(year)) score += 2;
          if (item.artists?.[0]?.name?.toLowerCase().includes(clean(artist).toLowerCase())) score += 1;
          return { item, score };
        });
        scored.sort((a: any, b: any) => b.score - a.score);
        const img = scored[0]?.item?.images?.[0]?.url;
        if (img) return jsonRes({ imageUrl: img });
      }
    } catch {}

    // 3. Deezer search
    try {
      const q = encodeURIComponent(`${clean(title)} ${clean(artist)}${label ? ' ' + clean(label) : ''}`);
      const r = await fetch(`https://api.deezer.com/search/album?q=${q}&limit=3`);
      const d = await r.json() as any;
      const items = d?.data || [];
      const match = items.find((i: any) =>
        i.title?.toLowerCase().includes(clean(title).toLowerCase())
      ) || items[0];
      const img = match?.cover_xl || match?.cover_big;
      if (img && !img.includes('default')) return jsonRes({ imageUrl: img });
    } catch {}

    // 4. iTunes
    try {
      const q = encodeURIComponent(`${clean(title)} ${clean(artist)}`);
      const r = await fetch(`https://itunes.apple.com/search?term=${q}&entity=album&limit=5&media=music`);
      const d = await r.json() as any;
      const results = (d.results || []).filter((i: any) => i.artworkUrl100);
      const scored = results.map((i: any) => {
        let score = 0;
        if ((i.collectionName || '').toLowerCase().includes(clean(title).toLowerCase())) score += 3;
        if ((i.artistName   || '').toLowerCase().includes(clean(artist).toLowerCase())) score += 2;
        return { i, score };
      });
      scored.sort((a: any, b: any) => b.score - a.score);
      const best = scored[0]?.i;
      if (best?.artworkUrl100) {
        return jsonRes({ imageUrl: best.artworkUrl100.replace('100x100bb', '600x600bb') });
      }
    } catch {}

    return jsonRes({ imageUrl: '' });
  },
};