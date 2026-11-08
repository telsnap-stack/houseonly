/**
 * El slug con el que el SITIO identifica un disco. No es el handle de Shopify.
 *
 * El handle suele ser el SKU —"chiwax027ltd"— mientras que el slug es
 * artista+titulo —"jakobiin-a-place-called-jack"—, y es lo que llevan los
 * enlaces, el sitemap y las paginas prerenderizadas. Un enlace construido con el
 * handle cae en la home.
 *
 * La regla vive en ./ficha-seo.mjs, la misma copia que importan src/App.jsx y
 * scripts/prerender.mjs; aqui solo se le da el nombre que usa el worker
 * (newsletter, feed y portal).
 */

export { slugify as slugifyRelease, makeSlug as makeReleaseSlug } from './ficha-seo.mjs';
