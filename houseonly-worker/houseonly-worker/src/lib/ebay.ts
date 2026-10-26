// ── EBAY: THIRD SALES CHANNEL ────────────────────────────────────────
//
// Mirrors the Discogs channel (sync.ts) without sharing a single switch with
// it. Full runbook: docs/ebay.md.
//
// 1. AUTO-LIST. Records are picked ONE BY ONE in the admin (eBay tab →
//    ?action=ebay-select) and land in a queue (ebay:item:{SKU}). The eBay cron
//    (EBAY_CRON in index.ts, its own expression) lists a batch of them:
//    createOrReplaceInventoryItem → createOffer → publishOffer. Gated by its
//    OWN mode, meta:ebay_autolist_mode (dry | live, default dry). Discogs'
//    meta:sync_35_mode is never read here: either channel can run alone.
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
  challengeResponse, verifyNotificationSignature, isSellingLimitError,
  type EbayEnv, type EbayOrder,
} from './ebay-api';
import {
  buildEbayListing, gradesFor, skipReason, toSourceProduct, PRODUCT_BY_SKU_QUERY,
  EBAY_DEFAULT_CATEGORY_ID, type EbaySourceProduct, type Grades,
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
const LIMIT_KEY = 'meta:ebay_limit_hit';
const GO_LIVE_KEY = 'meta:ebay_go_live_ts';
const AUTOLIST_LAST_RUN = 'meta:ebay_autolist_last_run';
const ORDERS_LAST_RUN = 'meta:ebay_orders_last_run';
const ITEM_PREFIX = 'ebay:item:';
const LISTING_PREFIX = 'ebay:listing:';
const SALE_PREFIX = 'ebay-sale:';
const LOCK_PREFIX = 'lock:ebay-order:';

// New listings per cron run. Small on purpose: new eBay accounts start with
// low monthly limits, and each record may cost a Discogs call for its grades.
export const EBAY_BATCH_SIZE = 10;
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
  | 'queued'       // selected, waiting for the cron
  | 'would_list'   // dry run built the listing; live picks it up
  | 'listed'       // live on eBay
  | 'skipped'      // not listable (reason in skip_reason); reselect to retry
  | 'failed'       // eBay refused (error); reselect to retry
  | 'withdrawn'    // ended because it sold elsewhere, or unselected
  | 'sold';        // sold on eBay

export interface EbayItem {
  sku: string;
  status: EbayItemStatus;
  selected_at: string;
  updated_at: string;
  offer_id?: string;
  listing_id?: string;
  error?: string;
  skip_reason?: string;
  preview?: { title: string; price: string; condition: string; grades: Grades; ean: string; images: number };
  history?: Array<{ at: string; status: EbayItemStatus; note?: string }>;
}

async function getItem(env: EbayEnv, sku: string): Promise<EbayItem | null> {
  const raw = await env.SYNC_STATE.get(ITEM_PREFIX + sku);
  if (!raw) return null;
  try { return JSON.parse(raw) as EbayItem; } catch { return null; }
}

async function saveItem(env: EbayEnv, item: EbayItem, status: EbayItemStatus, note?: string): Promise<EbayItem> {
  const at = new Date().toISOString();
  const next: EbayItem = {
    ...item, status, updated_at: at,
    history: [...(item.history || []), { at, status, ...(note ? { note: note.slice(0, 300) } : {}) }].slice(-HISTORY_MAX),
  };
  await env.SYNC_STATE.put(ITEM_PREFIX + item.sku, JSON.stringify(next));
  return next;
}

export async function listItems(env: EbayEnv): Promise<EbayItem[]> {
  const out: EbayItem[] = [];
  let cursor: string | undefined;
  do {
    const page: any = await env.SYNC_STATE.list({ prefix: ITEM_PREFIX, cursor });
    for (const k of page.keys) {
      const it = await getItem(env, k.name.slice(ITEM_PREFIX.length));
      if (it) out.push(it);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** Queue SKUs for eBay. A live listing is left alone; anything else re-queues. */
export async function selectSkus(env: EbayEnv, skus: string[]): Promise<Array<{ sku: string; result: string }>> {
  const out: Array<{ sku: string; result: string }> = [];
  for (const sku of skus) {
    const prev = await getItem(env, sku);
    if (prev?.status === 'listed') { out.push({ sku, result: 'already_listed' }); continue; }
    if (prev?.status === 'queued') { out.push({ sku, result: 'already_queued' }); continue; }
    const now = new Date().toISOString();
    const base: EbayItem = prev
      ? { ...prev, error: undefined, skip_reason: undefined }
      : { sku, status: 'queued', selected_at: now, updated_at: now };
    await saveItem(env, base, 'queued', 'selected');
    out.push({ sku, result: 'queued' });
  }
  return out;
}

/** Take SKUs out of the eBay channel; a live listing is ended first. */
export async function unselectSkus(env: EbayFullEnv, skus: string[]): Promise<Array<{ sku: string; result: string; error?: string }>> {
  const out: Array<{ sku: string; result: string; error?: string }> = [];
  for (const sku of skus) {
    const it = await getItem(env, sku);
    if (!it) { out.push({ sku, result: 'not_selected' }); continue; }
    if (it.status === 'listed' && it.offer_id) {
      try {
        await withdrawOffer(env, it.offer_id);
      } catch (e: any) {
        out.push({ sku, result: 'withdraw_failed', error: e?.message || String(e) });
        continue;
      }
    }
    await env.SYNC_STATE.delete(ITEM_PREFIX + sku);
    if (it.listing_id) await env.SYNC_STATE.delete(LISTING_PREFIX + it.listing_id);
    out.push({ sku, result: it.status === 'listed' ? 'withdrawn' : 'removed' });
  }
  return out;
}

// ── auto-list ──────────────────────────────────────────────────────

export interface AutolistResult {
  ok: boolean;
  mode: EbayMode;
  processed: number;
  listed: number;
  would_list: number;
  skipped: number;
  failed: number;
  remaining_queued: number;
  stopped?: 'selling_limit' | 'cooldown' | 'not_configured' | 'setup_failed';
  error?: string;
  finished_at: string;
}

async function fetchSourceProduct(env: EbayFullEnv, sku: string): Promise<EbaySourceProduct | null> {
  const r = await shopifyAdminGraphQL(env, PRODUCT_BY_SKU_QUERY, { q: `sku:"${sku.replace(/"/g, '\\"')}"` });
  if (r?.errors?.length) throw new Error(`Shopify: ${r.errors[0]?.message || 'query failed'}`);
  return toSourceProduct(r?.data?.products?.nodes || [], sku);
}

/** Grades of our own Discogs listing, if the SKU is linked. Never fatal. */
async function discogsGrades(env: EbayFullEnv, sku: string): Promise<{ condition?: string; sleeve_condition?: string } | null> {
  const raw = await env.SYNC_STATE.get(`sku:${sku}`);
  if (!raw || !env.DISCOGS_TOKEN) return null;
  try {
    const listingId = JSON.parse(raw).listing_id;
    if (!listingId) return null;
    const l = await getListing(env.DISCOGS_TOKEN, listingId);
    return { condition: l.condition, sleeve_condition: l.sleeve_condition };
  } catch {
    // Discogs' per-IP budget is often spent (429). New stock defaults to Mint
    // anyway; a used record with no grade is skipped rather than guessed.
    return null;
  }
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

export async function runEbayAutolist(env: EbayFullEnv, opts: { force?: boolean } = {}): Promise<AutolistResult> {
  const mode = await getEbayAutolistMode(env);
  const result: AutolistResult = {
    ok: true, mode, processed: 0, listed: 0, would_list: 0, skipped: 0, failed: 0,
    remaining_queued: 0, finished_at: '',
  };
  const finish = async () => {
    result.finished_at = new Date().toISOString();
    await env.SYNC_STATE.put(AUTOLIST_LAST_RUN, JSON.stringify(result));
    return result;
  };

  // Dry builds from what was just selected; live also takes what dry built.
  const eligible = new Set<EbayItemStatus>(mode === 'live' ? ['queued', 'would_list'] : ['queued']);
  const queue = (await listItems(env))
    .filter(i => eligible.has(i.status))
    .sort((a, b) => a.selected_at.localeCompare(b.selected_at));
  result.remaining_queued = queue.length;
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

  for (const item of queue.slice(0, EBAY_BATCH_SIZE)) {
    result.processed++;
    let product: EbaySourceProduct | null;
    try {
      product = await fetchSourceProduct(env, item.sku);
    } catch (e: any) {
      // Shopify down is not the record's fault: leave it queued.
      result.ok = false; result.error = e?.message || String(e);
      break;
    }
    if (!product) {
      await saveItem(env, { ...item, skip_reason: 'no_en_shopify' }, 'skipped', 'SKU not found in Shopify');
      result.skipped++;
      continue;
    }
    const grades = gradesFor(product.tags, await discogsGrades(env, item.sku));
    const why = skipReason(product, grades);
    if (why) {
      await saveItem(env, { ...item, skip_reason: why }, 'skipped', why);
      result.skipped++;
      continue;
    }

    const preview = (p: ReturnType<typeof buildEbayListing>) => ({
      title: p.inventoryItem.product.title, price: p.offer.pricingSummary.price.value,
      condition: p.inventoryItem.condition, grades: p.grades, ean: p.ean,
      images: p.inventoryItem.product.imageUrls.length,
    });

    if (mode === 'dry') {
      const p = buildEbayListing(product, grades!, {
        categoryId: (await env.SYNC_STATE.get(CATEGORY_KEY)) || EBAY_DEFAULT_CATEGORY_ID,
        policies: { fulfillmentPolicyId: '(dry)', paymentPolicyId: '(dry)', returnPolicyId: '(dry)' },
        merchantLocationKey: '(dry)', withEan: true,
      });
      await saveItem(env, { ...item, preview: preview(p) }, 'would_list', 'dry run');
      result.would_list++;
      continue;
    }

    // LIVE. First with the EAN (eBay may match its catalogue); if eBay refuses
    // for any reason other than the selling limit, once more as a standalone.
    let payload = buildEbayListing(product, grades!, { ...cfg!, withEan: true });
    try {
      let ids: { offerId: string; listingId: string };
      try {
        ids = await publishListing(env, payload);
      } catch (e) {
        if (isSellingLimitError(e) || !payload.ean) throw e;
        payload = buildEbayListing(product, grades!, { ...cfg!, withEan: false });
        ids = await publishListing(env, payload);
      }
      await env.SYNC_STATE.put(LISTING_PREFIX + ids.listingId, item.sku);
      await saveItem(env, {
        ...item, offer_id: ids.offerId, listing_id: ids.listingId, preview: preview(payload), error: undefined,
      }, 'listed', `listing ${ids.listingId}`);
      result.listed++;
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (isSellingLimitError(e)) {
        await env.SYNC_STATE.put(LIMIT_KEY, JSON.stringify({
          at: new Date().toISOString(), sku: item.sku, message: msg,
          until: new Date(Date.now() + EBAY_LIMIT_COOLDOWN_MS).toISOString(),
        }));
        await saveItem(env, item, item.status, `selling limit: ${msg}`);
        result.stopped = 'selling_limit';
        result.error = msg;
        break;
      }
      await saveItem(env, { ...item, error: msg }, 'failed', msg);
      result.failed++;
    }
  }

  result.remaining_queued = (await listItems(env)).filter(i => eligible.has(i.status)).length;
  return finish();
}

// ── Shopify / Discogs sale → end the eBay listing ──────────────────

/**
 * Called from the Shopify orders/create webhook. Ends the eBay listing of
 * every SKU in the order. Orders that ARE eBay sales (attribute ebay_order_id)
 * are skipped: that listing already sold.
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
    if (!it) continue;
    if (it.status !== 'listed') {
      // Not live yet: drop it from the queue so the cron doesn't list a sold copy.
      if (it.status === 'queued' || it.status === 'would_list') {
        await saveItem(env, it, 'withdrawn', `sold in Shopify order ${orderId} before listing`);
      }
      continue;
    }
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

async function readSkus(request: Request): Promise<string[] | null> {
  try {
    const b: any = await request.json();
    const list = Array.isArray(b?.skus) ? b.skus : [];
    const skus = [...new Set(list.map((s: any) => String(s || '').trim()).filter(Boolean))] as string[];
    return skus.length ? skus : null;
  } catch { return null; }
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
    let b: any = {};
    try { b = await request.json(); } catch { /* empty */ }
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

/** GET ?action=ebay-items (Bearer) — queue, modes, last runs, limit pause. */
export async function handleEbayItems(request: Request, env: EbayFullEnv): Promise<Response> {
  if (!bearerOk(request, env)) return res({ error: 'unauthorized' }, 401);
  const items = (await listItems(env)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return res({
    configured: ebayConfigured(env),
    autolist: await getEbayAutolistMode(env),
    sync: await getEbaySyncMode(env),
    limit_hit: await readJsonKey(env, LIMIT_KEY),
    autolist_last_run: await readJsonKey(env, AUTOLIST_LAST_RUN),
    orders_last_run: await readJsonKey(env, ORDERS_LAST_RUN),
    items,
  });
}

/** POST ?action=ebay-select / ebay-unselect {skus: [...]} (Bearer) */
export async function handleEbaySelect(request: Request, env: EbayFullEnv, select: boolean): Promise<Response> {
  if (!bearerOk(request, env)) return res({ error: 'unauthorized' }, 401);
  const skus = await readSkus(request);
  if (!skus) return res({ error: 'body: {"skus": ["SKU1", ...]}' }, 400);
  return res({ ok: true, results: select ? await selectSkus(env, skus) : await unselectSkus(env, skus) });
}

/**
 * POST ?action=ebay-run {what: 'autolist'|'orders'|'both', force?} (Bearer).
 * Staging has no 15-min cron, so this is how it is exercised there. `force`
 * ignores the selling-limit pause (and clears it).
 */
export async function handleEbayRun(request: Request, env: EbayFullEnv): Promise<Response> {
  if (!bearerOk(request, env)) return res({ error: 'unauthorized' }, 401);
  let b: any = {};
  try { b = await request.json(); } catch { /* defaults */ }
  const what = b.what || 'both';
  if (!['autolist', 'orders', 'both'].includes(what)) return res({ error: 'what: autolist | orders | both' }, 400);
  if (b.force) await env.SYNC_STATE.delete(LIMIT_KEY);
  const out: any = { ok: true };
  if (what !== 'orders') out.autolist = await runEbayAutolist(env, { force: Boolean(b.force) });
  if (what !== 'autolist') out.orders = await pollEbayOrders(env);
  return res(out);
}
