// Paginas de politicas de la tienda. Una sola lista para el pie y las rutas de
// la app (src/App.jsx) y para el prerender y el sitemap (scripts/prerender.mjs).
//
// El TEXTO de cada pagina no vive aqui: sale de Shopify (shop.shopPolicies, por
// el worker: ?action=shop-policies), asi que si se cambia una politica en el
// admin de Shopify, el siguiente build la recoge. Aqui solo van la ruta, el
// tipo de politica de Shopify y el <title>/description de cada pagina.
export const POLICY_PAGES = [
  { path: '/shipping', type: 'SHIPPING_POLICY',     label: 'Shipping',     title: 'Shipping Policy',    description: 'How House Only ships vinyl records worldwide from Madrid: carriers, delivery times and costs.' },
  { path: '/returns',  type: 'REFUND_POLICY',       label: 'Returns',      title: 'Returns & Refunds',  description: 'How to return a record bought at House Only, what can be returned and how refunds work.' },
  { path: '/contact',  type: 'CONTACT_INFORMATION', label: 'Contact',      title: 'Contact',            description: 'Get in touch with House Only: email, Instagram and our Discogs store.' },
  { path: '/privacy',  type: 'PRIVACY_POLICY',      label: 'Privacy',      title: 'Privacy Policy',     description: 'What personal data House Only collects, why, and how you can access or delete it.' },
  { path: '/terms',    type: 'TERMS_OF_SERVICE',    label: 'Terms',        title: 'Terms of Service',   description: 'The terms that apply when you browse and buy records at House Only.' },
  { path: '/legal',    type: 'LEGAL_NOTICE',        label: 'Legal Notice', title: 'Legal Notice',       description: 'Who runs House Only: company details and legal information.' },
];

// Lo que /contact ensena ademas del texto de Shopify.
export const CONTACT_LINKS = {
  email: 'info@houseonly.store',
  instagram: { label: '@onlyhouseonly', url: 'https://www.instagram.com/onlyhouseonly/' },
  discogs: { label: 'Discogs store', url: 'https://www.discogs.com/seller/houseonly/profile' },
};

/** La pagina de una ruta ("/shipping" o "/shipping/"), o null. */
export function policyPageFor(path) {
  const p = String(path || '').replace(/\/+$/, '') || '/';
  return POLICY_PAGES.find(x => x.path === p) || null;
}
