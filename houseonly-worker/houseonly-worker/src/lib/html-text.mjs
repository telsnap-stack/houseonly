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

// ── LA PROSA DE UN CORREO DE ANUNCIO ────────────────────────────────
//
// `parseDistributorEmail` saca de cada bloque la ventana de texto que rodea a
// la ficha del disco. Esa ventana NO es una descripcion: arrastra el saludo, la
// cabecera del anuncio repetida, y en los reenvios la cabecera del mensaje
// entera —con la direccion de correo del distribuidor Y la del destinatario—.
// Escribir eso en el producto publica dos direcciones privadas en la tienda.
//
// Medido sobre los 517 correos del archivo el 2026-09-17: de 19 discos con
// ventana de texto, solo 13 tenian prosa de verdad debajo de toda esa capa.

/** `---------- Forwarded message ---------` y las cuatro cabeceras que le siguen. */
const RE_REENVIO = /-{3,}\s*Forwarded message\s*-{3,}/gi;
const RE_CABECERA_CORREO = /^\s*(From|Date|Subject|To|Sent|Cc|Bcc)\s*:.*$/gim;

/** Cualquier direccion, escrita a pelo o como la deja el HTML del cliente. */
const RE_EMAIL = /\(?\s*mailto:[^\s)]+\s*\)?|[<(]?\b[\w.+-]+@[\w-]+\.[\w.-]+\b[>)]?/gi;

/** `Hello Eduardo Montagut,` — el saludo del mailing, con o sin nombre. */
const RE_SALUDO = /\b(?:hello|hi|hey|dear)\b[^,.!\n]{0,40}[,!]/gi;

/**
 * La linea de anuncio del distribuidor: `OUT SOON ON RAWAX: RV10 - RICARDO
 * VILLALOBOS - MONOSTEREO (12")`. DBH la manda hasta tres veces seguidas y no
 * dice nada que la ficha no diga ya.
 */
// El titulo lleva puntos dentro —`Gottwood Future Ltd. (12")`— asi que la
// ventana no puede cortarse en el primer punto; se limita por longitud.
const RE_ANUNCIO = /(?:DBH-Music\s*[-–]\s*)?\b(?:out\s+soon|new\s+release)\b[^\n]{0,140}?\(\s*\d+\s*["”']\s*\)/gi;

/**
 * `DBH Music welcomes GIOTTWAX to the distribution family!` — eso habla del
 * acuerdo con el distribuidor, no del disco. Solo la FAMILIA DE DISTRIBUCION:
 * «RAWAX welcomes Mad Rey to the artist family» si es texto del sello sobre su
 * fichaje, y ese se queda.
 */
const RE_BIENVENIDA = /\b[\w\s-]{0,30}welcomes\b[^\n]{0,80}?\bto the distribution family\b[!.]?/gi;

/** `Price correction - CITB019 - ...`: es un aviso de precio, no una descripcion. */
/**
 * Avisos de logistica que llegan en el mismo hueco que la prosa: `Price
 * correction - CITB019 - ...`, `NEW DATE: VIBEZ93031 - ... (06-11-2026)`. Son
 * mensajes para el comprador mayorista, no texto de ficha.
 */
const RE_AVISO_PRECIO = /\b(?:price\s+correction|new\s+date|date\s+change|postponed)\b[^\n]*/gi;

/**
 * Corta el tracklist del final. Mismo criterio que `descripcionDeProducto`: si
 * hay tres marcas o mas —`A1.`, `B2.`, `01`, `1.`— lo que va de la primera en
 * adelante es la lista, y la lista la pinta el reproductor.
 */
function sinTracklist(texto) {
  // Tres grafias reales del archivo: `A1. Chess`, `1.No. 1` (sin espacio tras el
  // punto) y `01 Crystal Fantasy` (cero delante, sin puntuacion). Las tres son
  // la misma cosa y ninguna es prosa.
  const marcas = [...texto.matchAll(
    /(?:^|\s)(?:(?:[A-F]{1,2}\d{1,2}|\d{1,2})\s*[.)–-]\s*|[A-F]{1,2}\d{1,2}\s|0\d\s+(?=[A-Za-z])|[A-F]\s*[.)]\s+(?=[A-Z]))/g)];
  if (!marcas.length) return texto;
  const corte = marcas[0].index;
  // Tres marcas son una lista en cualquier sitio. Dos bastan si estan al final:
  // un maxi de dos cortes se anuncia `A. … B. …` y eso, pegado detras de la
  // reseña, es la lista igual (LOG86). Dos marcas en medio de un parrafo no.
  if (marcas.length < 3 && !(marcas.length === 2 && corte > texto.length * 0.6)) return texto;
  // Solo si la lista esta en la cola: una marca al principio es texto normal
  // que empieza por un numero, no una lista.
  // La lista en la cola se corta. Si empieza casi al principio, lo que queda
  // delante no llega a descripcion y el `minimo` lo descarta: el bloque entero
  // ERA la lista. Pasa con los reenvios de Rubadub sin reseña, que traian solo
  // la cabecera del mensaje y los cortes, y publicaban 'A1. December Blackout
  // 1.4' como descripcion del disco.
  return texto.slice(0, corte);
}

/** Frases repetidas literalmente, que es como llegan los anuncios duplicados. */
function sinRepetidas(texto) {
  const vistas = new Set();
  return texto.split(/(?<=[.!?])\s+/)
    .filter(f => { const k = f.trim().toLowerCase(); if (!k || vistas.has(k)) return false; vistas.add(k); return true; })
    .join(' ');
}

/**
 * Lo que de verdad se puede publicar de la ventana de texto de un correo.
 *
 * Devuelve '' cuando debajo de la capa no queda nada: un bloque que solo trae
 * saludo y cabecera no es una descripcion corta, es que no hay descripcion, y
 * escribirla vacia es mejor que escribir ruido.
 */
export function prosaDeCorreo(entrada, { minimo = 60 } = {}) {
  let t = String(entrada || '');
  t = t.replace(RE_REENVIO, '\n').replace(RE_CABECERA_CORREO, '\n');
  t = t.replace(RE_EMAIL, ' ');
  t = t.replace(RE_ANUNCIO, ' ').replace(RE_BIENVENIDA, ' ')
       .replace(RE_AVISO_PRECIO, ' ').replace(RE_SALUDO, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  t = sinTracklist(t);
  t = sinRepetidas(t);
  // Restos de puntuacion que quedan donde se quito un trozo.
  t = t.replace(/\s+([,.;:])/g, '$1').replace(/^[\s,.;:–-]+/, '').replace(/\s+/g, ' ').trim();
  // La ventana del correo se corta por longitud, asi que puede terminar a mitad
  // de palabra —IT57 acababa en 'and thei'—. Se retrocede a la ultima frase
  // cerrada: una descripcion truncada canta mas que una descripcion mas corta.
  if (t && !/[.!?…]["”')]?$/.test(t)) {
    const fin = Math.max(t.lastIndexOf('.'), t.lastIndexOf('!'), t.lastIndexOf('?'));
    if (fin >= minimo) t = t.slice(0, fin + 1);
  }
  return t.length >= minimo ? t : '';
}

/**
 * El cuerpo del producto SIN lo que la ficha ya genera por su cuenta: la frase
 * de cabecera, el tracklist escrito a mano y la coletilla de envio.
 *
 * Es el gemelo en HTML de `descripcionDeProducto`, que hace lo mismo pero
 * devuelve texto. Hace falta al ESCRIBIR: para meter una descripcion de verdad
 * en un producto viejo no basta con ponerla delante —la cabecera dejaria de
 * estar al principio y el limpiador de lectura ya no la reconoceria, asi que
 * saldria publicada—. Hay que quitarla de verdad.
 *
 * Lo que NO toca: el `<script id="tracks">` del reproductor y cualquier otra
 * cosa que haya en el cuerpo. Solo borra los tres bloques que generamos.
 */
export function cuerpoSinGenerado(bodyHtml) {
  let html = String(bodyHtml || '');
  const cab = html.match(RE_CABECERA);
  if (cab && /\bby\b|released on/i.test(cab[0])) html = html.slice(cab[0].length);
  html = html.replace(RE_COLETILLA, '');
  const bloque = html.match(RE_BLOQUE_OL);
  if (bloque) html = html.replace(bloque[0], '');
  return html.trim();
}

/** Texto plano a un parrafo de HTML, escapando lo que Shopify guardaria mal. */
export function parrafoHtml(texto) {
  const t = String(texto || '').trim();
  if (!t) return '';
  return `<p>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
}
