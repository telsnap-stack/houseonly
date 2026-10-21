/**
 * Posible duplicado al importar (2026-10-21). Los importers ya dejaban fuera
 * del CSV los discos cuyo SKU esta tal cual en la tienda; los que coinciden
 * salvo sufijo o ceros (AD002dub / AD002, UR-025 / UR-025A, LOG88 / LOG088)
 * pasaban y creaban un segundo producto. La regla es la del tab Pre-order
 * (buscaEnTienda); aqui no se ocultan solos: se avisa y no entran en el CSV
 * hasta que se decide.
 *
 *   'mismo'  es el disco de la tienda: se trata como "ya en tienda" (Add stock
 *            y Completar media, con el SKU de la tienda)
 *   'crear'  es otro disco: entra en el CSV
 *   sin decidir: fuera del CSV
 */
import { claveCatno, indiceTienda, buscaEnTienda } from '../houseonly-worker/houseonly-worker/src/lib/preorder-rechazos.mjs';

/**
 * Rubadub pega a veces la version al catno: la factura de septiembre decia
 * "AD002dub" y el disco es AD002 (W&S y el email), y entro con ese SKU. Solo
 * estas palabras: "YORE-011LTD" o "UR-029r" son ediciones de verdad.
 */
const SUFIJO_VERSION = /(\d)[\s-]*(?:dubs?|remix(?:es)?|mix(?:es)?)$/i;
export const limpiaSkuRd = sku => String(sku || '').trim().replace(SUFIJO_VERSION, '$1');

// Un indice por catalogo: los importers preguntan fila a fila.
const indices = new WeakMap();
function indiceDe(live) {
  if (!indices.has(live)) indices.set(live, indiceTienda([...live]));
  return indices.get(live);
}

/**
 * @param live   el Set de fetchLiveHandles (claves de handles y SKUs, con skuReal)
 * @returns { _alreadyLive, _posibleDuplicado } — el segundo, el SKU de la
 *   tienda con el que casa salvo sufijo, o ''
 */
export function enTiendaODuplicado(live, catno) {
  const k = claveCatno(catno);
  if (!live || !k) return { _alreadyLive: false, _posibleDuplicado: '' };
  if (live.has(k)) return { _alreadyLive: true, _posibleDuplicado: '' };
  const como = buscaEnTienda(indiceDe(live), catno);
  return { _alreadyLive: false, _posibleDuplicado: como ? (live.skuReal?.get(como) || como) : '' };
}

const decision = (r, dup) => (dup || {})[claveCatno(r._catno)];

/** Se trata como ya en tienda: igual de verdad, o duplicado confirmado. */
export const comoEnTienda = (r, dup) =>
  !!r._alreadyLive || (!!r._posibleDuplicado && decision(r, dup) === 'mismo');

/** No viaja en el CSV: en tienda, o duplicado sin "crear". */
export const fueraDelCsv = (r, dup) =>
  !!r._alreadyLive || (!!r._posibleDuplicado && decision(r, dup) !== 'crear');

/** El SKU con el que Add stock y Completar media van a Shopify. */
export const skuEnTienda = (r, live) =>
  (r._alreadyLive ? live?.skuReal?.get(claveCatno(r._catno)) : r._posibleDuplicado) || r._catno;
