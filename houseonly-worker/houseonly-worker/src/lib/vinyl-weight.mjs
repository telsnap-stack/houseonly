// ── PESO DE ENVIO DE UN DISCO ───────────────────────────────────────
//
// Una sola regla para todo lo que pone pesos en Shopify: el script
// scripts/set-weights-from-discogs.mjs (formato del release de Discogs) y los
// importers de src/App.jsx (formato del distribuidor o texto del titulo).
//
//   peso = 0,15 kg de embalaje + discos × peso por disco (+0,20 si es box set)
//   12" o LP = 0,25 kg · 10" = 0,18 · 7" = 0,08
//
// Un 12" suelto embalado sale a 0,40 kg (Eduardo midio ~400 g). Sin ningun dato
// de formato, eso es lo que se pone. Antes los importers adivinaban 500/900 g y
// un 3LP o un box salia con 500 (memoria vinyl-weights-are-guessed-at-import).
// El peso decide el tramo de envio y lo que va en la declaracion de aduanas.

export const EMBALAJE_KG = 0.15;
export const KG_POR_DISCO = { 12: 0.25, 10: 0.18, 7: 0.08 };
export const BOX_SET_KG = 0.2;
export const PESO_POR_DEFECTO_KG = 0.4;

const r2 = (x) => Math.round(x * 100) / 100;

function pesoDe(partes, box) {
  const discos = partes.reduce((s, p) => s + p.n, 0);
  const kg = r2(EMBALAJE_KG + partes.reduce((s, p) => s + p.n * KG_POR_DISCO[p.talla], 0) + (box ? BOX_SET_KG : 0));
  return { kg, discos, partes, box };
}

/** "2×12" · "1×7" + box → texto corto para tablas e informes. */
export function describirPeso(r) {
  if (!r) return '';
  return r.partes.map((p) => `${p.n}×${p.talla}"${p.sinTalla ? '?' : ''}`).join(' + ') + (r.box ? ' + box' : '');
}

/**
 * Peso a partir de `formats` de un release de Discogs:
 * [{ name: 'Vinyl', qty: '2', descriptions: ['LP', 'Album'] }, { name: 'CD', … }].
 * Solo cuentan los de tipo Vinyl (CD, cassette, insertos… fuera). Devuelve null
 * si no hay ninguno: ese producto no se toca.
 */
export function pesoDesdeDiscogs(formats) {
  const lista = Array.isArray(formats) ? formats : [];
  const vinilos = lista.filter((f) => /^vinyl$/i.test(String(f?.name || '').trim()));
  if (!vinilos.length) return null;
  const partes = vinilos.map((f) => {
    const n = Math.max(1, parseInt(f?.qty, 10) || 1);
    const d = (f?.descriptions || []).map((x) => String(x).trim());
    // Primero los tamanos explicitos: un 10" LP es un 10", no un 12".
    if (d.some((x) => /^7"$/.test(x))) return { n, talla: 7 };
    if (d.some((x) => /^10"$/.test(x))) return { n, talla: 10 };
    if (d.some((x) => /^12"$/.test(x) || /^LP$/i.test(x))) return { n, talla: 12 };
    return { n, talla: 12, sinTalla: true };   // Vinyl sin tamano: se cuenta como 12" y se marca
  });
  const box = lista.some((f) => /box\s*set/i.test(String(f?.name || '')) || (f?.descriptions || []).some((x) => /box\s*set/i.test(String(x))));
  return pesoDe(partes, box);
}

/**
 * Peso a partir del texto de formato del distribuidor y/o del titulo:
 * "2x 12\"LP", "3LP", "2xLP", "Double LP", "7\"", "Box Set"… Sin nada que
 * reconocer, un 12" suelto (0,40 kg) con `origen: 'defecto'`.
 */
export function pesoDesdeTexto(...textos) {
  const s = textos.filter(Boolean).map(String).join(' ').toLowerCase().replace(/[″”“]/g, '"').replace(/''/g, '"');
  const talla = /(?:^|[^0-9])7\s*(?:"|inch|in\b)/.test(s) ? 7
    : /(?:^|[^0-9])10\s*(?:"|inch|in\b)/.test(s) ? 10
    : 12;
  let n = 0;
  const m = s.match(/(?:^|[^0-9])([1-9])\s*[x×]\s*(?:12|10|7)?\s*(?:"|inch|in\b)?\s*(?:lp|vinyl|"|inch|in\b)/)
    || s.match(/(?:^|[^0-9])([1-9])\s*-?\s*lp\b/);
  if (m) n = parseInt(m[1], 10);
  else if (/\btriple\b/.test(s)) n = 3;
  else if (/\bdouble\b/.test(s)) n = 2;
  const box = /box\s*-?\s*set|\bboxset\b/.test(s);
  const hayFormato = n > 0 || box || /\blp\b|(?:^|[^0-9])(?:12|10|7)\s*(?:"|inch|in\b)/.test(s);
  if (!hayFormato) return { ...pesoDe([{ n: 1, talla: 12 }], false), kg: PESO_POR_DEFECTO_KG, origen: 'defecto' };
  return { ...pesoDe([{ n: Math.max(1, n), talla }], box), origen: 'texto' };
}

/** Lo mismo en gramos y como texto, para la columna "Variant Grams" del CSV. */
export function gramosDesdeFormato(...textos) {
  return String(Math.round(pesoDesdeTexto(...textos).kg * 1000));
}

/** Tramo de envio de Shopify al que cae un peso. */
export function tramo(kg) {
  if (kg <= 0.5) return '≤0,5';
  if (kg <= 0.9) return '0,5–0,9';
  if (kg <= 2) return '0,9–2';
  return '>2';
}
