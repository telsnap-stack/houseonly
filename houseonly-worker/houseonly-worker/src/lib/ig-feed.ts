// ── FEED DE INSTAGRAM (link in bio) ─────────────────────────────────
//
// Los discos que han salido en Reels, el mas reciente primero. Lo pinta la
// pagina publica /ig de la tienda, que es el destino fijo del link de la bio de
// @onlyhouseonly: quien vea un Reel antiguo tambien encuentra su disco.
//
// Lo alimenta solo el generador de Stories del admin (boton, o automatico al
// exportar con el cierre "Link in bio").
//
// Clave (en SYNC_STATE, que tiene id distinto en prod y staging):
//   ig:feed → IgFeedItem[]   max 40, sin duplicados por handle
//
// KV no tiene escritura atomica (docs de Cloudflare, "How KV works"): dos
// escrituras a la vez podrian pisarse. Aqui escribe una sola persona desde el
// admin, asi que leer-modificar-escribir basta.

export interface IgFeedItem {
  handle: string;
  sku: string;
  title: string;
  artist: string;
  addedAt: number;
}

export interface IgFeedEnv {
  SYNC_STATE: KVNamespace;
}

export const IG_FEED_KEY = 'ig:feed';
export const IG_FEED_MAX = 40;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*, Authorization',
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extra },
  });
}

const texto = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);

/** Un handle de Shopify: minusculas, digitos y guiones. Lo demas no se guarda. */
export function cleanHandle(v: unknown): string {
  const h = texto(v, 255).toLowerCase();
  return /^[a-z0-9][a-z0-9-]*$/.test(h) ? h : '';
}

/** Pone el disco el primero (o lo sube si ya estaba) y recorta a IG_FEED_MAX. */
export function addToFeed(items: IgFeedItem[], entry: Omit<IgFeedItem, 'addedAt'>, now: number): IgFeedItem[] {
  const rest = items.filter(i => i.handle !== entry.handle);
  return [{ ...entry, addedAt: now }, ...rest].slice(0, IG_FEED_MAX);
}

export function removeFromFeed(items: IgFeedItem[], handle: string): IgFeedItem[] {
  return items.filter(i => i.handle !== handle);
}

export async function getIgFeed(env: IgFeedEnv): Promise<IgFeedItem[]> {
  const v = await env.SYNC_STATE.get(IG_FEED_KEY, 'json');
  return Array.isArray(v) ? (v as IgFeedItem[]) : [];
}

async function readBody(request: Request): Promise<any> {
  try { return await request.json(); } catch { return null; }
}

/** GET ?action=ig-feed — publico, sin auth. */
export async function handleIgFeed(env: IgFeedEnv): Promise<Response> {
  return json({ items: await getIgFeed(env) }, 200, { 'Cache-Control': 'public, max-age=60' });
}

/** POST ?action=ig-feed-add {handle, sku, title, artist} — Bearer admin. */
export async function handleIgFeedAdd(request: Request, env: IgFeedEnv, autorizado: boolean): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  const handle = cleanHandle(body?.handle);
  if (!handle) return json({ error: 'handle required' }, 400);
  const items = addToFeed(await getIgFeed(env), {
    handle, sku: texto(body?.sku, 80), title: texto(body?.title), artist: texto(body?.artist),
  }, Date.now());
  await env.SYNC_STATE.put(IG_FEED_KEY, JSON.stringify(items));
  return json({ ok: true, items });
}

/** POST ?action=ig-feed-remove {handle} — Bearer admin. */
export async function handleIgFeedRemove(request: Request, env: IgFeedEnv, autorizado: boolean): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  const handle = cleanHandle(body?.handle);
  if (!handle) return json({ error: 'handle required' }, 400);
  const antes = await getIgFeed(env);
  const items = removeFromFeed(antes, handle);
  if (items.length === antes.length) return json({ error: 'not in the feed' }, 404);
  await env.SYNC_STATE.put(IG_FEED_KEY, JSON.stringify(items));
  return json({ ok: true, items });
}
