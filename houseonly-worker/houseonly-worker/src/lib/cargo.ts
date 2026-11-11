// ── CARGO PLAYER ─────────────────────────────────────────────────
// Stock report de Cargo Distribution (UK) para la pagina /cargo/ del frontend:
// escuchar los discos y armar el pedido. Mismo patron que el Subwax Player
// (src/lib/subwax.ts), con una diferencia de fondo: el report de Cargo no trae
// ni sello, ni genero, ni enlaces de audio. Todo eso se busca aqui, disco a
// disco, por EAN y catno:
//
//   1. Discogs (barcode → catno+titulo): sello completo, generos/estilos, ano,
//      portada y los videos de YouTube enlazados a la release.
//   2. Deezer (upc → busqueda) y Apple (upc → busqueda): previews de 30 s.
//   3. Bandcamp (busqueda → pagina de album → stream mp3-128): de cada pista se
//      guarda un tramo de ~90 s, no la pista entera (ver TRAMO_*).
//   4. Si nada de lo anterior tiene audio: los videos de YouTube de Discogs,
//      que la pagina reproduce embebidos.
//
// El audio se copia a R2 (houseonly-audio, publico por r2.dev) bajo cargo/: los
// previews de Deezer van firmados y caducan, y el stream de Bandcamp tambien.
// staging y prod comparten bucket y prefijo a proposito: es el mismo audio.
//
// La pagina sube el report (xlsx parseado en el navegador) con cargo-upload.
// Cada disco se resuelve al pulsarlo (cargo-audio) y, en segundo plano, el cron
// :41 hace PASADA_CRON discos por hora: primero los electronicos sin audio;
// del resto solo saca metadatos de Discogs, y si Discogs dice Electronic, en la
// pasada siguiente se le busca audio. Discogs comparte cupo (60/min) con el
// sync de la tienda: por eso las pasadas son pequenas.
//
// KV (SYNC_STATE, asi staging y prod no se mezclan):
//   cargo:stock      { updated_at, file, rows[], seen{ean: iso} }
//   cargo:a:<ean>    CargoAudio (resultado completo de un disco)
//   cargo:idx        { ean: [sello, generos, flag, electronicoSegunDiscogs] }
//   cargo:last       resumen de la ultima pasada
import { discogsFetch } from './discogs';

const STOCK_KEY = 'cargo:stock';
const IDX_KEY = 'cargo:idx';
const LAST_KEY = 'cargo:last';
const AKEY = (ean: string) => `cargo:a:${ean}`;
export const R2_PREFIX = 'cargo/';
export const PASADA_CRON = 6;
const MAX_PISTAS = 10;
const MAX_BYTES = 20 * 1024 * 1024;
// Bandcamp sirve la pista entera (5-10 MB). Se guarda solo un tramo: desde
// ~1:00 hasta ~2:30 a 128 kbps. Si la pista es mas corta (416), desde el
// principio. Un mp3 cortado en cualquier byte se reproduce: el decoder busca
// la siguiente cabecera de frame.
const TRAMO_DESDE = 960_000;
const TRAMO_BYTES = 1_440_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export interface CargoEnv {
  SYNC_STATE: KVNamespace;
  R2: R2Bucket;
  DISCOGS_TOKEN?: string;
}
type F = typeof fetch;

// Fila compacta, la misma que usa la pagina:
// [cat, artist, title, ean, fmt, discs, stock, price, date(yyyymmdd), status, electronico(0/1)]
export type CargoRow = [string, string, string, string, string, number, number, number, number, number, number];

export interface CargoStock { updated_at: string; file: string; rows: CargoRow[]; seen: Record<string, string> }
export interface CargoTrack { name: string; url?: string; yt?: string }
export type Fuente = 'deezer' | 'apple' | 'bandcamp' | 'youtube';
export interface CargoAudio {
  at: string;
  state: 'ok' | 'none' | 'meta';  // meta = solo metadatos (no electronico: no se busco audio)
  src?: Fuente;
  label?: string;
  genres?: string[];
  styles?: string[];
  year?: number;
  cover?: string;
  discogs?: number;
  album?: string;
  by?: string;
  page?: string;          // la ficha de donde sale el audio
  tracks: CargoTrack[];   // mp3 en R2
  yt: CargoTrack[];       // videos de YouTube (Discogs)
  tried: Record<string, string>;  // fuente → resultado ("ok", "sin coincidencia", "challenge", "429"…)
}
// sello, generos+estilos (cortos), flag (a=audio, y=solo youtube, n=nada, m=solo metadatos), electronico segun Discogs
export type IdxEntry = [string, string, 'a' | 'y' | 'n' | 'm', 0 | 1];

// ── comparacion de titulos ──────────────────────────────────────
export const norm = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/\b(feat|ft|featuring|presents|pres)\b.*$/, '').replace(/[([][^)\]]*[)\]]/g, ' ')
  .replace(/\b(lp|ep|vinyl|record|remastered|remaster|deluxe|edition|reissue|repress|limited|colou?red|2lp|3lp|12|7|the)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const toks = (s: string) => norm(s).split(' ').filter(Boolean);
export function overlap(a: string, b: string): number {
  const A = toks(a), B = new Set(toks(b));
  if (!A.length) return 0;
  return A.filter((x) => B.has(x)).length / A.length;
}
export const isVA = (artist: string) => /^(various|v\/?a\b|va\b)/i.test(String(artist || '').trim());
/** El mismo disco: titulo casi igual y (salvo VA) artista casi igual, en cualquiera de los dos sentidos. */
export function mismoDisco(art: string, tit: string, cArt: string, cTit: string): boolean {
  const ts = Math.max(overlap(tit, cTit), overlap(cTit, tit) * 0.9);
  if (ts < 0.6) return false;
  if (isVA(art)) return true;
  return Math.max(overlap(art, cArt), overlap(cArt, art)) >= 0.5;
}
const limpiaDiscogs = (n: string) => String(n || '').replace(/\s*\(\d+\)$/, '').replace(/\*$/, '').trim();
export const ytId = (u: string) => {
  const m = String(u || '').match(/[?&]v=([\w-]{11})/) || String(u || '').match(/youtu\.be\/([\w-]{11})/);
  return m ? m[1] : null;
};
const sinCeros = (ean: string) => String(ean || '').replace(/^0+/, '');
export const desentidad = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const quitaTags = (s: string) => desentidad(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// ── Discogs ─────────────────────────────────────────────────────
interface DgInfo { id: number; label: string; genres: string[]; styles: string[]; year?: number; cover?: string; artist: string; title: string; yt: CargoTrack[] }

async function dg(env: CargoEnv, path: string): Promise<any> {
  const r = await discogsFetch(env.DISCOGS_TOKEN || '', path);
  if (!r.ok) throw new Error(`discogs ${r.status}`);
  return r.json();
}
export async function viaDiscogs(env: CargoEnv, row: CargoRow): Promise<DgInfo | null> {
  if (!env.DISCOGS_TOKEN) throw new Error('sin DISCOGS_TOKEN');
  const [cat, artist, title, ean] = row;
  let cands: any[] = [];
  if (ean) cands = ((await dg(env, `/database/search?type=release&barcode=${encodeURIComponent(ean)}&per_page=5`)).results || []);
  if (!cands.length && cat) {
    const r = (await dg(env, `/database/search?type=release&catno=${encodeURIComponent(cat)}&per_page=15`)).results || [];
    cands = r.filter((x: any) => {
      const p = String(x.title || '').split(' - ');
      const ar = p.shift() || '';
      return mismoDisco(artist, title, ar, p.join(' - '));
    });
  }
  if (!cands.length) return null;
  cands.sort((a: any, b: any) => Number((b.format || []).includes('Vinyl')) - Number((a.format || []).includes('Vinyl')));
  const rel = await dg(env, `/releases/${cands[0].id}`);
  let yt: CargoTrack[] = (rel.videos || []).map((v: any) => ({ name: String(v.title || ''), yt: ytId(v.uri) || '' })).filter((v: CargoTrack) => v.yt);
  if (!yt.length && rel.master_id) {
    try { yt = ((await dg(env, `/masters/${rel.master_id}`)).videos || []).map((v: any) => ({ name: String(v.title || ''), yt: ytId(v.uri) || '' })).filter((v: CargoTrack) => v.yt); } catch { /* sin master */ }
  }
  const img = (rel.images || [])[0] || {};
  return {
    id: rel.id,
    label: limpiaDiscogs(((rel.labels || [])[0] || {}).name || ''),
    genres: rel.genres || [],
    styles: rel.styles || [],
    year: rel.year || undefined,
    cover: img.uri || img.resource_url || cands[0].cover_image || undefined,
    artist: (rel.artists || []).map((a: any) => limpiaDiscogs(a.name)).join(', '),
    title: String(rel.title || ''),
    yt,
  };
}

// ── Deezer / Apple ──────────────────────────────────────────────
interface Hallazgo { album: string; by: string; cover?: string; page?: string; tracks: { name: string; src: string }[]; tramo?: boolean }

async function json(f: F, url: string): Promise<any> {
  const r = await f(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} ${r.status}`);
  return r.json();
}
export async function viaDeezer(f: F, artist: string, title: string, ean: string): Promise<Hallazgo | null> {
  let a: any = null;
  if (ean) { try { const j = await json(f, `https://api.deezer.com/album/upc:${sinCeros(ean)}`); if (j && j.id && !j.error) a = j; } catch { /* sigue con la busqueda */ } }
  if (!a) {
    const va = isVA(artist);
    for (const q of [(va ? '' : `artist:"${norm(artist)}" `) + `album:"${norm(title)}"`, (va ? '' : norm(artist) + ' ') + norm(title)]) {
      const s = await json(f, `https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=15`);
      const hit = (s.data || []).find((x: any) => mismoDisco(artist, title, x.artist?.name || '', x.title || ''));
      if (hit) { a = await json(f, `https://api.deezer.com/album/${hit.id}`); break; }
    }
  }
  if (!a) return null;
  let tr = (a.tracks?.data || []);
  if (!tr.length) tr = (await json(f, `https://api.deezer.com/album/${a.id}/tracks?limit=100`)).data || [];
  const tracks = tr.filter((x: any) => x.preview).map((x: any) => ({ name: String(x.title || ''), src: x.preview }));
  if (!tracks.length) return null;
  return { album: a.title, by: a.artist?.name || '', cover: a.cover_xl || a.cover_big || undefined, page: a.link, tracks };
}
export async function viaApple(f: F, artist: string, title: string, ean: string): Promise<Hallazgo | null> {
  let songs: any[] = [], col: any = null;
  if (ean) {
    const j = await json(f, `https://itunes.apple.com/lookup?upc=${sinCeros(ean)}&entity=song&limit=200`);
    col = (j.results || []).find((x: any) => x.wrapperType === 'collection');
    songs = (j.results || []).filter((x: any) => x.wrapperType === 'track');
  }
  if (!col) {
    const term = (isVA(artist) ? '' : norm(artist) + ' ') + norm(title);
    const s = await json(f, `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=15`);
    col = (s.results || []).find((x: any) => mismoDisco(artist, title, x.artistName || '', x.collectionName || ''));
    if (!col) return null;
    songs = ((await json(f, `https://itunes.apple.com/lookup?id=${col.collectionId}&entity=song&limit=200`)).results || []).filter((x: any) => x.wrapperType === 'track');
  }
  const tracks = songs.filter((x) => x.previewUrl)
    .sort((a, b) => (a.discNumber || 1) - (b.discNumber || 1) || (a.trackNumber || 0) - (b.trackNumber || 0))
    .map((x) => ({ name: String(x.trackName || ''), src: x.previewUrl }));
  if (!tracks.length) return null;
  return { album: col.collectionName, by: col.artistName, cover: (col.artworkUrl100 || '').replace('100x100', '600x600') || undefined, page: col.collectionViewUrl, tracks };
}

// ── Bandcamp ────────────────────────────────────────────────────
export class Challenge extends Error {}
async function html(f: F, url: string): Promise<string> {
  const r = await f(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en' } });
  const t = await r.text();
  if (/Client Challenge|_fs-ch-|challenge-platform/i.test(t) || r.status === 403) throw new Challenge('challenge');
  if (!r.ok) throw new Error(`bandcamp ${r.status}`);
  return t;
}
/** Resultados de bandcamp.com/search: [{url, title, artist}]. */
export function parseBandcampSearch(h: string): { url: string; title: string; artist: string }[] {
  const out: { url: string; title: string; artist: string }[] = [];
  for (const li of h.split(/<li class="searchresult/).slice(1)) {
    const head = li.match(/<div class="heading">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const sub = li.match(/<div class="subhead">([\s\S]*?)<\/div>/);
    if (!head) continue;
    const url = desentidad(head[1]).split('?')[0];
    if (!/\/album\//.test(url)) continue;
    const subt = sub ? quitaTags(sub[1]) : '';
    const by = (subt.match(/\bby\s+(.+)$/i) || [])[1] || subt;
    out.push({ url, title: quitaTags(head[2]), artist: by.trim() });
  }
  return out;
}
/** data-tralbum de una pagina de album: pistas con stream mp3-128. */
export function parseTralbum(h: string): { artist: string; title: string; tracks: { name: string; src: string }[]; cover?: string } | null {
  const m = h.match(/data-tralbum="([^"]+)"/);
  if (!m) return null;
  let d: any;
  try { d = JSON.parse(desentidad(m[1])); } catch { return null; }
  const tracks = (d.trackinfo || []).map((t: any) => ({ name: String(t.title || ''), src: t.file?.['mp3-128'] || '' })).filter((t: any) => t.src);
  const art = h.match(/<link rel="image_src" href="([^"]+)"/);
  return { artist: String(d.artist || ''), title: String(d.current?.title || ''), tracks, cover: art ? art[1] : undefined };
}
export async function viaBandcamp(f: F, artist: string, title: string): Promise<Hallazgo | null> {
  const q = (isVA(artist) ? '' : artist + ' ') + title;
  const res = parseBandcampSearch(await html(f, `https://bandcamp.com/search?q=${encodeURIComponent(q)}&item_type=a`));
  const hit = res.find((x) => mismoDisco(artist, title, x.artist, x.title));
  if (!hit) return null;
  const t = parseTralbum(await html(f, hit.url));
  if (!t || !t.tracks.length) return null;
  return { album: t.title || hit.title, by: t.artist || hit.artist, cover: t.cover, page: hit.url, tracks: t.tracks, tramo: true };
}

// ── copia a R2 ──────────────────────────────────────────────────
async function espeja(env: CargoEnv, f: F, src: string, key: string, publico: string, tramo: boolean): Promise<string | null> {
  const pide = (range?: string) => f(src, { headers: { 'User-Agent': UA, Accept: 'audio/*,*/*;q=0.8', ...(range ? { Range: range } : {}) } });
  let r = await pide(tramo ? `bytes=${TRAMO_DESDE}-${TRAMO_DESDE + TRAMO_BYTES - 1}` : undefined);
  if (tramo && r.status === 416) r = await pide(`bytes=0-${TRAMO_BYTES - 1}`);
  if (!r.ok) return null;
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('audio/') && !ct.includes('octet-stream')) return null;
  const buf = await r.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > MAX_BYTES) return null;
  await env.R2.put(key, buf, { httpMetadata: { contentType: ct.startsWith('audio/') ? ct : 'audio/mpeg', cacheControl: 'public, max-age=31536000' } });
  return `${publico}/${key}`;
}

// ── un disco ────────────────────────────────────────────────────
const corto = (a: CargoAudio) => [...(a.genres || []), ...(a.styles || [])].join(', ');
export const esElectronico = (genres?: string[]) => (genres || []).some((g) => /electronic/i.test(g));

export async function resuelveCargo(
  env: CargoEnv, row: CargoRow, publico: string,
  opts: { audio?: boolean; fetcher?: F } = {},
): Promise<CargoAudio> {
  const f = opts.fetcher || fetch;
  const [, artist, title, ean] = row;
  const out: CargoAudio = { at: new Date().toISOString(), state: 'none', tracks: [], yt: [], tried: {} };

  let info: DgInfo | null = null;
  try {
    info = await viaDiscogs(env, row);
    out.tried.discogs = info ? 'ok' : 'sin coincidencia';
  } catch (e: any) { out.tried.discogs = String(e?.message || e).slice(0, 80); }
  if (info) Object.assign(out, { label: info.label, genres: info.genres, styles: info.styles, year: info.year, cover: info.cover, discogs: info.id, yt: info.yt });

  const quiereAudio = opts.audio ?? true;
  if (!quiereAudio) { out.state = 'meta'; return out; }

  // Busquedas con el nombre de Discogs si lo hay (viene mas limpio que el de Cargo).
  const a2 = info?.artist || artist, t2 = info?.title || title;
  const fuentes: [Fuente, () => Promise<Hallazgo | null>][] = [
    ['deezer', () => viaDeezer(f, a2, t2, ean)],
    ['apple', () => viaApple(f, a2, t2, ean)],
    ['bandcamp', () => viaBandcamp(f, a2, t2)],
  ];
  for (const [nombre, run] of fuentes) {
    let h: Hallazgo | null = null;
    try {
      h = await run();
      out.tried[nombre] = h ? 'ok' : 'sin coincidencia';
    } catch (e: any) { out.tried[nombre] = e instanceof Challenge ? 'challenge' : String(e?.message || e).slice(0, 80); }
    if (!h) continue;
    const pistas: CargoTrack[] = [];
    for (const [i, t] of h.tracks.slice(0, MAX_PISTAS).entries()) {
      try {
        const ext = nombre === 'apple' ? 'm4a' : 'mp3';
        const url = await espeja(env, f, t.src, `${R2_PREFIX}${ean}/${nombre}-${i + 1}.${ext}`, publico, !!h.tramo);
        if (url) pistas.push({ name: t.name, url });
      } catch { /* pista suelta: sigue */ }
    }
    if (!pistas.length) { out.tried[nombre] = 'audio no descargable'; continue; }
    Object.assign(out, { state: 'ok', src: nombre, tracks: pistas, album: h.album, by: h.by, page: h.page });
    if (!out.cover && h.cover) out.cover = h.cover;
    break;
  }
  if (out.state !== 'ok' && out.yt.length) { out.state = 'ok'; out.src = 'youtube'; }
  return out;
}

// ── KV ──────────────────────────────────────────────────────────
export async function leeStock(env: CargoEnv): Promise<CargoStock | null> {
  return (await env.SYNC_STATE.get(STOCK_KEY, 'json')) as CargoStock | null;
}
async function leeIdx(env: CargoEnv): Promise<Record<string, IdxEntry>> {
  return ((await env.SYNC_STATE.get(IDX_KEY, 'json')) as Record<string, IdxEntry> | null) || {};
}
function entrada(a: CargoAudio): IdxEntry {
  const flag = a.state === 'meta' ? 'm' : a.state !== 'ok' ? 'n' : a.src === 'youtube' ? 'y' : 'a';
  return [a.label || '', corto(a), flag, esElectronico(a.genres) ? 1 : 0];
}
async function guarda(env: CargoEnv, ean: string, a: CargoAudio, idx?: Record<string, IdxEntry>): Promise<void> {
  await env.SYNC_STATE.put(AKEY(ean), JSON.stringify(a));
  const i = idx || await leeIdx(env);
  i[ean] = entrada(a);
  if (!idx) await env.SYNC_STATE.put(IDX_KEY, JSON.stringify(i));
}

/** Valida y normaliza las filas que manda la pagina. */
export function validaFilas(rows: unknown): CargoRow[] {
  if (!Array.isArray(rows)) return [];
  const out: CargoRow[] = [];
  const vistos = new Set<string>();
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 10) continue;
    const ean = String(r[3] || '').trim();
    const cat = String(r[0] || '').trim();
    if (!cat || !/^\d{8,14}$/.test(ean) || vistos.has(ean)) continue;
    vistos.add(ean);
    const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    out.push([cat, String(r[1] || '').slice(0, 200), String(r[2] || '').slice(0, 300), ean, String(r[4] || 'VL').slice(0, 8), n(r[5]) || 1, n(r[6]), n(r[7]), n(r[8]), n(r[9]), n(r[10]) ? 1 : 0]);
  }
  return out;
}

/** Siguiente tanda del segundo plano: electronicos sin audio primero; luego metadatos del resto. */
export function siguientes(rows: CargoRow[], idx: Record<string, IdxEntry>, n: number): { row: CargoRow; audio: boolean }[] {
  const out: { row: CargoRow; audio: boolean }[] = [];
  const electronico = (r: CargoRow) => r[10] === 1 || idx[r[3]]?.[3] === 1;
  for (const r of rows) {
    if (out.length >= n) return out;
    const e = idx[r[3]];
    if (electronico(r) && (!e || e[2] === 'm')) out.push({ row: r, audio: true });
  }
  for (const r of rows) {
    if (out.length >= n) return out;
    if (!idx[r[3]] && !electronico(r)) out.push({ row: r, audio: false });
  }
  return out;
}

export async function pasadaCargo(env: CargoEnv, publico: string, n = PASADA_CRON, fetcher?: F) {
  const stock = await leeStock(env);
  if (!stock) return { ok: true, hechos: 0, pendientes: 0, nota: 'sin stock report' };
  const idx = await leeIdx(env);
  const tanda = siguientes(stock.rows, idx, n);
  const res: Record<string, number> = {};
  for (const { row, audio } of tanda) {
    const a = await resuelveCargo(env, row, publico, { audio, fetcher });
    await guarda(env, row[3], a, idx);
    const k = a.state === 'ok' ? a.src! : a.state;
    res[k] = (res[k] || 0) + 1;
  }
  if (tanda.length) await env.SYNC_STATE.put(IDX_KEY, JSON.stringify(idx));
  const pendientes = siguientes(stock.rows, idx, 1e6).length;
  const resumen = { ok: true, at: new Date().toISOString(), hechos: tanda.length, resultado: res, pendientes };
  await env.SYNC_STATE.put(LAST_KEY, JSON.stringify(resumen));
  return resumen;
}

// ── handlers ────────────────────────────────────────────────────
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const jr = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const NO = () => jr({ error: 'unauthorized' }, 401);

export async function handleCargoStock(env: CargoEnv, ok: boolean): Promise<Response> {
  if (!ok) return NO();
  const [stock, idx, last] = await Promise.all([leeStock(env), leeIdx(env), env.SYNC_STATE.get(LAST_KEY, 'json')]);
  return jr({ stock, idx, last });
}

export async function handleCargoUpload(request: Request, env: CargoEnv, ok: boolean): Promise<Response> {
  if (!ok) return NO();
  let body: any;
  try { body = await request.json(); } catch { return jr({ error: 'invalid json' }, 400); }
  const rows = validaFilas(body?.rows);
  if (rows.length < 20) return jr({ error: `muy pocas filas validas (${rows.length}); no piso el stock anterior` }, 400);
  const prev = await leeStock(env);
  const ahora = new Date().toISOString();
  const seen: Record<string, string> = {};
  for (const r of rows) seen[r[3]] = prev?.seen?.[r[3]] || (prev ? ahora : '');
  const stock: CargoStock = { updated_at: ahora, file: String(body?.file || '').slice(0, 200), rows, seen };
  await env.SYNC_STATE.put(STOCK_KEY, JSON.stringify(stock));
  const nuevos = prev ? rows.filter((r) => !prev.seen?.[r[3]]).length : 0;
  return jr({ ok: true, filas: rows.length, nuevos, electronicos: rows.filter((r) => r[10] === 1).length });
}

export async function handleCargoAudio(request: Request, env: CargoEnv, ok: boolean, publico: string): Promise<Response> {
  if (!ok) return NO();
  const url = new URL(request.url);
  const ean = (url.searchParams.get('ean') || '').trim();
  if (!/^\d{8,14}$/.test(ean)) return jr({ error: 'ean' }, 400);
  const force = url.searchParams.get('force') === '1';
  const hecho = (await env.SYNC_STATE.get(AKEY(ean), 'json')) as CargoAudio | null;
  if (hecho && hecho.state !== 'meta' && !force) return jr(hecho);
  const stock = await leeStock(env);
  const row = stock?.rows.find((r) => r[3] === ean);
  if (!row) return jr({ error: 'ean no esta en el stock report' }, 404);
  const a = await resuelveCargo(env, row, publico, { audio: true });
  await guarda(env, ean, a);
  return jr(a);
}

export async function handleCargoRefresh(request: Request, env: CargoEnv, ok: boolean, publico: string): Promise<Response> {
  if (!ok) return NO();
  const n = Math.max(1, Math.min(15, Number(new URL(request.url).searchParams.get('n')) || PASADA_CRON));
  try {
    return jr(await pasadaCargo(env, publico, n));
  } catch (e: any) {
    return jr({ ok: false, error: e?.message || String(e) }, 502);
  }
}
