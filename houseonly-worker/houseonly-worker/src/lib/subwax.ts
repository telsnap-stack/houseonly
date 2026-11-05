// ── SUBWAX PLAYER ────────────────────────────────────────────────
// Stocklist de Subwax Distribution (Barcelona) para la pagina /subwax/ del
// frontend: escuchar los discos y armar el Order Form / Pre-order Form.
//
// Fuente de verdad del inventario: la Google Sheet publica de Subwax
// (goo.gl/aDeGd8 → SUBWAX_SHEET_ID), la misma que enlazan sus correos
// semanales. Se baja como xlsx (export?format=xlsx, sin sesion) porque es el
// unico formato que conserva las formulas HYPERLINK de la columna LISTEN; el
// CSV y el gviz devuelven solo el rotulo. Dos hojas: STOCKLIST (secciones
// NEW ARRIVALS y BACK CATALOGUE) y PRE-ORDERS.
//
// Audio: casi todos los enlaces son SoundCloud privados (…/s-TOKEN). El widget
// de SoundCloud no los acepta por URL; hay que pasarle el id interno
// (api.soundcloud.com/tracks/ID?secret_token=s-…), que se saca del oembed
// publico (soundcloud.com/oembed). Se resuelve por tandas (RESOLVE_POR_PASADA
// por llamada, para no agotar las subpeticiones) y se guarda para siempre.
//
// Tienda: cada catno se cruza con el SKU de Shopify (searchVariantsBySkus) para
// que el player diga "en tienda · stock N" y no se pida dos veces.
//
// Pedidos: cada Order Form / Pre-order Form que se descarga desde el player se
// anota aqui (subwax:orders) con sus lineas; el player suma por catno lo ya
// pedido. Estado: draft → sent → received (lo cambia Eduardo a mano).
//
// KV (SYNC_STATE, asi staging y prod no se mezclan):
//   subwax:stock   { updated_at, rows[], gone[] }
//   subwax:orders  Order[]
//   subwax:last_refresh  resumen de la ultima pasada (ok/error)
import { unzipSync } from 'fflate';
import { searchVariantsBySkus, type ShopifyAdminEnv } from './shopify-admin';

export const SUBWAX_SHEET_ID = '1SxRUuuJibwRtYKLv7-TrgK72LojMjSe0yNmOHIpi9Q4';
export const SUBWAX_SHEET_XLSX = `https://docs.google.com/spreadsheets/d/${SUBWAX_SHEET_ID}/export?format=xlsx`;
const STOCK_KEY = 'subwax:stock';
const ORDERS_KEY = 'subwax:orders';
const LAST_KEY = 'subwax:last_refresh';
export const RESOLVE_POR_PASADA = 30;
const GONE_DIAS = 90;

export interface SubwaxEnv extends ShopifyAdminEnv {
  SYNC_STATE: KVNamespace;
}

export interface SubwaxRow {
  cat: string;
  label: string;
  artist: string;
  title: string;
  format: string;
  price: number;
  section: 'NEW ARRIVALS' | 'BACK CATALOGUE' | 'PRE ORDERS' | string;
  listen: string | null;   // enlace tal cual viene en la hoja
  embed: string | null;    // api.soundcloud.com/… para el widget
  embed_error?: string;    // por que no se pudo resolver (404, no-soundcloud…)
  first_seen: string;      // ISO, primera pasada en que aparecio
  shop?: { sku: string; qty: number | null; status: string; title: string } | null;
}

export interface SubwaxStock {
  updated_at: string;
  rows: SubwaxRow[];
  gone: (SubwaxRow & { gone_at: string })[];
}

export interface SubwaxOrderLine { cat: string; qty: number; label: string; artist: string; title: string; price: number }
export interface SubwaxOrder {
  id: string;
  at: string;             // ISO de creacion
  date: string;           // la fecha que lleva el formulario (dd/mm/aaaa)
  kind: 'order' | 'preorder';
  client: string;
  lines: SubwaxOrderLine[];
  total: number;
  status: 'draft' | 'sent' | 'received' | 'cancelled';
  note?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*, Authorization',
    },
  });
}

// ── XLSX ────────────────────────────────────────────────────────
const XML_ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function desentidad(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENT[e.toLowerCase()] ?? m;
  });
}
const textoDe = (xml: string) => desentidad((xml.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<t[^>]*>|<\/t>/g, '')).join(''));

export interface Celda { col: string; row: number; value: string | number | null; href: string | null }

/** Lee las hojas de un xlsx (export de Google Sheets) a celdas sueltas, con el URL de HYPERLINK si lo hay. */
export function leeXlsx(buf: Uint8Array): { name: string; cells: Celda[] }[] {
  const z = unzipSync(buf);
  const dec = new TextDecoder();
  const leer = (n: string) => (z[n] ? dec.decode(z[n]) : '');
  const sst = (leer('xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) || []).map(textoDe);
  const wb = leer('xl/workbook.xml');
  const rels = leer('xl/_rels/workbook.xml.rels');
  const hojas: { name: string; cells: Celda[] }[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]*)"/g)) {
    const rel = rels.match(new RegExp(`<Relationship\\b[^>]*\\bId="${m[2]}"[^>]*\\bTarget="([^"]*)"`)) || rels.match(new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]*)"[^>]*\\bId="${m[2]}"`));
    if (!rel) continue;
    const target = rel[1].replace(/^\/?(xl\/)?/, 'xl/');
    const xml = leer(target);
    const cells: Celda[] = [];
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], inner = c[2] || '';
      const r = attrs.match(/\br="([A-Z]+)(\d+)"/);
      if (!r) continue;
      const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
      const f = inner.match(/<f[^>]*>([\s\S]*?)<\/f>/);
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      let value: string | number | null = null;
      if (t === 's') value = sst[Number(v?.[1])] ?? null;
      else if (t === 'inlineStr') value = textoDe(inner);
      else if (t === 'str' || t === 'e') value = v ? desentidad(v[1]) : null;
      else if (t === 'b') value = v ? Number(v[1]) : null;
      else value = v ? Number(v[1]) : null;
      let href: string | null = null;
      if (f) {
        const h = desentidad(f[1]).match(/HYPERLINK\(\s*"([^"]+)"/i);
        if (h) href = h[1];
      }
      cells.push({ col: r[1], row: Number(r[2]), value, href });
    }
    hojas.push({ name: desentidad(m[1]), cells });
  }
  return hojas;
}

/** De las celdas de la stocklist a filas de disco, con su seccion. Misma logica que el primer player. */
export function parseStocklist(hojas: { name: string; cells: Celda[] }[]): Omit<SubwaxRow, 'embed' | 'first_seen'>[] {
  const out: Omit<SubwaxRow, 'embed' | 'first_seen'>[] = [];
  for (const h of hojas) {
    const porFila = new Map<number, Record<string, Celda>>();
    for (const c of h.cells) {
      if (c.value === null || c.value === '') continue;
      if (!porFila.has(c.row)) porFila.set(c.row, {});
      porFila.get(c.row)![c.col] = c;
    }
    let section = /pre/i.test(h.name) ? 'PRE ORDERS' : '';
    for (const row of [...porFila.keys()].sort((a, b) => a - b)) {
      const v = porFila.get(row)!;
      const s = (k: string) => (v[k] ? String(v[k].value).trim() : '');
      if (s('B') === 'LABEL') continue;
      const price = v.I?.value;
      if (v.C && v.E && typeof price === 'number') {
        const g = v.G;
        const listen = g?.href || (typeof g?.value === 'string' && /^https?:\/\//.test(g.value) ? g.value.trim() : null);
        out.push({ cat: s('C'), label: s('B'), artist: s('D'), title: s('E'), format: s('F'), price, section, listen });
        continue;
      }
      const keys = Object.keys(v);
      if (keys.length <= 2 && !v.I && keys.some((k) => 'ABCDE'.includes(k))) {
        const first = v[keys[0]];
        if (typeof first.value === 'string' && /^[A-Z &-]{4,}$/.test(first.value.trim()) && !/^https?:/.test(first.value)) section = first.value.trim();
      }
    }
  }
  return out;
}

// ── SOUNDCLOUD ──────────────────────────────────────────────────
const SC = /^https?:\/\/(www\.|m\.)?soundcloud\.com\//i;

/** URL que acepta el widget: api.soundcloud.com/tracks|playlists/ID[?secret_token=s-…]. */
export async function resuelveSoundcloud(listen: string, fetcher: typeof fetch = fetch): Promise<{ embed: string | null; error?: string }> {
  if (!SC.test(listen)) return { embed: null, error: 'no-soundcloud' };
  const limpio = listen.split('?')[0].split('#')[0].replace(/\/$/, '');
  const r = await fetcher(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(limpio)}`, {
    headers: { 'User-Agent': 'houseonly-worker (subwax player)' },
  });
  if (!r.ok) return { embed: null, error: `oembed ${r.status}` };
  const j: any = await r.json().catch(() => null);
  const src = String(j?.html || '').match(/src="([^"]+)"/)?.[1];
  if (!src) return { embed: null, error: 'oembed sin html' };
  const d = desentidad(src);
  const api = decodeURIComponent((d.match(/[?&]url=([^&]+)/) || [])[1] || '');
  const m = api.match(/api\.soundcloud\.com\/(tracks|playlists)\/(\d+)/);
  if (!m) return { embed: null, error: 'oembed sin id' };
  const tok = (d.match(/[?&]secret_token=([^&]+)/) || limpio.match(/\/(s-[A-Za-z0-9]+)$/) || [])[1];
  return { embed: `https://api.soundcloud.com/${m[1]}/${m[2]}${tok ? `?secret_token=${tok}` : ''}` };
}

// ── REFRESH ─────────────────────────────────────────────────────
export const normSku = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function leeStock(env: SubwaxEnv): Promise<SubwaxStock | null> {
  return JSON.parse((await env.SYNC_STATE.get(STOCK_KEY)) || 'null');
}

export interface RefreshOpts { fetcher?: typeof fetch; now?: Date; maxResolve?: number; shopify?: boolean; minRows?: number }

export async function refreshSubwax(env: SubwaxEnv, opts: RefreshOpts = {}) {
  const fetcher = opts.fetcher || fetch;
  const ahora = (opts.now || new Date()).toISOString();
  const prev = (await leeStock(env)) || { updated_at: '', rows: [], gone: [] };
  const prevByCat = new Map(prev.rows.map((r) => [r.cat, r]));
  const prevByListen = new Map<string, SubwaxRow>();
  for (const r of [...prev.rows, ...prev.gone]) if (r.listen && r.embed) prevByListen.set(r.listen.split('?')[0], r);

  const res = await fetcher(SUBWAX_SHEET_XLSX, { headers: { 'User-Agent': 'houseonly-worker (subwax player)' } });
  if (!res.ok) throw new Error(`stocklist ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!/spreadsheetml|octet-stream|zip/i.test(ct)) throw new Error(`stocklist content-type ${ct || 'vacio'} (¿la hoja ya no es publica?)`);
  const filas = parseStocklist(leeXlsx(new Uint8Array(await res.arrayBuffer())));
  const minRows = opts.minRows ?? 20;   // una hoja medio vacia o rota no pisa la buena
  if (filas.length < minRows) throw new Error(`stocklist con solo ${filas.length} filas: no se guarda`);

  const rows: SubwaxRow[] = [];
  const vistos = new Set<string>();
  let nuevos = 0;
  for (const f of filas) {
    if (vistos.has(f.cat)) continue;   // una referencia puede repetirse entre hojas
    vistos.add(f.cat);
    const p = prevByCat.get(f.cat) || prev.gone.find((g) => g.cat === f.cat);
    const mismaEscucha = p?.listen && f.listen && p.listen.split('?')[0] === f.listen.split('?')[0];
    const heredado = f.listen ? prevByListen.get(f.listen.split('?')[0]) : undefined;
    if (!p) nuevos++;
    rows.push({
      ...f,
      embed: mismaEscucha ? p!.embed : heredado?.embed ?? null,
      embed_error: mismaEscucha ? p!.embed_error : undefined,
      first_seen: p?.first_seen || ahora,
      shop: p?.shop ?? null,
    });
  }
  // Agotados: lo que estaba y ya no esta. Se conservan GONE_DIAS.
  const limite = Date.now() - GONE_DIAS * 86400e3;
  const gone = [
    ...prev.rows.filter((r) => !vistos.has(r.cat)).map((r) => ({ ...r, gone_at: ahora })),
    ...prev.gone.filter((g) => !vistos.has(g.cat) && Date.parse(g.gone_at) > limite),
  ];

  // SoundCloud, por tandas.
  let resueltos = 0, fallidos = 0;
  const max = opts.maxResolve ?? RESOLVE_POR_PASADA;
  for (const r of rows) {
    if (resueltos + fallidos >= max) break;
    if (!r.listen || r.embed || r.embed_error) continue;
    try {
      const x = await resuelveSoundcloud(r.listen, fetcher);
      if (x.embed) { r.embed = x.embed; resueltos++; } else { r.embed_error = x.error; fallidos++; }
    } catch (e: any) { r.embed_error = e?.message || 'error'; fallidos++; }
  }
  const pendientes = rows.filter((r) => r.listen && !r.embed && !r.embed_error).length;

  // Tienda: SKU = catno (exacto o sin separadores).
  let shopMatched = 0, shopError: string | undefined;
  if (opts.shopify !== false) {
    try {
      const vars = await searchVariantsBySkus(env, rows.map((r) => r.cat));
      const porNorm = new Map<string, typeof vars[number]>();
      for (const v of vars) if (!porNorm.has(normSku(v.sku))) porNorm.set(normSku(v.sku), v);
      for (const r of rows) {
        const v = porNorm.get(normSku(r.cat));
        r.shop = v ? { sku: v.sku, qty: v.inventoryQuantity, status: v.status, title: v.title } : null;
        if (v) shopMatched++;
      }
    } catch (e: any) { shopError = e?.message || String(e); }
  }

  const stock: SubwaxStock = { updated_at: ahora, rows, gone };
  await env.SYNC_STATE.put(STOCK_KEY, JSON.stringify(stock));
  const resumen = { ok: true, at: ahora, rows: rows.length, nuevos, agotados: gone.filter((g) => g.gone_at === ahora).length, resueltos, fallidos, pendientes, shop_matched: shopMatched, shop_error: shopError };
  await env.SYNC_STATE.put(LAST_KEY, JSON.stringify(resumen));
  return resumen;
}

// ── HANDLERS ────────────────────────────────────────────────────
export async function handleSubwaxStock(env: SubwaxEnv, autorizado: boolean): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  const stock = await leeStock(env);
  const last = JSON.parse((await env.SYNC_STATE.get(LAST_KEY)) || 'null');
  const orders: SubwaxOrder[] = JSON.parse((await env.SYNC_STATE.get(ORDERS_KEY)) || '[]');
  return json({ stock, last_refresh: last, orders });
}

export async function handleSubwaxRefresh(request: Request, env: SubwaxEnv, autorizado: boolean): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  const u = new URL(request.url);
  const max = Math.max(0, Math.min(60, Number(u.searchParams.get('resolve') ?? RESOLVE_POR_PASADA)));
  try {
    return json(await refreshSubwax(env, { maxResolve: max }));
  } catch (e: any) {
    const err = { ok: false, at: new Date().toISOString(), error: e?.message || String(e) };
    await env.SYNC_STATE.put(LAST_KEY, JSON.stringify(err));
    return json(err, 502);
  }
}

export async function handleSubwaxOrder(request: Request, env: SubwaxEnv, autorizado: boolean): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const orders: SubwaxOrder[] = JSON.parse((await env.SYNC_STATE.get(ORDERS_KEY)) || '[]');
  const op = String(body?.op || '');
  if (op === 'add') {
    const kind = body.kind === 'preorder' ? 'preorder' : 'order';
    const stock = await leeStock(env);
    const porCat = new Map((stock?.rows || []).map((r) => [r.cat, r]));
    const lines: SubwaxOrderLine[] = [];
    for (const l of Array.isArray(body.lines) ? body.lines : []) {
      const cat = String(l?.cat || '').trim();
      const qty = Math.floor(Number(l?.qty));
      if (!cat || !(qty > 0)) continue;
      const r = porCat.get(cat);
      lines.push({
        cat, qty,
        label: String(l.label ?? r?.label ?? ''), artist: String(l.artist ?? r?.artist ?? ''), title: String(l.title ?? r?.title ?? ''),
        price: Number.isFinite(Number(l.price)) ? Number(l.price) : (r?.price ?? 0),
      });
    }
    if (!lines.length) return json({ error: 'sin lineas' }, 400);
    const total = Math.round(lines.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100;
    const order: SubwaxOrder = {
      id: `${kind === 'preorder' ? 'p' : 'o'}_${Date.now().toString(36)}`,
      at: new Date().toISOString(),
      date: String(body.date || '').slice(0, 20),
      kind, client: String(body.client || 'Telsnap S.L.').slice(0, 80),
      lines, total, status: 'draft',
      note: body.note ? String(body.note).slice(0, 300) : undefined,
    };
    orders.unshift(order);
    await env.SYNC_STATE.put(ORDERS_KEY, JSON.stringify(orders.slice(0, 500)));
    return json({ ok: true, order, orders });
  }
  const id = String(body?.id || '');
  const i = orders.findIndex((o) => o.id === id);
  if (i < 0) return json({ error: 'no existe' }, 404);
  if (op === 'status') {
    const st = String(body.status);
    if (!['draft', 'sent', 'received', 'cancelled'].includes(st)) return json({ error: 'estado' }, 400);
    orders[i].status = st as SubwaxOrder['status'];
    if (body.note !== undefined) orders[i].note = String(body.note).slice(0, 300) || undefined;
  } else if (op === 'delete') {
    orders.splice(i, 1);
  } else return json({ error: 'op' }, 400);
  await env.SYNC_STATE.put(ORDERS_KEY, JSON.stringify(orders));
  return json({ ok: true, orders });
}
