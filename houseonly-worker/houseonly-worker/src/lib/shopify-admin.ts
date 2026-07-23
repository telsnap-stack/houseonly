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

// ── CHANNEL PUBLICATION ─────────────────────────────────────────────
// Publish a product to EVERY sales channel (publication), including the
// headless / custom-app Storefront channel. A Shopify CSV import only publishes
// to the Online Store channel, so freshly imported products stay invisible to
// the headless storefront (which reads the Storefront API and only returns
// products published to its channel) until they are published here.
//
// Idempotent: re-publishing an already-published product is a no-op, so this is
// safe to call on every products/create webhook (including Shopify retries).
// Requires the `write_publications` access scope on the admin token — without it
// Shopify returns an access-denied error, surfaced in the returned `errors`.
export async function publishProductToAllChannels(
  env: ShopifyAdminEnv,
  productGid: string,
): Promise<{ published: number; channels: string[]; errors: string[] }> {
  // 1. List all sales channels (publications).
  const pubResp = await shopifyAdminGraphQL(
    env,
    `query { publications(first: 50) { nodes { id name } } }`,
  );
  const gqlErrors: string[] = (pubResp?.errors || []).map((e: any) => e.message);
  const nodes: Array<{ id: string; name: string }> =
    pubResp?.data?.publications?.nodes || [];
  if (!nodes.length) {
    return {
      published: 0,
      channels: [],
      errors: gqlErrors.length ? gqlErrors : ['no publications returned'],
    };
  }

  // 2. Publish to all of them in one mutation. publishablePublish is additive
  //    and idempotent, so already-published channels are left untouched.
  const resp = await shopifyAdminGraphQL(
    env,
    `mutation PublishAll($id: ID!, $input: [PublishablePublishInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }`,
    { id: productGid, input: nodes.map(n => ({ publicationId: n.id })) },
  );

  const errors: string[] = [
    ...(resp?.errors || []).map((e: any) => e.message),
    ...(resp?.data?.publishablePublish?.userErrors || []).map((e: any) => e.message),
  ];
  return {
    published: errors.length ? 0 : nodes.length,
    channels: nodes.map(n => n.name),
    errors,
  };
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
        // Must be present per the 2026-04 validator. `null` skips the
        // compare-and-swap check — correct here because the Discogs sync is
        // the source of truth for this decrement (no concurrent-update guard needed).
        changeFromQuantity: null,
      })),
    },
    idempotencyKey,
  };

  const result = await shopifyAdminGraphQL(env, mutation, variables);

  // Top-level GraphQL errors leave `data` null. These must NOT be treated as
  // success — this was the root cause of silent inventory drift: a rejected
  // mutation (e.g. INVALID_AVAILABLE_DOCUMENT) surfaced here, `payload` was
  // undefined, `userErrors` defaulted to [], and the function returned ok:true.
  if (result?.errors?.length) {
    return { ok: false, userErrors: result.errors };
  }

  const payload = result?.data?.inventoryAdjustQuantities;
  const userErrors = payload?.userErrors || [];

  if (userErrors.length > 0) {
    return { ok: false, userErrors };
  }

  // Require positive proof the adjustment actually applied. Without this a null
  // payload silently returned ok:true. If no adjustment group came back, the
  // change did not happen — report failure so the audit shows the truth.
  if (!payload?.inventoryAdjustmentGroup?.id) {
    return {
      ok: false,
      userErrors: [{
        message: 'inventoryAdjustQuantities returned no inventoryAdjustmentGroup',
        raw: result,
      }],
    };
  }

  return {
    ok: true,
    groupId: payload.inventoryAdjustmentGroup.id,
  };
}

// ── WEBHOOK HMAC VALIDATION ─────────────────────────────────────────
//
// Shopify signs every webhook with HMAC-SHA256 using the app's CLIENT
// SECRET (the same SHOPIFY_ADMIN_CLIENT_SECRET we already have for OAuth).
// The signature is sent in the `X-Shopify-Hmac-SHA256` header as base64.
//
// CRITICAL: must be computed on the raw request body (bytes, not parsed
// JSON). In our handler we read the body once as text and pass it here
// AND to JSON.parse() — that ordering preserves the raw bytes.

/**
 * Verify that a webhook request was sent by Shopify.
 *
 * @param rawBody   The raw request body as a string (UTF-8)
 * @param hmacHeader The value of the X-Shopify-Hmac-SHA256 header
 * @param secret    The app's client secret
 * @returns true if the HMAC matches, false otherwise
 */
export async function validateShopifyWebhookHmac(
  rawBody: string,
  hmacHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!hmacHeader || !secret) return false;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const bodyData = encoder.encode(rawBody);

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    return false;
  }

  const signature = await crypto.subtle.sign('HMAC', key, bodyData);

  // Base64-encode the signature
  const signatureBytes = new Uint8Array(signature);
  let binary = '';
  for (let i = 0; i < signatureBytes.byteLength; i++) {
    binary += String.fromCharCode(signatureBytes[i]);
  }
  const computed = btoa(binary);

  // Constant-time comparison
  return constantTimeEqual(computed, hmacHeader);
}

/**
 * Length-independent constant-time string comparison.
 *
 * We use this for HMAC comparison so an attacker cannot use timing
 * differences to learn anything about the expected value. Standard
 * `===` short-circuits on first difference, which is a timing oracle.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ── WEBHOOK REGISTRATION ────────────────────────────────────────────

export interface WebhookRegistrationResult {
  ok: boolean;
  webhookId?: string;
  topic?: string;
  uri?: string;
  userErrors?: any[];
  error?: string;
}

/**
 * Register a webhook subscription via the GraphQL Admin API.
 * Idempotent-ish: if a subscription with the same topic + uri already
 * exists, Shopify returns a userError (we treat it as success).
 *
 * @param env  Worker env
 * @param topic  Shopify webhook topic (e.g. "ORDERS_CREATE")
 * @param uri    Full HTTPS URL where webhooks should be delivered
 */
export async function registerShopifyWebhook(
  env: ShopifyAdminEnv,
  topic: string,
  uri: string,
): Promise<WebhookRegistrationResult> {
  const mutation = `
    mutation webhookSubscriptionCreate(
      $topic: WebhookSubscriptionTopic!
      $webhookSubscription: WebhookSubscriptionInput!
    ) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription {
          id
          topic
          uri
        }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    topic,
    webhookSubscription: { uri, format: 'JSON' },
  };

  try {
    const result = await shopifyAdminGraphQL(env, mutation, variables);
    const payload = result?.data?.webhookSubscriptionCreate;
    const userErrors = payload?.userErrors || [];
    const webhook = payload?.webhookSubscription;

    if (webhook?.id) {
      return {
        ok: true,
        webhookId: webhook.id,
        topic: webhook.topic,
        uri: webhook.uri,
      };
    }

    return { ok: false, userErrors };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * List existing webhook subscriptions for the app, used by callers that
 * want to check whether a webhook is already registered before creating
 * one (avoids spurious "already exists" userErrors).
 */
export async function listShopifyWebhooks(
  env: ShopifyAdminEnv,
): Promise<Array<{ id: string; topic: string; uri: string }>> {
  const query = `
    query {
      webhookSubscriptions(first: 50) {
        edges {
          node {
            id
            topic
            endpoint {
              __typename
              ... on WebhookHttpEndpoint { callbackUrl }
            }
          }
        }
      }
    }
  `;
  const result = await shopifyAdminGraphQL(env, query);
  const edges = result?.data?.webhookSubscriptions?.edges || [];
  return edges.map((e: any) => ({
    id: e.node.id,
    topic: e.node.topic,
    uri: e.node.endpoint?.callbackUrl || '',
  }));
}

// ── DISCOGS ORDER → SHOPIFY ORDER (Fase 3G) ─────────────────────────
//
// Creates a real, PAID Shopify order for a Discogs marketplace sale so the
// sale is captured in Shopify for Spanish fiscal invoicing (Shoptopus reads
// completed Shopify orders to produce the factura).
//
// Design decisions (confirmed with Eduardo):
//   - Line prices = each variant's CURRENT SHOPIFY PRICE (not the Discogs
//     total). We pass variantId with no price override, so Shopify uses the
//     product's own price. Rationale: the factura must reflect the record's
//     actual selling price in the shop, independent of PayPal/Discogs fees
//     and shipping that the buyer paid on Discogs.
//   - taxExempt: true → NO VAT on these orders (per fiscal instruction).
//     This overrides each product's own `taxable:true` flag at order level.
//   - Real buyer: name/address/email parsed from the Discogs order and set
//     as the Shopify shippingAddress + email so the factura names the buyer.
//   - draftOrderComplete(paymentPending:false) → order is marked PAID and
//     converts to a real order. Completing the draft performs the SINGLE
//     inventory decrement — so the caller must NOT also call adjustInventory.
//   - Tagged `source:discogs`; Discogs order id in note + custom attribute
//     for traceability.

export interface DiscogsBuyer {
  name: string;
  email?: string;
  address1: string;
  address2?: string;
  city: string;
  province?: string;
  zip: string;
  country: string;
  phone?: string;
}

export interface DiscogsOrderLine {
  variantId: string;   // gid://shopify/ProductVariant/...
  quantity: number;
}

export interface CreateDiscogsOrderResult {
  ok: boolean;
  draftOrderId?: string;
  orderId?: string;       // gid://shopify/Order/... after completion
  orderName?: string;     // e.g. "#1007"
  error?: string;
  userErrors?: any[];
}

/**
 * Create a paid Shopify order for a Discogs sale.
 *
 * @param env         Worker env
 * @param discogsOrderId  e.g. "147628-8" (for tags/note/traceability)
 * @param lines       Line items (variantId + quantity)
 * @param buyer       Parsed buyer details from the Discogs order
 */
// Minimal country name → ISO 3166-1 alpha-2 map covering the markets a
// Madrid vinyl shop actually ships to. Extend as needed. Unknown → undefined
// (we then omit countryCode rather than reject the order).
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  'spain': 'ES', 'españa': 'ES', 'espana': 'ES',
  'italy': 'IT', 'italia': 'IT',
  'france': 'FR', 'germany': 'DE', 'deutschland': 'DE',
  'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB', 'england': 'GB',
  'portugal': 'PT', 'netherlands': 'NL', 'holland': 'NL',
  'belgium': 'BE', 'ireland': 'IE', 'austria': 'AT', 'switzerland': 'CH',
  'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK', 'finland': 'FI',
  'poland': 'PL', 'czechia': 'CZ', 'czech republic': 'CZ', 'greece': 'GR',
  'united states': 'US', 'usa': 'US', 'united states of america': 'US',
  'canada': 'CA', 'japan': 'JP', 'australia': 'AU',
};
function countryNameToCode(name: string): string | undefined {
  if (!name) return undefined;
  return COUNTRY_NAME_TO_CODE[name.trim().toLowerCase()];
}

export async function createDiscogsOrder(
  env: ShopifyAdminEnv,
  discogsOrderId: string,
  lines: DiscogsOrderLine[],
  buyer: DiscogsBuyer,
): Promise<CreateDiscogsOrderResult> {
  if (lines.length === 0) {
    return { ok: false, error: 'no line items' };
  }

  // ── 1. Create the draft order ─────────────────────────────────
  const createMutation = `
    mutation createDiscogsDraft($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id }
        userErrors { field message }
      }
    }
  `;

  const shippingAddress: any = {
    firstName: buyer.name,   // Discogs gives one combined name; put it all in firstName
    address1: buyer.address1,
    city: buyer.city,
    zip: buyer.zip,
  };
  // Shopify wants a 2-letter ISO countryCode, but Discogs gives the country
  // NAME ("Spain"). Map it; if unknown, omit countryCode rather than send an
  // invalid value (Shopify would reject the whole order).
  const cc = countryNameToCode(buyer.country);
  if (cc) shippingAddress.countryCode = cc;
  if (buyer.address2) shippingAddress.address2 = buyer.address2;
  // NOTE: provinceCode requires a valid subdivision code we can't reliably
  // derive from Discogs' free-text region, so we fold the region into
  // address2 to preserve it without risking an invalid-code rejection.
  if (buyer.province) {
    shippingAddress.address2 = shippingAddress.address2
      ? `${shippingAddress.address2}, ${buyer.province}`
      : buyer.province;
  }
  if (buyer.phone) shippingAddress.phone = buyer.phone;

  const draftInput: any = {
    lineItems: lines.map(l => ({ variantId: l.variantId, quantity: l.quantity })),
    taxExempt: true,                       // NO VAT
    shippingAddress,
    tags: ['source:discogs'],
    sourceName: 'discogs',
    note: `Discogs order ${discogsOrderId}`,
    customAttributes: [{ key: 'discogs_order_id', value: discogsOrderId }],
  };
  if (buyer.email) draftInput.email = buyer.email;

  const createRes = await shopifyAdminGraphQL(env, createMutation, { input: draftInput });
  if (createRes?.errors?.length) {
    return { ok: false, error: 'draftOrderCreate GraphQL error', userErrors: createRes.errors };
  }
  const createPayload = createRes?.data?.draftOrderCreate;
  const createErrs = createPayload?.userErrors || [];
  if (createErrs.length > 0) {
    return { ok: false, error: 'draftOrderCreate userErrors', userErrors: createErrs };
  }
  const draftOrderId = createPayload?.draftOrder?.id;
  if (!draftOrderId) {
    return { ok: false, error: 'draftOrderCreate returned no draftOrder id', userErrors: [createRes] };
  }

  // ── 2. Complete the draft, marking it PAID ────────────────────
  // paymentPending:false → mark as paid. Completing claims inventory (the
  // single decrement — caller must not adjustInventory separately).
  const completeMutation = `
    mutation completeDiscogsDraft($id: ID!) {
      draftOrderComplete(id: $id, paymentPending: false) {
        draftOrder {
          id
          order { id name }
        }
        userErrors { field message }
      }
    }
  `;

  const completeRes = await shopifyAdminGraphQL(env, completeMutation, { id: draftOrderId });
  if (completeRes?.errors?.length) {
    return { ok: false, draftOrderId, error: 'draftOrderComplete GraphQL error', userErrors: completeRes.errors };
  }
  const completePayload = completeRes?.data?.draftOrderComplete;
  const completeErrs = completePayload?.userErrors || [];
  if (completeErrs.length > 0) {
    return { ok: false, draftOrderId, error: 'draftOrderComplete userErrors', userErrors: completeErrs };
  }
  const order = completePayload?.draftOrder?.order;
  if (!order?.id) {
    return { ok: false, draftOrderId, error: 'draftOrderComplete returned no order', userErrors: [completeRes] };
  }

  return {
    ok: true,
    draftOrderId,
    orderId: order.id,
    orderName: order.name,
  };
}
