// La tarjeta regalo (producto "House Only Gift Card", handle gift-card). Una
// sola definicion para la app (src/App.jsx), las consultas del catalogo
// (src/catalogo.mjs) y el prerender (scripts/prerender.mjs).
//
// No es un disco: no sale en la rejilla, ni en las pildoras de genero, ni en el
// buscador, ni tiene /products/<slug>/. Tiene su propia ficha en /gift-card/.
//
// Se reconoce por tres cosas, cualquiera basta: `isGiftCard` (lo que Shopify
// dice del producto), el tipo de producto "Gift Card" y el handle. Comprobado
// en el admin el 2026-10-19: isGiftCard true, productType "Gift Card", sin tags,
// variantes €25 / €50 / €100.

export const GIFT_CARD = {
  handle: 'gift-card',
  path: '/gift-card/',
  productType: 'Gift Card',
  label: 'Gift card',
  title: 'Gift Card — House Only',
  description: 'A House Only gift card, delivered by email. They pick the records.',
};

/**
 * Clausula para `products(query:)` de la Storefront API. `product_type` es uno
 * de los campos documentados del filtro y el "-" lo excluye. Medido contra la
 * tienda el 2026-10-19: no quita ni un disco (1349 con y sin ella).
 */
export const EXCLUIR_TARJETAS = `-product_type:'${GIFT_CARD.productType}'`;

/** Acepta un nodo de la Storefront API o un registro ya parseado. */
export function esTarjetaRegalo(p) {
  if (!p) return false;
  return p.isGiftCard === true
    || String(p.productType || '').trim().toLowerCase() === GIFT_CARD.productType.toLowerCase()
    || p.handle === GIFT_CARD.handle;
}

/** Segunda barrera tras la clausula: si una tarjeta llega igual, no se pinta. */
export const sinTarjetas = edges => (edges || []).filter(e => !esTarjetaRegalo(e?.node ?? e));

export const esRutaTarjeta = path => /^\/gift-card\/?$/.test(String(path || ''));

/** "€25" de la variante; el titulo de Shopify ya es el importe. */
export const importeDeVariante = v => String(v?.option || v?.title || '').trim() || `€${Number(v?.price || 0).toFixed(0)}`;

/**
 * La portada de la ficha: en la tarjeta, la imagen del importe elegido (cada
 * variante tiene la suya en Shopify); si no la tiene, la del producto. Un disco
 * usa siempre la del producto.
 */
export const portadaDe = (r, variante) => ((r?.isGiftCard && variante?.imagen) || r?.coverUrl || null);
