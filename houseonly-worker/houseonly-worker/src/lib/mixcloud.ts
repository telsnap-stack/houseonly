// ── MIXCLOUD AL DIA (FASE 7C) ───────────────────────────────────────
//
// docs/entities.md, "Fase 7C". Lo UNICO que refresca el cron.
//
// Que hace y que no:
//   - SI: para las entidades con una cuenta de Mixcloud **aprobada**, guarda una
//     foto del perfil —nombre, seguidores, cuantos shows y el ultimo— para que
//     el bloque Listen pueda decir "Mixcloud · last show 14 Sep" en vez de un
//     enlace mudo.
//   - NO: no descarga audio, no incrusta reproductores y no inventa sets. Los
//     sets destacados los aprueba una persona (sets.ts).
//   - NO toca NTS: por decision de Eduardo, NTS solo se consulta desde el
//     script local, nunca desde el worker.
//
// Claves:
//   mixstat:{slug}        → MixcloudStat
//   meta:mixcloud_index   → { slugs, builtAt }   quien tiene cuenta aprobada

import type { EntitiesEnv } from './entities';
import { getExternal } from './external';

export interface MixcloudStat {
  slug: string;
  username: string;
  name?: string;
  avatar?: string;
  followers?: number;
  shows?: number;
  last?: string;          // ISO del ultimo show
  lastUrl?: string;
  lastTitle?: string;
  checkedAt: number;
  error?: string;         // la cuenta ya no existe, o Mixcloud fallo
}

/** El indice de quien tiene Mixcloud se reconstruye como mucho cada 24 h. */
export const MIX_INDEX_TTL_MS = 24 * 3600 * 1000;
/** Una foto vale 12 h: por debajo de eso no se vuelve a pedir. */
export const MIX_STAT_TTL_MS = 12 * 3600 * 1000;
/** Cuantas entidades por pasada del cron. Con dos cuentas sobra, pero el tope
 *  existe para que esto no crezca sin control cuando haya cuarenta. */
export const MIX_PER_RUN = 5;

const K = {
  stat: (slug: string) => `mixstat:${slug}`,
  index: 'meta:mixcloud_index',
};

/**
 * Quien tiene cuenta de Mixcloud aprobada. Recorrer external: son ~160 lecturas,
 * asi que se hace una vez al dia y se cachea; el cron de 15 minutos lee el
 * indice, no el namespace entero.
 */
export async function mixcloudIndex(env: EntitiesEnv, now = Date.now()): Promise<string[]> {
  const raw = await env.ENTITIES.get(K.index);
  if (raw) {
    try {
      const c = JSON.parse(raw);
      if (c?.builtAt && now - c.builtAt < MIX_INDEX_TTL_MS && Array.isArray(c.slugs)) return c.slugs;
    } catch { /* se reconstruye */ }
  }

  const slugs: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const l = await env.ENTITIES.list({ prefix: 'external:', limit: 1000, cursor });
    const vals = await Promise.all(l.keys.map(k => env.ENTITIES.get(k.name)));
    for (const v of vals) {
      try { const r = JSON.parse(v || 'null'); if (r?.mixcloud) slugs.push(r.slug); } catch { /* fila corrupta */ }
    }
    if (l.list_complete) break;
    cursor = l.cursor;
  }
  await env.ENTITIES.put(K.index, JSON.stringify({ slugs, builtAt: now }));
  return slugs;
}

export async function getMixStat(env: EntitiesEnv, slug: string): Promise<MixcloudStat | null> {
  const raw = await env.ENTITIES.get(K.stat(slug));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Una cuenta: el perfil y su ultimo show. Dos llamadas a la API publica. */
export async function fetchMixcloud(
  username: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Omit<MixcloudStat, 'slug' | 'username' | 'checkedAt'>> {
  const u = encodeURIComponent(username);
  try {
    const r = await fetchImpl(`https://api.mixcloud.com/${u}/`, { headers: { Accept: 'application/json' } });
    if (!r.ok) return { error: `perfil HTTP ${r.status}` };
    const d: any = await r.json();
    if (d?.error) return { error: 'la cuenta ya no existe en Mixcloud' };
    const out: Omit<MixcloudStat, 'slug' | 'username' | 'checkedAt'> = {
      name: d.name,
      avatar: d.pictures?.thumbnail || d.pictures?.medium,
      followers: d.follower_count,
      shows: d.cloudcast_count,
    };
    const rc = await fetchImpl(`https://api.mixcloud.com/${u}/cloudcasts/?limit=1`, { headers: { Accept: 'application/json' } });
    if (rc.ok) {
      const dc: any = await rc.json();
      const last = (dc?.data || [])[0];
      if (last) { out.last = last.created_time; out.lastUrl = last.url; out.lastTitle = last.name; }
    }
    return out;
  } catch (e: any) {
    return { error: e?.message || 'Mixcloud no responde' };
  }
}

/**
 * Lo que corre el cron. Refresca como mucho MIX_PER_RUN cuentas, empezando por
 * las que llevan mas tiempo sin mirarse, y salta las frescas. Si Mixcloud falla,
 * se guarda el error y se conserva la foto anterior: un enlace con datos viejos
 * es mejor que uno sin nada.
 */
export async function refreshMixcloud(
  env: EntitiesEnv,
  opts: { now?: number; limit?: number; force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ checked: number; updated: number; failed: number; skipped: number; slugs: string[] }> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? MIX_PER_RUN;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const slugs = await mixcloudIndex(env, now);
  const stats = await Promise.all(slugs.map(s => getMixStat(env, s)));
  const pendientes = slugs
    .map((slug, i) => ({ slug, checkedAt: stats[i]?.checkedAt || 0 }))
    .filter(x => opts.force || now - x.checkedAt > MIX_STAT_TTL_MS)
    .sort((a, b) => a.checkedAt - b.checkedAt)
    .slice(0, limit);

  let updated = 0, failed = 0;
  for (const { slug } of pendientes) {
    const ext = await getExternal(env, slug);
    if (!ext?.mixcloud) continue;
    const datos = await fetchMixcloud(ext.mixcloud, fetchImpl);
    const previo = await getMixStat(env, slug);
    const stat: MixcloudStat = datos.error
      ? { ...(previo || {}), slug, username: ext.mixcloud, checkedAt: now, error: datos.error }
      : { slug, username: ext.mixcloud, ...datos, checkedAt: now };
    await env.ENTITIES.put(K.stat(slug), JSON.stringify(stat));
    if (datos.error) failed++; else updated++;
  }

  return { checked: pendientes.length, updated, failed, skipped: slugs.length - pendientes.length, slugs: pendientes.map(p => p.slug) };
}

// ── HANDLER HTTP ────────────────────────────────────────────────────

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

/**
 * GET/POST ?action=mixcloud-refresh  (Bearer)
 *
 * Dispararlo a mano, porque esperar al cron para comprobar un cambio no es
 * forma de trabajar. `?force=1` ignora las 12 h de frescura.
 */
export async function handleMixcloudRefresh(request: Request, env: EntitiesEnv): Promise<Response> {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m || !env.BOOTSTRAP_AUTH_SECRET || m[1] !== env.BOOTSTRAP_AUTH_SECRET) return json({ error: 'unauthorized' }, 401);
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  const limit = Math.min(Number(url.searchParams.get('limit')) || MIX_PER_RUN, 50);
  return json(await refreshMixcloud(env, { force, limit }));
}
