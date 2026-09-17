// ── ENLACES EXTERNOS DE UNA ENTIDAD (FASE 7) ────────────────────────
//
// Diseño y decisiones: docs/entities.md, "Fase 7: sets y eventos".
//
// A que cuenta de Mixcloud, SoundCloud, YouTube, RA, Songkick… corresponde una
// entidad. Buscar por nombre NO sirve para decidirlo: con "Pampa" salen dos
// sellos homonimos en MusicBrainz y un DJ de radio de Monaco en Mixcloud. Asi
// que la misma regla que en entities.ts:
//
//   EL SCRIPT PROPONE, UNA PERSONA DISPONE.
//
// scripts/entities-external-sweep.mjs busca candidatos en MusicBrainz y
// Wikidata y los deja en extreview:{slug}. Solo lo que alguien aprueba en la
// pestaña Entities → Links llega a external:{slug}, y solo external: se usa.
//
// Claves:
//   external:{slug}   → ExternalRecord   aprobado (y descartado, para no repetir)
//   extreview:{slug}  → ExternalReview   candidatos pendientes

import { getEntity, type EntitiesEnv } from './entities';

/** Campos de enlace. El MBID y el Wikidata no son enlaces: son la identidad. */
export const LINK_FIELDS = ['mixcloud', 'soundcloud', 'youtube', 'ra', 'songkick', 'bandsintown', 'nts', 'bandcamp'] as const;
export type LinkField = typeof LINK_FIELDS[number];

/**
 * Se guardan pero NUNCA se enseñan en el portal ni en la ficha (decision de
 * Eduardo, 2026-09-17). Por eso tampoco pesan en la cola: dos Bandcamp para la
 * misma entidad (DJ Koze tiene djkoze y djkozeofficial) no sacan la fila del
 * bloque; se quedan sin decidir y el siguiente barrido los pide fila a fila.
 */
export const HIDDEN_FIELDS: readonly LinkField[] = ['bandcamp'];

const K = {
  external: (slug: string) => `external:${slug}`,
  review: (slug: string) => `extreview:${slug}`,
};

export interface LinkValue {
  value: string;                       // forma canonica, ver parseLinkUrl()
  url: string;
  from: Array<'mb' | 'wikidata'>;      // quien lo afirma
}

export interface ExternalCandidate {
  mbid: string;
  mbKind: 'artist' | 'label';
  name: string;
  disambiguation?: string;
  country?: string;
  score?: number;
  // 'discogs-id': el Discogs ID que MB tiene enlazado coincide con el de un
  // disco nuestro ya listado en Discogs. 'name': solo casa el nombre.
  why: 'discogs-id' | 'name';
  discogs: string[];                   // Discogs IDs que MB lista para esta entidad
  wikidata?: string;
  links: Partial<Record<LinkField, LinkValue[]>>;
}

export interface ExternalReview {
  slug: string;
  display: string;
  roles: string[];
  total: number;
  followed: boolean;
  candidates: ExternalCandidate[];
  // De donde sale el Discogs ID: que disco nuestro lo prueba.
  evidence: Array<{ kind: 'artist' | 'label'; discogsId: string; name: string; releaseId: number; sku: string }>;
  bucket: 'confirmed' | 'review';
  bucketWhy?: 'no-discogs' | 'multi-mb' | 'conflict';
  fetchedAt: number;
}

export interface ExternalRecord {
  slug: string;
  mbid?: string;
  mbKind?: 'artist' | 'label';
  wikidata?: string;
  discogs?: string[];
  mixcloud?: string;
  soundcloud?: string;
  youtube?: string;
  ra?: string;
  songkick?: string;
  bandsintown?: string;
  nts?: string;
  bandcamp?: string;            // guardado, nunca publicado: ver HIDDEN_FIELDS
  approved: Record<string, { at: number; via: 'bulk' | 'row' }>;
  // Valores descartados por campo ('mbid' incluido). El barrido no los vuelve
  // a proponer: el Pampa de Monaco se descarta una vez, no cada semana.
  rejected: Record<string, string[]>;
  updatedAt: number;
}

// ── URLS ────────────────────────────────────────────────────────────
//
// Cada campo guarda un valor corto y la URL se deriva. Asi un mismo canal
// escrito como youtube.com/channel/UC… o music.youtube.com/channel/UC… es UN
// valor, y no dos que parezcan un conflicto.

const HOST_RE = /^https?:\/\/(?:www\.|m\.|music\.)?([^/]+)(\/[^?#]*)?/i;

export function parseLinkUrl(url: string): { field: LinkField; value: string } | null {
  const m = String(url || '').trim().match(HOST_RE);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const segs = (m[2] || '').split('/').filter(Boolean).map(s => decodeURIComponent(s));
  const first = (segs[0] || '').toLowerCase();

  if (host === 'mixcloud.com' && segs[0] && !['discover', 'upload', 'search'].includes(first)) {
    return { field: 'mixcloud', value: segs[0] };
  }
  if (host === 'soundcloud.com' && segs[0] && segs.length === 1) {
    return { field: 'soundcloud', value: segs[0].toLowerCase() };
  }
  if (host === 'youtube.com') {
    if (first === 'channel' && /^UC[\w-]{22}$/.test(segs[1] || '')) return { field: 'youtube', value: segs[1] };
    if (segs[0]?.startsWith('@')) return { field: 'youtube', value: segs[0].toLowerCase() };
    if ((first === 'user' || first === 'c') && segs[1]) return { field: 'youtube', value: `${first}/${segs[1]}` };
    return null;
  }
  if (host === 'ra.co' || host === 'residentadvisor.net') {
    if (first === 'dj' && segs[1]) return { field: 'ra', value: `dj/${segs[1].toLowerCase()}` };
    if (first === 'labels' && /^\d+$/.test(segs[1] || '')) return { field: 'ra', value: `labels/${segs[1]}` };
    return null;
  }
  if (host === 'songkick.com' && first === 'artists') {
    const id = (segs[1] || '').match(/^(\d+)/);
    return id ? { field: 'songkick', value: id[1] } : null;
  }
  if (host === 'bandsintown.com' && first === 'a') {
    const id = (segs[1] || '').match(/^(\d+)/);
    return id ? { field: 'bandsintown', value: id[1] } : null;
  }
  // Solo la raiz de la cuenta: un /album/ en el Bandcamp de un sello es del
  // sello, no del artista del disco.
  const bc = host.match(/^([a-z0-9-]+)\.bandcamp\.com$/);
  if (bc && !['daily', 'www'].includes(bc[1]) && (segs.length === 0 || (segs.length === 1 && first === 'music'))) {
    return { field: 'bandcamp', value: bc[1] };
  }
  if (host === 'nts.live' && first === 'artists' && segs[1]) {
    return { field: 'nts', value: `artists/${segs[1]}` };
  }
  if (host === 'nts.live' && first === 'shows' && segs[1] && segs.length === 2) {
    return { field: 'nts', value: `shows/${segs[1]}` };
  }
  return null;
}

export function externalUrl(field: LinkField, value: string): string {
  switch (field) {
    case 'mixcloud': return `https://www.mixcloud.com/${encodeURIComponent(value)}/`;
    case 'soundcloud': return `https://soundcloud.com/${encodeURIComponent(value)}`;
    case 'youtube':
      return value.startsWith('UC') ? `https://www.youtube.com/channel/${value}`
        : `https://www.youtube.com/${value}`;
    case 'ra': return `https://ra.co/${value}`;
    case 'songkick': return `https://www.songkick.com/artists/${value}`;
    case 'bandsintown': return `https://www.bandsintown.com/a/${value}`;
    case 'nts': return `https://www.nts.live/${value}`;
    case 'bandcamp': return `https://${value}.bandcamp.com/`;
  }
}

/**
 * De URLs sueltas (lo que traen MusicBrainz y Wikidata) a enlaces por campo.
 * Canonicaliza AQUI y no en el script: el valor es lo que se compara con lo
 * aprobado y lo descartado, y tiene que salir siempre de la misma funcion.
 * Lo que no es una cuenta reconocible (Spotify, Discogs, una pista suelta) se
 * cae sin mas.
 */
export function buildLinks(entries: Array<{ url: string; from: 'mb' | 'wikidata' }>): ExternalCandidate['links'] {
  const links: ExternalCandidate['links'] = {};
  for (const { url, from } of entries) {
    const p = parseLinkUrl(url);
    if (!p) continue;
    const list = links[p.field] || (links[p.field] = []);
    const hit = list.find(v => v.value === p.value);
    if (hit) { if (!hit.from.includes(from)) hit.from.push(from); }
    else list.push({ value: p.value, url: externalUrl(p.field, p.value), from: [from] });
  }
  return links;
}

// ── REGLAS PURAS ────────────────────────────────────────────────────

/**
 * Confirmed = un solo candidato de MusicBrainz, al que se ha llegado por un
 * Discogs ID de un disco nuestro, y sin ningun campo con dos valores. Es lo
 * unico que la pantalla deja aprobar en bloque. Todo lo demas, fila a fila.
 */
export function computeExternalBucket(row: Pick<ExternalReview, 'candidates'>): Pick<ExternalReview, 'bucket' | 'bucketWhy'> {
  const c = row.candidates;
  if (c.length !== 1) return { bucket: 'review', bucketWhy: c.length > 1 ? 'multi-mb' : 'no-discogs' };
  if (c[0].why !== 'discogs-id') return { bucket: 'review', bucketWhy: 'no-discogs' };
  const offered = LINK_FIELDS.filter(f => (c[0].links[f] || []).length > 0);
  const conflicts = offered.filter(f => c[0].links[f]!.length > 1);
  if (conflicts.some(f => !HIDDEN_FIELDS.includes(f))) return { bucket: 'review', bucketWhy: 'conflict' };
  // Si lo unico que queda por decidir es un conflicto oculto, el bloque no lo
  // resolveria nunca (lo deja sin decidir): a mano.
  if (conflicts.length && conflicts.length === offered.length) return { bucket: 'review', bucketWhy: 'conflict' };
  return { bucket: 'confirmed' };
}

/**
 * Quita de una fila lo que ya esta decidido en external:{slug}: MBIDs y valores
 * descartados, y los campos que ya tienen valor aprobado. Si la entidad ya
 * tiene MBID aprobado, solo sobreviven candidatos con ESE MBID (pueden traer
 * enlaces nuevos que MB no tenia la vez anterior). null = no queda nada.
 */
export function filterAgainstRecord(row: ExternalReview, rec: ExternalRecord | null): ExternalReview | null {
  const rej = rec?.rejected || {};
  let candidates = row.candidates.filter(c => !(rej.mbid || []).includes(c.mbid));
  if (rec?.mbid) candidates = candidates.filter(c => c.mbid === rec.mbid);

  candidates = candidates.map(c => {
    const links: ExternalCandidate['links'] = {};
    for (const f of LINK_FIELDS) {
      if (rec && (rec as any)[f]) continue;
      const vals = (c.links[f] || []).filter(v => !(rej[f] || []).includes(v.value));
      if (vals.length) links[f] = vals;
    }
    return { ...c, links };
  });

  // Con el MBID ya aprobado, un candidato sin enlaces nuevos no pide nada.
  if (rec?.mbid) candidates = candidates.filter(c => Object.keys(c.links).length > 0);
  if (!candidates.length) return null;

  const out = { ...row, candidates };
  return { ...out, ...computeExternalBucket(out) };
}

/** Lo que aprobar escribe: el candidato elegido, con los valores elegidos. */
export function applyApproval(
  rec: ExternalRecord | null,
  row: ExternalReview,
  mbid: string,
  fields: Partial<Record<LinkField, string>>,
  via: 'bulk' | 'row',
  now: number,
  undecided: LinkField[] = [],   // campos que no se aprueban NI se descartan
): ExternalRecord {
  const cand = row.candidates.find(c => c.mbid === mbid);
  if (!cand) throw new Error('mbid is not a candidate of this row');

  const out: ExternalRecord = rec
    ? { ...rec, approved: { ...rec.approved }, rejected: { ...rec.rejected } }
    : { slug: row.slug, approved: {}, rejected: {}, updatedAt: now };
  const reject = (field: string, value: string) => {
    const list = out.rejected[field] || [];
    if (!list.includes(value)) out.rejected[field] = [...list, value];
  };

  if (!out.mbid) {
    out.mbid = cand.mbid;
    out.mbKind = cand.mbKind;
    out.approved.mbid = { at: now, via };
    if (cand.wikidata) out.wikidata = cand.wikidata;
    if (cand.discogs.length) out.discogs = cand.discogs;
  }

  for (const f of LINK_FIELDS) {
    if (undecided.includes(f)) continue;
    const offered = cand.links[f] || [];
    const chosen = fields[f];
    if (chosen !== undefined && !offered.some(v => v.value === chosen)) {
      throw new Error(`${f}: "${chosen}" is not offered by this candidate`);
    }
    for (const v of offered) {
      if (v.value === chosen) { (out as any)[f] = chosen; out.approved[f] = { at: now, via }; }
      else reject(f, v.value);
    }
  }

  // Los otros candidatos de la fila quedan descartados, con sus enlaces.
  for (const c of row.candidates) {
    if (c.mbid === cand.mbid) continue;
    if (c.mbid !== out.mbid) reject('mbid', c.mbid);
    for (const f of LINK_FIELDS) for (const v of c.links[f] || []) {
      if ((out as any)[f] !== v.value) reject(f, v.value);
    }
  }

  out.updatedAt = now;
  return out;
}

// ── KV ──────────────────────────────────────────────────────────────

export async function getExternal(env: EntitiesEnv, slug: string): Promise<ExternalRecord | null> {
  const raw = await env.ENTITIES.get(K.external(slug));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function getReview(env: EntitiesEnv, slug: string): Promise<ExternalReview | null> {
  const raw = await env.ENTITIES.get(K.review(slug));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
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

/**
 * POST ?action=external-review-put  {items: ExternalReview[]}
 *
 * Lo llama el barrido. Filtra contra lo ya decidido y recalcula el bucket aqui,
 * no en el script: la pantalla confia en el bucket, y el bucket es lo que deja
 * aprobar en bloque.
 */
export async function handleExternalReviewPut(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  const items: ExternalReview[] = Array.isArray(body?.items) ? body.items : [];
  if (!items.length || items.length > 50) return json({ error: 'items: 1-50 required' }, 400);

  let written = 0, dropped = 0, skipped = 0;
  for (const it of items) {
    if (!it?.slug || !Array.isArray(it.candidates)) { skipped++; continue; }
    const e = await getEntity(env, it.slug);
    if (!e || e.status !== 'active') { skipped++; continue; }
    // El script manda URLs (urls: [{url, from}]); los enlaces se construyen aqui.
    const candidates = it.candidates.map((c: any): ExternalCandidate => ({
      mbid: String(c.mbid || ''), mbKind: c.mbKind === 'label' ? 'label' as const : 'artist' as const,
      name: String(c.name || ''), disambiguation: c.disambiguation || undefined,
      country: c.country || undefined, score: c.score, why: c.why === 'discogs-id' ? 'discogs-id' as const : 'name' as const,
      discogs: Array.isArray(c.discogs) ? c.discogs.map(String) : [],
      wikidata: c.wikidata || undefined,
      links: buildLinks([
        ...(Array.isArray(c.urls) ? c.urls : []),
        ...LINK_FIELDS.flatMap(f => (c.links?.[f] || []).flatMap((v: LinkValue) => v.from.map(from => ({ url: v.url, from })))),
      ]),
    })).filter((c: ExternalCandidate) => /^[0-9a-f-]{36}$/.test(c.mbid));
    const row = filterAgainstRecord({
      ...it,
      candidates,
      display: e.display,
      roles: e.roles,
      evidence: Array.isArray(it.evidence) ? it.evidence : [],
      fetchedAt: Number(it.fetchedAt) || Date.now(),
    }, await getExternal(env, it.slug));
    if (!row) { await env.ENTITIES.delete(K.review(it.slug)); dropped++; continue; }
    await env.ENTITIES.put(K.review(it.slug), JSON.stringify(row));
    written++;
  }
  return json({ written, dropped, skipped });
}

/** GET ?action=external-review-list — seguidas primero, luego por discos. */
export async function handleExternalReviewList(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);

  const rows: ExternalReview[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const l = await env.ENTITIES.list({ prefix: 'extreview:', limit: 1000, cursor });
    const vals = await Promise.all(l.keys.map(k => env.ENTITIES.get(k.name)));
    for (const v of vals) { try { if (v) rows.push(JSON.parse(v)); } catch { /* fila corrupta */ } }
    if (l.list_complete) break;
    cursor = l.cursor;
  }
  rows.sort((a, b) => Number(b.followed) - Number(a.followed) || b.total - a.total || a.slug.localeCompare(b.slug));
  return json({
    records: rows,
    counts: {
      confirmed: rows.filter(r => r.bucket === 'confirmed').length,
      review: rows.filter(r => r.bucket === 'review').length,
    },
  });
}

/**
 * POST ?action=external-review-approve
 *   {slug, mbid, fields: {mixcloud?: "…", ra?: "…", …}}
 *
 * Fila a fila. Lo no elegido de la fila se descarta.
 */
export async function handleExternalReviewApprove(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  const slug = String(body?.slug || '');
  const mbid = String(body?.mbid || '');
  if (!slug || !mbid) return json({ error: 'slug and mbid required' }, 400);

  const row = await getReview(env, slug);
  if (!row) return json({ error: 'not in queue' }, 404);
  try {
    const rec = applyApproval(await getExternal(env, slug), row, mbid, body.fields || {}, 'row', Date.now());
    await env.ENTITIES.put(K.external(slug), JSON.stringify(rec));
    await env.ENTITIES.delete(K.review(slug));
    return json({ ok: true, external: rec });
  } catch (e: any) {
    return json({ error: e.message }, 400);
  }
}

/**
 * POST ?action=external-review-approve-bulk  {slugs: string[]}
 *
 * Solo filas 'confirmed'; el servidor lo comprueba otra vez, no se fia de la
 * pantalla. Aprueba el candidato unico con todos sus enlaces (por construccion,
 * uno por campo).
 */
export async function handleExternalReviewApproveBulk(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  const slugs: string[] = Array.isArray(body?.slugs) ? body.slugs.map(String) : [];
  if (!slugs.length || slugs.length > 50) return json({ error: 'slugs: 1-50 required' }, 400);

  const results: Array<{ slug: string; ok: boolean; error?: string }> = [];
  for (const slug of slugs) {
    const row = await getReview(env, slug);
    if (!row) { results.push({ slug, ok: false, error: 'not in queue' }); continue; }
    if (computeExternalBucket(row).bucket !== 'confirmed') { results.push({ slug, ok: false, error: 'not confirmed' }); continue; }
    const c = row.candidates[0];
    const fields: Partial<Record<LinkField, string>> = {};
    const undecided: LinkField[] = [];
    for (const f of LINK_FIELDS) {
      if (c.links[f]?.length === 1) fields[f] = c.links[f]![0].value;
      else if ((c.links[f]?.length || 0) > 1) undecided.push(f);   // solo puede pasar en HIDDEN_FIELDS
    }
    try {
      const rec = applyApproval(await getExternal(env, slug), row, c.mbid, fields, 'bulk', Date.now(), undecided);
      await env.ENTITIES.put(K.external(slug), JSON.stringify(rec));
      await env.ENTITIES.delete(K.review(slug));
      results.push({ slug, ok: true });
    } catch (e: any) {
      results.push({ slug, ok: false, error: e.message });
    }
  }
  return json({ approved: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
}

/** POST ?action=external-review-reject {slug} — ninguno es; no volveran. */
export async function handleExternalReviewReject(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  const slug = String(body?.slug || '');
  const row = slug ? await getReview(env, slug) : null;
  if (!row) return json({ error: 'not in queue' }, 404);

  const now = Date.now();
  const rec: ExternalRecord = (await getExternal(env, slug)) || { slug, approved: {}, rejected: {}, updatedAt: now };
  const reject = (field: string, value: string) => {
    const list = rec.rejected[field] || [];
    if (!list.includes(value)) rec.rejected[field] = [...list, value];
  };
  for (const c of row.candidates) {
    if (c.mbid !== rec.mbid) reject('mbid', c.mbid);
    for (const f of LINK_FIELDS) for (const v of c.links[f] || []) reject(f, v.value);
  }
  rec.updatedAt = now;
  await env.ENTITIES.put(K.external(slug), JSON.stringify(rec));
  await env.ENTITIES.delete(K.review(slug));
  return json({ ok: true });
}

/** GET ?action=external-get&slug=… — depurar. */
export async function handleExternalGet(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  const slug = new URL(request.url).searchParams.get('slug') || '';
  if (!slug) return json({ error: 'slug required' }, 400);
  return json({ external: await getExternal(env, slug), review: await getReview(env, slug) });
}
