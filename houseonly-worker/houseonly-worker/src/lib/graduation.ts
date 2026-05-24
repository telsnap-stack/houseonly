// ── FORTHCOMING GRADUATION ───────────────────────────────────────────
//
// "Release date is the gate into the main catalogue."
//
// A pre-order is a Shopify product tagged `forthcoming` + `release:YYYY-MM-DD`,
// stock 0, oversell on. It shows ONLY in the Forthcoming section (the catalogue
// query excludes `-tag:'forthcoming'`).
//
// When its release date passes, it is no longer a pre-order. It must leave the
// Forthcoming section and become a normal catalogue product governed by stock:
//   - stock > 0  → BUY
//   - stock 0    → BACKORDER (REQUEST, unpaid)
//
// Because the Forthcoming-vs-catalogue routing is SERVER-SIDE and tag-based
// (`tag:'forthcoming'` vs `-tag:'forthcoming'`), and Shopify cannot range-filter
// a tag by date, the ONLY way to move a product across that boundary is to
// REMOVE the `forthcoming` tag. That is what this module does:
//
//   1. Query Admin API for products tagged `forthcoming` (paginated).
//   2. Parse each product's `release:YYYY-MM-DD` tag.
//   3. If the release date is today or in the past → the product is OVERDUE.
//   4. Remove ONLY the `forthcoming` tag (tagsRemove) → it graduates.
//
// SAFETY:
//   - Gated by KV `meta:graduation_mode` (default 'dry'). In dry mode it writes
//     a record of what it WOULD do to KV (`graduation-overdue:{productId}`) and
//     performs NO Shopify writes. Flip to 'live' via the ?action=graduation-mode
//     endpoint only after reviewing the dry-run records.
//   - Only ever removes the single `forthcoming` tag. `release:`, `source:`,
//     genre, label, year, mothertongue etc. are untouched.
//   - Products with a missing or unparseable `release:` tag are SKIPPED (never
//     graduated on bad data) and counted under `skipped_no_date`.
//   - Per-product errors are caught and counted; one failure never aborts the
//     batch.
//   - Date comparison is done in UTC using the date portion only, so a release
//     dated today (YYYY-MM-DD) graduates from 00:00 UTC of that day. Matches the
//     "date is the gate" rule (graduate on/after the street date).

import { shopifyAdminGraphQL } from './shopify-admin';
import type { ShopifyAdminEnv } from './shopify-admin';

const FORTHCOMING_TAG = 'forthcoming';
const MODE_KEY = 'meta:graduation_mode';
const OVERDUE_PREFIX = 'graduation-overdue:';      // dry-run record of intended graduations
const DONE_PREFIX = 'graduation-done:';            // audit record of live graduations
const OVERDUE_TTL_S = 30 * 24 * 60 * 60;           // 30 days
const DONE_TTL_S = 90 * 24 * 60 * 60;              // 90 days
const PAGE_SIZE = 100;                             // products per Admin API page
const MAX_PAGES = 50;                              // hard stop: 50 × 100 = 5000 forthcoming products

// graduation.ts needs SYNC_STATE for the mode flag + records, plus the
// ShopifyAdminEnv pieces for the API calls.
export interface GraduationEnv extends ShopifyAdminEnv {
  SYNC_STATE: KVNamespace;
}

export type GraduationMode = 'dry' | 'live';

export interface GraduationResult {
  mode: GraduationMode;
  scanned: number;          // forthcoming products examined
  overdue: number;          // past-dated (would graduate / did graduate)
  graduated: number;        // live: tag actually removed
  skipped_no_date: number;  // forthcoming but no parseable release: tag
  errors: number;
  details: Array<{ productId: string; sku?: string; release: string; action: string }>;
  finished_at: string;
}

/**
 * Read the current graduation mode from KV. Defaults to 'dry' (log only, no
 * writes) if the key is missing or unrecognized — fail safe.
 */
export async function getGraduationMode(env: GraduationEnv): Promise<GraduationMode> {
  const raw = await env.SYNC_STATE.get(MODE_KEY);
  return raw === 'live' ? 'live' : 'dry';
}

/**
 * Set the graduation mode. Only 'live' enables actual tag removal; anything
 * else is normalized to 'dry'.
 */
export async function setGraduationMode(env: GraduationEnv, mode: string): Promise<GraduationMode> {
  const normalized: GraduationMode = mode === 'live' ? 'live' : 'dry';
  await env.SYNC_STATE.put(MODE_KEY, normalized);
  return normalized;
}

/**
 * Parse a `release:YYYY-MM-DD` value out of a product's tags. Returns the raw
 * date string (e.g. "2026-05-01") or null if no parseable release tag exists.
 *
 * Mirrors the frontend parser: find the tag matching /^release:/i and take
 * everything after the first colon.
 */
function parseReleaseDate(tags: string[]): string | null {
  const tag = tags.find(t => /^release:/i.test(t));
  if (!tag) return null;
  const raw = tag.slice(tag.indexOf(':') + 1).trim();
  // Require a strict YYYY-MM-DD shape so we never graduate on garbage.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  // Validate it's a real date.
  const t = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return raw;
}

/**
 * Today's date in UTC as YYYY-MM-DD. A release is overdue when its date string
 * is <= today's date string (ISO date strings compare correctly as strings).
 */
function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Pull the first variant SKU from a product node (best-effort, for logging).
 */
function firstSku(node: any): string | undefined {
  return node?.variants?.edges?.[0]?.node?.sku || undefined;
}

/**
 * Main entry point. Scans all `forthcoming`-tagged products, graduates the ones
 * whose release date has passed.
 *
 * @param env   Worker env (SYNC_STATE + Shopify admin creds)
 * @param modeOverride  Optional explicit mode; if omitted, read from KV.
 */
export async function runGraduation(
  env: GraduationEnv,
  modeOverride?: GraduationMode,
): Promise<GraduationResult> {
  const mode = modeOverride || await getGraduationMode(env);
  const today = todayUtcDate();

  const result: GraduationResult = {
    mode,
    scanned: 0,
    overdue: 0,
    graduated: 0,
    skipped_no_date: 0,
    errors: 0,
    details: [],
    finished_at: '',
  };

  let cursor: string | null = null;
  let page = 0;

  while (page < MAX_PAGES) {
    page++;
    const after = cursor ? `, after: "${cursor}"` : '';
    const query = `
      query {
        products(first: ${PAGE_SIZE}, query: "tag:'${FORTHCOMING_TAG}'"${after}) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              tags
              variants(first: 1) { edges { node { sku } } }
            }
          }
        }
      }
    `;

    let data: any;
    try {
      data = await shopifyAdminGraphQL(env, query);
    } catch (e: any) {
      // A page-level failure (network / API) — record and stop. We do NOT
      // continue blindly, because a partial scan could mis-report.
      result.errors++;
      result.details.push({ productId: '(page-fetch)', release: '', action: `ERROR: ${e?.message || e}` });
      break;
    }

    const conn = data?.data?.products;
    if (!conn) {
      result.errors++;
      result.details.push({ productId: '(page-parse)', release: '', action: `ERROR: malformed response` });
      break;
    }

    const edges = conn.edges || [];
    for (const edge of edges) {
      const node = edge?.node;
      if (!node?.id) continue;
      result.scanned++;

      const tags: string[] = Array.isArray(node.tags) ? node.tags : [];
      const release = parseReleaseDate(tags);
      const sku = firstSku(node);

      if (!release) {
        // Forthcoming but no usable release date — never graduate on bad data.
        result.skipped_no_date++;
        result.details.push({ productId: node.id, sku, release: '(none)', action: 'skipped_no_date' });
        continue;
      }

      // Overdue when release date is today or earlier (string compare on ISO dates).
      const overdue = release <= today;
      if (!overdue) continue;

      result.overdue++;

      if (mode === 'dry') {
        // Record what we WOULD do, no Shopify write.
        const record = JSON.stringify({
          productId: node.id, sku, release, detected_at: new Date().toISOString(),
        });
        try {
          await env.SYNC_STATE.put(`${OVERDUE_PREFIX}${node.id}`, record, { expirationTtl: OVERDUE_TTL_S });
        } catch { /* KV write best-effort in dry mode */ }
        result.details.push({ productId: node.id, sku, release, action: 'would_graduate' });
        continue;
      }

      // LIVE: remove ONLY the forthcoming tag.
      try {
        const mutation = `
          mutation removeForthcoming($id: ID!, $tags: [String!]!) {
            tagsRemove(id: $id, tags: $tags) {
              node { id }
              userErrors { field message }
            }
          }
        `;
        const res = await shopifyAdminGraphQL(env, mutation, {
          id: node.id,
          tags: [FORTHCOMING_TAG],
        });
        const userErrors = res?.data?.tagsRemove?.userErrors || [];
        if (userErrors.length > 0) {
          result.errors++;
          result.details.push({
            productId: node.id, sku, release,
            action: `ERROR: ${userErrors.map((u: any) => u.message).join('; ')}`,
          });
          continue;
        }
        result.graduated++;
        result.details.push({ productId: node.id, sku, release, action: 'graduated' });
        // Audit record of the live graduation.
        try {
          await env.SYNC_STATE.put(
            `${DONE_PREFIX}${node.id}`,
            JSON.stringify({ productId: node.id, sku, release, graduated_at: new Date().toISOString() }),
            { expirationTtl: DONE_TTL_S },
          );
        } catch { /* audit best-effort */ }
        // Clean up any prior dry-run record for this product.
        try { await env.SYNC_STATE.delete(`${OVERDUE_PREFIX}${node.id}`); } catch { /* ignore */ }
      } catch (e: any) {
        result.errors++;
        result.details.push({ productId: node.id, sku, release, action: `ERROR: ${e?.message || e}` });
      }
    }

    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  result.finished_at = new Date().toISOString();

  // Persist a summary of the last run for inspection via the status endpoint.
  try {
    await env.SYNC_STATE.put('meta:graduation_last_run', JSON.stringify({
      mode: result.mode,
      scanned: result.scanned,
      overdue: result.overdue,
      graduated: result.graduated,
      skipped_no_date: result.skipped_no_date,
      errors: result.errors,
      finished_at: result.finished_at,
    }));
  } catch { /* summary best-effort */ }

  return result;
}
