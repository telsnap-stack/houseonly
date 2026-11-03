/**
 * Nombre de pista a partir del nombre de fichero del promopack. Compartido entre
 * el importer de Mother Tongue (src/App.jsx, donde nacio) y la bandeja de
 * escucha (lib/listen.ts), para que los dos limpien igual.
 */
import { claveCatno } from './preorder-rechazos.mjs';

// ── TRACK NAME EXTRACTION ─────────────────────────────────────
// Strip prefixes (A1, B2, Side A.1, 01., catalog number) and suffixes
// (Snippet, Clip, Preview, "60 sec taster", "[1.30MIN SNIPPET]", " - 2000BLACK").
// Catno is passed in so we can recognize SKU-prefixed track names like
// "DTW082 A1 Don't Forget Your Hiss" or "MT19022- 1-A1 Terra de Luz".
export function trackNameFromFilename(fname, catno) {
  return limpiaNombre(fname, catno) || fname.replace(/\.[^.]+$/, '');
}

// La limpieza sola: '' si no queda nada (p. ej. "CITS007_A1-snippet").
function limpiaNombre(fname, catno) {
  let n = fname.replace(/\.[^.]+$/, '');
  n = n.replace(/_/g, ' ');
  n = n.replace(/\s*\[\s*\d+\.?\d*\s*MIN\s*SNIPPET\s*\]\s*/i, '');

  const skuRx = catno ? catno.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  for (let i = 0; i < 5; i++) {
    const before = n;
    n = n.replace(/^[\s\-–]+/, '');
    if (skuRx) n = n.replace(new RegExp('^' + skuRx + '\\s*', 'i'), '');
    n = n.replace(/^[AB]\s*[-–]\s+/i, '');
    n = n.replace(/^\d+\s*[-–]\s*/, '');
    n = n.replace(/^[AB]\d+\.?\s*[-–]?\s*/i, '');
    n = n.replace(/^Side\s+[A-D][.\s_-]*\d*\s*[-–]?\s*/i, '');
    n = n.replace(/^TRACK\s+\d+[\s_\-]*/i, '');
    n = n.replace(/^\d{1,2}[\s_.\-]+/, '');
    if (n === before) break;
  }
  // "sound clip" (Dapple, 2026-11-03) antes que "clip" a secas, o quedaba "… sound".
  n = n.replace(/[\s_.\-]*\(?\s*(sound\s+clip|snippet|snip|preview|clip|teaser|taster)s?\s*\)?\s*$/i, '');
  n = n.replace(/[\s_-]*\(\s*\d+\s*sec\s+taster\s*\)\s*$/i, '');
  n = n.replace(/\s*-\s*2000BLACK\s*$/i, '');
  n = n.replace(/\s{2,}/g, ' ').trim();
  return n;
}

/**
 * Para mostrar y para el producto: lo de arriba y, si lo que queda no es un
 * titulo (un numero suelto "1", el catno, un codigo como "DMSR8411"), la cara
 * del fichero ("CITS007_A1-snippet" → "A1", "Side B 2" → "B2") y, si tampoco
 * la trae, "Pista N".
 */
export function nombreDePista(crudo, catno, i, artista = '') {
  // El catno, escrito con o sin separadores ("LN017-Sugar…" con catno LN-017).
  const k = claveCatno(catno);
  let sinCatno = k ? String(crudo || '').replace(new RegExp('^' + k.split('').join('[\\s._-]*') + '[\\s._-]*', 'i'), '') : String(crudo || '');
  // DBH: "<catno> - <n>. <artista> - <titulo>", a veces con el artista otra vez
  // detras de la cara ("ME015 - 1. George Apergis - A1 George Apergis - Psilocybe").
  const art = String(artista || '').trim();
  const delArtista = art ? new RegExp('^' + art.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+[-–]\\s+', 'i') : null;
  if (delArtista) sinCatno = sinCatno.replace(/^\d{1,2}\.\s+/, m => delArtista.test(sinCatno.slice(m.length)) ? '' : m).replace(delArtista, '');
  // Cara sin numero ("B. Gradien Flow", PLZ014S): la del artista, sin mas.
  if (delArtista) sinCatno = sinCatno.replace(/^[A-D]\.\s+/, '');
  // Lo guardado no lleva extension: sin la ".mp3" de vuelta, limpiaNombre se
  // comeria "A1. Orcas Chord" desde el punto como si fuera una.
  let n = limpiaNombre(`${sinCatno}.mp3`, catno);
  if (delArtista) n = n.replace(delArtista, '');
  const sinTitulo = !n || /^\d+$/.test(n) || claveCatno(n) === claveCatno(catno) || /^[A-Z]{2,}[\s-]?\d+[A-Z0-9-]*$/.test(n);
  if (!sinTitulo) return n;
  const cara = sinCatno.match(/(?:^|[\s._-])(?:side[\s._-]*)?([A-D])[\s._-]?(\d{1,2})(?=$|[\s._-])/i);
  return cara ? `${cara[1].toUpperCase()}${Number(cara[2])}` : `Pista ${i + 1}`;
}
