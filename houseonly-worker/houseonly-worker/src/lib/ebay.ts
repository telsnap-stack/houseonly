// ── EBAY: THIRD SALES CHANNEL ────────────────────────────────────────
//
// Mirrors the Discogs channel (sync.ts) without sharing a single switch with
// it. Full runbook: docs/ebay.md.
//
// 1. AUTO-LIST. Automatic, not hand-picked:
//    - every new Shopify product (products/create — the same webhook as the
//      Discogs auto-add) is queued while meta:ebay_autolist_mode is live;
//    - the existing catalogue is queued by ?action=ebay-backfill, in batches
//      (first one small, capped by the monthly selling limit).
//    The admin's eBay tab shows the queue and can exclude / re-add a record;
//    an excluded record is never re-queued by the webhook or the backfill.
//    The eBay cron (EBAY_CRON, its own expression) walks the queue every run
//    (oldest check first) and lists what is ready:
//    createOrReplaceInventoryItem → createOffer → publishOffer.
//    Discogs' meta:sync_35_mode is never read here: either channel runs alone.
//
//    PRICE never comes from the Shopify price:
//    - the CURRENT price of the record's Discogs listing (sku:{SKU} mapping →
//      GET /marketplace/listings/{id}); without a listing the record is HELD
//      (esperando_discogs) and re-checked every run — the mapping itself is
//      kept current by runRelinkCron (sync.ts), which now runs on this cron;
//    - records tagged `discogs:no`: Shopify unitCost × meta:ebay_cost_multiplier
//      (default 2); no cost → HELD as sin_fuente_de_precio, flagged in the tab.
//    Never a guessed price.
//
//    Selling limits: publishOffer error 25026 stops the batch, the record stays
//    queued and the cron pauses for EBAY_LIMIT_COOLDOWN_MS.
//
// 2. THREE-WAY INVENTORY. One copy per channel; a sale anywhere ends the rest.
//    - Shopify sale → orders/create webhook (sync.ts) → withdrawOffer here.
//    - Discogs sale → the poll creates a paid Shopify order → same webhook →
//      eBay withdrawn. Nothing Discogs-specific needed.
//    - eBay sale    → the eBay cron (getOrders) AND eBay's ORDER_CONFIRMATION
//      notification both call processEbayOrder, which creates a paid Shopify
//      order (same path as Discogs: factura, single inventory decrement). That
//      order fires the same webhook, which delists Discogs.
//    Order creation is gated by meta:ebay_sync_mode (dry | live, default dry),
//    with the same two-stage lock as the Discogs poll so a duplicate factura
//    is impossible and a transient failure is retried.
//
// 3. NOTIFICATIONS (?action=ebay-notify): endpoint challenge, signature check,
//    MARKETPLACE_ACCOUNT_DELETION (required by eBay to keep the keys alive) and
//    ORDER_CONFIRMATION.
//
// ONE ENVIRONMENT ONLY may run eBay live: prod and staging have separate
// SYNC_STATE, so their order locks don't see each other.

import {
  ebayConfigured, getPolicyIds, getMerchantLocationKey, putInventoryItem, findOffer,
  createOffer, updateOffer, publishOffer, withdrawOffer, getOrdersSince, getEbayOrder,
  challengeResponse, verifyNotificationSignature, isSellingLimitError, getSellingLimitQuantity,
  type EbayEnv, type EbayOrder,
} from './ebay-api';
import {
  buildEbayListing, gradesFor, holdReason, priceFromCost, notForDiscogs, roundUpTo99, toSourceProduct, PRODUCT_BY_SKU_QUERY,
  EBAY_DEFAULT_CATEGORY_ID, type EbaySourceProduct, type Grades, type EbayPrice, type EbayHoldReason,
} from './ebay-listing';
import {
  shopifyAdminGraphQL, findVariantBySkuLoose, getVariantsStock, createDiscogsOrder,
  EBAY_ORDER_CHANNEL, type ShopifyAdminEnv, type DiscogsOrderLine, type DiscogsBuyer,
} from './shopify-admin';
import { getListing } from './discogs';

export interface EbayFullEnv extends EbayEnv, ShopifyAdminEnv {
  DISCOGS_TOKEN?: string;
  BOOTSTRAP_AUTH_SECRET?: string;
}

export type EbayMode = 'dry' | 'live';

export const EBAY_CRON = '3,18,33,48 * * * *';

const AUTOLIST_MODE_KEY = 'meta:ebay_autolist_mode';
const SYNC_MODE_KEY = 'meta:ebay_sync_mode';
const CATEGORY_KEY = 'meta:ebay_category_id';
const COST_MULTIPLIER_KEY = 'meta:ebay_cost_multiplier';
const LIMIT_KEY = 'meta:ebay_limit_hit';
const GO_LIVE_KEY = 'meta:ebay_go_live_ts';
const BACKFILL_KEY = 'meta:ebay_backfill';
const AUTOLIST_LAST_RUN = 'meta:ebay_autolist_last_run';
const ORDERS_LAST_RUN = 'meta:ebay_orders_last_run';
const ITEM_PREFIX = 'ebay:item:';
const LISTING_PREFIX = 'ebay:listing:';
const SALE_PREFIX = 'ebay-sale:';
const LOCK_PREFIX = 'lock:ebay-order:';

// New listings per cron run. Small on purpose: new eBay accounts start with
// low monthly limits.
export const EBAY_BATCH_SIZE = 10;
// Records examined per run (one Shopify query each). Held records are
// re-checked round-robin, oldest check first, so a long queue is covered
// every few runs without one run doing hundreds of lookups.
export const EBAY_CHECKS_PER_RUN = 40;
// Discogs listing reads per run (price + grades). Discogs' budget is per
// egress IP and shared; the Discogs poll already finds it spent (memory).
export const EBAY_DISCOGS_READS_PER_RUN = 10;
export const EBAY_DEFAULT_COST_MULTIPLIER = 2;
// Backfill: first batch small enough to check every listing by eye.
export const EBAY_BACKFILL_FIRST = 5;
export const EBAY_BACKFILL_NEXT = 25;
const EBAY_BACKFILL_MAX = 100;
// After a selling-limit error, don't knock again for a day.
export const EBAY_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Same reasoning as the Discogs poll (sync.ts): re-scan a window, not a cursor.
const ORDER_LOOKBACK_DAYS = 10;
const LOCK_INFLIGHT_TTL_S = 10 * 60;
// The cron leaves orders younger than this to the ORDER_CONFIRMATION
// notification. KV is eventually consistent (up to ~60 s between locations),
// so two paths racing on a brand-new order could both miss the other's lock;
// by the time the cron sees an order, the notification's lock is visible.
export const EBAY_ORDER_SETTLE_MS = 5 * 60 * 1000;
const LOCK_COMMITTED_TTL_S = 60 * 24 * 60 * 60;
const AUDIT_TTL_S = 30 * 24 * 60 * 60;
const HISTORY_MAX = 20;

// ── modes ──────────────────────────────────────────────────────────

async function readMode(env: EbayEnv, key: string): Promise<EbayMode> {
  return (await env.SYNC_STATE.get(key)) === 'live' ? 'live' : 'dry';
}
export const getEbayAutolistMode = (env: EbayEnv) => readMode(env, AUTOLIST_MODE_KEY);
export const getEbaySyncMode = (env: EbayEnv) => readMode(env, SYNC_MODE_KEY);

// ── queue records ──────────────────────────────────────────────────

export type EbayItemStatus =
  | 'queued'       // waiting for its first check
  | 'held'         // not listable yet (hold_reason); re-checked every run
  | 'would_list'   // dry run built the listing; live picks it up
  | 'listed'       // live on eBay
  | 'failed'       // eBay refused (error); re-add to retry
  | 'excluded'     // taken out by hand; never re-queued automatically
  | 'withdrawn'    // ended because it sold elsewhere
  | 'sold';        // sold on eBay

export type EbayItemOrigin = 'webhook' | 'backfill' | 'admin';

export interface EbayItem {
  sku: string;
  status: EbayItemStatus;
  origin?: EbayItemOrigin;
  selected_at: string;
  updated_at: string;
  checked_at?: string;
  hold_reason?: EbayHoldReason;
  offer_id?: string;
  listing_id?: string;
  error?: string;
  title?: string;
  price?: EbayPrice;
  preview?: { title: string; price: string; price_source: string; condition: string; grades: Grades; ean: string; images: number };
  history?: Array<{ at: string; status: EbayItemStatus; note?: string }>;
}

/**
 * What KV list() returns for each record, so the queue can be walked and
 * shown without one KV read per record (1,500 reads would blow the per-run
 * subrequest budget). Must stay under KV's 1024-byte metadata limit.
 */
export interface EbayItemMeta {
  s: EbayItemStatus; r?: string; c?: string; a: string; t?: string;
  p?: string; ps?: string; l?: string; e?: string; o?: string;
}

function metaOf(it: EbayItem): EbayItemMeta {
  const m: EbayItemMeta = { s: it.status, a: it.selected_at };
  if (it.hold_reason && it.status === 'held') m.r = it.hold_reason;
  if (it.checked_at) m.c = it.checked_at;
  if (it.title) m.t = it.title.slice(0, 70);
  if (it.price) { m.p = it.price.value.toFixed(2); m.ps = it.price.source; }
  if (it.listing_id) m.l = it.listing_id;
  if (it.error && it.status === 'failed') m.e = it.error.slice(0, 160);
  if (it.origin) m.o = it.origin;
  return m;
}

async function getItem(env: EbayEnv, sku: string): Promise<EbayItem | null> {
  const raw = await env.SYNC_STATE.get(ITEM_PREFIX + sku);
  if (!raw) return null;
  try { return JSON.parse(raw) as EbayItem; } catch { return null; }
}

async function putItem(env: EbayEnv, it: EbayItem): Promise<void> {
  await env.SYNC_STATE.put(ITEM_PREFIX + it.sku, JSON.stringify(it), { metadata: metaOf(it) });
}

async function saveItem(env: EbayEnv, item: EbayItem, status: EbayItemStatus, note?: string): Promise<EbayItem> {
  const at = new Date().toISOString();
  const prev = item.history || [];
  const last = prev[prev.length - 1];
  // A record held for the same reason run after run doesn't grow its history.
  const same = last && last.status === status && last.note === (note ? note.slice(0, 300) : undefined);
  const next: EbayItem = {
    ...item, status, updated_at: at,
    history: same ? prev : [...prev, { at, status, ...(note ? { note: note.slice(0, 300) } : {}) }].slice(-HISTORY_MAX),
  };
  await putItem(env, next);
  return next;
}

/** Every record's summary, from list() metadata only. */
export async function listItemMetas(env: EbayEnv): Promise<Array<{ sku: string } & EbayItemMeta>> {
  const out: Array<{ sku: string } & EbayItemMeta> = [];
  let cursor: string | undefined;
  do {
    const page: any = await env.SYNC_STATE.list({ prefix: ITEM_PREFIX, cursor });
    for (const k of page.keys) {
      const m = (k.metadata || {}) as EbayItemMeta;
      out.push({ sku: k.name.slice(ITEM_PREFIX.length), ...m, s: m.s || 'queued', a: m.a || '' });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** Queue a SKU unless it already has a record (an excluded one stays excluded). */
async function enqueue(env: EbayEnv, sku: string, origin: EbayItemOrigin): Promise<boolean> {
  if (await getItem(env, sku)) return false;
  const now = new Date().toISOString();
  await saveItem(env, { sku, status: 'queued', origin, selected_at: now, updated_at: now }, 'queued', `queued (${origin})`);
  return true;
}

/**
 * products/create: queue the new product for eBay while the eBay auto-list is
 * live. Called from handleProductCreateWebhook (sync.ts) BEFORE any of the
 * Discogs filters, so a product Discogs skips is still an eBay candidate.
 */
export async function enqueueNewProductForEbay(
  env: EbayEnv,
  body: { variants?: Array<{ sku?: string }> },
): Promise<'queued' | 'exists' | 'off' | 'no_sku'> {
  if ((await getEbayAutolistMode(env)) !== 'live') return 'off';
  const sku = ((body.variants || [])[0]?.sku || '').trim();
  if (!sku) return 'no_sku';
  return (await enqueue(env, sku, 'webhook')) ? 'queued' : 'exists';
}

/** Admin: take records out. A live listing is ended first. */
export async function excludeSkus(env: EbayFullEnv, skus: string[]): Promise<Array<{ sku: string; result: string; error?: string }>> {
  const out: Array<{ sku: string; result: string; error?: string }> = [];
  for (const sku of skus) {
    const now = new Date().toISOString();
    const it = (await getItem(env, sku)) || { sku, status: 'queued' as EbayItemStatus, origin: 'admin' as EbayItemOrigin, selected_at: now, updated_at: now };
    if (it.status === 'sold') { out.push({ sku, result: 'sold' }); continue; }
    if (it.status === 'listed' && it.offer_id) {
      try {
        await withdrawOffer(env, it.offer_id);
      } catch (e: any) {
        out.push({ sku, result: 'withdraw_failed', error: e?.message || String(e) });
        continue;
      }
      if (it.listing_id) await env.SYNC_STATE.delete(LISTING_PREFIX + it.listing_id);
    }
    const wasListed = it.status === 'listed';
    await saveItem(env, { ...it, listing_id: undefined }, 'excluded', 'excluded in admin');
    out.push({ sku, result: wasListed ? 'withdrawn_and_excluded' : 'excluded' });
  }
  return out;
}

/** Admin: put records (back) in the queue — excluded, failed, withdrawn, or new. */
export async function includeSkus(env: EbayEnv, skus: string[]): Promise<Array<{ sku: string; result: string }>> {
  const out: Array<{ sku: string; result: string }> = [];
  for (const sku of skus) {
    const it = await getItem(env, sku);
    if (!it) { await enqueue(env, sku, 'admin'); out.push({ sku, result: 'queued' }); continue; }
    if (['listed', 'sold', 'queued', 'held', 'would_list'].includes(it.status)) { out.push({ sku, result: `already_${it.status}` }); continue; }
    await saveItem(env, { ...it, error: undefined, hold_reason: undefined, checked_at: undefined }, 'queued', 're-added in admin');
    out.push({ sku, result: 'queued' });
  }
  return out;
}

// ── price ──────────────────────────────────────────────────────────

type PriceDecision =
  | { ok: true; price: EbayPrice; discogs?: { condition?: string; sleeve_condition?: string } }
  | { ok: false; hold: EbayHoldReason; detail?: string };

async function costMultiplier(env: EbayEnv): Promise<number> {
  const n = Number(await env.SYNC_STATE.get(COST_MULTIPLIER_KEY));
  return n > 0 ? n : EBAY_DEFAULT_COST_MULTIPLIER;
}

/** The only two price sources. Anything else holds the record. */
async function resolvePrice(env: EbayFullEnv, p: EbaySourceProduct, budget: { discogs: number }): Promise<PriceDecision> {
  if (notForDiscogs(p.tags)) {
    const price = priceFromCost(p, await costMultiplier(env));
    return price ? { ok: true, price } : { ok: false, hold: 'sin_fuente_de_precio', detail: 'discogs:no and no Shopify unit cost' };
  }
  const raw = await env.SYNC_STATE.get(`sku:${p.variant.sku.trim()}`);
  let listingId: number | null = null;
  try { listingId = raw ? Number(JSON.parse(raw).listing_id) || null : null; } catch { /* treat as unlinked */ }
  if (!listingId) return { ok: false, hold: 'esperando_discogs' };
  if (!env.DISCOGS_TOKEN) return { ok: false, hold: 'discogs_error', detail: 'DISCOGS_TOKEN not configured' };
  if (budget.discogs <= 0) return { ok: false, hold: 'discogs_error', detail: 'Discogs read budget for this run spent' };
  budget.discogs--;
  let l;
  try {
    l = await getListing(env.DISCOGS_TOKEN, listingId);
  } catch (e: any) {
    return { ok: false, hold: 'discogs_error', detail: `getListing ${listingId}: ${e?.message || e}` };
  }
  if (l.status !== 'For Sale' && l.status !== 'Draft') {
    return { ok: false, hold: 'discogs_no_disponible', detail: `Discogs listing ${listingId} is ${l.status}` };
  }
  if (l.price?.currency !== 'EUR') {
    return { ok: false, hold: 'discogs_no_eur', detail: `Discogs listing ${listingId} in ${l.price?.currency}` };
  }
  const discogsValue = Math.round(Number(l.price.value) * 100) / 100;
  if (!(discogsValue > 0)) return { ok: false, hold: 'discogs_no_disponible', detail: `Discogs listing ${listingId} has no price` };
  const value = roundUpTo99(discogsValue);
  return {
    ok: true,
    price: {
      value, source: 'discogs',
      detail: value === discogsValue ? `Discogs listing ${listingId}` : `Discogs listing ${listingId} (${discogsValue.toFixed(2)} → ${value.toFixed(2)})`,
    },
    discogs: { condition: l.condition, sleeve_condition: l.sleeve_condition },
  };
}

// ── auto-list ──────────────────────────────────────────────────────

export interface AutolistResult {
  ok: boolean;
  mode: EbayMode;
  checked: number;
  listed: number;
  would_list: number;
  held: number;
  failed: number;
  held_by_reason: Record<string, number>;
  pending: number;          // queued + held + (live) would_list after the run
  stopped?: 'selling_limit' | 'cooldown' | 'not_configured' | 'setup_failed' | 'shopify_error';
  error?: string;
  finished_at: string;
}

async function fetchSourceProduct(env: EbayFullEnv, sku: string): Promise<EbaySourceProduct | null> {
  const r = await shopifyAdminGraphQL(env, PRODUCT_BY_SKU_QUERY, { q: `sku:"${sku.replace(/"/g, '\\"')}"` });
  if (r?.errors?.length) throw new Error(`Shopify: ${r.errors[0]?.message || 'query failed'}`);
  return toSourceProduct(r?.data?.products?.nodes || [], sku);
}

async function publishListing(env: EbayFullEnv, payload: ReturnType<typeof buildEbayListing>): Promise<{ offerId: string; listingId: string }> {
  await putInventoryItem(env, payload.sku, payload.inventoryItem);
  const existing = await findOffer(env, payload.sku);
  if (existing?.status === 'PUBLISHED' && existing.listingId) {
    return { offerId: existing.offerId, listingId: existing.listingId };
  }
  let offerId: string;
  if (existing) {
    offerId = existing.offerId;
    await updateOffer(env, offerId, payload.offer);
  } else {
    offerId = await createOffer(env, payload.offer);
  }
  const listingId = await publishOffer(env, offerId);
  return { offerId, listingId };
}

const pendingStatuses = (mode: EbayMode): Set<EbayItemStatus> =>
  new Set<EbayItemStatus>(mode === 'live' ? ['queued', 'held', 'would_list'] : ['queued', 'held']);

export async function runEbayAutolist(env: EbayFullEnv, opts: { force?: boolean } = {}): Promise<AutolistResult> {
  const mode = await getEbayAutolistMode(env);
  const result: AutolistResult = {
    ok: true, mode, checked: 0, listed: 0, would_list: 0, held: 0, failed: 0, held_by_reason: {},
    pending: 0, finished_at: '',
  };
  const finish = async () => {
    result.pending = (await listItemMetas(env)).filter(i => pendingStatuses(mode).has(i.s)).length;
    result.finished_at = new Date().toISOString();
    await env.SYNC_STATE.put(AUTOLIST_LAST_RUN, JSON.stringify(result));
    return result;
  };

  // Never-checked first, then the oldest check: every held record comes round.
  const queue = (await listItemMetas(env))
    .filter(i => pendingStatuses(mode).has(i.s))
    .sort((a, b) => (a.c || '').localeCompare(b.c || '') || a.a.localeCompare(b.a));
  if (queue.length === 0) return finish();

  let cfg: { categoryId: string; policies: any; merchantLocationKey: string } | null = null;
  if (mode === 'live') {
    if (!ebayConfigured(env)) { result.ok = false; result.stopped = 'not_configured'; return finish(); }
    const limit = await env.SYNC_STATE.get(LIMIT_KEY);
    if (limit && !opts.force) {
      try {
        if (Date.parse(JSON.parse(limit).until) > Date.now()) { result.stopped = 'cooldown'; return finish(); }
      } catch { /* malformed → ignore */ }
    }
    try {
      cfg = {
        categoryId: (await env.SYNC_STATE.get(CATEGORY_KEY)) || EBAY_DEFAULT_CATEGORY_ID,
        policies: await getPolicyIds(env),
        merchantLocationKey: await getMerchantLocationKey(env),
      };
    } catch (e: any) {
      result.ok = false; result.stopped = 'setup_failed'; result.error = e?.message || String(e);
      return finish();
    }
  }

  const budget = { discogs: EBAY_DISCOGS_READS_PER_RUN };
  const hold = async (item: EbayItem, reason: EbayHoldReason, detail?: string) => {
    await saveItem(env, { ...item, hold_reason: reason }, 'held', detail ? `${reason}: ${detail}` : reason);
    result.held++;
    result.held_by_reason[reason] = (result.held_by_reason[reason] || 0) + 1;
  };

  for (const entry of queue) {
    if (result.checked >= EBAY_CHECKS_PER_RUN) break;
    if (result.listed + result.would_list >= EBAY_BATCH_SIZE) break;
    const stored = await getItem(env, entry.sku);
    if (!stored || !pendingStatuses(mode).has(stored.status)) continue;
    result.checked++;
    const item: EbayItem = { ...stored, checked_at: new Date().toISOString() };

    let product: EbaySourceProduct | null;
    try {
      product = await fetchSourceProduct(env, item.sku);
    } catch (e: any) {
      // Shopify down is not the record's fault: stop, leave the queue as it is.
      result.ok = false; result.stopped = 'shopify_error'; result.error = e?.message || String(e);
      break;
    }
    if (!product) { await hold(item, 'no_en_shopify'); continue; }
    item.title = [product.vendor, product.title].filter(Boolean).join(' - ');
    const why = holdReason(product);
    if (why) { await hold(item, why); continue; }

    const priced = await resolvePrice(env, product, budget);
    if (!priced.ok) { await hold({ ...item, price: undefined }, priced.hold, priced.detail); continue; }
    const grades = gradesFor(product.tags, priced.discogs || null);
    if (!grades) { await hold(item, 'usado_sin_grado'); continue; }
    item.price = priced.price;

    const preview = (p: ReturnType<typeof buildEbayListing>) => ({
      title: p.inventoryItem.product.title, price: p.offer.pricingSummary.price.value, price_source: p.price.detail,
      condition: p.inventoryItem.condition, grades: p.grades, ean: p.ean,
      images: p.inventoryItem.product.imageUrls.length,
    });

    if (mode === 'dry') {
      const p = buildEbayListing(product, grades, priced.price, {
        categoryId: (await env.SYNC_STATE.get(CATEGORY_KEY)) || EBAY_DEFAULT_CATEGORY_ID,
        policies: { fulfillmentPolicyId: '(dry)', paymentPolicyId: '(dry)', returnPolicyId: '(dry)' },
        merchantLocationKey: '(dry)', withEan: true,
      });
      await saveItem(env, { ...item, hold_reason: undefined, preview: preview(p) }, 'would_list', `dry run at ${priced.price.value.toFixed(2)} (${priced.price.detail})`);
      result.would_list++;
      continue;
    }

    // LIVE. First with the EAN (eBay may match its catalogue); if eBay refuses
    // for any reason other than the selling limit, once more as a standalone.
    let payload = buildEbayListing(product, grades, priced.price, { ...cfg!, withEan: true });
    try {
      let ids: { offerId: string; listingId: string };
      try {
        ids = await publishListing(env, payload);
      } catch (e) {
        if (isSellingLimitError(e) || !payload.ean) throw e;
        payload = buildEbayListing(product, grades, priced.price, { ...cfg!, withEan: false });
        ids = await publishListing(env, payload);
      }
      await env.SYNC_STATE.put(LISTING_PREFIX + ids.listingId, item.sku);
      await saveItem(env, {
        ...item, hold_reason: undefined, offer_id: ids.offerId, listing_id: ids.listingId, preview: preview(payload), error: undefined,
      }, 'listed', `listing ${ids.listingId} at ${priced.price.value.toFixed(2)} (${priced.price.detail})`);
      result.listed++;
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (isSellingLimitError(e)) {
        await env.SYNC_STATE.put(LIMIT_KEY, JSON.stringify({
          at: new Date().toISOString(), sku: item.sku, message: msg,
          until: new Date(Date.now() + EBAY_LIMIT_COOLDOWN_MS).toISOString(),
        }));
        await saveItem(env, item, stored.status, `selling limit: ${msg}`);
        result.stopped = 'selling_limit';
        result.error = msg;
        break;
      }
      await saveItem(env, { ...item, error: msg }, 'failed', msg);
      result.failed++;
    }
  }

  return finish();
}

// ── Shopify / Discogs sale → end the eBay listing ──────────────────

/**
 * Called from the Shopify orders/create webhook. Ends the eBay listing of
 * every SKU in the order. Orders that ARE eBay sales (attribute ebay_order_id)
 * are skipped: that listing already sold. Records not listed yet are left in
 * the queue — the cron's stock check holds them if nothing is left to sell.
 */
export async function withdrawOnEbayForShopifyOrder(
  env: EbayFullEnv,
  orderId: string,
  body: { source_name?: string; note_attributes?: Array<{ name?: string; value?: string }>; line_items?: Array<{ sku?: string }> },
): Promise<void> {
  const isEbaySale = body.source_name === EBAY_ORDER_CHANNEL.sourceName
    || (body.note_attributes || []).some(a => a?.name === EBAY_ORDER_CHANNEL.attributeKey);
  if (isEbaySale) return;

  const skus = [...new Set((body.line_items || []).map(l => (l.sku || '').trim()).filter(Boolean))];
  const log: Array<{ sku: string; ok: boolean; error?: string }> = [];
  for (const sku of skus) {
    const it = await getItem(env, sku);
    if (!it || it.status !== 'listed') continue;
    if (!ebayConfigured(env) || !it.offer_id) {
      log.push({ sku, ok: false, error: 'eBay not configured' });
      continue;
    }
    try {
      await withdrawOffer(env, it.offer_id);
      await saveItem(env, it, 'withdrawn', `sold elsewhere (Shopify order ${orderId})`);
      log.push({ sku, ok: true });
    } catch (e: any) {
      const msg = e?.message || String(e);
      await saveItem(env, { ...it, error: msg }, it.status, `withdraw failed: ${msg}`);
      log.push({ sku, ok: false, error: msg });
    }
  }
  if (log.length) {
    await env.SYNC_STATE.put(`ebay-withdraw:${orderId}`, JSON.stringify({ orderId, at: new Date().toISOString(), items: log }),
      { expirationTtl: AUDIT_TTL_S });
  }
}

// ── backfill: the existing catalogue ───────────────────────────────

const BACKFILL_QUERY = `
  query ebayBackfill($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: CREATED_AT, query: "status:active AND inventory_total:>0 AND -tag:forthcoming") {
      pageInfo { hasNextPage endCursor }
      nodes { variants(first: 1) { nodes { sku } } }
    }
  }
`;

export interface BackfillResult {
  ok: boolean;
  queued: string[];
  already_in_queue: number;
  batch: number;              // how many this call was allowed to queue
  batches: number;            // calls so far
  done: boolean;              // catalogue walked to the end
  selling_limit?: number | null;
  error?: string;
}

/**
 * Queue the next batch of the existing catalogue (active, in stock, not a
 * pre-order; oldest first). The first batch is EBAY_BACKFILL_FIRST so every
 * listing can be checked by eye; later ones EBAY_BACKFILL_NEXT (or `count`).
 * Respects the selling limit: refused during the 25026 pause, and capped so
 * listed + pending never exceeds the monthly quantity from getPrivileges.
 */
export async function runEbayBackfill(env: EbayFullEnv, opts: { count?: number } = {}): Promise<BackfillResult> {
  let state: { cursor: string | null; batches: number; done: boolean; queued: number } = { cursor: null, batches: 0, done: false, queued: 0 };
  try {
    const raw = await env.SYNC_STATE.get(BACKFILL_KEY);
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch { /* start over */ }
  const out: BackfillResult = { ok: true, queued: [], already_in_queue: 0, batch: 0, batches: state.batches, done: state.done };
  if (state.done) return out;

  const limit = await env.SYNC_STATE.get(LIMIT_KEY);
  if (limit) {
    try {
      const until = JSON.parse(limit).until;
      if (Date.parse(until) > Date.now()) return { ...out, ok: false, error: `selling limit reached; paused until ${until}` };
    } catch { /* ignore malformed */ }
  }

  const asked = Math.floor(opts.count || 0);
  let batch = asked > 0 ? Math.min(EBAY_BACKFILL_MAX, asked)
    : (state.batches === 0 ? EBAY_BACKFILL_FIRST : EBAY_BACKFILL_NEXT);
  if (state.batches === 0) batch = Math.min(batch, EBAY_BACKFILL_FIRST);   // first one always small
  if (ebayConfigured(env)) {
    try {
      const cap = await getSellingLimitQuantity(env);
      out.selling_limit = cap;
      if (cap !== null) {
        const metas = await listItemMetas(env);
        const committed = metas.filter(i => i.s === 'listed' || pendingStatuses('live').has(i.s)).length;
        batch = Math.min(batch, Math.max(0, cap - committed));
        if (batch === 0) return { ...out, ok: false, error: `selling limit ${cap}: ${committed} already listed or queued` };
      }
    } catch (e: any) {
      return { ...out, ok: false, error: `getPrivileges failed: ${e?.message || e}` };
    }
  }
  out.batch = batch;

  let cursor = state.cursor;
  let done = false;
  while (out.queued.length < batch) {
    // Never fetch more than we can still queue, so the saved cursor never
    // skips products we haven't looked at.
    const r = await shopifyAdminGraphQL(env, BACKFILL_QUERY, { first: Math.min(50, batch - out.queued.length), after: cursor });
    if (r?.errors?.length) return { ...out, ok: false, error: `Shopify: ${r.errors[0]?.message}` };
    const conn = r?.data?.products;
    for (const n of conn?.nodes || []) {
      const sku = (n?.variants?.nodes?.[0]?.sku || '').trim();
      if (!sku) continue;
      if (await enqueue(env, sku, 'backfill')) out.queued.push(sku); else out.already_in_queue++;
    }
    cursor = conn?.pageInfo?.endCursor || cursor;
    if (!conn?.pageInfo?.hasNextPage) { done = true; break; }
  }

  const next = { cursor, batches: state.batches + 1, done, queued: state.queued + out.queued.length };
  await env.SYNC_STATE.put(BACKFILL_KEY, JSON.stringify(next));
  return { ...out, batches: next.batches, done };
}

// ── eBay sale → Shopify order ──────────────────────────────────────

export interface EbayOrdersResult {
  ok: boolean;
  mode: EbayMode;
  orders_examined: number;
  paid: number;
  skipped_duplicate: number;
  created: number;
  would_create: number;
  failed: number;
  not_ours: number;
  stopped?: 'not_configured';
  error?: string;
  finished_at: string;
}

function emptyOrdersResult(mode: EbayMode): EbayOrdersResult {
  return { ok: true, mode, orders_examined: 0, paid: 0, skipped_duplicate: 0, created: 0, would_create: 0, failed: 0, not_ours: 0, finished_at: '' };
}

function buyerOf(order: EbayOrder): DiscogsBuyer {
  const to = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {};
  const a = to.contactAddress || {};
  return {
    name: to.fullName || order.buyer?.username || 'eBay buyer',
    email: to.email || undefined,
    address1: a.addressLine1 || '',
    address2: a.addressLine2 || undefined,
    city: a.city || '',
    province: a.stateOrProvince || undefined,
    zip: a.postalCode || '',
    country: a.countryCode || '',
    countryCode: a.countryCode || undefined,
    phone: to.primaryPhone?.phoneNumber || undefined,
  };
}

/**
 * One eBay order → one paid Shopify order. Same contract as the Discogs poll:
 * all lines resolve or nothing is invoiced; stock is checked first; in-flight
 * lock while resolving, durable lock right before creating.
 *
 * The audit keeps NO buyer data (name, address, username) — only the country —
 * so a MARKETPLACE_ACCOUNT_DELETION has nothing of ours to erase. The Shopify
 * order itself is a factura, kept under the legal-retention exemption.
 */
export async function processEbayOrder(env: EbayFullEnv, order: EbayOrder, mode: EbayMode, result: EbayOrdersResult): Promise<void> {
  const orderId = String(order.orderId || '');
  if (!orderId) return;
  if (order.orderPaymentStatus !== 'PAID') return;
  const cancel = order.cancelStatus?.cancelState;
  if (cancel && cancel !== 'NONE_REQUESTED') return;
  result.paid++;

  const lockKey = LOCK_PREFIX + orderId;
  if (await env.SYNC_STATE.get(lockKey)) { result.skipped_duplicate++; return; }
  // Claimed before any lookup: the notification and the cron may both reach
  // this order. Expires so a failure below is retried by the next run.
  await env.SYNC_STATE.put(lockKey, 'in-flight', { expirationTtl: LOCK_INFLIGHT_TTL_S });

  // Only orders for records WE listed through this channel. Anything else
  // (listed by hand in Seller Hub) is left to Eduardo, never invoiced blind.
  const lines: DiscogsOrderLine[] = [];
  const items: any[] = [];
  let unresolved = false;
  for (const li of order.lineItems || []) {
    let sku = (li.sku || '').trim();
    if (!sku && li.legacyItemId) sku = (await env.SYNC_STATE.get(LISTING_PREFIX + li.legacyItemId)) || '';
    const rec = sku ? await getItem(env, sku) : null;
    const entry: any = { sku: sku || null, listing_id: li.legacyItemId, quantity: li.quantity || 1, outcome: 'pending' };
    items.push(entry);
    if (!rec) { entry.outcome = 'not_ours'; unresolved = true; continue; }
    const v = await findVariantBySkuLoose(env, sku).catch(() => null);
    if (!v?.variantId) { entry.outcome = 'variant_not_found'; unresolved = true; continue; }
    entry.outcome = 'resolved';
    entry.variant_id = v.variantId;
    lines.push({ variantId: v.variantId, quantity: li.quantity || 1 });
  }

  const prevRaw = await env.SYNC_STATE.get(SALE_PREFIX + orderId);
  const prev = prevRaw ? JSON.parse(prevRaw) : null;
  const now = new Date().toISOString();
  const audit: any = {
    order_id: orderId, mode, processed_at: now,
    first_detected_at: prev?.first_detected_at || now,
    attempts: (prev?.attempts || 0) + 1,
    buyer_country: buyerOf(order).countryCode || null,
    items,
  };
  const save = () => env.SYNC_STATE.put(SALE_PREFIX + orderId, JSON.stringify(audit), { expirationTtl: AUDIT_TTL_S });

  if (unresolved || lines.length === 0) {
    if (items.every(i => i.outcome === 'not_ours')) result.not_ours++; else result.failed++;
    audit.order_creation = { ok: false, needs_manual: true, will_retry: true, error: 'line(s) not resolvable; skipped to avoid partial factura' };
    return save();
  }

  try {
    const stock = await getVariantsStock(env, lines.map(l => l.variantId));
    const short = lines.filter(l => { const n = stock.get(l.variantId); return n !== null && n !== undefined && n < l.quantity; });
    if (short.length) {
      audit.order_creation = { ok: false, oversold: true, needs_manual: true, will_retry: true,
        error: `Shopify stock below eBay sale for ${short.map(l => l.variantId).join(', ')}` };
      result.failed++;
      return save();
    }
  } catch (e: any) {
    audit.order_creation = { ok: false, will_retry: true, error: `stock check failed: ${e?.message || e}` };
    result.failed++;
    return save();
  }

  if (mode === 'dry') {
    audit.order_creation = { ok: true, dry_run: true, would_create_lines: lines.length };
    result.would_create++;
    return save();
  }

  await env.SYNC_STATE.put(lockKey, '1', { expirationTtl: LOCK_COMMITTED_TTL_S });
  const r = await createDiscogsOrder(env, orderId, lines, buyerOf(order), EBAY_ORDER_CHANNEL);
  if (r.ok) {
    audit.order_creation = { ok: true, shopify_order_id: r.orderId, shopify_order_name: r.orderName, lines: lines.length };
    result.created++;
    for (const i of items) {
      const rec = i.sku ? await getItem(env, i.sku) : null;
      if (rec) await saveItem(env, rec, 'sold', `eBay order ${orderId} → Shopify ${r.orderName}`);
    }
  } else {
    audit.order_creation = { ok: false, error: r.error, userErrors: r.userErrors, draft_order_id: r.draftOrderId };
    result.failed++;
  }
  return save();
}

export async function pollEbayOrders(env: EbayFullEnv): Promise<EbayOrdersResult> {
  const mode = await getEbaySyncMode(env);
  const result = emptyOrdersResult(mode);
  const finish = async () => {
    result.finished_at = new Date().toISOString();
    await env.SYNC_STATE.put(ORDERS_LAST_RUN, JSON.stringify(result));
    return result;
  };
  if (!ebayConfigured(env)) { result.stopped = 'not_configured'; return finish(); }

  // Go-live floor, set on the first run: never back-process sales made before
  // this channel existed (the Discogs 3H lesson — duplicate facturas).
  let goLive = await env.SYNC_STATE.get(GO_LIVE_KEY);
  if (!goLive) {
    goLive = new Date().toISOString();
    await env.SYNC_STATE.put(GO_LIVE_KEY, goLive);
  }
  const since = new Date(Math.max(Date.parse(goLive), Date.now() - ORDER_LOOKBACK_DAYS * 86400000)).toISOString();

  let orders: EbayOrder[];
  try {
    orders = await getOrdersSince(env, since);
  } catch (e: any) {
    result.ok = false; result.error = `getOrders failed: ${e?.message || e}`;
    return finish();
  }
  result.orders_examined = orders.length;
  const settled = Date.now() - EBAY_ORDER_SETTLE_MS;
  for (const o of orders) {
    if (o.creationDate && Date.parse(o.creationDate) > settled) continue;
    try {
      await processEbayOrder(env, o, mode, result);
    } catch (e: any) {
      result.failed++;
      result.error = e?.message || String(e);
    }
  }
  return finish();
}

// ── notifications ──────────────────────────────────────────────────

/** The endpoint as eBay knows it: this URL minus the challenge_code eBay appended. */
function endpointOf(url: URL): string {
  const u = new URL(url.toString());
  u.searchParams.delete('challenge_code');
  return u.toString();
}

export async function handleEbayNotification(request: Request, env: EbayFullEnv, ctx: ExecutionContext): Promise<Response> {
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const code = url.searchParams.get('challenge_code');
    if (!code) return json({ error: 'challenge_code required' }, 400);
    if (!env.EBAY_VERIFICATION_TOKEN) return json({ error: 'EBAY_VERIFICATION_TOKEN not configured' }, 500);
    return json({ challengeResponse: await challengeResponse(code, env.EBAY_VERIFICATION_TOKEN, endpointOf(url)) });
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const raw = await request.text();
  let verified = false;
  try {
    verified = await verifyNotificationSignature(env, raw, request.headers.get('x-ebay-signature'));
  } catch { verified = false; }
  // eBay's contract: 412 for a signature we cannot verify.
  if (!verified) return json({ error: 'signature verification failed' }, 412);

  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: 'invalid json' }, 400); }
  const topic = body?.metadata?.topic;
  const notificationId = String(body?.notification?.notificationId || '');

  if (topic === 'MARKETPLACE_ACCOUNT_DELETION') {
    // We store no eBay user data outside Shopify facturas (see processEbayOrder),
    // so there is nothing to erase. Record only that the notice was honoured —
    // no username, no user id.
    if (notificationId) {
      await env.SYNC_STATE.put(`ebay-deletion:${notificationId}`, JSON.stringify({ received_at: new Date().toISOString() }),
        { expirationTtl: AUDIT_TTL_S });
    }
    return new Response(null, { status: 204 });
  }

  if (topic === 'ORDER_CONFIRMATION') {
    const orderId = body?.notification?.data?.order?.orderId;
    if (orderId) {
      ctx.waitUntil((async () => {
        const mode = await getEbaySyncMode(env);
        const result = emptyOrdersResult(mode);
        try {
          await processEbayOrder(env, await getEbayOrder(env, String(orderId)), mode, result);
        } catch (e: any) {
          // The cron re-scans the window, so a failure here is retried there.
          result.ok = false; result.error = e?.message || String(e);
        }
        await env.SYNC_STATE.put(`ebay-notified:${orderId}`, JSON.stringify({ at: new Date().toISOString(), ...result }),
          { expirationTtl: AUDIT_TTL_S });
      })());
    }
    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 204 });
}

// ── admin endpoints ────────────────────────────────────────────────

function bearerOk(request: Request, env: EbayFullEnv): boolean {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return Boolean(env.BOOTSTRAP_AUTH_SECRET && m && m[1] === env.BOOTSTRAP_AUTH_SECRET);
}

const CORS_JSON = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const res = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: CORS_JSON });

async function readBody(request: Request): Promise<any> {
  try { return await request.json(); } catch { return {}; }
}

function skusOf(b: any): string[] | null {
  const list = Array.isArray(b?.skus) ? b.skus : [];
  const skus = [...new Set(list.map((s: any) => String(s || '').trim()).filter(Boolean))] as string[];
  return skus.length ? skus : null;
}

async function readJsonKey(env: EbayEnv, key: string): Promise<any> {
  const raw = await env.SYNC_STATE.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * GET  ?action=ebay-mode → {autolist, sync} (public, like sync35-mode)
 * POST ?action=ebay-mode → {autolist?: 'dry'|'live', sync?: 'dry'|'live'} (Bearer)
 */
export async function handleEbayMode(request: Request, env: EbayFullEnv): Promise<Response> {
  if (request.method === 'POST') {
    if (!bearerOk(request, env)) return res({ error: 'unauthorized' }, 401);
    const b = await readBody(request);
    const valid = (v: any) => v === 'dry' || v === 'live';
    if ((b.autolist !== undefined && !valid(b.autolist)) || (b.sync !== undefined && !valid(b.sync))
      || (b.autolist === undefined && b.sync === undefined)) {
      return res({ error: 'body: {"autolist": "dry"|"live"} and/or {"sync": "dry"|"live"}' }, 400);
    }
    if (b.autolist) await env.SYNC_STATE.put(AUTOLIST_MODE_KEY, b.autolist);
    if (b.sync) await env.SYNC_STATE.put(SYNC_MODE_KEY, b.sync);
  }
  return res({ autolist: await getEbayAutolistMode(env), sync: await getEbaySyncMode(env), configured: ebayConfigured(env) });
}

/**
 * GET ?action=ebay-items (Bearer) — the queue (from list metadata, no per-record
 * reads), counts per status and hold reason, modes, last runs, backfill state.
 * `&sku=X` returns that one full record (history, preview).
 */
export async function handleEbayItems(request: Request, env: EbayFullEnv): Promise<Response> {
  if (!bearerOk(request, env)) return res({ error: 'unauthorized' }, 401);
  const one = new URL(request.url).searchParams.get('sku');
  if (one) {
    const it = await getItem(env, one);
    return it ? res(it) : res({ error: 'not in the eBay queue', sku: one }, 404);
  }
  const items = (await listItemMetas(env)).sort((a, b) => (b.c || b.a).localeCompare(a.c || a.a));
  const counts: Record<string, number> = {};
  const holds: Record<string, number> = {};
  for (const i of items) {
    counts[i.s] = (counts[i.s] || 0) + 1;
    if (i.s === 'held' && i.r) holds[i.r] = (holds[i.r] || 0) + 1;
  }
  return res({
    configured: ebayConfigured(env),
    autolist: await getEbayAutolistMode(env),
    sync: await getEbaySyncMode(env),
    cost_multiplier: await costMultiplier(env),
    limit_hit: await readJsonKey(env, LIMIT_KEY),
    backfill: await readJsonKey(env, BACKFILL_KEY),
    autolist_last_run: await readJsonKey(env, AUTOLIST_LAST_RUN),
    orders_last_run: await readJsonKey(env, ORDERS_LAST_RUN),
    relink_last_run: await readJsonKey(env, 'meta:relink_cron_last_run'),
    counts,
    holds,
    items,
  });
}

/** POST ?action=ebay-exclude / ebay-include {skus: [...]} (Bearer) */
export async function handleEbayExclude(request: Request, env: EbayFullEnv, exclude: boolean): Promise<Response> {
  if (!bearerOk(request, env)) return res({ error: 'unauthorized' }, 401);
  const skus = skusOf(await readBody(request));
  if (!skus) return res({ error: 'body: {"skus": ["SKU1", ...]}' }, 400);
  return res({ ok: true, results: exclude ? await excludeSkus(env, skus) : await includeSkus(env, skus) });
}

/** POST ?action=ebay-backfill {count?} (Bearer) — queue the next catalogue batch. */
export async function handleEbayBackfill(request: Request, env: EbayFullEnv): Promise<Response> {
  if (!bearerOk(request, env)) return res({ error: 'unauthorized' }, 401);
  const b = await readBody(request);
  if (b.reset === true) await env.SYNC_STATE.delete(BACKFILL_KEY);
  const r = await runEbayBackfill(env, { count: Number(b.count) || undefined });
  return res(r, r.ok ? 200 : 409);
}

/**
 * POST ?action=ebay-run {what: 'autolist'|'orders'|'both', force?} (Bearer).
 * Staging has no eBay cron, so this is how it is exercised there. `force`
 * ignores the selling-limit pause (and clears it).
 */
export async function handleEbayRun(request: Request, env: EbayFullEnv): Promise<Response> {
  if (!bearerOk(request, env)) return res({ error: 'unauthorized' }, 401);
  const b = await readBody(request);
  const what = b.what || 'both';
  if (!['autolist', 'orders', 'both'].includes(what)) return res({ error: 'what: autolist | orders | both' }, 400);
  if (b.force) await env.SYNC_STATE.delete(LIMIT_KEY);
  const out: any = { ok: true };
  if (what !== 'orders') out.autolist = await runEbayAutolist(env, { force: Boolean(b.force) });
  if (what !== 'autolist') out.orders = await pollEbayOrders(env);
  return res(out);
}
