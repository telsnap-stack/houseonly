// ── MT ENRICH ──────────────────────────────────────────────────
//
// Port al Worker de los extractores de `scripts/mt_scraper_v4.js`, para que el
// tab MT del admin funcione con la factura PDF y nada mas: sin pegar nada en la
// consola de Chrome y sin listener HTML intermedio.
//
// Por que aqui y no en el navegador: mothertonguerecords.com no manda cabeceras
// CORS, asi que el navegador no puede leer ni su API ni sus fichas. El Worker si
// —fetch() en el edge no pasa por CORS—, igual que ya hace `handleMirror` con
// las portadas.
//
// DIFERENCIA IMPORTANTE CON v4: aqui NO hay DOMParser. Los Workers traen
// HTMLRewriter, que es un parser en streaming, no un arbol: no se puede
// consultar hacia atras ni pedir textContent de un nodo. Asi que cada extractor
// se reescribe como manejador de eventos que acumula texto, y el orden del
// documento hace de estado. El array del reproductor, que vive dentro de un
// <script>, sale por regex sobre el HTML en crudo.
//
// Lo que NO se porta: el respaldo por el buscador HTML de WordPress. Comprobado
// el 2026-09-28 contra la tienda en vivo, devuelve cero productos para
// cualquier busqueda (ni por SKU ni por titulo): su buscador es un plugin con
// su propio endpoint. Queda la cascada que si funciona — busqueda por SKU en la
// Store API y, si falla, barrido del catalogo completo.

const ORIGIN = 'https://www.mothertonguerecords.com';
const API = `${ORIGIN}/wp-json/wc/store/v1/products`;
const UA = 'Mozilla/5.0 (compatible; HouseOnlyEnrich/1.0)';

// Tandas pequenas con pausa: la tienda es de un distribuidor pequeno y esto
// corre contra su WordPress, no contra una API pensada para aguantar carga.
const TANDA = 4;
const PAUSA_MS = 200;

// Tope de catnos por llamada. El plan Free de Workers corta a 50 subpeticiones
// por invocacion; con 10 catnos son ~10 busquedas + ~10 fichas, y si ademas
// hace falta barrer el catalogo, +7. Queda holgado. El navegador trocea.
export const MT_MAX_CATNOS = 10;

export type MtTrack = { name: string; filename: string; url: string };

export type MtRelease = {
  catno: string;
  catno_web: string;
  url: string;
  ok: true;
  resolved_via: string;
  artist: string;
  title: string;
  label: string;
  format_hint: string;
  released: string;
  cover: string;
  description: string;
  genres: string[];
  tracks: MtTrack[];
  track_count: number;
  tracks_via: string;
  warning?: string;
};

export type MtError = { catno: string; ok: false; error: string };

const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const limpia = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const duerme = (ms: number) => new Promise(r => setTimeout(r, ms));

// HTMLRewriter entrega el texto tal cual viene en el HTML: las entidades NO se
// decodifican. DOMParser si lo hacia, asi que sin esto el artista de TLM041
// saldria como "Jose Rico &#038; Ruben Valero" y acabaria tal cual en el Vendor
// de Shopify.
const NOMBRADAS: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
  ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä',
  deg: '°', euro: '€', pound: '£', copy: '©', reg: '®',
};
export function decodeEntities(s: string): string {
  if (!s || s.indexOf('&') < 0) return s;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NOMBRADAS[String(n).toLowerCase()] ?? m);
}
function cp(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

// ── RESOLUCION catno → ficha ─────────────────────────────────────
//
// El `sku` de la Store API es el catalog number de la factura, asi que el
// emparejamiento es exacto y no por ranking de texto. El orden importa: buscar
// "SACREDMEDICINE005" devuelve tambien "SACREDMEDICINE005B", de ahi que primero
// se exija SKU identico y solo al final se acepte un prefijo, y unicamente si
// queda un candidato. Si quedan varios NO se elige: se reporta como ambiguo.
type Hit = { url: string; sku: string; via: string };

async function pedirJson(url: string, señal?: AbortSignal): Promise<any> {
  const r = await fetch(url, {
    signal: señal,
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });
  if (!r.ok) throw new Error(`API HTTP ${r.status}`);
  return await r.json();
}

async function porBusqueda(catno: string): Promise<Hit | null> {
  const lista = await pedirJson(`${API}?search=${encodeURIComponent(catno)}&per_page=20`);
  if (!Array.isArray(lista)) throw new Error('API no devolvio un array');
  if (!lista.length) return null;

  const quiero = norm(catno);
  const exacto = lista.filter((p: any) =>
    String(p?.sku ?? '').trim().toUpperCase() === catno.trim().toUpperCase());
  if (exacto.length === 1) return { url: exacto[0].permalink, sku: exacto[0].sku, via: 'api:sku-exacto' };

  const normal = lista.filter((p: any) => norm(p?.sku) === quiero);
  if (normal.length === 1) return { url: normal[0].permalink, sku: normal[0].sku, via: 'api:sku-normalizado' };

  const prefijo = lista.filter((p: any) => norm(p?.sku).startsWith(quiero));
  if (prefijo.length === 1) return { url: prefijo[0].permalink, sku: prefijo[0].sku, via: 'api:sku-prefijo' };

  const cands = (prefijo.length ? prefijo : lista).map((p: any) => `${p?.sku || '?'}`);
  throw new Error(`ambiguo (${cands.length}): ${cands.slice(0, 5).join(', ')}`);
}

// Respaldo: barrer el catalogo entero (~700 referencias, 7 peticiones) y
// emparejar en local. Cubre que `search=` deje de filtrar pero la API siga viva.
// Se barre una vez por invocacion y se reparte entre todos los catnos.
async function barrer(): Promise<Map<string, any>> {
  const mapa = new Map<string, any>();
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${API}?per_page=100&page=${page}`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    });
    if (!r.ok) break;
    const lista: any = await r.json();
    if (!Array.isArray(lista) || !lista.length) break;
    for (const p of lista) {
      const k = norm(p?.sku);
      if (k && !mapa.has(k)) mapa.set(k, p);
    }
    const total = parseInt(r.headers.get('X-WP-TotalPages') || '0', 10);
    if (total && page >= total) break;
    await duerme(PAUSA_MS);
  }
  return mapa;
}

// ── EXTRACCION DE LA FICHA ───────────────────────────────────────
//
// Una sola descarga del HTML, que sirve para las dos cosas: HTMLRewriter para
// lo estructural y una regex para el <script> del reproductor.
type Fila = { etiqueta: string; crudo: string };
type Ficha = {
  artist: string; title: string; label: string;
  cover: string; description: string;
  filas: Fila[];
  cats: { href: string; texto: string }[];
};

async function leerFicha(html: string): Promise<Ficha> {
  const f: Ficha = {
    artist: '', title: '', label: '', cover: '', description: '',
    filas: [], cats: [],
  };
  // Cajas para acumular texto: HTMLRewriter puede partir un mismo nodo de texto
  // en varios trozos segun llegan por el cable, asi que se concatena y se cierra
  // al final, no en el primer trozo.
  const h1 = { s: '' }, sub = { s: '' }, sello = { s: '' };

  const ultimaFila = () => f.filas[f.filas.length - 1];
  const ultimaCat = () => f.cats[f.cats.length - 1];

  const rw = new HTMLRewriter()
    .on('meta[property="og:image"]', {
      element(e) { if (!f.cover) f.cover = e.getAttribute('content') || ''; },
    })
    .on('meta[property="og:description"]', {
      element(e) { if (!f.description) f.description = e.getAttribute('content') || ''; },
    })
    // El <h1> de la ficha es el ARTISTA, no el titulo del disco.
    .on('h1.product_title', { text(t) { h1.s += t.text; } })
    .on('.mt-product-subheading', { text(t) { sub.s += t.text; } })
    .on('.mt-product-label', { text(t) { sello.s += t.text; } })
    // Bloque de pares etiqueta/valor:
    //   <p><strong>Catalog No.</strong><br>2053BLACK</p>
    // El manejador de `p` recibe TODO su texto (incluido el del <strong>), y el
    // de `strong` solo la etiqueta; el valor es la resta. Se lee por etiqueta y
    // no por posicion, asi que si anaden un campo esto no se rompe.
    .on('.mt-product-meta p', {
      element() { f.filas.push({ etiqueta: '', crudo: '' }); },
      text(t) { const fila = ultimaFila(); if (fila) fila.crudo += t.text; },
    })
    .on('.mt-product-meta p strong', {
      text(t) { const fila = ultimaFila(); if (fila) fila.etiqueta += t.text; },
    })
    // Generos = categorias de WooCommerce. El tema actual ya no pinta
    // .posted_in ni .tagged_as; lo que queda son estos enlaces.
    .on('a[rel="tag"]', {
      element(e) { f.cats.push({ href: e.getAttribute('href') || '', texto: '' }); },
      text(t) { const c = ultimaCat(); if (c) c.texto += t.text; },
    });

  // transform() es perezoso: hay que consumir el cuerpo para que corra.
  await rw.transform(new Response(html)).text();

  f.artist = limpia(decodeEntities(h1.s));
  f.title = limpia(decodeEntities(sub.s));
  f.label = limpia(decodeEntities(sello.s));
  f.cover = decodeEntities(f.cover);
  f.description = limpia(decodeEntities(f.description));
  return f;
}

function campo(f: Ficha, etiqueta: string): string {
  const rx = new RegExp('^' + etiqueta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.?$', 'i');
  for (const fila of f.filas) {
    const et = limpia(decodeEntities(fila.etiqueta));
    if (!et || !rx.test(et)) continue;
    const todo = limpia(decodeEntities(fila.crudo));
    const valor = todo.toLowerCase().startsWith(et.toLowerCase()) ? todo.slice(et.length) : todo;
    return limpia(valor.replace(/^[.:\s]+/, ''));
  }
  return '';
}

function generos(f: Ficha): string[] {
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const c of f.cats) {
    if (!c.href.includes('/product-category/')) continue;
    const texto = limpia(decodeEntities(c.texto));
    if (!texto || /^(Categories?|Tags?):?$/i.test(texto)) continue;
    const k = texto.toLowerCase();
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push(texto);
  }
  return out;
}

// Nombre de pista deducido del fichero, SOLO para cuando el reproductor no
// trae titulo. Los nombres crudos de MT vienen con de todo encima:
//
//   09-9.-Sandra-St.-Victor-Womanizer-Mother-Tongue-records_snippet.mp3
//
// y de ahi lo unico que interesa es "Womanizer": el numero de pista sale dos
// veces, el artista ya va en el Vendor y el sello ya va en su tag.
export function humanizaNombrePista(fichero: string, artist = '', label = ''): string {
  const original = fichero.replace(/\.[^.]+$/, '');
  let n = original;

  // Un nombre propio se puede escribir con guiones, guiones bajos o espacios
  // segun quien exportara el fichero, asi que se compara con cualquiera.
  const comoRegex = (s: string) => s.trim().split(/\s+/)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[-_\\s]+');

  // 1. Coletilla de recorte al final: _snippet, -clip, (preview)…
  n = n.replace(
    /[-_\s]*\(?\s*(snippets?|snips?|previews?|clips?|teasers?|tasters?)\s*\)?\s*$/i, '');

  // 2. Coletilla del sello. Si el sello ya se llama "… Records" lo cubre la
  //    propia etiqueta; si se llama solo "Mother Tongue", el grupo opcional
  //    recoge el "-records" que el fichero si trae.
  if (label.trim()) {
    n = n.replace(new RegExp(
      `[-_\\s]*${comoRegex(label)}(?:[-_\\s]*recordings?|[-_\\s]*records?)?\\s*$`, 'i'), '');
  }

  // 3. Prefijo de numero de pista, hasta dos veces porque vienen encadenados
  //    ("09-9.-"). Se exige que PAREZCA un indice —cero delante, o punto o
  //    parentesis detras— para no comerse un titulo que empiece por cifra:
  //    "2-Step-Dub" tiene que seguir siendo "2 Step Dub".
  for (let i = 0; i < 2; i++) {
    const antes = n;
    n = n.replace(/^(?:0\d{1,2}|\d{1,3}\s*[.)])\s*[-._\s]*/, '');
    if (n === antes) break;
  }

  // 4. Separadores a espacios.
  n = n.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

  // 5. Si lo que queda empieza por el artista que ya sacamos de la ficha, fuera.
  if (artist.trim()) {
    n = n.replace(new RegExp(`^${comoRegex(artist)}[-_\\s]*`, 'i'), '').trim();
  }

  n = n.replace(/^[\s\-–—.]+|[\s\-–—.]+$/g, '').replace(/\s+/g, ' ').trim();
  // Si de tanto limpiar no queda nada, mejor el nombre crudo que una pista sin
  // nombre: al menos se puede reconocer el fichero.
  return n || original;
}

// La ficha imprime el reproductor como
//   var player = new Player( [ { "title": "...", "file": "...", "howl": null }, … ] );
// que es JSON valido y trae el titulo editado a mano. Es la fuente buena: el
// nombre del fichero mp3 no lo es (de ahi los "A1. Galaxy feat Lola" de antes).
function pistas(html: string, artist = '', label = ''): { tracks: MtTrack[]; via: string } {
  const m = html.match(/new\s+Player\(\s*(\[[\s\S]*?\])\s*\)/);
  if (m) {
    try {
      const arr = JSON.parse(m[1]);
      const tracks: MtTrack[] = (Array.isArray(arr) ? arr : [])
        .filter((t: any) => t && typeof t.file === 'string' && t.file)
        .map((t: any) => {
          const filename = String(t.file).split('/').pop()!.replace(/\.mp3$/i, '');
          return {
            // El titulo del reproductor manda; solo si viene vacio se deduce
            // del nombre del fichero.
            name: limpia(decodeEntities(String(t.title || ''))) ||
                  humanizaNombrePista(filename, artist, label),
            filename,
            url: String(t.file),
          };
        });
      if (tracks.length) return { tracks, via: 'player-array' };
    } catch { /* cae al respaldo */ }
  }
  const urls = [...new Set(html.match(
    /https:\/\/www\.mothertonguerecords\.com\/wp-content\/uploads\/[^"'\s)]+\.mp3/gi) || [])];
  const tracks: MtTrack[] = urls.map(url => {
    const filename = url.split('/').pop()!.replace(/\.mp3$/i, '');
    return { name: humanizaNombrePista(filename, artist, label), filename, url };
  });
  return { tracks, via: tracks.length ? 'regex-mp3' : 'sin-pistas' };
}

// ── UN CATNO DE PRINCIPIO A FIN ──────────────────────────────────
async function unCatno(catno: string, mapa: Map<string, any> | null): Promise<MtRelease | MtError> {
  try {
    let hit: Hit | null = null;
    try {
      hit = await porBusqueda(catno);
    } catch (e: any) {
      // Ambiguo: no adivinamos. Preferimos una linea en "errors" a un disco
      // con la ficha de otro.
      if (!/^(API HTTP|API no devolvio)/.test(e?.message || '')) {
        return { catno, ok: false, error: e?.message || String(e) };
      }
    }
    if (!hit && mapa) {
      const p = mapa.get(norm(catno));
      if (p) hit = { url: p.permalink, sku: p.sku, via: 'api:catalogo-completo' };
    }
    if (!hit) return { catno, ok: false, error: 'no resuelto' };

    const r = await fetch(hit.url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
    if (!r.ok) return { catno, ok: false, error: `ficha HTTP ${r.status}` };
    const html = await r.text();

    const f = await leerFicha(html);
    const { tracks, via } = pistas(html, f.artist, f.label);
    const catnoWeb = campo(f, 'Catalog No');

    const rel: MtRelease = {
      catno,
      catno_web: catnoWeb,
      url: hit.url,
      ok: true,
      resolved_via: hit.via,
      artist: f.artist,
      title: f.title,
      label: f.label,
      format_hint: campo(f, 'Format'),
      released: campo(f, 'Released'),
      cover: f.cover,
      description: f.description,
      genres: generos(f),
      tracks,
      track_count: tracks.length,
      tracks_via: via,
    };
    if (catnoWeb && norm(catnoWeb) !== norm(catno)) {
      rel.warning = `la ficha dice ${catnoWeb}, se pidio ${catno}`;
    }
    return rel;
  } catch (e: any) {
    return { catno, ok: false, error: e?.message || String(e) };
  }
}

// ── ENTRADA ──────────────────────────────────────────────────────
export async function mtEnrich(catnos: string[]): Promise<{
  releases: MtRelease[]; errors: MtError[];
}> {
  const limpios = [...new Set(catnos.map(c => String(c || '').trim()).filter(Boolean))];
  const releases: MtRelease[] = [];
  const errors: MtError[] = [];

  // Primera pasada. Si alguno no resuelve por busqueda, se barre el catalogo
  // UNA vez y se reintentan solo esos: barrer por cada fallo seria pagar siete
  // peticiones de mas cada vez.
  const primera: (MtRelease | MtError)[] = [];
  for (let i = 0; i < limpios.length; i += TANDA) {
    const tanda = limpios.slice(i, i + TANDA);
    primera.push(...await Promise.all(tanda.map(c => unCatno(c, null))));
    if (i + TANDA < limpios.length) await duerme(PAUSA_MS);
  }

  const sinResolver = primera.filter(r => !r.ok && /^no resuelto$/.test((r as MtError).error));
  let segunda = new Map<string, MtRelease | MtError>();
  if (sinResolver.length) {
    const mapa = await barrer();
    for (let i = 0; i < sinResolver.length; i += TANDA) {
      const tanda = sinResolver.slice(i, i + TANDA);
      const res = await Promise.all(tanda.map(r => unCatno(r.catno, mapa)));
      res.forEach(r => segunda.set(r.catno, r));
      if (i + TANDA < sinResolver.length) await duerme(PAUSA_MS);
    }
  }

  for (const r of primera) {
    const bueno = segunda.get(r.catno) ?? r;
    if (bueno.ok) releases.push(bueno); else errors.push(bueno);
  }
  return { releases, errors };
}
