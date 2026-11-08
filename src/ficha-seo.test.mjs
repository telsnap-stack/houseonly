// npm test  (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify, makeSlug, artistaDeVendor, encabezadoFicha, tituloFicha, metaDeTags, gtinDe,
  textoFicha, relacionadas, consultasRelacionadas, bloqueFichaHtml,
} from '../houseonly-worker/houseonly-worker/src/lib/ficha-seo.mjs';
import { makeReleaseSlug } from '../houseonly-worker/houseonly-worker/src/lib/slug.ts';
import { productosDelCatalogo, renderProductHtml, renderSitemap, conPiePoliticas } from '../scripts/prerender.mjs';

// Lo que devuelve la Storefront API (FAR04 tal cual estaba el 2026-11-08).
const nodo = (o = {}) => ({
  id: 'gid://shopify/Product/1', title: 'Forward Motions EP', vendor: 'Shawn Ward', handle: 'far04',
  descriptionHtml: '<script type="application/json" id="tracks">[{"name":"A1 Back To The Future","d":"","url":"x"},{"name":"A2 Holiday","d":"","url":"y"},{"name":"B1 Night Vibes","d":"","url":"z"}]</script>',
  tags: ['2026', 'genre:house', 'label:Flat & Round', 'source:ws', 'vinyl'],
  isGiftCard: false, productType: '', createdAt: '2026-10-01T10:00:00Z',
  variants: { edges: [{ node: { sku: 'FAR04', barcode: '', price: { amount: '20.99' }, quantityAvailable: 2 } }] },
  images: { edges: [{ node: { url: 'https://cdn.shopify.com/far04.jpg' } }] }, ...o,
});
const PLANTILLA = '<!doctype html><html><head><title>houseonly</title><link rel="canonical" href="https://houseonly.store/" /></head><body><div id="root"></div></body></html>';

test('slug: una sola regla para App, prerender y worker', () => {
  assert.equal(makeSlug('Shawn Ward', 'Forward Motions EP', 'FAR04'), 'shawn-ward-forward-motions-ep');
  assert.equal(makeSlug('Chez Damier & Ron Trent', 'Morning Factory', 'X'), 'chez-damier-and-ron-trent-morning-factory');
  assert.equal(makeSlug('Naïm', '', ''), 'naim');
  assert.equal(makeSlug('', '', 'SS 004'), 'ss-004');
  assert.equal(makeSlug('', '', ''), 'release');
  // El vendor por defecto de Shopify no es un artista (DJ Series Vol 4.).
  assert.equal(artistaDeVendor('House Only'), '');
  assert.equal(makeSlug('House Only', 'DJ Series Vol 4.', 'FS004'), 'dj-series-vol-4');
  // El worker usa la misma copia.
  assert.equal(makeReleaseSlug('House Only', 'DJ Series Vol 4.', 'FS004'), 'dj-series-vol-4');
  assert.equal(slugify('  --A&B--  '), 'a-and-b');
});

test('titulo: Artista – Titulo (Sello, Catalogo) Vinyl | House Only', () => {
  const p = { artist: 'Shawn Ward', title: 'Forward Motions EP', label: 'Flat & Round', catalog: 'FAR04' };
  assert.equal(tituloFicha(p), 'Shawn Ward – Forward Motions EP (Flat & Round, FAR04) Vinyl | House Only');
  assert.equal(encabezadoFicha(p), 'Shawn Ward – Forward Motions EP');
  assert.equal(tituloFicha({ ...p, label: '' }), 'Shawn Ward – Forward Motions EP (FAR04) Vinyl | House Only');
  assert.equal(tituloFicha({ ...p, label: '', catalog: '' }), 'Shawn Ward – Forward Motions EP Vinyl | House Only');
  assert.equal(tituloFicha({ ...p, artist: 'House Only' }), 'Forward Motions EP (Flat & Round, FAR04) Vinyl | House Only');
  // "Vinyl" no se repite.
  assert.equal(tituloFicha({ ...p, title: 'Wind On Water (Orange Vinyl)' }), 'Shawn Ward – Wind On Water (Orange Vinyl) (Flat & Round, FAR04) | House Only');
});

test('tags: sello, año, pre-order y fecha', () => {
  assert.deepEqual(metaDeTags(['2026', 'label:Flat & Round', 'forthcoming', 'release:2026-12-04']),
    { label: 'Flat & Round', year: 2026, forthcoming: true, releaseDate: '2026-12-04' });
  assert.deepEqual(metaDeTags([]), { label: '', year: null, forthcoming: false, releaseDate: '' });
});

test('gtin: solo con digito de control valido, y la propiedad por longitud', () => {
  assert.deepEqual(gtinDe('4251804189613'), { prop: 'gtin13', value: '4251804189613' });
  assert.deepEqual(gtinDe('198704823671'), { prop: 'gtin12', value: '198704823671' });
  assert.equal(gtinDe('4251804189614'), null);   // control mal
  assert.equal(gtinDe('127173'), null);          // numero interno de distribuidor
  assert.equal(gtinDe(''), null);
  assert.equal(gtinDe(null), null);
});

test('texto: solo frases con datos reales', () => {
  const base = { title: 'Forward Motions EP', artist: 'Shawn Ward', label: 'Flat & Round', catalog: 'FAR04', year: 2026, genre: 'House',
    tracks: [{ name: 'A1 Back To The Future' }, { name: 'A2 Holiday' }] };
  assert.deepEqual(textoFicha(base), [
    'Forward Motions EP is a vinyl record by Shawn Ward on Flat & Round, catalogue number FAR04, released in 2026.',
    'Genre: House.',
    'Tracklist: Back To The Future · Holiday.',
  ]);
  // Nombres de fichero del promopack: limpios; sin titulo, fuera.
  assert.deepEqual(textoFicha({ title: 'Old Friends EP', artist: 'Abyssy & Memoryman', catalog: 'HI002',
    tracks: [{ name: 'HI002 - 1. Abyssy & Memoryman - A1- HER SOUND' }, { name: 'HI002 - 2. Abyssy & Memoryman - B1- PROGRAMMER' }, { name: 'Side B 2' }] })[1],
    'Tracklist: HER SOUND · PROGRAMMER.');
  // Sin sello, sin año, sin genero, sin pistas: no quedan huecos.
  assert.deepEqual(textoFicha({ title: 'Untitled', artist: 'X', catalog: 'C1' }),
    ['Untitled is a vinyl record by X, catalogue number C1.']);
  // Pre-order: "upcoming" y la fecha si la hay; nunca "released in".
  assert.deepEqual(textoFicha({ title: 'T', artist: 'A', year: 2026, forthcoming: true, releaseDate: '2026-12-04' }),
    ['T is an upcoming vinyl record by A, release date 2026-12-04.']);
  assert.deepEqual(textoFicha({ title: 'T', artist: 'A', year: 2026, forthcoming: true }),
    ['T is an upcoming vinyl record by A.']);
  // Sin reproductor, la lista del texto.
  assert.deepEqual(textoFicha({ title: 'T', descTracks: ['A. Uno', 'B. Dos'] }),
    ['T is a vinyl record.', 'Tracklist: A. Uno · B. Dos.']);
  assert.deepEqual(textoFicha({ title: '' }), []);
});

test('relacionadas: artista primero, luego sello, recientes primero, sin repetir, max 8', () => {
  const c = (slug, artist, label, createdAt) => ({ slug, title: slug.toUpperCase(), artist, label, createdAt, handle: slug });
  const p = { slug: 'yo', artist: 'Ron Trent', label: 'Prescription' };
  const cands = [
    c('yo', 'Ron Trent', 'Prescription', '2026-11-01'),                 // la propia: fuera
    c('rt-viejo', 'Ron Trent', 'Electric Blue', '2025-01-01'),
    c('rt-nuevo', 'Ron Trent', 'Prescription', '2026-10-01'),           // artista y sello: una vez
    c('chez', 'Chez Damier & Ron Trent', 'Prescription', '2026-09-01'), // otro artista: va por sello
    c('otro', 'Otro', 'Otro sello', '2026-11-05'),                      // nada que ver
    ...Array.from({ length: 10 }, (_, i) => c(`pres-${i}`, `X${i}`, 'prescription', `2026-0${(i % 9) + 1}-01`)),
  ];
  const r = relacionadas(p, cands);
  assert.equal(r.length, 8);
  assert.deepEqual(r.slice(0, 3).map(x => x.slug), ['rt-nuevo', 'rt-viejo', 'chez']);
  assert.ok(!r.some(x => x.slug === 'yo' || x.slug === 'otro'));
  assert.equal(r[0].texto, 'Ron Trent – RT-NUEVO');
  assert.equal(r[0].handle, 'rt-nuevo');
  // El orden no depende del orden de entrada.
  assert.deepEqual(relacionadas(p, [...cands].reverse()), r);
  // "Various Artists" no enlaza por artista; sin artista ni sello, nada.
  assert.deepEqual(relacionadas({ slug: 'v', artist: 'Various Artists', label: '' }, [c('w', 'Various Artists', '', '2026-01-01')]), []);
  assert.deepEqual(relacionadas({ slug: 'v', artist: '', label: '' }, cands), []);
});

test('consultas del modal: vendor y tag, con comillas escapadas', () => {
  assert.deepEqual(consultasRelacionadas({ artist: 'Shawn Ward', label: 'Flat & Round' }),
    { artista: 'vendor:"Shawn Ward"', sello: 'tag:"label:Flat & Round"' });
  assert.deepEqual(consultasRelacionadas({ artist: 'DJ "Q"', label: '' }), { artista: 'vendor:"DJ \\"Q\\""', sello: '' });
  assert.deepEqual(consultasRelacionadas({ artist: 'Various', label: '' }), { artista: '', sello: '' });
});

test('bloque HTML: escapado, enlaces con barra final y data-handle', () => {
  const html = bloqueFichaHtml({ title: 'A <b>', artist: 'X & Y', label: 'L' },
    [{ slug: 'x-and-y-otro', handle: 'cat1', texto: 'X & Y – Otro' }]);
  assert.ok(html.includes('A &lt;b&gt; is a vinyl record by X &amp; Y on L.'));
  assert.ok(html.includes('<a href="/products/x-and-y-otro/" data-handle="cat1"'));
  assert.ok(html.includes('More from X &amp; Y · L'));
  assert.equal(bloqueFichaHtml({ title: '' }, []), '');
});

test('prerender: titulo, JSON-LD, ficha visible dentro de #root', () => {
  const [far] = productosDelCatalogo([nodo({ variants: { edges: [{ node: { sku: 'FAR04', barcode: '4251804189613', price: { amount: '20.99' }, quantityAvailable: 2 } }] } })]);
  const html = renderProductHtml(PLANTILLA, far, [{ slug: 'otra', handle: 'h', texto: 'Shawn Ward – Otra' }]);
  assert.ok(html.includes('<title>Shawn Ward – Forward Motions EP (Flat &amp; Round, FAR04) Vinyl | House Only</title>'));
  assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  assert.equal(ld.name, 'Shawn Ward – Forward Motions EP');
  assert.equal(ld.gtin13, '4251804189613');
  assert.equal(ld.offers.itemCondition, 'https://schema.org/NewCondition');
  // Dentro de #root y sin esconder.
  assert.ok(/<div id="root"><main[^>]*>/.test(html));
  assert.ok(!html.includes('-9999px'));
  assert.ok(html.includes('<h1 style="font-size:22px;margin:18px 0 6px">Shawn Ward – Forward Motions EP</h1>'));
  assert.ok(html.includes('Tracklist: Back To The Future · Holiday · Night Vibes.'));
  assert.ok(html.includes('Genre: House.'));
  assert.ok(html.includes('<a href="/products/otra/"'));
  // Sin barcode valido, sin gtin.
  const [sin] = productosDelCatalogo([nodo()]);
  const ld2 = JSON.parse(renderProductHtml(PLANTILLA, sin).match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  assert.ok(!Object.keys(ld2).some(k => k.startsWith('gtin')));
  // El pie entra dentro de #root, detras de la ficha.
  const conPie = conPiePoliticas(html);
  assert.ok(/<\/main><footer[^>]*><nav aria-label="Store policies">/.test(conPie));
});

test('pie de politicas: enlaces con barra final (sin redireccion 308)', () => {
  const html = conPiePoliticas(PLANTILLA);
  assert.ok(html.includes('<a href="/shipping/"'));
  assert.ok(!/<a href="\/shipping"/.test(html));
});

test('sitemap: una URL por slug aunque dos discos lo compartan', () => {
  const productos = productosDelCatalogo([
    nodo({ title: 'Wind On Water', vendor: 'Fresh & Low', variants: { edges: [{ node: { sku: 'RXT-05', price: { amount: '12' } } }] } }),
    nodo({ title: 'Wind On Water', vendor: 'Fresh & Low', variants: { edges: [{ node: { sku: 'RXT-05R', price: { amount: '12' } } }] } }),
  ]);
  assert.equal(productos.length, 2);
  const xml = renderSitemap(productos);
  assert.equal((xml.match(/\/products\/fresh-and-low-wind-on-water\//g) || []).length, 1);
});
