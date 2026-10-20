/**
 * Rechazos del tab Pre-order (2026-10-20). Que se guarda y por que, en
 * preorder-rechazos.mjs, que comparte con el admin.
 *
 *   GET    ?action=preorder-rejects            todos          Bearer admin
 *   POST   ?action=preorder-reject  {catno, tipo, distribuidor, artist, title}
 *   DELETE ?action=preorder-reject  {catno}    recuperar (tambien los definitivos)
 *   GET    ?action=preorder-unlisted          SKUs de productos UNLISTED
 */
import { REJECT_PREFIX, claveKV, claveCatno, nuevoRechazo } from './preorder-rechazos.mjs';
import { shopifyAdminGraphQL, type ShopifyAdminEnv } from './shopify-admin';

export interface PreorderRejectsEnv {
  SYNC_STATE: KVNamespace;
}

export interface Rechazo {
  catno: string;
  tipo: 'temporal' | 'definitivo';
  fecha: string;
  distribuidor: string;
  artist: string;
  title: string;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*, Authorization',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function readBody(request: Request): Promise<any> {
  try { return await request.json(); } catch { return null; }
}

/** Todos los rechazos, de la metadata de list() (sin un get por clave). */
export async function listRechazos(env: PreorderRejectsEnv): Promise<Rechazo[]> {
  const out: Rechazo[] = [];
  let cursor: string | undefined;
  do {
    const l: any = await env.SYNC_STATE.list({ prefix: REJECT_PREFIX, limit: 1000, cursor });
    for (const k of l.keys) {
      // Sin metadata (escrita a mano, por ejemplo): se lee el valor.
      const rec = k.metadata ?? (await env.SYNC_STATE.get(k.name, 'json'));
      if (rec) out.push(rec as Rechazo);
    }
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  return out;
}

export async function handlePreorderRejects(env: PreorderRejectsEnv, autorizado: boolean): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  return json({ ok: true, items: await listRechazos(env) });
}

export async function handlePreorderReject(request: Request, env: PreorderRejectsEnv, autorizado: boolean, ahora = Date.now()): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  const rec = nuevoRechazo(await readBody(request), ahora);
  if ('error' in rec) return json({ error: rec.error }, 400);
  await env.SYNC_STATE.put(claveKV(rec.catno), JSON.stringify(rec), { metadata: rec });
  return json({ ok: true, item: rec });
}

export async function handlePreorderRejectUndo(request: Request, env: PreorderRejectsEnv, autorizado: boolean): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  if (!claveCatno(body?.catno)) return json({ error: 'catno required' }, 400);
  const key = claveKV(body.catno);
  if ((await env.SYNC_STATE.get(key)) == null) return json({ error: 'not rejected' }, 404);
  await env.SYNC_STATE.delete(key);
  return json({ ok: true, catno: body.catno });
}

/**
 * Productos en estado UNLISTED: existen y se venden por enlace directo, pero
 * el listado `products` de la Storefront API —con el que el tab sabe que hay en
 * la tienda— no los devuelve. El 2026-10-20 eran 6 (WARPLP324, PFR36, ...) y
 * cinco salian como "pedidos sin alta". Solo la Admin API conoce el estado.
 */
export async function listUnlisted(env: ShopifyAdminEnv): Promise<{ sku: string; handle: string; title: string }[]> {
  const out: { sku: string; handle: string; title: string }[] = [];
  let after: string | null = null;
  for (let pagina = 0; pagina < 20; pagina++) {
    const r: any = await shopifyAdminGraphQL(env, `
      query($after: String) {
        products(first: 250, after: $after, query: "status:unlisted") {
          pageInfo { hasNextPage endCursor }
          nodes { handle title status variants(first: 5) { nodes { sku } } }
        }
      }`, { after });
    const conn = r?.data?.products;
    if (r?.errors?.length || !conn) throw new Error(`Shopify products(status:unlisted): ${JSON.stringify(r?.errors || r).slice(0, 200)}`);
    for (const n of conn.nodes) {
      if (n.status !== 'UNLISTED') continue;          // por si el filtro dejara pasar otro estado
      const skus = (n.variants?.nodes || []).map((v: any) => String(v.sku || '').trim()).filter(Boolean);
      for (const sku of skus.length ? skus : ['']) out.push({ sku, handle: n.handle, title: n.title });
    }
    if (!conn.pageInfo?.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
  }
  throw new Error('Shopify products(status:unlisted): demasiadas paginas');
}

export async function handlePreorderUnlisted(env: ShopifyAdminEnv, autorizado: boolean): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  try {
    return json({ ok: true, items: await listUnlisted(env) });
  } catch (e: any) {
    return json({ error: String(e?.message || e).slice(0, 300) }, 502);
  }
}
