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
 * ¿Esta ya en la tienda? El catno del email y el SKU de Shopify no siempre se
 * escriben igual (2026-10-20: UR-025 llega por email y en Shopify son UR-025A y
 * UR-025J, asi que salia marcado como nuevo teniendo stock). Encaja si:
 *   - son iguales (claveCatno), o
 *   - solo cambian ceros a la izquierda (LOG88 = LOG088), o
 *   - uno lleva un sufijo de letras y el otro no (UR-025 = UR-025A,
 *     TURBO249 = TURBO249V).
 * No encaja si los dos llevan sufijos distintos (ABC001A ≠ ABC001B: partes de
 * una serie) ni si cambia un numero (UR-02 ≠ UR-025).
 */
const sinCeros = k => k.replace(/\d+/g, n => String(Number(n)));
function partes(clave) {
  const z = sinCeros(clave);
  const m = z.match(/^(.*\d)([A-Z]*)$/);   // nucleo hasta el ultimo digito + sufijo de letras
  return m ? { nucleo: m[1], sufijo: m[2] } : { nucleo: z, sufijo: '' };
}

/** Indice de las claves de la tienda (claveCatno de SKUs y handles). */
export function indiceTienda(claves) {
  const exactas = new Set();
  const porNucleo = new Map();
  for (const c of claves || []) {
    const k = claveCatno(c);
    if (!k) continue;
    exactas.add(k);
    const { nucleo, sufijo } = partes(k);
    if (!porNucleo.has(nucleo)) porNucleo.set(nucleo, []);
    porNucleo.get(nucleo).push({ clave: k, sufijo });
  }
  return { exactas, porNucleo };
}

/** La clave de la tienda con la que encaja el catno, o null. */
export function buscaEnTienda(indice, catno) {
  const k = claveCatno(catno);
  if (!k || !indice) return null;
  if (indice.exactas.has(k)) return k;
  const { nucleo, sufijo } = partes(k);
  if (!/\d/.test(nucleo)) return null;       // sin numero no hay catno que comparar
  const cand = (indice.porNucleo.get(nucleo) || [])
    .filter(x => x.sufijo === sufijo || !x.sufijo || !sufijo);
  return cand.length ? cand[0].clave : null;
}

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
 * Pedido hace mas de 4 semanas y sin producto en la tienda (2026-10-20: 68 de
 * los 124 pedidos de W&S sin alta, el mas viejo de marzo). Van a su propio
 * bloque desplegable, sin marcar solos, con los mismos botones de rechazo.
 * NUNCA se ocultan solos: solo salen del bloque si se dan de alta o se
 * rechazan. `_fechaPedido` es la del pedido mas reciente de ese disco.
 */
export const DIAS_PEDIDO_ANTIGUO = 28;
export function esPedidoAntiguo(r, ahora = Date.now()) {
  if (!r?._ordered || !r._fechaPedido) return false;
  const t = Date.parse(r._fechaPedido);
  return Number.isFinite(t) && ahora - t > DIAS_PEDIDO_ANTIGUO * DIA_MS;
}

/**
 * @param rows      filas del parseo ({catno, ...})
 * @param enTienda  (clave) => boolean — existe en Shopify por SKU/handle
 * @param rechazos  Map clave → registro de KV
 * @returns { visibles, antiguos, yaEnTienda, rechazados }
 *   visibles    lo que se lista; un temporal caducado lleva _rechazadoEl
 *   antiguos    pedidos de hace mas de 4 semanas sin alta (esPedidoAntiguo)
 *   rechazados  vigentes, con _rechazo y _estadoRechazo
 * Orden: en tienda > rechazado > antiguo > visible.
 */
export function clasificaFilas(rows, { enTienda = () => false, rechazos = new Map(), ahora = Date.now() } = {}) {
  const visibles = [], antiguos = [], yaEnTienda = [], rechazados = [];
  for (const r of rows || []) {
    const k = claveCatno(r.catno);
    // En tienda gana: si ya esta en Shopify da igual que se rechazara.
    if (enTienda(k)) { yaEnTienda.push(r); continue; }
    const rec = rechazos.get(k);
    const est = estadoRechazo(rec, ahora);
    if (est === 'oculto' || est === 'definitivo') { rechazados.push({ ...r, _rechazo: rec, _estadoRechazo: est }); continue; }
    const fila = est === 'caducado' ? { ...r, _rechazadoEl: rec.fecha } : r;
    (esPedidoAntiguo(fila, ahora) ? antiguos : visibles).push(fila);
  }
  return { visibles, antiguos, yaEnTienda, rechazados };
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
