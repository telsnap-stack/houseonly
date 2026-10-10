// Politicas de la tienda (las paginas de Shopify). Una sola lista para el pie
// de la app (src/App.jsx) y para el del HTML prerenderizado
// (scripts/prerender.mjs): Google Merchant Center comprueba que esten
// enlazadas desde el sitio.
export const POLICY_LINKS = [
  ['Shipping', 'https://checkout.shopify.com/99008938368/policies/53762163072.html?locale=en'],
  ['Returns',  'https://checkout.shopify.com/99008938368/policies/53761507712.html?locale=en'],
  ['Contact',  'https://checkout.shopify.com/99008938368/policies/53762261376.html?locale=en'],
  ['Privacy',  'https://checkout.shopify.com/99008938368/policies/53701345664.html?locale=en'],
  ['Terms',    'https://checkout.shopify.com/99008938368/policies/53761966464.html?locale=en'],
];
