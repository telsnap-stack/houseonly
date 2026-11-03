/**
 * ZIPs de W&S traidos por el bookmarklet (tab W&S del admin).
 *
 * POR QUE UN BOOKMARKLET Y NO EL WORKER
 * wordandsound.net va detras del reto JS de Cloudflare (cf-mitigated:
 * challenge, comprobado el 2026-11-03 en /, /login y /release/{id}/assets): el
 * worker no puede ni ver el formulario de login. El navegador de Eduardo ya ha
 * pasado el reto y tiene la sesion, asi que es el quien descarga
 * /release/{ArtId}/assets y nos sube el ZIP. W&S no manda CSP ni COOP, asi que
 * el fetch cruzado al worker desde su pagina funciona.
 *
 * FLUJO
 *   1. El tab sube el XLSX → POST ?action=ws-zips-job (Bearer admin) con
 *      [{artId, artNo}] → token de trabajo (24 h) que solo vale para subir y
 *      marcar ESOS ArtId. El bookmarklet no lleva el secreto de admin: vive en
 *      una pagina ajena.
 *   2. El bookmarklet (en wordandsound.net) pide ws-zips-status con el token,
 *      salta los que ya estan (ok / sin assets) y por cada pendiente descarga el
 *      ZIP y hace ws-zips-upload, o ws-zips-none si W&S da 404.
 *   3. El tab lee ws-zips-status y baja cada ZIP con ws-zips-get (Bearer admin).
 *
 * R2: houseonly-listen (PRIVADO), no houseonly-audio, que es publico por r2.dev:
 * son promos con licencia y el ArtId se adivina. Prefijo WS_ZIPS_R2_PREFIX
 * (staging: ws-zips-staging/, por defecto ws-zips/), porque el bucket es el
 * mismo para los dos workers.
 *   {prefijo}{ArtId}.zip          el ZIP, customMetadata { artNo, at }
 *   {prefijo}{ArtId}.none         W&S no tiene pack (404) → Bandcamp
 *   {prefijo}_jobs/{sha256}.json  el trabajo; se guarda el hash, no el token
 */

export interface WsZipsEnv {
  LISTEN_R2: R2Bucket;
  WS_ZIPS_R2_PREFIX?: string;
}

export interface WsItem { artId: string; artNo: string }
export type WsEstado = 'ok' | 'sin_assets' | 'pendiente';

interface Trabajo { items: WsItem[]; created_at: string; expires_at: string }

/** Tope por ZIP. Los reales pesan 3–15 MB; el cuerpo entero se lee en memoria. */
export const WS_ZIP_MAX_BYTES = 60 * 1024 * 1024;
export const WS_JOB_MAX_ITEMS = 300;
const JOB_TTL_MS = 24 * 3600 * 1000;

export function prefijoWs(env: WsZipsEnv): string {
  return env.WS_ZIPS_R2_PREFIX || 'ws-zips/';
}

/** ArtId de W&S: solo cifras (170379). Cualquier otra cosa no entra en una clave de R2. */
export function artIdValido(s: unknown): s is string {
  return typeof s === 'string' && /^\d{1,10}$/.test(s);
}

/** Normaliza la lista del tab: ArtId valido, uno por ArtId (el primero gana). */
export function dedupeItems(crudo: unknown): WsItem[] {
  const vistos = new Set<string>();
  const out: WsItem[] = [];
  for (const it of Array.isArray(crudo) ? crudo : []) {
    const artId = String((it as any)?.artId ?? '').trim();
    if (!artIdValido(artId) || vistos.has(artId)) continue;
    vistos.add(artId);
    out.push({ artId, artNo: String((it as any)?.artNo ?? '').trim().slice(0, 64) });
  }
  return out;
}

/** Cabecera de un ZIP local (PK\x03\x04). Un ZIP vacio (PK\x05\x06) no sirve. */
export function esZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function sha256Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function bearer(request: Request): string {
  return (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
}

async function leeTrabajo(env: WsZipsEnv, token: string): Promise<Trabajo | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const obj = await env.LISTEN_R2.get(`${prefijoWs(env)}_jobs/${await sha256Hex(token)}.json`);
  if (!obj) return null;
  const t = await obj.json<Trabajo>().catch(() => null);
  if (!t || Date.parse(t.expires_at) < Date.now()) return null;
  return t;
}

async function estados(env: WsZipsEnv, items: WsItem[]): Promise<Array<WsItem & { estado: WsEstado; bytes?: number }>> {
  const p = prefijoWs(env);
  return Promise.all(items.map(async (it) => {
    const zip = await env.LISTEN_R2.head(`${p}${it.artId}.zip`);
    if (zip) return { ...it, estado: 'ok' as const, bytes: zip.size };
    const none = await env.LISTEN_R2.head(`${p}${it.artId}.none`);
    return { ...it, estado: none ? 'sin_assets' as const : 'pendiente' as const };
  }));
}

function json(data: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

/**
 * Todas las acciones ws-zips-*. `esAdmin` lo decide index.ts (Bearer de admin);
 * si no lo es, el Bearer tiene que ser un token de trabajo vigente, y entonces
 * solo vale para status / upload / none de los ArtId de ese trabajo.
 */
export async function handleWsZips(
  action: string, request: Request, env: WsZipsEnv, esAdmin: boolean, cors: Record<string, string>,
): Promise<Response> {
  const url = new URL(request.url);
  const p = prefijoWs(env);

  if (action === 'ws-zips-job') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);
    if (!esAdmin) return json({ error: 'unauthorized' }, 401, cors);
    const body: any = await request.json().catch(() => ({}));
    const items = dedupeItems(body?.items);
    if (!items.length) return json({ error: 'no valid items (artId)' }, 400, cors);
    if (items.length > WS_JOB_MAX_ITEMS) return json({ error: `too many items (${items.length}); max ${WS_JOB_MAX_ITEMS}` }, 400, cors);
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
    const now = Date.now();
    const trabajo: Trabajo = { items, created_at: new Date(now).toISOString(), expires_at: new Date(now + JOB_TTL_MS).toISOString() };
    await env.LISTEN_R2.put(`${p}_jobs/${await sha256Hex(token)}.json`, JSON.stringify(trabajo),
      { httpMetadata: { contentType: 'application/json' } });
    return json({ token, expires_at: trabajo.expires_at, items: await estados(env, items) }, 200, cors);
  }

  // A partir de aqui: admin, o token de trabajo limitado a sus ArtId.
  let permitidos: Set<string> | null = null;   // null = admin, todos
  let trabajo: Trabajo | null = null;
  if (!esAdmin) {
    trabajo = await leeTrabajo(env, bearer(request));
    if (!trabajo) return json({ error: 'unauthorized (job token missing or expired)' }, 401, cors);
    permitidos = new Set(trabajo.items.map(i => i.artId));
  }

  if (action === 'ws-zips-status' && request.method === 'GET') {
    let items: WsItem[];
    if (trabajo) items = trabajo.items;
    else {
      items = dedupeItems((url.searchParams.get('artids') || '').split(',').map(artId => ({ artId: artId.trim(), artNo: '' })));
      if (!items.length) return json({ error: 'missing artids' }, 400, cors);
      if (items.length > WS_JOB_MAX_ITEMS) return json({ error: `too many artids; max ${WS_JOB_MAX_ITEMS}` }, 400, cors);
    }
    return json({ prefix: p, items: await estados(env, items) }, 200, cors);
  }

  const artId = url.searchParams.get('artid') || '';
  if (!artIdValido(artId)) return json({ error: 'invalid artid' }, 400, cors);
  if (permitidos && !permitidos.has(artId)) return json({ error: 'artid not in this job' }, 403, cors);
  const artNo = trabajo?.items.find(i => i.artId === artId)?.artNo || (url.searchParams.get('artno') || '').slice(0, 64);

  if (action === 'ws-zips-upload' && request.method === 'POST') {
    const ct = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/zip' && ct !== 'application/x-zip-compressed') {
      return json({ error: `content-type must be application/zip (got "${ct}")` }, 415, cors);
    }
    const largo = Number(request.headers.get('content-length') || '0');
    if (largo > WS_ZIP_MAX_BYTES) return json({ error: `zip too large (${largo} > ${WS_ZIP_MAX_BYTES})` }, 413, cors);
    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.byteLength > WS_ZIP_MAX_BYTES) return json({ error: `zip too large (${buf.byteLength} > ${WS_ZIP_MAX_BYTES})` }, 413, cors);
    if (!esZip(buf)) return json({ error: 'body is not a zip' }, 415, cors);
    await env.LISTEN_R2.put(`${p}${artId}.zip`, buf, {
      httpMetadata: { contentType: 'application/zip' },
      customMetadata: { artNo, at: new Date().toISOString() },
    });
    await env.LISTEN_R2.delete(`${p}${artId}.none`);
    return json({ ok: true, artId, bytes: buf.byteLength }, 200, cors);
  }

  if (action === 'ws-zips-none' && request.method === 'POST') {
    // Si ya hay ZIP, manda el ZIP: un 404 posterior no lo borra.
    if (await env.LISTEN_R2.head(`${p}${artId}.zip`)) return json({ ok: true, artId, estado: 'ok' }, 200, cors);
    await env.LISTEN_R2.put(`${p}${artId}.none`, '', { customMetadata: { artNo, at: new Date().toISOString() } });
    return json({ ok: true, artId, estado: 'sin_assets' }, 200, cors);
  }

  // Leer y borrar: solo el admin.
  if (!esAdmin) return json({ error: 'unauthorized' }, 401, cors);

  if (action === 'ws-zips-get' && request.method === 'GET') {
    const obj = await env.LISTEN_R2.get(`${p}${artId}.zip`);
    if (!obj) return json({ error: 'not found' }, 404, cors);
    return new Response(obj.body, {
      headers: { ...cors, 'Content-Type': 'application/zip', 'Content-Length': String(obj.size), 'Cache-Control': 'no-store' },
    });
  }

  if (action === 'ws-zips-clean' && request.method === 'POST') {
    await env.LISTEN_R2.delete([`${p}${artId}.zip`, `${p}${artId}.none`]);
    return json({ ok: true, artId }, 200, cors);
  }

  return json({ error: 'unknown ws-zips action or method' }, 404, cors);
}
