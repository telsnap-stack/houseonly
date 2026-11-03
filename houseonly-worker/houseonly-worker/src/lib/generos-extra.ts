/**
 * Generos "extra" del desplegable de la rejilla (2026-11-03, decision de
 * Eduardo): ademas de la tabla canonica (genres.mjs), cualquier genero con 10 o
 * mas discos activos sale como pildora sola, sin editar la tabla a mano (como
 * se hizo con Bass Music).
 *
 * Solo cuentan los tags `genre:<pegado>` que no son de la tabla: son los unicos
 * por los que la rejilla puede filtrar exacto (ver la cabecera de genres.mjs:
 * un tag plano como "Techno - Minimal" tokeniza y casa con cualquier "techno").
 * Hoy los escribe el importer de DBH cuando su genero no esta en la tabla
 * (tagGeneroLibre); su nombre legible es el tag plano que va al lado.
 *
 * Se calcula una vez al dia (cron 0 6) leyendo los productos por Admin API, y
 * se guarda en KV. La rejilla lo pide una vez por visita a ?action=generos-extra
 * (publico, 1 h de cache): nada de contar tags en cada carga.
 *
 * KV (SYNC_STATE): meta:generos_extra = {at, umbral, generos: [{id, label, total,
 * vistas: {house, dnb, forthcoming_house, forthcoming_dnb}}]}. `vistas` son las
 * cuatro de la rejilla (clausulasDeSeccion de src/catalogo.mjs): una pildora no
 * sale en una vista donde daria cero.
 */
import { GENRES, genreTag, tagGeneroLibre, DNB_GENRE_ID } from './genres.mjs';
import { shopifyAdminGraphQL, type ShopifyAdminEnv } from './shopify-admin';

export const GENEROS_EXTRA_KEY = 'meta:generos_extra';
export const UMBRAL_GENERO_EXTRA = 10;
const CANONICOS = new Set(GENRES.map(g => genreTag(g.id)));
const DNB = genreTag(DNB_GENRE_ID);

export interface GeneroExtra {
  id: string; label: string; total: number;
  vistas: { house: number; dnb: number; forthcoming_house: number; forthcoming_dnb: number };
}

/** De los productos activos (tags) a los generos extra con su recuento por vista. */
export function cuentaGenerosExtra(productos: Array<{ tags: string[] }>, umbral = UMBRAL_GENERO_EXTRA): GeneroExtra[] {
  const por = new Map<string, GeneroExtra & { nombres: Map<string, number> }>();
  for (const p of productos) {
    const tags = p.tags || [];
    const bajos = tags.map(t => t.toLowerCase());
    const dnb = bajos.includes(DNB);
    const fc = bajos.includes('forthcoming');
    for (const t of bajos) {
      if (!t.startsWith('genre:') || CANONICOS.has(t)) continue;
      const id = t.slice('genre:'.length);
      if (!id) continue;
      let g = por.get(id);
      if (!g) por.set(id, g = { id, label: '', total: 0, vistas: { house: 0, dnb: 0, forthcoming_house: 0, forthcoming_dnb: 0 }, nombres: new Map() });
      g.total++;
      // Las vistas de la rejilla: sin forthcoming, house excluye D&B; en
      // forthcoming, "house" lo incluye (clausulasDeSeccion).
      if (fc) { g.vistas.forthcoming_house++; if (dnb) g.vistas.forthcoming_dnb++; }
      else if (dnb) g.vistas.dnb++;
      else g.vistas.house++;
      for (const n of tags) if (!n.includes(':') && tagGeneroLibre(n) === t) g.nombres.set(n, (g.nombres.get(n) || 0) + 1);
    }
  }
  return [...por.values()]
    .filter(g => g.total >= umbral)
    .map(({ nombres, ...g }) => ({ ...g, label: [...nombres].sort((a, b) => b[1] - a[1])[0]?.[0] || g.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Todos los productos ACTIVOS con sus tags (Admin API, sin el indice de busqueda). */
async function productosActivos(env: ShopifyAdminEnv): Promise<Array<{ tags: string[] }>> {
  const out: Array<{ tags: string[] }> = [];
  let after: string | null = null;
  for (let pagina = 0, esperas = 0; pagina < 40;) {
    const r: any = await shopifyAdminGraphQL(env, `
      query($after: String) {
        products(first: 250, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { status tags }
        }
      }`, { after });
    if (r?.errors?.some((e: any) => e?.extensions?.code === 'THROTTLED') && esperas++ < 5) {
      await new Promise(ok => setTimeout(ok, 2000));
      continue;
    }
    const conn = r?.data?.products;
    if (r?.errors?.length || !conn) throw new Error(`Shopify products: ${JSON.stringify(r?.errors || r).slice(0, 200)}`);
    for (const n of conn.nodes) if (n.status === 'ACTIVE') out.push({ tags: n.tags || [] });
    if (!conn.pageInfo?.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
    pagina++;
  }
  throw new Error('Shopify products: demasiadas paginas');
}

export async function recalculaGenerosExtra(env: ShopifyAdminEnv & { SYNC_STATE: KVNamespace }, ahora = new Date()) {
  const productos = await productosActivos(env);
  const datos = { at: ahora.toISOString(), umbral: UMBRAL_GENERO_EXTRA, activos: productos.length, generos: cuentaGenerosExtra(productos) };
  await env.SYNC_STATE.put(GENEROS_EXTRA_KEY, JSON.stringify(datos));
  return datos;
}

const CABECERAS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

/** GET ?action=generos-extra — publico, 1 h de cache. Sin datos: lista vacia. */
export async function handleGenerosExtra(env: { SYNC_STATE: KVNamespace }): Promise<Response> {
  let datos: any = null;
  try { datos = JSON.parse((await env.SYNC_STATE.get(GENEROS_EXTRA_KEY)) || 'null'); } catch { /* corrupto: como vacio */ }
  return new Response(JSON.stringify({ ok: true, at: datos?.at || null, umbral: UMBRAL_GENERO_EXTRA, generos: datos?.generos || [] }),
    { headers: { ...CABECERAS, 'Cache-Control': 'public, max-age=3600' } });
}

/** POST ?action=generos-extra-rebuild — Bearer: recalcula ya (no espera a las 6). */
export async function handleGenerosExtraRebuild(env: ShopifyAdminEnv & { SYNC_STATE: KVNamespace }, autorizado: boolean): Promise<Response> {
  if (!autorizado) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CABECERAS });
  try {
    return new Response(JSON.stringify({ ok: true, ...(await recalculaGenerosExtra(env)) }), { headers: CABECERAS });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e).slice(0, 300) }), { status: 502, headers: CABECERAS });
  }
}
