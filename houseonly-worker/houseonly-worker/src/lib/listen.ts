/**
 * Bandeja de escucha del tab Pre-order, fase 1: ingesta de audio (2026-11-02).
 *
 * De cada email de anuncio de Rubadub o Triple Vision archivado en EMAILS, el
 * cron saca los discos (parseDistributorEmail, el mismo parser que el tab), baja
 * el promopack y deja en R2 solo los MP3 y la portada (la del ZIP; si no trae,
 * la del email). La bandeja los reproduce desde aqui: nada de enlaces externos.
 *
 * Audio PRIVADO: vive en su propio bucket, houseonly-listen (binding LISTEN_R2),
 * sin r2.dev ni dominio. (Hasta el 2026-11-02 iba en houseonly-audio, que se
 * sirve ENTERO por r2.dev: la firma no protegia nada.) Solo lo sirve
 * ?action=listen-file con URL firmada (HMAC de la clave + caducidad), que solo
 * reparte ?action=listen-list con el Bearer de admin.
 *
 * KV (SYNC_STATE, distinto en prod y staging):
 *   meta:listen_mode        'live' = el cron ingiere; cualquier otra cosa, nada
 *   meta:listen_last_run    resumen de la ultima pasada
 *   listen:rel:<CLAVE>      el disco (CLAVE = claveCatno: dedupe por catno);
 *                           metadata = resumen para listar sin un get por clave
 *   listen:mail:<fichero>   email ya tratado entero (no se vuelve a abrir)
 *
 * R2 (houseonly-listen, compartido con staging): LISTEN_R2_PREFIX, por defecto
 * listen/ (prod); staging usa listen-staging/ para no pisar a prod.
 *
 * Fase 2 (2026-11-02): decisiones y limpieza.
 *   listen-decide  preorder (solo lo marca: la carga al tab es la fase 3) |
 *                  pendiente | rechazado (temporal 90 dias o definitivo, en el
 *                  mismo preorder:rejected del filtro del 20-10) | null (deshacer)
 *   Limpieza, en cada pasada: un rechazado sale de la bandeja (KV y R2) a los 7
 *   dias de rechazarlo; un pendiente o sin decidir pierde el audio a los 30 dias
 *   de entrar, y sale de la bandeja 30 dias despues de eso. Lo elegido para
 *   pre-order no se toca.
 *   listen-list pagina por vista (por_decidir | pendientes | elegidos |
 *   rechazados | cargados) con limit y cursor.
 *
 * Fase 3 (2026-11-02): carga al Pre-order.
 *   El tab mete los elegidos en el manifest (filas _listen). Al hacer Process,
 *   ?action=listen-promote COPIA (no mueve) el audio y la portada de aqui a
 *   audio/<safeKey>/ y covers/ de houseonly-audio (staging: staging-audio/ y
 *   staging-covers/) y marca el disco "cargado". El original se queda para que
 *   "deshacer" funcione; la limpieza lo borra 7 dias despues de cargarlo.
 *   Interruptor: meta:listen_promote = 'on' (sin el, listen-promote no hace nada).
 *   Si el ZIP trae texto (_promotext.txt de TV, SALESPAPER.pdf de Rubadub) se
 *   guarda tambien, para la descripcion del producto.
 */
import { unzipSync } from 'fflate';
import { parseDistributorEmail, parseDbhEmail, parseSubwaxEmail, MAIL_DIGEST, MAIL_ORDER, RD_GBP_EUR } from './distributor-email.mjs';
import { ENLACE_DE_SUSCRIPCION } from './distributor-email.mjs';
import { claveCatno, claveKV, nuevoRechazo, indiceTienda, buscaEnTienda } from './preorder-rechazos.mjs';
import { nombreDePista } from './track-names.mjs';
import { shopifyAdminGraphQL, type ShopifyAdminEnv } from './shopify-admin';

export interface ListenEnv {
  SYNC_STATE: KVNamespace;
  EMAILS: KVNamespace;
  LISTEN_R2: R2Bucket;            // houseonly-listen, privado
  BOOTSTRAP_AUTH_SECRET: string;
  LISTEN_R2_PREFIX?: string;
  R2: R2Bucket;                   // houseonly-audio (publico): destino de listen-promote
  LISTEN_PROMOTE_AUDIO_PREFIX?: string;
  LISTEN_PROMOTE_COVERS_PREFIX?: string;
  // Shopify (deshacer carga: ¿algun producto usa ya lo copiado?)
  WISHLIST?: KVNamespace;
  SHOPIFY_ADMIN_CLIENT_ID?: string;
  SHOPIFY_ADMIN_CLIENT_SECRET?: string;
}

// Su propia expresion de cron, lejos de :03 (eBay) y :07 (Discogs).
export const LISTEN_CRON = '41 * * * *';

const MODE_KEY = 'meta:listen_mode';
const LAST_RUN_KEY = 'meta:listen_last_run';
const REL_PREFIX = 'listen:rel:';
const MAIL_PREFIX = 'listen:mail:';

// Rubadub y Triple Vision (fase 1); DBH desde el 2026-11-03 (parseDbhEmail, el
// ZIP es release_zip/<id> de su tienda); Subwax desde el 2026-11-04
// (parseSubwaxEmail, ZIP en subwax.es tras un tracker). MT y Kudos vendran cada
// uno con su propio mecanismo de audio.
export const LISTEN_SOURCES: Record<string, string> = { RD: 'Rubadub', TV: 'Triple Vision', DBH: 'DBH', SUBWAX: 'Subwax' };

// Fuentes cuyo correo es un catalogo de fichas, cada una con su ZIP: ni enlace
// de pista (MYD015, cosa de Rubadub) ni precio en libras.
const POR_FICHAS = new Set(['DBH', 'SUBWAX']);

/** Las fichas de un email archivado, con el parser de su distribuidor. */
function filasDelEmail(prefix: string, html: string, fecha: string): any[] {
  if (prefix === 'DBH') return parseDbhEmail(html);
  if (prefix === 'SUBWAX') return parseSubwaxEmail(html);
  const [y, m, d] = fecha.split('-').map(Number);
  return parseDistributorEmail(html, { fx: RD_GBP_EUR, emailDate: new Date(y, m - 1, d) });
}

// Solo emails recientes. 7 dias desde el 03-11 (con 3 se quedaban fuera los
// anuncios que llegan tarde al indice). Ojo: los st= de Dropbox de Rubadub
// caducan (los del 30-10 aun bajaban el 02-11); si ya no bajan, el disco entra
// sin audio, con portada y prosa, y se sube a mano.
const MAX_EMAIL_AGE_DAYS = 7;
// Discos intentados por pasada. A ~10 MB por promopack y una pasada por hora,
// sobra para los ~6 anuncios diarios de octubre.
const PER_RUN = 6;
// Tope del ZIP. Se lee en memoria (128 MB por isolate) y se descomprime fichero
// a fichero, asi que el pico es el ZIP mas un MP3. Por encima: descarga manual.
export const ZIP_MAX_BYTES = 50 * 1024 * 1024;
const COVER_MAX_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
// Caducidad de las URLs firmadas que da listen-list.
export const SIGNED_TTL_S = 3600;
// Limpieza (fase 2).
export const DIAS_RECHAZADO = 7;
export const DIAS_SIN_DECIDIR = 30;
const DIA_MS = 86400000;

const TRACKER = /^https:\/\/([a-z0-9.-]*\.)?(list-manage\.com|mailchi\.mp)\//i;
// Mismos hosts que ?action=zip-proxy.
const ZIP_HOSTS = /^(www\.)?dropbox\.com$|^dl\.dropboxusercontent\.com$|^triple-vision-assets\.ams3\.cdn\.digitaloceanspaces\.com$|^xcdn\.triplevision\.nl$|^dbh-music\.com$|^(www\.)?subwax\.es$/i;
// Portadas del email: los mismos hosts que espeja ?action=mirror.
// Mas la de la ficha de DBH (img.php de su tienda).
const COVER_HOSTS = /^(mcusercontent\.com|.*\.mcusercontent\.com|triple-vision-assets\.ams3\.cdn\.digitaloceanspaces\.com|dbh-music\.com)$/i;

// caducado: el Dropbox del promopack ya no baja (pedir el promo).
export type ListenEstado = 'listo' | 'descarga_manual' | 'sin_zip' | 'sin_audio' | 'caducado' | 'error';
export type ListenDecision = 'preorder' | 'pendiente' | 'rechazado' | 'cargado';
// Las que se pueden poner a mano; 'cargado' solo lo pone listen-promote.
export const DECISIONES: ListenDecision[] = ['preorder', 'pendiente', 'rechazado'];
const PROMOTE_KEY = 'meta:listen_promote';
export const DIAS_CARGADO = 7;
const TEXTO_MAX_BYTES = 256 * 1024;
const PDF_MAX_BYTES = 2 * 1024 * 1024;

export interface ListenTrack { name: string; key: string; bytes: number }

export interface ListenRelease {
  clave: string;
  catno: string;
  distribuidor: string;          // RD | TV
  artist: string;
  title: string;
  label: string;
  format: string;
  release: string;               // yyyy-mm-dd o ''
  dealerPrice: number | null;    // EUR, como en el tab (coste dealer)
  gbp?: number | null;           // RD: precio del email en libras
  fx?: number;                   // RD: cambio con el que se paso a EUR
  email: string;                 // fichero archivado del que sale
  email_date: string;
  estado: ListenEstado;
  detalle?: string;
  zip_link?: string;             // solo si hay que bajarlo a mano
  tracks: ListenTrack[];
  cover?: { key: string; from: 'zip' | 'email' };
  textos?: { promotext?: string; salespaper?: string };   // claves en LISTEN_R2
  bytes: number;
  ingested_at: string;
  decision?: ListenDecision;
  decided_at?: string;
  rechazo?: 'temporal' | 'definitivo';
  audio_limpiado_at?: string;    // pendiente/sin decidir de mas de 30 dias
  cargado_at?: string;           // listen-promote: copiado a audio/ y covers/
  handle?: string;               // el handle con que va al CSV
  promovidos?: string[];         // claves copiadas en houseonly-audio
  en_tienda_como?: string;       // "cargado" sin copiar nada: ya estaba en la tienda
  resumen?: string;              // prosa del correo (recortada), para decidir sin audio
  portada_comprobada?: boolean;  // completaPortadas ya miro su correo
  subido_a_mano_at?: string;     // listen-upload: audio conseguido por otra via
  reparado_at?: string;          // listen-repair ya lo reintento (sin_zip)
  reparado_v?: number;           // con que version de listen-repair (REPARA_VERSION)
}

export interface ListenRunResult {
  mode: string;
  emails_vistos: number;
  emails_cerrados: number;
  nuevos: number;
  por_estado: Partial<Record<ListenEstado, number>>;
  saltados: { duplicado: number; rechazado: number; no_preorder: number; en_tienda: number };
  en_tienda?: string[];          // "<catno> como <handle>"
  descartados_asunto?: string[]; // "<fichero> (<motivo>)": no se abren
  tienda_error?: string;
  limpiados: { rechazados: number; sin_audio: number; fuera: number; cargados: number };
  portadas?: number;
  quedan: boolean;
  finished_at: string;
}

function prefijo(env: ListenEnv): string {
  return env.LISTEN_R2_PREFIX || 'listen/';
}

function metaDe(r: ListenRelease) {
  return {
    c: r.catno, d: r.distribuidor, e: r.estado,
    a: r.artist.slice(0, 60), t: r.title.slice(0, 60), r: r.release,
    n: r.tracks.length, at: r.ingested_at,
    x: r.decision, dt: r.decided_at, al: r.audio_limpiado_at,
    pc: r.portada_comprobada ? 1 : undefined,
    rz: r.reparado_v || (r.reparado_at ? 1 : undefined),
  };
}

async function guardaRelease(env: ListenEnv, r: ListenRelease): Promise<void> {
  await env.SYNC_STATE.put(REL_PREFIX + r.clave, JSON.stringify(r), { metadata: metaDe(r) });
}

// ── selección de emails ────────────────────────────────────────

interface IdxEntry { name: string; prefix: string; subject: string; date: string }

// Rubadub: fuera solo sus listas masivas conocidas, de ~150-200 fichas y
// ninguna de pre-order. Lo demas se abre aunque el asunto suene a digest: el
// parser ya descarta lo que no es "Please pre-order". Con MAIL_DIGEST (que es
// del tab) se quedaron fuera los represses de Theo Parrish y de Short Span
// (2026-11-04); asi un asunto nuevo no vuelve a dejar discos fuera.
const RD_MASIVAS = [/Imports-Shipping-Today/i, /New-Releases-Shipping/i, /All-Rubadub-Pre-sales/i];

/** Por que no se abre un email, o null si se abre. */
function motivoDescarte(e: IdxEntry): string | null {
  if (MAIL_ORDER.test(e.subject)) return 'pedido';
  // Las newsletters de DBH si: traen fichas "Coming soon" (2026-11-03: 7 de 86).
  if (e.prefix === 'DBH') return null;
  if (e.prefix === 'RD') return RD_MASIVAS.some(re => re.test(e.subject)) ? 'lista masiva' : null;
  return MAIL_DIGEST.some(re => re.test(e.subject)) ? 'digest' : null;
}

/**
 * Emails de la ventana, del mas antiguo al mas nuevo (caducan antes): los que se
 * abren y los que se descartan por el asunto, con el motivo.
 */
export function triaEmails(idx: IdxEntry[], hoy: Date, dias = MAX_EMAIL_AGE_DAYS, fuente = '') {
  const desde = new Date(hoy.getTime() - dias * 86400000).toISOString().slice(0, 10);
  const candidatos: IdxEntry[] = [], descartados: { email: IdxEntry; motivo: string }[] = [];
  const ventana = idx
    .filter(e => LISTEN_SOURCES[e.prefix] && e.date >= desde && (!fuente || e.prefix === fuente))
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  for (const e of ventana) {
    const motivo = motivoDescarte(e);
    if (motivo) descartados.push({ email: e, motivo }); else candidatos.push(e);
  }
  return { candidatos, descartados };
}

export function emailsCandidatos(idx: IdxEntry[], hoy: Date, dias = MAX_EMAIL_AGE_DAYS, fuente = ''): IdxEntry[] {
  return triaEmails(idx, hoy, dias, fuente).candidatos;
}

// ── enlaces y descargas ────────────────────────────────────────

async function fetchConTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', ...(init.headers || {}) } });
  } finally {
    clearTimeout(t);
  }
}

/** dl=1: dl=0 devuelve la pagina de vista previa (HTML con 200), no el ZIP. */
export function dropboxDescarga(url: string): string {
  let u = url.replace(/([?&])dl=0(&|$)/i, '$1dl=1$2');
  if (!/[?&]dl=1(&|$)/i.test(u)) u += (u.includes('?') ? '&' : '?') + 'dl=1';
  return u;
}

function esZipDescargable(u: string): boolean {
  try {
    const p = new URL(u);
    if (p.protocol !== 'https:' || !ZIP_HOSTS.test(p.hostname)) return false;
    if (/dropbox\.com$/i.test(p.hostname)) return /\/(scl\/fo|sh)\//i.test(p.pathname);
    if (/digitaloceanspaces\.com$/i.test(p.hostname)) return /promopack/i.test(p.pathname);
    if (/dbh-music\.com$/i.test(p.hostname)) return /^\/shop\/release_zip\/\d+$/.test(p.pathname);
    if (/subwax\.es$/i.test(p.hostname)) return /^\/wp-content\/uploads\/\d{4}\/\d{2}\/[^/]+_pack\.zip$/i.test(p.pathname);
    return true;
  } catch { return false; }
}

// Mailchimp a veces encadena dos trackers: en el correo de Theo Parrish del
// 30-10, us.list-manage.com/<codigo> → rubadub.us1.list-manage.com/track/click
// → Dropbox. Con un solo salto, 5 de sus 8 promopacks salian "sin ZIP".
export const SALTOS_TRACKER = 3;

/**
 * Adonde lleva un enlace de Mailchimp: se sigue mientras el destino siga siendo
 * un tracker, hasta SALTOS_TRACKER saltos. Solo desde trackers (no es un proxy
 * abierto). '' si no se llega a un destino fuera de Mailchimp.
 */
export async function destinoDeTracker(raw: string): Promise<string> {
  let u = raw.replace(/&amp;/g, '&');
  for (let i = 0; i < SALTOS_TRACKER && TRACKER.test(u); i++) {
    if (ENLACE_DE_SUSCRIPCION.test(u)) return '';
    // redirect:'manual' para leer el Location sin bajar nada.
    const r = await fetchConTimeout(u, { redirect: 'manual' });
    await r.body?.cancel();
    u = (r.headers.get('location') || '').replace(/&amp;/g, '&');
  }
  return TRACKER.test(u) ? '' : u;
}

/** El promopack del disco: directo, o al final de los saltos del tracker de Mailchimp. */
async function enlaceDelZip(row: { zipUrl?: string; _zipLinks?: string[] }): Promise<string> {
  const candidatos = [...new Set([row.zipUrl, ...(row._zipLinks || [])].filter(Boolean) as string[])];
  for (const raw of candidatos) {
    const u = raw.replace(/&amp;/g, '&');
    const dest = TRACKER.test(u) ? await destinoDeTracker(u) : u;
    if (esZipDescargable(dest)) return /dropbox\.com/i.test(dest) ? dropboxDescarga(dest) : dest;
  }
  return '';
}

// MYD015 (2026-10-30): sin boton "Download Zip"; el Dropbox va colgado del
// nombre de la pista "A1. ...". Solo en emails de un disco y solo Dropbox.
const ETIQUETA_PISTA = /^(?:[A-H]\d{1,2}|\d{1,2})\s*[.)]/;
const textoPlano = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();

/** Los href de los enlaces cuyo texto empieza por una etiqueta de pista, en orden. */
export function enlacesDePista(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) if (ETIQUETA_PISTA.test(textoPlano(m[2]))) out.push(m[1].replace(/&amp;/g, '&'));
  return [...new Set(out)];
}

/** Cuantas pistas distintas ("A1.", "B2." ...) lista el email. */
export function cuentaPistas(html: string): number {
  const t = textoPlano(html);
  return new Set([...t.matchAll(/(?:^|\s)([A-H]\d{1,2})\s*[.)]/g)].map(m => m[1])).size;
}

const esDropbox = (u: string) => { try { return /(^|\.)dropbox\.com$/i.test(new URL(u).hostname); } catch { return false; } };

/** El primer enlace de pista que lleve a Dropbox (directo o tras los saltos del tracker). */
async function dropboxDePista(enlaces: string[]): Promise<string> {
  for (const u of enlaces) {
    if (esDropbox(u)) return u;
    if (!TRACKER.test(u)) continue;
    const dest = await destinoDeTracker(u);
    if (esDropbox(dest)) return dest;
  }
  return '';
}

const ENLACES_FICHA_MAX = 12;

/** Adonde lleva cada enlace de la ficha (ya resueltos los trackers), con su texto; sin repetir destino. */
async function destinosDeFicha(row: { _enlacesFicha?: string[]; _textoEnlace?: Record<string, string> }): Promise<Array<{ destino: string; texto: string }>> {
  const out: Array<{ destino: string; texto: string }> = [];
  for (const u of (row._enlacesFicha || []).slice(0, ENLACES_FICHA_MAX)) {
    if (ENLACE_DE_SUSCRIPCION.test(u)) continue;
    const d = TRACKER.test(u) ? await destinoDeTracker(u).catch(() => '') : u;
    if (d && !out.some(x => x.destino === d)) out.push({ destino: d, texto: row._textoEnlace?.[u] || '' });
  }
  return out;
}

// MP3 sueltos por pista de discos de Rubadub, en los hosts que les alojan el
// audio: Fett Distro (~1,3 MB por cara, solo http) y Groovedis (http → https).
// Los correos que Groovedis manda por su cuenta no son una fuente (04-11).
const MP3_SUELTO_HOSTS: Record<string, RegExp> = {
  'fett-distro.com': /^\/audio\/[^/]+\.mp3$/i,
  'groovedis.com': /^\/singles\/[^/]+\.mp3$/i,
};
const MP3_SUELTO_MAX_BYTES = 25 * 1024 * 1024;

/**
 * La URL del MP3 sin lo que le pega Mailchimp (?utm_…&mc_eid=…; con ello
 * RDUB702 no casaba) y, si viene mal escrita ("http://%20http://www.groovedis…",
 * MO26), la ultima URL de dentro. '' si no es un MP3 suelto admitido.
 */
export function mp3Suelto(raw: string): string {
  for (const c of [raw, raw.slice(raw.lastIndexOf('http'))]) {
    let p: URL;
    try { p = new URL(c); } catch { continue; }
    const host = p.hostname.replace(/^www\./i, '').toLowerCase();
    const ruta = MP3_SUELTO_HOSTS[host];
    if (/^https?:$/.test(p.protocol) && ruta?.test(p.pathname)) return `${p.protocol}//${p.hostname}${p.pathname}`;
  }
  return '';
}
export const esMp3Suelto = (u: string) => !!mp3Suelto(u);

/** Por que un disco no tiene promopack, para decidir si vale la pena pedirlo. */
export function porQueSinZip(destinos: string[]): string {
  // Con el enlace mal escrito ("http://%20http://www.groovedis.com/…", MO26) vale la ultima URL de dentro.
  const host = (u: string) => {
    for (const c of [u, u.slice(u.lastIndexOf('http'))]) { try { return new URL(c).hostname.replace(/^www\./, ''); } catch { /* la siguiente */ } }
    return '';
  };
  const mp3 = destinos.filter(u => /\.mp3(\?|$)/i.test(u));
  if (mp3.length) {
    const hosts = [...new Set(mp3.map(host).filter(Boolean))];
    return `sin promopack: MP3 sueltos por pista${hosts.length ? ` (${hosts.join(', ')})` : ''}`;
  }
  if (destinos.some(u => /(^|\.)(youtube\.com|youtu\.be|soundcloud\.com|bandcamp\.com)$/i.test(host(u))))
    return 'sin promopack: solo enlaces de escucha (YouTube, SoundCloud…)';
  if (!destinos.length) return 'sin promopack: la ficha no trae ningún enlace';
  return 'sin promopack: ningún enlace de la ficha lleva a uno';
}

/**
 * ¿Lo que bajo el enlace de la pista es el promopack del disco y no una pista
 * suelta u otra cosa? Si el ZIP o algun fichero lleva el catno, o si trae un MP3
 * por cada pista que lista el email.
 */
export function esElPromopack(clave: string, nombreZip: string, lista: Array<{ name: string }>, mp3: number, pistas: number): boolean {
  if (claveCatno(nombreZip).includes(clave)) return true;
  if (lista.some(f => claveCatno(f.name).includes(clave))) return true;
  return pistas >= 2 && mp3 >= pistas;
}

const nombreDeDescarga = (res: Response) => {
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  try { return m ? decodeURIComponent(m[1]) : ''; } catch { return m ? m[1] : ''; }
};

class Demasiado extends Error {}

/** El cuerpo entero, cortando en cuanto pase del tope (sin fiarse de Content-Length). */
async function leeConTope(res: Response, tope: number): Promise<Uint8Array> {
  const declarado = Number(res.headers.get('content-length') || 0);
  if (declarado > tope) throw new Demasiado(`${declarado} bytes`);
  const reader = res.body!.getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > tope) { await reader.cancel(); throw new Demasiado(`más de ${tope} bytes`); }
    trozos.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const t of trozos) { out.set(t, o); o += t.byteLength; }
  return out;
}

// ── el ZIP ─────────────────────────────────────────────────────

const base = (n: string) => n.split('/').pop() || n;
const esBasura = (n: string) => /(^|\/)__MACOSX\//.test(n) || base(n).startsWith('._');
const esMp3 = (n: string) => /\.mp3$/i.test(n) && !esBasura(n);
// Solo JPG: los PNG de los promopacks son las galletas (LN-017), no la funda.
const esJpg = (n: string) => /\.jpe?g$/i.test(n) && !esBasura(n);

const orden = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Nombres y tamaños del ZIP, sin descomprimir nada. */
export function contenidoZip(zip: Uint8Array): Array<{ name: string; size: number }> {
  const out: Array<{ name: string; size: number }> = [];
  unzipSync(zip, { filter: f => { out.push({ name: f.name, size: f.originalSize }); return false; } });
  return out;
}

/** Un fichero del ZIP. De uno en uno, para no tener todo descomprimido a la vez. */
function unFichero(zip: Uint8Array, name: string): Uint8Array {
  return unzipSync(zip, { filter: f => f.name === name })[name];
}

/** Lo que se guarda de un promopack: MP3 en orden natural y la portada mejor candidata. */
export function eligeFicheros(lista: Array<{ name: string; size: number }>): { mp3: string[]; portada: string | null; promotext: string | null; salespaper: string | null } {
  const mp3 = lista.filter(f => esMp3(f.name)).map(f => f.name).sort(orden.compare);
  const jpgs = lista.filter(f => esJpg(f.name));
  // La trasera nunca es la portada (DBH trae {CATNO}_cover.jpg y {CATNO}_cover_back.jpg).
  const trasera = (f: { name: string }) => /back/i.test(base(f.name));
  // Subwax: {CATNO}_A / _B y {CATNO}_1_Front / _2_Back; la A (o la 1) es la frontal.
  const frontal = (f: { name: string }) => /front|cover|sleeve/i.test(base(f.name)) || /[_\s-](A|1)(?=[_\s.-])/.test(base(f.name));
  const preferida = jpgs.find(f => frontal(f) && !trasera(f));
  const portada = preferida?.name || jpgs.sort((a, b) => Number(trasera(a)) - Number(trasera(b)) || b.size - a.size)[0]?.name || null;
  // Los mismos que lee el Process del tab: TV {CATNO}_promotext.txt, DBH {CATNO}_info.txt (o un .txt),
  // W&S/Rubadub SALESPAPER.pdf (o un .pdf). Si pesan demasiado, no.
  const txts = lista.filter(f => /\.txt$/i.test(f.name) && !esBasura(f.name) && f.size <= TEXTO_MAX_BYTES);
  const pdfs = lista.filter(f => /\.pdf$/i.test(f.name) && !esBasura(f.name) && f.size <= PDF_MAX_BYTES);
  // Subwax: "{CATNO} info.txt", con espacio.
  const promotext = (txts.find(f => /[_\s](promotext|info)\.txt$/i.test(f.name)) || txts[0])?.name || null;
  const salespaper = (pdfs.find(f => /SALESPAPER\.pdf$/i.test(f.name)) || pdfs[0])?.name || null;
  return { mp3, portada, promotext, salespaper };
}

const slug = (s: string) => s.replace(/\.[^.]+$/, '').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'pista';

// ── un disco ───────────────────────────────────────────────────

/** `html` solo en emails de un disco: habilita el enlace de pista (MYD015). */
async function ingiereDisco(env: ListenEnv, row: any, email: IdxEntry, ahora: string, html?: string): Promise<ListenRelease> {
  const clave = claveCatno(row.catno);
  const rel: ListenRelease = {
    clave, catno: row.catno, distribuidor: email.prefix,
    artist: row.artist || '', title: row.title || '', label: row.label || '', format: row.format || '',
    release: row.release || '', dealerPrice: row.dealerPrice ?? null,
    ...(row._gbp != null ? { gbp: row._gbp, fx: RD_GBP_EUR } : {}),
    email: email.name, email_date: email.date,
    estado: 'listo', tracks: [], bytes: 0, ingested_at: ahora,
  };
  const dir = `${prefijo(env)}${clave}/`;
  const subidas: string[] = [];
  try {
    let url = await enlaceDelZip(row);
    let viaPista = false;
    if (!url && html) {
      const dbx = await dropboxDePista(enlacesDePista(html));
      if (dbx) {
        // Un /scl/fi/ es una pista suelta, no la carpeta del promopack.
        if (!esZipDescargable(dbx)) return { ...rel, estado: 'descarga_manual', detalle: 'el enlace de la pista es un fichero suelto, no el promopack', zip_link: dbx };
        url = dropboxDescarga(dbx);
        viaPista = true;
      }
    }
    if (!url) {
      // Sin "Download Zip": los demas enlaces de su ficha. Si uno lleva a la
      // carpeta del promopack (SS041 la cuelga de la tracklist), se usa; si no,
      // se dice por que no hay promopack.
      const pares = await destinosDeFicha(row);
      const destinos = pares.map(p => p.destino);
      const carpeta = destinos.find(esZipDescargable);
      const sueltas = pares.filter(p => esMp3Suelto(p.destino)).map(p => ({ ...p, destino: mp3Suelto(p.destino) }));
      if (!carpeta && sueltas.length) {
        await guardaPistasSueltas(env, rel, sueltas, dir, subidas);
        if (row.coverUrl) await guardaPortadaDelCorreo(env, rel, row.coverUrl, dir, subidas);
        rel.detalle = `sin promopack: MP3 sueltos por pista de ${new URL(sueltas[0].destino).hostname.replace(/^www\./, '')}`;
        return rel;
      }
      if (!carpeta) return { ...rel, estado: 'sin_zip', detalle: porQueSinZip(destinos) };
      url = /dropbox\.com/i.test(carpeta) ? dropboxDescarga(carpeta) : carpeta;
      rel.detalle = 'promopack de otro enlace de la ficha (sin botón Download Zip)';
    }
    // Por el enlace de pista, cualquier cosa que no sea el promopack: a mano.
    const fallo = viaPista ? 'descarga_manual' as const : 'error' as const;

    const res = await fetchConTimeout(url, { redirect: 'follow' });
    // Un Dropbox caducado (los st= de Rubadub) responde 404/410 o una pagina:
    // eso es "enlace caducado", para saber que hay que pedir el promo.
    const caducado = esDropbox(url) ? { ...rel, estado: 'caducado' as const, detalle: 'el Dropbox del promopack ha caducado: pide el promo', zip_link: url } : null;
    if (!res.ok) {
      await res.body?.cancel();
      if (caducado && (res.status === 404 || res.status === 410)) return caducado;
      return { ...rel, estado: fallo, detalle: `promopack: HTTP ${res.status}`, zip_link: url };
    }
    if (/text\/html/i.test(res.headers.get('content-type') || '')) {
      await res.body?.cancel();
      return caducado || { ...rel, estado: fallo, detalle: 'el enlace devuelve una página, no un ZIP (¿caducado?)', zip_link: url };
    }
    let zip: Uint8Array;
    try { zip = await leeConTope(res, ZIP_MAX_BYTES); }
    catch (e) {
      if (e instanceof Demasiado) return { ...rel, estado: 'descarga_manual', detalle: `ZIP demasiado grande (${e.message})`, zip_link: url };
      throw e;
    }

    const lista = contenidoZip(zip);
    const { mp3, portada, promotext, salespaper } = eligeFicheros(lista);
    if (viaPista && !esElPromopack(clave, nombreDeDescarga(res), lista, mp3.length, cuentaPistas(html!)))
      return { ...rel, estado: 'descarga_manual', detalle: 'el enlace de la pista no baja el promopack del disco', zip_link: url };
    if (!mp3.length) return { ...rel, estado: viaPista ? 'descarga_manual' : 'sin_audio', detalle: 'el ZIP no trae MP3', zip_link: url };
    if (viaPista) rel.detalle = 'promopack del enlace de la pista (sin botón Download Zip)';

    await guardaDelZip(env, rel, zip, { mp3, portada, promotext, salespaper }, dir, subidas);
    if (!portada && row.coverUrl) await guardaPortadaDelCorreo(env, rel, row.coverUrl, dir, subidas);
    return rel;
  } catch (e: any) {
    // A medias no sirve: lo subido se borra para que el reintento empiece limpio.
    if (subidas.length) await env.LISTEN_R2.delete(subidas).catch(() => {});
    return { ...rel, estado: 'error', tracks: [], bytes: 0, cover: undefined, detalle: e?.message || String(e) };
  }
}

/** Las pistas sueltas (esMp3Suelto), en el orden del correo y con el texto del enlace como nombre. */
async function guardaPistasSueltas(env: ListenEnv, rel: ListenRelease, sueltas: Array<{ destino: string; texto: string }>, dir: string, subidas: string[]): Promise<void> {
  for (let i = 0; i < sueltas.length; i++) {
    const { destino, texto } = sueltas[i];
    const res = await fetchConTimeout(destino, { redirect: 'follow' });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`pista ${i + 1}: HTTP ${res.status}`); }
    if (!/audio\/(mpeg|mp3)/i.test(res.headers.get('content-type') || '')) { await res.body?.cancel(); throw new Error(`pista ${i + 1}: no es un MP3`); }
    const data = await leeConTope(res, MP3_SUELTO_MAX_BYTES);
    const nombre = texto || base(new URL(destino).pathname).replace(/\.mp3$/i, '');
    // slug() quita la extension: sin ".mp3" se comeria "A. Uno…" desde el punto.
    const key = `${dir}${String(i + 1).padStart(2, '0')}-${slug(`${nombre}.mp3`)}.mp3`;
    await env.LISTEN_R2.put(key, data, { httpMetadata: { contentType: 'audio/mpeg' } });
    subidas.push(key);
    rel.tracks.push({ name: nombre, key, bytes: data.byteLength });
    rel.bytes += data.byteLength;
  }
}

/** Pistas, textos y portada (si el ZIP la trae) a la bandeja. Anota cada clave en `subidas`. */
async function guardaDelZip(env: ListenEnv, rel: ListenRelease, zip: Uint8Array,
  f: { mp3: string[]; portada: string | null; promotext: string | null; salespaper: string | null }, dir: string, subidas: string[]): Promise<void> {
  for (let i = 0; i < f.mp3.length; i++) {
    const data = unFichero(zip, f.mp3[i]);
    const key = `${dir}${String(i + 1).padStart(2, '0')}-${slug(base(f.mp3[i]))}.mp3`;
    await env.LISTEN_R2.put(key, data, { httpMetadata: { contentType: 'audio/mpeg' } });
    subidas.push(key);
    rel.tracks.push({ name: base(f.mp3[i]).replace(/\.mp3$/i, ''), key, bytes: data.byteLength });
    rel.bytes += data.byteLength;
  }
  for (const [campo, nombre, destino, tipo] of [
    ['promotext', f.promotext, 'promotext.txt', 'text/plain; charset=utf-8'],
    ['salespaper', f.salespaper, 'salespaper.pdf', 'application/pdf'],
  ] as const) {
    if (!nombre) continue;
    const data = unFichero(zip, nombre);
    const key = `${dir}${destino}`;
    await env.LISTEN_R2.put(key, data, { httpMetadata: { contentType: tipo } });
    subidas.push(key);
    rel.textos = { ...rel.textos, [campo]: key };
    rel.bytes += data.byteLength;
  }
  if (f.portada) {
    const data = unFichero(zip, f.portada);
    const key = `${dir}cover.jpg`;
    await env.LISTEN_R2.put(key, data, { httpMetadata: { contentType: 'image/jpeg' } });
    subidas.push(key);
    rel.cover = { key, from: 'zip' };
    rel.bytes += data.byteLength;
  }
}

/** La portada del correo a la bandeja (tambien para los que no traen promopack). */
async function guardaPortadaDelCorreo(env: ListenEnv, rel: ListenRelease, url: string, dir: string, subidas: string[] = []): Promise<void> {
  const cover = await portadaDelEmail(url);
  if (!cover) return;
  const key = `${dir}cover${cover.ext}`;
  await env.LISTEN_R2.put(key, cover.data, { httpMetadata: { contentType: cover.type } });
  subidas.push(key);
  rel.cover = { key, from: 'email' };
  rel.bytes += cover.data.byteLength;
}

async function portadaDelEmail(url: string): Promise<{ data: Uint8Array; type: string; ext: string } | null> {
  try {
    const p = new URL(url);
    if (p.protocol !== 'https:' || !COVER_HOSTS.test(p.hostname)) return null;
    const res = await fetchConTimeout(url, { headers: { Accept: 'image/*' } });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || !type.startsWith('image/')) return null;
    const data = await leeConTope(res, COVER_MAX_BYTES);
    const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg';
    return { data, type, ext };
  } catch { return null; }
}

// ── la pasada ──────────────────────────────────────────────────

// Un disco ya ingerido no se repite; uno que no se pudo bajar se reintenta si
// otro email (una revision, por ejemplo) lo vuelve a anunciar.
const REINTENTABLE: ListenEstado[] = ['sin_zip', 'error'];

// ── ya en tienda ───────────────────────────────────────────

export interface Tienda { indice: ReturnType<typeof indiceTienda>; handleDe: Map<string, string> }

/**
 * Lo que ya existe en Shopify no entra a la bandeja (2026-11-03: MSLP022LTD
 * salio en "Por decidir" estando activo). Las mismas reglas que "Cargar
 * elegidos" en el tab (indiceTienda + buscaEnTienda sobre handle y SKU), pero
 * con TODOS los productos menos los archivados: un borrador o un unlisted
 * tambien estan ya dados de alta. Admin API leyendo productos (no el indice de
 * busqueda): ~1600 productos = 7 paginas de 250 (coste pedido ~500 cada una).
 */
export async function leeTienda(env: ListenEnv): Promise<Tienda> {
  const claves: string[] = [];
  const handleDe = new Map<string, string>();
  let after: string | null = null;
  for (let pagina = 0, esperas = 0; pagina < 40;) {
    const r: any = await shopifyAdminGraphQL(env as unknown as ShopifyAdminEnv, `
      query($after: String) {
        products(first: 250, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { handle status variants(first: 1) { nodes { sku } } }
        }
      }`, { after });
    if (r?.errors?.some((e: any) => e?.extensions?.code === 'THROTTLED') && esperas++ < 5) {
      await new Promise(ok => setTimeout(ok, 2000));
      continue;
    }
    const conn = r?.data?.products;
    if (r?.errors?.length || !conn) throw new Error(`Shopify products: ${JSON.stringify(r?.errors || r).slice(0, 200)}`);
    for (const n of conn.nodes) {
      if (n.status === 'ARCHIVED') continue;
      for (const k of [claveCatno(n.handle), claveCatno(n.variants?.nodes?.[0]?.sku)].filter(Boolean)) {
        claves.push(k);
        if (!handleDe.has(k)) handleDe.set(k, n.handle);
      }
    }
    if (!conn.pageInfo?.hasNextPage) return { indice: indiceTienda(claves), handleDe };
    after = conn.pageInfo.endCursor;
    pagina++;
  }
  throw new Error('Shopify products: demasiadas paginas');
}

export async function runListenIngest(env: ListenEnv, opts: { force?: boolean; now?: Date; dias?: number; fuente?: string } = {}): Promise<ListenRunResult> {
  const now = opts.now || new Date();
  const mode = (await env.SYNC_STATE.get(MODE_KEY)) || 'off';
  const out: ListenRunResult = {
    mode, emails_vistos: 0, emails_cerrados: 0, nuevos: 0, por_estado: {},
    saltados: { duplicado: 0, rechazado: 0, no_preorder: 0, en_tienda: 0 }, limpiados: { rechazados: 0, sin_audio: 0, fuera: 0, cargados: 0 }, quedan: false, finished_at: '',
  };
  if (mode !== 'live' && !opts.force) return { ...out, finished_at: new Date().toISOString() };

  const idx: IdxEntry[] = JSON.parse((await env.EMAILS.get('idx')) || '[]');
  let intentos = 0;
  // La tienda se lee una vez por pasada, y solo si hay algun disco que bajar.
  let tienda: Tienda | null = null;
  const { candidatos, descartados } = triaEmails(idx, now, opts.dias, opts.fuente);
  // A la vista en el resumen: si algo se queda fuera por el asunto, se ve.
  if (descartados.length) out.descartados_asunto = descartados.map(d => `${d.email.name} (${d.motivo})`);
  ingesta: for (const email of candidatos) {
    if (await env.SYNC_STATE.get(MAIL_PREFIX + email.name)) continue;
    if (intentos >= PER_RUN) { out.quedan = true; break; }
    out.emails_vistos++;
    const html = await env.EMAILS.get(`msg:${email.name}`);
    if (!html) continue;
    const rows = filasDelEmail(email.prefix, html, email.date);

    let completo = true;
    const vistos = new Set<string>();
    // El enlace de pista (MYD015) es cosa de Rubadub; DBH siempre trae su ZIP.
    const unDisco = !POR_FICHAS.has(email.prefix) && new Set(rows.map((r: any) => claveCatno(r.catno)).filter(Boolean)).size === 1;
    for (const row of rows) {
      const clave = claveCatno(row.catno);
      if (!clave || vistos.has(clave)) continue;
      vistos.add(clave);
      // La bandeja es de pre-orders: lo que ya se envia no entra.
      if (!row.forthcoming) { out.saltados.no_preorder++; continue; }
      if (await env.SYNC_STATE.get(claveKV(row.catno))) { out.saltados.rechazado++; continue; }
      const previo = await env.SYNC_STATE.getWithMetadata<{ e: ListenEstado }>(REL_PREFIX + clave);
      if (previo.value && !REINTENTABLE.includes(previo.metadata?.e as ListenEstado)) { out.saltados.duplicado++; continue; }
      if (!tienda) {
        // Sin saber que hay en la tienda no entra nada: el email queda abierto
        // y la pasada de la hora siguiente lo reintenta.
        try { tienda = await leeTienda(env); }
        catch (e: any) { out.tienda_error = String(e?.message || e).slice(0, 300); out.quedan = true; break ingesta; }
      }
      const como = buscaEnTienda(tienda.indice, row.catno);
      if (como) {
        out.saltados.en_tienda++;
        (out.en_tienda ||= []).push(`${row.catno} como ${tienda.handleDe.get(como) || como}`);
        continue;
      }
      if (intentos >= PER_RUN) { completo = false; out.quedan = true; break; }
      intentos++;
      const rel = await ingiereDisco(env, row, email, now.toISOString(), unDisco ? html : undefined);
      // Sin audio (sin ZIP, descarga manual, error) el disco se ve igual: con la
      // portada y la prosa del correo, para decidir y, si se consigue el audio
      // por otra via, subirlo a mano (listen-upload).
      if (row._desc) rel.resumen = String(row._desc).replace(/\s+/g, ' ').trim().slice(0, 600);
      if (!rel.cover && row.coverUrl) await guardaPortadaDelCorreo(env, rel, row.coverUrl, `${prefijo(env)}${rel.clave}/`).catch(() => {});
      await guardaRelease(env, rel);
      out.nuevos++;
      out.por_estado[rel.estado] = (out.por_estado[rel.estado] || 0) + 1;
    }
    if (completo) {
      // Caduca sola cuando el email ya no puede volver a ser candidato.
      await env.SYNC_STATE.put(MAIL_PREFIX + email.name, JSON.stringify({ at: now.toISOString(), discos: vistos.size }),
        { expirationTtl: (MAX_EMAIL_AGE_DAYS + 2) * 86400 });
      out.emails_cerrados++;
    }
  }
  out.limpiados = await limpiaBandeja(env, now);
  out.portadas = await completaPortadas(env);
  out.finished_at = new Date().toISOString();
  await env.SYNC_STATE.put(LAST_RUN_KEY, JSON.stringify(out));
  return out;
}

// ── portadas que faltan ────────────────────────────────────────

const PORTADAS_POR_PASADA = 10;

/**
 * Los discos sin audio que entraron antes de guardar la portada del correo
 * (los tres de Egyptian Lover del 03-11): se vuelve a leer su correo y se guarda
 * la portada. Una vez por disco (portada_comprobada), haya o no portada.
 */
export async function completaPortadas(env: ListenEnv): Promise<number> {
  let hechas = 0, vistas = 0;
  let cursor: string | undefined;
  do {
    const l: any = await env.SYNC_STATE.list({ prefix: REL_PREFIX, limit: 1000, cursor });
    for (const k of l.keys) {
      const m = k.metadata || {};
      if (m.n !== 0 || m.pc) continue;
      if (vistas >= PORTADAS_POR_PASADA) return hechas;
      const r = await env.SYNC_STATE.get<ListenRelease>(k.name, 'json');
      if (!r || r.cover || r.tracks.length) continue;
      vistas++;
      const html = await env.EMAILS.get(`msg:${r.email}`);
      if (html) {
        const row: any = filasDelEmail(r.distribuidor, html, r.email_date).find((x: any) => claveCatno(x.catno) === r.clave);
        if (row?.coverUrl) await guardaPortadaDelCorreo(env, r, row.coverUrl, `${prefijo(env)}${r.clave}/`).catch(() => {});
        if (row?._desc && !r.resumen) r.resumen = String(row._desc).replace(/\s+/g, ' ').trim().slice(0, 600);
      }
      if (r.cover) hechas++;
      r.portada_comprobada = true;
      await guardaRelease(env, r);
    }
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  return hechas;
}

// ── limpieza ───────────────────────────────────────────────────

/** Todo lo que un disco tiene en la bandeja (LISTEN_R2). */
const clavesDe = (r: ListenRelease) => [
  ...r.tracks.map(x => x.key), ...(r.cover ? [r.cover.key] : []),
  ...Object.values(r.textos || {}).filter(Boolean) as string[],
];

/**
 * Rechazado hace 7 dias o mas: fuera de la bandeja (KV y R2); el rechazo sigue
 * en preorder:rejected. Pendiente o sin decidir con 30 dias o mas desde que
 * entro: se borra el audio y el disco se queda, marcado. 30 dias despues de
 * borrarle el audio, fuera tambien (KV y la portada). Pre-order: intacto.
 */
export async function limpiaBandeja(env: ListenEnv, now: Date): Promise<{ rechazados: number; sin_audio: number; fuera: number; cargados: number }> {
  const out = { rechazados: 0, sin_audio: 0, fuera: 0, cargados: 0 };
  const t = now.getTime();
  // El bucket es el de prod tambien: solo se borra bajo el prefijo de este
  // entorno (staging: listen-staging/), diga lo que diga el registro.
  const pre = prefijo(env);
  const borra = async (keys: string[]) => {
    const mias = keys.filter(k => k.startsWith(pre) && !k.includes('..'));
    if (mias.length) await env.LISTEN_R2.delete(mias);
  };
  let cursor: string | undefined;
  do {
    const l: any = await env.SYNC_STATE.list({ prefix: REL_PREFIX, limit: 1000, cursor });
    for (const k of l.keys) {
      const m = k.metadata || {};
      const rechazadoViejo = m.x === 'rechazado' && t - Date.parse(m.dt) >= DIAS_RECHAZADO * DIA_MS;
      const cargadoViejo = m.x === 'cargado' && t - Date.parse(m.dt) >= DIAS_CARGADO * DIA_MS;
      const noElegido = !m.x || m.x === 'pendiente';
      const sinDecidirViejo = noElegido && m.n > 0 && t - Date.parse(m.at) >= DIAS_SIN_DECIDIR * DIA_MS;
      const sinAudioViejo = noElegido && !!m.al && t - Date.parse(m.al) >= DIAS_SIN_DECIDIR * DIA_MS;
      if (!rechazadoViejo && !sinDecidirViejo && !sinAudioViejo && !cargadoViejo) continue;
      const r = await env.SYNC_STATE.get<ListenRelease>(k.name, 'json');
      if (!r) continue;
      if (rechazadoViejo || sinAudioViejo || cargadoViejo) {
        // Solo la copia de la bandeja (LISTEN_R2): lo copiado a audio/ y covers/
        // es del producto y no se toca.
        await borra(clavesDe(r));
        await env.SYNC_STATE.delete(k.name);
        if (rechazadoViejo) out.rechazados++; else if (cargadoViejo) out.cargados++; else out.fuera++;
      } else {
        await borra(r.tracks.map(x => x.key));
        r.bytes -= r.tracks.reduce((s, x) => s + x.bytes, 0);
        r.tracks = [];
        r.audio_limpiado_at = now.toISOString();
        await guardaRelease(env, r);
        out.sin_audio++;
      }
    }
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  return out;
}

// ── decisiones ─────────────────────────────────────────────────

/**
 * POST ?action=listen-decide (Bearer) {clave, decision, tipo?}
 *   decision: preorder | pendiente | rechazado (con tipo temporal|definitivo) | null
 * Rechazar escribe el mismo preorder:rejected que el tab (filtro del 20-10);
 * salir de rechazado lo borra.
 */
/**
 * ¿Hay en la tienda un producto con ese handle? null si no se pudo saber.
 * productByIdentifier lee el producto directamente: el indice de busqueda
 * (products(query:)) tarda en ver lo recien importado por CSV, y aqui un falso
 * "no existe" borraria el audio de un producto vivo.
 */
export async function productoEnTienda(env: ListenEnv, handle: string): Promise<boolean | null> {
  try {
    const d = await shopifyAdminGraphQL(env as unknown as ShopifyAdminEnv,
      `query($h: String!) { productByIdentifier(identifier: { handle: $h }) { id } }`, { h: handle });
    if (!d?.data || d.errors?.length) return null;
    return d.data.productByIdentifier != null;
  } catch { return null; }
}

export async function handleListenDecide(request: Request, env: ListenEnv, autorizado: boolean, ahora = Date.now(),
  existeEnTienda: (handle: string) => Promise<boolean | null> = h => productoEnTienda(env, h)): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  const body: any = await request.json().catch(() => null);
  const clave = claveCatno(body?.clave);
  const decision = body?.decision ?? null;
  if (!clave) return json({ error: 'clave required' }, 400);
  // 'cargado' a mano solo con en_tienda: un elegido que ya esta en la tienda no
  // pasa por listen-promote (no hay nada que copiar) pero sale de Elegidos.
  const enTienda = String(body?.en_tienda || '').slice(0, 120);
  const cargadoEnTienda = decision === 'cargado' && !!enTienda;
  if (decision !== null && !DECISIONES.includes(decision) && !cargadoEnTienda) return json({ error: `decision must be ${DECISIONES.join(', ')} or null` }, 400);
  const r = await env.SYNC_STATE.get<ListenRelease>(REL_PREFIX + clave, 'json');
  if (!r) return json({ error: 'not found' }, 404);
  if (cargadoEnTienda && r.decision !== 'preorder') return json({ error: 'solo un elegido para pre-order pasa a cargado por estar en tienda' }, 409);

  // Deshacer una carga: vuelve a Elegidos. Lo copiado a audio/ y covers/ se
  // borra SOLO si ningun producto de la tienda lo usa (su handle no existe); si
  // existe, o no se puede comprobar, se queda (borrarlo dejaria el producto sin audio).
  let copias: { borradas: number; conservadas?: string } | undefined;
  if (r.decision === 'cargado' && decision !== 'cargado') {
    const mias = (r.promovidos || []).filter(k => {
      const a = env.LISTEN_PROMOTE_AUDIO_PREFIX || 'audio/', c = env.LISTEN_PROMOTE_COVERS_PREFIX || 'covers/';
      return (k.startsWith(a) || k.startsWith(c)) && !k.includes('..');
    });
    if (mias.length) {
      const existe = r.handle ? await existeEnTienda(r.handle) : null;
      if (existe === false) { await env.R2.delete(mias); copias = { borradas: mias.length }; }
      else copias = { borradas: 0, conservadas: existe ? `el producto ${r.handle} existe en la tienda` : 'no se pudo comprobar la tienda' };
    }
    delete r.cargado_at; delete r.handle; delete r.promovidos; delete r.en_tienda_como;
  }
  if (decision === 'rechazado') {
    const rec = nuevoRechazo({ catno: r.catno, tipo: body?.tipo, distribuidor: r.distribuidor.toLowerCase(), artist: r.artist, title: r.title }, ahora);
    if ('error' in rec) return json({ error: rec.error }, 400);
    await env.SYNC_STATE.put(claveKV(rec.catno), JSON.stringify(rec), { metadata: rec });
    r.rechazo = rec.tipo as 'temporal' | 'definitivo';
  } else {
    if (r.decision === 'rechazado') await env.SYNC_STATE.delete(claveKV(r.catno));
    delete r.rechazo;
  }
  if (decision) { r.decision = decision; r.decided_at = new Date(ahora).toISOString(); }
  else { delete r.decision; delete r.decided_at; }
  if (cargadoEnTienda) { r.cargado_at = r.decided_at; r.en_tienda_como = enTienda; }
  await guardaRelease(env, r);
  return json({ ok: true, item: { clave, decision: r.decision ?? null, decided_at: r.decided_at ?? null, rechazo: r.rechazo ?? null,
    cargado_at: r.cargado_at ?? null, en_tienda_como: r.en_tienda_como ?? null }, ...(copias ? { copias } : {}) });
}

// ── URLs firmadas ──────────────────────────────────────────────

const enc = new TextEncoder();

async function firma(secret: string, key: string, exp: number): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(`listen:v1\n${key}\n${exp}`));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function urlFirmada(env: ListenEnv, origin: string, key: string, now = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000) + SIGNED_TTL_S;
  const sig = await firma(env.BOOTSTRAP_AUTH_SECRET, key, exp);
  return `${origin}/?action=listen-file&k=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges' };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

/** GET ?action=listen-file&k&exp&sig — sin Bearer: la firma es la autorizacion. Soporta Range. */
export async function handleListenFile(request: Request, env: ListenEnv): Promise<Response> {
  const u = new URL(request.url);
  const key = u.searchParams.get('k') || '';
  const exp = Number(u.searchParams.get('exp') || 0);
  const sig = u.searchParams.get('sig') || '';
  if (!env.BOOTSTRAP_AUTH_SECRET || !key.startsWith(prefijo(env)) || key.includes('..')) return json({ error: 'forbidden' }, 403);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return json({ error: 'expired' }, 403);
  const real = enc.encode(await firma(env.BOOTSTRAP_AUTH_SECRET, key, exp));
  const dada = enc.encode(sig);
  const ok = real.byteLength === dada.byteLength && crypto.subtle.timingSafeEqual(real, dada);
  if (!ok) return json({ error: 'forbidden' }, 403);

  const obj = await env.LISTEN_R2.get(key, { range: request.headers });
  if (!obj) return json({ error: 'not found' }, 404);
  const headers = new Headers(CORS);
  obj.writeHttpMetadata(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, max-age=3600');
  headers.set('ETag', obj.httpEtag);
  const r = (obj as R2ObjectBody & { range?: R2Range }).range as any;
  if (r && request.headers.has('range')) {
    const offset = r.offset ?? (r.suffix !== undefined ? obj.size - r.suffix : 0);
    const length = r.length ?? (obj.size - offset);
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('Content-Length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { headers });
}

// ── lista para el admin ────────────────────────────────────────

// Vistas de la bandeja, sobre la metadata (x = decision), sin leer cada disco.
export const VISTAS: Record<string, (x?: string) => boolean> = {
  por_decidir: x => !x,
  pendientes: x => x === 'pendiente',
  elegidos: x => x === 'preorder',
  rechazados: x => x === 'rechazado',
  cargados: x => x === 'cargado',
};
const LIMIT_DEF = 30;
const LIMIT_MAX = 100;

async function conUrls(env: ListenEnv, origin: string, r: ListenRelease) {
  return {
    ...r,
    tracks: await Promise.all(r.tracks.map(async (t, i) => ({ name: nombreDePista(t.name, r.catno, i, r.artist), bytes: t.bytes, url: await urlFirmada(env, origin, t.key) }))),
    cover: r.cover ? { from: r.cover.from, url: await urlFirmada(env, origin, r.cover.key) } : null,
    textos: {
      promotext: r.textos?.promotext ? await urlFirmada(env, origin, r.textos.promotext) : null,
      salespaper: r.textos?.salespaper ? await urlFirmada(env, origin, r.textos.salespaper) : null,
    },
  };
}

/**
 * GET ?action=listen-list (Bearer) — una pagina de una vista, con URLs firmadas.
 *   vista   por_decidir (defecto) | pendientes | elegidos | rechazados
 *   limit   1..100 (defecto 30)    cursor  el `cursor` de la respuesta anterior
 *   claves  CLAVE,CLAVE... (max 100): esos discos, de cualquier vista; la
 *           bandeja lo usa para renovar las URLs de lo que tiene en la cola
 * Responde {items, count (de la vista), counts (de todas), cursor|null}.
 * La lista y los recuentos salen de la metadata (un list por 1000 discos);
 * solo se leen enteros los de la pagina.
 */
export async function handleListenList(request: Request, env: ListenEnv, autorizado: boolean): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  const u = new URL(request.url);
  const origin = u.origin;
  const lastRun = JSON.parse((await env.SYNC_STATE.get(LAST_RUN_KEY)) || 'null');
  // Para que el tab avise de que el CSV sale con el audio de pruebas (staging).
  const audioPre = env.LISTEN_PROMOTE_AUDIO_PREFIX || 'audio/';
  const modo = (await env.SYNC_STATE.get(MODE_KEY)) || 'off';   // el interruptor de ahora, no el de la ultima pasada
  const promote = {
    activo: (await env.SYNC_STATE.get(PROMOTE_KEY)) === 'on',
    audio: audioPre, covers: env.LISTEN_PROMOTE_COVERS_PREFIX || 'covers/',
    pruebas: audioPre !== 'audio/',
  };

  const pedidas = (u.searchParams.get('claves') || '').split(',').map(c => claveCatno(c)).filter(Boolean).slice(0, LIMIT_MAX);
  if (pedidas.length) {
    const recs = await Promise.all(pedidas.map(c => env.SYNC_STATE.get<ListenRelease>(REL_PREFIX + c, 'json')));
    const items = await Promise.all(recs.filter(Boolean).map(r => conUrls(env, origin, r!)));
    return json({ ok: true, count: items.length, expires_in: SIGNED_TTL_S, last_run: lastRun, modo, promote, items, cursor: null });
  }

  const vista = u.searchParams.get('vista') || 'por_decidir';
  if (!VISTAS[vista]) return json({ error: `vista must be ${Object.keys(VISTAS).join(', ')}` }, 400);
  const limit = Math.min(LIMIT_MAX, Math.max(1, Number(u.searchParams.get('limit')) || LIMIT_DEF));
  const desde = Math.max(0, Number(u.searchParams.get('cursor')) || 0);

  const todos: Array<{ name: string; m: any }> = [];
  let cursor: string | undefined;
  do {
    const l: any = await env.SYNC_STATE.list({ prefix: REL_PREFIX, limit: 1000, cursor });
    for (const k of l.keys) todos.push({ name: k.name, m: k.metadata || {} });
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  const counts = Object.fromEntries(Object.entries(VISTAS).map(([v, f]) => [v, todos.filter(k => f(k.m.x)).length]));
  // Lo mas nuevo primero; el cursor es la posicion en este orden.
  const deVista = todos.filter(k => VISTAS[vista](k.m.x))
    .sort((a, b) => String(b.m.at || '').localeCompare(String(a.m.at || '')) || a.name.localeCompare(b.name));
  const pagina = deVista.slice(desde, desde + limit);
  const recs = await Promise.all(pagina.map(k => env.SYNC_STATE.get<ListenRelease>(k.name, 'json')));
  const items = await Promise.all(recs.filter(Boolean).map(r => conUrls(env, origin, r!)));
  const sig = desde + limit < deVista.length ? String(desde + limit) : null;
  return json({ ok: true, vista, count: deVista.length, counts, expires_in: SIGNED_TTL_S, last_run: lastRun, modo, promote, items, cursor: sig });
}

// ── carga al Pre-order ─────────────────────────────────────────

// El mismo nombre que da el Process del tab a un MP3 de un ZIP.
const nombreProcess = (name: string) => `${name}.mp3`.replace(/[^A-Za-z0-9._-]+/g, '-');

/** Copia R2→R2 en streaming. El binding no tiene copy; put() quiere longitud conocida. */
async function copia(src: R2Bucket, key: string, dst: R2Bucket, destino: string): Promise<void> {
  const obj = await src.get(key);
  if (!obj) throw new Error(`no esta en la bandeja: ${key}`);
  const { readable, writable } = new FixedLengthStream(obj.size);
  const [, puesto] = await Promise.all([obj.body.pipeTo(writable), dst.put(destino, readable, { httpMetadata: obj.httpMetadata })]);
  if (!puesto) throw new Error(`no se pudo escribir ${destino}`);
}

/**
 * POST ?action=listen-promote (Bearer) {clave, safeKey, handle}
 * Lo llama el Process del tab para una fila _listen. COPIA las pistas y la
 * portada de la bandeja a audio/<safeKey>/ y covers/<safeKey>.<ext> de
 * houseonly-audio (prefijos LISTEN_PROMOTE_AUDIO_PREFIX / _COVERS_PREFIX; staging:
 * staging-audio/ y staging-covers/) con los nombres que daria el Process, y marca
 * el disco "cargado". Devuelve las URLs publicas para el CSV.
 */
export async function handleListenPromote(request: Request, env: ListenEnv, autorizado: boolean, publicBase: string, ahora = Date.now()): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  if ((await env.SYNC_STATE.get(PROMOTE_KEY)) !== 'on') return json({ error: `listen-promote apagado (${PROMOTE_KEY})` }, 403);
  const body: any = await request.json().catch(() => null);
  const clave = claveCatno(body?.clave);
  const safeKey = String(body?.safeKey || '');
  const handle = String(body?.handle || '').slice(0, 120);
  if (!clave) return json({ error: 'clave required' }, 400);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(safeKey)) return json({ error: 'safeKey invalido' }, 400);
  const r = await env.SYNC_STATE.get<ListenRelease>(REL_PREFIX + clave, 'json');
  if (!r) return json({ error: 'not found' }, 404);
  // Ya cargado: no se copia otra vez, pero un Process repetido recibe las mismas
  // URLs (si no, ese CSV saldria sin pistas). Orden de promovidos: pistas, portada.
  if (r.decision === 'cargado' && r.promovidos?.length) {
    const n = r.tracks.length;
    return json({
      ok: true, clave, ya_cargado: true, cargado_at: r.cargado_at, cover_from: r.cover?.from || null,
      tracks: r.tracks.map((t, i) => ({ name: nombreDePista(t.name, r.catno, i, r.artist), url: `${publicBase}/${r.promovidos![i]}` })),
      coverUrl: r.promovidos[n] ? `${publicBase}/${r.promovidos[n]}` : '',
    });
  }
  if (r.decision !== 'preorder') return json({ error: 'solo se cargan los elegidos para pre-order' }, 409);
  if (!r.tracks.length) return json({ error: 'sin audio en la bandeja' }, 409);

  const audioPre = env.LISTEN_PROMOTE_AUDIO_PREFIX || 'audio/';
  const coversPre = env.LISTEN_PROMOTE_COVERS_PREFIX || 'covers/';
  const promovidos: string[] = [];
  const tracks: Array<{ name: string; url: string }> = [];
  for (const [i, t] of r.tracks.entries()) {
    const destino = `${audioPre}${safeKey}/${nombreProcess(t.name)}`;
    await copia(env.LISTEN_R2, t.key, env.R2, destino);
    promovidos.push(destino);
    tracks.push({ name: nombreDePista(t.name, r.catno, i, r.artist), url: `${publicBase}/${destino}` });
  }
  let coverUrl = '';
  if (r.cover) {
    const ext = (r.cover.key.match(/\.(jpe?g|png|webp)$/i)?.[1] || 'jpg').toLowerCase().replace('jpeg', 'jpg');
    const destino = `${coversPre}${safeKey}.${ext}`;
    await copia(env.LISTEN_R2, r.cover.key, env.R2, destino);
    promovidos.push(destino);
    coverUrl = `${publicBase}/${destino}`;
  }
  const at = new Date(ahora).toISOString();
  Object.assign(r, { decision: 'cargado', decided_at: at, cargado_at: at, handle, promovidos });
  await guardaRelease(env, r);
  return json({ ok: true, clave, tracks, coverUrl, cover_from: r.cover?.from || null, cargado_at: at });
}

/**
 * POST ?action=listen-upload&clave=CLAVE (Bearer), cuerpo = ZIP (application/zip)
 * "Descarga manual": el audio de un disco que llego sin promopack (o con uno que
 * no servia) conseguido por otra via. Mismo tratamiento que el ZIP de la
 * ingesta: MP3, textos y portada si la trae (si no, se queda la del correo).
 * Sustituye el audio que hubiera. Tope: ZIP_MAX_BYTES.
 */
export async function handleListenUpload(request: Request, env: ListenEnv, autorizado: boolean, ahora = Date.now()): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  const clave = claveCatno(new URL(request.url).searchParams.get('clave'));
  if (!clave) return json({ error: 'clave required' }, 400);
  const r = await env.SYNC_STATE.get<ListenRelease>(REL_PREFIX + clave, 'json');
  if (!r) return json({ error: 'not found' }, 404);
  if (!request.body) return json({ error: 'falta el ZIP' }, 400);
  let zip: Uint8Array;
  try { zip = await leeConTope(request as unknown as Response, ZIP_MAX_BYTES); }
  catch (e) { if (e instanceof Demasiado) return json({ error: `ZIP demasiado grande (${e.message})` }, 413); throw e; }
  let lista: Array<{ name: string; size: number }>;
  try { lista = contenidoZip(zip); } catch { return json({ error: 'no es un ZIP valido' }, 400); }
  const f = eligeFicheros(lista);
  if (!f.mp3.length) return json({ error: 'el ZIP no trae MP3' }, 400);

  // Fuera el audio y los textos anteriores; la portada solo si el ZIP trae otra.
  const viejas = [...r.tracks.map(t => t.key), ...Object.values(r.textos || {}).filter(Boolean) as string[],
    ...(f.portada && r.cover ? [r.cover.key] : [])].filter(k => k.startsWith(prefijo(env)));
  if (viejas.length) await env.LISTEN_R2.delete(viejas);
  const cover = f.portada ? undefined : r.cover;
  const coverBytes = cover ? Math.max(0, r.bytes - r.tracks.reduce((s, t) => s + t.bytes, 0)) : 0;
  const nuevo: ListenRelease = { ...r, tracks: [], textos: undefined, cover, bytes: coverBytes, estado: 'listo',
    detalle: `audio subido a mano el ${new Date(ahora).toISOString().slice(0, 10)}`, subido_a_mano_at: new Date(ahora).toISOString() };
  delete nuevo.audio_limpiado_at;
  const subidas: string[] = [];
  try {
    await guardaDelZip(env, nuevo, zip, f, `${prefijo(env)}${clave}/`, subidas);
  } catch (e: any) {
    if (subidas.length) await env.LISTEN_R2.delete(subidas).catch(() => {});
    return json({ error: e?.message || String(e) }, 500);
  }
  await guardaRelease(env, nuevo);
  return json({ ok: true, item: await conUrls(env, new URL(request.url).origin, nuevo) });
}

// ── reparacion de los "sin ZIP" ────────────────────────────────

const REPARA_POR_PASADA = 6;
// Sube cuando la reparacion aprende algo nuevo, para que repase los ya
// reintentados: 2 = enlaces de la ficha sin "Download Zip" y el porque (04-11);
// 3 = MP3 sueltos de fett-distro.com (04-11); 4 = motivo sin dominios vacios (MO26);
// 5 = MP3 sueltos con el query de Mailchimp y de groovedis.com (04-11).
const REPARA_VERSION = 5;
const HAY_TRACKER = /https:\/\/([a-z0-9.-]*\.)?(list-manage\.com|mailchi\.mp)\//i;

export interface ListenRepairResult {
  intentados: number;
  por_estado: Partial<Record<ListenEstado, number>>;
  siguen_sin_zip: string[];      // "<catno>: <por que>" de los que siguen sin promopack
  sin_tracker: number;           // su correo no lleva enlaces de Mailchimp: no se tocan
  quedan: boolean;
  // La tanda siguiente empieza despues de esta clave. La lista de KV tarda en
  // ver la marca recien escrita (hasta 60 s): sin cursor, la tanda siguiente
  // repetia discos (SC1278, SC7095 y SS041 tres veces el 04-11).
  siguiente?: string;
}

/**
 * Los sin_zip que entraron cuando la ingesta seguia un solo salto del tracker
 * (hasta el 04-11): se reabre su correo y se reintenta el promopack. Se conserva
 * todo lo del disco (decision, fechas, resumen); solo cambian estado, audio,
 * portada y textos. Cada disco una vez (reparado_at), tope por llamada como la
 * ingesta: se repite mientras quedan=true.
 */
export async function reparaSinZip(env: ListenEnv, now = new Date(), despues = ''): Promise<ListenRepairResult> {
  const out: ListenRepairResult = { intentados: 0, por_estado: {}, siguen_sin_zip: [], sin_tracker: 0, quedan: false };
  let cursor: string | undefined;
  do {
    const l: any = await env.SYNC_STATE.list({ prefix: REL_PREFIX, limit: 1000, cursor });
    for (const k of l.keys) {
      // La lista de KV va en orden de clave: lo de tandas anteriores, fuera.
      if (despues && k.name <= despues) continue;
      const m = k.metadata || {};
      if (m.e !== 'sin_zip' || (m.rz || 0) >= REPARA_VERSION) continue;
      if (out.intentados >= REPARA_POR_PASADA) { out.quedan = true; return out; }
      const prev = await env.SYNC_STATE.get<ListenRelease>(k.name, 'json');
      if (!prev || prev.estado !== 'sin_zip' || (prev.reparado_v || 0) >= REPARA_VERSION) continue;
      out.siguiente = k.name;
      const reparado_at = now.toISOString();
      const html = await env.EMAILS.get(`msg:${prev.email}`);
      const rows: any[] = !html || !HAY_TRACKER.test(html) ? [] : filasDelEmail(prev.distribuidor, html, prev.email_date);
      const row = rows.find(r => claveCatno(r.catno) === prev.clave);
      if (!row) { out.sin_tracker++; await guardaRelease(env, { ...prev, reparado_at, reparado_v: REPARA_VERSION }); continue; }
      out.intentados++;
      const unDisco = !POR_FICHAS.has(prev.distribuidor) && new Set(rows.map(r => claveCatno(r.catno)).filter(Boolean)).size === 1;
      const email: IdxEntry = { name: prev.email, prefix: prev.distribuidor, subject: '', date: prev.email_date };
      const n = await ingiereDisco(env, row, email, prev.ingested_at, unDisco ? html! : undefined);
      await guardaRelease(env, {
        ...prev, estado: n.estado, detalle: n.detalle, zip_link: n.zip_link, tracks: n.tracks, bytes: n.bytes,
        cover: n.cover || prev.cover, textos: n.textos || prev.textos, reparado_at, reparado_v: REPARA_VERSION,
      });
      out.por_estado[n.estado] = (out.por_estado[n.estado] || 0) + 1;
      if (n.estado === 'sin_zip') out.siguen_sin_zip.push(`${prev.catno}: ${n.detalle}`);
    }
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  return out;
}

/** POST ?action=listen-repair[&despues=<clave>] (Bearer) — una tanda de reparacion de sin_zip. */
export async function handleListenRepair(env: ListenEnv, autorizado: boolean, request?: Request): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  const despues = request ? new URL(request.url).searchParams.get('despues') || '' : '';
  return json({ ok: true, ...(await reparaSinZip(env, new Date(), despues)) });
}

/** POST ?action=listen-run (Bearer) — una pasada a mano, aunque el modo no sea live. */
/**
 * Pasada a mano. Opcional, solo aqui (el cron no los usa): ?dias=N (1-14) amplia
 * la ventana de emails y ?fuente=DBH la limita a un distribuidor, para probar
 * una fuente nueva con sus emails de la ultima semana. Ojo: los Dropbox de
 * Rubadub de hace mas de 3 dias pueden haber caducado.
 */
export async function handleListenRun(env: ListenEnv, autorizado: boolean, request?: Request): Promise<Response> {
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  const q = request ? new URL(request.url).searchParams : new URLSearchParams();
  const dias = q.has('dias') ? Math.min(14, Math.max(1, Math.floor(Number(q.get('dias')) || 0))) : undefined;
  const fuente = (q.get('fuente') || '').toUpperCase();
  if (fuente && !LISTEN_SOURCES[fuente]) return json({ error: `fuente desconocida: ${fuente}` }, 400);
  return json({ ok: true, ...(await runListenIngest(env, { force: true, dias, fuente })) });
}
