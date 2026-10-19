// npm test  (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIFT_CARD, EXCLUIR_TARJETAS, esTarjetaRegalo, sinTarjetas, esRutaTarjeta, importeDeVariante } from './giftcard.mjs';
import { clausulasDeSeccion, partesDeBusqueda } from './catalogo.mjs';
import { productosDelCatalogo, renderSitemap } from '../scripts/prerender.mjs';

// Lo que devuelve la Storefront API para la tarjeta (comprobado en el admin el
// 2026-10-19) y para un disco cualquiera.
const nodo = (o = {}) => ({
  id: 'gid://shopify/Product/1', title: 'Ultramarine EP', vendor: 'Sanskrit', handle: 'fat072',
  descriptionHtml: '', tags: ['House'], isGiftCard: false, productType: '',
  variants: { edges: [{ node: { sku: 'FAT072', price: { amount: '13.99' }, quantityAvailable: 2 } }] },
  images: { edges: [] }, ...o,
});
const TARJETA = nodo({
  id: 'gid://shopify/Product/16003939991936', title: 'House Only Gift Card', vendor: 'House Only',
  handle: 'gift-card', tags: [], isGiftCard: true, productType: 'Gift Card',
  variants: { edges: [{ node: { sku: null, price: { amount: '25.00' }, quantityAvailable: null } }] },
});

test('la tarjeta se reconoce por isGiftCard, por tipo o por handle; un disco no', () => {
  assert.equal(esTarjetaRegalo(TARJETA), true);
  assert.equal(esTarjetaRegalo({ isGiftCard: true }), true);
  assert.equal(esTarjetaRegalo({ productType: 'gift card' }), true);
  assert.equal(esTarjetaRegalo({ handle: 'gift-card' }), true);
  assert.equal(esTarjetaRegalo(nodo()), false);
  assert.equal(esTarjetaRegalo(nodo({ title: 'Gift Card EP', handle: 'gift-card-ep' })), false);
});

test('la rejilla y las pildoras de genero piden sin tarjetas, en todas las secciones', () => {
  for (const seccion of [{}, { forthcoming: true }, { dnb: true }, { filterTags: ['genre:deephouse'] }]) {
    assert.ok(clausulasDeSeccion(seccion).includes(EXCLUIR_TARJETAS), JSON.stringify(seccion));
  }
  assert.equal(EXCLUIR_TARJETAS, "-product_type:'Gift Card'");
});

test('el buscador tampoco la mezcla con los discos, ni buscando "gift card"', () => {
  for (const termino of ['gift card', 'moodymann', 'deep house']) {
    assert.ok(partesDeBusqueda({ termino }).includes(EXCLUIR_TARJETAS), termino);
    assert.ok(partesDeBusqueda({ termino, forthcoming: true }).includes(EXCLUIR_TARJETAS), termino);
  }
  // Lo de antes sigue igual: el genero entero va como tag, el resto texto libre
  assert.equal(partesDeBusqueda({ termino: 'deep house' })[0], "tag:'genre:deephouse'");
  assert.equal(partesDeBusqueda({ termino: ' pampa ' })[0], 'pampa');
});

test('segunda barrera: si una tarjeta llega en la respuesta, se quita', () => {
  const edges = [{ node: nodo(), cursor: 'a' }, { node: TARJETA, cursor: 'b' }];
  assert.deepEqual(sinTarjetas(edges).map(e => e.cursor), ['a']);
});

test('prerender: sin /products/ para la tarjeta, y al sitemap solo si esta publicada', () => {
  const productos = productosDelCatalogo([nodo(), TARJETA]);
  assert.deepEqual(productos.map(p => p.handle), ['fat072']);
  const sin = renderSitemap(productos);
  assert.ok(!sin.includes('gift-card'));
  const con = renderSitemap(productos, [], [], { giftCard: true });
  assert.ok(con.includes('https://houseonly.store/gift-card/'));
  assert.ok(!con.includes('/products/house-only-gift-card'));
});

test('ruta propia e importes', () => {
  assert.equal(GIFT_CARD.path, '/gift-card/');
  assert.ok(esRutaTarjeta('/gift-card') && esRutaTarjeta('/gift-card/'));
  assert.ok(!esRutaTarjeta('/products/gift-card/'));
  assert.equal(importeDeVariante({ option: '€50', price: 50 }), '€50');
});
