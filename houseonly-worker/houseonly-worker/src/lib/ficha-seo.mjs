/**
 * La ficha de un disco tal como la ven los buscadores: slug, titulo, texto
 * propio y enlaces a otras fichas.
 *
 * Una sola copia para los tres sitios que la necesitan: src/App.jsx (el modal y
 * los enlaces de las tarjetas), scripts/prerender.mjs (el HTML estatico, el
 * sitemap) y el worker (lib/slug.ts: newsletter, feed de Google, portal). Antes
 * eran tres copias de makeSlug "que tenian que dar lo mismo"; ahora dan lo mismo
 * porque son la misma.
 *
 * JavaScript plano y no TypeScript, como html-text.mjs: lo importa
 * scripts/prerender.mjs con node a secas en el build de Pages.
 *
 * Nada de lo que sale de aqui se inventa: cada frase y cada parentesis aparece
 * solo si su dato existe en Shopify (vendor, titulo, tag label:, SKU, tag de
 * año, tag genre:, tracklist). La descripcion del distribuidor no se usa.
 */

import { nombreDePista } from './track-names.mjs';

const TIENDA = 'House Only';

// ── Slug ────────────────────────────────────────────────────────

/** @param {string} str @returns {string} */
export function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/**
 * El artista a partir del vendor. Un alta sin artista se queda con el vendor
 * por defecto de Shopify, que es el nombre de la tienda: eso no es un artista y
 * no entra ni en el slug ni en el titulo.
 * @param {string} vendor @returns {string}
 */
export function artistaDeVendor(vendor) {
  const v = String(vendor || '').trim();
  return v === TIENDA ? '' : v;
}

/**
 * artista-titulo; sin ninguno de los dos, el catalogo. Recibe el vendor tal
 * cual (o el artista ya limpio, que da lo mismo).
 * @param {string} artist @param {string} title @param {string} catalog @returns {string}
 */
export function makeSlug(artist, title, catalog) {
  const base = [artistaDeVendor(artist), title].filter(Boolean).join(' ');
  const s = slugify(base);
  if (s) return s;
  return slugify(catalog) || 'release';
}

// ── Titulo ──────────────────────────────────────────────────────

/** "Artista – Titulo", o solo el titulo. El H1 y el `name` del JSON-LD. */
export function encabezadoFicha({ artist, title }) {
  const a = artistaDeVendor(artist);
  const t = String(title || '').trim();
  return a ? `${a} – ${t}` : t;
}

/**
 * "Artista – Titulo (Sello, Catalogo) Vinyl | House Only". El parentesis lleva
 * lo que haya de sello y catalogo; sin ninguno, no hay parentesis. "Vinyl" no
 * se repite si el titulo ya lo dice ("… (Orange Vinyl)").
 */
export function tituloFicha({ artist, title, label, catalog }) {
  const extra = [label, catalog].map(x => String(x || '').trim()).filter(Boolean).join(', ');
  const base = encabezadoFicha({ artist, title }) + (extra ? ` (${extra})` : '');
  const vinilo = /\bvinyl\b/i.test(base) ? '' : ' Vinyl';
  return `${base}${vinilo} | ${TIENDA}`;
}

// ── Datos de Shopify ────────────────────────────────────────────

/**
 * Lo que la ficha necesita de los tags, con las mismas reglas que
 * extractTagMeta() en App.jsx: el sello sale de `label:` y de nada mas.
 * @param {string[]} tags
 */
export function metaDeTags(tags) {
  tags = tags || [];
  const label = tags.find(t => String(t).toLowerCase().startsWith('label:'))?.slice(6).trim() || '';
  const year = parseInt(tags.find(t => /^\d{4}$/.test(t)) || '0') || null;
  const forthcoming = tags.some(t => /^forthcoming$/i.test(t));
  const rel = tags.find(t => /^release:/i.test(t));
  const releaseDate = rel ? rel.slice(rel.indexOf(':') + 1).trim() : '';
  return { label, year, forthcoming, releaseDate };
}

/**
 * GTIN valido (8, 12, 13 o 14 cifras con su digito de control) y la propiedad
 * de schema.org que le toca. El barcode de Shopify trae tambien numeros
 * internos de distribuidor ("127173"): esos no son GTIN y no se publican.
 * @param {string} barcode @returns {{prop: string, value: string} | null}
 */
export function gtinDe(barcode) {
  const b = String(barcode || '').trim();
  if (!/^(\d{8}|\d{12,14})$/.test(b)) return null;
  const d = b.split('').map(Number);
  const control = d.pop();
  const suma = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0);
  if ((10 - (suma % 10)) % 10 !== control) return null;
  return { prop: `gtin${b.length}`, value: b };
}

// ── Texto propio ────────────────────────────────────────────────

/**
 * Los cortes: los del reproductor y, si no hay, la lista del texto. Los del
 * reproductor salen del nombre de fichero del promopack ("HI002 - 1. Abyssy &
 * Memoryman - A1- HER SOUND"), asi que pasan por nombreDePista, el limpiador
 * de la bandeja; lo que no deja titulo ("A2", "Pista 3") no se lista.
 */
function nombresDeCortes(p) {
  const delJson = (p.tracks || [])
    .map((t, i) => nombreDePista(String(t?.name || t?.t || '').trim(), p.catalog, i, artistaDeVendor(p.artist)))
    .filter(n => n && !/^(Pista \d+|[A-D]\d{1,2})$/.test(n));
  const lista = delJson.length ? delJson : (p.descTracks || []).map(t => String(t || '').trim()).filter(Boolean);
  return [...new Set(lista)].slice(0, 24);
}

/**
 * Las frases de la ficha, solo con datos reales. `p` lleva title, artist,
 * label, catalog, year, genre, tracks, descTracks, forthcoming, releaseDate.
 * @returns {string[]}
 */
export function textoFicha(p) {
  const titulo = String(p.title || '').trim();
  if (!titulo) return [];
  const artista = artistaDeVendor(p.artist);
  const sello = String(p.label || '').trim();
  const cat = String(p.catalog || '').trim();
  const frases = [];

  let f = `${titulo} is ${p.forthcoming ? 'an upcoming' : 'a'} vinyl record`;
  if (artista) f += ` by ${artista}`;
  if (sello) f += ` on ${sello}`;
  if (cat) f += `, catalogue number ${cat}`;
  if (p.forthcoming && /^\d{4}-\d{2}-\d{2}$/.test(p.releaseDate || '')) f += `, due ${p.releaseDate}`;
  else if (!p.forthcoming && p.year) f += `, released in ${p.year}`;
  frases.push(`${f}.`);

  if (p.genre) frases.push(`Genre: ${p.genre}.`);
  const cortes = nombresDeCortes(p);
  if (cortes.length) frases.push(`Tracklist: ${cortes.join(' · ')}.`);
  return frases;
}

// ── Otras fichas del mismo artista y sello ──────────────────────

const MAX_RELACIONADAS = 8;
/** "Various Artists" no es un artista: enlazaria recopilatorios sin relacion. */
const RE_VARIOS = /^(various(\s+artists)?|v\.?\s?a\.?)$/i;
const clave = s => String(s || '').trim().toLowerCase();

function claveArtista(p) {
  const a = clave(artistaDeVendor(p.artist));
  return a && !RE_VARIOS.test(a) ? a : '';
}

/**
 * Hasta 8 fichas: primero las del mismo artista, luego las del mismo sello,
 * las mas recientes primero (createdAt, y el slug para desempatar). La misma
 * regla para el prerender (con el catalogo entero) y para el modal (con lo que
 * devuelva consultaRelacionadas): con candidatos que incluyan a todos los del
 * artista y el sello, el resultado es el mismo.
 * @param {{slug:string, artist:string, label:string}} p
 * @param {Array<{slug:string, title:string, artist:string, label:string, createdAt?:string, handle?:string}>} candidatos
 */
export function relacionadas(p, candidatos, max = MAX_RELACIONADAS) {
  const art = claveArtista(p);
  const sello = clave(p.label);
  if (!art && !sello) return [];
  const orden = [...(candidatos || [])]
    .filter(c => c && c.slug && c.title && c.slug !== p.slug)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.slug.localeCompare(b.slug));
  const vistos = new Set();
  const out = [];
  const mete = c => {
    if (out.length >= max || vistos.has(c.slug)) return;
    vistos.add(c.slug);
    out.push({ slug: c.slug, handle: c.handle || '', texto: encabezadoFicha(c) });
  };
  if (art) orden.filter(c => claveArtista(c) === art).forEach(mete);
  if (sello) orden.filter(c => clave(c.label) === sello).forEach(mete);
  return out;
}

/**
 * El `query` de la Storefront API para traer los candidatos desde el cliente:
 * uno por artista y otro por sello, cada uno con los mas recientes primero.
 * Shopify busca por palabras (vendor:"Ron Trent" trae tambien "Chez Damier &
 * Ron Trent"), asi que es un superconjunto y relacionadas() hace el filtro
 * exacto.
 */
export function consultasRelacionadas(p) {
  const q = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return {
    artista: claveArtista(p) ? `vendor:${q(artistaDeVendor(p.artist))}` : '',
    sello: clave(p.label) ? `tag:${q(`label:${String(p.label).trim()}`)}` : '',
  };
}

// ── HTML ────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Los colores del bloque: los tokens de `S` en src/App.jsx (text, muted,
 * border). El modal le pasa su `S`; el prerender, que no puede importar
 * App.jsx, usa esta copia. Si cambia `S`, cambiar aqui tambien.
 */
export const TEMA_FICHA = { text: '#efefef', muted: '#585858', border: '#1e1e1e' };

/**
 * El bloque de texto y enlaces, en HTML con estilos en linea. Lo pinta el
 * prerender dentro de #root y el modal con dangerouslySetInnerHTML: el mismo
 * marcado en los dos. Discreto y al final de la ficha: el texto como la
 * descripcion del modal (11px, muted) y los enlaces como las filas del
 * tracklist (cabecera de 9px en mayusculas, filas con borde). La tipografia se
 * hereda. Los enlaces llevan data-handle para que el modal abra la ficha sin
 * recargar.
 */
export function bloqueFichaHtml(p, relacionados = [], tema = TEMA_FICHA) {
  const frases = textoFicha(p);
  if (!frases.length && !relacionados.length) return '';
  const t = { ...TEMA_FICHA, ...tema };
  const artista = claveArtista(p) ? artistaDeVendor(p.artist) : '';
  const de = [artista, String(p.label || '').trim()].filter(Boolean).join(' · ');
  const texto = frases.length
    ? `<p style="margin:0 0 14px;font-size:11px;line-height:1.75;color:${t.muted}">${frases.map(esc).join(' ')}</p>`
    : '';
  const enlaces = relacionados.length
    ? `<nav aria-label="More records"><div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${t.muted};margin:0 0 6px">More from ${esc(de)}</div><ul style="list-style:none;margin:0;padding:0">${relacionados
        .map(r => `<li style="padding:4px 0;border-bottom:1px solid ${t.border}"><a href="/products/${esc(r.slug)}/" data-handle="${esc(r.handle)}" style="color:${t.muted};text-decoration:none;font-size:11px">${esc(r.texto)}</a></li>`)
        .join('')}</ul></nav>`
    : '';
  return `<section data-ficha-seo style="padding:18px 26px 22px;border-top:1px solid ${t.border}">${texto}${enlaces}</section>`;
}
