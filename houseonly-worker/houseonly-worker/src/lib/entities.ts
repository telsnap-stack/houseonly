// ── ENTIDADES: ARTISTAS Y SELLOS CANONICOS ──────────────────────────
//
// Diseño completo y decisiones: docs/entities.md
//
// El problema, en una linea: el artista vive en `Vendor` y el sello en un tag
// `label:`, ambos texto libre del distribuidor. 910 vendors distintos para 1266
// productos, y normalizar (casefold + puntuacion) solo absorbe 33 filas — el
// 3,6 %. El resto es estructural: 215 vendors meten varios artistas en un
// campo, hay 17 grafias de "varios artistas", sub-sellos, alias.
//
// De ahi la regla que gobierna todo este modulo:
//
//   EL RESOLVER PROPONE, UNA PERSONA DISPONE.
//
// Nada crea una entidad salvo una aprobacion explicita en la cola. Aqui ya han
// llegado matches equivocados a clientes por automatizar de mas, y los falsos
// positivos son faciles de encontrar: AXIS / Axis Of People, Base / Based
// Faith y NOTON / Not On Label son sellos DISTINTOS que un parecido textual
// juntaria alegremente.

export type EntityKind = 'artist' | 'label';
export type EntityRole = EntityKind;

export interface EntitiesEnv {
  ENTITIES: KVNamespace;
  BOOTSTRAP_AUTH_SECRET: string;
}

export interface EntityRecord {
  slug: string;                 // inmutable
  display: string;              // editable
  roles: EntityRole[];
  parent?: string;              // slug del sello padre (solo sub-sellos reales)
  aliases: string[];
  sources: string[];
  status: 'active' | 'merged';
  mergedInto?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewProposalPart {
  raw: string;
  display: string;
  norm: string;
  existingSlug?: string;
}

export interface ReviewRecord {
  kind: EntityKind;
  norm: string;
  raw: string;
  variants: string[];
  proposal: {
    action: 'create' | 'split';
    parts: ReviewProposalPart[];
    separator?: string;
  };
  candidates: Array<{ slug: string; display: string; why: 'normalized' | 'prefix' }>;
  sources: string[];
  samples: string[];       // primeros handles, para que la UI ensene de que va
  handles?: string[];      // handles ya contados, para que count no se infle
  countApprox?: boolean;   // true si se paso del tope y count deja de ser exacto
  count: number;
  firstSeen: number;
  lastSeen: number;
}

// ── CLAVES ──────────────────────────────────────────────────────────
//
//   entity:{slug}                     → EntityRecord
//   alias:a:{norm} / alias:l:{norm}   → "{slug}"   (uno por rol: el contexto
//                                        importa — "Signature" como sello no es
//                                        "Signature" como artista)
//   ignore:a:{norm} / ignore:l:{norm} → "1"
//   children:{parent}:{child}         → "1"
//   review:{kind}:{norm}              → ReviewRecord

const K = {
  entity: (slug: string) => `entity:${slug}`,
  alias: (kind: EntityKind, norm: string) => `alias:${kind === 'artist' ? 'a' : 'l'}:${norm}`,
  ignore: (kind: EntityKind, norm: string) => `ignore:${kind === 'artist' ? 'a' : 'l'}:${norm}`,
  child: (parent: string, child: string) => `children:${parent}:${child}`,
  review: (kind: EntityKind, norm: string) => `review:${kind}:${norm}`,
};

// Limite de muestras guardadas por fila de la cola. Suficiente para que una
// persona vea de que va y se pueda pinchar; no queremos 900 handles en KV.
const MAX_SAMPLES = 8;
const MAX_VARIANTS = 12;
// Handles recordados por fila para deduplicar el conteo. El barrido se puede
// repetir, y sin esto `count` se doblaria en cada pasada. Con 1266 productos la
// fila mas poblada no llega ni de lejos a este tope, asi que en la practica el
// conteo es exacto; si alguna vez se pasa, se marca countApprox.
const MAX_HANDLES = 200;

// ── NORMALIZACION ───────────────────────────────────────────────────

/**
 * Clave de agrupacion: minusculas y fuera todo lo que no sea alfanumerico.
 * Es la MISMA regla que rdKey() en el importer de Rubadub y que
 * findVariantBySkuLoose() en shopify-admin — a proposito, para que catno, SKU y
 * nombre de entidad se comporten igual en todo el sistema.
 */
export function normalizeName(raw: string): string {
  return (raw || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Slug legible y estable: minusculas, separadores a guion, sin extremos sueltos.
 * Se congela al aprobar; `display` es lo que se puede corregir despues.
 */
export function slugify(raw: string): string {
  return (raw || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // fuera diacriticos: Böning → Boning
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Limpieza cosmetica del nombre para PROPONER un display. No decide nada: es
 * lo que aparece relleno en la cola para que la persona lo acepte o lo corrija.
 * Arregla lo que se ve en el catalogo real: espacios dobles, comas y puntos
 * colgando de un truncado, y la corrupcion de ligaduras del parseo de PDF
 * ("Bano ff ee Pies" → "Banoffee Pies", "Forti fi ed Audio", "Synaptic Cli ff s").
 */
export function cleanDisplay(raw: string): string {
  return (raw || '')
    // Que hacer con el trozo de despues depende de si es continuacion de la
    // misma palabra o una palabra nueva, y eso se ve por la mayuscula:
    //   "Bano ff ee Pies"   → ee minuscula  → pega los dos lados → Banoffee
    //   "Synaptic Cli ff s" → s  minuscula  → Cliffs
    //   "O ff   House"      → House MAYUS   → pega solo a la izquierda → Off House
    // Es una heuristica, no una certeza: por eso el display propuesto se
    // aprueba a mano y es editable en la cola.
    .replace(/\s+(ff|fi|fl)\s+(?=[a-z])/g, '$1')
    .replace(/\s+(ff|fi|fl)\s+(?=[A-Z])/g, '$1 ')
    .replace(/\s+(ff|fi|fl)$/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/[\s,;.]+$/g, '')            // coma o punto de un truncado
    .trim();
}

// Separadores vistos de verdad en los 910 vendors del catalogo. El orden
// importa poco porque partimos con una sola expresion, pero la lista si: cada
// uno esta aqui porque aparece en datos reales.
const SPLIT_RE = /\s+(?:&|\+|\/|\||,|x|vs\.?|and|feat\.?|ft\.?|featuring|pres\.?|presents|aka)\s+|\s*\/\s*|\s*,\s*|\s*\|\s*/i;

/**
 * Trocea un multi-artista en partes. SOLO para proponer: el resultado va a la
 * cola, nunca directo a entidades. 215 de los 910 vendors (23,6 %) meten varios
 * artistas en un campo, asi que esto es la mayoria del trabajo de la cola.
 */
export function proposeSplit(raw: string): { parts: string[]; separator?: string } {
  const s = (raw || '').trim();
  // Un parentesis suele ser aclaracion, no otro artista: "Echelon (Jeroen
  // Search)", "Presence (Aka Charles Webster)". No se parte por ahi.
  const withoutParens = s.replace(/\([^)]*\)/g, ' ').trim();
  if (!SPLIT_RE.test(withoutParens)) return { parts: [s] };

  const m = withoutParens.match(SPLIT_RE);
  const parts = withoutParens
    .split(new RegExp(SPLIT_RE.source, 'gi'))
    .map(p => p.trim())
    .filter(Boolean);

  if (parts.length < 2) return { parts: [s] };
  return { parts, separator: (m?.[0] || '').trim() };
}

// ── LECTURA ─────────────────────────────────────────────────────────

export async function getEntity(env: EntitiesEnv, slug: string): Promise<EntityRecord | null> {
  const raw = await env.ENTITIES.get(K.entity(slug));
  if (!raw) return null;
  try { return JSON.parse(raw) as EntityRecord; } catch { return null; }
}

/** Sigue la cadena de merges hasta la entidad viva. Tope por si hay un ciclo. */
async function resolveMerged(env: EntitiesEnv, slug: string): Promise<EntityRecord | null> {
  let cur = slug;
  for (let i = 0; i < 5; i++) {
    const e = await getEntity(env, cur);
    if (!e) return null;
    if (e.status !== 'merged' || !e.mergedInto) return e;
    cur = e.mergedInto;
  }
  return null;
}

// ── RESOLUCION ──────────────────────────────────────────────────────

export type ResolveStatus = 'resolved' | 'review' | 'ignored';

export interface ResolveResult {
  raw: string;
  status: ResolveStatus;
  slugs: string[];
  display: string[];
  matchedBy: 'exact' | 'alias' | 'normalized' | null;
}

export interface ResolveItem {
  raw: string;
  context?: { handle?: string };
}

/**
 * Resuelve un nombre crudo a entidades canonicas.
 *
 * El orden es este y no hay un paso 5:
 *   1. alias exacto por la cadena cruda
 *   2. alias por la forma normalizada
 *   3. lista de ignorados (V.A., Unknown, House Only...)
 *   4. a la cola de revision, con una propuesta
 *
 * Nada de distancia de edicion ni de dar por bueno un troceo automatico.
 */
export async function resolveOne(
  env: EntitiesEnv,
  kind: EntityKind,
  item: ResolveItem,
  source: string,
): Promise<ResolveResult> {
  const raw = (item.raw || '').trim();
  const base: ResolveResult = { raw, status: 'review', slugs: [], display: [], matchedBy: null };
  if (!raw) return { ...base, status: 'ignored' };

  const norm = normalizeName(raw);
  if (!norm) return { ...base, status: 'ignored' };

  // 1 + 2. alias exacto, luego normalizado
  for (const [key, how] of [
    [K.alias(kind, raw), 'exact'],
    [K.alias(kind, norm), 'normalized'],
  ] as const) {
    const hit = await env.ENTITIES.get(key);
    if (!hit) continue;
    const slugs = hit.split(',').map(s => s.trim()).filter(Boolean);
    const entities = await Promise.all(slugs.map(s => resolveMerged(env, s)));
    const live = entities.filter((e): e is EntityRecord => !!e);
    if (live.length) {
      return {
        raw,
        status: 'resolved',
        slugs: live.map(e => e.slug),
        display: live.map(e => e.display),
        matchedBy: how === 'exact' ? 'exact' : 'alias',
      };
    }
  }

  // 3. ignorados
  if (await env.ENTITIES.get(K.ignore(kind, norm))) {
    return { ...base, status: 'ignored' };
  }

  // 4. a la cola
  await upsertReview(env, kind, raw, norm, source, item.context?.handle);
  return base;
}

export async function resolveBatch(
  env: EntitiesEnv,
  kind: EntityKind,
  items: ResolveItem[],
  source: string,
): Promise<ResolveResult[]> {
  const out: ResolveResult[] = [];
  for (const it of items) out.push(await resolveOne(env, kind, it, source));
  return out;
}

// ── COLA DE REVISION ────────────────────────────────────────────────

/**
 * Crea o engorda la fila de la cola. Idempotente por `norm`: repetir el barrido
 * suma count, variantes y muestras en vez de duplicar filas.
 */
async function upsertReview(
  env: EntitiesEnv,
  kind: EntityKind,
  raw: string,
  norm: string,
  source: string,
  handle?: string,
): Promise<void> {
  const key = K.review(kind, norm);
  let rec: ReviewRecord | null = null;
  try {
    const prev = await env.ENTITIES.get(key);
    if (prev) rec = JSON.parse(prev) as ReviewRecord;
  } catch { /* una fila corrupta no puede parar una importacion */ }

  const now = Date.now();
  if (!rec) {
    rec = {
      kind, norm, raw,
      variants: [],
      proposal: { action: 'create', parts: [] },
      candidates: [],
      sources: [],
      samples: [],
      count: 0,
      firstSeen: now,
      lastSeen: now,
    };
  }

  if (!rec.variants.includes(raw) && rec.variants.length < MAX_VARIANTS) rec.variants.push(raw);
  if (source && !rec.sources.includes(source)) rec.sources.push(source);
  if (handle && !rec.samples.includes(handle) && rec.samples.length < MAX_SAMPLES) rec.samples.push(handle);

  // Conteo idempotente: un producto ya contado no vuelve a sumar, asi que
  // repetir el barrido reordena la cola igual pero no infla los numeros. Sin
  // handle no hay forma de deduplicar y se suma a ciegas.
  rec.handles ||= [];
  if (!handle) {
    rec.count++;
  } else if (!rec.handles.includes(handle)) {
    if (rec.handles.length < MAX_HANDLES) {
      rec.handles.push(handle);
      rec.count++;
    } else {
      rec.count++;
      rec.countApprox = true;
    }
  }
  rec.lastSeen = now;

  // La propuesta se recalcula en cada pasada: si entretanto se ha aprobado una
  // entidad que casa con un trozo, aparece como existingSlug sin repetir barrido.
  rec.proposal = await buildProposal(env, kind, raw);
  rec.candidates = await findCandidates(env, kind, norm);

  await env.ENTITIES.put(key, JSON.stringify(rec));
}

/**
 * Propuesta por defecto de la fila: crear una entidad con el display limpio.
 * Si el nombre huele a multi-artista, se propone el troceo y cada parte se
 * busca por si ya existe.
 */
async function buildProposal(
  env: EntitiesEnv,
  kind: EntityKind,
  raw: string,
): Promise<ReviewRecord['proposal']> {
  // Los sellos no se trocean: "Vibes & Pepper Records" es un solo sello, y
  // partirlo por el "&" seria justo el error que este modulo evita.
  const split = kind === 'artist' ? proposeSplit(raw) : { parts: [raw] as string[], separator: undefined };

  const parts: ReviewProposalPart[] = [];
  for (const p of split.parts) {
    const display = cleanDisplay(p);
    const pnorm = normalizeName(display);
    const existing = pnorm ? await env.ENTITIES.get(K.alias(kind, pnorm)) : null;
    parts.push({
      raw: p,
      display,
      norm: pnorm,
      ...(existing ? { existingSlug: existing.split(',')[0] } : {}),
    });
  }

  return {
    action: parts.length > 1 ? 'split' : 'create',
    parts,
    ...(split.separator ? { separator: split.separator } : {}),
  };
}

/**
 * Candidatos que la UI ofrece con un clic. Solo dos motivos, ambos textuales y
 * ambos SUGERENCIAS: coincidencia normalizada y prefijo. El prefijo trae falsos
 * positivos conocidos (AXIS / Axis Of People), por eso una fila con candidatos
 * llega DESMARCADA en la cola y hay que mirarla.
 */
async function findCandidates(
  env: EntitiesEnv,
  kind: EntityKind,
  norm: string,
): Promise<ReviewRecord['candidates']> {
  const out: ReviewRecord['candidates'] = [];
  const seen = new Set<string>();

  const exact = await env.ENTITIES.get(K.alias(kind, norm));
  if (exact) {
    for (const slug of exact.split(',')) {
      const e = await getEntity(env, slug.trim());
      if (e && !seen.has(e.slug)) { seen.add(e.slug); out.push({ slug: e.slug, display: e.display, why: 'normalized' }); }
    }
  }

  // Prefijo: recorre los alias del mismo rol. Es un list() sobre el namespace,
  // aceptable con centenares de entidades; si esto crece a miles, hara falta un
  // indice propio.
  if (norm.length >= 4) {
    const prefix = `alias:${kind === 'artist' ? 'a' : 'l'}:`;
    const listing = await env.ENTITIES.list({ prefix, limit: 1000 });
    for (const k of listing.keys) {
      const other = k.name.slice(prefix.length);
      if (other === norm) continue;
      if (!other.startsWith(norm) && !norm.startsWith(other)) continue;
      if (Math.min(other.length, norm.length) < 4) continue;
      const slug = (await env.ENTITIES.get(k.name) || '').split(',')[0].trim();
      if (!slug || seen.has(slug)) continue;
      const e = await getEntity(env, slug);
      if (!e) continue;
      seen.add(slug);
      out.push({ slug: e.slug, display: e.display, why: 'prefix' });
      if (out.length >= 6) break;
    }
  }

  return out;
}

// ── ESCRITURA DE ENTIDADES ──────────────────────────────────────────

async function putEntity(env: EntitiesEnv, e: EntityRecord): Promise<void> {
  await env.ENTITIES.put(K.entity(e.slug), JSON.stringify(e));
}

/**
 * Crea la entidad si no existe; si existe, le suma el rol, el alias y la fuente.
 * Es lo que permite que una sola entidad tenga roles ['artist','label'] — como
 * 2000Black, Neroli o Rhythm & Sound, que son vendor Y sello.
 */
async function upsertEntity(
  env: EntitiesEnv,
  slug: string,
  display: string,
  kind: EntityKind,
  opts: { aliases?: string[]; sources?: string[]; parent?: string } = {},
): Promise<EntityRecord> {
  const now = Date.now();
  let e = await getEntity(env, slug);
  if (!e) {
    e = {
      slug, display,
      roles: [kind],
      aliases: [],
      sources: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
  }
  if (display) e.display = display;
  if (!e.roles.includes(kind)) e.roles.push(kind);
  for (const a of opts.aliases || []) if (a && !e.aliases.includes(a)) e.aliases.push(a);
  for (const s of opts.sources || []) if (s && !e.sources.includes(s)) e.sources.push(s);
  if (opts.parent) e.parent = opts.parent;
  e.updatedAt = now;
  await putEntity(env, e);
  return e;
}

/** Apunta un alias (crudo y normalizado) a uno o varios slugs. */
async function pointAlias(env: EntitiesEnv, kind: EntityKind, raws: string[], slugs: string[]): Promise<void> {
  const value = slugs.join(',');
  const norms = new Set<string>();
  for (const r of raws) {
    if (!r) continue;
    await env.ENTITIES.put(K.alias(kind, r), value);   // exacto
    const n = normalizeName(r);
    if (n) norms.add(n);
  }
  for (const n of norms) await env.ENTITIES.put(K.alias(kind, n), value);
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

function parseKind(v: any): EntityKind | null {
  return v === 'artist' || v === 'label' ? v : null;
}

/** POST ?action=entity-resolve */
export async function handleEntityResolve(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const kind = parseKind(body?.kind);
  if (!kind) return json({ error: "kind must be 'artist' or 'label'" }, 400);

  const items: ResolveItem[] = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) return json({ error: 'items required' }, 400);
  if (items.length > 500) return json({ error: 'max 500 items per call' }, 400);

  const results = await resolveBatch(env, kind, items, String(body?.source || ''));
  return json({
    results,
    summary: {
      resolved: results.filter(r => r.status === 'resolved').length,
      review: results.filter(r => r.status === 'review').length,
      ignored: results.filter(r => r.status === 'ignored').length,
    },
  });
}

/** GET ?action=entity-review-list */
export async function handleEntityReviewList(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const kind = parseKind(url.searchParams.get('kind'));
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
  const prefix = kind ? `review:${kind}:` : 'review:';

  const listing = await env.ENTITIES.list({ prefix, limit: 1000 });
  const records: ReviewRecord[] = [];
  for (const k of listing.keys) {
    const raw = await env.ENTITIES.get(k.name);
    if (!raw) continue;
    try { records.push(JSON.parse(raw) as ReviewRecord); } catch { /* fila corrupta, se salta */ }
  }

  // Por count descendente: primero lo que mas catalogo desbloquea.
  records.sort((a, b) => (b.count || 0) - (a.count || 0));

  return json({
    total: records.length,
    truncated: listing.list_complete === false,
    records: records.slice(0, limit),
  });
}

/** POST ?action=entity-review-approve */
export async function handleEntityReviewApprove(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const kind = parseKind(body?.kind);
  const norm = String(body?.norm || '').trim();
  const action = String(body?.action || 'create');
  if (!kind || !norm) return json({ error: 'kind and norm required' }, 400);

  const key = K.review(kind, norm);
  const rawRec = await env.ENTITIES.get(key);
  if (!rawRec) return json({ error: 'review record not found' }, 404);

  let rec: ReviewRecord;
  try { rec = JSON.parse(rawRec) as ReviewRecord; } catch { return json({ error: 'corrupt review record' }, 500); }

  const aliasRaws = [rec.raw, ...rec.variants];
  const slugs: string[] = [];

  if (action === 'merge') {
    const target = String(body?.targetSlug || '').trim();
    if (!target) return json({ error: 'targetSlug required for merge' }, 400);
    const e = await getEntity(env, target);
    if (!e) return json({ error: `unknown targetSlug ${target}` }, 400);
    await upsertEntity(env, target, e.display, kind, { aliases: aliasRaws, sources: rec.sources });
    slugs.push(target);

  } else if (action === 'create' || action === 'split' || action === 'child') {
    const parts: any[] = Array.isArray(body?.parts) && body.parts.length
      ? body.parts
      : rec.proposal.parts;
    if (!parts.length) return json({ error: 'parts required' }, 400);

    const parentSlug = action === 'child' ? String(body?.parentSlug || '').trim() : '';
    if (action === 'child') {
      if (!parentSlug) return json({ error: 'parentSlug required for child' }, 400);
      if (!(await getEntity(env, parentSlug))) return json({ error: `unknown parentSlug ${parentSlug}` }, 400);
    }

    for (const p of parts) {
      const display = cleanDisplay(String(p?.display || p?.raw || ''));
      if (!display) continue;
      // Siempre por slugify, incluso si el cliente manda un slug ya hecho. El
      // valor de alias:{k}:{norm} son slugs separados por COMA, asi que un slug
      // con una coma dentro romperia el split y resolveria a entidades que no
      // existen. slugify no puede producir una.
      const slug = slugify(String(p?.slug || '').trim() || display);
      if (!slug) continue;
      await upsertEntity(env, slug, display, kind, {
        // Un split reparte el alias entre las partes, asi que el crudo completo
        // no es alias de ninguna por separado: se apunta abajo, a todas a la vez.
        aliases: parts.length === 1 ? aliasRaws : [],
        sources: rec.sources,
        ...(parentSlug ? { parent: parentSlug } : {}),
      });
      if (parentSlug) await env.ENTITIES.put(K.child(parentSlug, slug), '1');
      slugs.push(slug);
    }
    if (!slugs.length) return json({ error: 'no usable parts' }, 400);

  } else {
    return json({ error: `unknown action ${action}` }, 400);
  }

  // El crudo (y sus variantes) apuntan al conjunto resultante. En un split eso
  // son N slugs separados por coma, que es como resolveOne devuelve varios.
  await pointAlias(env, kind, aliasRaws, slugs);
  await env.ENTITIES.delete(key);

  return json({ ok: true, action, kind, norm, slugs });
}

/** POST ?action=entity-review-reject */
export async function handleEntityReviewReject(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const kind = parseKind(body?.kind);
  const norm = String(body?.norm || '').trim();
  if (!kind || !norm) return json({ error: 'kind and norm required' }, 400);

  await env.ENTITIES.put(K.ignore(kind, norm), '1');
  await env.ENTITIES.delete(K.review(kind, norm));
  return json({ ok: true, ignored: norm, kind });
}

/** GET ?action=entity-get&slug=… */
export async function handleEntityGet(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);

  const slug = new URL(request.url).searchParams.get('slug') || '';
  if (!slug) return json({ error: 'slug required' }, 400);

  const e = await getEntity(env, slug);
  if (!e) return json({ error: 'not found' }, 404);

  const kids = await env.ENTITIES.list({ prefix: `children:${slug}:`, limit: 200 });
  return json({
    entity: e,
    children: kids.keys.map(k => k.name.split(':')[2]).filter(Boolean),
  });
}
