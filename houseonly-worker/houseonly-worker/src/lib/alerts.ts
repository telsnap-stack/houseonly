/**
 * Avisos de novedades para quien sigue artistas y sellos — fase 6 de
 * docs/entities.md.
 *
 * Seguir a alguien sin que te avise es una lista de deseos con otro nombre.
 * Esto es lo que hace que el follow devuelva valor solo.
 */

import { getEntity } from './entities';
import {
  loadFollows, getCatalogIndex, type FollowsEnv, type IndexedProduct,
} from './follows';

export interface AlertsEnv extends FollowsEnv {
  RESEND_API_KEY: string;
}

/**
 * Direccion propia, no la del newsletter: si alguien marca un aviso como spam,
 * no arrastra la reputacion de la otra lista. El dominio ya esta verificado en
 * Resend, asi que basta con el buzon.
 *
 * El reply-to es un buzon que no se lee, y el pie lo dice: contestar a un aviso
 * automatico no llega a ninguna parte, y lo que la gente quiere preguntar —"se
 * agoto, me lo consigues?"— tiene su propio sitio en la ficha del disco.
 */
const ALERTS_FROM = 'House Only <alerts@houseonly.store>';
const ALERTS_REPLY_TO = 'no-reply@houseonly.store';
const SITE = 'https://houseonly.store';
/** El logo del sitio, rasterizado a 3x. SVG no vale: Gmail lo descarta. */
const LOGO_URL = 'https://pub-7e5c9e2f45b3409383e7f23a2cb7028d.r2.dev/brand/houseonly-logo.png';

/** Tope de discos por correo. Lo que pase de ahi se resume en un "y N mas". */
export const MAX_PER_EMAIL = 20;

const K = {
  follow: (cid: string) => `follow:${cid}`,
  fanout: (slug: string) => `fanout:${slug}:`,
  sent: (cid: string, dia: string) => `alertsent:${cid}:${dia}`,
  token: (t: string) => `alerttoken:${t}`,
  mode: 'meta:follow_alerts_mode',
};

/** 60 dias: suficiente para depurar un envio raro, no para siempre. */
const SENT_TTL_S = 60 * 24 * 60 * 60;

export type AlertsMode = 'off' | 'test' | 'live';

export async function getMode(env: AlertsEnv): Promise<AlertsMode> {
  const v = await env.ENTITIES.get(K.mode);
  return v === 'live' || v === 'test' ? v : 'off';
}

export async function setMode(env: AlertsEnv, mode: AlertsMode): Promise<void> {
  await env.ENTITIES.put(K.mode, mode);
}

// ── CONSENTIMIENTO ──────────────────────────────────────────────────

function tokenNuevo(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

export interface AlertsState {
  emailAlerts: boolean;
  asked: boolean;        // false = nunca se le ha preguntado
  email: string;
  /** true = toca ofrecerselo al seguir a alguien. Lo decide el servidor. */
  prompt: boolean;
}

/**
 * Descanso entre recordatorios. Seguir a alguien con los avisos apagados es
 * justo el momento de ofrecerlos —acaba de decir que le importa ese artista—,
 * pero preguntarlo en cada alta es un fastidio y acaba en "no" permanente.
 * Un mes: suficiente para que se note el hueco, poco para que se olvide.
 */
export const PROMPT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export async function getAlertsState(env: AlertsEnv, cid: string, now = Date.now()): Promise<AlertsState> {
  const raw = await env.ENTITIES.get(K.follow(cid));
  if (!raw) return { emailAlerts: false, asked: false, email: '', prompt: true };
  try {
    const f = JSON.parse(raw);
    const on = f.emailAlerts === true;
    // El ultimo contacto sobre esto: la respuesta que dio, o el recordatorio
    // que aparto sin contestar.
    const ultimo = Math.max(Number(f.emailAlertsAt || 0), Number(f.alertsPromptAt || 0));
    return {
      emailAlerts: on,
      asked: typeof f.emailAlerts === 'boolean',
      email: String(f.email || ''),
      prompt: !on && (!ultimo || now - ultimo >= PROMPT_COOLDOWN_MS),
    };
  } catch {
    return { emailAlerts: false, asked: false, email: '', prompt: true };
  }
}

/**
 * "Ahora no" sin contestar: aparta el recordatorio sin tocar la preferencia.
 * Sin esto, cerrar el aviso lo devolvia en el siguiente follow de la misma
 * sesion, que es exactamente el fastidio que se quiere evitar.
 */
export async function snoozeAlertsPrompt(env: AlertsEnv, cid: string, now = Date.now()): Promise<{ ok: true }> {
  const raw = await env.ENTITIES.get(K.follow(cid));
  if (!raw) return { ok: true };
  let f: any;
  try { f = JSON.parse(raw); } catch { return { ok: true }; }
  f.alertsPromptAt = now;
  await env.ENTITIES.put(K.follow(cid), JSON.stringify(f));
  return { ok: true };
}

/**
 * Guarda la decision. El correo se guarda SOLO al decir que si, y es
 * imprescindible: el envio lo hace un cron sin sesion de nadie, y ahi el worker
 * no puede averiguar el correo de un cliente —la Customer Account API lo da solo
 * con sesion, y la Admin API nos lo niega por falta de scope—.
 */
export async function setEmailAlerts(
  env: AlertsEnv, cid: string, enabled: boolean, email = '',
): Promise<{ ok: true; emailAlerts: boolean }> {
  const raw = await env.ENTITIES.get(K.follow(cid));
  let f: any = { entities: [], updatedAt: 0 };
  try { if (raw) f = JSON.parse(raw); } catch { /* se reescribe */ }

  f.emailAlerts = enabled;
  f.emailAlertsAt = Date.now();
  if (enabled && email) f.email = email;
  if (enabled && !f.alertToken) {
    f.alertToken = tokenNuevo();
    await env.ENTITIES.put(K.token(f.alertToken), cid);
  }
  await env.ENTITIES.put(K.follow(cid), JSON.stringify(f));
  return { ok: true, emailAlerts: enabled };
}

/** El correo guardado se refresca cuando el cliente pasa por el portal. */
export async function refreshStoredEmail(env: AlertsEnv, cid: string, email: string): Promise<void> {
  if (!email) return;
  const raw = await env.ENTITIES.get(K.follow(cid));
  if (!raw) return;
  try {
    const f = JSON.parse(raw);
    if (f.emailAlerts === true && f.email !== email) {
      f.email = email;
      await env.ENTITIES.put(K.follow(cid), JSON.stringify(f));
    }
  } catch { /* nada que refrescar */ }
}

/** Baja por el enlace del correo. Apaga los avisos y NADA MAS: el newsletter no se toca. */
export async function unsubscribeByToken(env: AlertsEnv, token: string): Promise<boolean> {
  const t = String(token || '').trim();
  if (!t) return false;
  const cid = await env.ENTITIES.get(K.token(t));
  if (!cid) return false;
  await setEmailAlerts(env, cid, false);
  return true;
}

// ── QUE MANDAR ──────────────────────────────────────────────────────

/**
 * Un disco dentro del correo. `alsoFrom` lleva las demas entidades seguidas
 * que tambien lo traen: el disco sale una sola vez, y debajo se dice quien mas
 * lo trae en vez de repetirlo bajo cada una.
 */
export interface DigestItem extends IndexedProduct {
  alsoFrom?: string[];
}

export interface DigestGroup {
  slug: string;
  display: string;
  items: DigestItem[];
}

export interface Digest {
  cid: string;
  email: string;
  token: string;
  groups: DigestGroup[];
  total: number;
}

/**
 * Quien recibe que. Se parte de los productos NUEVOS y se sube por el indice
 * inverso —`fanout:{slug}:*`— en vez de recorrer cliente por cliente: si hoy no
 * ha salido nada de una entidad, sus seguidores no se tocan.
 *
 * Los pre-orders cuentan como novedad: son justo lo que alguien quiere saber
 * antes que nadie.
 */
const cuandoOrden = (p: IndexedProduct) => Date.parse(p.publishedAt || p.createdAt);

/**
 * Un disco con dos seguidos detras —el artista y su sello, o dos artistas del
 * mismo disco— se cuenta UNA vez. Quien se lo queda: el artista seguido, que es
 * a quien se sigue de verdad; el sello recoge lo que no trae artista seguido.
 * A igualdad manda el orden del propio disco, asi que el primer artista de la
 * ficha va antes que el segundo.
 *
 * El rango 1 es para el seguido que no aparece en las columnas del disco: pasa
 * con el sello padre, que recibe lo del sub-sello sin figurar en el.
 */
function rangoDueno(slug: string, p: IndexedProduct, ents: Map<string, any>): [number, number, string] {
  const display = String(ents.get(slug)?.display || slug);
  const ia = p.artistSlugs.indexOf(slug);
  if (ia >= 0) return [0, ia, display];
  if ((ents.get(slug)?.roles || []).includes('artist')) return [1, 0, display];
  const il = p.labelSlugs.indexOf(slug);
  if (il >= 0) return [2, il, display];
  return [3, 0, display];
}

function antes(a: [number, number, string], b: [number, number, string]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
}

export async function buildDigests(
  env: AlertsEnv, opts: { sinceMs: number; now?: number } = { sinceMs: 24 * 60 * 60 * 1000 },
): Promise<Digest[]> {
  const now = opts.now ?? Date.now();
  const desde = now - opts.sinceMs;
  const idx = await getCatalogIndex(env, now);
  // Novedad = cuando se PUBLICO. Un disco creado como borrador y publicado una
  // semana despues es novedad el dia que el cliente puede verlo. Si Shopify no
  // da publishedAt —producto viejo, o sin publicar— manda createdAt.
  const cuando = (p: IndexedProduct) => Date.parse(p.publishedAt || p.createdAt);
  const nuevos = idx.items.filter(p => cuando(p) >= desde);
  if (!nuevos.length) return [];

  // slug efectivo → { display, productos }
  const porSlug = new Map<string, IndexedProduct[]>();
  for (const p of nuevos) {
    for (const s of new Set([...p.artistSlugs, ...p.labelSlugs])) {
      if (!porSlug.has(s)) porSlug.set(s, []);
      porSlug.get(s)!.push(p);
    }
  }

  // cid → slug seguido → productos
  const porCliente = new Map<string, Map<string, IndexedProduct[]>>();
  const apuntar = async (slug: string, productos: IndexedProduct[], slugSeguido: string) => {
    const l = await env.ENTITIES.list({ prefix: K.fanout(slugSeguido) });
    for (const k of l.keys) {
      const cid = k.name.slice(K.fanout(slugSeguido).length);
      if (!cid) continue;
      if (!porCliente.has(cid)) porCliente.set(cid, new Map());
      const suyo = porCliente.get(cid)!;
      const prev = suyo.get(slugSeguido) || [];
      for (const p of productos) if (!prev.some(x => x.handle === p.handle)) prev.push(p);
      suyo.set(slugSeguido, prev);
    }
    void slug;
  };

  for (const [slug, productos] of porSlug) {
    await apuntar(slug, productos, slug);
    // Expansion hacia ARRIBA: quien sigue al sello padre recibe lo del sub-sello.
    const e = await getEntity(env as any, slug);
    if (e?.parent) await apuntar(slug, productos, e.parent);
  }

  const out: Digest[] = [];
  for (const [cid, porEntidad] of porCliente) {
    const raw = await env.ENTITIES.get(K.follow(cid));
    if (!raw) continue;
    let f: any;
    try { f = JSON.parse(raw); } catch { continue; }
    if (f.emailAlerts !== true || !f.email) continue;

    // La entidad de cada seguido, una sola lectura por slug.
    const ents = new Map<string, any>();
    for (const slug of porEntidad.keys()) {
      const e = await getEntity(env as any, slug);
      if (e) ents.set(slug, e);
    }

    // handle -> seguidos que lo traen, el dueno primero.
    const traenPor = new Map<string, string[]>();
    for (const [slug, items] of porEntidad) {
      if (!ents.has(slug)) continue;
      for (const p of items) {
        const l = traenPor.get(p.handle) || [];
        l.push(slug);
        traenPor.set(p.handle, l);
      }
    }
    for (const [handle, slugs] of traenPor) {
      const p = porEntidad.get(slugs[0])!.find(x => x.handle === handle)!;
      slugs.sort((a, b) => antes(rangoDueno(a, p, ents), rangoDueno(b, p, ents)));
    }

    const groups: DigestGroup[] = [];
    for (const [slug, items] of porEntidad) {
      const e = ents.get(slug);
      if (!e) continue;
      const mios: DigestItem[] = items
        .filter(p => traenPor.get(p.handle)![0] === slug)
        .map(p => {
          const otras = traenPor.get(p.handle)!.slice(1)
            .map(s => String(ents.get(s)?.display || s));
          return otras.length ? { ...p, alsoFrom: otras } : p;
        });
      if (!mios.length) continue;
      mios.sort((a, b) => cuandoOrden(b) - cuandoOrden(a));
      groups.push({ slug, display: e.display, items: mios });
    }
    if (!groups.length) continue;
    groups.sort((a, b) => b.items.length - a.items.length || a.display.localeCompare(b.display));
    // El total cuenta discos, no apariciones: es lo que promete el asunto.
    out.push({
      cid, email: f.email, token: String(f.alertToken || ''),
      groups, total: groups.reduce((n, g) => n + g.items.length, 0),
    });
  }
  return out;
}

// ── EL CORREO ───────────────────────────────────────────────────────

const esc = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const precio = (p: IndexedProduct) => p.price ? `€${Number(p.price).toFixed(2)}` : '';

/** "A", "A and B", "A, B and C" — se lee como lo diria una persona. */
export function listaEn(xs: string[]): string {
  if (xs.length <= 1) return xs[0] || '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/**
 * Mismo criterio que la tienda para decidir el boton: con stock se compra, y un
 * agotado solo admite peticion si es reciente —el año del disco es lo que lo
 * decide, igual que en isBackorderEligible() de App.jsx—. Un agotado viejo no
 * puede decir "Request a copy", porque al llegar a la ficha no habria formulario.
 */
export function ctaFor(p: IndexedProduct, now = Date.now()): { label: string; backorder: boolean } {
  if (p.stock > 0 || p.forthcoming) return { label: 'View record', backorder: false };
  const elegible = p.year > 0 && p.year >= new Date(now).getFullYear() - 1;
  return elegible ? { label: 'Request a copy', backorder: true } : { label: 'View record', backorder: false };
}

export function renderAlertEmail(d: Digest, unsubUrl: string): string {
  let restantes = MAX_PER_EMAIL;
  const bloques: string[] = [];

  for (const g of d.groups) {
    if (restantes <= 0) break;
    const items = g.items.slice(0, restantes);
    restantes -= items.length;
    bloques.push(`
      <p style="color:#c8ff00;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;margin:28px 0 12px;">${esc(g.display)}</p>
      ${items.map(p => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;">
        <tr>
          <td width="72" valign="top">
            <a href="${SITE}/products/${esc(p.slug)}/"><img src="${esc((p.imageUrl || '').split('?')[0])}?width=144" width="72" height="72" alt="" style="display:block;border-radius:2px;object-fit:cover;"></a>
          </td>
          <td valign="top" style="padding-left:14px;">
            <a href="${SITE}/products/${esc(p.slug)}/" style="color:#efefef;text-decoration:none;font-size:15px;font-weight:700;">${esc(p.title)}</a>
            <div style="color:#585858;font-size:13px;padding-top:3px;">${esc(p.vendor)}</div>
            ${p.alsoFrom?.length ? `<div style="color:#585858;font-size:12px;padding-top:2px;">also from ${esc(listaEn(p.alsoFrom))}</div>` : ''}
            <div style="padding-top:6px;font-size:13px;color:#efefef;">${precio(p)}${p.forthcoming ? ' · <span style="color:#c8ff00;font-weight:700;">PRE-ORDER</span>' : ''}</div>
            <div style="padding-top:9px;">
              <a href="${SITE}/products/${esc(p.slug)}/" style="display:inline-block;border:1px solid ${ctaFor(p).backorder ? '#c8ff00' : '#1e1e1e'};color:${ctaFor(p).backorder ? '#c8ff00' : '#efefef'};text-decoration:none;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:6px 11px;border-radius:2px;">${ctaFor(p).label}</a>
            </div>
          </td>
        </tr>
      </table>`).join('')}`);
  }

  const sobran = d.total - Math.min(d.total, MAX_PER_EMAIL);
  // Siempre hay salida al portal, no solo cuando el correo se corta: desde ahi
  // se ve todo lo de cada entidad, no solo lo de hoy.
  const cola = `
    <p style="margin:26px 0 0;">
      <a href="${SITE}/account" style="display:inline-block;border:1px solid #1e1e1e;color:#efefef;text-decoration:none;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:9px 14px;border-radius:2px;">See all in your account</a>
    </p>
    ${sobran > 0 ? `<p style="color:#585858;font-size:12px;margin:12px 0 0;">And ${sobran} more not shown here.</p>` : ''}`;

  return `<!doctype html><html><body style="margin:0;background:#080808;font-family:Inter,system-ui,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <!-- El logo de la tienda, el mismo SVG del sitio rasterizado a 3x y servido
         desde R2. El alt NO es decorativo: muchos clientes de correo bloquean
         imagenes por defecto, y con el bloqueo puesto lo que se lee es esto. -->
    <p style="margin:0 0 6px;">
      <img src="${LOGO_URL}" width="160" height="52" alt="HOUSE ONLY"
        style="display:block;border:0;outline:none;text-decoration:none;width:160px;height:auto;">
    </p>
    <p style="color:#585858;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 20px;">New from who you follow</p>
    ${bloques.join('')}
    ${cola}
    <p style="border-top:1px solid #1e1e1e;margin:34px 0 0;padding-top:18px;color:#585858;font-size:11px;line-height:1.7;">
      Don't reply to this email. Sold out? Request a copy from the record page.
      <br><br>
      You're getting this because you follow these artists or labels at House Only.
      Your newsletter subscription isn't affected.
    </p>
    <p style="margin:12px 0 0;">
      <a href="${esc(unsubUrl)}" style="color:#efefef;font-size:11px;text-decoration:underline;">Stop these alerts</a>
    </p>
  </div></body></html>`;
}

export function alertSubject(d: Digest): string {
  const primero = d.groups[0];
  if (!primero) return 'New from who you follow';
  if (d.groups.length === 1 && primero.items.length === 1) {
    return `${primero.display}: ${primero.items[0].title}`;
  }
  if (d.groups.length === 1) return `${primero.display}: ${primero.items.length} new records`;
  return `${primero.display} and ${d.groups.length - 1} more — ${d.total} new records`;
}

// ── EL ENVIO ────────────────────────────────────────────────────────

export interface RunSummary {
  mode: AlertsMode;
  window_hours: number;
  digests: number;
  sent: number;
  skipped_already_sent: number;
  failed: number;
  recipients: string[];
  errors: string[];
}

async function enviar(env: AlertsEnv, to: string, subject: string, html: string, unsubUrl: string): Promise<void> {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: ALERTS_FROM, to, subject, html, reply_to: ALERTS_REPLY_TO,
      // Baja de un clic desde el propio cliente de correo. Gmail y Outlook la
      // pintan junto al remitente, y tenerla reduce las marcas de spam: quien
      // quiere irse se va por la puerta en vez de reportar.
      // Exige que la URL acepte POST, y la acepta.
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 160)}`);
}

/**
 * La tanda diaria.
 *
 * En `test` calcula todo de verdad pero manda a una sola direccion y NO escribe
 * el registro, asi que se puede repetir sin quedarse sin clientes que probar.
 */
export async function runFollowAlerts(
  env: AlertsEnv,
  opts: { mode?: AlertsMode; testTo?: string; sinceMs?: number; now?: number; workerUrl?: string } = {},
): Promise<RunSummary> {
  const mode = opts.mode || await getMode(env);
  const sinceMs = opts.sinceMs ?? 24 * 60 * 60 * 1000;
  const now = opts.now ?? Date.now();
  const dia = new Date(now).toISOString().slice(0, 10);
  const base = opts.workerUrl || '';

  const res: RunSummary = {
    mode, window_hours: Math.round(sinceMs / 3600000),
    digests: 0, sent: 0, skipped_already_sent: 0, failed: 0, recipients: [], errors: [],
  };
  if (mode === 'off') return res;

  const digests = await buildDigests(env, { sinceMs, now });
  res.digests = digests.length;

  for (const d of digests) {
    if (mode === 'live') {
      // El registro se escribe ANTES de mandar. Si el envio falla, ese cliente
      // se queda sin aviso hoy; de los dos errores posibles, no avisar es el
      // barato. Avisar dos veces se paga con una baja.
      const ya = await env.ENTITIES.get(K.sent(d.cid, dia));
      if (ya) { res.skipped_already_sent++; continue; }
      await env.ENTITIES.put(K.sent(d.cid, dia), '1', { expirationTtl: SENT_TTL_S });
    }

    const destino = mode === 'test' ? (opts.testTo || '') : d.email;
    if (!destino) { res.failed++; res.errors.push(`${d.cid}: sin destino`); continue; }

    const unsub = `${base}/?action=follow-alerts-unsubscribe&t=${encodeURIComponent(d.token)}`;
    try {
      await enviar(env, destino, alertSubject(d), renderAlertEmail(d, unsub), unsub);
      res.sent++;
      res.recipients.push(mode === 'test' ? `${destino} (por ${d.cid})` : d.cid);
    } catch (e: any) {
      res.failed++;
      res.errors.push(`${d.cid}: ${e?.message || e}`);
    }
  }
  return res;
}
