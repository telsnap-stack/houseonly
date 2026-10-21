import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limpiaSkuRd, enTiendaODuplicado, comoEnTienda, fueraDelCsv, skuEnTienda } from './duplicados.mjs';

// Como lo devuelve fetchLiveHandles: claves alfanumericas, con skuReal colgado.
function catalogo(skus) {
  const s = new Set(skus.map(x => x.toUpperCase().replace(/[^A-Z0-9]+/g, '')));
  s.skuReal = new Map(skus.map(x => [x.toUpperCase().replace(/[^A-Z0-9]+/g, ''), x]));
  return s;
}

test('Rubadub: fuera dub, remix y mix pegados al numero', () => {
  assert.equal(limpiaSkuRd('AD002dub'), 'AD002');
  assert.equal(limpiaSkuRd('AD002DUB'), 'AD002');
  assert.equal(limpiaSkuRd('XYZ010remix'), 'XYZ010');
  assert.equal(limpiaSkuRd('XYZ010-Remixes'), 'XYZ010');
  assert.equal(limpiaSkuRd('XYZ010mix'), 'XYZ010');
  assert.equal(limpiaSkuRd('ABC7 dubs'), 'ABC7');
});

test('Rubadub: ediciones y catnos que acaban en letras se quedan', () => {
  for (const s of ['YORE-011LTD', 'UR-029r', 'echospace012-RE', 'AOS111LP', 'WPA-4/ UR-079', 'DUBPLATE1', 'REMIXDUB']) {
    assert.equal(limpiaSkuRd(s), s);
  }
});

test('igual: ya en tienda, sin aviso', () => {
  const live = catalogo(['AD002', 'UR-025A']);
  assert.deepEqual(enTiendaODuplicado(live, 'ad-002'), { _alreadyLive: true, _posibleDuplicado: '' });
});

test('salvo sufijo o ceros: posible duplicado con el SKU de la tienda', () => {
  const live = catalogo(['AD002dub', 'UR-025A', 'LOG088']);
  assert.equal(enTiendaODuplicado(live, 'AD002')._posibleDuplicado, 'AD002dub');
  assert.equal(enTiendaODuplicado(live, 'UR-025')._posibleDuplicado, 'UR-025A');
  assert.equal(enTiendaODuplicado(live, 'LOG88')._posibleDuplicado, 'LOG088');
  assert.equal(enTiendaODuplicado(live, 'LOG88')._alreadyLive, false);
});

test('otro disco: ni en tienda ni duplicado', () => {
  const live = catalogo(['ABC001A', 'UR-025']);
  assert.deepEqual(enTiendaODuplicado(live, 'ABC001B'), { _alreadyLive: false, _posibleDuplicado: '' });
  assert.deepEqual(enTiendaODuplicado(live, 'UR-02'), { _alreadyLive: false, _posibleDuplicado: '' });
  assert.deepEqual(enTiendaODuplicado(null, 'UR-02'), { _alreadyLive: false, _posibleDuplicado: '' });
});

test('sin decidir no viaja; "crear" viaja; "mismo" va como en tienda', () => {
  const r = { _catno: 'AD002', _alreadyLive: false, _posibleDuplicado: 'AD002dub' };
  assert.equal(fueraDelCsv(r, {}), true);
  assert.equal(comoEnTienda(r, {}), false);
  assert.equal(fueraDelCsv(r, { AD002: 'crear' }), false);
  assert.equal(fueraDelCsv(r, { AD002: 'mismo' }), true);
  assert.equal(comoEnTienda(r, { AD002: 'mismo' }), true);
  assert.equal(skuEnTienda(r, catalogo([])), 'AD002dub');
  const normal = { _catno: 'NEW1', _alreadyLive: false, _posibleDuplicado: '' };
  assert.equal(fueraDelCsv(normal, {}), false);
});
