// ── DISCOGS ↔ SHOPIFY SYNC HANDLERS ──────────────────────────────────
//
// Module for Fase 3 of the houseonly.store project: keeping inventory in
// sync between Shopify (primary) and Discogs (secondary) without manual
// intervention.
//
// Endpoints currently implemented:
//   - sync-bootstrap        : populate KV with SKU↔listing_id mapping (Fase 3C)
//   - sync-status           : read-only summary of sync state (Fase 3C/3E)
//   - sync-register-webhook : register Shopify orders/create webhook (Fase 3D)
//   - webhook-shopify-order : delist on Discogs when Shopify sells (Fase 3D)
//   - sync-mode             : view/set Fase 3E mode (dry | live)
//
// Scheduled handler (Fase 3E): pollDiscogsForSales(env)
//   Runs every 15 min via cron (configured in wrangler.jsonc).
//   Polls Discogs for new orders, decrements Shopify inventory.
//   Starts in 'dry' mode (logs only). Switch to 'live' via sync-mode endpoint.

import {
  getInventory,
  updateListingStatus,
  getOrders,
  createListing,
  searchRelease,
  type DiscogsListing,
  type DiscogsOrder,
  type DiscogsListingInput,
  type MatchResult,
} from './discogs';
import {
  validateShopifyWebhookHmac,
  registerShopifyWebhook,
  listShopifyWebhooks,
  findVariantBySku,
  getPrimaryLocationId,
  adjustInventory,
  type ShopifyAdminEnv,
} from './shopify-admin';

const DISCOGS_USERNAME = 'houseonly';
const SHOPIFY_ORDERS_CREATE_TOPIC = 'ORDERS_CREATE';
const SHOPIFY_PRODUCTS_CREATE_TOPIC = 'PRODUCTS_CREATE';

// ── FASE 3.5B: AUTO-LIST CONSTANTS ──────────────────────────────────
// Discogs price = Shopify price × this multiplier (Discogs sells a bit
// higher to account for marketplace fees + the collector channel).
const DISCOGS_PRICE_MULTIPLIER = 1.18;
// Listing condition for new stock — all our vinyl is new/sealed.
const DISCOGS_DEFAULT_CONDITION = 'Near Mint (NM or M-)' as const;
// Weights (grams) for shipping; 2LP heavier than single.
const WEIGHT_SINGLE_LP = 500;
const WEIGHT_DOUBLE_LP = 900;
// Only auto-process products from a known distributor source. DBH was the
// Fase 3.5B first slice; W&S/Kudos/MT added once the pipeline was validated.
// The Discogs matcher uses catno/label/artist/title (not genre), so all four
// sources are matchable even though W&S lacks genre at import time.
const ACCEPTED_SOURCE_TAGS = ['source:ws', 'source:kudos', 'source:dbh', 'source:mt', 'source:tv'];

// Status values from Discogs we consider "firm sale" — we reduce Shopify
// inventory when an order reaches one of these. Earlier states ("New Order",
// "Payment Pending") may still cancel; later states already had inventory
// reduced when they hit "Payment Received".
const FIRM_SALE_STATUSES = new Set([
  'Payment Received',
  'In Progress',
  'Shipped',
]);

// ── ENV ─────────────────────────────────────────────────────────────

/** Subset of Env that sync handlers need. */
export interface SyncEnv {
  SYNC_STATE: KVNamespace;
  DISCOGS_TOKEN: string;
  BOOTSTRAP_AUTH_SECRET: string;
  SHOPIFY_ADMIN_CLIENT_SECRET: string;
}

/** Combined Env type for handlers that need both sync + Shopify admin access. */
export type SyncAdminEnv = SyncEnv & ShopifyAdminEnv;

// ── KV SCHEMA ───────────────────────────────────────────────────────
//
// Keys:
//   sku:{SKU}                  → JSON {listing_id, status, synced_at}
//   listing:{listing_id}       → JSON {sku, status}
//   meta:bootstrap_last_run    → ISO 8601 timestamp string
//   meta:bootstrap_stats       → JSON {total, mapped, no_sku, errors, pages}
//   meta:last_polled_ts        → ISO 8601 (used by Fase 3E, not Fase 3C)
//   lock:webhook:{order_id}    → "1" with TTL (used by Fase 3D)
//   lock:order:{order_id}      → "1" with TTL (used by Fase 3E)

interface SkuMapping {
  listing_id: number;
  status: string;
  synced_at: string;  // ISO 8601
}

interface ListingMapping {
  sku: string;
  status: string;
}

interface BootstrapStats {
  total: number;
  mapped: number;
  no_sku: number;
  errors: number;
  pages: number;
  duration_ms: number;
  started_at: string;
  finished_at: string;
}

// ── AUTH ────────────────────────────────────────────────────────────

/**
 * Validate a request's Authorization header against BOOTSTRAP_AUTH_SECRET.
 * Returns true if authorized, false otherwise.
 *
 * Format: `Authorization: Bearer <secret>`
 *
 * Using a fixed shared secret (not OAuth) because this endpoint is for the
 * admin (Eduardo) only and is invoked manually via curl. No third parties
 * need to call it.
 */
function isAuthorized(request: Request, env: SyncEnv): boolean {
  if (!env.BOOTSTRAP_AUTH_SECRET) return false;
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  // Constant-time-ish comparison: short circuit on length mismatch is fine
  // here because the secret length is not itself a secret.
  return match[1] === env.BOOTSTRAP_AUTH_SECRET;
}

// ── BOOTSTRAP ────────────────────────────────────────────────────────

/**
 * One-shot endpoint: paginate the user's Discogs inventory and populate
 * SYNC_STATE KV with sku↔listing_id mappings.
 *
 * Idempotent: re-running overwrites existing mappings with fresh data from
 * Discogs. Safe to run multiple times. Each run replaces meta:bootstrap_stats
 * and meta:bootstrap_last_run with the latest results.
 *
 * Listings WITHOUT an external_id (i.e. listings not created by our bulk
 * upload) are counted in no_sku but not stored. This is intentional: we
 * can only sync products that have a SKU connecting them to Shopify.
 *
 * Returns JSON with stats.
 */
export async function handleSyncBootstrap(
  request: Request,
  env: SyncEnv,
): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.DISCOGS_TOKEN) {
    return jsonResponse({ error: 'DISCOGS_TOKEN not configured' }, 500);
  }

  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const stats = {
    total: 0,
    mapped: 0,
    no_sku: 0,
    errors: 0,
    pages: 0,
  };

  // Paginate inventory. Max per_page is 100; for 208 listings = 3 pages.
  // We cap at 50 pages defensively (5000 listings) to avoid runaway loops.
  const MAX_PAGES = 50;
  let page = 1;
  let totalPages = 1;

  try {
    while (page <= totalPages && page <= MAX_PAGES) {
      const result = await getInventory(env.DISCOGS_TOKEN, DISCOGS_USERNAME, page);
      stats.pages = page;
      totalPages = result.pagination.pages;
      stats.total = result.pagination.items;

      for (const listing of result.listings) {
        const processed = await processListing(env, listing);
        if (processed === 'mapped') stats.mapped++;
        else if (processed === 'no_sku') stats.no_sku++;
        else stats.errors++;
      }

      page++;
    }
  } catch (e: any) {
    return jsonResponse({
      error: 'bootstrap failed mid-run',
      message: e?.message || String(e),
      partial_stats: stats,
    }, 502);
  }

  const finishedAt = new Date().toISOString();
  const fullStats: BootstrapStats = {
    ...stats,
    duration_ms: Date.now() - startMs,
    started_at: startedAt,
    finished_at: finishedAt,
  };

  // Store stats and timestamp for later inspection
  await env.SYNC_STATE.put('meta:bootstrap_last_run', finishedAt);
  await env.SYNC_STATE.put('meta:bootstrap_stats', JSON.stringify(fullStats));

  return jsonResponse({
    success: true,
    stats: fullStats,
  });
}

/**
 * Store a single listing's mapping in KV. Returns one of:
 *   - 'mapped'  : SKU found, both forward and reverse keys written
 *   - 'no_sku'  : listing has no external_id, skipped
 *   - 'error'   : write failed
 */
async function processListing(
  env: SyncEnv,
  listing: DiscogsListing,
): Promise<'mapped' | 'no_sku' | 'error'> {
  const sku = (listing.external_id || '').trim();
  if (!sku) return 'no_sku';

  const now = new Date().toISOString();
  const skuMapping: SkuMapping = {
    listing_id: listing.id,
    status: listing.status,
    synced_at: now,
  };
  const listingMapping: ListingMapping = {
    sku,
    status: listing.status,
  };

  try {
    // Two writes per listing. KV is eventually consistent but for our use
    // case (eduardo runs bootstrap, then later we read from KV) the lag is
    // not a problem — bootstrap is a one-shot operation.
    await env.SYNC_STATE.put(`sku:${sku}`, JSON.stringify(skuMapping));
    await env.SYNC_STATE.put(`listing:${listing.id}`, JSON.stringify(listingMapping));
    return 'mapped';
  } catch {
    return 'error';
  }
}

// ── STATUS ──────────────────────────────────────────────────────────

/**
 * Read-only endpoint: returns a summary of the current sync state.
 * Useful for monitoring and debugging without poking at KV directly.
 *
 * Not authenticated because the data is not sensitive (only stats, no
 * actual SKU/listing details).
 *
 * Response:
 *   {
 *     bootstrap_last_run: ISO 8601 or null,
 *     bootstrap_stats: BootstrapStats or null,
 *     last_polled_ts: ISO 8601 or null  // Fase 3E
 *   }
 */
export async function handleSyncStatus(
  _request: Request,
  env: SyncEnv,
): Promise<Response> {
  const [lastRun, statsRaw, lastPolled, mode, lastPollResultRaw] = await Promise.all([
    env.SYNC_STATE.get('meta:bootstrap_last_run'),
    env.SYNC_STATE.get('meta:bootstrap_stats'),
    env.SYNC_STATE.get('meta:last_polled_ts'),
    env.SYNC_STATE.get('meta:sync_3e_mode'),
    env.SYNC_STATE.get('meta:last_poll_result'),
  ]);

  let stats: BootstrapStats | null = null;
  if (statsRaw) {
    try { stats = JSON.parse(statsRaw); } catch { /* leave null */ }
  }

  let lastPollResult: any = null;
  if (lastPollResultRaw) {
    try { lastPollResult = JSON.parse(lastPollResultRaw); } catch { /* leave null */ }
  }

  return jsonResponse({
    bootstrap_last_run: lastRun || null,
    bootstrap_stats: stats,
    last_polled_ts: lastPolled || null,
    sync_3e_mode: mode === 'live' ? 'live' : 'dry',
    last_poll_result: lastPollResult,
  });
}

// ── FASE 3D: SHOPIFY ORDER WEBHOOK ──────────────────────────────────
//
// When a customer buys a record on houseonly.store, Shopify sends an
// `orders/create` webhook to this endpoint. We:
//   1. Validate the HMAC signature (rejects spoofed requests)
//   2. Check idempotency via lock:webhook:{order_id}
//   3. For each line item with a SKU, look up the Discogs listing_id in KV
//   4. Mark each listing as Draft on Discogs (hides it from the marketplace)
//
// We use "Draft" rather than DELETE so the listing can be reactivated later
// (e.g. on restock) without re-uploading all the metadata.
//
// CRITICAL constraints:
//   - Must respond 200 OK within 5 seconds or Shopify retries
//   - Failed webhooks retry up to 8 times over 4 hours; subscription gets
//     auto-deleted after 8 failures. We use ctx.waitUntil() to do the slow
//     Discogs API calls in the background, returning 200 immediately
//     after HMAC validation + KV lookups.

interface ShopifyOrderWebhookBody {
  id?: number;
  order_number?: number;
  email?: string;
  line_items?: Array<{
    id?: number;
    sku?: string;
    title?: string;
    quantity?: number;
    variant_id?: number;
  }>;
}

/**
 * Handle a Shopify orders/create webhook.
 *
 * @param request  The webhook POST request from Shopify
 * @param env      Worker env (needs SYNC_STATE, DISCOGS_TOKEN, SHOPIFY_ADMIN_CLIENT_SECRET)
 * @param ctx      ExecutionContext for waitUntil() — keep Discogs calls async
 */
export async function handleShopifyOrderWebhook(
  request: Request,
  env: SyncEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  // 1. Read body ONCE as text — both for HMAC validation and JSON parse
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (e: any) {
    return jsonResponse({ error: 'could not read body', message: e?.message }, 400);
  }

  // 2. HMAC validation
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256');
  const valid = await validateShopifyWebhookHmac(
    rawBody,
    hmacHeader,
    env.SHOPIFY_ADMIN_CLIENT_SECRET,
  );
  if (!valid) {
    // Return 401 so Shopify logs the failure clearly
    return jsonResponse({ error: 'invalid hmac' }, 401);
  }

  // 3. Parse body now that we know it's authentic
  let body: ShopifyOrderWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch (e: any) {
    return jsonResponse({ error: 'invalid json', message: e?.message }, 400);
  }

  const orderId = String(body.id ?? body.order_number ?? '');
  if (!orderId) {
    // Acknowledge to prevent retries — there's nothing we can do
    return jsonResponse({ ok: true, processed: 0, reason: 'no order id' });
  }

  // 4. Idempotency: if we already processed this order recently, skip
  const lockKey = `lock:webhook:${orderId}`;
  const existing = await env.SYNC_STATE.get(lockKey);
  if (existing) {
    return jsonResponse({ ok: true, processed: 0, reason: 'duplicate webhook' });
  }
  // Set the lock with a 60s TTL — long enough to dedupe retries, short
  // enough that a real restock + resale won't be falsely deduped
  await env.SYNC_STATE.put(lockKey, '1', { expirationTtl: 60 });

  // 5. Resolve each line_item to its Discogs listing_id via KV
  const lineItems = body.line_items || [];
  const resolved: Array<{ sku: string; listingId: number }> = [];
  const unmapped: string[] = [];

  for (const item of lineItems) {
    const sku = (item.sku || '').trim();
    if (!sku) continue;  // not all line items are vinyl (eg shipping line)
    const mapping = await getSkuMapping(env, sku);
    if (mapping?.listing_id) {
      resolved.push({ sku, listingId: mapping.listing_id });
    } else {
      unmapped.push(sku);
    }
  }

  // 6. Schedule Discogs API calls in the background so we can return 200
  //    immediately. Shopify needs us to respond in <5 seconds; the Discogs
  //    delist call can take 1-2 seconds per item.
  if (resolved.length > 0) {
    ctx.waitUntil(delistOnDiscogs(env, orderId, resolved));
  }

  return jsonResponse({
    ok: true,
    order_id: orderId,
    queued_delists: resolved.length,
    unmapped_skus: unmapped,
    processed_line_items: lineItems.length,
  });
}

/**
 * Background task: delist each item on Discogs.
 * Runs after the webhook response has been sent. Failures are logged but
 * don't cause the webhook to fail (Shopify would retry, but the order
 * already happened — better to manually reconcile than spam retries).
 */
async function delistOnDiscogs(
  env: SyncEnv,
  orderId: string,
  items: Array<{ sku: string; listingId: number }>,
): Promise<void> {
  const log: Array<{ sku: string; listingId: number; ok: boolean; error?: string }> = [];
  for (const { sku, listingId } of items) {
    try {
      await updateListingStatus(env.DISCOGS_TOKEN, listingId, 'Draft');
      log.push({ sku, listingId, ok: true });
      // Update the KV mapping with the new status so future webhooks know
      const fresh = await getSkuMapping(env, sku);
      if (fresh) {
        fresh.status = 'Draft';
        fresh.synced_at = new Date().toISOString();
        await env.SYNC_STATE.put(`sku:${sku}`, JSON.stringify(fresh));
      }
    } catch (e: any) {
      log.push({ sku, listingId, ok: false, error: e?.message || String(e) });
    }
  }
  // Stash a record of what happened, for later inspection via sync-status
  // (or just for forensics). Keyed by order_id for traceability.
  await env.SYNC_STATE.put(
    `webhook-result:${orderId}`,
    JSON.stringify({ orderId, processed_at: new Date().toISOString(), items: log }),
    { expirationTtl: 30 * 24 * 60 * 60 },  // 30 days
  );
}

// ── FASE 3D: WEBHOOK REGISTRATION ───────────────────────────────────
//
// One-shot admin endpoint to register the Shopify orders/create webhook
// pointing at this Worker's URL. Auth via Bearer (BOOTSTRAP_AUTH_SECRET,
// reused — same admin trust boundary).
//
// Body: { worker_url: "https://...workers.dev" }  (omit ?action=...; we add it)
//
// Returns the webhook ID and any userErrors from Shopify.

interface RegisterWebhookBody {
  worker_url?: string;
}

export async function handleRegisterWebhook(
  request: Request,
  env: SyncAdminEnv,
): Promise<Response> {
  // Reuse the bootstrap auth check
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== env.BOOTSTRAP_AUTH_SECRET) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let body: RegisterWebhookBody = {};
  try {
    body = await request.json();
  } catch { /* allow missing body */ }

  const workerUrl = body.worker_url;
  if (!workerUrl || !workerUrl.startsWith('https://')) {
    return jsonResponse({
      error: 'worker_url required, must start with https://',
      example: { worker_url: 'https://houseonly-worker-staging.emontagut.workers.dev' },
    }, 400);
  }

  const webhookUri = `${workerUrl}/?action=webhook-shopify-order`;

  // Check existing subscriptions first to avoid duplicate-error noise
  try {
    const existing = await listShopifyWebhooks(env);
    const dup = existing.find(
      w => w.topic === SHOPIFY_ORDERS_CREATE_TOPIC && w.uri === webhookUri,
    );
    if (dup) {
      return jsonResponse({
        ok: true,
        already_registered: true,
        webhook_id: dup.id,
        topic: dup.topic,
        uri: dup.uri,
      });
    }
  } catch (e: any) {
    return jsonResponse({
      error: 'could not list existing webhooks',
      message: e?.message || String(e),
    }, 502);
  }

  const result = await registerShopifyWebhook(env, SHOPIFY_ORDERS_CREATE_TOPIC, webhookUri);
  if (!result.ok) {
    return jsonResponse({ error: 'registration failed', ...result }, 502);
  }

  return jsonResponse({
    ok: true,
    webhook_id: result.webhookId,
    topic: result.topic,
    uri: result.uri,
  });
}

// ── LOOKUP HELPERS (exported for future use by Fase 3D) ─────────────

/** Look up a SKU's listing mapping. Returns null if not found. */
export async function getSkuMapping(
  env: SyncEnv,
  sku: string,
): Promise<SkuMapping | null> {
  const raw = await env.SYNC_STATE.get(`sku:${sku}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as SkuMapping; } catch { return null; }
}

/** Look up a listing ID's SKU mapping. Returns null if not found. */
export async function getListingMapping(
  env: SyncEnv,
  listingId: number,
): Promise<ListingMapping | null> {
  const raw = await env.SYNC_STATE.get(`listing:${listingId}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as ListingMapping; } catch { return null; }
}

// ── FASE 3E: SCHEDULED POLL OF DISCOGS ORDERS ───────────────────────
//
// Runs every 15 min via cron. Detects new firm sales on Discogs and
// reduces the corresponding Shopify inventory.
//
// Modes:
//   - dry  : logs intended adjustments to KV under sales-detected:* but
//            does NOT call adjustInventory. Default mode.
//   - live : also calls adjustInventory(-quantity) on Shopify.
//
// Switch modes via the sync-mode endpoint (no redeploy needed).
//
// Cursor:
//   meta:last_polled_ts (ISO 8601) — orders with created_at after this
//   timestamp are considered new. Updated to the newest processed order's
//   created_at on success.
//
// Idempotency:
//   lock:order:{order_id} TTL 24h — set BEFORE adjustment is attempted.
//   If a second cron run sees the same order, it's skipped.
//
// Audit:
//   sales-detected:{order_id} JSON entry kept 30 days — for forensics.

type SyncMode = 'dry' | 'live';

interface PollResult {
  ok: boolean;
  mode: SyncMode;
  orders_examined: number;
  firm_sales_found: number;
  skipped_duplicate: number;
  shopify_adjustments_attempted: number;
  shopify_adjustments_succeeded: number;
  shopify_adjustments_failed: number;
  unmapped_listings: number;
  variant_not_found: number;
  new_cursor: string | null;
  errors?: string[];
}

/**
 * Read current sync mode. Defaults to 'dry' if unset.
 */
async function getSyncMode(env: SyncEnv): Promise<SyncMode> {
  const raw = await env.SYNC_STATE.get('meta:sync_3e_mode');
  return raw === 'live' ? 'live' : 'dry';
}

/**
 * Read current AUTO-LIST mode (Fase 3.5B). Independent of the 3E inventory
 * sync mode — controls whether the products/create webhook actually creates
 * Discogs listings ('live') or just records what it would do ('dry').
 * Defaults to 'dry' so deploying + registering the webhook is safe; nothing
 * gets listed until explicitly switched to live.
 */
async function getAutoListMode(env: SyncEnv): Promise<SyncMode> {
  const raw = await env.SYNC_STATE.get('meta:sync_35_mode');
  return raw === 'live' ? 'live' : 'dry';
}

/**
 * Main entry point for the cron handler. Called every 15 min.
 *
 * @param env Worker env (needs SYNC_STATE, DISCOGS_TOKEN, Shopify admin secrets)
 */
export async function pollDiscogsForSales(env: SyncAdminEnv): Promise<PollResult> {
  const mode = await getSyncMode(env);
  const errors: string[] = [];

  const result: PollResult = {
    ok: true,
    mode,
    orders_examined: 0,
    firm_sales_found: 0,
    skipped_duplicate: 0,
    shopify_adjustments_attempted: 0,
    shopify_adjustments_succeeded: 0,
    shopify_adjustments_failed: 0,
    unmapped_listings: 0,
    variant_not_found: 0,
    new_cursor: null,
  };

  // ── 1. Determine cursor (createdAfter) ──────────────────────────
  let cursor = await env.SYNC_STATE.get('meta:last_polled_ts');
  if (!cursor) {
    // First run: use bootstrap timestamp as starting point, so we don't
    // re-process orders that existed before our system started watching.
    cursor = await env.SYNC_STATE.get('meta:bootstrap_last_run');
  }
  if (!cursor) {
    // Truly first time, neither bootstrap nor a previous poll has run.
    // Start from 24 h ago as a safety fallback.
    cursor = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  }

  // ── 2. Fetch orders from Discogs ────────────────────────────────
  // We don't filter by status in the API call — Discogs only accepts one
  // status per call, and we want 3 (Payment Received, In Progress, Shipped).
  // Filtering in code is simpler than 3 API calls.
  let orders: DiscogsOrder[] = [];
  try {
    // First page only for now — at 15 min poll cadence and ≤50 per page,
    // we'd need 50+ firm sales in 15 min to overflow. Highly unlikely for
    // a vinyl shop. If it ever happens, we'll log and add pagination.
    const page = await getOrders(env.DISCOGS_TOKEN, {
      createdAfter: cursor,
      sort: 'created',
      sortOrder: 'asc',
      page: 1,
    });
    orders = page.orders;
    result.orders_examined = orders.length;
  } catch (e: any) {
    errors.push(`getOrders failed: ${e?.message || e}`);
    result.ok = false;
    result.errors = errors;
    return result;
  }

  // ── 3. Process each order ───────────────────────────────────────
  let newestProcessed = cursor;

  for (const order of orders) {
    // Track the newest seen — we use this as the next cursor even if
    // the order is skipped (e.g. status not firm sale).
    if (order.created && order.created > newestProcessed) {
      newestProcessed = order.created;
    }

    // Filter to firm-sale statuses
    if (!FIRM_SALE_STATUSES.has(order.status)) continue;
    result.firm_sales_found++;

    // Idempotency check: have we already processed this order?
    const orderIdStr = String(order.id);
    const lockKey = `lock:order:${orderIdStr}`;
    const alreadyProcessed = await env.SYNC_STATE.get(lockKey);
    if (alreadyProcessed) {
      result.skipped_duplicate++;
      continue;
    }

    // Set lock IMMEDIATELY — even if we fail mid-way, we don't want
    // to retry blindly on next cron run (would double-decrement stock).
    // TTL 24 h is enough cushion.
    await env.SYNC_STATE.put(lockKey, '1', { expirationTtl: 24 * 60 * 60 });

    // Process each item in the order
    const audit: any = {
      order_id: orderIdStr,
      status: order.status,
      created: order.created,
      mode,
      processed_at: new Date().toISOString(),
      items: [],
    };

    for (const item of (order.items || [])) {
      const itemAudit: any = {
        listing_id: item.id,
        release_title: item.release?.description,
        quantity: 1,  // Discogs marketplace items are always quantity 1
        sku: null as string | null,
        shopify_variant_id: null as string | null,
        shopify_location_id: null as string | null,
        outcome: 'pending',
        error: null as string | null,
      };

      // Resolve listing_id → sku via KV (populated by Fase 3C bootstrap)
      const listingMapping = await getListingMapping(env, item.id);
      if (!listingMapping?.sku) {
        itemAudit.outcome = 'unmapped_listing';
        result.unmapped_listings++;
        audit.items.push(itemAudit);
        continue;
      }
      itemAudit.sku = listingMapping.sku;

      // Resolve sku → Shopify variant + inventory item
      let variant;
      try {
        variant = await findVariantBySku(env, listingMapping.sku);
      } catch (e: any) {
        itemAudit.outcome = 'shopify_lookup_failed';
        itemAudit.error = e?.message || String(e);
        result.shopify_adjustments_failed++;
        audit.items.push(itemAudit);
        continue;
      }
      if (!variant?.inventoryItemId) {
        itemAudit.outcome = 'variant_not_found';
        result.variant_not_found++;
        audit.items.push(itemAudit);
        continue;
      }
      itemAudit.shopify_variant_id = variant.variantId;

      // Resolve location ID
      let locationId;
      try {
        locationId = await getPrimaryLocationId(env);
      } catch (e: any) {
        itemAudit.outcome = 'location_lookup_failed';
        itemAudit.error = e?.message || String(e);
        result.shopify_adjustments_failed++;
        audit.items.push(itemAudit);
        continue;
      }
      itemAudit.shopify_location_id = locationId;

      // ── Branch: dry or live ────────────────────────────
      if (mode === 'dry') {
        itemAudit.outcome = 'would_adjust_dry_run';
        result.shopify_adjustments_attempted++;
        // count as "succeeded" semantically — we say "would have worked"
        result.shopify_adjustments_succeeded++;
        audit.items.push(itemAudit);
        continue;
      }

      // LIVE mode: actually call Shopify
      result.shopify_adjustments_attempted++;
      const idempotencyKey = `discogs-order-${orderIdStr}-item-${item.id}`;
      const adjustResult = await adjustInventory(
        env,
        [{
          inventoryItemId: variant.inventoryItemId,
          locationId,
          delta: -1,  // one unit sold
        }],
        idempotencyKey,
        'movement_created',
        `discogs:order:${orderIdStr}`,
      );

      if (adjustResult.ok) {
        itemAudit.outcome = 'adjusted_live';
        result.shopify_adjustments_succeeded++;
      } else {
        itemAudit.outcome = 'shopify_adjust_failed';
        itemAudit.error = JSON.stringify(adjustResult.userErrors);
        result.shopify_adjustments_failed++;
      }
      audit.items.push(itemAudit);
    }

    // Save audit trail (30 day TTL)
    await env.SYNC_STATE.put(
      `sales-detected:${orderIdStr}`,
      JSON.stringify(audit),
      { expirationTtl: 30 * 24 * 60 * 60 },
    );
  }

  // ── 4. Update cursor ────────────────────────────────────────────
  if (newestProcessed !== cursor) {
    await env.SYNC_STATE.put('meta:last_polled_ts', newestProcessed);
    result.new_cursor = newestProcessed;
  }

  if (errors.length > 0) result.errors = errors;
  return result;
}

// ── FASE 3E: MODE MANAGEMENT ENDPOINT ──────────────────────────────
//
// GET  ?action=sync-mode   → returns current mode (no auth, non-sensitive)
// POST ?action=sync-mode   → set mode (auth: Bearer BOOTSTRAP_AUTH_SECRET)
//   body: {"mode": "dry"} or {"mode": "live"}

export async function handleSyncMode(
  request: Request,
  env: SyncEnv,
): Promise<Response> {
  if (request.method === 'GET') {
    const mode = await getSyncMode(env);
    return jsonResponse({ mode });
  }

  if (request.method === 'POST') {
    // Auth
    const header = request.headers.get('authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match || match[1] !== env.BOOTSTRAP_AUTH_SECRET) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

    let body: { mode?: string } = {};
    try { body = await request.json(); } catch { /* allow missing */ }

    const newMode = body.mode;
    if (newMode !== 'dry' && newMode !== 'live') {
      return jsonResponse({
        error: 'mode must be "dry" or "live"',
        received: newMode,
      }, 400);
    }

    await env.SYNC_STATE.put('meta:sync_3e_mode', newMode);
    return jsonResponse({ ok: true, mode: newMode });
  }

  return jsonResponse({ error: 'method not allowed' }, 405);
}

// ── FASE 3.5B: PRODUCTS/CREATE WEBHOOK → AUTO-LIST ON DISCOGS ────────
//
// When a new product is created in Shopify, Shopify sends a products/create
// webhook here. We:
//   1. Validate HMAC (rejects spoofed requests)
//   2. Idempotency via lock:product-create:{product_id}
//   3. Filter: only products tagged `source:dbh` (Fase 3.5B scope)
//   4. Skip if SKU already mapped (already on Discogs)
//   5. Run the Discogs matcher (searchRelease) in the background
//   6. HIGH (barcode) match + live mode → create a Draft Discogs listing,
//      store sku:/listing: mappings + pending-review with status 'listed'
//   7. Everything else (MED/LOW/NOT_FOUND, or dry mode) → write
//      pending-review:{SKU} for manual approval via the 3.5C dashboard
//
// SAFETY: auto-listing is gated by meta:sync_35_mode (default 'dry'). In dry
// mode the matcher runs and pending-review is written, but createListing is
// NEVER called. Flip to live via ?action=sync35-mode once validated.
//
// Per the CS001 finding: ONLY HIGH (barcode, single candidate) is ever
// auto-listed. MED/LOW always route to manual review, never auto-create.

interface ShopifyProductWebhookBody {
  id?: number;
  title?: string;
  vendor?: string;
  tags?: string;  // comma-separated
  variants?: Array<{
    id?: number;
    sku?: string;
    price?: string;
    barcode?: string;
  }>;
}

// pending-review:{SKU} record shape (consumed by the 3.5C dashboard)
interface PendingReview {
  sku: string;
  title: string;
  artist: string;
  label: string;
  barcode: string;
  shopify_price: number | null;
  discogs_price: number | null;
  weight: number;
  confidence: MatchResult['confidence'];
  match_method: MatchResult['match_method'];
  release_id: number | null;
  candidate_count: number;
  ambiguous: boolean;
  candidates: MatchResult['candidates'];
  status: 'pending' | 'would_list' | 'listed' | 'list_failed' | 'rejected';
  listing_id?: number;
  error?: string;
  mode: SyncMode;
  created_at: string;
}

/** Extract `label:X` value from a comma-separated Shopify tag string. */
function extractLabelTag(tags: string): string {
  const parts = tags.split(',').map(t => t.trim());
  const labelTag = parts.find(t => t.toLowerCase().startsWith('label:'));
  return labelTag ? labelTag.slice('label:'.length).trim() : '';
}

/** Detect a 2LP/double release from title + tags → heavier shipping weight. */
function detectWeight(title: string, tags: string): number {
  const hay = `${title} ${tags}`.toLowerCase();
  // common 2LP signals: "2lp", "2 lp", "2x12", "2 x 12", "double"
  if (/\b2\s*lp\b|\b2\s*x\s*12|\bdouble\b|\b2x12\b/.test(hay)) {
    return WEIGHT_DOUBLE_LP;
  }
  return WEIGHT_SINGLE_LP;
}

/**
 * Handle a Shopify products/create webhook (Fase 3.5B).
 * Validates, filters, dedupes, then runs match + (maybe) auto-list in the
 * background so we respond <5s as Shopify requires.
 */
export async function handleProductCreateWebhook(
  request: Request,
  env: SyncAdminEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  // 1. Read body ONCE as text (HMAC needs raw bytes), then validate
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (e: any) {
    return jsonResponse({ error: 'could not read body', message: e?.message }, 400);
  }

  const hmacHeader = request.headers.get('x-shopify-hmac-sha256');
  const valid = await validateShopifyWebhookHmac(
    rawBody,
    hmacHeader,
    env.SHOPIFY_ADMIN_CLIENT_SECRET,
  );
  if (!valid) {
    return jsonResponse({ error: 'invalid hmac' }, 401);
  }

  // Backfill mode: when ?sync=1, run the match synchronously (awaited) and
  // bypass the idempotency lock. Live Shopify webhooks never set this, so they
  // keep the fast-response + background (waitUntil) behaviour. Synchronous
  // processing avoids the 30s waitUntil cancellation that drops slow matches
  // during bulk re-sends — fine here because the caller is our backfill script,
  // not Shopify, so a slower response is acceptable.
  const syncMode = new URL(request.url).searchParams.get('sync') === '1';

  // 2. Parse
  let body: ShopifyProductWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch (e: any) {
    return jsonResponse({ error: 'invalid json', message: e?.message }, 400);
  }

  const productId = String(body.id ?? '');
  if (!productId) {
    return jsonResponse({ ok: true, processed: 0, reason: 'no product id' });
  }

  // 3. Idempotency lock (60s TTL — dedupes Shopify retries). Skipped in sync
  // backfill mode, where re-processing is intentional and idempotent at the
  // pending-review level.
  if (!syncMode) {
    const lockKey = `lock:product-create:${productId}`;
    if (await env.SYNC_STATE.get(lockKey)) {
      return jsonResponse({ ok: true, processed: 0, reason: 'duplicate webhook' });
    }
    await env.SYNC_STATE.put(lockKey, '1', { expirationTtl: 60 });
  }

  // 4. Filter: only products from a known distributor source
  const tags = body.tags || '';
  const tagList = tags.split(',').map(t => t.trim());
  if (!tagList.some(t => ACCEPTED_SOURCE_TAGS.includes(t))) {
    return jsonResponse({ ok: true, processed: 0, reason: 'no recognized source tag' });
  }

  // 4b. NEVER list pre-orders on Discogs. A `forthcoming` product has stock 0
  // and no physical copy — listing it would let a Discogs buyer purchase a
  // record we don't hold. This is the SINGLE entry point that feeds both the
  // auto-list path AND the pending-review queue, so guarding here protects
  // both. Graduation is symmetric: when the record physically arrives, the
  // arrival step removes the `forthcoming` tag, and a later products/update
  // (or manual re-trigger) makes it Discogs-eligible again.
  if (tagList.includes('forthcoming')) {
    return jsonResponse({ ok: true, processed: 0, reason: 'forthcoming pre-order — not listed on Discogs', sku: (((body.variants || [])[0] || {}).sku || '').trim() });
  }

  // 5. Extract identifiers from the first variant
  const variant = (body.variants || [])[0] || {};
  const sku = (variant.sku || '').trim();
  if (!sku) {
    return jsonResponse({ ok: true, processed: 0, reason: 'no sku' });
  }

  // 6. Duplicate check — already mapped means already on Discogs
  const existing = await getSkuMapping(env, sku);
  if (existing) {
    return jsonResponse({ ok: true, processed: 0, reason: 'sku already mapped', sku });
  }

  const barcode = (variant.barcode || '').trim();
  const shopifyPrice = variant.price ? parseFloat(variant.price) : null;
  const artist = (body.vendor || '').trim();
  const title = (body.title || '').trim();
  const label = extractLabelTag(tags);
  const weight = detectWeight(title, tags);

  // 7. Run the match (Discogs lookup + maybe create listing). In sync/backfill
  // mode, await it so it completes before we respond (no waitUntil 30s cap). For
  // live Shopify webhooks, background it so we respond fast as Shopify requires.
  const matchArgs = { sku, barcode, artist, title, label, shopifyPrice, weight };
  if (syncMode) {
    await processProductMatch(env, matchArgs);
  } else {
    ctx.waitUntil(processProductMatch(env, matchArgs));
  }

  return jsonResponse({
    ok: true,
    product_id: productId,
    sku,
    queued: true,
    sync: syncMode,
    has_barcode: Boolean(barcode),
  });
}

/**
 * Background: run the matcher, then either auto-list (HIGH + live mode) or
 * write a pending-review record. Writes to pending-review:{SKU} in all cases
 * so the 3.5C dashboard always has a record to show.
 */
async function processProductMatch(
  env: SyncAdminEnv,
  p: {
    sku: string;
    barcode: string;
    artist: string;
    title: string;
    label: string;
    shopifyPrice: number | null;
    weight: number;
  },
): Promise<void> {
  const mode = await getAutoListMode(env);
  const now = new Date().toISOString();
  const discogsPrice = p.shopifyPrice != null
    ? Math.round(p.shopifyPrice * DISCOGS_PRICE_MULTIPLIER * 100) / 100
    : null;

  let match: MatchResult;
  try {
    match = await searchRelease(env.DISCOGS_TOKEN, {
      barcode: p.barcode || undefined,
      catno: p.sku || undefined,
      label: p.label || undefined,
      artist: p.artist || undefined,
      title: p.title || undefined,
    });
  } catch (e: any) {
    await writePendingReview(env, {
      sku: p.sku, title: p.title, artist: p.artist, label: p.label,
      barcode: p.barcode, shopify_price: p.shopifyPrice, discogs_price: discogsPrice,
      weight: p.weight, confidence: 'NOT_FOUND', match_method: 'none',
      release_id: null, candidate_count: 0, ambiguous: false, candidates: [],
      status: 'pending', error: `matcher failed: ${e?.message || e}`,
      mode, created_at: now,
    });
    return;
  }

  const base: PendingReview = {
    sku: p.sku, title: p.title, artist: p.artist, label: p.label,
    barcode: p.barcode, shopify_price: p.shopifyPrice, discogs_price: discogsPrice,
    weight: p.weight,
    confidence: match.confidence,
    match_method: match.match_method,
    release_id: match.release_id,
    candidate_count: match.candidate_count,
    ambiguous: match.ambiguous,
    candidates: match.candidates,
    status: 'pending',
    mode,
    created_at: now,
  };

  // Only HIGH (barcode, single confident match) is eligible to auto-list.
  const eligibleToList =
    match.confidence === 'HIGH' &&
    match.release_id != null &&
    discogsPrice != null;

  if (!eligibleToList) {
    // MED/LOW/NOT_FOUND → manual review queue
    await writePendingReview(env, base);
    return;
  }

  if (mode === 'dry') {
    // Would list, but dry mode — record intent, create nothing
    await writePendingReview(env, { ...base, status: 'would_list' });
    return;
  }

  // LIVE + HIGH → create the Discogs listing (Draft)
  try {
    const input: DiscogsListingInput = {
      release_id: match.release_id!,
      condition: DISCOGS_DEFAULT_CONDITION,
      price: discogsPrice!,
      status: 'Draft',
      external_id: p.sku,
      location: p.sku,
      weight: p.weight,
    };
    const listingId = await createListing(env.DISCOGS_TOKEN, input);

    // Record the sku:/listing: mappings so Fase 3 sync knows about it
    const skuMapping: SkuMapping = { listing_id: listingId, status: 'Draft', synced_at: now };
    const listingMapping: ListingMapping = { sku: p.sku, status: 'Draft' };
    await env.SYNC_STATE.put(`sku:${p.sku}`, JSON.stringify(skuMapping));
    await env.SYNC_STATE.put(`listing:${listingId}`, JSON.stringify(listingMapping));

    await writePendingReview(env, { ...base, status: 'listed', listing_id: listingId });
  } catch (e: any) {
    await writePendingReview(env, {
      ...base, status: 'list_failed', error: e?.message || String(e),
    });
  }
}

/** Persist a pending-review record (90 day TTL — long enough to act on). */
async function writePendingReview(env: SyncEnv, rec: PendingReview): Promise<void> {
  await env.SYNC_STATE.put(
    `pending-review:${rec.sku}`,
    JSON.stringify(rec),
    { expirationTtl: 90 * 24 * 60 * 60 },
  );
}

// ── FASE 3.5B: AUTO-LIST MODE ENDPOINT ──────────────────────────────
//
// GET  ?action=sync35-mode  → returns current auto-list mode
// POST ?action=sync35-mode  → set mode (Bearer BOOTSTRAP_AUTH_SECRET)
//   body: {"mode": "dry"} | {"mode": "live"}

export async function handleAutoListMode(
  request: Request,
  env: SyncEnv,
): Promise<Response> {
  if (request.method === 'GET') {
    const mode = await getAutoListMode(env);
    return jsonResponse({ mode });
  }

  if (request.method === 'POST') {
    const header = request.headers.get('authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m || m[1] !== env.BOOTSTRAP_AUTH_SECRET) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }
    let body: { mode?: string } = {};
    try { body = await request.json(); } catch { /* allow missing */ }
    if (body.mode !== 'dry' && body.mode !== 'live') {
      return jsonResponse({ error: 'mode must be "dry" or "live"', received: body.mode }, 400);
    }
    await env.SYNC_STATE.put('meta:sync_35_mode', body.mode);
    return jsonResponse({ ok: true, mode: body.mode });
  }

  return jsonResponse({ error: 'method not allowed' }, 405);
}

// ── FASE 3.5C: REVIEW DASHBOARD ENDPOINTS ───────────────────────────
//
// The review queue (pending-review:{SKU} records) is the PRIMARY workflow
// for houseonly, because most underground 12"s lack barcodes and match via
// catno+label (MEDIUM) → manual review rather than HIGH/auto-list.
//
//   GET  ?action=pending-review-list     → all pending records (Bearer)
//   POST ?action=pending-review-approve  → {sku, release_id} create listing
//   POST ?action=pending-review-reject   → {sku} discard
//
// Auth: Bearer BOOTSTRAP_AUTH_SECRET on all three (admin-only).

function checkBearer(request: Request, env: SyncEnv): boolean {
  const header = request.headers.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(m && m[1] === env.BOOTSTRAP_AUTH_SECRET);
}

/**
 * List all pending-review records. Paginates the KV `pending-review:` prefix,
 * fetches each value, returns them newest-first. Includes a status filter so
 * the dashboard can show only actionable items if desired (?status=pending).
 */
export async function handlePendingReviewList(
  request: Request,
  env: SyncEnv,
): Promise<Response> {
  if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405);
  if (!checkBearer(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get('status'); // optional

  const records: PendingReview[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    pages++;
    const list = await env.SYNC_STATE.list({ prefix: 'pending-review:', cursor });
    for (const key of list.keys) {
      const raw = await env.SYNC_STATE.get(key.name);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw) as PendingReview;
        if (!statusFilter || rec.status === statusFilter) records.push(rec);
      } catch { /* skip malformed */ }
    }
    cursor = list.list_complete ? undefined : list.cursor;
    if (pages > 20) break; // safety cap
  } while (cursor);

  // newest first
  records.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  return jsonResponse({
    count: records.length,
    records,
  });
}

/**
 * Approve a pending record → create the Discogs listing for the chosen
 * release_id. Unlike the auto-list flow, manual approval ALWAYS creates the
 * listing (the dry/live gate only governs *automatic* listing; a human
 * clicking approve is an explicit decision).
 *
 * Body: { sku: string, release_id: number }
 *   release_id lets the dashboard override the matcher's pick — essential for
 *   ambiguous matches where the user selects the correct candidate.
 */
export async function handlePendingReviewApprove(
  request: Request,
  env: SyncAdminEnv,
): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
  if (!checkBearer(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  let body: { sku?: string; release_id?: number } = {};
  try { body = await request.json(); } catch { /* */ }
  const sku = (body.sku || '').trim();
  const releaseId = Number(body.release_id);
  if (!sku) return jsonResponse({ error: 'sku required' }, 400);
  if (!Number.isFinite(releaseId) || releaseId <= 0) {
    return jsonResponse({ error: 'valid release_id required' }, 400);
  }

  const raw = await env.SYNC_STATE.get(`pending-review:${sku}`);
  if (!raw) return jsonResponse({ error: 'pending record not found', sku }, 404);
  const rec = JSON.parse(raw) as PendingReview;

  // Guard: don't double-list an already-listed SKU
  const existing = await getSkuMapping(env, sku);
  if (existing) {
    return jsonResponse({ error: 'sku already mapped', sku, listing_id: existing.listing_id }, 409);
  }

  if (rec.discogs_price == null) {
    return jsonResponse({ error: 'no price on record — cannot list', sku }, 400);
  }

  try {
    const input: DiscogsListingInput = {
      release_id: releaseId,
      condition: DISCOGS_DEFAULT_CONDITION,
      price: rec.discogs_price,
      status: 'Draft',
      external_id: sku,
      location: sku,
      weight: rec.weight || WEIGHT_SINGLE_LP,
    };
    const listingId = await createListing(env.DISCOGS_TOKEN, input);

    const now = new Date().toISOString();
    const skuMapping: SkuMapping = { listing_id: listingId, status: 'Draft', synced_at: now };
    const listingMapping: ListingMapping = { sku, status: 'Draft' };
    await env.SYNC_STATE.put(`sku:${sku}`, JSON.stringify(skuMapping));
    await env.SYNC_STATE.put(`listing:${listingId}`, JSON.stringify(listingMapping));

    // Update the pending record → listed (short TTL so it ages out of the queue)
    const updated: PendingReview = {
      ...rec, status: 'listed', listing_id: listingId, release_id: releaseId,
    };
    await env.SYNC_STATE.put(`pending-review:${sku}`, JSON.stringify(updated),
      { expirationTtl: 7 * 24 * 60 * 60 });

    return jsonResponse({ ok: true, sku, listing_id: listingId, release_id: releaseId });
  } catch (e: any) {
    return jsonResponse({ error: 'createListing failed', message: e?.message || String(e), sku }, 502);
  }
}

/**
 * Reject a pending record → mark rejected (kept briefly for audit, then ages
 * out). Does not touch Discogs. Body: { sku: string }
 */
export async function handlePendingReviewReject(
  request: Request,
  env: SyncEnv,
): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
  if (!checkBearer(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  let body: { sku?: string } = {};
  try { body = await request.json(); } catch { /* */ }
  const sku = (body.sku || '').trim();
  if (!sku) return jsonResponse({ error: 'sku required' }, 400);

  const raw = await env.SYNC_STATE.get(`pending-review:${sku}`);
  if (!raw) return jsonResponse({ error: 'pending record not found', sku }, 404);
  const rec = JSON.parse(raw) as PendingReview;

  const updated: PendingReview = { ...rec, status: 'rejected' };
  await env.SYNC_STATE.put(`pending-review:${sku}`, JSON.stringify(updated),
    { expirationTtl: 7 * 24 * 60 * 60 });

  return jsonResponse({ ok: true, sku, status: 'rejected' });
}

// ── INTERNAL: JSON response helper ──────────────────────────────────
//
// Duplicated from index.ts to avoid cyclic imports. Includes CORS headers
// because the Fase 3.5C review-dashboard endpoints are called from the
// browser admin panel (cross-origin: pages.dev → workers.dev), not just curl.

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}
