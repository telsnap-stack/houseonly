/**
 * Pre-order: lo que ya se trato no vuelve a salir al parsear el archivo de
 * emails (2026-10-20). Modulo compartido —sin dependencias ni KV— entre el
 * worker (lib/preorder-rejects.ts, que guarda) y el tab Pre-order del admin
 * (src/App.jsx, que clasifica), para que los dos digan lo mismo del mismo disco.
 *
 * Dos filtros, en este orden:
 *   1. Ya en tienda por SKU: no se lista; queda tras un contador desplegable.
 *   2. Rechazado: tras otro contador, con su tipo, recuperable.
 *        temporal   ("No, por ahora") oculto 90 dias; al caducar vuelve a la
 *                   lista marcado "rechazado el <fecha>"
 *        definitivo ("Nunca") no vuelve solo; solo si se recupera a mano
 *
 * KV (SYNC_STATE): preorder:rejected:<CATNO> → {catno, fecha, distribuidor,
 * tipo, artist, title}, tambien como metadata para listar sin un get por clave.
 * <CATNO> es la misma clave que usa el tab (rdKey): mayusculas y solo
 * alfanumerico, asi "YORE-011LTD" y "YORE 011 LTD" son el mismo disco.
 */

export const REJECT_PREFIX = 'preorder:rejected:';
export const DIAS_RECHAZO_TEMPORAL = 90;
export const TIPOS_RECHAZO = ['temporal', 'definitivo'];
const DIA_MS = 24 * 60 * 60 * 1000;

export const claveCatno = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
export const claveKV = catno => `${REJECT_PREFIX}${claveCatno(catno)}`;

/**
 * 'definitivo' | 'oculto' (temporal vigente) | 'caducado' (temporal de hace
 * 90 dias o mas) | null (sin rechazo).
 */
export function estadoRechazo(rec, ahora = Date.now()) {
  if (!rec) return null;
  if (rec.tipo === 'definitivo') return 'definitivo';
  const t = Date.parse(rec.fecha);
  if (!Number.isFinite(t)) return 'oculto';          // fecha rota: mejor oculto que perdido
  return ahora - t >= DIAS_RECHAZO_TEMPORAL * DIA_MS ? 'caducado' : 'oculto';
}

/**
 * @param rows      filas del parseo ({catno, ...})
 * @param enTienda  (clave) => boolean — existe en Shopify por SKU/handle
 * @param rechazos  Map clave → registro de KV
 * @returns { visibles, yaEnTienda, rechazados }
 *   visibles    lo que se lista; un temporal caducado lleva _rechazadoEl
 *   rechazados  vigentes, con _rechazo y _estadoRechazo
 */
export function clasificaFilas(rows, { enTienda = () => false, rechazos = new Map(), ahora = Date.now() } = {}) {
  const visibles = [], yaEnTienda = [], rechazados = [];
  for (const r of rows || []) {
    const k = claveCatno(r.catno);
    // En tienda gana: si ya esta en Shopify da igual que se rechazara.
    if (enTienda(k)) { yaEnTienda.push(r); continue; }
    const rec = rechazos.get(k);
    const est = estadoRechazo(rec, ahora);
    if (est === 'oculto' || est === 'definitivo') rechazados.push({ ...r, _rechazo: rec, _estadoRechazo: est });
    else if (est === 'caducado') visibles.push({ ...r, _rechazadoEl: rec.fecha });
    else visibles.push(r);
  }
  return { visibles, yaEnTienda, rechazados };
}

const texto = (v, max = 120) => String(v ?? '').trim().slice(0, max);

/** Lo que llega al endpoint → registro guardable, o {error}. */
export function nuevoRechazo(body, ahora = Date.now()) {
  const catno = texto(body?.catno, 60);
  if (!claveCatno(catno)) return { error: 'catno required' };
  const tipo = body?.tipo;
  if (!TIPOS_RECHAZO.includes(tipo)) return { error: `tipo must be ${TIPOS_RECHAZO.join(' or ')}` };
  return {
    catno, tipo,
    fecha: new Date(ahora).toISOString(),
    distribuidor: texto(body?.distribuidor, 40),
    artist: texto(body?.artist),
    title: texto(body?.title),
  };
}

/** "2026-10-20T…" → "20/10/2026", para "rechazado el <fecha>". */
export const fechaCorta = iso => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
};
