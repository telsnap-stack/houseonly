/**
 * El HTML de la descripcion, convertido a texto.
 *
 * Shopify guarda la descripcion como HTML y la tienda la pinta como texto
 * plano. Esa conversion la hacia cada uno por su cuenta —App.jsx y el
 * prerender— y solo el prerender decodificaba las entidades, asi que el mismo
 * disco se leia "ru ff & jackin" en el <meta> y "ru ff &amp; jackin" en la
 * ficha. Una sola funcion, dos llamadores.
 */

/**
 * `&amp;amp;` existe en el catalogo: viene de textos que llegaron ya escapados
 * y se escaparon otra vez al guardarlos. Va primero, porque si no quedaria un
 * `&amp;` a medio decodificar.
 */
export function decodeHtmlEntities(s: string): string {
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
export function htmlToText(html: string): string {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<\/(p|div|br|li|h[1-6])\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeHtmlEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}
