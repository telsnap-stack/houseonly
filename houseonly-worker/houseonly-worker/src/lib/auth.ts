// ── CUSTOMER ACCOUNT API (CAAPI) AUTH — Confidential client ───────────────
//
// Shopify migrated to New Customer Accounts (NCA). The legacy Storefront
// mutations (customerAccessTokenCreate, customerCreate, customerRecover, …)
// are incompatible with NCA. This module implements the OAuth 2.0 authorization
// code flow against the Customer Account API as a CONFIDENTIAL client, with the
// whole token exchange happening server-side in the Worker.
//
// WHY CONFIDENTIAL (not public/PKCE):
//   - The Worker is a real backend, so the refresh token never touches the
//     browser — it lives in KV. The browser only ever holds an opaque session
//     id that is useless outside this Worker.
//   - Server-to-server token exchange sidesteps the documented CORS failure
//     that public (browser) clients hit on the /token endpoint.
//   - This is the foundation for the "account hub" (followed artists, charts,
//     alerts, order history): every future per-customer feature resolves
//     identity the same way the wishlist does — via the session → customerId.
//
// SESSION MODEL (opaque token, NOT a cookie):
//   - On successful login the Worker mints a random opaque session id and
//     stores {customerId, accessToken, refreshToken, idToken, expiresAt} in KV
//     under `sess:{sessionId}`.
//   - The frontend keeps the opaque session id in localStorage and sends it to
//     the Worker exactly like it used to send the Storefront token. This keeps
//     the wishlist flow nearly unchanged and avoids cross-domain cookie pain
//     (Worker is on workers.dev, the site on houseonly.store).
//
// THE GOLDEN-RULE GUARANTEE (wishlist must never break):
//   - The wishlist is keyed by `wl:{customerId}` where customerId is the
//     NUMERIC Shopify customer id (gid://shopify/Customer/12345 → "12345").
//   - We resolve that SAME numeric id from CAAPI (via a `customer { id }` query)
//     and normalize it identically to the legacy customerIdFromToken(). So the
//     existing wishlist data stays valid with ZERO migration — only HOW we learn
//     the id changes, not the id itself.
//
// CRITICAL CONFIDENTIAL-CLIENT DETAILS (confirmed against the official docs,
// not assumed — getting any of these wrong breaks the flow silently):
//   - Token endpoint requires `Authorization: Basic base64(client_id:secret)`.
//   - Confidential clients DO NOT use PKCE (no code_verifier / code_challenge).
//   - A `user-agent` header is REQUIRED or the token endpoint returns 403
//     ("You do not have permission to access this website").
//   - Scope must be `openid email customer-account-api:full`.
//   - Discovery (.well-known/openid-configuration) returns the real endpoints
//     on the shop's configured customer-accounts domain, which for this store
//     is the vanity domain account.houseonly.store — so we DISCOVER rather than
//     hardcode, and only fall back to known URLs if discovery fails.

const SHOP_STOREFRONT_DOMAIN = 'houseonly.store';

// Known-good fallbacks (observed in the Shopify Headless → Customer Account API
// settings). Used only if discovery fails for some reason. Discovery is the
// source of truth.
const FALLBACK_ENDPOINTS = {
  authorization_endpoint: 'https://account.houseonly.store/authentication/oauth/authorize',
  token_endpoint: 'https://account.houseonly.store/authentication/oauth/token',
  end_session_endpoint: 'https://account.houseonly.store/authentication/logout',
};

const OAUTH_SCOPE = 'openid email customer-account-api:full';
const USER_AGENT = 'houseonly-worker/1.0 (+https://houseonly.store)';

// KV key prefixes (live in WISHLIST KV, shared across prod+staging, like wl:).
const SESSION_PREFIX = 'sess:';     // sess:{sessionId} → SessionData
const STATE_PREFIX = 'authstate:';  // authstate:{state} → return-to URL (CSRF + redirect memory)
const DISCOVERY_KEY = 'meta:caapi_discovery';   // cached discovery doc

// TTLs
const SESSION_TTL_S = 30 * 24 * 60 * 60;   // 30 days — the session itself; access token refreshed within
const STATE_TTL_S = 10 * 60;               // 10 min — a login attempt must complete within this window
const DISCOVERY_TTL_S = 24 * 60 * 60;      // cache discovery for a day
// Refresh the access token this many seconds BEFORE it actually expires, so an
// in-flight request never races the expiry boundary.
const REFRESH_SKEW_S = 120;

// auth.ts needs CAAPI creds + a KV namespace for sessions/state. We reuse
// WISHLIST KV (shared cross-env) so sessions and wishlist live together — they
// are both "this customer's data" and key prefixes keep them cleanly separated.
export interface AuthEnv {
  WISHLIST: KVNamespace;
  CAAPI_CLIENT_ID: string;
  CAAPI_CLIENT_SECRET: string;
}

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in: number;   // seconds
}

export interface SessionData {
  customerId: string;        // NUMERIC Shopify id, same as wishlist wl:{customerId}
  accessToken: string;       // CAAPI access token
  refreshToken: string;      // CAAPI refresh token (NEVER leaves the Worker)
  idToken?: string;          // needed as id_token_hint on logout
  expiresAt: number;         // epoch ms when accessToken expires
  createdAt: number;         // epoch ms
}

// ── DISCOVERY ─────────────────────────────────────────────────────────────
//
// Fetch (and cache) the OpenID configuration from the storefront domain. The
// returned endpoints point at the customer-accounts vanity domain. Falls back
// to the known endpoints if the network call fails so login still works.
export async function discoverEndpoints(env: AuthEnv): Promise<DiscoveryDoc> {
  try {
    const cached = await env.WISHLIST.get(DISCOVERY_KEY);
    if (cached) {
      const d = JSON.parse(cached);
      if (d?.authorization_endpoint && d?.token_endpoint && d?.end_session_endpoint) {
        return d as DiscoveryDoc;
      }
    }
  } catch { /* cache miss/parse error → fetch fresh */ }

  try {
    const res = await fetch(
      `https://${SHOP_STOREFRONT_DOMAIN}/.well-known/openid-configuration`,
      { headers: { 'user-agent': USER_AGENT } },
    );
    if (res.ok) {
      const cfg: any = await res.json();
      const doc: DiscoveryDoc = {
        authorization_endpoint: cfg.authorization_endpoint || FALLBACK_ENDPOINTS.authorization_endpoint,
        token_endpoint: cfg.token_endpoint || FALLBACK_ENDPOINTS.token_endpoint,
        end_session_endpoint: cfg.end_session_endpoint || FALLBACK_ENDPOINTS.end_session_endpoint,
      };
      try {
        await env.WISHLIST.put(DISCOVERY_KEY, JSON.stringify(doc), { expirationTtl: DISCOVERY_TTL_S });
      } catch { /* cache write best-effort */ }
      return doc;
    }
  } catch { /* fall through to fallback */ }

  return { ...FALLBACK_ENDPOINTS };
}

// ── STATE (CSRF) ──────────────────────────────────────────────────────────
//
// Random state stored in KV alongside the URL we should return the user to
// after login. On callback we require the state to exist (and we delete it,
// single-use). This both prevents CSRF and lets us redirect back to wherever
// the user started (e.g. a product page).
function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  // base64url, no padding
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function createState(env: AuthEnv, returnTo: string): Promise<string> {
  const state = randomToken(24);
  await env.WISHLIST.put(`${STATE_PREFIX}${state}`, returnTo || '/', { expirationTtl: STATE_TTL_S });
  return state;
}

export async function consumeAuthState(env: AuthEnv, state: string): Promise<string | null> {
  if (!state) return null;
  const returnTo = await env.WISHLIST.get(`${STATE_PREFIX}${state}`);
  if (returnTo === null) return null;        // unknown/expired state → reject
  try { await env.WISHLIST.delete(`${STATE_PREFIX}${state}`); } catch { /* single-use best-effort */ }
  return returnTo || '/';
}

// ── AUTHORIZE URL ─────────────────────────────────────────────────────────
//
// Build the URL we redirect the browser to. `redirectUri` must EXACTLY match
// one of the Callback URIs registered in the Customer Account API settings
// (the Worker's /auth/callback for this environment).
export async function buildAuthorizeUrl(
  env: AuthEnv,
  redirectUri: string,
  returnTo: string,
  loginHint?: string,
): Promise<string> {
  const { authorization_endpoint } = await discoverEndpoints(env);
  const state = await createState(env, returnTo);
  const u = new URL(authorization_endpoint);
  u.searchParams.set('scope', OAUTH_SCOPE);
  u.searchParams.set('client_id', env.CAAPI_CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

// ── TOKEN EXCHANGE (confidential, server-to-server) ───────────────────────
function basicAuthHeader(env: AuthEnv): string {
  return 'Basic ' + btoa(`${env.CAAPI_CLIENT_ID}:${env.CAAPI_CLIENT_SECRET}`);
}

export async function exchangeCodeForTokens(
  env: AuthEnv,
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const { token_endpoint } = await discoverEndpoints(env);
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', env.CAAPI_CLIENT_ID);
  body.set('redirect_uri', redirectUri);
  body.set('code', code);

  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'authorization': basicAuthHeader(env),
      'user-agent': USER_AGENT,   // REQUIRED — without it Shopify returns 403
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`token exchange failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return await res.json() as TokenResponse;
}

export async function refreshAccessToken(
  env: AuthEnv,
  refreshToken: string,
): Promise<TokenResponse> {
  const { token_endpoint } = await discoverEndpoints(env);
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', env.CAAPI_CLIENT_ID);
  body.set('refresh_token', refreshToken);

  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'authorization': basicAuthHeader(env),
      'user-agent': USER_AGENT,
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`token refresh failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return await res.json() as TokenResponse;
}

// ── RESOLVE CUSTOMER ID FROM CAAPI ────────────────────────────────────────
//
// This is the bridge that protects the wishlist. We query the Customer Account
// API for `customer { id }`, which returns gid://shopify/Customer/12345, and
// normalize to "12345" — IDENTICAL to the legacy customerIdFromToken(), so the
// existing wl:{customerId} data maps to the same person.
//
// We discover the GraphQL endpoint dynamically (it already includes the API
// version). Falls back to the versioned vanity URL if discovery fails.
async function caapiGraphqlEndpoint(): Promise<string> {
  try {
    const res = await fetch(
      `https://${SHOP_STOREFRONT_DOMAIN}/.well-known/customer-account-api`,
      { headers: { 'user-agent': USER_AGENT } },
    );
    if (res.ok) {
      const cfg: any = await res.json();
      if (cfg?.graphql_api) return cfg.graphql_api as string;
    }
  } catch { /* fall through */ }
  return 'https://account.houseonly.store/customer/api/2026-04/graphql';
}

// Run an authenticated Customer Account API GraphQL query with a raw access
// token. Returns the parsed JSON (or null on transport failure). Callers read
// data/errors themselves. CAAPI uses the raw access token in the Authorization
// header (no "Bearer" prefix) and requires a user-agent.
export async function caapiQuery(
  accessToken: string,
  query: string,
  variables?: Record<string, any>,
): Promise<any | null> {
  if (!accessToken) return null;
  try {
    const endpoint = await caapiGraphqlEndpoint();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': accessToken,
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

export async function customerIdFromAccessToken(
  accessToken: string,
): Promise<string | null> {
  const d = await caapiQuery(accessToken, 'query { customer { id } }');
  const id = d?.data?.customer?.id;
  if (!id) return null;
  // Normalize gid://shopify/Customer/12345 → "12345" (same as legacy path).
  return String(id).split('/').pop() || null;
}

// ── SESSION MANAGEMENT ────────────────────────────────────────────────────
export async function createSession(
  env: AuthEnv,
  data: Omit<SessionData, 'createdAt'>,
): Promise<string> {
  const sessionId = randomToken(32);
  const full: SessionData = { ...data, createdAt: Date.now() };
  await env.WISHLIST.put(`${SESSION_PREFIX}${sessionId}`, JSON.stringify(full), {
    expirationTtl: SESSION_TTL_S,
  });
  return sessionId;
}

async function readSession(env: AuthEnv, sessionId: string): Promise<SessionData | null> {
  if (!sessionId) return null;
  const raw = await env.WISHLIST.get(`${SESSION_PREFIX}${sessionId}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as SessionData; } catch { return null; }
}

async function writeSession(env: AuthEnv, sessionId: string, data: SessionData): Promise<void> {
  await env.WISHLIST.put(`${SESSION_PREFIX}${sessionId}`, JSON.stringify(data), {
    expirationTtl: SESSION_TTL_S,
  });
}

export async function deleteSession(env: AuthEnv, sessionId: string): Promise<SessionData | null> {
  const data = await readSession(env, sessionId);
  if (sessionId) {
    try { await env.WISHLIST.delete(`${SESSION_PREFIX}${sessionId}`); } catch { /* best-effort */ }
  }
  return data;
}

// ── THE KEY HELPER: resolve a customerId from an opaque session id ─────────
//
// This is the function the wishlist (and every future account-hub feature)
// will call instead of the legacy customerIdFromToken(). It:
//   1. Loads the session from KV.
//   2. If the CAAPI access token is near expiry, refreshes it transparently
//      (rotating the stored refresh token) and persists the new tokens.
//   3. Returns the stable NUMERIC customerId.
// Returns null for any failure → caller responds 401, exactly like today.
export async function customerIdFromSession(
  env: AuthEnv,
  sessionId: string,
): Promise<string | null> {
  const sess = await getValidSession(env, sessionId);
  return sess ? sess.customerId : null;
}

// Load a session and ensure its access token is fresh, refreshing transparently
// (and rotating the stored refresh token) when at/near expiry. Returns the
// up-to-date session, or null if missing or if refresh failed (→ logged out).
// This is the single place token-lifetime is managed; both customerIdFromSession
// and caapiQueryBySession build on it.
async function getValidSession(env: AuthEnv, sessionId: string): Promise<SessionData | null> {
  const sess = await readSession(env, sessionId);
  if (!sess) return null;

  // Proactively refresh if the access token is at/near expiry. The session
  // (and thus wishlist/account access) survives as long as the refresh token is
  // valid, well beyond a single access-token lifetime.
  if (Date.now() >= sess.expiresAt - REFRESH_SKEW_S * 1000) {
    try {
      const t = await refreshAccessToken(env, sess.refreshToken);
      sess.accessToken = t.access_token;
      // Shopify rotates refresh tokens; keep the newest. Fall back to the old
      // one if the response omitted it (some IdPs do on refresh).
      if (t.refresh_token) sess.refreshToken = t.refresh_token;
      if (t.id_token) sess.idToken = t.id_token;
      sess.expiresAt = Date.now() + (t.expires_in || 3600) * 1000;
      await writeSession(env, sessionId, sess);
    } catch {
      // Refresh failed (revoked / expired refresh token). Treat as logged out.
      return null;
    }
  }
  return sess;
}

// Run a CAAPI GraphQL query on behalf of a logged-in session: resolves the
// session (refreshing the access token if needed) and executes the query with
// that token. Returns the parsed JSON, or null if the session is invalid.
// Used by the account profile/orders endpoints.
export async function caapiQueryBySession(
  env: AuthEnv,
  sessionId: string,
  query: string,
  variables?: Record<string, any>,
): Promise<any | null> {
  const sess = await getValidSession(env, sessionId);
  if (!sess) return null;
  return caapiQuery(sess.accessToken, query, variables);
}

// ── LOGOUT URL ────────────────────────────────────────────────────────────
//
// Build the end-session URL. id_token_hint is required by the spec;
// post_logout_redirect_uri must be one of the registered Logout URIs.
export async function buildLogoutUrl(
  env: AuthEnv,
  idToken: string | undefined,
  postLogoutRedirectUri: string,
): Promise<string> {
  const { end_session_endpoint } = await discoverEndpoints(env);
  const u = new URL(end_session_endpoint);
  if (idToken) u.searchParams.set('id_token_hint', idToken);
  u.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  return u.toString();
}
