// ── SETS DESTACADOS DE UNA ENTIDAD (FASE 7B) ────────────────────────
//
// Diseño y decisiones: docs/entities.md, "Fase 7".
//
// Un follow dice que sacas discos; un set dice como suenas. Esto es lo segundo:
// los sets que la tienda enseña en la ficha de un artista o un sello.
//
// Dos maneras de que entre un set, y las dos pasan por una persona:
//
//   1. Alguien pega la URL en Entities → Links. El worker resuelve titulo,
//      autor y miniatura por oEmbed — SIN clave de API — y lo guarda.
//   2. La busqueda de YouTube (scripts/entities-youtube-candidates.mjs) propone
//      candidatos en setreview:{slug}, que CADUCAN A LOS 30 DIAS si nadie los
//      aprueba. Un candidato no se enseña jamas: solo lo aprobado en sets:.
//
// Claves:
//   sets:{slug}      → SetsRecord     lo aprobado, en el orden elegido
//   setreview:{slug} → SetsReview     candidatos de la busqueda, TTL 30 dias

import { getEntity, type EntitiesEnv } from './entities';
import { getExternal, externalUrl } from './external';
import { getMixStat } from './mixcloud';

export type SetSource = 'youtube' | 'soundcloud' | 'mixcloud';

export interface FeaturedSet {
  id: string;                  // `${source}:${idExterno}` — estable, dedupe
  source: SetSource;
  url: string;
  title?: string;
  author?: string;             // canal, usuario o radio que lo subio
  thumbnail?: string;
  publishedAt?: string;
  addedAt: number;
  via: 'manual' | 'search';    // pegado a mano o aprobado de la busqueda
}

export interface SetsRecord {
  slug: string;
  items: FeaturedSet[];        // el ORDEN es el que se enseña
  rejected: string[];          // ids descartados: la busqueda no los repropone
  updatedAt: number;
}

export interface SetCandidate extends Omit<FeaturedSet, 'addedAt' | 'via'> {
  query: string;               // con que busqueda salio
  foundAt: number;
}

export interface SetsReview {
  slug: string;
  candidates: SetCandidate[];
  fetchedAt: number;
}

/** Tope por entidad. Una ficha con veinte sets ya no es una seleccion. */
export const MAX_SETS = 20;
/** Un candidato sin aprobar se borra solo a los 30 dias. */
export const SET_REVIEW_TTL_S = 30 * 24 * 3600;

const K = {
  sets: (slug: string) => `sets:${slug}`,
  review: (slug: string) => `setreview:${slug}`,
};

// ── URLS ────────────────────────────────────────────────────────────

/**
 * Una pista, un video o un show concretos. NO una cuenta: la cuenta es un
 * enlace de entidad (external:), y mezclarlas haria que "Listen" enseñara un
 * perfil donde promete un set.
 */
export function parseSetUrl(raw: string): { source: SetSource; id: string; url: string } | null {
  let u: URL;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '').toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));

  if (host === 'youtube.com') {
    const v = u.searchParams.get('v');
    const id = segs[0] === 'watch' && v ? v
      : (segs[0] === 'shorts' || segs[0] === 'live' || segs[0] === 'embed') ? segs[1]
      : null;
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    return { source: 'youtube', id: `youtube:${id}`, url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (host === 'youtu.be') {
    const id = segs[0];
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    return { source: 'youtube', id: `youtube:${id}`, url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (host === 'soundcloud.com') {
    // usuario/pista. Los /sets/ son listas, no un set de DJ; fuera.
    if (segs.length !== 2 || segs[0] === 'sets' || segs[1] === 'sets') return null;
    const id = `${segs[0].toLowerCase()}/${segs[1].toLowerCase()}`;
    return { source: 'soundcloud', id: `soundcloud:${id}`, url: `https://soundcloud.com/${id}` };
  }
  if (host === 'mixcloud.com') {
    if (segs.length !== 2) return null;
    const id = `${segs[0]}/${segs[1]}`;
    return { source: 'mixcloud', id: `mixcloud:${id}`, url: `https://www.mixcloud.com/${id}/` };
  }
  return null;
}

/**
 * Titulo, autor y miniatura. YouTube y SoundCloud por oEmbed (sin clave, que es
 * justo lo que se decidio); Mixcloud por su API, que ademas da la fecha.
 * Si la fuente no contesta, se guarda igual con lo que haya: mejor un set sin
 * miniatura que perder la URL que alguien se molesto en pegar.
 */
export async function resolveSetMeta(
  parsed: { source: SetSource; url: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Partial<FeaturedSet>> {
  const endpoint = parsed.source === 'youtube'
    ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(parsed.url)}`
    : parsed.source === 'soundcloud'
      ? `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(parsed.url)}`
      // El oembed de www.mixcloud.com redirige; su API da lo mismo y la fecha.
      : `https://api.mixcloud.com/${parsed.url.replace(/^https:\/\/www\.mixcloud\.com\//, '').replace(/\/$/, '')}/`;
  try {
    const r = await fetchImpl(endpoint, { headers: { Accept: 'application/json' } });
    if (!r.ok) return {};
    const d: any = await r.json();
    if (parsed.source === 'mixcloud') {
      return {
        title: d.name, author: d.user?.name,
        thumbnail: d.pictures?.medium || d.pictures?.thumbnail,
        publishedAt: d.created_time,
      };
    }
    return { title: d.title, author: d.author_name, thumbnail: d.thumbnail_url };
  } catch {
    return {};
  }
}

// ── KV ──────────────────────────────────────────────────────────────

export async function getSets(env: EntitiesEnv, slug: string): Promise<SetsRecord> {
  const raw = await env.ENTITIES.get(K.sets(slug));
  if (raw) {
    try {
      const r = JSON.parse(raw);
      return { slug, items: r.items || [], rejected: r.rejected || [], updatedAt: r.updatedAt || 0 };
    } catch { /* fila corrupta: se reconstruye */ }
  }
  return { slug, items: [], rejected: [], updatedAt: 0 };
}

async function putSets(env: EntitiesEnv, rec: SetsRecord): Promise<void> {
  await env.ENTITIES.put(K.sets(rec.slug), JSON.stringify({ ...rec, updatedAt: Date.now() }));
}

export async function getSetsReview(env: EntitiesEnv, slug: string): Promise<SetsReview | null> {
  const raw = await env.ENTITIES.get(K.review(slug));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Lo que ya esta dentro o descartado no se vuelve a proponer. */
export function filterCandidates(cands: SetCandidate[], rec: SetsRecord): SetCandidate[] {
  const fuera = new Set([...rec.items.map(i => i.id), ...rec.rejected]);
  const vistos = new Set<string>();
  return cands.filter(c => !fuera.has(c.id) && !vistos.has(c.id) && vistos.add(c.id));
}

// ── HANDLERS HTTP ───────────────────────────────────────────────────

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function bearerOk(request: Request, env: EntitiesEnv): boolean {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return !!m && !!env.BOOTSTRAP_AUTH_SECRET && m[1] === env.BOOTSTRAP_AUTH_SECRET;
}

async function readBody(request: Request): Promise<any> {
  try { return await request.json(); } catch { return null; }
}

/** GET ?action=sets-list&slug=… */
export async function handleSetsList(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  const slug = new URL(request.url).searchParams.get('slug') || '';
  if (!slug) return json({ error: 'slug required' }, 400);
  return json({ sets: await getSets(env, slug) });
}

/** POST ?action=sets-add  {slug, url} — pegar un set a mano. */
export async function handleSetsAdd(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  const slug = String(body?.slug || '');
  const parsed = parseSetUrl(body?.url);
  if (!slug) return json({ error: 'slug required' }, 400);
  if (!parsed) return json({ error: 'not a YouTube video, SoundCloud track or Mixcloud show URL' }, 400);

  const e = await getEntity(env, slug);
  if (!e || e.status !== 'active') return json({ error: 'unknown entity' }, 404);

  const rec = await getSets(env, slug);
  if (rec.items.some(i => i.id === parsed.id)) return json({ ok: true, already: true, sets: rec });
  if (rec.items.length >= MAX_SETS) return json({ error: `max ${MAX_SETS} sets per entity` }, 400);

  const meta = await resolveSetMeta(parsed);
  rec.items.push({ id: parsed.id, source: parsed.source, url: parsed.url, ...meta, addedAt: Date.now(), via: 'manual' });
  rec.rejected = rec.rejected.filter(id => id !== parsed.id);
  await putSets(env, rec);
  return json({ ok: true, sets: rec });
}

/** POST ?action=sets-remove  {slug, id} */
export async function handleSetsRemove(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  const slug = String(body?.slug || '');
  const id = String(body?.id || '');
  if (!slug || !id) return json({ error: 'slug and id required' }, 400);

  const rec = await getSets(env, slug);
  const antes = rec.items.length;
  rec.items = rec.items.filter(i => i.id !== id);
  if (rec.items.length === antes) return json({ error: 'not in the list' }, 404);
  // Quitarlo a mano es una decision: la busqueda no lo vuelve a proponer.
  if (!rec.rejected.includes(id)) rec.rejected.push(id);
  await putSets(env, rec);
  return json({ ok: true, sets: rec });
}

/**
 * POST ?action=sets-order  {slug, ids: [...]}
 *
 * El orden lo pone una persona: lo primero de la lista es lo que la ficha
 * enseña primero. Ids que no esten se ignoran; los que falten se quedan al
 * final, para que reordenar nunca borre nada.
 */
export async function handleSetsOrder(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  const slug = String(body?.slug || '');
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.map(String) : [];
  if (!slug || !ids.length) return json({ error: 'slug and ids required' }, 400);

  const rec = await getSets(env, slug);
  const byId = new Map(rec.items.map(i => [i.id, i]));
  const ordenados = ids.map(id => byId.get(id)).filter((x): x is FeaturedSet => !!x);
  const resto = rec.items.filter(i => !ids.includes(i.id));
  rec.items = [...ordenados, ...resto];
  await putSets(env, rec);
  return json({ ok: true, sets: rec });
}

/** GET ?action=sets-review-list — lo que ha propuesto la busqueda. */
export async function handleSetsReviewList(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);

  const rows: SetsReview[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const l = await env.ENTITIES.list({ prefix: 'setreview:', limit: 1000, cursor });
    const vals = await Promise.all(l.keys.map(k => env.ENTITIES.get(k.name)));
    for (const v of vals) { try { if (v) rows.push(JSON.parse(v)); } catch { /* fila corrupta */ } }
    if (l.list_complete) break;
    cursor = l.cursor;
  }
  rows.sort((a, b) => b.fetchedAt - a.fetchedAt);
  return json({ records: rows, candidates: rows.reduce((n, r) => n + r.candidates.length, 0) });
}

/**
 * POST ?action=sets-review-put  {items: [{slug, candidates: [...]}]}
 *
 * Lo llama la busqueda de YouTube. TTL de 30 dias: un candidato que nadie mira
 * se borra solo, que es justo lo que se pidio.
 */
export async function handleSetsReviewPut(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length || items.length > 50) return json({ error: 'items: 1-50 required' }, 400);

  let written = 0, dropped = 0, skipped = 0;
  for (const it of items) {
    const slug = String(it?.slug || '');
    const e = slug ? await getEntity(env, slug) : null;
    if (!e || e.status !== 'active') { skipped++; continue; }

    const rec = await getSets(env, slug);
    const cands = filterCandidates((Array.isArray(it.candidates) ? it.candidates : [])
      .map((c: any) => {
        const parsed = parseSetUrl(c?.url);
        if (!parsed) return null;
        return {
          id: parsed.id, source: parsed.source, url: parsed.url,
          title: c.title, author: c.author, thumbnail: c.thumbnail,
          publishedAt: c.publishedAt, query: String(c.query || ''), foundAt: Date.now(),
        } as SetCandidate;
      })
      .filter(Boolean) as SetCandidate[], rec);

    if (!cands.length) { await env.ENTITIES.delete(K.review(slug)); dropped++; continue; }
    await env.ENTITIES.put(K.review(slug), JSON.stringify({ slug, candidates: cands, fetchedAt: Date.now() }),
      { expirationTtl: SET_REVIEW_TTL_S });
    written++;
  }
  return json({ written, dropped, skipped });
}

/** POST ?action=sets-review-approve  {slug, ids: [...]} → pasan a sets:. */
export async function handleSetsReviewApprove(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  const slug = String(body?.slug || '');
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.map(String) : [];
  if (!slug || !ids.length) return json({ error: 'slug and ids required' }, 400);

  const row = await getSetsReview(env, slug);
  if (!row) return json({ error: 'nothing pending for this entity' }, 404);
  const rec = await getSets(env, slug);

  let added = 0;
  for (const id of ids) {
    const c = row.candidates.find(x => x.id === id);
    if (!c || rec.items.some(i => i.id === id) || rec.items.length >= MAX_SETS) continue;
    const { query, foundAt, ...resto } = c;
    rec.items.push({ ...resto, addedAt: Date.now(), via: 'search' });
    added++;
  }
  // Lo no aprobado de esta tanda queda descartado: no se pregunta dos veces.
  for (const c of row.candidates) {
    if (!ids.includes(c.id) && !rec.rejected.includes(c.id)) rec.rejected.push(c.id);
  }
  await putSets(env, rec);
  await env.ENTITIES.delete(K.review(slug));
  return json({ ok: true, added, sets: rec });
}

/** POST ?action=sets-review-reject  {slug} — ninguno vale. */
export async function handleSetsReviewReject(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  const slug = String(body?.slug || '');
  const row = slug ? await getSetsReview(env, slug) : null;
  if (!row) return json({ error: 'nothing pending for this entity' }, 404);

  const rec = await getSets(env, slug);
  for (const c of row.candidates) if (!rec.rejected.includes(c.id)) rec.rejected.push(c.id);
  await putSets(env, rec);
  await env.ENTITIES.delete(K.review(slug));
  return json({ ok: true });
}

// ── EL BLOQUE "LISTEN" QUE VE EL CLIENTE (FASE 7D) ──────────────────
//
// Nada aqui sale de una API en caliente: todo esta ya aprobado en KV. El orden
// lo fija esta funcion y es el mismo en la estanteria del portal y en la ficha
// publica:
//
//   1. sets destacados (lo que una persona eligio)
//   2. canal de YouTube · 3. SoundCloud · 4. Mixcloud · 5. NTS
//   6. tour dates: RA y Songkick
//
// Si una entidad no tiene nada aprobado, devuelve null y **el bloque no se
// pinta**: un "Listen" vacio es peor que no tenerlo.

export interface ListenLink {
  kind: 'youtube' | 'soundcloud' | 'mixcloud' | 'nts' | 'ra' | 'songkick';
  url: string;
  label: string;        // "YouTube", "SoundCloud"…
  meta?: string;        // "last show 11 Sep 2026", cuando se sabe
}

export interface ListenBlock {
  sets: FeaturedSet[];
  links: ListenLink[];  // perfiles donde escuchar
  tour: ListenLink[];   // RA y Songkick, cuando existan
}

const LISTEN_LABEL: Record<ListenLink['kind'], string> = {
  youtube: 'YouTube', soundcloud: 'SoundCloud', mixcloud: 'Mixcloud',
  nts: 'NTS', ra: 'Resident Advisor', songkick: 'Songkick',
};

// A mano y no con toLocaleDateString: el runtime de Workers dice "11 Sept" y
// el navegador "11 Sep". Esto se guarda y se compara en los tests, asi que la
// cadena no puede depender de donde corra.
const MESES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fecha = (iso?: string) => {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return undefined;
  return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/**
 * Lo que hay que enseñar de una entidad, o null si no hay nada.
 * `externalUrl` vive en external.ts: el valor guardado es corto y la URL se
 * deriva, para que no haya dos formas de escribir el mismo enlace.
 */
export async function buildListen(env: EntitiesEnv, slug: string): Promise<ListenBlock | null> {
  const [ext, rec, mix] = await Promise.all([
    getExternal(env, slug),
    getSets(env, slug),
    getMixStat(env, slug),
  ]);

  const links: ListenLink[] = [];
  const tour: ListenLink[] = [];
  const add = (arr: ListenLink[], kind: ListenLink['kind'], value?: string, meta?: string) => {
    if (!value) return;
    arr.push({ kind, url: externalUrl(kind as any, value), label: LISTEN_LABEL[kind], ...(meta ? { meta } : {}) });
  };

  add(links, 'youtube', ext?.youtube);
  add(links, 'soundcloud', ext?.soundcloud);
  // La foto del cron: "last show 11 Sep 2026" convierte un enlace mudo en una
  // razon para pincharlo.
  add(links, 'mixcloud', ext?.mixcloud, mix?.last ? `last show ${fecha(mix.last)}` : undefined);
  add(links, 'nts', ext?.nts);
  // Las segundas cuentas aprobadas van detras de la principal, no se pierden.
  for (const [field, extras] of Object.entries(ext?.secondary || {})) {
    for (const v of extras || []) add(links, field as ListenLink['kind'], v);
  }

  add(tour, 'ra', ext?.ra);
  add(tour, 'songkick', ext?.songkick);

  const sets = rec.items;
  if (!sets.length && !links.length && !tour.length) return null;
  return { sets, links, tour };
}
