/**
 * Bandeja de escucha → Pre-order (2026-11-03). Reglas puras que usa el tab
 * (src/App.jsx) y que se prueban sin navegador (preorder-listen.test.mjs).
 */

/**
 * Filas del resultado que NO pueden ir al CSV: una fila de la bandeja (_listen)
 * cuyo audio no se pudo copiar (listen-promote fallo o no devolvio pistas)
 * saldria como producto sin pistas. Bloquea el CSV hasta excluirla a mano o
 * volver a hacer "List pre-orders" con exito.
 */
export function filasBloqueadas(results, excluded = {}) {
  return (results || []).filter(r => r._bloqueo && !excluded[r._catno] && !r._alreadyLive);
}

/** Motivo de bloqueo de una fila _listen tras listen-promote, o '' si va bien. */
export function bloqueoListen({ listen, error, tracks }) {
  if (!listen) return '';
  if (error) return `no se pudo copiar el audio de la bandeja: ${error}`;
  if (!tracks?.length) return 'la bandeja no devolvio pistas';
  return '';
}

/** El CSV apunta al audio/portadas de pruebas de staging (listen-promote en staging). */
const PRUEBAS = /\/staging-(audio|covers)\//;
export function esCsvDePruebas(results) {
  return (results || []).some(r => PRUEBAS.test(r._coverUrl || '') || (r._tracks || []).some(t => PRUEBAS.test(t.url || '')));
}

/**
 * Texto del aviso de "Cargar elegidos", siempre con todas las partes.
 *   res = {anadidos: [clave], enTienda: [{clave, catno, como, handle}], sinAudio: [clave], errores: [{clave, error}]}
 */
export function resumenCarga(total, res) {
  const lista = xs => xs.join(', ');
  const enTienda = res.enTienda || [];
  const sinAudio = res.sinAudio || [];
  const errores = (res.errores || []).filter(e => e.clave !== '—');
  const partes = [
    `${(res.anadidos || []).length} al manifest`,
    `${enTienda.length} ya en tienda${enTienda.length ? ` (${lista(enTienda.map(x => `${x.catno || x.clave} como ${x.handle || x.como}`))})` : ''}`,
    `${sinAudio.length} sin audio${sinAudio.length ? ` (${lista(sinAudio)}: entran esperando ZIP)` : ''}`,
  ];
  if (errores.length) partes.push(`${errores.length} sin entrar por error (${lista(errores.map(e => `${e.clave}: ${e.error}`))})`);
  const avisos = (res.errores || []).filter(e => e.clave === '—').map(e => e.error);
  return `${total} elegido${total === 1 ? '' : 's'}: ${partes.join(' · ')}.${avisos.length ? ` Aviso: ${avisos.join('; ')}.` : ''}`;
}
