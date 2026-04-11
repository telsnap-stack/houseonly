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
    const ean = url.searchParams.get('ean') || '';
    const title = url.searchParams.get('title') || '';
    const artist = url.searchParams.get('artist') || '';
    const discogsHeaders = {
      'User-Agent': 'HouseOnly/1.0 houseonly.store',
      'Authorization': 'Discogs token=nRLxrBzkUfjQyDmokFzxGSpTHRfwnxAvwVGgKonv',
    };
    const getImage = (data: any) => {
      const r = data.results?.[0];
      return r?.cover_image && !r.cover_image.includes('spacer') ? r.cover_image : '';
    };
    let imageUrl = '';
    if (ean) {
      const r = await fetch(`https://api.discogs.com/database/search?barcode=${encodeURIComponent(ean)}&type=release&per_page=1`, { headers: discogsHeaders });
      const d = await r.json();
      imageUrl = getImage(d);
    }
    if (!imageUrl && (title || artist)) {
      const clean = (s: string) => s.replace(/\(.*?\)/g,'').replace(/feat\.?.*/i,'').trim();
      const q = encodeURIComponent(`${clean(title)} ${clean(artist)}`);
      const r = await fetch(`https://api.discogs.com/database/search?q=${q}&type=release&per_page=1`, { headers: discogsHeaders });
      const d = await r.json();
      imageUrl = getImage(d);
    }
    return new Response(JSON.stringify({ imageUrl }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  },
};