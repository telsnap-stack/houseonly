/* === MT scraper v3.1 patch — invoice 756 === */
/* Pega en la consola de Chrome en mothertonguerecords.com. ~30s.
   Hace dos cosas:
   1) Resuelve y scrapea completos TLM041 y VP014 (bug de stop-words arreglado + búsqueda por catno).
   2) Pasa por las 12 páginas ya scrapeadas y extrae SOLO label + format hint.
   Descarga mt_enrichment_756_patch.json. */

(async () => {
  const ORIGIN = 'https://www.mothertonguerecords.com';

  const MISSING = [
    { catno: "TLM041", artist: "", title: "Frisson EP Part B" },
    { catno: "VP014",  artist: "Dj Compufunk", title: "The Remixes" },
  ];

  // the 12 already-scraped product URLs (from mt_enrichment_invoice756)
  const KNOWN = {
    "GT01": "https://www.mothertonguerecords.com/product/gene-tellem-unreleased-vol1/",
    "DMND010": "https://www.mothertonguerecords.com/product/rosa-brunello-we-are-surging-waters/",
    "CAT-016": "https://www.mothertonguerecords.com/product/the-soul-pops-the-mask-ep/",
    "SACREDMEDICINE005": "https://www.mothertonguerecords.com/product/ron-trent-electric-jungle/",
    "EGLO99": "https://www.mothertonguerecords.com/product/sum-of-its-parts-the-message-ep/",
    "MT19024": "https://www.mothertonguerecords.com/product/sandra-st-victor-life-moonchild/",
    "MAKINEP021": "https://www.mothertonguerecords.com/product/cee-elassaad-sabrina-chyld-the-time-is-here-ron-trent/",
    "CAT-017": "https://www.mothertonguerecords.com/product/leon-ware-for-the-rainbow-remixes/",
    "FAR001": "https://www.mothertonguerecords.com/product/the-illusion-nathan-haines-find-your-way/",
    "VISIO055": "https://www.mothertonguerecords.com/product/sean-khan-give-love-as-the-tree-grows/",
    "FSRDR061": "https://www.mothertonguerecords.com/product/trinidadian-deep-deep-rooted-isle/",
    "PS06": "https://www.mothertonguerecords.com/product/melchior-sultana-interstate/",
  };

  const words = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1); // NO stop words this time

  async function searchCandidates(query) {
    const res = await fetch(`${ORIGIN}/?s=${encodeURIComponent(query)}&post_type=product`, { credentials: 'omit' });
    if (!res.ok) return [];
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const seen = new Set(); const out = [];
    doc.querySelectorAll('a[href*="/product/"]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(/\/product\/([^\/?#]+)\/?/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
    });
    return out;
  }

  function extractGenres(doc) {
    const seen = new Set(); const g = [];
    const grab = (a) => { const t = a.textContent.trim();
      if (!t || /^(Categories?|Tags?):?$/i.test(t)) return;
      const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); g.push(t); } };
    doc.querySelectorAll('.posted_in a, .tagged_as a').forEach(grab);
    doc.querySelectorAll('a[rel="tag"]').forEach(a => {
      if ((a.getAttribute('href') || '').includes('/product-category/')) grab(a); });
    return g;
  }

  function extractLabel(doc) {
    // WooCommerce product pages link the label archive: /record-label/...
    const a = doc.querySelector('a[href*="/record-label/"]');
    return a ? a.textContent.trim() : '';
  }

  function extractFormatHint(doc, html) {
    const zone = (doc.querySelector('h1')?.textContent || '') + ' ' +
                 (doc.querySelector('.summary, .product_meta, .woocommerce-product-details__short-description')?.textContent || '') + ' ' +
                 html.slice(0, 20000);
    const m = zone.match(/(\d\s*[xX]\s*12\s*(?:"|”|inch)|2LP|3LP|\b12\s*(?:"|”|inch)|\b7\s*(?:"|”|inch)|\bLP\b)/);
    return m ? m[1].replace(/\s+/g, '') : '';
  }

  function extractReleased(doc) {
    const m = (doc.body?.innerText || '').match(/Released\s*:?\s*\n?\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
    return m ? m[1] : '';
  }

  async function fetchPage(url) {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return { html, doc };
  }

  function fullScrape(item, url, html, doc) {
    const mp3s = [...new Set(html.match(/https:\/\/www\.mothertonguerecords\.com\/wp-content\/uploads\/[^"'\s)]+\.mp3/gi) || [])];
    const tracks = mp3s.map(u => {
      const filename = u.split('/').pop().replace(/\.mp3$/i, '');
      let name = filename;
      const idx = html.indexOf(u);
      if (idx > 0) {
        const s = [...html.substring(Math.max(0, idx - 800), idx).matchAll(/<strong>([^<]+)<\/strong>/gi)];
        if (s.length) name = s[s.length - 1][1].trim();
      }
      return { name, filename, url: u };
    });
    return {
      catno: item.catno, invoice_artist: item.artist, invoice_title: item.title,
      url, ok: true,
      page_title: doc.querySelector('h1')?.textContent?.trim() || '',
      cover: doc.querySelector('meta[property="og:image"]')?.content || '',
      description: doc.querySelector('meta[property="og:description"]')?.content || '',
      genres: extractGenres(doc),
      label: extractLabel(doc),
      format_hint: extractFormatHint(doc, html),
      released: extractReleased(doc),
      tracks, track_count: tracks.length,
    };
  }

  const newReleases = [];
  const labels = {};
  const failures = [];

  console.log('%c🔧 v3.1 patch · resolviendo TLM041 + VP014…', 'color:#c8ff00;font-weight:bold');

  for (const item of MISSING) {
    const queries = [item.catno, [item.artist, item.title].join(' ').trim(), item.title];
    let picked = null;
    for (const q of queries) {
      if (!q) continue;
      const cands = await searchCandidates(q);
      if (!cands.length) continue;
      const qw = new Set(words(item.artist + ' ' + item.title + ' ' + item.catno));
      const ranked = cands.map(s => [s.toLowerCase().split('-').filter(w => qw.has(w)).length, s]).sort((a, b) => b[0] - a[0]);
      picked = ranked[0][1];             // top hit; catno search is precise enough
      break;
    }
    if (!picked) { failures.push(item.catno); console.log(`  ✗ ${item.catno} sin resolver`); continue; }
    try {
      const url = `${ORIGIN}/product/${picked}/`;
      const { html, doc } = await fetchPage(url);
      const r = fullScrape(item, url, html, doc);
      newReleases.push(r);
      console.log(`  ✓ ${item.catno} → ${picked} · ${r.track_count}t/${r.genres.length}g · label=${r.label} · ${r.format_hint || '12"?'}`);
    } catch (e) { failures.push(item.catno); console.log(`  ✗ ${item.catno} ERROR ${e}`); }
    await new Promise(r => setTimeout(r, 250));
  }

  console.log('%c🏷 barriendo labels de las 12 conocidas…', 'color:#c8ff00;font-weight:bold');
  for (const [catno, url] of Object.entries(KNOWN)) {
    if (!url) { console.log(`  ? ${catno} — sin URL previa (¿corriste v3 en otra pestaña? sube igualmente, lo resuelvo yo)`); continue; }
    try {
      const { html, doc } = await fetchPage(url);
      labels[catno] = { label: extractLabel(doc), format_hint: extractFormatHint(doc, html) };
      console.log(`  ✓ ${catno} · label=${labels[catno].label || '???'} · ${labels[catno].format_hint || '12"?'}`);
    } catch (e) { console.log(`  ✗ ${catno} ERROR ${e}`); }
    await new Promise(r => setTimeout(r, 200));
  }

  const payload = { patched_at: new Date().toISOString(), invoice: '756/2026',
    new_releases: newReleases, labels, failures };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = 'mt_enrichment_756_patch.json'; a.click();
  URL.revokeObjectURL(u);
  console.log('%c📥 mt_enrichment_756_patch.json descargado. Súbelo a Claude.', 'color:#c8ff00;font-weight:bold');
})();
