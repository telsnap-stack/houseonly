// ── EBAY REST CLIENT ─────────────────────────────────────────────────
//
// The eBay calls the third sales channel needs (src/lib/ebay.ts), and nothing
// else. Every path, header and field here comes from eBay's own OpenAPI specs
// (sell_inventory_v1, sell_account_v1, sell_fulfillment_v1,
// commerce_notification_v1, downloaded 2026-10-26) and from their official
// Node clients (ebay-oauth-nodejs-client, event-notification-nodejs-sdk):
//
//   OAuth token        POST https://api.ebay.com/identity/v1/oauth2/token
//                      Basic base64(client_id:client_secret)
//                      user:  grant_type=refresh_token&refresh_token=…&scope=…
//                      app:   grant_type=client_credentials&scope=api_scope
//   Inventory item     PUT  /sell/inventory/v1/inventory_item/{sku}  (Content-Language)
//   Offer              POST /sell/inventory/v1/offer  · GET /offer?sku=&marketplace_id=
//                      PUT  /offer/{id} · POST /offer/{id}/publish · POST /offer/{id}/withdraw
//   Location           GET  /sell/inventory/v1/location
//   Policies           GET  /sell/account/v1/{fulfillment|payment|return}_policy/get_by_policy_name
//   Selling limit      GET  /sell/account/v1/privilege  → sellingLimit.quantity (optional)
//   Orders             GET  /sell/fulfillment/v1/order?filter=… · GET /order/{id}
//   Public key         GET  /commerce/notification/v1/public_key/{kid}   (app token)
//
// Secrets (wrangler secret put …, staging first — see docs/ebay.md):
//   EBAY_CLIENT_ID, EBAY_CLIENT_SECRET  the keyset (pending eBay approval)
//   EBAY_REFRESH_TOKEN                  from the one-off OAuth consent
//   EBAY_VERIFICATION_TOKEN             the token typed into the developer
//                                       portal for the notification endpoint
// All optional: with none set every caller reports "not configured" instead
// of failing, so the worker deploys and runs exactly as before.

export interface EbayEnv {
  SYNC_STATE: KVNamespace;
  EBAY_CLIENT_ID?: string;
  EBAY_CLIENT_SECRET?: string;
  EBAY_REFRESH_TOKEN?: string;
  EBAY_VERIFICATION_TOKEN?: string;
}

export const EBAY_API = 'https://api.ebay.com';
export const EBAY_MARKETPLACE = 'EBAY_ES';
export const EBAY_CONTENT_LANGUAGE = 'es-ES';

// Scopes asked for at consent AND on every refresh. A refresh may only ask for
// scopes the seller consented to, so the consent script (scripts/ebay-oauth.mjs)
// carries a copy of this list — change both together.
export const EBAY_USER_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription',
];
const EBAY_APP_SCOPE = 'https://api.ebay.com/oauth/api_scope';

// Business policies on the seller account, by name (task brief). Resolved to
// IDs at runtime through the Account API, never hardcoded.
export const EBAY_POLICY_NAMES = {
  fulfillment: 'Vinilos - envío estándar',
  return: 'Vinilos - devolución 14 días, comprador paga',
  payment: 'Vinilos - pago inmediato',
};

const TOKEN_KEY_USER = 'ebay:token:user';
const TOKEN_KEY_APP = 'ebay:token:app';
const POLICIES_KEY = 'ebay:policies';
const POLICIES_TTL_S = 24 * 60 * 60;
const LOCATION_OVERRIDE_KEY = 'meta:ebay_location_key';
const PUBKEY_PREFIX = 'ebay:pubkey:';
// eBay: "cache the public key for about one hour".
const PUBKEY_TTL_S = 60 * 60;
// Renew a little before eBay's expiry so a token never dies mid-run.
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

export function ebayConfigured(env: EbayEnv): boolean {
  return Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET && env.EBAY_REFRESH_TOKEN);
}

// ── ERRORS ──────────────────────────────────────────────────────────

export interface EbayErrorDetail {
  errorId?: number;
  message?: string;
  longMessage?: string;
  parameters?: Array<{ name?: string; value?: string }>;
}

export class EbayApiError extends Error {
  status: number;
  errors: EbayErrorDetail[];
  constructor(status: number, errors: EbayErrorDetail[], fallback: string) {
    const first = errors[0];
    super(first
      ? `eBay ${status} ${first.errorId ?? ''}: ${first.longMessage || first.message || ''}`.trim()
      : `eBay ${status}: ${fallback.slice(0, 200)}`);
    this.status = status;
    this.errors = errors;
  }
  has(errorId: number): boolean {
    return this.errors.some(e => e.errorId === errorId);
  }
}

// publishOffer 25026 "Selling limit exceeded" (sell_inventory_v1 spec). The
// only error that must stop the whole batch: every later publish would hit it.
export const EBAY_ERR_SELLING_LIMIT = 25026;

export function isSellingLimitError(e: unknown): boolean {
  return e instanceof EbayApiError && e.has(EBAY_ERR_SELLING_LIMIT);
}

// ── TOKENS ──────────────────────────────────────────────────────────

interface CachedToken { token: string; expiresAt: number }

async function fetchToken(env: EbayEnv, body: URLSearchParams): Promise<CachedToken> {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    throw new Error('eBay not configured (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET)');
  }
  const r = await fetch(`${EBAY_API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`)}`,
    },
    body: body.toString(),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    // OAuth errors come as {error, error_description}, not the REST errors[].
    throw new Error(`eBay token refused (${r.status}): ${data.error_description || data.error || 'no access_token'}`);
  }
  return { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 0) * 1000 };
}

async function cachedToken(env: EbayEnv, key: string, mint: () => Promise<CachedToken>): Promise<string> {
  const raw = await env.SYNC_STATE.get(key);
  if (raw) {
    try {
      const c = JSON.parse(raw) as CachedToken;
      if (c.token && c.expiresAt - TOKEN_MARGIN_MS > Date.now()) return c.token;
    } catch { /* re-mint */ }
  }
  const fresh = await mint();
  const ttl = Math.max(60, Math.floor((fresh.expiresAt - Date.now()) / 1000));
  await env.SYNC_STATE.put(key, JSON.stringify(fresh), { expirationTtl: ttl });
  return fresh.token;
}

/** Seller (user) access token from the long-lived refresh token. */
export async function getUserToken(env: EbayEnv): Promise<string> {
  if (!env.EBAY_REFRESH_TOKEN) throw new Error('eBay not configured (EBAY_REFRESH_TOKEN)');
  return cachedToken(env, TOKEN_KEY_USER, () => fetchToken(env, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: env.EBAY_REFRESH_TOKEN!,
    scope: EBAY_USER_SCOPES.join(' '),
  })));
}

/** Application token (client credentials) — only getPublicKey needs it. */
export async function getAppToken(env: EbayEnv): Promise<string> {
  return cachedToken(env, TOKEN_KEY_APP, () => fetchToken(env, new URLSearchParams({
    grant_type: 'client_credentials',
    scope: EBAY_APP_SCOPE,
  })));
}

// ── REQUEST ─────────────────────────────────────────────────────────

interface EbayRequestOpts {
  body?: unknown;
  app?: boolean;               // app token instead of the seller's
  contentLanguage?: boolean;   // Inventory writes require Content-Language
}

export async function ebayRequest(env: EbayEnv, method: string, path: string, opts: EbayRequestOpts = {}): Promise<any> {
  const send = async (token: string) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.contentLanguage) headers['Content-Language'] = EBAY_CONTENT_LANGUAGE;
    return fetch(`${EBAY_API}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  };
  const tokenKey = opts.app ? TOKEN_KEY_APP : TOKEN_KEY_USER;
  const mint = () => (opts.app ? getAppToken(env) : getUserToken(env));

  let r = await send(await mint());
  if (r.status === 401) {
    // A cached token eBay already revoked: drop it and try once with a new one.
    await env.SYNC_STATE.delete(tokenKey);
    r = await send(await mint());
  }
  if (r.status === 204) return null;
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!r.ok) throw new EbayApiError(r.status, Array.isArray(data?.errors) ? data.errors : [], text);
  return data;
}

// ── ACCOUNT: POLICIES ───────────────────────────────────────────────

export interface EbayPolicyIds {
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
}

/** The three business policies' IDs, looked up by name and cached for a day. */
export async function getPolicyIds(env: EbayEnv): Promise<EbayPolicyIds> {
  const raw = await env.SYNC_STATE.get(POLICIES_KEY);
  if (raw) {
    try { return JSON.parse(raw) as EbayPolicyIds; } catch { /* re-resolve */ }
  }
  const byName = (kind: string, name: string) => ebayRequest(env, 'GET',
    `/sell/account/v1/${kind}_policy/get_by_policy_name?marketplace_id=${EBAY_MARKETPLACE}&name=${encodeURIComponent(name)}`);
  // One token for the three parallel calls, not three refreshes racing.
  await getUserToken(env);
  const [f, p, r] = await Promise.all([
    byName('fulfillment', EBAY_POLICY_NAMES.fulfillment),
    byName('payment', EBAY_POLICY_NAMES.payment),
    byName('return', EBAY_POLICY_NAMES.return),
  ]);
  const ids: EbayPolicyIds = {
    fulfillmentPolicyId: f?.fulfillmentPolicyId,
    paymentPolicyId: p?.paymentPolicyId,
    returnPolicyId: r?.returnPolicyId,
  };
  const missing = Object.entries(ids).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`eBay policies not found on ${EBAY_MARKETPLACE}: ${missing.join(', ')}`);
  await env.SYNC_STATE.put(POLICIES_KEY, JSON.stringify(ids), { expirationTtl: POLICIES_TTL_S });
  return ids;
}

/**
 * Monthly selling limit (quantity) from getPrivileges, or null when the
 * account has no quantity cap (eBay omits the field then).
 */
export async function getSellingLimitQuantity(env: EbayEnv): Promise<number | null> {
  const data = await ebayRequest(env, 'GET', '/sell/account/v1/privilege');
  const q = data?.sellingLimit?.quantity;
  return typeof q === 'number' ? q : null;
}

// ── INVENTORY ───────────────────────────────────────────────────────

/**
 * merchantLocationKey for offers (required to publish). KV override first
 * (meta:ebay_location_key); otherwise the account's first ENABLED location.
 * We never create one: a location is a postal address and belongs to Eduardo.
 */
export async function getMerchantLocationKey(env: EbayEnv): Promise<string> {
  const override = await env.SYNC_STATE.get(LOCATION_OVERRIDE_KEY);
  if (override) return override;
  const data = await ebayRequest(env, 'GET', '/sell/inventory/v1/location?limit=20');
  const loc = (data?.locations || []).find((l: any) => l.merchantLocationStatus !== 'DISABLED');
  if (!loc?.merchantLocationKey) {
    throw new Error('eBay account has no inventory location — create one in Seller Hub (or set meta:ebay_location_key)');
  }
  return loc.merchantLocationKey;
}

const skuPath = (sku: string) => encodeURIComponent(sku);

export async function putInventoryItem(env: EbayEnv, sku: string, item: unknown): Promise<void> {
  await ebayRequest(env, 'PUT', `/sell/inventory/v1/inventory_item/${skuPath(sku)}`, { body: item, contentLanguage: true });
}

export interface EbayOfferSummary {
  offerId: string;
  status?: string;              // UNPUBLISHED | PUBLISHED
  listingId?: string;
  listingStatus?: string;
}

/** The offer for this SKU on EBAY_ES, if any. getOffers answers 404 for none. */
export async function findOffer(env: EbayEnv, sku: string): Promise<EbayOfferSummary | null> {
  let data: any;
  try {
    data = await ebayRequest(env, 'GET',
      `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${EBAY_MARKETPLACE}&format=FIXED_PRICE`);
  } catch (e) {
    if (e instanceof EbayApiError && e.status === 404) return null;
    throw e;
  }
  const o = (data?.offers || [])[0];
  if (!o?.offerId) return null;
  return { offerId: o.offerId, status: o.status, listingId: o.listing?.listingId, listingStatus: o.listing?.listingStatus };
}

export async function createOffer(env: EbayEnv, offer: unknown): Promise<string> {
  const data = await ebayRequest(env, 'POST', '/sell/inventory/v1/offer', { body: offer, contentLanguage: true });
  if (!data?.offerId) throw new Error('eBay createOffer returned no offerId');
  return data.offerId;
}

export async function updateOffer(env: EbayEnv, offerId: string, offer: unknown): Promise<void> {
  await ebayRequest(env, 'PUT', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { body: offer, contentLanguage: true });
}

export async function publishOffer(env: EbayEnv, offerId: string): Promise<string> {
  const data = await ebayRequest(env, 'POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`);
  if (!data?.listingId) throw new Error('eBay publishOffer returned no listingId');
  return data.listingId;
}

/** Ends the live listing; the offer goes back to UNPUBLISHED. */
export async function withdrawOffer(env: EbayEnv, offerId: string): Promise<void> {
  await ebayRequest(env, 'POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`);
}

// ── FULFILLMENT: ORDERS ─────────────────────────────────────────────

export interface EbayOrder {
  orderId: string;
  creationDate?: string;
  orderPaymentStatus?: string;   // PAID, PENDING, FAILED, FULLY_REFUNDED, …
  cancelStatus?: { cancelState?: string };
  buyer?: { username?: string; buyerRegistrationAddress?: any };
  lineItems?: Array<{ lineItemId?: string; sku?: string; legacyItemId?: string; quantity?: number; title?: string; lineItemCost?: { value?: string; currency?: string } }>;
  fulfillmentStartInstructions?: Array<{ shippingStep?: { shipTo?: any } }>;
}

/** Orders created since `sinceIso`, all pages (50 each, capped). */
export async function getOrdersSince(env: EbayEnv, sinceIso: string, maxPages = 10): Promise<EbayOrder[]> {
  const out: EbayOrder[] = [];
  const filter = encodeURIComponent(`creationdate:[${sinceIso}..]`);
  for (let page = 0; page < maxPages; page++) {
    const data = await ebayRequest(env, 'GET', `/sell/fulfillment/v1/order?filter=${filter}&limit=50&offset=${page * 50}`);
    const orders: EbayOrder[] = data?.orders || [];
    out.push(...orders);
    if (orders.length < 50 || out.length >= Number(data?.total ?? 0)) break;
  }
  return out;
}

export async function getEbayOrder(env: EbayEnv, orderId: string): Promise<EbayOrder> {
  return ebayRequest(env, 'GET', `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`);
}

// ── NOTIFICATIONS ───────────────────────────────────────────────────

/**
 * Endpoint validation (Marketplace Account Deletion page and Notification API
 * destinations): hex SHA-256 of challengeCode + verificationToken + endpoint,
 * in that order, returned as {"challengeResponse": "…"}.
 */
export async function challengeResponse(challengeCode: string, verificationToken: string, endpoint: string): Promise<string> {
  const bytes = new TextEncoder().encode(challengeCode + verificationToken + endpoint);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getPublicKey(env: EbayEnv, kid: string): Promise<{ key: string; algorithm?: string; digest?: string }> {
  const cacheKey = `${PUBKEY_PREFIX}${kid}`;
  const raw = await env.SYNC_STATE.get(cacheKey);
  if (raw) return JSON.parse(raw);
  const data = await ebayRequest(env, 'GET', `/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`, { app: true });
  await env.SYNC_STATE.put(cacheKey, JSON.stringify(data), { expirationTtl: PUBKEY_TTL_S });
  return data;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * eBay signs with ECDSA and sends a DER signature (Java/Node default); Web
 * Crypto verifies the raw r‖s form. Each integer is left-padded / stripped to
 * the curve's coordinate size.
 */
export function derToRawSignature(der: Uint8Array, size: number): Uint8Array {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('signature is not DER');
  if (der[i] & 0x80) i += 1 + (der[i] & 0x7f); else i += 1;
  const readInt = () => {
    if (der[i++] !== 0x02) throw new Error('bad DER integer');
    const len = der[i++];
    let v = der.slice(i, i + len);
    i += len;
    while (v.length > size && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(size * 2);
  raw.set(r, 0);
  raw.set(s, size);
  return raw;
}

const CURVES: Array<[string, number]> = [['P-256', 32], ['P-384', 48], ['P-521', 66]];

/**
 * X-EBAY-SIGNATURE = base64(JSON {alg, kid, signature, digest}). The key comes
 * from getPublicKey(kid) as PEM; algorithm ECDSA, digest SHA1 (eBay's Node SDK
 * verifies with 'ssl3-sha1' over JSON.stringify(payload)). We try the raw body
 * first and that re-serialisation second, exactly what the SDK signs.
 */
export async function verifyNotificationSignature(env: EbayEnv, rawBody: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  let sig: { kid?: string; signature?: string };
  try { sig = JSON.parse(new TextDecoder().decode(b64ToBytes(header))); } catch { return false; }
  if (!sig.kid || !sig.signature) return false;

  const pk = await getPublicKey(env, sig.kid);
  const pem = String(pk.key || '').replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '');
  const spki = b64ToBytes(pem);
  const der = b64ToBytes(sig.signature);
  const hash = /256/.test(pk.digest || '') ? 'SHA-256' : 'SHA-1';

  const candidates = [rawBody];
  try { candidates.push(JSON.stringify(JSON.parse(rawBody))); } catch { /* raw only */ }

  for (const [namedCurve, size] of CURVES) {
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve }, false, ['verify']);
    } catch { continue; }   // not this curve
    let raw: Uint8Array;
    try { raw = derToRawSignature(der, size); } catch { return false; }
    for (const msg of candidates) {
      if (await crypto.subtle.verify({ name: 'ECDSA', hash }, key, raw, new TextEncoder().encode(msg))) return true;
    }
    return false;
  }
  return false;
}
