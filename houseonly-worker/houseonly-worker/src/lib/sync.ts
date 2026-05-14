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
//   - sync-bootstrap : populate KV with SKU↔listing_id mapping (one-shot, Fase 3C)
//   - sync-status    : read-only summary of sync state (Fase 3C)
//
// Endpoints planned but not yet implemented:
//   - webhook-shopify-order : delist on Discogs when Shopify sells (Fase 3D)
//   - scheduled handler     : poll Discogs orders, decrement Shopify (Fase 3E)

import { getInventory, type DiscogsListing } from './discogs';

const DISCOGS_USERNAME = 'houseonly';

// ── ENV ─────────────────────────────────────────────────────────────

/** Subset of Env that sync handlers need. */
export interface SyncEnv {
  SYNC_STATE: KVNamespace;
  DISCOGS_TOKEN: string;
  BOOTSTRAP_AUTH_SECRET: string;
}

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
