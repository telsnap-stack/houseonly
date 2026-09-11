/**
 * Follows y feed — fase 5a de docs/entities.md.
 *
 * Un follow guarda un SLUG, nunca un nombre. `WishlistItem` copio `artist` y
 * `label` como texto libre y por eso hoy no se puede seguir a nadie desde la
 * wishlist; ese error no se repite aqui.
 *
 * Claves (namespace ENTITIES):
 *   follow:{customerId}        → { entities: string[], updatedAt }
 *   fanout:{slug}:{customerId} → "1"     indice inverso, una clave por par
 *   feedindex:v1               → catalogo activo cacheado, con sus slugs
 *
 * El indice inverso es una clave por seguidor y no un blob con la lista: KV no
 * tiene transacciones, y un `fanout:{slug}` con miles de seguidores pierde altas
 * en cuanto dos personas siguen a la vez.
 */

import { getEntity, normalizeName, type EntityRecord } from './entities';
import { parseSlugs } from './entity-metafields';
import { makeReleaseSlug } from './slug';

export interface FollowsEnv {
  ENTITIES: KVNamespace;
  STOREFRONT_TOKEN: string;
}

export interface FollowRecord {
  entities: string[];
  updatedAt: number;
}

/** Tope por cliente, como los 500 items de la wishlist. */
export const MAX_FOLLOWS = 500;

/** Ventana del feed: por defecto 90 dias, y nunca mas de 180. */
export const FEED_DAYS_DEFAULT = 90;
export const FEED_DAYS_MAX = 180;
export const FEED_LIMIT_DEFAULT = 24;
export const FEED_LIMIT_MAX = 100;

/** El indice del catalogo se reconstruye como mucho cada 10 minutos. */
export const INDEX_TTL_MS = 10 * 60 * 1000;

const SHOPIFY_DOMAIN = 'house-only-2.myshopify.com';
const SF_API = '2024-04';

const K = {
  follow: (cid: string) => `follow:${cid}`,
  fanout: (slug: string, cid: string) => `fanout:${slug}:${cid}`,
  children: (slug: string) => `children:${slug}:`,
  index: 'feedindex:v2',   // v2: cada producto lleva su gid, para cruzar pedidos
  entityIndex: 'entityindex:v1',
};

// ── LECTURA Y ESCRITURA DE FOLLOWS ──────────────────────────────────

export async function loadFollows(env: FollowsEnv, cid: string): Promise<FollowRecord> {
  const raw = await env.ENTITIES.get(K.follow(cid));
  if (!raw) return { entities: [], updatedAt: 0 };
  try {
    const p = JSON.parse(raw);
    return {
      entities: Array.isArray(p.entities) ? p.entities.filter((s: any) => typeof s === 'string') : [],
      updatedAt: Number(p.updatedAt) || 0,
    };
  } catch {
    return { entities: [], updatedAt: 0 };
  }
}

async function saveFollows(env: FollowsEnv, cid: string, entities: string[]): Promise<FollowRecord> {
  const rec: FollowRecord = { entities, updatedAt: Date.now() };
  await env.ENTITIES.put(K.follow(cid), JSON.stringify(rec));
  return rec;
}

/**
 * Devuelve la entidad viva detras de un slug, siguiendo `mergedInto`. Es lo que
 * convierte "seguir a Freerange" en "seguir a la entidad en la que Freerange se
 * fusiono" sin que el cliente se entere de nada.
 */
async function liveEntity(env: FollowsEnv, slug: string, saltos = 5): Promise<EntityRecord | null> {
  let e = await getEntity(env as any, slug);
  while (e && e.status === 'merged' && e.mergedInto && saltos-- > 0) {
    e = await getEntity(env as any, e.mergedInto);
  }
  return e && e.status !== 'merged' ? e : null;
}

export interface FollowView {
  slug: string;
  display: string;
  roles: string[];
  parent?: string;
}

/**
 * Lista hidratada. De paso limpia: un slug que ya no existe se cae, y uno que se
 * fusiono se reescribe al vivo. Se guarda solo si algo cambio, para no tocar KV
 * en cada lectura.
 */
export async function listFollows(env: FollowsEnv, cid: string): Promise<{ entities: FollowView[] }> {
  const rec = await loadFollows(env, cid);
  const out: FollowView[] = [];
  const vivos: string[] = [];
  let cambio = false;

  for (const slug of rec.entities) {
    const e = await liveEntity(env, slug);
    if (!e) { cambio = true; continue; }
    if (e.slug !== slug) cambio = true;
    if (vivos.includes(e.slug)) { cambio = true; continue; }
    vivos.push(e.slug);
    out.push({ slug: e.slug, display: e.display, roles: e.roles, ...(e.parent ? { parent: e.parent } : {}) });
  }

  if (cambio) await saveFollows(env, cid, vivos);
  return { entities: out };
}

export interface FollowChange {
  ok: true;
  slug: string;
  changed: boolean;      // false = ya estaba asi; la llamada es idempotente
  entities: string[];
}

/**
 * Alta. El orden importa: **el blob primero, el fanout despues**. Si falla lo
 * segundo, el cliente ve su follow —que es lo que el nota— y el fanout se puede
 * reconstruir desde los blobs. Al reves se notificaria a alguien que no ve el
 * follow en su lista.
 */
export async function addFollow(
  env: FollowsEnv, cid: string, slugRaw: string,
): Promise<FollowChange | { error: string; status: number }> {
  const slug = String(slugRaw || '').trim();
  if (!slug) return { error: 'slug required', status: 400 };

  const e = await liveEntity(env, slug);
  if (!e) return { error: `unknown entity ${slug}`, status: 400 };

  const rec = await loadFollows(env, cid);
  if (rec.entities.includes(e.slug)) {
    // Idempotente: repetir un alta no es un error, y el fanout se reafirma por
    // si la primera vez se quedo a medias.
    await env.ENTITIES.put(K.fanout(e.slug, cid), '1');
    return { ok: true, slug: e.slug, changed: false, entities: rec.entities };
  }
  if (rec.entities.length >= MAX_FOLLOWS) return { error: `too many follows (max ${MAX_FOLLOWS})`, status: 400 };

  const entities = [...rec.entities, e.slug];
  await saveFollows(env, cid, entities);
  await env.ENTITIES.put(K.fanout(e.slug, cid), '1');
  return { ok: true, slug: e.slug, changed: true, entities };
}

/**
 * Baja. Aqui el orden se invierte: **el fanout primero**. Lo grave al darse de
 * baja es seguir recibiendo avisos.
 *
 * No valida que la entidad exista: si desaparecio, con mas razon hay que poder
 * quitarsela de encima.
 */
export async function removeFollow(
  env: FollowsEnv, cid: string, slugRaw: string,
): Promise<FollowChange | { error: string; status: number }> {
  const slug = String(slugRaw || '').trim();
  if (!slug) return { error: 'slug required', status: 400 };

  const e = await liveEntity(env, slug);
  const objetivo = e?.slug || slug;

  await env.ENTITIES.delete(K.fanout(objetivo, cid));
  if (objetivo !== slug) await env.ENTITIES.delete(K.fanout(slug, cid));

  const rec = await loadFollows(env, cid);
  const entities = rec.entities.filter(s => s !== objetivo && s !== slug);
  const changed = entities.length !== rec.entities.length;
  if (changed) await saveFollows(env, cid, entities);
  return { ok: true, slug: objetivo, changed, entities };
}

/**
 * Funde la lista de invitado con la de la cuenta al entrar. Calco de
 * `wishlist-merge`: lo que hay gana, lo que llega se suma, y lo que no resuelve
 * se descarta diciendolo en vez de tragarselo.
 */
export async function mergeFollows(
  env: FollowsEnv, cid: string, incoming: string[],
): Promise<{ ok: true; entities: string[]; added: string[]; skipped: string[] }> {
  const rec = await loadFollows(env, cid);
  const entities = [...rec.entities];
  const added: string[] = [], skipped: string[] = [];

  for (const raw of (incoming || []).slice(0, MAX_FOLLOWS)) {
    const e = await liveEntity(env, String(raw || '').trim());
    if (!e) { skipped.push(String(raw)); continue; }
    if (entities.includes(e.slug)) continue;
    if (entities.length >= MAX_FOLLOWS) { skipped.push(String(raw)); continue; }
    entities.push(e.slug);
    added.push(e.slug);
  }

  if (added.length) {
    await saveFollows(env, cid, entities);
    for (const slug of added) await env.ENTITIES.put(K.fanout(slug, cid), '1');
  }
  return { ok: true, entities, added, skipped };
}

// ── INDICE DEL CATALOGO ─────────────────────────────────────────────

export interface IndexedProduct {
  id: string;              // gid de Shopify — es por donde casan los pedidos
  handle: string;          // handle de Shopify: NO es lo que llevan los enlaces
  slug: string;            // el slug del sitio, artista-titulo: esto si
  title: string;
  vendor: string;
  createdAt: string;
  forthcoming: boolean;
  releaseDate: string;
  imageUrl: string;
  price: string;
  currency: string;
  stock: number;
  artistSlugs: string[];
  labelSlugs: string[];
}

interface CatalogIndex {
  builtAt: number;
  items: IndexedProduct[];
}

const INDEX_QUERY = `
  query feedIndex($cursor: String) {
    products(first: 250, after: $cursor, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title vendor createdAt tags
        featuredImage { url }
        artist: metafield(namespace: "houseonly", key: "artist_slugs") { value }
        label: metafield(namespace: "houseonly", key: "label_slugs") { value }
        variants(first: 1) { nodes { sku quantityAvailable price { amount currencyCode } } }
      }
    }
  }
`;

function tagValue(tags: string[], prefix: RegExp): string {
  for (const t of tags || []) {
    const m = String(t).match(prefix);
    if (m && m[1]?.trim()) return m[1].trim();
  }
  return '';
}

/**
 * Trae el catalogo activo por Storefront API. La Storefront solo sirve lo
 * publicado, asi que "activo" y "lo que ve el cliente" son aqui la misma cosa —
 * y coincide con `status:active` de la Admin API, 1276 productos medidos.
 */
async function fetchCatalogue(env: FollowsEnv): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 12; page++) {
    const r = await fetch(`https://${SHOPIFY_DOMAIN}/api/${SF_API}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': env.STOREFRONT_TOKEN },
      body: JSON.stringify({ query: INDEX_QUERY, variables: { cursor } }),
    });
    if (!r.ok) throw new Error(`storefront HTTP ${r.status}`);
    const j: any = await r.json();
    if (j.errors) throw new Error(`storefront: ${JSON.stringify(j.errors).slice(0, 200)}`);
    out.push(...j.data.products.nodes);
    if (!j.data.products.pageInfo.hasNextPage) break;
    cursor = j.data.products.pageInfo.endCursor;
  }
  return out;
}

/**
 * Anota cada producto con sus slugs. Primero el metafield de la fase 4; si
 * falta, se resuelve `vendor` y el tag `label:` contra `alias:`. Asi el feed
 * funciona desde el primer dia, sin esperar a que el backfill haya pasado por
 * todo el catalogo, y se abarata solo segun se llenan los metafields.
 */
export async function annotate(env: FollowsEnv, nodes: any[]): Promise<IndexedProduct[]> {
  const cache = new Map<string, string[]>();

  const viaAlias = async (kind: 'a' | 'l', raw: string): Promise<string[]> => {
    const norm = normalizeName(raw);
    if (!norm) return [];
    const key = `alias:${kind}:${norm}`;
    if (cache.has(key)) return cache.get(key)!;
    const hit = await env.ENTITIES.get(key);
    const slugs = hit ? hit.split(',').map(s => s.trim()).filter(Boolean) : [];
    cache.set(key, slugs);
    return slugs;
  };

  const out: IndexedProduct[] = [];
  for (const n of nodes) {
    const tags: string[] = n.tags || [];
    const vendor = String(n.vendor || '').trim();
    const label = tagValue(tags, /^\s*label\s*:\s*(.+)$/i);

    let artistSlugs = parseSlugs(n.artist?.value);
    if (!artistSlugs.length && vendor) artistSlugs = await viaAlias('a', vendor);
    let labelSlugs = parseSlugs(n.label?.value);
    if (!labelSlugs.length && label) labelSlugs = await viaAlias('l', label);

    const v = n.variants?.nodes?.[0];

    out.push({
      id: n.id || '',
      handle: n.handle,
      slug: makeReleaseSlug(vendor, n.title, v?.sku || n.handle),
      title: n.title,
      vendor,
      createdAt: n.createdAt,
      forthcoming: tags.some(t => String(t).toLowerCase() === 'forthcoming'),
      releaseDate: tagValue(tags, /^\s*release\s*:\s*(.+)$/i),
      imageUrl: n.featuredImage?.url || '',
      price: v?.price?.amount || '',
      currency: v?.price?.currencyCode || '',
      stock: Number(v?.quantityAvailable ?? 0),
      artistSlugs,
      labelSlugs,
    });
  }
  return out;
}

/** El indice, del cache si esta fresco. Todos los seguidores miran el mismo. */
export async function getCatalogIndex(env: FollowsEnv, now = Date.now()): Promise<CatalogIndex> {
  const raw = await env.ENTITIES.get(K.index);
  if (raw) {
    try {
      const idx = JSON.parse(raw) as CatalogIndex;
      if (idx.builtAt && now - idx.builtAt < INDEX_TTL_MS && Array.isArray(idx.items)) return idx;
    } catch { /* se reconstruye */ }
  }
  const idx: CatalogIndex = { builtAt: now, items: await annotate(env, await fetchCatalogue(env)) };
  await env.ENTITIES.put(K.index, JSON.stringify(idx));
  return idx;
}

// ── FEED ────────────────────────────────────────────────────────────

export interface FeedItem extends IndexedProduct {
  via: string[];
}

/**
 * Expande hacia ABAJO: seguir a `chiwax` incluye `chiwax classic edition`. Es el
 * espejo de la expansion hacia arriba que usaran las notificaciones, y el motivo
 * de que el indice `children:` exista.
 */
export async function expandDown(env: FollowsEnv, slugs: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();   // slug efectivo → entidad seguida que lo trajo
  for (const s of slugs) {
    map.set(s, s);
    const hijos = await env.ENTITIES.list({ prefix: K.children(s) });
    for (const k of hijos.keys) {
      const hijo = k.name.slice(K.children(s).length);
      if (hijo && !map.has(hijo)) map.set(hijo, s);
    }
  }
  return map;
}

export function clampDays(raw: any): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return FEED_DAYS_DEFAULT;
  return Math.min(n, FEED_DAYS_MAX);
}

export function clampLimit(raw: any): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return FEED_LIMIT_DEFAULT;
  return Math.min(n, FEED_LIMIT_MAX);
}

/**
 * Corta la lista por el cursor. El cursor es `createdAt|handle` del ultimo
 * devuelto: es estable aunque entren productos nuevos mientras se pagina, cosa
 * que un offset no aguanta.
 */
export function afterCursor(items: FeedItem[], cursor: string): FeedItem[] {
  if (!cursor) return items;
  const i = items.findIndex(x => `${x.createdAt}|${x.handle}` === cursor);
  return i < 0 ? items : items.slice(i + 1);
}

export interface FeedResult {
  items: FeedItem[];
  cursor: string | null;
  window: { days: number; from: string };
  following: number;
}

export async function buildFeed(
  env: FollowsEnv,
  cid: string,
  opts: { days?: any; limit?: any; cursor?: string } = {},
  now = Date.now(),
): Promise<FeedResult> {
  const days = clampDays(opts.days);
  const limit = clampLimit(opts.limit);
  const desde = now - days * 24 * 60 * 60 * 1000;
  const from = new Date(desde).toISOString();

  const { entities } = await loadFollows(env, cid);
  if (!entities.length) {
    // Cuerpo vacio honesto, no la portada disfrazada de feed.
    return { items: [], cursor: null, window: { days, from }, following: 0 };
  }

  const efectivos = await expandDown(env, entities);
  const idx = await getCatalogIndex(env, now);

  const hits: FeedItem[] = [];
  for (const p of idx.items) {
    if (Date.parse(p.createdAt) < desde) continue;
    const via = new Set<string>();
    for (const s of [...p.artistSlugs, ...p.labelSlugs]) {
      const origen = efectivos.get(s);
      if (origen) via.add(origen);
    }
    if (via.size) hits.push({ ...p, via: [...via] });
  }

  hits.sort((a, b) => (Date.parse(b.createdAt) - Date.parse(a.createdAt)) || a.handle.localeCompare(b.handle));

  const page = afterCursor(hits, String(opts.cursor || '')).slice(0, limit);
  const last = page[page.length - 1];
  const quedan = afterCursor(hits, String(opts.cursor || '')).length > page.length;

  return {
    items: page,
    cursor: quedan && last ? `${last.createdAt}|${last.handle}` : null,
    window: { days, from },
    following: entities.length,
  };
}

// ── FICHA PUBLICA DE ENTIDAD ────────────────────────────────────────

export interface EntityPage {
  slug: string;
  display: string;
  roles: string[];
  aliases: string[];
  parent?: string;
  children: string[];
  products: IndexedProduct[];
  total: number;
}

/**
 * Para la ficha de artista o sello. Sin ventana: aqui se quiere TODO lo que hay
 * vivo de esa entidad, que es justo lo contrario que el feed.
 */
export async function entityPage(
  env: FollowsEnv, slugRaw: string, opts: { limit?: any } = {},
): Promise<EntityPage | null> {
  const e = await liveEntity(env, String(slugRaw || '').trim());
  if (!e) return null;

  const efectivos = await expandDown(env, [e.slug]);
  const idx = await getCatalogIndex(env);
  const todos = idx.items.filter(p =>
    [...p.artistSlugs, ...p.labelSlugs].some(s => efectivos.has(s)));
  todos.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const limit = clampLimit(opts.limit ?? FEED_LIMIT_MAX);
  return {
    slug: e.slug,
    display: e.display,
    roles: e.roles,
    aliases: e.aliases || [],
    ...(e.parent ? { parent: e.parent } : {}),
    children: [...efectivos.keys()].filter(s => s !== e.slug),
    products: todos.slice(0, limit),
    total: todos.length,
  };
}

// ── HOME DEL PORTAL ─────────────────────────────────────────────────

export interface Shelf {
  slug: string;
  display: string;
  roles: string[];
  total: number;                 // discos activos de la entidad
  owned: number;                 // de esos, cuantos ya tiene el cliente
  newest: string;                // fecha del mas reciente — ordena las estanterias
  items: Array<IndexedProduct & { owned: boolean }>;
}

export interface Suggestion {
  slug: string;
  display: string;
  roles: string[];
  total: number;
  from: 'wishlist' | 'orders';
  /** La portada del disco que justifica la sugerencia: por que sale esta y no otra. */
  coverUrl: string;
  coverTitle: string;
}

export interface AccountHome {
  following: Array<{ slug: string; display: string; roles: string[]; total: number; owned: number }>;
  shelves: Shelf[];
  suggestions: Suggestion[];
}

/** Cuantos discos por estanteria como mucho. Mas que eso no lo desliza nadie. */
export const SHELF_MAX = 40;

/**
 * Tope de sugerencias. Alto a proposito: se quieren TODAS las entidades de la
 * wishlist y de las compras, no una seleccion. El tope existe solo para que una
 * cuenta con cientos de pedidos no devuelva una lista infinita.
 */
export const MAX_SUGGESTIONS = 60;

/**
 * Todo lo que la home del portal necesita, en UNA llamada. En el movil, tres
 * peticiones encadenadas para pintar una pantalla se notan; esta no.
 *
 * `ownedIds` son los gid de producto que el cliente ya ha comprado, que index.ts
 * saca de la Customer Account API. Aqui solo se cruzan.
 */
export async function accountHome(
  env: FollowsEnv,
  cid: string,
  ownedIds: string[],
  wishlistRaws: Array<{ artist?: string; label?: string; handle?: string }> = [],
): Promise<AccountHome> {
  const owned = new Set((ownedIds || []).filter(Boolean));
  const idx = await getCatalogIndex(env);
  const { entities } = await listFollows(env, cid);

  // ── estanterias ──
  const shelves: Shelf[] = [];
  for (const e of entities) {
    const efectivos = await expandDown(env, [e.slug]);
    const suyos = idx.items
      .filter(p => [...p.artistSlugs, ...p.labelSlugs].some(s => efectivos.has(s)))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    shelves.push({
      slug: e.slug, display: e.display, roles: e.roles,
      total: suyos.length,
      owned: suyos.filter(p => owned.has(p.id)).length,
      newest: suyos[0]?.createdAt || '',
      items: suyos.slice(0, SHELF_MAX).map(p => ({ ...p, owned: owned.has(p.id) })),
    });
  }
  // Primero la entidad que ha sacado algo hace menos: es lo que trae a alguien
  // de vuelta al portal.
  shelves.sort((a, b) => (Date.parse(b.newest) || 0) - (Date.parse(a.newest) || 0));

  // ── sugerencias para el estado vacio ──
  const yaSeguidas = new Set(entities.map(e => e.slug));
  const sug = new Map<string, Suggestion>();
  // La wishlist guarda el SLUG DEL SITIO en su campo `handle` —lo que va en la
  // URL—, no el handle de Shopify. Se indexa por los dos para que la portada sea
  // la del disco guardado y no una cualquiera de la entidad.
  const porClave = new Map<string, IndexedProduct>();
  for (const p of idx.items) { porClave.set(p.handle, p); porClave.set(p.slug, p); }

  /**
   * `justifica` es el disco por el que aparece esta sugerencia: de el sale la
   * portada. Sin ella, la lista es una tabla de nombres sueltos y nadie se
   * acuerda de por que esta ahi Frank Music.
   */
  const proponer = async (slug: string, from: 'wishlist' | 'orders', justifica?: IndexedProduct) => {
    if (!slug || yaSeguidas.has(slug) || sug.has(slug)) return;
    if (sug.size >= MAX_SUGGESTIONS) return;
    const ent = await liveEntity(env, slug);
    if (!ent) return;
    const suyos = idx.items.filter(p => [...p.artistSlugs, ...p.labelSlugs].includes(ent.slug));
    const cover = justifica || suyos[0];
    sug.set(ent.slug, {
      slug: ent.slug, display: ent.display, roles: ent.roles, total: suyos.length, from,
      coverUrl: cover?.imageUrl || '', coverTitle: cover?.title || '',
    });
  };

  // De la wishlist, TODAS: el texto guardado se resuelve como lo resolveria el
  // importer, y la portada sale del disco guardado, no de uno cualquiera de la
  // entidad.
  for (const it of wishlistRaws) {
    const suyo = it?.handle ? porClave.get(it.handle) : undefined;
    for (const [kind, raw] of [['a', it?.artist], ['l', it?.label]] as const) {
      const norm = normalizeName(String(raw || ''));
      if (!norm) continue;
      const hit = await env.ENTITIES.get(`alias:${kind}:${norm}`);
      for (const slug of (hit || '').split(',').map(s => s.trim()).filter(Boolean)) {
        await proponer(slug, 'wishlist', suyo);
      }
    }
  }

  // De los pedidos: lo que ya compro dice mas que lo que guardo para luego. La
  // portada es la del disco comprado.
  const comprados = idx.items.filter(p => owned.has(p.id));
  const frecuencia = new Map<string, { n: number; cover: IndexedProduct }>();
  for (const p of comprados) {
    for (const s of [...p.artistSlugs, ...p.labelSlugs]) {
      const prev = frecuencia.get(s);
      frecuencia.set(s, { n: (prev?.n || 0) + 1, cover: prev?.cover || p });
    }
  }
  for (const [slug, v] of [...frecuencia.entries()].sort((a, b) => b[1].n - a[1].n)) {
    await proponer(slug, 'orders', v.cover);
  }

  return {
    following: shelves.map(s => ({ slug: s.slug, display: s.display, roles: s.roles, total: s.total, owned: s.owned })),
    shelves,
    suggestions: [...sug.values()],
  };
}

/**
 * Resuelve un nombre crudo —el vendor o el tag `label:` de un producto— a las
 * entidades que le corresponden. SOLO LEE: a diferencia de `entity-resolve`, no
 * encola nada en revision, porque esto lo llama la tienda en cada ficha de
 * producto y la cola es cosa del admin.
 */
export async function lookupPublic(
  env: FollowsEnv, kind: 'artist' | 'label', raw: string,
): Promise<Array<{ slug: string; display: string; roles: string[] }>> {
  const k = kind === 'artist' ? 'a' : 'l';
  const limpio = String(raw || '').trim();
  if (!limpio) return [];

  // Mismo orden que el resolver: exacto, normalizado, y nada mas. Sin
  // distancia de edicion ni troceo: aqui no se adivina.
  //
  // Los dos intentos se prueban hasta dar con uno que lleve a una entidad VIVA.
  // Un alias que apunta a una entidad borrada existe —devuelve valor— pero no
  // resuelve a nada, y quedarse en el primer acierto dejaba la ficha sin enlace
  // ni boton en silencio. Paso de verdad: al renombrar una entidad a mano se
  // repunto el alias normalizado y se olvido el crudo.
  for (const clave of [`alias:${k}:${limpio}`, `alias:${k}:${normalizeName(limpio)}`]) {
    const hit = await env.ENTITIES.get(clave);
    if (!hit) continue;
    const out: Array<{ slug: string; display: string; roles: string[] }> = [];
    for (const slug of hit.split(',').map(x => x.trim()).filter(Boolean)) {
      const e = await liveEntity(env, slug);
      if (e) out.push({ slug: e.slug, display: e.display, roles: e.roles });
    }
    if (out.length) return out;
  }
  return [];
}

/**
 * Todas las entidades que tienen algo vivo en la tienda, con su display y su
 * cuenta. Publico y pequeño: lo usa el prerender para generar una pagina por
 * entidad, y de paso sirve para el sitemap.
 *
 * Se calcula del indice cacheado, asi que no cuesta mas que una lectura de KV.
 */
export async function entityIndex(env: FollowsEnv, now = Date.now()): Promise<Array<{
  slug: string; display: string; roles: string[]; total: number;
}>> {
  const raw = await env.ENTITIES.get(K.entityIndex);
  if (raw) {
    try {
      const c = JSON.parse(raw);
      if (c?.builtAt && now - c.builtAt < INDEX_TTL_MS && Array.isArray(c.items)) return c.items;
    } catch { /* se reconstruye */ }
  }

  const idx = await getCatalogIndex(env, now);
  const cuenta = new Map<string, number>();
  for (const p of idx.items) {
    for (const s of new Set([...p.artistSlugs, ...p.labelSlugs])) cuenta.set(s, (cuenta.get(s) || 0) + 1);
  }

  // En lotes y en paralelo. De una en una son ~1500 lecturas encadenadas y la
  // llamada se va por encima de los veinte segundos: el prerender la abortaba.
  const slugs = [...cuenta.keys()];
  const out: Array<{ slug: string; display: string; roles: string[]; total: number }> = [];
  const LOTE = 50;
  for (let i = 0; i < slugs.length; i += LOTE) {
    const recs = await Promise.all(slugs.slice(i, i + LOTE).map(s => getEntity(env as any, s)));
    for (const e of recs) {
      if (!e || e.status === 'merged') continue;
      out.push({ slug: e.slug, display: e.display, roles: e.roles, total: cuenta.get(e.slug) || 0 });
    }
  }
  out.sort((a, b) => b.total - a.total);
  await env.ENTITIES.put(K.entityIndex, JSON.stringify({ builtAt: now, items: out }));
  return out;
}
