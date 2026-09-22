/**
 * Stuck-sale alerts for the Discogs → Shopify sync.
 *
 * Every stuck sale so far was found by Eduardo looking at Discogs, hours or
 * days later (147628-C-22, C-30, C-31). ?action=sync-pending knew each time,
 * but nobody reads a URL. This sends ONE email per poll listing whatever newly
 * needs a human:
 *
 *   oversold  — a Discogs sale for a record with no Shopify stock. Immediate.
 *   stuck     — a firm sale still not a Shopify order after STUCK_AFTER_MS.
 *   poll      — the poll itself has failed POLL_FAIL_ALERT_STREAK runs in a row.
 *
 * Each order/kind alerts once (alerted:{order}:{kind}, 30d), marked only AFTER
 * Resend accepted the email, so a failed send retries on the next poll.
 * Recipient lives in KV (meta:sync_alert_to) — no address in code; unset means
 * nothing is sent and the poll result says so.
 */

export interface SyncAlertEnv {
  SYNC_STATE: KVNamespace;
  RESEND_API_KEY?: string;
}

export const STUCK_AFTER_MS = 60 * 60 * 1000;
// 8 × 15 min = 2 h of polls dying on getOrders before anyone hears about it.
export const POLL_FAIL_ALERT_STREAK = 8;
const ALERT_MARK_TTL = 30 * 24 * 60 * 60;
const POLL_ALERT_MARK_TTL = 6 * 60 * 60;
const FROM = 'House Only <alerts@houseonly.store>';
const REPLY_TO = 'no-reply@houseonly.store';

export interface SyncAlert {
  kind: 'oversold' | 'stuck' | 'poll';
  order_id?: string;
  reason: string;
  items?: Array<{ title?: string; sku?: string | null }>;
  first_detected_at?: string;
  attempts?: number;
}

export interface SyncAlertSummary {
  found: number;
  sent: boolean;
  to?: string;
  skipped_reason?: string;
  error?: string;
}

/** What needs a human now and has not been alerted yet. */
export async function collectSyncAlerts(env: SyncAlertEnv, nowMs = Date.now()): Promise<SyncAlert[]> {
  const alerts: SyncAlert[] = [];
  const { keys } = await env.SYNC_STATE.list({ prefix: 'sales-detected:' });
  for (const k of keys) {
    const raw = await env.SYNC_STATE.get(k.name);
    if (!raw) continue;
    let a: any;
    try { a = JSON.parse(raw); } catch { continue; }
    const oc = a.order_creation || {};
    if (oc.ok || oc.closed) continue;
    const orderId = String(a.order_id || k.name.slice('sales-detected:'.length));

    let kind: SyncAlert['kind'] | null = null;
    if (oc.oversold) kind = 'oversold';
    else {
      const first = Date.parse(a.first_detected_at || '');
      if (Number.isFinite(first) && nowMs - first >= STUCK_AFTER_MS) kind = 'stuck';
    }
    if (!kind) continue;
    if (await env.SYNC_STATE.get(`alerted:${orderId}:${kind}`)) continue;

    alerts.push({
      kind,
      order_id: orderId,
      reason: String(oc.error || 'unknown'),
      items: (a.items || []).map((i: any) => ({ title: i.release_title, sku: i.sku })),
      first_detected_at: a.first_detected_at,
      attempts: a.attempts,
    });
  }

  const streak = Number(await env.SYNC_STATE.get('meta:poll_fail_streak') || '0');
  if (streak >= POLL_FAIL_ALERT_STREAK && !(await env.SYNC_STATE.get('alerted:poll-failing'))) {
    const last = await env.SYNC_STATE.get('meta:last_poll_result');
    let err = '';
    try { err = (JSON.parse(last || '{}').errors || [])[0] || ''; } catch { /* ignore */ }
    alerts.push({
      kind: 'poll',
      reason: `the Discogs poll has failed ${streak} runs in a row${err ? `: ${String(err).slice(0, 200)}` : ''}`,
    });
  }
  return alerts;
}

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const HEADLINE: Record<SyncAlert['kind'], string> = {
  oversold: 'OVERSOLD — no stock in Shopify, no order created. Cancel on Discogs or restock.',
  stuck: 'Not synced after 1 hour — no Shopify order yet.',
  poll: 'The sync itself is failing.',
};

export function renderSyncAlertEmail(alerts: SyncAlert[]): { subject: string; html: string } {
  const oversold = alerts.filter((a) => a.kind === 'oversold').length;
  const orders = alerts.filter((a) => a.order_id).length;
  const subject = oversold
    ? `Discogs sync: ${oversold} oversold order${oversold > 1 ? 's' : ''} need action`
    : orders
      ? `Discogs sync: ${orders} order${orders > 1 ? 's' : ''} not in Shopify`
      : 'Discogs sync is failing';
  const blocks = alerts.map((a) => {
    const link = a.order_id
      ? `<a href="https://www.discogs.com/sell/order/${encodeURIComponent(a.order_id)}" style="color:#c8ff00">${esc(a.order_id)}</a>`
      : 'Sync';
    const items = (a.items || [])
      .map((i) => `<li>${esc(i.title || '?')}${i.sku ? ` — <code>${esc(i.sku)}</code>` : ''}</li>`)
      .join('');
    const meta = a.order_id
      ? `<div style="color:#888;font-size:12px">first seen ${esc(a.first_detected_at)} · ${esc(a.attempts)} attempts</div>`
      : '';
    return `<div style="margin:0 0 18px"><div><strong>${link}</strong> — ${esc(HEADLINE[a.kind])}</div>`
      + (items ? `<ul style="margin:6px 0">${items}</ul>` : '')
      + `<div style="font-size:13px">${esc(a.reason)}</div>${meta}</div>`;
  }).join('');
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45">${blocks}`
    + `<div style="color:#888;font-size:12px">Details: ?action=sync-pending on the worker.</div></div>`;
  return { subject, html };
}

/** Collect, send one email, mark what was sent. Never throws. */
export async function sendSyncAlerts(env: SyncAlertEnv, nowMs = Date.now()): Promise<SyncAlertSummary> {
  let alerts: SyncAlert[];
  try {
    alerts = await collectSyncAlerts(env, nowMs);
  } catch (e: any) {
    return { found: 0, sent: false, error: `collect failed: ${e?.message || e}` };
  }
  if (alerts.length === 0) return { found: 0, sent: false };

  const to = ((await env.SYNC_STATE.get('meta:sync_alert_to')) || '').trim();
  if (!to) return { found: alerts.length, sent: false, skipped_reason: 'meta:sync_alert_to not set' };
  if (!env.RESEND_API_KEY) return { found: alerts.length, sent: false, skipped_reason: 'RESEND_API_KEY not set' };

  const { subject, html } = renderSyncAlertEmail(alerts);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM, to, subject, html, reply_to: REPLY_TO }),
    });
    if (!r.ok) {
      return { found: alerts.length, sent: false, to, error: `resend ${r.status}: ${(await r.text()).slice(0, 160)}` };
    }
  } catch (e: any) {
    return { found: alerts.length, sent: false, to, error: `resend failed: ${e?.message || e}` };
  }

  for (const a of alerts) {
    if (a.kind === 'poll') {
      await env.SYNC_STATE.put('alerted:poll-failing', new Date(nowMs).toISOString(), { expirationTtl: POLL_ALERT_MARK_TTL });
    } else {
      await env.SYNC_STATE.put(`alerted:${a.order_id}:${a.kind}`, new Date(nowMs).toISOString(), { expirationTtl: ALERT_MARK_TTL });
    }
  }
  return { found: alerts.length, sent: true, to };
}
