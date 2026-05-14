// ── DISCOGS ↔ SHOPIFY SYNC HANDLERS ──────────────────────────────────
//
// Module for Fase 3 of the houseonly.store project: keeping inventory in
// sync between Shopify (primary) and Discogs (secondary) without manual
// intervention.
//
// This file holds the handlers for the new ?action=... endpoints added in
// Fase 3C and beyond. Each handler is independent and can be invoked
// without affecting the rest of the Worker.
//
// Endpoints currently implemented:
//   - sync-bootstrap        : populate KV with SKU↔listing_id mapping (Fase 3C)
//   - sync-status           : read-only summary of sync state (Fase 3C)
//   - sync-register-webhook : register Shopify orders/create webhook (Fase 3D)
//   - webhook-shopify-order : delist on Discogs when Shopify sells (Fase 3D)
//
// Endpoints planned but not yet implemented:
//   - scheduled handler     : poll Discogs orders, decrement Shopify (Fase 3E)

import { getInventory, updateListingStatus, type DiscogsListing } from './discogs';
import {
  validateShopifyWebhookHmac,
  registerShopifyWebhook,
  listShopifyWebhooks,
  type ShopifyAdminEnv,
} from './shopify-admin';

const DISCOGS_USERNAME = 'houseonly';
const SHOPIFY_ORDERS_CREATE_TOPIC = 'ORDERS_CREATE';

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
  const [lastRun, statsRaw, lastPolled] = await Promise.all([
    env.SYNC_STATE.get('meta:bootstrap_last_run'),
    env.SYNC_STATE.get('meta:bootstrap_stats'),
    env.SYNC_STATE.get('meta:last_polled_ts'),
  ]);

  let stats: BootstrapStats | null = null;
  if (statsRaw) {
    try { stats = JSON.parse(statsRaw); } catch { /* leave null */ }
  }

  return jsonResponse({
    bootstrap_last_run: lastRun || null,
    bootstrap_stats: stats,
    last_polled_ts: lastPolled || null,
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

// ── INTERNAL: JSON response helper ──────────────────────────────────
//
// Duplicated from index.ts to avoid cyclic imports. Kept minimal —
// CORS is irrelevant for admin-only endpoints called by curl.

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
