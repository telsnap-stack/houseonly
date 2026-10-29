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
//      GET /marketplace/listings/{id}) — the mapping itself is kept current by
//      runRelinkCron (sync.ts), which now runs on this cron; without a listing,
//      unitCost × multiplier like discogs:no, and with no cost either the record
//      is HELD (esperando_discogs) and re-checked every run;
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
  getStoreSubscription, getStoreCategoryPaths, EBAY_POLICY_NAMES, getOffer, listInventorySkus, getInventoryItem, type StoreCheck, type EbayEnv, type EbayOrder,
} from './ebay-api';
import {
  buildEbayListing, gradesFor, holdReason, priceFromCost, notForDiscogs, roundUpTo99, toSourceProduct, PRODUCT_BY_SKU_QUERY,
  EBAY_DEFAULT_CATEGORY_ID, EBAY_STORE_CATEGORY_DEFAULTS, OFF_EBAY_TEXT, stripOffEbayText, shippingBandFor, fulfillmentPolicyFor, type ShippingBand, storeCategoryFor, type StoreCategoryMap, type EbaySourceProduct, type Grades, type EbayPrice, type EbayHoldReason,
} from './ebay-listing';
import {
  shopifyAdminGraphQL, findVariantBySkuLoose, getVariantsStock, createDiscogsOrder,
  EBAY_ORDER_CHANNEL, type ShopifyAdminEnv, type DiscogsOrderLine, type DiscogsBuyer,
} from './shopify-admin';
import { getListing } from './discogs';
import { loadSnapshot, snapshotFresh, snapshotStatus, saveSnapshot, snapshotFromCsv, type DiscogsSnapshot } from './discogs-snapshot';

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
const PRICE_FLOOR_KEY = 'meta:ebay_price_floor';   // editable; "0" turns it off
const LIMIT_KEY = 'meta:ebay_limit_hit';
// Listings published per day (Europe/Madrid), editable; unset or "0" = no cap.
// Set to 60 for the relaunch after eBay's verification restriction (2026-10-29).
const DAILY_CAP_KEY = 'meta:ebay_daily_publish_cap';
const DAILY_COUNT_KEY = 'meta:ebay_published_today';   // {day, count}
const GO_LIVE_KEY = 'meta:ebay_go_live_ts';
const BACKFILL_KEY = 'meta:ebay_backfill';
const AUTOLIST_LAST_RUN = 'meta:ebay_autolist_last_run';
// Continuous backfill (cron): 'off' stops it; the admin button keeps working.
const AUTOBACKFILL_MODE_KEY = 'meta:ebay_autobackfill_mode';
const AUTOBACKFILL_LAST_RUN = 'meta:ebay_autobackfill_last_run';
// Last getSubscription result: no eBay store → auto-list never publishes.
const STORE_CHECK_KEY = 'meta:ebay_store_check';
const STORE_CHECK_MAX_AGE_MS = 10 * 60 * 1000;
const STORE_CATEGORY_MAP_KEY = 'meta:ebay_store_category_map';   // editable: {by_tag, by_genre}
const STORE_CATEGORIES_KEY = 'meta:ebay_store_categories';       // GetStore cache: {paths, checked_at}
const STORE_CATEGORIES_MAX_AGE_MS = 6 * 60 * 60 * 1000;
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
// Override for both, editable: meta:ebay_batch_size (1–100; unset = 10). Set
// to 50 for the relaunch after eBay's restriction (2026-10-29), then removed.
// A pass of 50 is ~500 subrequests and ~6 min: Workers Paid allows 10,000
// and 15 min per cron (developers.cloudflare.com/workers/platform/limits).
const BATCH_SIZE_KEY = 'meta:ebay_batch_size';
const EBAY_BATCH_SIZE_MAX = 100;
export async function passSize(env: EbayEnv): Promise<{ batch: number; checks: number }> {
  const n = Math.floor(Number(await env.SYNC_STATE.get(BATCH_SIZE_KEY)));
  const batch = n > 0 ? Math.min(n, EBAY_BATCH_SIZE_MAX) : EBAY_BATCH_SIZE;
  // Room for records that end up held (sold out, no price) on the way.
  return { batch, checks: Math.max(EBAY_CHECKS_PER_RUN, batch + 20) };
}
// Discogs listing reads per run (price + grades). Discogs' budget is per
// egress IP and shared; the Discogs poll already finds it spent (memory).
export const EBAY_DISCOGS_READS_PER_RUN = 10;
export const EBAY_DEFAULT_COST_MULTIPLIER = 2;
// No eBay price below this, whatever the source (Eduardo, 2026-10-27).
export const EBAY_DEFAULT_PRICE_FLOOR = 12.99;
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
// eBay errors that are eBay's own load, not the record (2026-10-29, pass of
// 50: 7× 25001 system error, 5× 25604 "Availability not found", 1× 25710).
// Back to the queue, at most this many tries, then failed.
const TRANSIENT_ERROR = /\beBay \d{3} (25001|25604|25710)\b/;
export const EBAY_TRANSIENT_MAX_ATTEMPTS = 3;
// 25002 on photo resolution: eBay wants 500 px on the longest side.
const IMAGE_TOO_SMALL_ERROR = /\b25002\b.*(resoluci[oó]n de las im[aá]genes|image resolution|Pol[ií]tica de im[aá]genes)/i;
// Pause between writing the inventory item (stock) and publishing: 25604
// "Availability not found" is eBay not seeing the stock it was just sent.
// Editable (ms) for tests and tuning.
const PUBLISH_SETTLE_KEY = 'meta:ebay_publish_settle_ms';
export const EBAY_PUBLISH_SETTLE_MS = 1500;
// A pass stops starting new records after this (the cron runs every 15 min;
// Eduardo: cut near 12). The record in flight finishes.
export const EBAY_PASS_TIME_BUDGET_MS = 11 * 60 * 1000;

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
  | 'withdrawn_by_ebay'  // ended by eBay (account restriction, 2026-10-28); re-add to relist
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
  transient_attempts?: number;   // eBay temporary errors in a row (25001/25604/25710); failed after 3
  held_images?: string[];        // imagen_pequena: the photos eBay refused; new ones → try again
  no_weight?: boolean;      // Shopify variant without weight: shipped on the one-record policy, flagged in the admin
  preview?: { title: string; price: string; price_source: string; condition: string; grades: Grades; ean: string; images: number; shipping?: string; store_category?: string | null };
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
  w?: 1;                    // no weight in Shopify
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
  if (it.no_weight) m.w = 1;
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

async function priceFloor(env: EbayEnv): Promise<number> {
  const raw = await env.SYNC_STATE.get(PRICE_FLOOR_KEY);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : EBAY_DEFAULT_PRICE_FLOOR;
}

/** The only two price sources. Anything else holds the record. */
// The Discogs side of a price: from the inventory snapshot while it is fresh,
// a single getListing only for a listing the snapshot doesn't have.
async function discogsListingFor(
  env: EbayFullEnv, listingId: number, budget: { discogs: number }, snap: DiscogsSnapshot | null,
): Promise<{ ok: true; l: { status: string; price: { value: number; currency: string }; condition?: string; sleeve_condition?: string }; from: string } | { ok: false; hold: EbayHoldReason; detail: string }> {
  if (!snapshotFresh(snap)) {
    return { ok: false, hold: 'discogs_snapshot_caducado', detail: snap ? `snapshot from ${snap.taken_at}` : 'no snapshot' };
  }
  const s = snap!.listings[String(listingId)];
  if (s) return { ok: true, l: { ...s, price: { value: s.price, currency: s.currency } }, from: `snapshot ${snap!.taken_at.slice(0, 16)}Z` };
  if (!env.DISCOGS_TOKEN) return { ok: false, hold: 'discogs_error', detail: 'DISCOGS_TOKEN not configured' };
  if (budget.discogs <= 0) return { ok: false, hold: 'discogs_error', detail: 'Discogs read budget for this run spent' };
  budget.discogs--;
  try {
    return { ok: true, l: await getListing(env.DISCOGS_TOKEN, listingId), from: 'API' };
  } catch (e: any) {
    return { ok: false, hold: 'discogs_error', detail: `getListing ${listingId}: ${e?.message || e}` };
  }
}

/** The source's price, then the floor: anything under it goes up to it. */
async function resolvePrice(env: EbayFullEnv, p: EbaySourceProduct, budget: { discogs: number }, snap: DiscogsSnapshot | null): Promise<PriceDecision> {
  const d = await priceFromSource(env, p, budget, snap);
  if (!d.ok) return d;
  const floor = await priceFloor(env);
  if (d.price.value >= floor) return d;
  return { ...d, price: { ...d.price, value: floor, detail: `${d.price.detail}; floor ${floor.toFixed(2)}` } };
}

async function priceFromSource(env: EbayFullEnv, p: EbaySourceProduct, budget: { discogs: number }, snap: DiscogsSnapshot | null): Promise<PriceDecision> {
  if (notForDiscogs(p.tags)) {
    const price = priceFromCost(p, await costMultiplier(env));
    return price ? { ok: true, price } : { ok: false, hold: 'sin_fuente_de_precio', detail: 'discogs:no and no Shopify unit cost' };
  }
  const raw = await env.SYNC_STATE.get(`sku:${p.variant.sku.trim()}`);
  let listingId: number | null = null;
  try { listingId = raw ? Number(JSON.parse(raw).listing_id) || null : null; } catch { /* treat as unlinked */ }
  if (!listingId) {
    // Not on Discogs: list anyway at cost × multiplier, like discogs:no (Eduardo, 2026-10-29).
    // The eBay price is not updated if a Discogs listing is linked later.
    const price = priceFromCost(p, await costMultiplier(env));
    return price
      ? { ok: true, price: { ...price, detail: `${price.detail} (sin listing de Discogs)` } }
      : { ok: false, hold: 'esperando_discogs', detail: 'no Discogs listing and no Shopify unit cost' };
  }
  const got = await discogsListingFor(env, listingId, budget, snap);
  if (!got.ok) return got;
  const l = got.l;
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
      detail: `Discogs listing ${listingId}${value === discogsValue ? '' : ` (${discogsValue.toFixed(2)} → ${value.toFixed(2)})`}, ${got.from}`,
    },
    discogs: { condition: l.condition, sleeve_condition: l.sleeve_condition },
  };
}

// ── auto-list ──────────────────────────────────────────────────────

export interface AutolistResult {
  ok: boolean;
  mode: EbayMode;           // what the pass actually did
  // Switch set to live but the pass ran dry: no eBay store subscription (every
  // listing would pay an insertion fee), or the check itself failed.
  store_guard?: 'no_store' | 'check_failed';
  checked: number;
  listed: number;
  would_list: number;
  held: number;
  failed: number;
  held_by_reason: Record<string, number>;
  requeued_transient?: number;   // eBay temporary error: back in the queue
  pending: number;          // queued + held + (live) would_list after the run
  stopped?: 'selling_limit' | 'cooldown' | 'not_configured' | 'setup_failed' | 'shopify_error' | 'daily_cap' | 'time_budget';
  // Discogs answered 429 (after its own retries): no more Discogs reads this
  // run, and the cron skips the relink that would hit the same quota.
  discogs_429?: boolean;
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
  const raw = await env.SYNC_STATE.get(PUBLISH_SETTLE_KEY);
  const n = raw === null ? NaN : Number(raw);
  const settle = n >= 0 ? n : EBAY_PUBLISH_SETTLE_MS;
  if (settle > 0) await new Promise(r => setTimeout(r, settle));
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

const madridDay = (t = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);

/** Today's cap and count. remaining = Infinity when no cap is set. */
export async function dailyPublishState(env: EbayEnv): Promise<{ day: string; cap: number | null; count: number; remaining: number }> {
  const day = madridDay();
  const n = Number(await env.SYNC_STATE.get(DAILY_CAP_KEY));
  const cap = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  let count = 0;
  try {
    const c = JSON.parse((await env.SYNC_STATE.get(DAILY_COUNT_KEY)) || 'null');
    if (c?.day === day) count = Number(c.count) || 0;
  } catch { /* malformed → 0 */ }
  return { day, cap, count, remaining: cap === null ? Infinity : Math.max(0, cap - count) };
}

const pendingStatuses = (mode: EbayMode): Set<EbayItemStatus> =>
  new Set<EbayItemStatus>(mode === 'live' ? ['queued', 'held', 'would_list'] : ['queued', 'held']);

/** Fresh getSubscription result, saved for the admin. */
async function checkStore(env: EbayEnv): Promise<StoreCheck> {
  const store = await getStoreSubscription(env);
  await env.SYNC_STATE.put(STORE_CHECK_KEY, JSON.stringify(store));
  return store;
}

// eBay 25002 "El campo EAN está vacío": a product without a barcode, before
// EBAY_NO_GTIN_TEXT existed. Not the record's fault — it gets another go.
const EAN_EMPTY_ERROR = /25002[\s\S]*\bEAN\b/;

/** Failed records that only failed for a missing EAN go back to the queue. */
export async function requeueEanFailures(env: EbayEnv): Promise<string[]> {
  const out: string[] = [];
  for (const m of (await listItemMetas(env)).filter(i => i.s === 'failed')) {
    const it = await getItem(env, m.sku);
    if (!it || it.status !== 'failed' || !EAN_EMPTY_ERROR.test(it.error || '')) continue;
    await saveItem(env, { ...it, error: undefined, hold_reason: undefined, checked_at: undefined }, 'queued', 're-queued: EAN now sent as "No aplicable"');
    out.push(m.sku);
  }
  return out;
}

// ── store categories ──────────────────────────────────────────────

export interface StoreCategories {
  map: StoreCategoryMap;
  paths: string[] | null;   // what the store has; null = never read
  error?: string;
}

/** The editable map; defaults when unset or not valid JSON. No eBay call. */
async function loadStoreCategoryMap(env: EbayEnv): Promise<StoreCategoryMap> {
  const raw = await readJsonKey(env, STORE_CATEGORY_MAP_KEY);
  return raw && typeof raw === 'object' ? { by_tag: raw.by_tag || {}, by_genre: raw.by_genre || {} } : EBAY_STORE_CATEGORY_DEFAULTS;
}

/** KV map (defaults when unset or not valid JSON) + the store's category paths (cached 6 h). */
export async function loadStoreCategories(env: EbayEnv, opts: { fresh?: boolean } = {}): Promise<StoreCategories> {
  const map = await loadStoreCategoryMap(env);
  const cached = await readJsonKey(env, STORE_CATEGORIES_KEY);
  if (!opts.fresh && Array.isArray(cached?.paths) && Date.now() - Date.parse(cached.checked_at) < STORE_CATEGORIES_MAX_AGE_MS) {
    return { map, paths: cached.paths };
  }
  try {
    const paths = await getStoreCategoryPaths(env);
    await env.SYNC_STATE.put(STORE_CATEGORIES_KEY, JSON.stringify({ paths, checked_at: new Date().toISOString() }));
    return { map, paths };
  } catch (e: any) {
    // Stale list beats none; with none, nothing gets a store category.
    return { map, paths: Array.isArray(cached?.paths) ? cached.paths : null, error: e?.message || String(e) };
  }
}

/** The mapped name only if the store has it; a typo in the map never reaches eBay. */
export function storeCategoryOf(tags: string[], sc: StoreCategories): string | null {
  const name = storeCategoryFor(tags, sc.map);
  return name && sc.paths?.includes(`/${name}`) ? name : null;
}

export interface StoreCategoryApplyResult {
  ok: boolean;
  apply: boolean;
  live: number;
  by_category: Record<string, number>;
  unassigned: number;
  updated: number;
  failed: number;
  items: Array<{ sku: string; category: string | null; was: string[]; result: 'updated' | 'unchanged' | 'would_update' | 'failed' | 'no_en_shopify'; error?: string }>;
  map_missing_on_store: string[];
  error?: string;
}

/**
 * One-off: set the store category on every PUBLISHED offer (the ones listed
 * before storeCategoryNames existed). updateOffer replaces the whole offer, so
 * it goes back as getOffer returned it, with only storeCategoryNames changed.
 * Revising is free on eBay (no fee unless an upgrade is added or the price raised).
 */
export async function applyStoreCategoriesToLive(env: EbayFullEnv, opts: { apply: boolean }): Promise<StoreCategoryApplyResult> {
  const out: StoreCategoryApplyResult = {
    ok: true, apply: opts.apply, live: 0, by_category: {}, unassigned: 0, updated: 0, failed: 0, items: [], map_missing_on_store: [],
  };
  const sc = await loadStoreCategories(env, { fresh: true });
  if (!sc.paths) { out.ok = false; out.error = `store categories unreadable: ${sc.error}`; return out; }
  out.map_missing_on_store = [...new Set([...Object.values(sc.map.by_tag), ...Object.values(sc.map.by_genre)])]
    .filter(n => !sc.paths!.includes(`/${n}`));

  for (const sku of await listInventorySkus(env)) {
    const summary = await findOffer(env, sku);
    if (summary?.status !== 'PUBLISHED') continue;
    out.live++;
    const product = await fetchSourceProduct(env, sku);
    if (!product) { out.unassigned++; out.items.push({ sku, category: null, was: [], result: 'no_en_shopify' }); continue; }
    const category = storeCategoryOf(product.tags, sc);
    if (category) out.by_category[category] = (out.by_category[category] || 0) + 1;
    else out.unassigned++;
    const offer = await getOffer(env, summary.offerId);
    const was: string[] = offer?.storeCategoryNames || [];
    const want = category ? [`/${category}`] : [];
    if (was.join('|') === want.join('|')) { out.items.push({ sku, category, was, result: 'unchanged' }); continue; }
    if (!opts.apply) { out.items.push({ sku, category, was, result: 'would_update' }); continue; }
    const body = offerForUpdate(offer);
    if (want.length) body.storeCategoryNames = want; else delete body.storeCategoryNames;
    try {
      await putLiveOffer(env, summary.offerId, body);
      out.updated++;
      out.items.push({ sku, category, was, result: 'updated' });
    } catch (e: any) {
      out.failed++;
      out.items.push({ sku, category, was, result: 'failed', error: e?.message || String(e) });
    }
  }
  return out;
}

/** getOffer's answer cut to what updateOffer takes (it replaces the whole offer). */
function offerForUpdate(offer: any): any {
  const body: any = {};
  for (const k of UPDATE_OFFER_FIELDS) if (offer?.[k] !== undefined) body[k] = offer[k];
  body.includeCatalogProductDetails ??= false;   // omitted, eBay would default it to true
  return body;
}

/**
 * The one way to revise a LIVE offer: the price floor applies here too, so no
 * revision (price sync, categories, anything later) leaves a listing under it.
 */
async function putLiveOffer(env: EbayEnv, offerId: string, body: any): Promise<{ raised_from?: string }> {
  const floor = await priceFloor(env);
  const value = Number(body?.pricingSummary?.price?.value);
  let raised_from: string | undefined;
  if (floor > 0 && Number.isFinite(value) && value < floor) {
    raised_from = body.pricingSummary.price.value;
    body = { ...body, pricingSummary: { ...body.pricingSummary, price: { ...body.pricingSummary.price, value: floor.toFixed(2) } } };
  }
  await updateOffer(env, offerId, body);
  return { raised_from };
}

/** Live listings priced under the floor (published before it existed) go up to it. */
export async function raiseLiveToFloor(env: EbayFullEnv, skus: string[]): Promise<Array<{ sku: string; result: string; from?: string; to?: string; error?: string }>> {
  const floor = await priceFloor(env);
  const out: Array<{ sku: string; result: string; from?: string; to?: string; error?: string }> = [];
  for (const sku of skus) {
    const summary = await findOffer(env, sku);
    if (summary?.status !== 'PUBLISHED') { out.push({ sku, result: 'not_live' }); continue; }
    const offer = await getOffer(env, summary.offerId);
    const from = offer?.pricingSummary?.price?.value;
    if (!(Number(from) < floor)) { out.push({ sku, result: 'at_or_above_floor', from }); continue; }
    try {
      await putLiveOffer(env, summary.offerId, offerForUpdate(offer));
      const item = await getItem(env, sku);
      if (item) await saveItem(env, { ...item, preview: item.preview ? { ...item.preview, price: floor.toFixed(2) } : item.preview }, item.status, `price ${from} → ${floor.toFixed(2)} (floor)`);
      out.push({ sku, result: 'raised', from, to: floor.toFixed(2) });
    } catch (e: any) {
      out.push({ sku, result: 'failed', from, error: e?.message || String(e) });
    }
  }
  return out;
}

const shippingPolicyName = (band: ShippingBand) =>
  band === 'two' ? EBAY_POLICY_NAMES.fulfillment2 : band === 'three' ? EBAY_POLICY_NAMES.fulfillment3 : EBAY_POLICY_NAMES.fulfillment;

export interface ShippingPolicyApplyResult {
  apply: boolean;
  live: number;
  by_policy: Record<string, number>;     // where each live listing belongs now
  moved: number;
  no_weight: string[];
  items: Array<{ sku: string; kg: number | null; policy: string; result: 'moved' | 'would_move' | 'unchanged' | 'policy_missing' | 'no_en_shopify' | 'failed'; error?: string }>;
}

/**
 * One-off: live listings onto the shipping policy their weight calls for
 * (published before shipping went by weight). Only listingPolicies changes.
 */
export async function applyShippingPolicyToLive(env: EbayFullEnv, opts: { apply: boolean }): Promise<ShippingPolicyApplyResult> {
  const out: ShippingPolicyApplyResult = { apply: opts.apply, live: 0, by_policy: {}, moved: 0, no_weight: [], items: [] };
  await env.SYNC_STATE.delete('ebay:policies:v2');   // the band policies may have just been created
  const policies = await getPolicyIds(env);
  for (const sku of await listInventorySkus(env)) {
    const summary = await findOffer(env, sku);
    if (summary?.status !== 'PUBLISHED') continue;
    out.live++;
    const product = await fetchSourceProduct(env, sku);
    if (!product) { out.items.push({ sku, kg: null, policy: '-', result: 'no_en_shopify' }); continue; }
    const kg = product.variant.weightKg ?? null;
    const band = shippingBandFor(kg);
    const name = shippingPolicyName(band);
    if (!kg) out.no_weight.push(sku);
    const want = fulfillmentPolicyFor(band, policies);
    if (!want) { out.items.push({ sku, kg, policy: name, result: 'policy_missing' }); continue; }
    out.by_policy[name] = (out.by_policy[name] || 0) + 1;
    const item = await getItem(env, sku);
    if (item && Boolean(item.no_weight) !== !kg) await saveItem(env, { ...item, no_weight: !kg || undefined }, item.status);
    const offer = await withOneRetry(() => getOffer(env, summary.offerId));
    if (offer?.listingPolicies?.fulfillmentPolicyId === want) { out.items.push({ sku, kg, policy: name, result: 'unchanged' }); continue; }
    if (!opts.apply) { out.items.push({ sku, kg, policy: name, result: 'would_move' }); continue; }
    try {
      const body = offerForUpdate(offer);
      await putLiveOffer(env, summary.offerId, { ...body, listingPolicies: { ...body.listingPolicies, fulfillmentPolicyId: want } });
      out.moved++;
      out.items.push({ sku, kg, policy: name, result: 'moved' });
    } catch (e: any) {
      out.items.push({ sku, kg, policy: name, result: 'failed', error: e?.message || String(e) });
    }
  }
  return out;
}

// createOrReplaceInventoryItem's request fields (InventoryItem, Inventory API spec).
const PUT_INVENTORY_ITEM_FIELDS = ['availability', 'condition', 'conditionDescription', 'conditionDescriptors', 'packageWeightAndSize', 'product'];

export interface OffEbayScrubResult {
  apply: boolean;
  live: number;
  affected: Array<{ sku: string; where: string[]; result: 'would_fix' | 'fixed' | 'failed'; error?: string }>;
}

/**
 * Live listings whose eBay text still points off eBay (published before
 * stripOffEbayText existed): the offer's listingDescription and the inventory
 * item's product.description go back cleaned, everything else as eBay has it.
 */
// eBay's Inventory API answers the odd 500 (25001 "system error"): one more try.
async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch { await new Promise(r => setTimeout(r, 2000)); return fn(); }
}

export async function scrubOffEbayTextOnLive(env: EbayFullEnv, opts: { apply: boolean }): Promise<OffEbayScrubResult> {
  const out: OffEbayScrubResult = { apply: opts.apply, live: 0, affected: [] };
  for (const sku of await listInventorySkus(env)) {
    const summary = await findOffer(env, sku);
    if (summary?.status !== 'PUBLISHED') continue;
    out.live++;
    let offer: any, inv: any;
    try {
      [offer, inv] = await withOneRetry(() => Promise.all([getOffer(env, summary.offerId), getInventoryItem(env, sku)]));
    } catch (e: any) {
      out.affected.push({ sku, where: [], result: 'failed', error: `read: ${e?.message || e}` });
      continue;
    }
    const where: string[] = [];
    if (OFF_EBAY_TEXT.test(offer?.listingDescription || '')) where.push('listingDescription');
    if (OFF_EBAY_TEXT.test(inv?.product?.description || '')) where.push('product.description');
    if (OFF_EBAY_TEXT.test(inv?.product?.title || '')) where.push('title');   // reported only: titles aren't rewritten
    if (!where.length) continue;
    if (!opts.apply) { out.affected.push({ sku, where, result: 'would_fix' }); continue; }
    try {
      if (where.includes('product.description')) {
        const body: any = {};
        for (const k of PUT_INVENTORY_ITEM_FIELDS) if (inv[k] !== undefined) body[k] = inv[k];
        body.product = { ...inv.product, description: stripOffEbayText(inv.product.description).trim() || inv.product.title };
        await putInventoryItem(env, sku, body);
      }
      if (where.includes('listingDescription')) {
        await putLiveOffer(env, summary.offerId, { ...offerForUpdate(offer), listingDescription: stripOffEbayText(offer.listingDescription) });
      }
      out.affected.push({ sku, where, result: 'fixed' });
    } catch (e: any) {
      out.affected.push({ sku, where, result: 'failed', error: e?.message || String(e) });
    }
  }
  return out;
}

// updateOffer's request fields (EbayOfferDetailsWithId, Inventory API spec).
const UPDATE_OFFER_FIELDS = [
  'availableQuantity', 'categoryId', 'charity', 'extendedProducerResponsibility', 'hideBuyerDetails',
  'includeCatalogProductDetails', 'listingDescription', 'listingDuration', 'listingPolicies', 'listingStartDate',
  'lotSize', 'merchantLocationKey', 'pricingSummary', 'quantityLimitPerBuyer', 'regulatory', 'secondaryCategoryId',
  'storeCategoryNames', 'tax',
];

export async function runEbayAutolist(env: EbayFullEnv, opts: { force?: boolean } = {}): Promise<AutolistResult> {
  const passStart = Date.now();
  await requeueEanFailures(env);
  let mode = await getEbayAutolistMode(env);
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
  const metas = await listItemMetas(env);
  const queueFor = (m: EbayMode) => metas.filter(i => pendingStatuses(m).has(i.s))
    .sort((a, b) => (a.c || '').localeCompare(b.c || '') || a.a.localeCompare(b.a));
  let queue = queueFor(mode);
  if (queue.length === 0) return finish();

  let cfg: { categoryId: string; policies: any; merchantLocationKey: string } | null = null;
  let storeCats: StoreCategories | null = null;
  if (mode === 'live') {
    if (!ebayConfigured(env)) { result.ok = false; result.stopped = 'not_configured'; return finish(); }
    const limit = await env.SYNC_STATE.get(LIMIT_KEY);
    if (limit && !opts.force) {
      try {
        if (Date.parse(JSON.parse(limit).until) > Date.now()) { result.stopped = 'cooldown'; return finish(); }
      } catch { /* malformed → ignore */ }
    }
    // Checked every pass that has work, before anything is published. No
    // store subscription (or no answer) → this pass runs dry.
    const store = await checkStore(env);
    if (!store.has_store) {
      mode = 'dry'; result.mode = 'dry';
      result.store_guard = store.error ? 'check_failed' : 'no_store';
      queue = queueFor('dry');
      if (queue.length === 0) return finish();
    }
  }
  const daily = mode === 'live' ? await dailyPublishState(env) : null;
  if (daily && daily.remaining <= 0) { result.stopped = 'daily_cap'; return finish(); }
  if (mode === 'live') {
    try {
      cfg = {
        categoryId: (await env.SYNC_STATE.get(CATEGORY_KEY)) || EBAY_DEFAULT_CATEGORY_ID,
        policies: await getPolicyIds(env),
        merchantLocationKey: await getMerchantLocationKey(env),
      };
      storeCats = await loadStoreCategories(env);
    } catch (e: any) {
      result.ok = false; result.stopped = 'setup_failed'; result.error = e?.message || String(e);
      return finish();
    }
  }

  const budget = { discogs: EBAY_DISCOGS_READS_PER_RUN };
  const size = await passSize(env);
  const snap = await loadSnapshot(env);
  const hold = async (item: EbayItem, reason: EbayHoldReason, detail?: string) => {
    await saveItem(env, { ...item, hold_reason: reason }, 'held', detail ? `${reason}: ${detail}` : reason);
    result.held++;
    result.held_by_reason[reason] = (result.held_by_reason[reason] || 0) + 1;
  };

  for (const entry of queue) {
    if (Date.now() - passStart > EBAY_PASS_TIME_BUDGET_MS) { result.stopped = 'time_budget'; break; }
    if (result.checked >= size.checks) break;
    if (result.listed + result.would_list >= size.batch) break;
    if (daily && result.listed >= daily.remaining) { result.stopped = 'daily_cap'; break; }
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
    if (item.hold_reason === 'imagen_pequena') {
      // Same photos eBay refused → keep waiting; new ones (Shopify URLs change) → try.
      const same = !item.held_images || item.held_images.join('\n') === product.images.join('\n');
      if (same) { await hold({ ...item, held_images: item.held_images || product.images }, 'imagen_pequena', 'imagen <500 px'); continue; }
      item.held_images = undefined;
    }

    const priced = await resolvePrice(env, product, budget, snap);
    if (!priced.ok) {
      if (priced.hold === 'discogs_error' && /\b429\b/.test(priced.detail || '')) {
        result.discogs_429 = true;
        budget.discogs = 0;   // each further read would wait out the same 429 retries
      }
      await hold({ ...item, price: undefined }, priced.hold, priced.detail);
      continue;
    }
    const grades = gradesFor(product.tags, priced.discogs || null);
    if (!grades) { await hold(item, 'usado_sin_grado'); continue; }
    item.price = priced.price;
    const kg = product.variant.weightKg ?? null;
    const band = shippingBandFor(kg);
    item.no_weight = !kg || undefined;
    if (mode === 'live' && !fulfillmentPolicyFor(band, cfg!.policies)) {
      await hold(item, 'sin_politica_envio', `${shippingPolicyName(band)} (${kg} kg)`);
      continue;
    }

    const preview = (p: ReturnType<typeof buildEbayListing>) => ({
      title: p.inventoryItem.product.title, price: p.offer.pricingSummary.price.value, price_source: p.price.detail,
      condition: p.inventoryItem.condition, grades: p.grades, ean: p.ean,
      images: p.inventoryItem.product.imageUrls.length,
      store_category: p.offer.storeCategoryNames?.[0] || null,
      shipping: `${shippingPolicyName(shippingBandFor(product.variant.weightKg))} · ${product.variant.weightKg ? `${product.variant.weightKg} kg` : 'SIN PESO'}`,
    });

    if (mode === 'dry') {
      const p = buildEbayListing(product, grades, priced.price, {
        categoryId: (await env.SYNC_STATE.get(CATEGORY_KEY)) || EBAY_DEFAULT_CATEGORY_ID,
        policies: { fulfillmentPolicyId: '(dry)', paymentPolicyId: '(dry)', returnPolicyId: '(dry)' },
        merchantLocationKey: '(dry)', withEan: true,
        storeCategory: storeCategoryFor(product.tags, await loadStoreCategoryMap(env)),   // dry: not checked against the store
      });
      await saveItem(env, { ...item, hold_reason: undefined, preview: preview(p) }, 'would_list', `dry run at ${priced.price.value.toFixed(2)} (${priced.price.detail})`);
      result.would_list++;
      continue;
    }

    // LIVE. First with the EAN (eBay may match its catalogue); if eBay refuses
    // for any reason other than the selling limit, once more as a standalone.
    const storeCategory = storeCategoryOf(product.tags, storeCats!);
    let payload = buildEbayListing(product, grades, priced.price, { ...cfg!, withEan: true, storeCategory });
    try {
      let ids: { offerId: string; listingId: string };
      try {
        ids = await publishListing(env, payload);
      } catch (e) {
        if (isSellingLimitError(e) || !payload.ean) throw e;
        payload = buildEbayListing(product, grades, priced.price, { ...cfg!, withEan: false, storeCategory });
        ids = await publishListing(env, payload);
      }
      await env.SYNC_STATE.put(LISTING_PREFIX + ids.listingId, item.sku);
      await saveItem(env, {
        ...item, hold_reason: undefined, offer_id: ids.offerId, listing_id: ids.listingId, preview: preview(payload), error: undefined,
        transient_attempts: undefined, held_images: undefined,
      }, 'listed', `listing ${ids.listingId} at ${priced.price.value.toFixed(2)} (${priced.price.detail})`);
      result.listed++;
      await env.SYNC_STATE.put(DAILY_COUNT_KEY, JSON.stringify({ day: daily!.day, count: daily!.count + result.listed }));
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
      if (TRANSIENT_ERROR.test(msg)) {
        const attempts = (item.transient_attempts || 0) + 1;
        if (attempts < EBAY_TRANSIENT_MAX_ATTEMPTS) {
          // checked_at = now: to the back of the queue, not straight back at eBay.
          await saveItem(env, { ...item, transient_attempts: attempts, error: undefined }, 'queued',
            `eBay temporary error, try ${attempts}/${EBAY_TRANSIENT_MAX_ATTEMPTS}: ${msg}`);
          result.requeued_transient = (result.requeued_transient || 0) + 1;
          continue;
        }
        await saveItem(env, { ...item, transient_attempts: attempts, error: msg }, 'failed', msg);
        result.failed++;
        continue;
      }
      if (IMAGE_TOO_SMALL_ERROR.test(msg)) {
        await hold({ ...item, held_images: product.images }, 'imagen_pequena', 'imagen <500 px');
        continue;
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

/**
 * Continuous backfill, run by the cron after the auto-list pass: once nothing
 * is waiting to be published (no queued / would_list — held records don't
 * count, they wait on Discogs), queue the next EBAY_BACKFILL_NEXT. Only while
 * auto-list is live (in dry nothing gets published, so the queue would only
 * grow) and the pass wasn't stopped. runEbayBackfill itself refuses during the
 * 25026 pause, caps by the selling limit and stops at the end of the catalogue.
 */
export async function runEbayAutoBackfill(env: EbayFullEnv, pass: AutolistResult): Promise<BackfillResult | { skipped: string }> {
  const skip = async (why: string) => {
    const r = { skipped: why };
    await env.SYNC_STATE.put(AUTOBACKFILL_LAST_RUN, JSON.stringify({ at: new Date().toISOString(), ...r }));
    return r;
  };
  if ((await env.SYNC_STATE.get(AUTOBACKFILL_MODE_KEY)) === 'off') return skip('off');
  if (pass.store_guard) return skip(`no eBay store (${pass.store_guard})`);
  if (pass.mode !== 'live') return skip('autolist not live');
  if (pass.stopped) return skip(`pass stopped: ${pass.stopped}`);
  const waiting = (await listItemMetas(env)).filter(i => i.s === 'queued' || i.s === 'would_list').length;
  if (waiting > 0) return skip(`${waiting} still waiting to publish`);
  const r = await runEbayBackfill(env, { count: EBAY_BACKFILL_NEXT });
  await env.SYNC_STATE.put(AUTOBACKFILL_LAST_RUN, JSON.stringify({ at: new Date().toISOString(), ...r }));
  return r;
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

/** Store check for the admin: the saved one if recent, else a fresh call. */
async function storeForAdmin(env: EbayFullEnv): Promise<StoreCheck | null> {
  if (!ebayConfigured(env)) return null;
  const saved = await readJsonKey(env, STORE_CHECK_KEY) as StoreCheck | null;
  if (saved?.checked_at && Date.now() - Date.parse(saved.checked_at) < STORE_CHECK_MAX_AGE_MS) return saved;
  return checkStore(env);
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
  let noWeight = 0;
  for (const i of items) {
    counts[i.s] = (counts[i.s] || 0) + 1;
    if (i.s === 'held' && i.r) holds[i.r] = (holds[i.r] || 0) + 1;
    if (i.w && ['listed', 'would_list', 'queued', 'held'].includes(i.s)) noWeight++;
  }
  return res({
    configured: ebayConfigured(env),
    autolist: await getEbayAutolistMode(env),
    sync: await getEbaySyncMode(env),
    cost_multiplier: await costMultiplier(env),
    price_floor: await priceFloor(env),
    daily_publish: await dailyPublishState(env),
    pass_size: await passSize(env),
    limit_hit: await readJsonKey(env, LIMIT_KEY),
    backfill: await readJsonKey(env, BACKFILL_KEY),
    autolist_last_run: await readJsonKey(env, AUTOLIST_LAST_RUN),
    store: await storeForAdmin(env),
    discogs_snapshot: await snapshotStatus(env),
    autobackfill: (await env.SYNC_STATE.get(AUTOBACKFILL_MODE_KEY)) === 'off' ? 'off' : 'on',
    autobackfill_last_run: await readJsonKey(env, AUTOBACKFILL_LAST_RUN),
    orders_last_run: await readJsonKey(env, ORDERS_LAST_RUN),
    relink_last_run: await readJsonKey(env, 'meta:relink_cron_last_run'),
    counts,
    holds,
    no_weight: noWeight,
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

/**
 * GET  ?action=ebay-store-categories (Bearer) — the map, the store's categories
 *      (fresh from eBay) and which mapped names the store lacks.
 * POST ?action=ebay-store-categories {apply?: true} (Bearer) — the one-off on
 *      live listings; without apply it only reports what would change.
 */
export async function handleEbayStoreCategories(request: Request, env: EbayFullEnv): Promise<Response> {
  if (!bearerOk(request, env)) return res({ error: 'unauthorized' }, 401);
  if (request.method === 'GET') {
    const sc = await loadStoreCategories(env, { fresh: true });
    const names = [...new Set([...Object.values(sc.map.by_tag), ...Object.values(sc.map.by_genre)])];
    return res({ ...sc, map_missing_on_store: sc.paths ? names.filter(n => !sc.paths!.includes(`/${n}`)) : null });
  }
  const b = await readBody(request);
  const r = await applyStoreCategoriesToLive(env, { apply: b.apply === true });
  return res(r, r.ok ? 200 : 502);
}

/**
 * GET  ?action=discogs-snapshot (Bearer) — the snapshot's age, size, refresh progress.
 * POST ?action=discogs-snapshot&name=<export file name> (Bearer), body = the
 *      Discogs inventory export CSV — the manual fallback when the API refresh
 *      can't get through. The file name carries the export's time.
 */
export async function handleDiscogsSnapshot(request: Request, env: EbayFullEnv): Promise<Response> {
  if (!bearerOk(request, env)) return res({ error: 'unauthorized' }, 401);
  if (request.method === 'POST') {
    const name = new URL(request.url).searchParams.get('name') || '';
    let parsed;
    try {
      parsed = snapshotFromCsv(await request.text(), name);
    } catch (e: any) {
      return res({ error: e?.message || String(e) }, 400);
    }
    const current = await loadSnapshot(env);
    if (current && Date.parse(current.taken_at) > Date.parse(parsed.taken_at)) {
      return res({ error: `this export (${parsed.taken_at}) is older than the snapshot in use (${current.taken_at})` }, 409);
    }
    await saveSnapshot(env, parsed.listings, parsed.taken_at, 'csv');
  }
  return res(await snapshotStatus(env));
}
