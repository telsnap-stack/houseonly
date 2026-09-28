/* === Mother Tongue scraper v4 ===
 *
 * IIFE para pegar en la consola de Chrome estando en cualquier pagina de
 * https://www.mothertonguerecords.com — NO es un script de Node (usa fetch
 * same-origin, DOMParser y URL.createObjectURL).
 *
 * Que hace: recibe una lista de CATNOS (editable justo debajo), resuelve cada
 * uno a su pagina de producto por la Store API de WooCommerce y la scrapea.
 * Descarga un JSON, `mt_enrichment_v4_AAAA-MM-DD.json`.
 *
 * Que NO hace: no genera el HTML del listener. Eso se monta aparte cruzando
 * este JSON con la factura (precio, cantidad, preventa). Ver MT_IMPORTER_FLOW.md.
 *
 * CAMBIOS vs v2 + parche v3.1:
 *   - Sin lista de URLs incrustada. Se le dan catnos (los de la factura) y los
 *     resuelve solo por SKU: la v2 obligaba a pegar 276 URLs a mano y la v3.1
 *     existia solo porque dos catnos no se resolvieron.
 *   - label / format / released salen del bloque `div.mt-product-meta` y de
 *     `p.mt-product-label`, no de heuristicas. El `extractLabel` de la v3.1
 *     (`a[href*="/record-label/"]`) cogia el PRIMER enlace de la pagina, que
 *     hoy es el menu lateral de sellos: en /product/kaidi-tatham-galaxy/
 *     devolvia "Salsoul Records" en vez de "2000Black". Aqui no se usa.
 *   - artist y title separados: el <h1> es el ARTISTA y el subtitulo
 *     (`p.mt-product-subheading`) es el TITULO. La v2 guardaba el <h1> como
 *     `page_title` y el nombre del disco se perdia.
 *   - Nombres de pista del array `new Player([{title, file}, ...])` que la
 *     propia pagina imprime. La heuristica de la v2 (ultimo <strong> en los
 *     800 caracteres anteriores al mp3) no llegaba —el array va en un <script>
 *     lejos del listado— y caia siempre al nombre del fichero: por eso los
 *     listeners viejos dicen "A1. Galaxy feat Lola" y no "Galaxy".
 *
 * Se mantiene de la v2: tandas de 4 con 200 ms entre medias, y los campos
 * page_title / headings / cover / description / genres / tracks / track_count.
 */

(async () => {
  // ── EDITAR: aqui van los catnos de la factura, uno por linea ─────
  // Se deja un ejemplo suelto a proposito: la lista de una factura concreta no
  // pinta nada en el repo, y dejarla puesta invita a relanzar la de otro dia
  // sin darse cuenta.
  const CATNOS = [
    'LEMAN006',
  ];

  // ── Config ───────────────────────────────────────────────────────
  const ORIGIN = 'https://www.mothertonguerecords.com';
  const BATCH_SIZE = 4;               // educado con su servidor, como en v2
  const DELAY_BETWEEN_BATCHES = 200;  // ms
  const API = `${ORIGIN}/wp-json/wc/store/v1/products`;

  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ── RESOLUCION catno → URL de producto ───────────────────────────
  //
  // Via principal: Store API de WooCommerce. Es publica y de solo lectura, va
  // same-origin desde la consola y devuelve el `sku`, que en esta tienda es el
  // catalog number. Asi el emparejamiento es exacto en vez de por ranking de
  // texto, que es donde se atascaba la v3.1.
  //
  // El orden de preferencia importa: buscar "SACREDMEDICINE005" devuelve
  // tambien "SACREDMEDICINE005B", asi que primero SKU identico, luego
  // normalizado, y solo si queda UN candidato se acepta un prefijo.
  async function resolveViaApi(catno) {
    const res = await fetch(`${API}?search=${encodeURIComponent(catno)}&per_page=20`,
      { credentials: 'omit', headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('API HTTP ' + res.status);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('API no devolvio un array');
    if (!list.length) return null;

    const want = norm(catno);
    const exact = list.filter(p => String(p.sku || '').trim().toUpperCase() === catno.trim().toUpperCase());
    if (exact.length === 1) return { url: exact[0].permalink, sku: exact[0].sku, via: 'api:sku-exacto' };

    const normed = list.filter(p => norm(p.sku) === want);
    if (normed.length === 1) return { url: normed[0].permalink, sku: normed[0].sku, via: 'api:sku-normalizado' };

    const prefixed = list.filter(p => norm(p.sku).startsWith(want));
    if (prefixed.length === 1) return { url: prefixed[0].permalink, sku: prefixed[0].sku, via: 'api:sku-prefijo' };

    // Varios candidatos plausibles: no elegimos por nosotros, se reporta.
    const cands = (prefixed.length ? prefixed : list).map(p => `${p.sku || '?'} ${p.permalink}`);
    throw new Error('ambiguo (' + cands.length + '): ' + cands.slice(0, 5).join(' | '));
  }

  // Respaldo A: barrer el catalogo entero y emparejar SKU en local.
  //
  // Cubre el caso de que `search=` deje de filtrar (o filtre mal) pero la API
  // siga en pie. Son 7 peticiones para las ~700 referencias de la tienda, asi
  // que sale mas barato que una busqueda por catno en cuanto la factura pasa
  // de siete lineas. Se cachea: se barre una sola vez por ejecucion.
  let catalogo = null;
  async function barrerCatalogo() {
    if (catalogo) return catalogo;
    catalogo = new Map();
    for (let page = 1; page <= 20; page++) {
      const res = await fetch(`${API}?per_page=100&page=${page}`,
        { credentials: 'omit', headers: { 'Accept': 'application/json' } });
      if (!res.ok) break;
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) break;
      for (const p of list) {
        const k = norm(p.sku);
        if (k && !catalogo.has(k)) catalogo.set(k, p);
      }
      const totalPages = parseInt(res.headers.get('X-WP-TotalPages') || '0', 10);
      if (totalPages && page >= totalPages) break;
      await sleep(DELAY_BETWEEN_BATCHES);
    }
    console.log(`  · catalogo barrido: ${catalogo.size} SKUs`);
    return catalogo;
  }

  async function resolveViaCatalogo(catno) {
    const mapa = await barrerCatalogo();
    const p = mapa.get(norm(catno));
    return p ? { url: p.permalink, sku: p.sku, via: 'api:catalogo-completo' } : null;
  }

  // Respaldo B: el buscador HTML de WordPress.
  //
  // OJO — comprobado el 2026-09-28 contra la tienda en vivo: hoy NO funciona.
  // `/?s=CAT-016&post_type=product` responde 200 con "No products were found
  // matching your selection", y lo mismo por titulo ("Kaidi Tatham Galaxy") o
  // por catno suelto: la busqueda nativa de WooCommerce no indexa SKUs y el
  // buscador visible del tema es el plugin Advanced Woo Search, cuyo endpoint
  // AJAX devuelve 0 resultados sin nonce. Se deja como ultimo recurso por si
  // se reactiva, pero lo normal es que devuelva null y el catno salga en la
  // lista de fallos para resolverlo a mano. No se adivina nada.
  async function resolveViaHtml(catno) {
    const res = await fetch(`${ORIGIN}/?s=${encodeURIComponent(catno)}&post_type=product`,
      { credentials: 'omit' });
    if (!res.ok) throw new Error('buscador HTTP ' + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const slugs = [];
    doc.querySelectorAll('a[href*="/product/"]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(/\/product\/([^\/?#]+)\/?/);
      if (m && !slugs.includes(m[1])) slugs.push(m[1]);
    });
    for (const slug of slugs.slice(0, 5)) {
      const url = `${ORIGIN}/product/${slug}/`;
      try {
        const { doc: pdoc } = await fetchPage(url);
        if (norm(metaField(pdoc, 'Catalog No')) === norm(catno)) {
          return { url, sku: metaField(pdoc, 'Catalog No'), via: 'html:catalog-no' };
        }
      } catch { /* siguiente candidato */ }
      await sleep(150);
    }
    return null;
  }

  // ── EXTRACTORES ──────────────────────────────────────────────────

  async function fetchPage(url) {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    return { html, doc: new DOMParser().parseFromString(html, 'text/html') };
  }

  // La ficha imprime un bloque con pares etiqueta/valor:
  //   <div class="mt-product-meta">
  //     <p><strong>Catalog No.</strong><br>2053BLACK</p>
  //     <p><strong>Format</strong><br>vinyl 12"</p>
  //     <p><strong>Released</strong><br>17 June 2022</p>
  //     <p><strong>Categories</strong><br><a rel="tag">…</a>, …</p>
  //   </div>
  // Leemos por etiqueta, no por posicion: si añaden un campo, esto no se rompe.
  function metaField(doc, label) {
    const rx = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.?$', 'i');
    for (const p of doc.querySelectorAll('.mt-product-meta p')) {
      const strong = p.querySelector('strong');
      if (!strong || !rx.test(clean(strong.textContent))) continue;
      const full = clean(p.textContent);
      return clean(full.slice(clean(strong.textContent).length).replace(/^[.:\s]+/, ''));
    }
    return '';
  }

  // Sello: <p class="mt-product-label"><em>2000Black</em></p>.
  function extractLabel(doc) {
    return clean(doc.querySelector('.mt-product-label')?.textContent || '');
  }

  // Formato tal cual lo escribe la tienda ("vinyl 12\"", "2LP"…). El importer
  // ya normaliza a gramos, asi que no tocamos el texto.
  function extractFormat(doc) {
    return metaField(doc, 'Format');
  }

  // Fecha de salida en el formato de la web: "17 June 2022".
  function extractReleased(doc) {
    return metaField(doc, 'Released');
  }

  // Generos = categorias de WooCommerce. Los selectores clasicos .posted_in /
  // .tagged_as ya no existen en este tema; lo que queda son los a[rel="tag"]
  // que apuntan a /product-category/, dentro del bloque de meta.
  function extractGenres(doc) {
    const seen = new Set();
    const out = [];
    doc.querySelectorAll('a[rel="tag"], .posted_in a, .tagged_as a').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!href.includes('/product-category/')) return;
      const text = clean(a.textContent);
      if (!text || /^(Categories?|Tags?):?$/i.test(text)) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(text);
    });
    return out;
  }

  // Pistas. La pagina imprime el reproductor como
  //   var player = new Player( [ { "title": "...", "file": "...", "howl": null }, … ] );
  // que es JSON valido. Es la fuente buena: trae el titulo editado a mano.
  // Si algun dia desaparece, se cae a la heuristica de la v2.
  function extractTracks(html) {
    const m = html.match(/new\s+Player\(\s*(\[[\s\S]*?\])\s*\)/);
    if (m) {
      try {
        const arr = JSON.parse(m[1]);
        const tracks = arr
          .filter(t => t && t.file)
          .map(t => ({
            name: clean(t.title) || t.file.split('/').pop().replace(/\.mp3$/i, ''),
            filename: t.file.split('/').pop().replace(/\.mp3$/i, ''),
            url: t.file,
          }));
        if (tracks.length) return { tracks, via: 'player-array' };
      } catch { /* cae al respaldo */ }
    }
    // Respaldo v2: regex de mp3 + ultimo <strong> en los 800 chars anteriores.
    const mp3s = [...new Set(html.match(
      /https:\/\/www\.mothertonguerecords\.com\/wp-content\/uploads\/[^"'\s)]+\.mp3/gi) || [])];
    const tracks = mp3s.map(url => {
      const filename = url.split('/').pop().replace(/\.mp3$/i, '');
      let name = filename;
      const idx = html.indexOf(url);
      if (idx > 0) {
        const s = [...html.substring(Math.max(0, idx - 800), idx).matchAll(/<strong>([^<]+)<\/strong>/gi)];
        if (s.length) name = clean(s[s.length - 1][1]);
      }
      return { name, filename, url };
    });
    return { tracks, via: tracks.length ? 'regex-mp3' : 'sin-pistas' };
  }

  function scrapeProduct(catno, url, html, doc, via) {
    const artist = clean(doc.querySelector('h1.product_title, h1')?.textContent || '');
    const title = clean(doc.querySelector('.mt-product-subheading')?.textContent || '');
    const { tracks, via: tracksVia } = extractTracks(html);
    return {
      catno,
      catno_web: metaField(doc, 'Catalog No'),   // lo que dice la ficha, para cotejar
      url,
      ok: true,
      resolved_via: via,
      artist,                                     // <h1> — es el artista
      title,                                      // subtitulo — es el disco
      page_title: artist,                         // compat v2
      headings: [...doc.querySelectorAll('h1, h2')].map(h => clean(h.textContent)).filter(Boolean),
      label: extractLabel(doc),
      format_hint: extractFormat(doc),
      released: extractReleased(doc),
      cover: doc.querySelector('meta[property="og:image"]')?.content || '',
      description: doc.querySelector('meta[property="og:description"]')?.content || '',
      genres: extractGenres(doc),
      tracks,
      track_count: tracks.length,
      tracks_via: tracksVia,
    };
  }

  // ── UN CATNO DE PRINCIPIO A FIN ──────────────────────────────────
  //
  // Cascada: busqueda por SKU → catalogo completo → buscador HTML. Si un catno
  // sale ambiguo (varios SKU plausibles) se corta ahi y se reporta: preferimos
  // una linea en "fallos" a un disco con la ficha de otro.
  let apiRota = false;
  async function doOne(catno) {
    try {
      let hit = null;
      if (!apiRota) {
        try {
          hit = await resolveViaApi(catno);
        } catch (e) {
          if (/^(API HTTP|API no devolvio)/.test(e.message)) {
            if (!apiRota) console.warn(`  ⚠ Store API no disponible (${e.message}) — al buscador HTML`);
            apiRota = true;
          } else {
            return { catno, ok: false, error: e.message };   // ambiguo: no adivinamos
          }
        }
        if (!hit) {
          try { hit = await resolveViaCatalogo(catno); }
          catch { apiRota = true; }
        }
      }
      if (!hit) hit = await resolveViaHtml(catno);
      if (!hit) return { catno, ok: false, error: 'no resuelto (ni API ni buscador)' };

      const { html, doc } = await fetchPage(hit.url);
      const r = scrapeProduct(catno, hit.url, html, doc, hit.via);
      // Aviso si la ficha dice otro catalog number del que pedimos.
      if (r.catno_web && norm(r.catno_web) !== norm(catno)) {
        r.warning = `la ficha dice ${r.catno_web}, se pidio ${catno}`;
      }
      return r;
    } catch (e) {
      return { catno, ok: false, error: String(e.message || e) };
    }
  }

  // ── BUCLE ────────────────────────────────────────────────────────
  console.log(`%c🎵 MT scraper v4 · ${CATNOS.length} catnos`,
    'color:#c8ff00;font-weight:bold;font-size:14px');

  const releases = [];
  const errors = [];
  let done = 0;

  for (let i = 0; i < CATNOS.length; i += BATCH_SIZE) {
    const batch = CATNOS.slice(i, i + BATCH_SIZE);
    const out = await Promise.all(batch.map(doOne));
    for (const r of out) {
      if (r.ok) releases.push(r); else errors.push(r);
      done++;
    }
    const pct = Math.round(done / CATNOS.length * 100);
    const resumen = out.map(r => r.ok
      ? `${r.catno}:${r.track_count}t/${r.genres.length}g${r.label ? '' : '/SIN-SELLO'}`
      : `${r.catno}:X`).join(', ');
    console.log(`  ${done}/${CATNOS.length} (${pct}%) · ${resumen}`);
    if (i + BATCH_SIZE < CATNOS.length) await sleep(DELAY_BETWEEN_BATCHES);
  }

  // ── RESUMEN + DESCARGA ───────────────────────────────────────────
  const totalTracks = releases.reduce((s, r) => s + r.track_count, 0);
  const conSello = releases.filter(r => r.label).length;
  const conGeneros = releases.filter(r => r.genres.length).length;
  const conFecha = releases.filter(r => r.released).length;

  console.log(`%c✅ ${releases.length}/${CATNOS.length} resueltos · ${totalTracks} pistas · ` +
    `sello ${conSello}/${releases.length} · generos ${conGeneros}/${releases.length} · ` +
    `fecha ${conFecha}/${releases.length} · ${errors.length} fallos`,
    'color:#c8ff00;font-weight:bold;font-size:14px');
  if (errors.length) console.log('Fallos (resolver a mano):', errors);

  const payload = {
    scraper: 'v4',
    scraped_at: new Date().toISOString(),
    requested: CATNOS.length,
    total_releases: releases.length,
    total_tracks: totalTracks,
    errors,
    releases,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = 'mt_enrichment_v4_' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(u);

  console.log('%c📥 JSON descargado. El listener se monta aparte, con la factura.',
    'color:#c8ff00;font-weight:bold');
  window._mtScrapeV4 = payload;
})();
