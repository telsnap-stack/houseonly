// node --test scripts/scout/filtro.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { huella, compara, funcionesDe, normForm, normRuta, normDataAttr } from './filtro.mjs';

const pag = (o = {}) => ({ url: 'https://x.test/', forms: [], scripts: [], iframes: [], aria: [], data: [], rutas: [], funciones: [], ...o });
const v2 = (paginas, vistos, capturas = 1) => ({ version: 2, capturas, paginas, vistos });
const vistosDe = p => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v]));

test('el texto de catalogo no deja rastro (Deejay 19-oct)', () => {
  const h = huella({ url: 'u', textos: ['play: chris pascoe – darkside', '+11', 'show the other tracks (17)', 'cart: sylvie – new season lp', 'techno'] });
  assert.deepEqual(h.funciones, []);
});

test('palabras-funcion pasan aunque sean texto de boton (Hard Wax)', () => {
  assert.deepEqual(funcionesDe(['Notify me when/if back in stock']), ['aviso-reposicion']);
  assert.deepEqual(funcionesDe(['Pre-order', 'Add to Wishlist', 'Enqueue release']), ['cola-escucha', 'preventa', 'wishlist']);
  // Un titulo con precio o con muchos numeros es catalogo aunque diga pre-order
  assert.deepEqual(funcionesDe(['Pre-order — £12.99']), []);
});

test('mismo carrito con otro disco no es formulario nuevo (Triple Vision 19-oct)', () => {
  assert.equal(normForm('/cart/add/186575 []'), normForm({ action: 'https://www.triplevision.nl/cart/add/179524', campos: [] }));
  assert.equal(normForm('/player/set/186575/ []'), '/player/set/:id []');
  assert.equal(normForm('//boomkat.us1.list-manage.com/subscribe/post [EMAIL,subscribe]'), '/subscribe/post [EMAIL,subscribe]');
});

test('formularios: a si mismo, vacios y campos de catalogo (Rush Hour, Triple Vision)', () => {
  assert.equal(normForm({ action: '/record/vinyl/daydreaming-0', campos: ['product_id', 'quantity'] }, '/record/vinyl/daydreaming-0'), '(misma pagina) [product_id,quantity]');
  assert.equal(normForm({ action: '', campos: [] }), null);
  assert.equal(normForm({ action: '/filter/releases', campos: ['genre[House]', 'genre[Breaks]', 'customer[email]'] }), '/filter/releases [customer[email],genre[*]]');
});

test('rutas: seccion si, disco no', () => {
  assert.equal(normRuta('/shop/en/gift-cards/'), '/gift-cards');
  assert.equal(normRuta('/pages/record-club'), '/pages/record-club');
  assert.equal(normRuta('/Vick_Lavender_New_Horizons_YRE-011LTD_Vinyl__1257058'), null);
  assert.equal(normRuta('/89415/sanskrit/ultramarine-ep/'), null);
  assert.equal(normRuta('/item12345.html'), null);
});

test('data-* con hash de build o id fuera', () => {
  assert.equal(normDataAttr('data-v-3f2a1b9c'), null);
  assert.equal(normDataAttr('data-product-1234'), null);
  assert.equal(normDataAttr('data-preorder-date'), 'data-preorder-date');
});

test('nuevo es contra todo lo visto: lo que va y vuelve no sale (notify me de Hard Wax)', () => {
  const vistos = { forms: [], scripts: [], iframes: [], aria: [], data: [], rutas: [], funciones: ['aviso-reposicion'] };
  // La semana del 12 el listado no traia agotados; el 19 si.
  const r = compara(v2({ listing: pag() }, vistos), { paginas: { listing: pag({ funciones: ['aviso-reposicion'] }) } });
  assert.deepEqual(r.candidatos, []);
});

test('funcion de verdad nueva sale una vez, por la pagina mas importante', () => {
  const vacio = { forms: [], scripts: [], iframes: [], aria: [], data: [], rutas: [], funciones: [] };
  const nuevo = { paginas: { home: pag({ scripts: ['js.klarna.com'] }), product: pag({ scripts: ['js.klarna.com'] }) } };
  const r = compara(v2({ home: pag() }, vacio, 3), nuevo);
  assert.equal(r.candidatos.length, 1);
  assert.equal(r.candidatos[0].pagina, 'product');
  assert.equal(r.candidatos[0].sinValidar, false);
  assert.ok(r.vistos.scripts.includes('js.klarna.com'));
  assert.equal(r.capturas, 4);
  // La semana siguiente ya no es nuevo
  assert.deepEqual(compara(v2(nuevo.paginas, r.vistos, 4), nuevo).candidatos, []);
});

test('desde la huella v1: formularios, scripts y funciones comparan; aria/data/rutas son base', () => {
  const v1 = { paginas: { home: { forms: ['/cart/add/1 []'], scriptHosts: ['klaviyo.com'], controls: ['notify me'] } } };
  const nuevo = { paginas: { home: pag({
    forms: [normForm('/cart/add/2 []'), normForm('/player-queue [_method,commit]')],
    scripts: ['klaviyo.com'], funciones: ['aviso-reposicion'],
    aria: ['aria-label'], data: ['data-x'], rutas: ['/gift-cards'],
  }) } };
  const r = compara(v1, nuevo);
  assert.deepEqual(r.candidatos.map(c => `${c.tipo}:${c.valor}`), ['forms:/player-queue [_method,commit]']);
  assert.equal(r.capturas, 1);
});

test('aria/data/rutas salen "sin validar" hasta dos capturas reales', () => {
  const vacio = { forms: [], scripts: [], iframes: [], aria: [], data: [], rutas: [], funciones: [] };
  const nuevo = { paginas: { home: pag({ rutas: ['/gift-cards'], forms: ['/x []'] }) } };
  const c1 = compara(v2({ home: pag() }, vacio, 1), nuevo).candidatos;
  assert.equal(c1.find(c => c.tipo === 'rutas').sinValidar, true);
  assert.equal(c1.find(c => c.tipo === 'forms').sinValidar, false);
  assert.equal(compara(v2({ home: pag() }, vacio, 2), nuevo).candidatos.find(c => c.tipo === 'rutas').sinValidar, false);
});

test('desaparecidos: solo paginas vistas en las dos capturas', () => {
  const antes = { product: pag({ forms: ['/cart/add [id]'], scripts: ['fonts.googleapis.com'] }), cart: pag({ forms: ['/cart [note]'] }) };
  const r = compara(v2(antes, vistosDe({ forms: ['/cart/add [id]', '/cart [note]'], scripts: ['fonts.googleapis.com'] })),
    { paginas: { product: pag({ scripts: ['fonts.googleapis.com'] }) } });
  assert.deepEqual(r.desaparecidos.map(c => `${c.pagina}:${c.valor}`), ['product:/cart/add [id]']);
});
