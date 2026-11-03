import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filasBloqueadas, bloqueoListen, esCsvDePruebas, resumenCarga } from './preorder-listen.mjs';

test('listen-promote fallido: la fila queda bloqueada y frena el CSV hasta excluirla', () => {
  const malo = bloqueoListen({ listen: 'AAA001', error: 'HTTP 500', tracks: [] });
  assert.match(malo, /no se pudo copiar el audio de la bandeja: HTTP 500/);
  assert.equal(bloqueoListen({ listen: 'AAA001', error: '', tracks: [] }), 'la bandeja no devolvio pistas');
  assert.equal(bloqueoListen({ listen: 'AAA001', error: '', tracks: [{ url: 'x' }] }), '');
  assert.equal(bloqueoListen({ listen: undefined, error: 'lo que sea', tracks: [] }), '');   // filas de ZIP: intactas

  const results = [
    { _catno: 'AAA001', _bloqueo: malo },
    { _catno: 'BBB002', _bloqueo: '' },
    { _catno: 'CCC003', _bloqueo: 'x', _alreadyLive: true },
  ];
  assert.deepEqual(filasBloqueadas(results).map(r => r._catno), ['AAA001']);
  assert.deepEqual(filasBloqueadas(results, { AAA001: true }), []);
});

test('CSV de pruebas: cualquier pista o portada en staging-audio/ o staging-covers/', () => {
  assert.equal(esCsvDePruebas([{ _coverUrl: 'https://pub/covers/A.jpg', _tracks: [{ url: 'https://pub/audio/A/1.mp3' }] }]), false);
  assert.equal(esCsvDePruebas([{ _coverUrl: '', _tracks: [{ url: 'https://pub/staging-audio/A/1.mp3' }] }]), true);
  assert.equal(esCsvDePruebas([{ _coverUrl: 'https://pub/staging-covers/A.jpg' }]), true);
});

test('el aviso de Cargar elegidos desglosa siempre', () => {
  assert.equal(resumenCarga(4, {
    anadidos: ['CITS007'], enTienda: [{ clave: 'MSLP022LTD', catno: 'MSLP022LTD', como: 'MSLP022LTD', handle: 'mslp022ltd' }],
    sinAudio: [], errores: [{ clave: 'LN017', error: 'no se pudo leer su email' }],
  }), '4 elegidos: 1 al manifest · 1 ya en tienda (MSLP022LTD como mslp022ltd) · 0 sin audio · 1 sin entrar por error (LN017: no se pudo leer su email).');
  assert.equal(resumenCarga(1, { anadidos: ['A'], enTienda: [], sinAudio: ['A'], errores: [] }),
    '1 elegido: 1 al manifest · 0 ya en tienda · 1 sin audio (A: entran esperando ZIP).');
});
