// ── SHOPIFY ADMIN API CLIENT ─────────────────────────────────────────
//
// OAuth 2 client credentials grant + token caching, plus the GraphQL
// helpers used across the Worker.
//
// Originally inlined in src/index.ts; extracted to a module for reuse
// between the backorder flow (existing) and the new Fase 3 sync flows.
//
// Token flow:
//   1. POST to /admin/oauth/access_token with grant_type=client_credentials
//   2. Cache the access_token in WISHLIST KV under `shopify_admin_token`
//      (we reuse the existing namespace; no need for a new one)
//   3. On any 401 from a subsequent Admin API call, evict and refresh once
//
// Note on the 2026-04 idempotency directive:
//   As of API version 2026-04, several inventory mutations REQUIRE an
//   `@idempotent(key: $idempotencyKey)` directive in the GraphQL query.
//   Callers of decrementInventoryBySku() must pass a stable key per logical
//   operation (typically the source order ID, e.g. Discogs order ID).

const SHOPIFY_DOMAIN = 'house-only-2.myshopify.com';
const SHOPIFY_API_VERSION = '2026-04';

const TOKEN_KV_KEY = 'shopify_admin_token';
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;  // refresh after 23h to stay clear of any 24h expiry
const TOKEN_REFRESH_THRESHOLD_MS = 60 * 60 * 1000;  // refresh if <1h until expiry

// ── TYPES ───────────────────────────────────────────────────────────

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Subset of Env that this module needs. Keeping it narrow makes the module
 * easier to test in isolation — callers only need to pass what's used.
 */
export interface ShopifyAdminEnv {
  WISHLIST: KVNamespace;
  SHOPIFY_ADMIN_CLIENT_ID: string;
  SHOPIFY_ADMIN_CLIENT_SECRET: string;
}

// ── TOKEN MANAGEMENT ────────────────────────────────────────────────

async function fetchFreshAdminToken(env: ShopifyAdminEnv): Promise<string> {
  if (!env.SHOPIFY_ADMIN_CLIENT_ID || !env.SHOPIFY_ADMIN_CLIENT_SECRET) {
    throw new Error('Shopify admin credentials not configured');
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.SHOPIFY_ADMIN_CLIENT_ID,
    client_secret: env.SHOPIFY_ADMIN_CLIENT_SECRET,
  });
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Shopify token endpoint returned ${r.status}: ${text}`);
  }
  const data: any = await r.json();
  const token = data?.access_token;
  if (!token) {
    throw new Error(`Shopify token response missing access_token: ${JSON.stringify(data)}`);
  }
  const cached: CachedToken = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
  await env.WISHLIST.put(TOKEN_KV_KEY, JSON.stringify(cached));
  return token;
}

export async function getShopifyAdminToken(
  env: ShopifyAdminEnv,
  force = false,
): Promise<string> {
  if (!force) {
    const raw = await env.WISHLIST.get(TOKEN_KV_KEY);
    if (raw) {
      try {
        const cached: CachedToken = JSON.parse(raw);
        const msUntilExpiry = cached.expiresAt - Date.now();
        if (msUntilExpiry > TOKEN_REFRESH_THRESHOLD_MS && cached.token) {
          return cached.token;
        }
      } catch { /* fall through to refresh */ }
    }
  }
  return await fetchFreshAdminToken(env);
}

// ── GRAPHQL CLIENT ──────────────────────────────────────────────────

/**
 * Execute a GraphQL query against Shopify Admin API.
 * Automatically refreshes the token on 401 and retries once.
 *
 * @param env  Worker env (needs WISHLIST KV + admin credentials)
 * @param query  GraphQL query string
 * @param variables  GraphQL variables
 * @returns The full JSON response (caller checks `data.errors`, `data.data.X.userErrors`, etc.)
 */
export async function shopifyAdminGraphQL(
  env: ShopifyAdminEnv,
  query: string,
  variables?: any,
): Promise<any> {
  let token = await getShopifyAdminToken(env);
  let r = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables: variables || {} }),
    },
  );

  if (r.status === 401) {
    token = await getShopifyAdminToken(env, true);
    r = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query, variables: variables || {} }),
      },
    );
  }

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Shopify Admin API ${r.status}: ${text}`);
  }

  return await r.json();
}

// ── INVENTORY LOOKUP ────────────────────────────────────────────────

export interface VariantInventoryInfo {
  variantId: string;        // gid://shopify/ProductVariant/...
  inventoryItemId: string;  // gid://shopify/InventoryItem/...
  productId: string;        // gid://shopify/Product/...
  sku: string;
}

/**
 * Find a Shopify ProductVariant by SKU and return the gids needed for
 * inventory mutations. Returns null if no variant matches.
 *
 * Uses productVariants(query: "sku:XXX") which is indexed and fast.
 */
export async function findVariantBySku(
  env: ShopifyAdminEnv,
  sku: string,
): Promise<VariantInventoryInfo | null> {
  // Escape quotes in SKU for the query string. Shopify search syntax uses
  // double quotes around the value; backslash escapes them.
  const escapedSku = sku.replace(/"/g, '\\"');

  const query = `
    query findVariantBySku($q: String!) {
      productVariants(first: 5, query: $q) {
        edges {
          node {
            id
            sku
            inventoryItem { id }
            product { id }
          }
        }
      }
    }
  `;

  const result = await shopifyAdminGraphQL(env, query, { q: `sku:"${escapedSku}"` });
  const edges = result?.data?.productVariants?.edges || [];

  // Exact match (Shopify search is loose by default)
  const exact = edges.find((e: any) => e?.node?.sku === sku);
  if (!exact) return null;

  return {
    variantId: exact.node.id,
    inventoryItemId: exact.node.inventoryItem?.id,
    productId: exact.node.product?.id,
    sku: exact.node.sku,
  };
}

// ── LOCATION LOOKUP ─────────────────────────────────────────────────

/**
 * Fetch the primary location ID. houseonly.store has a single warehouse
 * (Fuente del Fresno, Madrid), so we cache the first active location.
 */
export async function getPrimaryLocationId(env: ShopifyAdminEnv): Promise<string> {
  const query = `
    query {
      locations(first: 1, includeInactive: false) {
        edges { node { id name } }
      }
    }
  `;
  const result = await shopifyAdminGraphQL(env, query);
  const id = result?.data?.locations?.edges?.[0]?.node?.id;
  if (!id) throw new Error('No active Shopify location found');
  return id;
}

// ── INVENTORY MUTATION ──────────────────────────────────────────────

export interface InventoryAdjustment {
  inventoryItemId: string;  // gid://shopify/InventoryItem/...
  locationId: string;       // gid://shopify/Location/...
  delta: number;            // negative to decrement
}

/**
 * Adjust inventory quantities by deltas at specific locations.
 *
 * Uses Shopify 2026-04 API which requires an idempotency key. Caller MUST
 * provide a stable key per logical operation (e.g. the Discogs order ID).
 * Re-running with the same key is a no-op, which is exactly what we want
 * when the cron polling retries an order that's already been processed.
 *
 * @param env  Worker env
 * @param adjustments  List of changes
 * @param idempotencyKey  Stable per-operation key (e.g. discogs_order:1234567)
 * @param reason  Shopify reason code (default: "correction")
 * @param referenceDocumentUri  Optional audit trail URI
 */
export async function adjustInventory(
  env: ShopifyAdminEnv,
  adjustments: InventoryAdjustment[],
  idempotencyKey: string,
  reason = 'correction',
  referenceDocumentUri?: string,
): Promise<{ ok: true; groupId?: string } | { ok: false; userErrors: any[] }> {
  if (adjustments.length === 0) {
    return { ok: true };
  }

  const mutation = `
    mutation adjustInventory(
      $input: InventoryAdjustQuantitiesInput!
      $idempotencyKey: String!
    ) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        userErrors { field message code }
        inventoryAdjustmentGroup {
          id
          createdAt
          reason
          changes { name delta }
        }
      }
    }
  `;

  const variables = {
    input: {
      reason,
      name: 'available',
      ...(referenceDocumentUri ? { referenceDocumentUri } : {}),
      changes: adjustments.map(a => ({
        delta: a.delta,
        inventoryItemId: a.inventoryItemId,
        locationId: a.locationId,
      })),
    },
    idempotencyKey,
  };

  const result = await shopifyAdminGraphQL(env, mutation, variables);
  const payload = result?.data?.inventoryAdjustQuantities;
  const userErrors = payload?.userErrors || [];

  if (userErrors.length > 0) {
    return { ok: false, userErrors };
  }

  return {
    ok: true,
    groupId: payload?.inventoryAdjustmentGroup?.id,
  };
}
