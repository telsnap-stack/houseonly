interface Env {
  R2: R2Bucket;
  WISHLIST: KVNamespace;
  // SYNC_STATE: KV namespace for Discogs↔Shopify sync metadata.
  // Used by Fase 3 handlers (sync, polling, webhook) once shipped.
  // Currently bound but not yet read/written by any code.
  SYNC_STATE: KVNamespace;
  SHOPIFY_ADMIN_CLIENT_ID: string;
  SHOPIFY_ADMIN_CLIENT_SECRET: string;
  // DISCOGS_TOKEN: Personal Access Token for Discogs API.
  // Configured via `wrangler secret put DISCOGS_TOKEN` (separate command for staging).
  // Currently declared but not yet read by any code.
  DISCOGS_TOKEN: string;
}

const R2_PUBLIC         = 'https://pub-7e5c9e2f45b3409383e7f23a2cb7028d.r2.dev';
const SPOTIFY_CLIENT_ID = '9d42a0fa3bb74eada7e6b4659e5fcf0e';
const SPOTIFY_CLIENT_SECRET = '6989af05077e493088e83f59a05bfb5e';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const clean = (s: string) =>
  s.replace(/\(.*?\)/g, '').replace(/feat\.?.*/i, '').trim();

function jsonRes(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── WISHLIST HELPERS ────────────────────────────────────────────
//
// Storage model:
//   key   = `wl:${customerId}` where customerId is the Shopify customer ID
//   value = JSON {items: [{handle, title, artist, label, price, coverUrl, addedAt}]}
//
// We accept both authenticated requests (via Shopify customer access token)
// and "merge" requests where an anonymous local wishlist is being uploaded
// for a newly-logged-in user.
//
// Auth: the client sends `customerAccessToken` in the JSON body. We verify
// it against Shopify Storefront API to get the customer ID. If verification
// fails, we reject the request — no anonymous writes.

const SHOPIFY_DOMAIN = 'house-only-2.myshopify.com';
const STOREFRONT_TOKEN = '3edf470af24f9bd4b81bca274121eec4';

interface WishlistItem {
  handle: string;
  title?: string;
  artist?: string;
  label?: string;
  price?: string;
  coverUrl?: string;
  addedAt: number; // epoch ms
}

interface WishlistData {
  items: WishlistItem[];
  updatedAt: number;
}

async function customerIdFromToken(token: string): Promise<string | null> {
  if (!token) return null;
  try {
    const r = await fetch(`https://${SHOPIFY_DOMAIN}/api/2024-04/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
      },
      body: JSON.stringify({
        query: `query($t:String!){customer(customerAccessToken:$t){id email}}`,
        variables: { t: token },
      }),
    });
    const d: any = await r.json();
    const id = d?.data?.customer?.id;
    if (!id) return null;
    // Normalize gid://shopify/Customer/12345 → "12345"
    return String(id).split('/').pop() || null;
  } catch {
    return null;
  }
}

async function loadWishlist(env: Env, customerId: string): Promise<WishlistData> {
  const raw = await env.WISHLIST.get(`wl:${customerId}`);
  if (!raw) return { items: [], updatedAt: 0 };
  try {
    const parsed = JSON.parse(raw);
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return { items: [], updatedAt: 0 };
  }
}

async function saveWishlist(env: Env, customerId: string, data: WishlistData): Promise<void> {
  data.updatedAt = Date.now();
  await env.WISHLIST.put(`wl:${customerId}`, JSON.stringify(data));
}

function mergeItems(a: WishlistItem[], b: WishlistItem[]): WishlistItem[] {
  const byHandle = new Map<string, WishlistItem>();
  for (const it of a) if (it?.handle) byHandle.set(it.handle, it);
  for (const it of b) {
    if (!it?.handle) continue;
    const existing = byHandle.get(it.handle);
    if (!existing || (it.addedAt || 0) > (existing.addedAt || 0)) {
      byHandle.set(it.handle, it);
    }
  }
  // Sort newest-first
  return Array.from(byHandle.values()).sort(
    (x, y) => (y.addedAt || 0) - (x.addedAt || 0)
  );
}

// ── SHOPIFY ADMIN API (token management + GraphQL helper) ──────────
//
// Uses OAuth 2 client credentials grant. The client_id and client_secret
// are wrangler secrets (see SHOPIFY_ADMIN_CLIENT_ID / SHOPIFY_ADMIN_CLIENT_SECRET).
//
// Token flow:
//   1. POST to /admin/oauth/access_token with grant_type=client_credentials
//   2. Response includes access_token (and possibly expires_in for some tokens;
//      Shopify's docs are inconsistent — we treat the token as valid for 24h
//      from issue and refresh ~1 hour before expiry)
//   3. Cache in KV under key `shopify_admin_token` as JSON {token, expiresAt}
//
// On any 401 from a subsequent Admin API call, we evict the cached token and
// retry once with a fresh token (in case the cache has gone stale early).
//
// We reuse the existing WISHLIST KV namespace for this — adding a separate
// namespace just for one key isn't worth the wrangler config churn.

const TOKEN_KV_KEY = 'shopify_admin_token';
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;  // refresh after 23h to stay clear of any 24h expiry
const TOKEN_REFRESH_THRESHOLD_MS = 60 * 60 * 1000;  // refresh if <1h until expiry

interface CachedToken {
  token: string;
  expiresAt: number;  // epoch ms
}

async function fetchFreshAdminToken(env: Env): Promise<string> {
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
  // Cache it with our own expiry (Shopify doesn't always return expires_in)
  const cached: CachedToken = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
  await env.WISHLIST.put(TOKEN_KV_KEY, JSON.stringify(cached));
  return token;
}

async function getShopifyAdminToken(env: Env, force = false): Promise<string> {
  if (!force) {
    const raw = await env.WISHLIST.get(TOKEN_KV_KEY);
    if (raw) {
      try {
        const cached: CachedToken = JSON.parse(raw);
        const msUntilExpiry = cached.expiresAt - Date.now();
        if (msUntilExpiry > TOKEN_REFRESH_THRESHOLD_MS && cached.token) {
          return cached.token;
        }
      } catch {}
    }
  }
  return await fetchFreshAdminToken(env);
}

async function shopifyAdminGraphQL(env: Env, query: string, variables?: any): Promise<any> {
  // First attempt with cached token
  let token = await getShopifyAdminToken(env);
  let r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2026-04/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  // On 401, refresh token and retry once
  if (r.status === 401) {
    token = await getShopifyAdminToken(env, true);
    r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2026-04/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
  }
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Shopify Admin API ${r.status}: ${text}`);
  }
  const data = await r.json();
  return data;
}

// ── BACKORDER REQUEST HANDLER ─────────────────────────────────────
//
// Customer-facing: when a release is out of stock but recent (year >= currentYear-1),
// the storefront shows a "Request" form instead of "+ Cart". On submit, the
// frontend POSTs here with the variant ID + customer details. We create a
// Shopify draft order with status "open", which Eduardo can then review in
// Shopify admin and either send-invoice or cancel.
//
// Validation:
//   - email format (basic)
//   - required fields: variantId, email, name, address1, city, country, zip
//   - variantId must be a Shopify GID format (gid://shopify/ProductVariant/...)
//
// We tag the draft with `backorder-request` so Eduardo can filter for them
// in admin, and put the customer's note (if any) in the draft order's note
// field.

interface BackorderRequest {
  variantId?: string;
  productHandle?: string;
  productTitle?: string;
  productArtist?: string;
  productPrice?: number;
  email?: string;
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  country?: string;
  zip?: string;
  phone?: string;
  note?: string;
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function splitName(full: string): { firstName: string; lastName: string } {
  const trimmed = (full || '').trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

async function handleBackorderRequest(req: BackorderRequest, env: Env): Promise<Response> {
  // Validate
  if (!req.variantId || !req.variantId.startsWith('gid://shopify/ProductVariant/')) {
    return jsonRes({ error: 'invalid variant id' }, 400);
  }
  if (!req.email || !isValidEmail(req.email)) {
    return jsonRes({ error: 'invalid email' }, 400);
  }
  if (!req.name || !req.address1 || !req.city || !req.country || !req.zip) {
    return jsonRes({ error: 'missing required fields' }, 400);
  }

  const { firstName, lastName } = splitName(req.name);

  // Build the note to attach to the draft order — visible in Shopify admin
  const noteParts: string[] = ['BACKORDER REQUEST'];
  if (req.productHandle) noteParts.push(`Product: ${req.productHandle}`);
  if (req.productTitle)  noteParts.push(`Title: ${req.productTitle}`);
  if (req.productArtist) noteParts.push(`Artist: ${req.productArtist}`);
  if (req.note)          noteParts.push(`\nCustomer note: ${req.note}`);
  const noteText = noteParts.join('\n');

  const mutation = `
    mutation backorderDraftCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          name
          invoiceUrl
        }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    input: {
      email: req.email,
      note: noteText,
      tags: ['backorder-request'],
      lineItems: [
        {
          variantId: req.variantId,
          quantity: 1,
        },
      ],
      shippingAddress: {
        firstName,
        lastName,
        address1: req.address1,
        address2: req.address2 || '',
        city: req.city,
        province: req.province || '',
        country: req.country,
        zip: req.zip,
        phone: req.phone || '',
      },
    },
  };

  try {
    const result = await shopifyAdminGraphQL(env, mutation, variables);
    const userErrors = result?.data?.draftOrderCreate?.userErrors || [];
    if (userErrors.length > 0) {
      return jsonRes({
        error: 'shopify rejected request',
        details: userErrors,
      }, 400);
    }
    const draftOrder = result?.data?.draftOrderCreate?.draftOrder;
    if (!draftOrder?.id) {
      return jsonRes({ error: 'unknown shopify response', raw: result }, 500);
    }
    return jsonRes({
      success: true,
      draftOrderId: draftOrder.id,
      draftOrderName: draftOrder.name,
    });
  } catch (e: any) {
    return jsonRes({ error: 'shopify call failed', message: e.message }, 502);
  }
}

// ── MIRROR HANDLER ─────────────────────────────────────────────
//
// Server-side proxy that fetches an external image URL (typically from
// mothertonguerecords.com or another distributor's WordPress) and stores
// the bytes in R2 under a caller-supplied key. The browser cannot do this
// directly because the source server doesn't return CORS headers — but
// fetch() running inside a Worker is cross-origin only at the Cloudflare
// edge, where CORS is not applied.
//
// Why a separate endpoint instead of reusing /upload:
//   - /upload expects a multipart formData with the file bytes already in
//     hand. Mirror needs to fetch them itself, server-side.
//   - This keeps the importer thin: one POST with `url` and `key`, no
//     intermediate blob shuffling in the browser.
//
// Hardening:
//   - Only http(s) URLs accepted; no file://, no relative paths.
//   - Allowlist: only images from public domains we control or trust (the
//     distributors). Prevents this becoming an open proxy.
//   - Hard-cap on response size (10 MB) to keep memory bounded.
//   - Hard-cap on fetch time (15 s) to keep the request from hanging.
//   - Content-Type sniffed from the response and forced to image/* — refuse
//     anything else. Prevents accidentally storing HTML error pages as
//     "covers".
//
// Request:  POST ?action=mirror   body: { url: string, key: string }
// Response: 200 { url: string }   (the public R2 URL)
//           4xx { error: string } on validation
//           5xx { error: string, ... } on upstream/network failure

const MIRROR_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MIRROR_TIMEOUT_MS = 15_000;
const MIRROR_ALLOWED_HOSTS = new Set([
  'www.mothertonguerecords.com',
  'mothertonguerecords.com',
  'objectstore.true.nl',  // Rush Hour cover images (CDN behind their distribution site)
  // Add other distributor hosts here when needed:
  // 'kompakt.fm', 'www.kompakt.fm', etc.
]);

async function handleMirror(req: { url?: string; key?: string }, env: Env): Promise<Response> {
  // 1. Validate inputs
  if (!req.url || typeof req.url !== 'string') {
    return jsonRes({ error: 'missing url' }, 400);
  }
  if (!req.key || typeof req.key !== 'string') {
    return jsonRes({ error: 'missing key' }, 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(req.url);
  } catch {
    return jsonRes({ error: 'invalid url' }, 400);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return jsonRes({ error: 'only http(s) urls allowed' }, 400);
  }
  if (!MIRROR_ALLOWED_HOSTS.has(parsed.hostname)) {
    return jsonRes({ error: `host not allowed: ${parsed.hostname}` }, 400);
  }
  // Reject keys that would escape the bucket prefix or look suspicious.
  if (req.key.includes('..') || req.key.startsWith('/')) {
    return jsonRes({ error: 'invalid key' }, 400);
  }

  // 2. Fetch with timeout
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MIRROR_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(req.url, {
      signal: ctrl.signal,
      // Some WordPress installs serve different bytes to bots vs browsers.
      // Pretend to be a normal browser request to maximize compat.
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HouseOnlyMirror/1.0)',
        'Accept': 'image/*',
      },
    });
  } catch (e: any) {
    clearTimeout(timer);
    return jsonRes({ error: 'fetch failed', message: e?.message || String(e) }, 502);
  }
  clearTimeout(timer);
  if (!upstream.ok) {
    return jsonRes({ error: `upstream ${upstream.status}` }, 502);
  }

  // 3. Sanity-check Content-Type. We refuse anything that isn't an image —
  //    a successful 200 with text/html is almost always a "soft 404" landing
  //    page, and we don't want that mirrored as a cover.
  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/')) {
    return jsonRes({
      error: 'upstream did not return an image',
      contentType,
    }, 502);
  }

  // 4. Read body with hard cap on size
  const buf = await upstream.arrayBuffer();
  if (buf.byteLength === 0) {
    return jsonRes({ error: 'empty body' }, 502);
  }
  if (buf.byteLength > MIRROR_MAX_BYTES) {
    return jsonRes({ error: 'too large', bytes: buf.byteLength }, 413);
  }

  // 5. Put in R2 and return public URL
  try {
    await env.R2.put(req.key, buf, {
      httpMetadata: { contentType },
    });
  } catch (e: any) {
    return jsonRes({ error: 'r2 put failed', message: e?.message || String(e) }, 500);
  }
  return jsonRes({ url: `${R2_PUBLIC}/${req.key}`, bytes: buf.byteLength });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    // ── BACKORDER REQUEST ──────────────────────────────────
    // POST ?action=backorder-request body:{variantId, email, name, address1, ...}
    //
    // Creates a Shopify draft order (no payment captured) for an out-of-stock
    // release. Eduardo confirms availability with the distributor in admin,
    // then sends an invoice from the draft order — customer pays online via
    // Shopify checkout, draft converts to a real order.
    if (action === 'backorder-request' && request.method === 'POST') {
      let body: BackorderRequest = {};
      try {
        body = await request.json();
      } catch {
        return jsonRes({ error: 'invalid json' }, 400);
      }
      return await handleBackorderRequest(body, env);
    }

    // ── MIRROR (server-side fetch + R2 store) ─────────────
    // POST ?action=mirror body:{url, key}
    //
    // Used by the Mother Tongue importer to bypass CORS when downloading
    // cover images from mothertonguerecords.com — the browser can't fetch
    // those URLs (no CORS headers), but the Worker can.
    if (action === 'mirror' && request.method === 'POST') {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return jsonRes({ error: 'invalid json' }, 400);
      }
      return await handleMirror(body, env);
    }

    // ── WISHLIST ENDPOINTS ──────────────────────────────────
    // GET    ?action=wishlist&token=...                  → fetch user's wishlist
    // POST   ?action=wishlist  body:{token,item}         → add item
    // DELETE ?action=wishlist  body:{token,handle}       → remove item
    // POST   ?action=wishlist-merge body:{token,items}   → merge anon list on login

    if (action === 'wishlist' || action === 'wishlist-merge') {
      // GET: return wishlist
      if (request.method === 'GET') {
        const token = url.searchParams.get('token') || '';
        const cid = await customerIdFromToken(token);
        if (!cid) return jsonRes({ error: 'auth' }, 401);
        const data = await loadWishlist(env, cid);
        return jsonRes(data);
      }

      // POST/DELETE: parse body
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return jsonRes({ error: 'invalid json' }, 400);
      }
      const cid = await customerIdFromToken(body.token || '');
      if (!cid) return jsonRes({ error: 'auth' }, 401);

      // POST: add or merge
      if (request.method === 'POST') {
        const data = await loadWishlist(env, cid);
        if (action === 'wishlist-merge') {
          // Merge anonymous local list into the account
          const incoming: WishlistItem[] = Array.isArray(body.items) ? body.items : [];
          data.items = mergeItems(data.items, incoming);
        } else {
          // Single-item add
          const item = body.item as WishlistItem | undefined;
          if (!item || !item.handle) return jsonRes({ error: 'missing item' }, 400);
          if (!item.addedAt) item.addedAt = Date.now();
          data.items = mergeItems(data.items, [item]);
        }
        // Cap at 500 items so a runaway client can't blow up the KV value
        if (data.items.length > 500) data.items = data.items.slice(0, 500);
        await saveWishlist(env, cid, data);
        return jsonRes(data);
      }

      // DELETE: remove single handle
      if (request.method === 'DELETE') {
        const handle = String(body.handle || '');
        if (!handle) return jsonRes({ error: 'missing handle' }, 400);
        const data = await loadWishlist(env, cid);
        data.items = data.items.filter(it => it.handle !== handle);
        await saveWishlist(env, cid, data);
        return jsonRes(data);
      }

      return jsonRes({ error: 'method not allowed' }, 405);
    }

    // ── POST: upload file to R2 ──────────────────────────────
    if (request.method === 'POST') {
      if (action === 'upload') {
        try {
          const fd   = await request.formData();
          const file = fd.get('file') as File;
          const key  = fd.get('key')  as string;
          if (!file || !key) return jsonRes({ error: 'Missing file or key' }, 400);
          await env.R2.put(key, await file.arrayBuffer(), {
            httpMetadata: { contentType: file.type || 'application/octet-stream' },
          });
          return jsonRes({ url: `${R2_PUBLIC}/${key}` });
        } catch (e: any) {
          return jsonRes({ error: e.message }, 500);
        }
      }
      return jsonRes({ error: 'Unknown action' }, 400);
    }

    // ── GET: cover art lookup ────────────────────────────────
    const ean    = url.searchParams.get('ean')    || '';
    const title  = url.searchParams.get('title')  || '';
    const artist = url.searchParams.get('artist') || '';
    const label  = url.searchParams.get('label')  || '';
    const year   = url.searchParams.get('year')   || '';

    // 1. Deezer by EAN/UPC
    if (ean) {
      try {
        const r = await fetch(`https://api.deezer.com/album/upc/${ean}`);
        const d = await r.json() as any;
        if (d?.cover_xl && !d.cover_xl.includes('default')) return jsonRes({ imageUrl: d.cover_xl });
        if (d?.cover_big && !d.cover_big.includes('default')) return jsonRes({ imageUrl: d.cover_big });
      } catch {}
    }

    // 2. Spotify by title + artist + label + year
    try {
      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + btoa(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`),
        },
        body: 'grant_type=client_credentials',
      });
      const tokenData = await tokenRes.json() as any;
      const token = tokenData.access_token;
      if (token) {
        let q = `${clean(title)} ${clean(artist)}`;
        if (label) q += ` ${clean(label)}`;
        if (year)  q += ` year:${year}`;
        const searchRes = await fetch(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=album&limit=5`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const searchData = await searchRes.json() as any;
        const items = searchData?.albums?.items || [];
        const scored = items.map((item: any) => {
          let score = 0;
          if (item.name?.toLowerCase().includes(clean(title).toLowerCase())) score += 3;
          if (year && item.release_date?.slice(0, 4) === String(year)) score += 2;
          if (item.artists?.[0]?.name?.toLowerCase().includes(clean(artist).toLowerCase())) score += 1;
          return { item, score };
        });
        scored.sort((a: any, b: any) => b.score - a.score);
        const img = scored[0]?.item?.images?.[0]?.url;
        if (img) return jsonRes({ imageUrl: img });
      }
    } catch {}

    // 3. Deezer search
    try {
      const q = encodeURIComponent(`${clean(title)} ${clean(artist)}${label ? ' ' + clean(label) : ''}`);
      const r = await fetch(`https://api.deezer.com/search/album?q=${q}&limit=3`);
      const d = await r.json() as any;
      const items = d?.data || [];
      const match = items.find((i: any) =>
        i.title?.toLowerCase().includes(clean(title).toLowerCase())
      ) || items[0];
      const img = match?.cover_xl || match?.cover_big;
      if (img && !img.includes('default')) return jsonRes({ imageUrl: img });
    } catch {}

    // 4. iTunes
    try {
      const q = encodeURIComponent(`${clean(title)} ${clean(artist)}`);
      const r = await fetch(`https://itunes.apple.com/search?term=${q}&entity=album&limit=5&media=music`);
      const d = await r.json() as any;
      const results = (d.results || []).filter((i: any) => i.artworkUrl100);
      const scored = results.map((i: any) => {
        let score = 0;
        if ((i.collectionName || '').toLowerCase().includes(clean(title).toLowerCase())) score += 3;
        if ((i.artistName   || '').toLowerCase().includes(clean(artist).toLowerCase())) score += 2;
        return { i, score };
      });
      scored.sort((a: any, b: any) => b.score - a.score);
      const best = scored[0]?.i;
      if (best?.artworkUrl100) {
        return jsonRes({ imageUrl: best.artworkUrl100.replace('100x100bb', '600x600bb') });
      }
    } catch {}

    return jsonRes({ imageUrl: '' });
  },
};
