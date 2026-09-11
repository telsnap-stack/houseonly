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
 * De donde salen los avisos. Comparte dominio con el newsletter porque es el
 * que esta verificado en Resend; la decision de darle su propia direccion
 * —para que una queja de spam no arrastre a la otra lista— esta abierta en
 * docs/entities.md.
 */
const ALERTS_FROM = 'House Only <newsletter@houseonly.store>';
const SITE = 'https://houseonly.store';

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
  asked: boolean;        // false = nunca se le ha preguntado; dispara el prompt
  email: string;
}

export async function getAlertsState(env: AlertsEnv, cid: string): Promise<AlertsState> {
  const raw = await env.ENTITIES.get(K.follow(cid));
  if (!raw) return { emailAlerts: false, asked: false, email: '' };
  try {
    const f = JSON.parse(raw);
    return {
      emailAlerts: f.emailAlerts === true,
      asked: typeof f.emailAlerts === 'boolean',
      email: String(f.email || ''),
    };
  } catch {
    return { emailAlerts: false, asked: false, email: '' };
  }
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

export interface DigestGroup {
  slug: string;
  display: string;
  items: IndexedProduct[];
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
export async function buildDigests(
  env: AlertsEnv, opts: { sinceMs: number; now?: number } = { sinceMs: 24 * 60 * 60 * 1000 },
): Promise<Digest[]> {
  const now = opts.now ?? Date.now();
  const desde = now - opts.sinceMs;
  const idx = await getCatalogIndex(env, now);
  const nuevos = idx.items.filter(p => Date.parse(p.createdAt) >= desde);
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

    const groups: DigestGroup[] = [];
    for (const [slug, items] of porEntidad) {
      const e = await getEntity(env as any, slug);
      if (!e) continue;
      items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      groups.push({ slug, display: e.display, items });
    }
    if (!groups.length) continue;
    groups.sort((a, b) => b.items.length - a.items.length || a.display.localeCompare(b.display));
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
            <div style="padding-top:6px;font-size:13px;color:#efefef;">${precio(p)}${p.forthcoming ? ' · <span style="color:#c8ff00;font-weight:700;">PRE-ORDER</span>' : ''}</div>
          </td>
        </tr>
      </table>`).join('')}`);
  }

  const sobran = d.total - Math.min(d.total, MAX_PER_EMAIL);
  const cola = sobran > 0
    ? `<p style="color:#585858;font-size:13px;margin:20px 0 0;">Y ${sobran} más — <a href="${SITE}/account" style="color:#c8ff00;">míralo en tus estanterías</a>.</p>`
    : '';

  return `<!doctype html><html><body style="margin:0;background:#080808;font-family:Inter,system-ui,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <p style="font-size:22px;font-weight:900;letter-spacing:-1px;color:#efefef;margin:0 0 4px;">HOUSE<span style="color:#c8ff00;">ONLY</span></p>
    <p style="color:#585858;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 20px;">New from who you follow</p>
    ${bloques.join('')}
    ${cola}
    <p style="border-top:1px solid #1e1e1e;margin:34px 0 0;padding-top:18px;color:#585858;font-size:11px;line-height:1.7;">
      Te llega esto porque sigues a estos artistas o sellos en House Only.
      <a href="${esc(unsubUrl)}" style="color:#585858;">Dejar de recibir avisos</a>.
      No afecta a tu suscripción al newsletter.
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

async function enviar(env: AlertsEnv, to: string, subject: string, html: string): Promise<void> {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: ALERTS_FROM, to, subject, html }),
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
      await enviar(env, destino, alertSubject(d), renderAlertEmail(d, unsub));
      res.sent++;
      res.recipients.push(mode === 'test' ? `${destino} (por ${d.cid})` : d.cid);
    } catch (e: any) {
      res.failed++;
      res.errors.push(`${d.cid}: ${e?.message || e}`);
    }
  }
  return res;
}
