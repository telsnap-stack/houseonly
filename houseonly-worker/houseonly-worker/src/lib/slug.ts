/**
 * El slug con el que el SITIO identifica un disco. No es el handle de Shopify.
 *
 * El handle suele ser el SKU —"chiwax027ltd"— mientras que el slug es
 * artista+titulo —"jakobiin-a-place-called-jack"—, y es lo que llevan los
 * enlaces, el sitemap y las paginas prerenderizadas. Un enlace construido con el
 * handle cae en la home.
 *
 * MUST mirror `makeSlug()` de src/App.jsx y de scripts/prerender.mjs. Las tres
 * copias tienen que dar exactamente lo mismo o los enlaces dejan de casar con
 * las paginas generadas; esta es la del worker, y la comparten el newsletter,
 * el feed y el portal.
 */

export function slugifyRelease(str: string): string {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

export function makeReleaseSlug(artist: string, title: string, catalog: string): string {
  const base = [artist, title].filter(Boolean).join(' ');
  const s = slugifyRelease(base);
  if (s) return s;
  return slugifyRelease(catalog) || 'release';
}
