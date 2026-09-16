/**
 * El HTML de la descripcion, convertido a texto.
 *
 * Shopify guarda la descripcion como HTML y la tienda la pinta como texto
 * plano. Esa conversion la hacia cada uno por su cuenta —App.jsx y el
 * prerender— y solo el prerender decodificaba las entidades, asi que el mismo
 * disco se leia "ru ff & jackin" en el <meta> y "ru ff &amp; jackin" en la
 * ficha. Una sola funcion, dos llamadores.
 *
 * JavaScript plano y no TypeScript a proposito: lo importa scripts/prerender.mjs,
 * que corre con node a secas en el build de Pages. Ese node no quita tipos, y un
 * .ts ahi revienta el build entero con ERR_UNKNOWN_FILE_EXTENSION.
 */

/**
 * `&amp;amp;` existe en el catalogo: viene de textos que llegaron ya escapados
 * y se escaparon otra vez al guardarlos. Va primero, porque si no quedaria un
 * `&amp;` a medio decodificar.
 */
/** @param {string} s @returns {string} */
export function decodeHtmlEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;amp;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&euro;/g, '€')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—');
}

/**
 * Los cierres de parrafo y los <br> pasan a espacio ANTES de quitar etiquetas:
 * sin eso, "…(1999).</p><p>classic…" queda pegado como "(1999).classic".
 */
/** @param {string} html @returns {string} */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<\/(p|div|br|li|h[1-6])\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeHtmlEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * La descripcion de un producto, lista para pintar.
 *
 * Las mismas tres reglas que aplica el importer al ESCRIBIR se aplican aqui al
 * LEER, y por eso viven en este modulo: la tienda y el prerender tienen que
 * decir lo mismo del mismo disco, y el catalogo que ya esta subido no se barre.
 *
 *   1. Fuera la frase de cabecera ("X by Y released on Z (año)"): artista,
 *      titulo, sello y año estan impresos justo encima en la ficha.
 *   2. Fuera la coletilla de envio, que la tienda ya dice en cabecera y pie.
 *   3. Una sola lista de cortes. Si hay <script id="tracks">, esa manda y la
 *      prosa del distribuidor se recorta —pero SOLO si sus cortes cuadran con
 *      los del JSON; si no cuadran puede estar diciendo algo que el JSON no
 *      tiene y se deja—. Si no hay JSON, la lista del texto se devuelve aparte
 *      para que la ficha la pinte como lista y no corrida.
 */

const RE_CABECERA = /^\s*<p>\s*<strong>[^<]*<\/strong>[^<]{0,120}?<\/p>/i;
const RE_COLETILLA = /<p>\s*12"?\s*vinyl\.\s*Worldwide shipping from House Only\.\s*<\/p>/i;
const RE_BLOQUE_OL = /(?:<p>\s*<strong>\s*Track\s*list(?:ing)?\s*<\/strong>\s*<\/p>\s*)?<ol[\s\S]*?<\/ol>/i;
/** Marcas de cara tal como las escriben los distribuidores: A1, B2, "A.", "AA —". */
const RE_MARCAS = /(?:^|\s)(?:[A-F]{1,2}\d{1,2}\b|[A-F]{1,2}\s*[.–\-:]\s+)/g;

export function cortesDelJson(bodyHtml) {
  const m = String(bodyHtml || '').match(/<script[^>]+id="tracks"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  try { const t = JSON.parse(m[1]); return Array.isArray(t) ? t : []; } catch { return []; }
}

export function descripcionDeProducto(bodyHtml) {
  let html = String(bodyHtml || '');
  const cortesJson = cortesDelJson(html).length;

  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');

  // 1 y 2 · lo que la ficha ya dice por su cuenta
  const cab = html.match(RE_CABECERA);
  if (cab && /\bby\b|released on/i.test(cab[0])) html = html.slice(cab[0].length);
  html = html.replace(RE_COLETILLA, '');

  // 3 · la lista, una sola vez
  let cortesDelTexto = [];
  const bloque = html.match(RE_BLOQUE_OL);
  if (bloque) {
    cortesDelTexto = [...bloque[0].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(x => htmlToText(x[1])).filter(Boolean);
    html = html.replace(bloque[0], '');
  }
  let texto = htmlToText(html);
  let prosaRecortada = false;
  if (cortesJson > 0) {
    cortesDelTexto = [];                                   // manda el reproductor
    const cabeza = texto.search(/track\s*list(ing)?\s*:?/i);
    const marcas = texto.match(RE_MARCAS) || [];
    if ((cabeza >= 0 || marcas.length >= 3) && marcas.length === cortesJson) {
      texto = texto.slice(0, cabeza >= 0 ? cabeza : texto.length).trim();
      prosaRecortada = true;
    }
  }
  return { texto: texto.trim(), cortesDelTexto, prosaRecortada, cortesJson };
}
