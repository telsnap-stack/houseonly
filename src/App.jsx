import { useState, useRef, useEffect, useMemo, createContext, useContext, useCallback } from "react";

const S = {
  bg:'#080808', surf:'#111', border:'#1e1e1e',
  text:'#efefef', muted:'#585858', accent:'#c8ff00', danger:'#ff4040',
};

// ── SHOPIFY ────────────────────────────────────────────────────
const SHOPIFY = {
  domain: 'house-only-2.myshopify.com',
  token:  import.meta.env.VITE_SHOPIFY_TOKEN || '3edf470af24f9bd4b81bca274121eec4',
  api:    '2024-01',
};

async function shopifyQuery(query, variables={}) {
  const resp = await fetch(
    `https://${SHOPIFY.domain}/api/${SHOPIFY.api}/graphql.json`,
    { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Shopify-Storefront-Access-Token':SHOPIFY.token }, body:JSON.stringify({ query, variables }) }
  );
  const data = await resp.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

const GENRE_TAGS = ['Detroit House','Chicago House','Afro House','Soulful House','Acid House','Disco House','Tech House','Deep House','House','Electronic','Nu-Disco','Funk','Soul','Jazz','Electronica','Ambient','Techno','Drum & Bass','Breakbeat','Reggae','Dub','Hip Hop','R&B'];
const SKIP_TAGS  = ['vinyl','house','kudos',...GENRE_TAGS.map(g=>g.toLowerCase())];

// ── SLUG (industry-standard SEO-friendly URLs: artist-title) ───
function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}
function makeSlug(artist, title, catalog) {
  const base = [artist, title].filter(Boolean).join(' ');
  const s = slugify(base);
  if (s) return s;
  return slugify(catalog) || 'release';
}

// Extract genre/year/label from a product's Shopify tags. Used by both the
// full product parser (for cards) and the lite metadata parser (for filter
// pills). Keeping the logic in one place ensures filters and cards always
// agree on what genre/year/label a product belongs to.
function extractTagMeta(tags) {
  tags = tags || [];
  // A tag is "structural" (never a genre or a free-text label) if it's a
  // key:value tag (source:, label:, release:, …), a bare flag (forthcoming),
  // a 4-digit year, a SKIP_TAGS entry, or a format/marker token. Genre comes
  // from the GENRE_TAGS whitelist first; the free-text fallback only considers
  // NON-structural tags, so technical tags (source:ws, forthcoming, release:…)
  // can never leak into the Genre or Label fields. If nothing qualifies the
  // field is left blank rather than showing a junk tag.
  const isStructural = (t) =>
    /:/.test(t) ||                                    // any key:value tag (source:, label:, release:, …)
    /^\d{4}$/.test(t) ||                              // year
    /^forthcoming$/i.test(t) ||                       // pre-order flag
    SKIP_TAGS.some(s => s.toLowerCase() === t.toLowerCase()) ||
    /^(12|excl|lp|ep|single|vinyl|kudos)/i.test(t);   // format / marker tokens
  const genre = GENRE_TAGS.find(g => tags.some(t => t.toLowerCase() === g.toLowerCase()))
    || tags.find(t => !isStructural(t))
    || '';
  const year = parseInt(tags.find(t => /^\d{4}$/.test(t)) || '0');
  const label = tags.find(t => t.toLowerCase().startsWith('label:'))?.slice(6).trim()
    || tags.find(t => !isStructural(t)) || '';
  return { genre, year, label };
}

function parseProduct({ node }) {
  const v    = node.variants.edges[0]?.node;
  const img  = node.images.edges[0]?.node;
  const tags = node.tags || [];
  const { genre, year, label } = extractTagMeta(tags);
  const bodyHtml = node.descriptionHtml || '';
  const cleanHtml = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, '');
  const desc  = cleanHtml.replace(/<[^>]+>/g,'').trim() || '';
  // Vendor holds the artist. Blank-artist imports get Shopify's default (the
  // shop name "House Only") — that exact value is the bug and must never show
  // as an artist. Treat it as no-artist (blank) so it can be corrected in
  // Shopify; never display the store name.
  const vendorIsStoreDefault = (node.vendor || '').trim() === 'House Only';
  const artist = vendorIsStoreDefault
    ? (desc.includes(' — ') ? desc.split(' — ')[0].trim() : '')
    : (node.vendor || (desc.includes(' — ') ? desc.split(' — ')[0].trim() : ''));
  let tracks = [];
  const tracksMatch = bodyHtml.match(/<script[^>]+id="tracks"[^>]*>([\s\S]*?)<\/script>/);
  if (tracksMatch) { try { tracks = JSON.parse(tracksMatch[1]); } catch {} }
  const catalog = v?.sku||'';
  const title = node.title||'';
  // Forthcoming/pre-order support: the `forthcoming` tag marks a release that
  // hasn't arrived yet (listed from a distributor's pre-sale feed). A
  // `release:YYYY-MM-DD` tag carries the expected street date. Both are read
  // off the raw tags, which we now expose on the record so isForthcoming() and
  // the pre-order UI can use them without re-fetching.
  const releaseTag = tags.find(t => /^release:/i.test(t));
  const releaseDate = releaseTag ? releaseTag.slice(releaseTag.indexOf(':') + 1).trim() : '';
  return {
    id: node.id, shopifyVariantId: v?.id,
    title, artist, label,
    catalog, genre, year,
    slug: makeSlug(artist, title, catalog),
    month: new Date().getMonth()+1,
    price: parseFloat(v?.price?.amount||18.99),
    stock: v?.quantityAvailable??10,
    coverUrl: img?.url||null, tracks, desc, g:'135deg,#1a1a2e,#16213e',
    tags, releaseDate,
  };
}

// Tags that mark a release as Drum & Bass (incl. jungle / liquid). The TV
// importer always writes 'dnb' on D&B records; the others catch any variant
// spelling. This set both POPULATES the "Drum & Bass Only" section and is
// EXCLUDED from the main house catalogue so the two never mix.
const DNB_TAGS = ['dnb', 'jungle', 'Jungle', 'Drum n Bass', 'Drum and Bass', 'Liquid Funk'];

async function fetchShopifyProducts({ cursor=null, sortKey='CREATED_AT', reverse=true, filterTags=[], forthcoming=false, dnb=false } = {}) {
  const after = cursor ? `, after: "${cursor}"` : '';
  // Build a tag-AND query string for server-side filtering. Each filterTag is a
  // raw tag value like "label:Word and Sound" or "year:2025".
  //
  // Forthcoming handling (mutually exclusive, drives the Forthcoming section vs
  // the main catalogue):
  //   - forthcoming=true  → REQUIRE the `forthcoming` tag  → only pre-orders
  //   - forthcoming=false → EXCLUDE it via `-tag:'forthcoming'` so pre-orders
  //     never leak into the main catalogue.
  // Negation ("-tag:...") is supported by Shopify's search query grammar
  // (verified against docs: a "-" modifier excludes documents with that value).
  //
  // Drum & Bass handling (separate "Drum & Bass Only" section):
  //   - dnb=true  → REQUIRE any D&B tag  → only the D&B catalogue
  //   - dnb=false → EXCLUDE all D&B tags so they never appear among the house
  //     genres on the main page. (Forthcoming is exempt — pre-orders can be D&B.)
  const clauses = filterTags.map(t => `tag:'${t}'`);
  clauses.push(forthcoming ? `tag:'forthcoming'` : `-tag:'forthcoming'`);
  if (dnb) {
    clauses.push(`(${DNB_TAGS.map(t => `tag:'${t}'`).join(' OR ')})`);
  } else if (!forthcoming) {
    // Main catalogue: hide every D&B record from the house genres.
    for (const t of DNB_TAGS) clauses.push(`-tag:'${t}'`);
  }
  const queryArg = `, query: ${JSON.stringify(clauses.join(' AND '))}`;
  const sortArg = `, sortKey: ${sortKey}, reverse: ${reverse ? 'true' : 'false'}`;
  const data = await shopifyQuery(`{
    products(first: 24${after}${sortArg}${queryArg}) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id title vendor descriptionHtml tags
          variants(first:1) { edges { node { id sku price { amount currencyCode } quantityAvailable } } }
          images(first:1) { edges { node { url } } }
        }
      }
    }
  }`);
  const { edges, pageInfo } = data.products;
  return { products: edges.map(parseProduct), hasNextPage: pageInfo.hasNextPage, endCursor: pageInfo.endCursor };
}

// Server-side free-text search via the Storefront API's `search` endpoint.
// Used when the customer types in the search box — searches the WHOLE catalog,
// not just the records currently loaded into memory.
//
// Differences vs fetchShopifyProducts:
//   - `search` endpoint returns Product | Page | Article; we filter to Product
//   - Results are sorted by relevance, not by CREATED_AT/PRICE (sort is
//     intentionally ignored when searching — relevance wins)
//   - `prefix: LAST` enables partial-word match on the final term, so typing
//     "moody" matches "moodymann" without waiting for the full word
//   - Filter tags ARE still applied if present, so "year=2024 + search=detroit"
//     narrows correctly
//
// Note: server-side search uses Shopify's relevance scoring which indexes
// title, vendor, tags, product_type, and metafields exposed to search.
// Description body is NOT searched by default.
async function fetchShopifyProductSearch({ cursor=null, searchTerm='', filterTags=[], dnb=false } = {}) {
  if (!searchTerm.trim()) {
    // Caller should not invoke us with empty term; bail safely.
    return { products: [], hasNextPage: false, endCursor: null };
  }
  const after = cursor ? `, after: "${cursor}"` : '';
  // Combine the free-text search with optional tag filters. The search-syntax
  // is space-separated AND, so we append each `tag:'X'` clause inline.
  // Also exclude forthcoming pre-orders — they live only in the Forthcoming
  // section and should never surface in a normal catalogue search.
  const queryParts = [searchTerm.trim(), `-tag:'forthcoming'`];
  for (const t of filterTags) queryParts.push(`tag:'${t}'`);
  // D&B scoping: in the D&B section, require a D&B tag; in the main catalogue,
  // exclude all D&B tags so house searches never surface drum & bass.
  if (dnb) {
    queryParts.push(`(${DNB_TAGS.map(t => `tag:'${t}'`).join(' OR ')})`);
  } else {
    for (const t of DNB_TAGS) queryParts.push(`-tag:'${t}'`);
  }
  const combinedQuery = JSON.stringify(queryParts.join(' '));
  const data = await shopifyQuery(`{
    search(query: ${combinedQuery}, first: 24${after}, types: PRODUCT, prefix: LAST) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          ... on Product {
            id title vendor descriptionHtml tags
            variants(first:1) { edges { node { id sku price { amount currencyCode } quantityAvailable } } }
            images(first:1) { edges { node { url } } }
          }
        }
      }
    }
  }`);
  const { edges, pageInfo } = data.search;
  // Filter out any edges that weren't Products (defensive — types: PRODUCT
  // should make this unnecessary, but if Shopify ever returns mixed types
  // we won't crash on missing fields).
  const products = edges
    .map(e => e.node)
    .filter(n => n && n.id && n.id.includes('/Product/'))
    .map(node => parseProduct({ node }));
  return { products, hasNextPage: pageInfo.hasNextPage, endCursor: pageInfo.endCursor };
}

// Fetch only the lightweight metadata (tags + vendor) for ALL products in the
// catalog. Used to populate filter pills (genres, years, labels) so customers
// can see the full range of options on first page load — not just the first
// 24 products that the paginated card-grid happens to have loaded.
//
// This is intentionally a separate query from fetchShopifyProducts: it skips
// images, variants, descriptionHtml etc. so the response is small and fast
// even with thousands of products. Paginates with the Storefront API maximum
// of 250 per page.
async function fetchAllProductMetadata() {
  const all = [];
  let cursor = null;
  let safety = 25; // up to 25 pages × 250 = 6250 products. Hard-stop if catalog ever balloons past that.
  while (safety-- > 0) {
    const after = cursor ? `, after: "${cursor}"` : '';
    const data = await shopifyQuery(`{
      products(first: 250${after}) {
        pageInfo { hasNextPage endCursor }
        edges { node { tags vendor } }
      }
    }`);
    const { edges, pageInfo } = data.products;
    for (const e of edges) all.push(e.node);
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  return all;
}

// Fetch the set of handles + variant SKUs of every LIVE product, lowercased.
// Used by the pre-order importer to auto-exclude records that already exist in
// the catalogue (an exact cat-no match would otherwise re-import a live, in-stock
// product as a stock-0 "forthcoming" pre-order). Small payload: handle + first
// variant SKU only. Returns a Set for O(1) exact-match lookup.
async function fetchLiveHandles() {
  const set = new Set();
  let cursor = null;
  let safety = 25; // up to 25 × 250 = 6250 products
  while (safety-- > 0) {
    const after = cursor ? `, after: "${cursor}"` : '';
    const data = await shopifyQuery(`{
      products(first: 250${after}) {
        pageInfo { hasNextPage endCursor }
        edges { node { handle variants(first: 1) { edges { node { sku } } } } }
      }
    }`);
    const { edges, pageInfo } = data.products;
    for (const e of edges) {
      const h = (e.node.handle || '').trim().toLowerCase();
      if (h) set.add(h);
      const sku = (e.node.variants?.edges?.[0]?.node?.sku || '').trim().toLowerCase();
      if (sku) set.add(sku);
    }
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  return set;
}

// Fetch a single product by handle. Used when adding a wishlisted item to cart
// where the record may not be in our paginated `records` array yet.
async function fetchShopifyProductByHandle(handle) {
  if (!handle) return null;
  const data = await shopifyQuery(`
    query($h: String!) {
      product(handle: $h) {
        id title vendor descriptionHtml tags
        variants(first:1) { edges { node { id sku price { amount currencyCode } quantityAvailable } } }
        images(first:1) { edges { node { url } } }
      }
    }`, { h: handle });
  if (!data.product) return null;
  return parseProduct({ node: data.product });
}

// ── CHECKOUT ───────────────────────────────────────────────────
async function shopifyCheckout(cartItems, session=null) {
  const lines = cartItems
    .filter(i => i.shopifyVariantId)
    .map(i => ({ merchandiseId: i.shopifyVariantId, quantity: i.qty }));
  if (!lines.length) throw new Error('No items in cart.');

  // Authenticated path: when the buyer is logged in, create the cart in the
  // Worker so it can attach the CAAPI access token (held server-side) as the
  // cart's buyerIdentity. The buyer then stays logged in through to checkout —
  // their details, saved cards and store credit carry over. The access token
  // never touches the browser.
  if (session) {
    try {
      const r = await fetch(`${WORKER_URL}?action=create-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, lines }),
      });
      const d = await r.json();
      if (r.ok && d.checkoutUrl) {
        window.open(d.checkoutUrl, '_blank');
        return;
      }
      // If the Worker couldn't build an authenticated cart, fall through to the
      // guest path below rather than failing the purchase.
    } catch {
      // Network/Worker error → fall through to guest checkout.
    }
  }

  // Guest path (anonymous buyer, or authenticated path fell through): create
  // the cart directly via the Storefront API, exactly as before.
  const input = { lines };
  const data = await shopifyQuery(
    `mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart { checkoutUrl }
        userErrors { field message }
      }
    }`,
    { input }
  );
  const errs = data.cartCreate?.userErrors;
  if (errs?.length) throw new Error(errs.map(e => e.message).join(', '));
  const rawUrl = data.cartCreate?.cart?.checkoutUrl;
  if (!rawUrl) throw new Error('No checkoutUrl in response: ' + JSON.stringify(data));
  window.open(rawUrl.replace('houseonly.store', 'checkout.houseonly.store'), '_blank');
}

// ── WORKER / R2 ────────────────────────────────────────────────
const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'https://houseonly-worker.emontagut.workers.dev';

// Resize an image blob to fit within maxDim x maxDim, preserving aspect ratio.
// Returns the original blob untouched if it's already within bounds. Used to
// prevent Shopify's ~25 megapixel rejection (covers above ~5000px are common
// from W&S salespapers). Uses Canvas API in the browser — no server calls.
//
// quality is 0..1 for JPEG re-encoding. Default 0.92 keeps visual quality high
// while shaving plenty of bytes off the original 7000x7000+ originals.
async function resizeImageIfNeeded(blob, maxDim = 2000, quality = 0.92) {
  // Decode the image to check its real dimensions. createImageBitmap is fast
  // and doesn't need a DOM <img> element.
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    // Decode failed (corrupt image, unsupported format). Return original
    // and let the upload step handle / surface the error.
    return blob;
  }
  const { width, height } = bitmap;
  if (width <= maxDim && height <= maxDim) {
    bitmap.close?.();
    return blob; // already small enough
  }
  // Compute target dimensions preserving aspect ratio.
  const scale = Math.min(maxDim / width, maxDim / height);
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close?.();
  // Re-encode as JPEG. We always emit JPEG regardless of input type, since
  // a 2000px JPEG at q=0.92 is the right format for cover art (small + good).
  const resized = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      'image/jpeg',
      quality
    );
  });
  return resized;
}

async function uploadToR2(blob, key, mimeType) {
  const fd = new FormData();
  fd.append('file', new File([blob], key.split('/').pop(), { type: mimeType }));
  fd.append('key', key);
  const r = await fetch(`${WORKER_URL}?action=upload`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`R2 upload failed: ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.url;
}

async function fetchCoverArt(title, artist, ean, label='', year='', catno='') {
  try {
    const params = new URLSearchParams();
    if (ean)    params.set('ean', String(ean).trim());
    if (title)  params.set('title', title);
    if (artist) params.set('artist', artist);
    if (label)  params.set('label', label);
    if (year)   params.set('year', String(year));
    if (catno)  params.set('catno', catno);
    const r = await fetch(`${WORKER_URL}?${params.toString()}`);
    if (!r.ok) return '';
    const d = await r.json();
    return d.imageUrl || '';
  } catch { return ''; }
}

// ── CUSTOMER AUTH ──────────────────────────────────────────────
//
// Customer accounts use Shopify's New Customer Accounts (NCA) via the Customer
// Account API. Auth is a confidential OAuth flow handled entirely by the Worker
// (/auth/login, /auth/callback, /auth/logout). The browser never sees a Shopify
// token — only an opaque SESSION id minted by the Worker, kept in localStorage
// and sent to the Worker on each request (same way the old Storefront token was
// sent). The Worker resolves session → customerId and holds the real CAAPI
// access/refresh tokens server-side in KV.
//
// Anonymous users still get a working wishlist via localStorage (below).

const AUTH_KEY  = 'houseonly_customer_auth';
const WISH_KEY  = 'houseonly_wishlist';

function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // New model: { session }. Reject legacy { token } shapes so a stale
    // pre-migration auth blob can't be mistaken for a valid session.
    if (!parsed?.session) return null;
    return parsed;
  } catch { return null; }
}

function saveAuth(auth) {
  if (auth) localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
  else localStorage.removeItem(AUTH_KEY);
}

// After the Worker's /auth/callback redirects back to the site, the opaque
// session id arrives in the URL fragment as #session=XXX. Capture it, persist
// it as our auth, and strip the fragment from the URL (so it isn't left in the
// address bar / history). Returns the new auth object, or null if no session
// fragment was present.
function captureSessionFromUrl() {
  try {
    const hash = window.location.hash || '';
    const m = hash.match(/[#&]session=([^&]+)/);
    if (!m) return null;
    const session = decodeURIComponent(m[1]);
    if (!session) return null;
    const auth = { session };
    saveAuth(auth);
    // Remove the fragment without reloading or adding a history entry.
    const clean = window.location.pathname + window.location.search;
    window.history.replaceState(null, '', clean);
    return auth;
  } catch {
    return null;
  }
}

// Build the Worker auth URLs for this environment. WORKER_URL already points at
// the right env (prod vs staging) via VITE_WORKER_URL, so login/logout follow.
function workerLoginUrl(returnToPath) {
  const rt = encodeURIComponent(returnToPath || (typeof window !== 'undefined' ? window.location.pathname : '/'));
  return `${WORKER_URL}/auth/login?return_to=${rt}`;
}
function workerLogoutUrl(session, returnToPath) {
  const rt = encodeURIComponent(returnToPath || '/');
  const s = encodeURIComponent(session || '');
  return `${WORKER_URL}/auth/logout?session=${s}&return_to=${rt}`;
}

async function customerLogin(email, password) {
  const d = await shopifyQuery(`
    mutation($input: CustomerAccessTokenCreateInput!) {
      customerAccessTokenCreate(input: $input) {
        customerAccessToken { accessToken expiresAt }
        customerUserErrors { code field message }
      }
    }`, { input: { email, password } });
  const result = d.customerAccessTokenCreate;
  if (result.customerUserErrors?.length) {
    throw new Error(result.customerUserErrors[0].message);
  }
  if (!result.customerAccessToken) {
    throw new Error('Login failed.');
  }
  return result.customerAccessToken;
}

async function customerSignup(email, password, firstName='', lastName='') {
  const created = await shopifyQuery(`
    mutation($input: CustomerCreateInput!) {
      customerCreate(input: $input) {
        customer { id }
        customerUserErrors { code field message }
      }
    }`, { input: { email, password, firstName, lastName, acceptsMarketing: false } });
  const cu = created.customerCreate;
  if (cu.customerUserErrors?.length) {
    throw new Error(cu.customerUserErrors[0].message);
  }
  // After signup, log in to get a token
  return customerLogin(email, password);
}

async function customerRecover(email) {
  const d = await shopifyQuery(`
    mutation($email: String!) {
      customerRecover(email: $email) {
        customerUserErrors { code field message }
      }
    }`, { email });
  const errs = d.customerRecover.customerUserErrors;
  if (errs?.length) throw new Error(errs[0].message);
  return true;
}

// Reset password from the URL Shopify emails to the customer.
// resetUrl is the full URL the user landed on, e.g.
//   https://houseonly.store/account/reset/<id>/<token>?syclid=...
// On success returns { accessToken, expiresAt } — same shape as customerLogin.
async function customerResetByUrl(resetUrl, password) {
  const d = await shopifyQuery(`
    mutation($url: URL!, $password: String!) {
      customerResetByUrl(resetUrl: $url, password: $password) {
        customerAccessToken { accessToken expiresAt }
        customerUserErrors { code field message }
      }
    }`, { url: resetUrl, password });
  const result = d.customerResetByUrl;
  if (result.customerUserErrors?.length) {
    throw new Error(result.customerUserErrors[0].message);
  }
  if (!result.customerAccessToken) {
    throw new Error('Password reset failed.');
  }
  return result.customerAccessToken;
}

// Activate a new account from the URL Shopify emails to the customer.
// activationUrl is the full URL the user landed on, e.g.
//   https://houseonly.store/account/activate/<id>/<token>?syclid=...
// On success returns { accessToken, expiresAt } — same shape as customerLogin.
async function customerActivateByUrl(activationUrl, password) {
  const d = await shopifyQuery(`
    mutation($url: URL!, $password: String!) {
      customerActivateByUrl(activationUrl: $url, password: $password) {
        customerAccessToken { accessToken expiresAt }
        customerUserErrors { code field message }
      }
    }`, { url: activationUrl, password });
  const result = d.customerActivateByUrl;
  if (result.customerUserErrors?.length) {
    throw new Error(result.customerUserErrors[0].message);
  }
  if (!result.customerAccessToken) {
    throw new Error('Account activation failed.');
  }
  return result.customerAccessToken;
}

async function customerProfile(session) {
  if (!session) return null;
  try {
    const r = await fetch(`${WORKER_URL}?action=account-profile&session=${encodeURIComponent(session)}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.error) return null;
    return d; // { id, email, firstName, lastName, displayName }
  } catch { return null; }
}

async function customerOrders(session) {
  if (!session) return [];
  try {
    const r = await fetch(`${WORKER_URL}?action=account-orders&session=${encodeURIComponent(session)}`);
    if (!r.ok) return [];
    const d = await r.json();
    if (d.error) return [];
    return Array.isArray(d.orders) ? d.orders : [];
  } catch {
    return [];
  }
}

// ── WISHLIST ───────────────────────────────────────────────────

function loadLocalWishlist() {
  try {
    const raw = localStorage.getItem(WISH_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveLocalWishlist(items) {
  localStorage.setItem(WISH_KEY, JSON.stringify(items));
}

function recordToWishlistItem(r) {
  return {
    handle: r.slug || r.handle || (r.id != null ? String(r.id) : ''),
    title: r.title || '',
    artist: r.artist || '',
    label: r.label || '',
    price: typeof r.price === 'number' ? r.price.toFixed(2) : String(r.price || ''),
    coverUrl: r.coverUrl || '',
    addedAt: Date.now(),
  };
}

async function fetchServerWishlist(session) {
  const r = await fetch(`${WORKER_URL}?action=wishlist&session=${encodeURIComponent(session)}`);
  if (!r.ok) return null;
  const d = await r.json();
  if (d.error) return null;
  return d.items || [];
}

async function postServerWishlistItem(session, item) {
  const r = await fetch(`${WORKER_URL}?action=wishlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, item }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  if (d.error) return null;
  return d.items || null;
}

async function deleteServerWishlistItem(session, handle) {
  const r = await fetch(`${WORKER_URL}?action=wishlist`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, handle }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  if (d.error) return null;
  return d.items || null;
}

async function mergeServerWishlist(session, items) {
  const r = await fetch(`${WORKER_URL}?action=wishlist-merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, items }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  if (d.error) return null;
  return d.items || null;
}

// ── BACKORDER REQUEST ──────────────────────────────────────────
//
// For releases that are out of stock but recent (year >= currentYear-1),
// customers can submit a request rather than getting "Sold Out". This sends
// the request to the worker, which creates a Shopify draft order. Eduardo
// confirms availability with the distributor in admin and either:
//   - Sends an invoice from the draft (customer pays online → real order)
//   - Cancels the draft (with an apology email, manual)
//
// No payment is captured at the request step. Customer is committed to the
// request but not charged.
async function submitBackorderRequest(payload) {
  const r = await fetch(`${WORKER_URL}?action=backorder-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const msg = data?.error || `Request failed (HTTP ${r.status})`;
    const detail = data?.details ? ' — ' + JSON.stringify(data.details) : '';
    throw new Error(msg + detail);
  }
  return data;
}

// Determine if a release is eligible for the backorder/request flow.
// Rule: stock=0 AND year >= currentYear - 1.
// This captures recent releases (last ~12-24 months) where labels might
// repress, while excluding older releases that are unlikely to come back.
function isBackorderEligible(r) {
  if (!r) return false;
  if ((r.stock ?? 0) > 0) return false;
  const y = parseInt(r.year || 0, 10);
  if (!y) return false; // no year tag = treat as truly sold out
  const currentYear = new Date().getFullYear();
  return y >= currentYear - 1;
}

// Determine if a release is a PRE-ORDER (forthcoming). Source of truth is the
// `forthcoming` tag, set by the pre-order importer when a release is listed
// from a distributor's pre-sale feed before it physically arrives.
//
// IMPORTANT — this is intentionally tag-based, NOT stock/date-based, because a
// forthcoming record and a sold-out backorder record can look identical by
// stock (both 0) and year (both recent). Only the tag distinguishes them.
// isForthcoming() takes precedence over isBackorderEligible() everywhere a
// button renders, so a pre-order shows PRE-ORDER (paid checkout) and never the
// unpaid backorder REQUEST form.
//
// Lifecycle: present = pre-order (paid, Forthcoming section only). When stock
// arrives, the arrival importer removes this tag and sets inventory, so the
// record graduates into the main catalogue automatically (the catalogue query
// excludes `forthcoming`, the Forthcoming query requires it).
function isForthcoming(r) {
  return !!(r && Array.isArray(r.tags) && r.tags.includes('forthcoming'));
}

// Add N days to an ISO date string, returning a new ISO `YYYY-MM-DD`.
// Used to apply the +14-day buffer (record lands in Madrid, then ships) to the
// distributor's raw release date at DISPLAY time only — the stored release:
// tag keeps the true street date so the buffer is a one-line change if needed.
// Parse a YYYY-MM-DD string at LOCAL noon, not UTC midnight. A bare
// `new Date('2026-06-30')` is parsed as UTC midnight, which then renders one
// calendar day early in any negative-offset timezone (and is fragile at DST
// boundaries). Anchoring at local noon keeps the calendar day stable in every
// timezone. Falls back to default parsing if the string isn't a plain date.
function parseLocalDate(isoDate) {
  if (!isoDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate).trim());
  const d = m ? new Date(isoDate + 'T12:00:00') : new Date(isoDate);
  return isNaN(d.getTime()) ? null : d;
}

function addDays(isoDate, days) {
  const d = parseLocalDate(isoDate);
  if (!d) return '';
  d.setDate(d.getDate() + days);
  const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// Format a release date (ISO `YYYY-MM-DD`) into a friendly full date,
// "Expected 4 September 2026". Degrades gracefully: bad/missing date →
// just "Pre-order" (never a fake date).
function formatExpected(isoDate) {
  const d = parseLocalDate(isoDate);
  if (!d) return 'Pre-order';
  return 'Expected ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ── LOGO ──────────────────────────────────────────────────────
function Logo({ scale=1, onClick }) {
  return (
    <svg width={160*scale} height={52*scale} viewBox="0 0 160 52" style={{ display:'block', cursor:onClick?'pointer':'default', flexShrink:0 }} onClick={onClick}>
      <text x="0" y="34" fontSize="36" fontWeight="900" fill="#efefef" fontFamily="'Inter',system-ui,sans-serif" letterSpacing="-1">HOUSE</text>
      <rect x="0" y="38" width="148" height="3" fill="#c8ff00"/>
      <text x="0" y="52" fontSize="36" fontWeight="900" fill="#c8ff00" fontFamily="'Inter',system-ui,sans-serif" letterSpacing="-1">ONLY</text>
    </svg>
  );
}

// ── SHARED UI ──────────────────────────────────────────────────
function Btn({ ch, onClick, variant='primary', disabled, full }) {
  const v = {
    primary:{ background:S.accent, color:'#080808', border:'none' },
    ghost:{ background:'transparent', color:S.text, border:`1px solid ${S.border}` },
    dark:{ background:S.border, color:S.muted, border:'none' },
  };
  return (
    <button onClick={disabled?null:onClick} style={{ ...v[variant], cursor:disabled?'not-allowed':'pointer', fontFamily:'inherit', fontWeight:700, letterSpacing:1.5, textTransform:'uppercase', fontSize:10, borderRadius:2, padding:'10px 18px', opacity:disabled?0.35:1, width:full?'100%':undefined, transition:'opacity 0.15s', whiteSpace:'nowrap' }}>{ch}</button>
  );
}

function coverSrc(url) {
  if (!url) return null;
  if (url.includes('discogs.com')) return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=300&output=jpg`;
  return url;
}

function AudioPlayer({ src }) {
  const ref = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [prog, setProg] = useState(0);
  const toggle = () => {
    if (!src) return;
    if (playing) { ref.current.pause(); setPlaying(false); }
    else { ref.current.play().catch(()=>{}); setPlaying(true); }
  };
  useEffect(() => {
    const a = ref.current; if (!a) return;
    const u = () => setProg((a.currentTime/a.duration)*100||0);
    const e = () => { setPlaying(false); setProg(0); };
    a.addEventListener('timeupdate',u); a.addEventListener('ended',e);
    return () => { a.removeEventListener('timeupdate',u); a.removeEventListener('ended',e); };
  }, []);
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
      {src&&<audio ref={ref} src={src} />}
      <button onClick={toggle} disabled={!src} style={{ width:32, height:32, borderRadius:'50%', background:src?S.accent:S.border, border:'none', cursor:src?'pointer':'not-allowed', fontSize:12, color:src?'#080808':S.muted, flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>{playing?'⏸':'▶'}</button>
      <div style={{ flex:1, height:2, background:S.border, borderRadius:1, overflow:'hidden' }}>
        <div style={{ width:`${prog}%`, height:'100%', background:S.accent, transition:'width 0.1s' }} />
      </div>
      <span style={{ fontSize:9, color:S.muted, letterSpacing:1, whiteSpace:'nowrap' }}>{src?'SNIPPET':'NO PREVIEW'}</span>
    </div>
  );
}

// ── GLOBAL MUSIC PLAYER ────────────────────────────────────────
//
// Owns a single <audio> element that plays release snippets across the whole
// site. Customers can:
//   - Play a release from a card (queues all its tracks, plays from track 1)
//   - Add a release to the queue (appends all tracks to end of queue)
//   - Continue listening as they navigate between releases
//   - See a sticky bottom bar with prev/play/next, scrubber, current track
//   - Open a queue panel to manage what plays next
//   - Heart the currently playing release
//
// Queue persists in sessionStorage (survives page reloads, dies on tab close).
//
// Internal model: the queue is a flat list of "items" where each item is
// { release, trackIdx, trackUrl, trackName }. When a release with N tracks is
// queued, N items get appended. Playback advances item-by-item via onended.

const PlayerCtx = createContext(null);

function PlayerProvider({ children, gate }) {
  // `gate(r)` is an optional callback the host (App) passes to control whether a
  // release may start playing. It returns true to allow, false to block (e.g.
  // forthcoming previews require an account). Default: always allow.
  const playGate = useCallback((r) => (typeof gate === 'function' ? gate(r) : true), [gate]);
  const audioRef = useRef(null);
  const [queue, setQueue]       = useState([]);  // [{releaseId, releaseSnap, trackIdx, url, name}]
  const [currentIdx, setCurIdx] = useState(-1);  // index within queue, or -1 if nothing
  const [isPlaying, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);   // 0..1
  const [duration, setDuration] = useState(0);   // seconds
  const [position, setPosition] = useState(0);   // seconds
  const [volume, setVolume]     = useState(1);
  const [muted, setMuted]       = useState(false);

  // Hydrate queue + current state from sessionStorage on mount (survives reload, clears on tab close)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('houseonly_player_state');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.queue) && parsed.queue.length) {
        setQueue(parsed.queue);
        if (typeof parsed.currentIdx === 'number' && parsed.currentIdx >= 0 && parsed.currentIdx < parsed.queue.length) {
          setCurIdx(parsed.currentIdx);
        }
      }
    } catch {}
  }, []);

  // Persist queue + currentIdx to sessionStorage whenever they change
  useEffect(() => {
    try {
      sessionStorage.setItem('houseonly_player_state', JSON.stringify({ queue, currentIdx }));
    } catch {}
  }, [queue, currentIdx]);

  // Build queue items from a release
  const itemsFromRelease = (r) => {
    const tracks = r?.tracks || [];
    return tracks.map((t, i) => ({
      releaseId: r.id,
      // Snapshot of the fields we need to render the player without re-fetching the full record
      releaseSnap: { id: r.id, title: r.title, artist: r.artist, label: r.label, catalog: r.catalog, coverUrl: r.coverUrl, slug: r.slug, handle: r.handle, price: r.price, stock: r.stock, g: r.g },
      trackIdx: i,
      url: t.url,
      name: t.name || `Track ${i+1}`,
    }));
  };

  const playRelease = useCallback((r, startAtTrackIdx = 0) => {
    if (!playGate(r)) return; // host blocked playback (e.g. forthcoming needs account)
    const items = itemsFromRelease(r);
    if (!items.length) return;
    const startOffset = Math.max(0, Math.min(items.length - 1, startAtTrackIdx));
    setQueue(prevQueue => {
      // Case 1: empty queue → start fresh with this release.
      if (prevQueue.length === 0) {
        setCurIdx(startOffset);
        setPlaying(true);
        return items;
      }
      // Case 2: release is already in the queue → jump to the requested track of that release, don't duplicate.
      const releaseId = items[0].releaseId;
      const existingIdx = prevQueue.findIndex(it => it.releaseId === releaseId);
      if (existingIdx >= 0) {
        setCurIdx(existingIdx + startOffset);
        setPlaying(true);
        return prevQueue;
      }
      // Case 3: insert release immediately after the currently-playing item, then jump to its requested track.
      // If nothing is currently playing (currentIdx < 0), insert at the start.
      const insertAt = currentIdx < 0 ? 0 : currentIdx + 1;
      const next = [...prevQueue.slice(0, insertAt), ...items, ...prevQueue.slice(insertAt)];
      setCurIdx(insertAt + startOffset);
      setPlaying(true);
      return next;
    });
  }, [currentIdx, playGate]);

  const addToQueue = useCallback((r) => {
    if (!playGate(r)) return; // host blocked (e.g. forthcoming needs account)
    const items = itemsFromRelease(r);
    if (!items.length) return;
    setQueue(q => {
      const next = [...q, ...items];
      // If nothing is currently playing, start on the first newly-added item
      if (currentIdx < 0) {
        setCurIdx(q.length);
        setPlaying(true);
      }
      return next;
    });
  }, [currentIdx, playGate]);

  const removeFromQueue = useCallback((idx) => {
    setQueue(q => {
      const next = q.filter((_, i) => i !== idx);
      if (idx === currentIdx) {
        // Removed currently-playing item: if there's a next one, play it (same idx since list shifted up)
        if (idx < next.length) {
          setCurIdx(idx);
          setPlaying(true);
        } else {
          setCurIdx(-1);
          setPlaying(false);
        }
      } else if (idx < currentIdx) {
        setCurIdx(c => c - 1);
      }
      return next;
    });
  }, [currentIdx]);

  const clearQueue = useCallback(() => {
    setQueue([]);
    setCurIdx(-1);
    setPlaying(false);
  }, []);

  const playNext = useCallback(() => {
    setCurIdx(c => {
      const next = c + 1;
      if (next >= queue.length) { setPlaying(false); return -1; }
      setPlaying(true);
      return next;
    });
  }, [queue.length]);

  const playPrev = useCallback(() => {
    // If we're more than 3s into the current track, restart it instead of going to previous
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }
    setCurIdx(c => {
      if (c <= 0) return c; // already at start
      setPlaying(true);
      return c - 1;
    });
  }, []);

  const jumpToQueueIdx = useCallback((idx) => {
    if (idx < 0 || idx >= queue.length) return;
    setCurIdx(idx);
    setPlaying(true);
  }, [queue.length]);

  const togglePlayPause = useCallback(() => {
    if (currentIdx < 0) {
      // Nothing loaded — pressing play with an existing queue should start at index 0
      if (queue.length > 0) {
        setCurIdx(0);
        setPlaying(true);
      }
      return;
    }
    setPlaying(p => !p);
  }, [currentIdx, queue.length]);

  const seek = useCallback((pct) => {
    const a = audioRef.current;
    if (!a || !a.duration) return;
    a.currentTime = pct * a.duration;
  }, []);

  const setVolPct = useCallback((v) => {
    setVolume(v);
    if (audioRef.current) audioRef.current.volume = v;
    if (v > 0 && muted) setMuted(false);
  }, [muted]);

  const toggleMute = useCallback(() => {
    setMuted(m => !m);
  }, []);

  // Keep <audio> element in sync with state
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const cur = queue[currentIdx];
    if (!cur) {
      a.pause();
      a.removeAttribute('src');
      a.load();
      return;
    }
    const srcChanged = a.src !== cur.url;
    if (srcChanged) {
      a.src = cur.url;
      // Force the element to (re)load the new source. Without this, after a
      // prior removeAttribute('src') + load() (e.g. from clearQueue), the
      // element can stay in an "empty" media state and a.play() rejects.
      a.load();
    }
    let onReady = null;
    if (isPlaying) {
      // play() returns a promise that can reject if interrupted by a load.
      // If src changed in this same tick, the load() above may not be ready
      // yet — wait for canplay before calling play() to avoid an AbortError
      // that would silently flip isPlaying back to false.
      if (srcChanged) {
        onReady = () => { a.play().catch(() => setPlaying(false)); };
        a.addEventListener('canplay', onReady, { once: true });
      } else {
        a.play().catch(() => setPlaying(false));
      }
    } else {
      a.pause();
    }
    return () => {
      if (onReady) a.removeEventListener('canplay', onReady);
    };
  }, [queue, currentIdx, isPlaying]);

  // Volume + mute → audio
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted]);

  // Audio element event listeners
  const onTimeUpdate = () => {
    const a = audioRef.current;
    if (!a) return;
    setPosition(a.currentTime || 0);
    setDuration(a.duration || 0);
    setProgress(a.duration ? (a.currentTime / a.duration) : 0);
  };
  const onEnded = () => {
    // Auto-advance to next item; stop if queue ends
    setCurIdx(c => {
      const next = c + 1;
      if (next >= queue.length) { setPlaying(false); return -1; }
      setPlaying(true);
      return next;
    });
  };

  const current = currentIdx >= 0 ? queue[currentIdx] : null;
  const currentRelease = current?.releaseSnap || null;

  // Helper: is a given release the currently-playing one?
  const isReleasePlaying = useCallback((r) => {
    return isPlaying && current && current.releaseId === r?.id;
  }, [isPlaying, current]);

  // Helper: is a release queued at all (playing or pending)?
  const isReleaseQueued = useCallback((r) => {
    return queue.some(item => item.releaseId === r?.id);
  }, [queue]);

  const value = {
    queue, currentIdx, current, currentRelease,
    isPlaying, progress, duration, position, volume, muted,
    playRelease, addToQueue, removeFromQueue, clearQueue,
    playNext, playPrev, jumpToQueueIdx, togglePlayPause, seek, setVolPct, toggleMute,
    isReleasePlaying, isReleaseQueued,
  };

  return (
    <PlayerCtx.Provider value={value}>
      <audio ref={audioRef} onTimeUpdate={onTimeUpdate} onEnded={onEnded} preload="metadata" />
      {children}
    </PlayerCtx.Provider>
  );
}

function usePlayer() {
  return useContext(PlayerCtx);
}

// Format seconds as M:SS
function fmtTime(s) {
  if (!s || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Shared viewport hook: returns true when window is narrower than `threshold` px.
// Used by PlayerBar and RecordCard to switch to a stacked layout on phones.
function useIsMobile(threshold = 720) {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < threshold);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < threshold);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [threshold]);
  return isMobile;
}

// ── NEWSLETTER SIGNUP (double opt-in via Worker → Resend) ───────
// One component, two looks via `variant`: 'footer' (full block at the bottom
// of the page) and 'grid' (a card that drops into the catalogue grid, spanning
// the full row). Both POST ?action=newsletter-subscribe and then ask the user
// to check their inbox — confirmation happens by clicking the email link.
function NewsletterSignup({ variant = 'footer', source = 'footer' }) {
  const isMobile = useIsMobile(640);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | success | error
  const [errMsg, setErrMsg] = useState('');

  // Chrome paints autofilled inputs with its own light background, ignoring inline
  // styles. The only reliable override is an inset box-shadow + forced text colour
  // on :-webkit-autofill, which can't be done inline — so inject it once.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById('nl-input-style')) return;
    const el = document.createElement('style');
    el.id = 'nl-input-style';
    el.textContent =
      '.nl-input:-webkit-autofill,.nl-input:-webkit-autofill:hover,.nl-input:-webkit-autofill:focus{' +
      '-webkit-text-fill-color:' + S.text + ';' +
      '-webkit-box-shadow:0 0 0 1000px ' + S.bg + ' inset;' +
      'box-shadow:0 0 0 1000px ' + S.bg + ' inset;' +
      'caret-color:' + S.text + ';transition:background-color 9999s ease-in-out 0s;}' +
      '.nl-input::placeholder{color:' + S.muted + ';}';
    document.head.appendChild(el);
  }, []);

  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

  async function submit() {
    const e = email.trim().toLowerCase();
    if (!validEmail(e)) { setStatus('error'); setErrMsg('Enter a valid email address.'); return; }
    setStatus('loading'); setErrMsg('');
    try {
      const r = await fetch(`${WORKER_URL}?action=newsletter-subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: e, source }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok) { setStatus('success'); }
      else { setStatus('error'); setErrMsg('Something went wrong. Please try again.'); }
    } catch {
      setStatus('error'); setErrMsg('Network error. Please try again.');
    }
  }

  const onKey = (ev) => { if (ev.key === 'Enter') submit(); };
  const isGrid = variant === 'grid';

  // Success state — same message for both variants (double opt-in: check inbox).
  if (status === 'success') {
    return (
      <div style={{
        gridColumn: isGrid ? '1 / -1' : undefined,
        background: isGrid ? S.surf : 'transparent',
        border: isGrid ? `1px solid ${S.accent}` : undefined,
        borderRadius: 2,
        borderTop: isGrid ? undefined : `1px solid ${S.border}`,
        padding: isGrid ? '28px 22px' : (isMobile ? '40px 20px' : '52px 20px'),
        maxWidth: isGrid ? undefined : 560,
        margin: isGrid ? undefined : '0 auto',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: isGrid ? 13 : 18, fontWeight: 800, color: S.accent, letterSpacing: 0.5, marginBottom: 8 }}>
          Almost there — check your inbox.
        </div>
        <div style={{ fontSize: isGrid ? 12 : 12, color: S.muted, lineHeight: 1.6, maxWidth: 420, margin: '0 auto' }}>
          We sent you a confirmation link. Click it to lock in early access to pre-orders.
        </div>
      </div>
    );
  }

  // The shared input + button row.
  const inputEl = (
    <input
      type="email"
      className="nl-input"
      value={email}
      onChange={(ev) => { setEmail(ev.target.value); if (status === 'error') setStatus('idle'); }}
      onKeyDown={onKey}
      placeholder="your@email.com"
      disabled={status === 'loading'}
      style={{
        background: S.bg, border: `1px solid ${S.border}`, color: S.text,
        borderRadius: 2, padding: '10px 12px', fontSize: 12, fontFamily: 'inherit',
        outline: 'none', flex: 1, minWidth: 0, boxSizing: 'border-box',
      }}
    />
  );
  const buttonEl = (
    <button
      onClick={submit}
      disabled={status === 'loading'}
      style={{
        background: S.accent, color: '#080808', border: 'none', borderRadius: 2,
        padding: '10px 18px', fontSize: 10, fontWeight: 800, letterSpacing: 1.5,
        textTransform: 'uppercase', fontFamily: 'inherit',
        cursor: status === 'loading' ? 'wait' : 'pointer',
        opacity: status === 'loading' ? 0.6 : 1, whiteSpace: 'nowrap', flexShrink: 0,
      }}
    >
      {status === 'loading' ? 'Joining…' : 'Get early access'}
    </button>
  );

  // ----- GRID variant: a full-row card inside the catalogue grid -----
  if (isGrid) {
    return (
      <div style={{
        gridColumn: '1 / -1',
        background: S.surf,
        border: `1px solid ${S.border}`,
        borderLeft: `2px solid ${S.accent}`,
        borderRadius: 2,
        padding: isMobile ? '20px 18px' : '24px 26px',
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        alignItems: isMobile ? 'stretch' : 'center',
        gap: isMobile ? 14 : 28,
      }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: S.text, letterSpacing: 0.3, marginBottom: 5 }}>
            First access to pre-orders.
          </div>
          <div style={{ fontSize: 11, color: S.muted, lineHeight: 1.6 }}>
            Join the list — we tell you before the records that matter go public. No noise.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flex: isMobile ? '1 1 auto' : '0 0 auto', width: isMobile ? '100%' : 360, maxWidth: '100%' }}>
          {inputEl}
          {buttonEl}
        </div>
        {status === 'error' && (
          <div style={{ gridColumn: '1 / -1', flexBasis: '100%', fontSize: 10, color: S.danger, marginTop: isMobile ? 0 : 4 }}>{errMsg}</div>
        )}
      </div>
    );
  }

  // ----- FOOTER variant: a centered block above the bottom bar -----
  return (
    <div style={{
      borderTop: `1px solid ${S.border}`,
      padding: isMobile ? '40px 20px' : '52px 20px',
      maxWidth: 560, margin: '0 auto', textAlign: 'center',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
    }}>
      <div style={{ fontSize: 9, color: S.accent, letterSpacing: 3, textTransform: 'uppercase', fontWeight: 700, marginBottom: 12 }}>
        Join the list
      </div>
      <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 800, color: S.text, letterSpacing: -0.3, lineHeight: 1.25, marginBottom: 10 }}>
        First access to pre-orders.
      </div>
      <div style={{ fontSize: 12, color: S.muted, lineHeight: 1.6, maxWidth: 420, marginBottom: 22 }}>
        We tell you before the records that matter go public — plus the ones we think you should hear. No noise.
      </div>
      <div style={{ display: 'flex', gap: 8, width: '100%', maxWidth: 420, flexDirection: isMobile ? 'column' : 'row' }}>
        {inputEl}
        {buttonEl}
      </div>
      {status === 'error' && (
        <div style={{ fontSize: 10, color: S.danger, marginTop: 10 }}>{errMsg}</div>
      )}
      <div style={{ fontSize: 9, color: S.muted, marginTop: 16, letterSpacing: 0.5, lineHeight: 1.5 }}>
        Double opt-in. Unsubscribe anytime. We never share your email.
      </div>
    </div>
  );
}


// ── JOIN PAGE (/join) ───────────────────────────────────────────
// Standalone landing rendered at houseonly.store/join — the URL to paste in
// the Instagram bio, the Discogs seller profile, a QR sticker on the mailer,
// etc. Reuses the existing <NewsletterSignup> (same Worker → Resend double
// opt-in flow); only the framing around it is new. source="join" so the
// Worker/Resend can tell these subscribers apart from footer/grid signups.
function JoinPage({ onBack }) {
  const isMobile = useIsMobile(640);
  return (
    <div style={{background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif",display:'flex',flexDirection:'column'}}>
      <Nav onLogo={onBack}>
        <button onClick={onBack} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'5px 12px',borderRadius:2,whiteSpace:'nowrap'}}>← Shop</button>
      </Nav>
      <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:isMobile?'48px 20px':'72px 20px'}}>
        <div style={{maxWidth:560,width:'100%',textAlign:'center'}}>
          <div style={{marginBottom:28,display:'flex',justifyContent:'center'}}>
            <Logo scale={isMobile?0.9:1.1} />
          </div>
          <h1 style={{fontSize:isMobile?20:26,fontWeight:800,letterSpacing:0.3,lineHeight:1.25,margin:'0 0 18px'}}>
            Join to receive weekly news from our House Only community.
          </h1>
          <p style={{fontSize:isMobile?13:14,color:S.muted,lineHeight:1.7,margin:'0 auto 4px',maxWidth:440}}>
            Forthcoming releases, new arrivals and more.
          </p>
          <p style={{fontSize:isMobile?13:14,color:S.muted,lineHeight:1.7,margin:'0 auto 32px',maxWidth:440}}>
            Thank you for supporting our store.
          </p>
          <NewsletterSignup variant="footer" source="join" />
        </div>
      </div>
    </div>
  );
}


// ── PLAYER BAR (sticky bottom) ──────────────────────────────────
function PlayerBar({ isWished, onWishlistToggle, onOpenRelease }) {
  const p = usePlayer();
  const [queueOpen, setQueueOpen] = useState(false);
  const isMobile = useIsMobile(720);
  const barRef = useRef(null);
  // Sync the rendered player-bar height to a CSS variable so the root container's
  // bottom padding clears the bar exactly, on any layout (1-row desktop / 2-row mobile).
  useEffect(() => {
    if (!barRef.current) {
      document.documentElement.style.setProperty('--player-h', '0px');
      return;
    }
    const update = () => {
      if (barRef.current) {
        document.documentElement.style.setProperty('--player-h', `${barRef.current.offsetHeight}px`);
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(barRef.current);
    return () => { ro.disconnect(); document.documentElement.style.setProperty('--player-h', '0px'); };
  });
  if (!p) return null;
  const { current, currentRelease, isPlaying, progress, duration, position, volume, muted, queue, currentIdx,
          playNext, playPrev, togglePlayPause, seek, setVolPct, toggleMute } = p;

  // Hide entirely if nothing has been played yet
  if (!current || !currentRelease) return null;

  const wished = isWished && currentRelease ? isWished(currentRelease) : false;
  const trackName = (current.name || '').replace(/^\d+_\d+_/, '').replace(/\.(mp3|wav|flac|aac|ogg)$/i, '');
  const onScrub = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
    const pct = (clientX - rect.left) / rect.width;
    seek(Math.max(0, Math.min(1, pct)));
  };

  // Shared building blocks
  const transport = (
    <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
      <button onClick={playPrev} aria-label="Previous" style={transportBtnStyle(currentIdx > 0)}>⏮</button>
      <button onClick={togglePlayPause} aria-label={isPlaying?'Pause':'Play'} style={{ ...transportBtnStyle(true), width:34, height:34, background:S.accent, color:'#080808' }}>{isPlaying?'⏸':'▶'}</button>
      <button onClick={playNext} aria-label="Next" style={transportBtnStyle(currentIdx < queue.length - 1)}>⏭</button>
    </div>
  );
  const scrubber = (
    <div style={{ display:'flex', alignItems:'center', gap:8, flex:1, minWidth:0 }}>
      <span style={{ fontSize:10, color:S.muted, fontFamily:'monospace', flexShrink:0 }}>{fmtTime(position)}</span>
      <div onClick={onScrub} onTouchStart={onScrub} style={{ flex:1, height:4, background:S.border, borderRadius:2, cursor:'pointer', position:'relative' }}>
        <div style={{ width:`${progress*100}%`, height:'100%', background:S.accent, borderRadius:2, transition:'width 0.1s' }} />
      </div>
      <span style={{ fontSize:10, color:S.muted, fontFamily:'monospace', flexShrink:0 }}>{fmtTime(duration)}</span>
    </div>
  );
  const coverInfo = (
    <div onClick={()=>currentRelease && onOpenRelease && onOpenRelease(currentRelease)} style={{ display:'flex', alignItems:'center', gap:10, minWidth:0, flex:isMobile?1:'0 1 auto', maxWidth:isMobile?'none':280, cursor:'pointer' }}>
      <div style={{ width:36, height:36, flexShrink:0, background:`linear-gradient(${currentRelease.g||'135deg,#1a1a2e,#16213e'})`, backgroundImage:coverSrc(currentRelease.coverUrl)?`url(${coverSrc(currentRelease.coverUrl)})`:'none', backgroundSize:'cover', backgroundPosition:'center', borderRadius:2 }} />
      <div style={{ minWidth:0, lineHeight:1.3, flex:1 }}>
        <div style={{ fontSize:11, fontWeight:700, color:S.text, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{trackName}</div>
        <div style={{ fontSize:10, color:S.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{currentRelease.artist} — {currentRelease.title}</div>
      </div>
    </div>
  );
  const heart = onWishlistToggle && (
    <button onClick={()=>onWishlistToggle(currentRelease)} aria-label={wished?'Remove from wishlist':'Add to wishlist'} title={wished?'Remove from wishlist':'Add to wishlist'} style={{ background:'transparent', border:`1px solid ${wished?S.accent:S.border}`, color:wished?S.accent:S.muted, borderRadius:2, padding:'5px 7px', cursor:'pointer', display:'flex', alignItems:'center', flexShrink:0 }}>
      <HeartIcon wished={wished} size={12} />
    </button>
  );
  const queueBtn = (
    <button onClick={()=>setQueueOpen(o=>!o)} aria-label="Queue" title="Queue" style={{ background:queueOpen?S.accent:'transparent', border:`1px solid ${queueOpen?S.accent:S.border}`, color:queueOpen?'#080808':S.muted, borderRadius:2, padding:'5px 9px', cursor:'pointer', flexShrink:0, fontSize:11 }}>
      ☰ {queue.length}
    </button>
  );
  const volumeCtrl = (
    <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
      <button onClick={toggleMute} aria-label={muted?'Unmute':'Mute'} style={transportBtnStyle(true)}>{muted||volume===0?'🔇':volume<0.5?'🔉':'🔊'}</button>
      <input type="range" min="0" max="1" step="0.05" value={muted?0:volume} onChange={e=>setVolPct(parseFloat(e.target.value))} style={{ width:60, accentColor:S.accent, cursor:'pointer' }} />
    </div>
  );

  if (isMobile) {
    return (
      <>
        {queueOpen && <QueuePanel onClose={()=>setQueueOpen(false)} onOpenRelease={onOpenRelease} />}
        <div ref={barRef} style={{ position:'fixed', bottom:0, left:0, right:0, background:S.surf, borderTop:`1px solid ${S.border}`, zIndex:900, padding:'8px 12px', display:'flex', flexDirection:'column', gap:6, fontFamily:"'Inter',system-ui,sans-serif" }}>
          {/* Row 1: cover + info on left, heart + queue on right */}
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            {coverInfo}
            {heart}
            {queueBtn}
          </div>
          {/* Row 2: scrubber + transport */}
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            {scrubber}
            {transport}
          </div>
        </div>
      </>
    );
  }

  // Desktop: single row layout (unchanged)
  return (
    <>
      {queueOpen && <QueuePanel onClose={()=>setQueueOpen(false)} onOpenRelease={onOpenRelease} />}
      <div ref={barRef} style={{ position:'fixed', bottom:0, left:0, right:0, background:S.surf, borderTop:`1px solid ${S.border}`, zIndex:900, padding:'10px 14px', display:'flex', alignItems:'center', gap:14, fontFamily:"'Inter',system-ui,sans-serif" }}>
        {transport}
        {scrubber}
        {volumeCtrl}
        {coverInfo}
        {heart}
        {queueBtn}
      </div>
    </>
  );
}

function transportBtnStyle(enabled) {
  return { background:'transparent', border:'none', color: enabled?S.text:S.border, fontSize:13, width:28, height:28, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', cursor:enabled?'pointer':'not-allowed', flexShrink:0 };
}

// ── QUEUE PANEL ────────────────────────────────────────────────
function QueuePanel({ onClose, onOpenRelease }) {
  const p = usePlayer();
  if (!p) return null;
  const { queue, currentIdx, removeFromQueue, clearQueue, jumpToQueueIdx } = p;

  return (
    <div style={{ position:'fixed', bottom:'var(--player-h, 64px)', right:14, left:'auto', width:340, maxWidth:'calc(100vw - 28px)', maxHeight:'60vh', background:S.surf, border:`1px solid ${S.border}`, borderRadius:4, zIndex:899, display:'flex', flexDirection:'column', boxShadow:'0 8px 24px rgba(0,0,0,0.5)', fontFamily:"'Inter',system-ui,sans-serif" }}>
      <div style={{ padding:'12px 14px', borderBottom:`1px solid ${S.border}`, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ fontSize:10, color:S.muted, letterSpacing:2, textTransform:'uppercase', fontWeight:700 }}>Queue · {queue.length}</div>
        <div style={{ display:'flex', gap:6 }}>
          {queue.length > 0 && <button onClick={clearQueue} style={{ background:'none', border:'none', color:S.muted, fontSize:9, letterSpacing:1.5, textTransform:'uppercase', cursor:'pointer', textDecoration:'underline' }}>Clear</button>}
          <button onClick={onClose} aria-label="Close queue" style={{ background:'none', border:'none', color:S.muted, fontSize:18, cursor:'pointer', padding:0, lineHeight:1 }}>×</button>
        </div>
      </div>
      <div style={{ overflowY:'auto', flex:1 }}>
        {queue.length === 0 && <div style={{ padding:'24px 14px', fontSize:11, color:S.muted, textAlign:'center', lineHeight:1.6 }}>Queue is empty.<br/>Tap ▶ on a release to start.</div>}
        {queue.map((item, i) => {
          const r = item.releaseSnap;
          const isCur = i === currentIdx;
          const trackName = (item.name || '').replace(/^\d+_\d+_/, '').replace(/\.(mp3|wav|flac|aac|ogg)$/i, '');
          return (
            <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 14px', borderBottom:`1px solid ${S.border}`, background:isCur?'#141400':'transparent' }}>
              <div onClick={()=>onOpenRelease && onOpenRelease(r)} title="Open release details" style={{ width:32, height:32, flexShrink:0, background:`linear-gradient(${r.g||'135deg,#1a1a2e,#16213e'})`, backgroundImage:coverSrc(r.coverUrl)?`url(${coverSrc(r.coverUrl)})`:'none', backgroundSize:'cover', backgroundPosition:'center', borderRadius:2, cursor:'pointer' }} />
              <div onClick={()=>jumpToQueueIdx && jumpToQueueIdx(i)} title={isCur?'Restart this track':'Play this track'} style={{ minWidth:0, flex:1, lineHeight:1.3, cursor:'pointer' }}>
                <div style={{ fontSize:11, fontWeight:700, color:isCur?S.accent:S.text, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{trackName}</div>
                <div style={{ fontSize:9, color:S.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{r.artist} — {r.title}</div>
              </div>
              <button onClick={()=>removeFromQueue(i)} aria-label="Remove from queue" title="Remove" style={{ background:'transparent', border:'none', color:S.muted, fontSize:14, cursor:'pointer', padding:'2px 6px', flexShrink:0 }}>×</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Small play/queue icon buttons used on cards
function PlayIcon({ size=12, filled=false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled?'currentColor':'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>
  );
}
function PauseIcon({ size=12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
  );
}
function QueuePlusIcon({ size=12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="14" y2="6"/><line x1="3" y1="12" x2="14" y2="12"/><line x1="3" y1="18" x2="9" y2="18"/><line x1="18" y1="9" x2="18" y2="21"/><line x1="12" y1="15" x2="24" y2="15"/></svg>
  );
}

// ── RECORD CARD ────────────────────────────────────────────────
function HeartIcon({ wished, size=14 }) {
  return wished ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={S.accent} stroke={S.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
  );
}

function RecordCard({ r, onOpen, onAdd, isWished, onWishlistToggle }) {
  const [hov, setHov] = useState(false);
  const wished = isWished ? isWished(r) : false;
  const player = usePlayer();
  const hasTracks = (r.tracks || []).length > 0;
  const isCurrentlyPlaying = player ? player.isReleasePlaying(r) : false;
  const isQueued = player ? player.isReleaseQueued(r) : false;
  return (
    <div onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)} style={{ background:S.surf, border:`1px solid ${hov?'#2e2e2e':S.border}`, borderRadius:3, overflow:'hidden', transition:'border 0.15s, transform 0.15s', transform:hov?'translateY(-2px)':'none' }}>
      <div style={{ position:'relative', paddingBottom:'100%', cursor:'pointer' }} onClick={()=>onOpen(r)}>
        <div style={{ position:'absolute', inset:0, background:`linear-gradient(${r.g})`, backgroundImage:coverSrc(r.coverUrl)?`url(${coverSrc(r.coverUrl)})`:'none', backgroundSize:'cover', backgroundPosition:'center' }}>
          <div style={{ position:'absolute', bottom:0, left:0, right:0, padding:'4px 8px', background:'rgba(0,0,0,0.5)', fontFamily:'monospace', fontSize:7, color:'rgba(255,255,255,0.35)', letterSpacing:2 }}>{r.catalog}</div>
          {hov&&<div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.55)', display:'flex', alignItems:'center', justifyContent:'center', backdropFilter:'blur(2px)' }}><span style={{ color:S.text, fontSize:10, letterSpacing:2, fontWeight:700, textTransform:'uppercase' }}>View Details</span></div>}
        </div>
      </div>
      <div style={{ padding:'12px 12px 14px' }}>
        <div style={{ fontSize:9, color:S.muted, letterSpacing:1.5, textTransform:'uppercase', marginBottom:3 }}>{r.label}</div>
        <div style={{ fontSize:13, fontWeight:700, color:S.text, lineHeight:1.3, marginBottom:2 }}>{r.title}</div>
        <div style={{ fontSize:11, color:S.muted, marginBottom:10 }}>{r.artist}</div>
        <div style={{ display:'flex', flexDirection:'column', alignItems:'stretch', justifyContent:'space-between', gap:8 }}>
          <span style={{ fontSize:15, fontWeight:800, color:S.accent }}>€{r.price.toFixed(2)}</span>
          <div style={{ display:'flex', alignItems:'center', gap:4, justifyContent:'flex-end' }}>
            {onWishlistToggle && (
              <button
                onClick={e=>{e.stopPropagation();onWishlistToggle(r);}}
                aria-label={wished?'Remove from wishlist':'Add to wishlist'}
                title={wished?'Remove from wishlist':'Add to wishlist'}
                style={{ background:'transparent', border:`1px solid ${wished?S.accent:S.border}`, color:wished?S.accent:S.muted, borderRadius:2, padding:'5px 7px', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', transition:'all 0.15s' }}>
                <HeartIcon wished={wished} size={12} />
              </button>
            )}
            {hasTracks && player && (
              <button
                onClick={e=>{e.stopPropagation(); isCurrentlyPlaying ? player.togglePlayPause() : player.playRelease(r);}}
                aria-label={isCurrentlyPlaying?'Pause':'Play preview'}
                title={isCurrentlyPlaying?'Pause':'Play preview'}
                style={{ background:'transparent', border:`1px solid ${isCurrentlyPlaying?S.accent:S.border}`, color:isCurrentlyPlaying?S.accent:S.muted, borderRadius:2, padding:'5px 7px', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', transition:'all 0.15s' }}>
                {isCurrentlyPlaying ? <PauseIcon size={12} /> : <PlayIcon size={12} filled />}
              </button>
            )}
            {hasTracks && player && (
              <button
                onClick={e=>{e.stopPropagation(); player.addToQueue(r);}}
                aria-label="Add to queue"
                title={isQueued?'Already in queue — add again':'Add to queue'}
                style={{ background:'transparent', border:`1px solid ${isQueued?S.accent:S.border}`, color:isQueued?S.accent:S.muted, borderRadius:2, padding:'5px 7px', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', transition:'all 0.15s' }}>
                <QueuePlusIcon size={12} />
              </button>
            )}
            {(() => {
              // PRE-ORDER takes precedence over everything: a forthcoming
              // release is purchasable now (paid checkout, oversell enabled),
              // so it gets a "+ Pre-order" add-to-cart button just like an
              // in-stock record. The full-width REQUEST button below is for
              // backorders only and is suppressed for forthcoming (see below).
              if (isForthcoming(r)) {
                return <button onClick={e=>{e.stopPropagation();onAdd(r);}} title="Pre-order — pay now, ships when it arrives" style={{ background:hov?S.accent:S.border, color:hov?'#080808':S.muted, border:'none', borderRadius:2, cursor:'pointer', fontSize:9, fontWeight:700, letterSpacing:1.5, padding:'5px 10px', textTransform:'uppercase', transition:'all 0.15s', whiteSpace:'nowrap' }}>+ Pre-order</button>;
              }
              const eligible = isBackorderEligible(r);
              // For backorder-eligible cards, the action goes on its own line below
              // (full-width REQUEST button), so this slot stays empty.
              if (r.stock === 0 && eligible) return null;
              if (r.stock > 0) {
                return <button onClick={e=>{e.stopPropagation();onAdd(r);}} style={{ background:hov?S.accent:S.border, color:hov?'#080808':S.muted, border:'none', borderRadius:2, cursor:'pointer', fontSize:9, fontWeight:700, letterSpacing:1.5, padding:'5px 10px', textTransform:'uppercase', transition:'all 0.15s', whiteSpace:'nowrap' }}>+ Cart</button>;
              }
              return <button disabled style={{ background:S.border, color:S.muted, border:'none', borderRadius:2, cursor:'not-allowed', fontSize:9, fontWeight:700, letterSpacing:1.5, padding:'5px 10px', textTransform:'uppercase', opacity:0.4, whiteSpace:'nowrap' }}>Sold Out</button>;
            })()}
          </div>
        </div>
        {r.stock>0&&r.stock<=3&&!isForthcoming(r)&&<div style={{ fontSize:8, color:'#ff8800', marginTop:5, letterSpacing:1, textTransform:'uppercase' }}>Only {r.stock} left</div>}
        {isForthcoming(r) && (
          <div style={{ fontSize:8, color:S.accent, marginTop:5, letterSpacing:1, textTransform:'uppercase', fontWeight:700 }}>{formatExpected(addDays(r.releaseDate, 14))}</div>
        )}
        {!isForthcoming(r) && r.stock===0 && isBackorderEligible(r) && (
          <button onClick={e=>{e.stopPropagation();onOpen(r);}} title="Request this release — we'll confirm availability" style={{ marginTop:8, width:'100%', background:hov?S.accent:'transparent', color:hov?'#080808':S.accent, border:`1px solid ${S.accent}`, borderRadius:2, cursor:'pointer', fontSize:9, fontWeight:700, letterSpacing:1.5, padding:'7px 10px', textTransform:'uppercase', transition:'all 0.15s', whiteSpace:'nowrap', fontFamily:'inherit' }}>Request</button>
        )}
        {!isForthcoming(r) && r.stock===0 && !isBackorderEligible(r) && <div style={{ fontSize:8, color:S.danger, marginTop:5, letterSpacing:1, textTransform:'uppercase' }}>Out of stock</div>}
      </div>
    </div>
  );
}

// ── FORTHCOMING ROW ────────────────────────────────────────────
// The default list-layout for the Forthcoming section. Structured like a
// distributor release list (cover left, artist/title + capped description in
// the middle, metadata block right) but in the store's own dark/accent theme.
// Shows the fields that exist on the record today: Label · Cat-No · Expected
// date · Genre · Price. Barcode/Configuration are deferred until the importer
// populates them. Description is the same `desc` shown elsewhere, capped to ~2
// lines (full text on click → modal). Pre-order button reuses the paid
// add-to-cart flow (oversell-enabled), identical to the card's + Pre-order.
function ForthcomingRow({ r, onOpen, onAdd, isWished, onWishlistToggle }) {
  const isMobile = useIsMobile(640);
  const player = usePlayer();
  const wished = isWished?.(r);
  const cover = coverSrc(r.coverUrl);
  const expected = formatExpected(addDays(r.releaseDate, 14));
  const hasTracks = (r.tracks || []).length > 0;
  const isCurrentlyPlaying = player ? player.isReleasePlaying(r) : false;
  const isQueued = player ? player.isReleaseQueued(r) : false;
  const metaRow = (k, v) => v ? (
    <div style={{ display:'flex', gap:8, fontSize:11, lineHeight:1.5, minWidth:0 }}>
      <span style={{ color:S.muted, minWidth:74, flexShrink:0, textTransform:'uppercase', letterSpacing:0.5, fontSize:9, paddingTop:1 }}>{k}</span>
      <span style={{ color:S.text, minWidth:0, wordBreak:'break-word' }}>{v}</span>
    </div>
  ) : null;
  const iconBtn = (active) => ({ background:'transparent', border:`1px solid ${active?S.accent:S.border}`, color:active?S.accent:S.muted, borderRadius:2, padding:'7px 9px', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', transition:'all 0.15s' });
  return (
    <div style={{ display:'flex', flexDirection:isMobile?'column':'row', gap:isMobile?12:18, padding:'18px 0', borderBottom:`1px solid ${S.border}`, alignItems:'flex-start', width:'100%', boxSizing:'border-box', minWidth:0 }}>
      {/* Cover */}
      <div onClick={()=>onOpen(r)} style={{ width:isMobile?'100%':120, height:isMobile?200:120, flexShrink:0, background:`linear-gradient(${r.g})`, borderRadius:2, cursor:'pointer', overflow:'hidden', position:'relative' }}>
        {cover && <img src={cover} alt="" style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} />}
      </div>

      {/* Middle: artist / title / capped description — left aligned */}
      <div onClick={()=>onOpen(r)} style={{ flex:1, minWidth:0, cursor:'pointer', textAlign:'left' }}>
        <div style={{ fontSize:15, fontWeight:800, color:S.text, lineHeight:1.2 }}>{r.artist}</div>
        <div style={{ fontSize:13, color:S.muted, marginTop:2, marginBottom:8 }}>{r.title}</div>
        {r.desc && (
          <p style={{ fontSize:11, color:S.muted, lineHeight:1.6, margin:0, display:'-webkit-box', WebkitLineClamp:4, WebkitBoxOrient:'vertical', overflow:'hidden', width:'100%', maxWidth:620 }}>{r.desc}</p>
        )}
        {/* Play / queue — same functionality as the grid card; only shown when the release has audio */}
        {hasTracks && player && (
          <div style={{ display:'flex', gap:6, marginTop:12 }}>
            <button onClick={e=>{e.stopPropagation(); isCurrentlyPlaying ? player.togglePlayPause() : player.playRelease(r);}} aria-label={isCurrentlyPlaying?'Pause':'Play preview'} title={isCurrentlyPlaying?'Pause':'Play preview'} style={iconBtn(isCurrentlyPlaying)}>
              {isCurrentlyPlaying ? <PauseIcon size={12} /> : <PlayIcon size={12} filled />}
            </button>
            <button onClick={e=>{e.stopPropagation(); player.addToQueue(r);}} aria-label="Add to queue" title={isQueued?'Already in queue — add again':'Add to queue'} style={iconBtn(isQueued)}>
              <QueuePlusIcon size={12} />
            </button>
          </div>
        )}
      </div>

      {/* Right: metadata at top (left-aligned), price + pre-order flush to the
          right margin below — lines up under the LIST/GRID toggle. */}
      <div style={{ width:isMobile?'100%':240, flexShrink:0, display:'flex', flexDirection:'column', gap:5, textAlign:'left', boxSizing:'border-box', minWidth:0 }}>
        {metaRow('Label', r.label)}
        {metaRow('Cat-No', r.catalog)}
        <div style={{ display:'flex', gap:8, fontSize:11, lineHeight:1.5, minWidth:0 }}>
          <span style={{ color:S.muted, minWidth:74, flexShrink:0, textTransform:'uppercase', letterSpacing:0.5, fontSize:9, paddingTop:1 }}>Expected</span>
          <span style={{ color:S.accent, fontWeight:700, minWidth:0, wordBreak:'break-word' }}>{expected.replace(/^Expected\s/, '')}</span>
        </div>
        {metaRow('Genre', r.genre)}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end', gap:10, marginTop:8 }}>
          <span style={{ fontSize:18, fontWeight:800, color:S.accent }}>€{r.price.toFixed(2)}</span>
        </div>
        <div style={{ display:'flex', gap:8, marginTop:6, alignItems:'center', justifyContent:'flex-end' }}>
          <button onClick={()=>onAdd(r)} title="Pre-order — pay now, ships when it arrives" style={{ flex:1, background:S.accent, color:'#080808', border:'none', borderRadius:2, cursor:'pointer', fontSize:10, fontWeight:800, letterSpacing:1.5, padding:'9px 12px', textTransform:'uppercase', whiteSpace:'nowrap', fontFamily:'inherit' }}>Pre-order</button>
          {onWishlistToggle && (
            <button onClick={()=>onWishlistToggle(r)} aria-label={wished?'Remove from wishlist':'Add to wishlist'} title={wished?'Remove from wishlist':'Add to wishlist'} style={{ background:'transparent', border:`1px solid ${wished?S.accent:S.border}`, color:wished?S.accent:S.muted, borderRadius:2, padding:'8px 10px', cursor:'pointer', display:'flex', alignItems:'center' }}>
              <HeartIcon wished={wished} size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
//
// Renders inside the Modal when a release is backorder-eligible (stock=0 AND
// year >= currentYear-1). Customer fills email + name + shipping address +
// optional note; on submit, calls submitBackorderRequest() which creates a
// Shopify draft order. After submit, replaces the form with an inline
// "request received" confirmation.
//
// Customer is NOT charged at this point. Eduardo confirms availability with
// the distributor in Shopify admin, then sends an invoice from the draft
// order — customer pays online via the Shopify checkout link.
function BackorderRequestForm({ release }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [address1, setAddress1] = useState('');
  const [address2, setAddress2] = useState('');
  const [city, setCity] = useState('');
  const [zip, setZip] = useState('');
  const [country, setCountry] = useState('Spain');
  const [province, setProvince] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [err, setErr] = useState('');

  const onSubmit = async () => {
    setErr('');
    // Basic client-side validation (server validates again)
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setErr('Please enter a valid email address.');
      return;
    }
    if (!name.trim() || !address1.trim() || !city.trim() || !country.trim() || !zip.trim()) {
      setErr('Name, address, city, country and postal code are required.');
      return;
    }
    if (!release?.shopifyVariantId) {
      setErr('Sorry, this release cannot be requested right now.');
      return;
    }
    setSubmitting(true);
    try {
      await submitBackorderRequest({
        variantId: release.shopifyVariantId,
        productHandle: release.slug,
        productTitle: release.title,
        productArtist: release.artist,
        productPrice: release.price,
        email: email.trim(),
        name: name.trim(),
        address1: address1.trim(),
        address2: address2.trim(),
        city: city.trim(),
        province: province.trim(),
        country: country.trim(),
        zip: zip.trim(),
        phone: phone.trim(),
        note: note.trim(),
      });
      setSubmitted(true);
    } catch (e) {
      setErr(e.message || 'Something went wrong. Please try again or contact us.');
    }
    setSubmitting(false);
  };

  if (submitted) {
    return (
      <div style={{ marginTop:20, padding:'18px 16px', background:'#0e1a0e', border:`1px solid ${S.accent}`, borderRadius:3 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
          <div style={{ width:24, height:24, borderRadius:'50%', background:S.accent, color:'#080808', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:900 }}>✓</div>
          <div style={{ fontSize:12, fontWeight:700, color:S.accent, letterSpacing:1, textTransform:'uppercase' }}>Request Received</div>
        </div>
        <p style={{ fontSize:11, color:S.muted, lineHeight:1.7, margin:0 }}>
          Thanks {name.split(/\s+/)[0] || 'for your request'}. We've recorded your request for <strong style={{color:S.text}}>{release.title}</strong>. We'll check availability with our distributor and email you within 24-48 hours. If we can source it, you'll receive a payment link to complete the order. No payment has been taken at this stage.
        </p>
      </div>
    );
  }

  const inputStyle = { background:S.bg, border:`1px solid ${S.border}`, color:S.text, borderRadius:2, padding:'8px 10px', fontSize:12, fontFamily:'inherit', outline:'none', width:'100%', boxSizing:'border-box' };
  const labelStyle = { fontSize:9, color:S.muted, letterSpacing:1.5, textTransform:'uppercase', marginBottom:4, display:'block', fontWeight:700 };

  return (
    <div style={{ marginTop:14 }}>
      <div style={{ fontSize:11, color:S.accent, letterSpacing:1.5, textTransform:'uppercase', fontWeight:700, marginBottom:6 }}>Request this release</div>
      <p style={{ fontSize:11, color:S.muted, lineHeight:1.6, margin:'0 0 14px' }}>
        Out of stock, but recent — we may still be able to source this from our distributor. Submit a request and we'll confirm within 24-48 hours. <strong style={{color:S.text}}>You won't be charged now</strong>; if available, we'll send you a payment link.
      </p>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
        <div style={{ gridColumn:'1 / -1' }}>
          <label style={labelStyle}>Name *</label>
          <input value={name} onChange={e=>setName(e.target.value)} style={inputStyle} placeholder="Full name" />
        </div>
        <div style={{ gridColumn:'1 / -1' }}>
          <label style={labelStyle}>Email *</label>
          <input type="email" value={email} onChange={e=>setEmail(e.target.value)} style={inputStyle} placeholder="you@example.com" />
        </div>
        <div style={{ gridColumn:'1 / -1' }}>
          <label style={labelStyle}>Address Line 1 *</label>
          <input value={address1} onChange={e=>setAddress1(e.target.value)} style={inputStyle} placeholder="Street address" />
        </div>
        <div style={{ gridColumn:'1 / -1' }}>
          <label style={labelStyle}>Address Line 2</label>
          <input value={address2} onChange={e=>setAddress2(e.target.value)} style={inputStyle} placeholder="Apt, suite, etc. (optional)" />
        </div>
        <div>
          <label style={labelStyle}>City *</label>
          <input value={city} onChange={e=>setCity(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Postal Code *</label>
          <input value={zip} onChange={e=>setZip(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>State / Province</label>
          <input value={province} onChange={e=>setProvince(e.target.value)} style={inputStyle} placeholder="(optional)" />
        </div>
        <div>
          <label style={labelStyle}>Country *</label>
          <input value={country} onChange={e=>setCountry(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ gridColumn:'1 / -1' }}>
          <label style={labelStyle}>Phone</label>
          <input type="tel" value={phone} onChange={e=>setPhone(e.target.value)} style={inputStyle} placeholder="(optional, helps with shipping)" />
        </div>
        <div style={{ gridColumn:'1 / -1' }}>
          <label style={labelStyle}>Anything we should know?</label>
          <textarea value={note} onChange={e=>setNote(e.target.value)} rows={2} style={{...inputStyle, resize:'vertical', minHeight:50}} placeholder="(optional — gift, ship together with another order, etc.)" />
        </div>
      </div>
      {err && <div style={{ fontSize:11, color:S.danger, marginTop:10 }}>{err}</div>}
      <div style={{ marginTop:14 }}>
        <button onClick={onSubmit} disabled={submitting} style={{ background:submitting?S.border:S.accent, color:submitting?S.muted:'#080808', border:'none', borderRadius:2, cursor:submitting?'wait':'pointer', fontSize:11, fontWeight:800, letterSpacing:1.5, padding:'10px 22px', textTransform:'uppercase', fontFamily:'inherit', transition:'all 0.15s' }}>
          {submitting ? 'Submitting…' : 'Submit Request'}
        </button>
      </div>
    </div>
  );
}

// ── MODAL ──────────────────────────────────────────────────────
function cleanTrackName(name) {
  return name.replace(/^\d+_\d+_/, '').trim();
}

function TrackPlayer({ tracks, release }) {
  const player = usePlayer();
  if (!tracks || !tracks.length) return null;

  // Determine which track (if any) of THIS release is currently playing in the
  // global player. If the global current item belongs to this release, light up
  // the matching row; otherwise nothing here is "active" even if something
  // unrelated is playing.
  const cur = player?.current;
  const playingThisRelease = cur && release && cur.releaseId === release.id;
  const activeTrackIdx = (playingThisRelease && player.isPlaying) ? cur.trackIdx : null;
  const prog = playingThisRelease ? player.progress * 100 : 0;

  const onClickTrack = (i) => {
    if (!player || !release) return;
    if (playingThisRelease && cur.trackIdx === i) {
      // Toggle pause/resume on the currently-playing track
      player.togglePlayPause();
      return;
    }
    if (playingThisRelease) {
      // Same release already queued — just jump to the clicked track
      // Find the queue index of the clicked track for this release
      // (simpler: this release's tracks were queued contiguously, so cur.trackIdx -> player.currentIdx maps directly)
      const offset = i - cur.trackIdx;
      player.jumpToQueueIdx(player.currentIdx + offset);
      return;
    }
    // Different release (or nothing playing): insert this release into the queue and start at clicked track.
    player.playRelease({ ...release, tracks }, i);
  };

  return (
    <div style={{ marginBottom:14 }}>
      {tracks.map((t, i) => {
        const isActive = activeTrackIdx === i;
        return (
          <div key={i} onClick={() => onClickTrack(i)} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 8px', borderBottom:`1px solid ${S.border}`, cursor:'pointer', background: isActive ? '#141400' : 'transparent', borderRadius:2 }}>
            <div style={{ width:20, height:20, borderRadius:'50%', background: isActive ? S.accent : S.border, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:9, color: isActive ? '#080808' : S.muted }}>
              {isActive ? '⏸' : '▶'}
            </div>
            <span style={{ fontSize:11, color: isActive ? S.accent : S.muted, flex:1 }}>{cleanTrackName(t.name)}</span>
            {isActive && (
              <div style={{ width:60, height:2, background:S.border, borderRadius:1, overflow:'hidden', flexShrink:0 }}>
                <div style={{ width:`${prog}%`, height:'100%', background:S.accent, transition:'width 0.1s' }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Modal({ r, onClose, onAdd, isWished, onWishlistToggle }) {
  if (!r) return null;
  const tracks = r.tracks || [];
  const wished = isWished ? isWished(r) : false;
  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.88)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:20, backdropFilter:'blur(4px)' }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:S.surf, border:`1px solid ${S.border}`, borderRadius:4, maxWidth:680, width:'100%', maxHeight:'90vh', overflow:'auto' }}>
        <div style={{ display:'flex', flexWrap:'wrap' }}>
          <div style={{ width:240, flexShrink:0, position:'relative' }}>
            <div style={{ paddingBottom:'100%', position:'relative', background:`linear-gradient(${r.g})` }}>
              {coverSrc(r.coverUrl) && <img src={coverSrc(r.coverUrl)} alt="" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', display:'block' }} />}
            </div>
          </div>
          <div style={{ flex:1, minWidth:220, padding:'28px 26px 24px' }}>
            <button onClick={onClose} style={{ float:'right', background:'none', border:'none', color:S.muted, cursor:'pointer', fontSize:20 }}>×</button>
            <div style={{ fontSize:9, color:S.muted, letterSpacing:2, textTransform:'uppercase', marginBottom:4 }}>{r.label} · {r.catalog}</div>
            <h2 style={{ margin:'0 0 4px', fontSize:18, fontWeight:800, color:S.text }}>{r.title}</h2>
            <div style={{ fontSize:12, color:S.muted, marginBottom:12 }}>{r.artist}</div>
            <div style={{ display:'flex', gap:6, marginBottom:14, flexWrap:'wrap' }}>
              {[r.genre,r.year].filter(Boolean).map(v=><span key={v} style={{ fontSize:9, fontWeight:700, letterSpacing:1, padding:'2px 8px', borderRadius:2, background:S.border, color:S.muted, textTransform:'uppercase' }}>{v}</span>)}
            </div>
            {/*
              Layout differs for backorder-eligible products. Their action (request form)
              has to be visible without scrolling past the description, so we render:
                price/heart row → form → description → tracks
              For in-stock and truly-OOS products, we keep the original order:
                description → tracks → price/heart/cart row.
            */}
            {!isForthcoming(r) && r.stock === 0 && isBackorderEligible(r) ? (
              <>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                  <span style={{ fontSize:22, fontWeight:800, color:S.accent }}>€{r.price.toFixed(2)}</span>
                  {onWishlistToggle && (
                    <button
                      onClick={()=>onWishlistToggle(r)}
                      aria-label={wished?'Remove from wishlist':'Add to wishlist'}
                      title={wished?'Remove from wishlist':'Add to wishlist'}
                      style={{ background:'transparent', border:`1px solid ${wished?S.accent:S.border}`, color:wished?S.accent:S.muted, borderRadius:2, padding:'8px 11px', cursor:'pointer', display:'flex', alignItems:'center', gap:6, fontSize:10, fontFamily:'inherit', letterSpacing:1.5, textTransform:'uppercase', fontWeight:700, transition:'all 0.15s' }}>
                      <HeartIcon wished={wished} size={13} />
                    </button>
                  )}
                </div>
                <BackorderRequestForm release={r} />
                {r.desc && <p style={{ fontSize:11, color:S.muted, lineHeight:1.75, margin:'20px 0 16px' }}>{r.desc}</p>}
                {tracks.length > 0
                  ? <TrackPlayer tracks={tracks} release={r} />
                  : (r.tracks||[]).length > 0 && (
                    <div style={{ marginBottom:14 }}>
                      {(r.tracks||[]).map((t,i)=>(
                        <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:`1px solid ${S.border}`, fontSize:11, color:S.muted }}>
                          <span>{String.fromCharCode(65+i)}. {t.t}</span>
                          <span style={{ fontFamily:'monospace' }}>{t.d}</span>
                        </div>
                      ))}
                    </div>
                  )
                }
              </>
            ) : (
              <>
                {r.desc && <p style={{ fontSize:11, color:S.muted, lineHeight:1.75, marginBottom:16 }}>{r.desc}</p>}
                {tracks.length > 0
                  ? <TrackPlayer tracks={tracks} release={r} />
                  : (r.tracks||[]).length > 0 && (
                    <div style={{ marginBottom:14 }}>
                      {(r.tracks||[]).map((t,i)=>(
                        <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:`1px solid ${S.border}`, fontSize:11, color:S.muted }}>
                          <span>{String.fromCharCode(65+i)}. {t.t}</span>
                          <span style={{ fontFamily:'monospace' }}>{t.d}</span>
                        </div>
                      ))}
                    </div>
                  )
                }
                <div style={{ marginTop:20, display:'flex', alignItems:'center', gap:10 }}>
                  <span style={{ fontSize:22, fontWeight:800, color:S.accent }}>€{r.price.toFixed(2)}</span>
                  {onWishlistToggle && (
                    <button
                      onClick={()=>onWishlistToggle(r)}
                      aria-label={wished?'Remove from wishlist':'Add to wishlist'}
                      title={wished?'Remove from wishlist':'Add to wishlist'}
                      style={{ background:'transparent', border:`1px solid ${wished?S.accent:S.border}`, color:wished?S.accent:S.muted, borderRadius:2, padding:'8px 11px', cursor:'pointer', display:'flex', alignItems:'center', gap:6, fontSize:10, fontFamily:'inherit', letterSpacing:1.5, textTransform:'uppercase', fontWeight:700, transition:'all 0.15s' }}>
                      <HeartIcon wished={wished} size={13} />
                      <span style={{ display:'none' }}>{wished?'Wished':'Wishlist'}</span>
                    </button>
                  )}
                  {isForthcoming(r)
                    ? (
                      <div style={{ display:'flex', flexDirection:'column', gap:6, flex:1 }}>
                        <Btn ch="Pre-order" onClick={()=>{onAdd(r);onClose();}} full />
                        <span style={{ fontSize:10, color:S.accent, letterSpacing:1, textTransform:'uppercase', fontWeight:700 }}>{formatExpected(addDays(r.releaseDate, 14))}</span>
                        <span style={{ fontSize:9, color:S.muted, lineHeight:1.5 }}>Pay now to reserve your copy. Ships when it arrives — estimated date above.</span>
                      </div>
                    )
                    : r.stock > 0
                    ? <Btn ch="Add to Cart" onClick={()=>{onAdd(r);onClose();}} full />
                    : <Btn ch="Out of Stock" disabled full />
                  }
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── CART ───────────────────────────────────────────────────────
function CartDrawer({ cart, open, onClose, onRemove, onCheckout }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const total = cart.reduce((s,i)=>s+i.price*i.qty,0);
  const count = cart.reduce((s,i)=>s+i.qty,0);
  const handleCheckout = async () => {
    setErr(''); setLoading(true);
    try { await onCheckout(); } catch(e) { setErr(e.message || 'Checkout failed.'); }
    setLoading(false);
  };
  return (
    <>
      {open&&<div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:900 }} />}
      <div style={{ position:'fixed', top:0, right:0, bottom:0, width:340, maxWidth:'100vw', background:S.surf, borderLeft:`1px solid ${S.border}`, zIndex:1000, transform:open?'translateX(0)':'translateX(100%)', transition:'transform 0.25s ease', display:'flex', flexDirection:'column', boxSizing:'border-box' }}>
        <div style={{ padding:'18px 22px', borderBottom:`1px solid ${S.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontWeight:800, fontSize:11, letterSpacing:2, textTransform:'uppercase' }}>Cart ({count})</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:S.muted, cursor:'pointer', fontSize:20 }}>×</button>
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'16px 22px' }}>
          {cart.length===0?<div style={{ textAlign:'center', color:S.muted, fontSize:12, marginTop:60 }}>Your cart is empty</div>:
            cart.map(item=>(
              <div key={item.id} style={{ display:'flex', gap:10, marginBottom:14, paddingBottom:14, borderBottom:`1px solid ${S.border}` }}>
                <div style={{ width:48, height:48, borderRadius:2, background:`linear-gradient(${item.g})`, backgroundImage:coverSrc(item.coverUrl)?`url(${coverSrc(item.coverUrl)})`:'none', backgroundSize:'cover', flexShrink:0 }} />
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:S.text }}>{item.title}</div>
                  <div style={{ fontSize:10, color:S.muted }}>{item.artist}</div>
                  <div style={{ fontSize:11, color:S.accent, marginTop:2 }}>€{item.price.toFixed(2)} × {item.qty}</div>
                </div>
                <button onClick={()=>onRemove(item.id)} style={{ background:'none', border:'none', color:S.muted, cursor:'pointer', fontSize:16, alignSelf:'flex-start' }}>×</button>
              </div>
            ))
          }
        </div>
        {cart.length>0&&(
          <div style={{ padding:'16px 22px', borderTop:`1px solid ${S.border}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:14 }}>
              <span style={{ fontSize:10, color:S.muted, textTransform:'uppercase', letterSpacing:1 }}>Total</span>
              <span style={{ fontSize:20, fontWeight:800, color:S.accent }}>€{total.toFixed(2)}</span>
            </div>
            {err&&<div style={{ fontSize:10, color:S.danger, marginBottom:10, lineHeight:1.5 }}>{err}</div>}
            <Btn ch={loading?'Creating Checkout…':'Checkout via Shopify'} onClick={handleCheckout} disabled={loading} full />
            <div style={{ fontSize:8, color:S.muted, textAlign:'center', marginTop:8, letterSpacing:1.5 }}>CARD · PAYPAL · CRYPTO</div>
          </div>
        )}
      </div>
    </>
  );
}

// ── ACCOUNT DRAWER ─────────────────────────────────────────────
function AccountDrawer({ open, onClose, auth, profile, onSignIn, onLogout }) {
  // Orders panel state
  const [view, setView] = useState('home'); // home | orders
  const [orders, setOrders] = useState(null); // null = not loaded, [] = empty
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersErr, setOrdersErr] = useState('');

  // Reset to home view when drawer closes or auth changes
  useEffect(() => { if (!open) setView('home'); }, [open]);
  useEffect(() => { setOrders(null); setView('home'); }, [auth?.session]);

  const loadOrders = async () => {
    if (!auth?.session) return;
    setOrdersLoading(true); setOrdersErr('');
    try {
      const list = await customerOrders(auth.session);
      setOrders(list);
    } catch (e) {
      setOrdersErr('Could not load orders.');
    } finally {
      setOrdersLoading(false);
    }
  };

  const goToOrders = () => {
    setView('orders');
    if (orders === null) loadOrders();
  };

  // Header text varies by view
  const headerLabel = !auth ? 'Sign In' : (view === 'orders' ? 'My Orders' : 'My Account');

  return (
    <>
      {open && <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:1099, backdropFilter:'blur(2px)' }} />}
      <div style={{ position:'fixed', top:0, right:0, height:'100vh', width:360, maxWidth:'100vw', background:S.surf, borderLeft:`1px solid ${S.border}`, transform:open?'translateX(0)':'translateX(100%)', transition:'transform 0.25s', zIndex:1100, display:'flex', flexDirection:'column' }}>
        <div style={{ padding:'18px 20px', borderBottom:`1px solid ${S.border}`, display:'flex', justifyContent:'space-between', alignItems:'center', gap:10 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            {view === 'orders' && (
              <button onClick={()=>setView('home')} style={{ background:'none', border:'none', color:S.muted, cursor:'pointer', padding:0, fontSize:14, fontFamily:'inherit' }} aria-label="Back">←</button>
            )}
            <span style={{ fontSize:11, color:S.muted, letterSpacing:2, textTransform:'uppercase', fontWeight:700 }}>{headerLabel}</span>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:S.muted, cursor:'pointer', fontSize:22, padding:0, lineHeight:1 }}>×</button>
        </div>

        <div style={{ flex:1, overflow:'auto', padding:'20px' }}>
          {auth && view === 'orders' ? (
            <OrdersView orders={orders} loading={ordersLoading} err={ordersErr} onRefresh={loadOrders} />
          ) : auth ? (
            <div>
              <div style={{ fontSize:14, fontWeight:700, color:S.text, marginBottom:6 }}>{profile?.firstName ? `${profile.firstName} ${profile.lastName||''}`.trim() : (profile?.displayName || 'Welcome')}</div>
              <div style={{ fontSize:11, color:S.muted, marginBottom:24 }}>{profile?.email || ''}</div>
              <button onClick={goToOrders} style={{ display:'block', width:'100%', textAlign:'center', padding:'10px 14px', background:S.bg, border:`1px solid ${S.border}`, borderRadius:2, color:S.text, fontSize:10, letterSpacing:1.5, textTransform:'uppercase', fontWeight:700, cursor:'pointer', fontFamily:'inherit', marginBottom:10 }}>My Orders →</button>
              <button onClick={onLogout} style={{ width:'100%', padding:'10px 14px', background:'transparent', border:`1px solid ${S.border}`, borderRadius:2, color:S.muted, fontSize:10, letterSpacing:1.5, textTransform:'uppercase', fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>Sign Out</button>
            </div>
          ) : (
            <>
              <div style={{ marginBottom:20, paddingBottom:14, borderBottom:`1px solid ${S.border}` }}>
                <div style={{ fontSize:10, color:S.muted, letterSpacing:2, textTransform:'uppercase', fontWeight:700 }}>Sign In</div>
              </div>

              <div style={{ fontSize:11, color:S.muted, lineHeight:1.6, marginBottom:18 }}>
                Sign in to sync your wishlist across devices and view your order history. No password needed — we'll email you a code.
              </div>

              <button onClick={onSignIn} style={{ width:'100%', padding:'12px 14px', background:S.accent, border:'none', borderRadius:2, color:'#080808', fontSize:11, letterSpacing:1.5, textTransform:'uppercase', fontWeight:800, cursor:'pointer', fontFamily:'inherit' }}>
                Sign In / Create Account
              </button>

              <div style={{ marginTop:24, padding:'14px', background:S.bg, border:`1px solid ${S.border}`, borderRadius:2, fontSize:10, color:S.muted, lineHeight:1.6 }}>
                New here? An account is created automatically the first time you sign in or place an order. No separate sign-up needed.
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ── ORDERS VIEW ─────────────────────────────────────────────────
function OrdersView({ orders, loading, err, onRefresh }) {
  const fmtDate = (iso) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
    } catch { return iso; }
  };

  // Status pill color
  const statusStyle = (status) => {
    const s = (status || '').toLowerCase();
    if (s === 'paid' || s === 'fulfilled') return { color: S.accent, label: status };
    if (s === 'pending' || s === 'partially_paid' || s === 'partially_fulfilled') return { color: '#ff8800', label: status };
    if (s === 'refunded' || s === 'voided' || s === 'cancelled') return { color: S.danger, label: status };
    return { color: S.muted, label: status || 'Unfulfilled' };
  };

  if (loading) {
    return <div style={{ textAlign:'center', color:S.muted, fontSize:11, padding:'40px 0' }}>Loading orders…</div>;
  }
  if (err) {
    return (
      <div style={{ textAlign:'center', padding:'24px 0' }}>
        <div style={{ color:S.danger, fontSize:11, marginBottom:14 }}>{err}</div>
        <button onClick={onRefresh} style={{ background:'transparent', border:`1px solid ${S.border}`, color:S.muted, fontSize:10, padding:'8px 14px', borderRadius:2, cursor:'pointer', letterSpacing:1.5, textTransform:'uppercase', fontFamily:'inherit' }}>Try again</button>
      </div>
    );
  }
  if (!orders || orders.length === 0) {
    return (
      <div style={{ textAlign:'center', color:S.muted, fontSize:11, padding:'40px 20px', lineHeight:1.6 }}>
        No orders yet.<br/>When you place an order, it will appear here.
      </div>
    );
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      {orders.map(o => {
        const finStat = statusStyle(o.financialStatus);
        const fulStat = statusStyle(o.fulfillmentStatus);
        return (
          <div key={o.id} style={{ background:S.bg, border:`1px solid ${S.border}`, borderRadius:2, padding:'14px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:8 }}>
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:S.text }}>Order #{o.number}</div>
                <div style={{ fontSize:10, color:S.muted, marginTop:2 }}>{fmtDate(o.date)}</div>
              </div>
              <div style={{ fontSize:12, fontWeight:800, color:S.accent }}>{o.total}</div>
            </div>

            <div style={{ display:'flex', gap:6, marginBottom:10, flexWrap:'wrap' }}>
              {o.financialStatus && <span style={{ fontSize:8, letterSpacing:1.2, textTransform:'uppercase', color:finStat.color, padding:'3px 6px', border:`1px solid ${finStat.color}`, borderRadius:2 }}>{finStat.label}</span>}
              {o.fulfillmentStatus && <span style={{ fontSize:8, letterSpacing:1.2, textTransform:'uppercase', color:fulStat.color, padding:'3px 6px', border:`1px solid ${fulStat.color}`, borderRadius:2 }}>{fulStat.label}</span>}
            </div>

            <div style={{ display:'flex', flexDirection:'column', gap:6, paddingTop:8, borderTop:`1px solid ${S.border}` }}>
              {o.items.map((it, idx) => (
                <div key={idx} style={{ display:'flex', alignItems:'center', gap:8 }}>
                  {it.imageUrl ? (
                    <img src={it.imageUrl} alt="" style={{ width:30, height:30, objectFit:'cover', borderRadius:2, flexShrink:0 }} />
                  ) : (
                    <div style={{ width:30, height:30, background:S.border, borderRadius:2, flexShrink:0 }} />
                  )}
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:11, color:S.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{it.title}</div>
                    {it.variantTitle && it.variantTitle !== 'Default Title' && <div style={{ fontSize:9, color:S.muted }}>{it.variantTitle}</div>}
                  </div>
                  <div style={{ fontSize:10, color:S.muted, flexShrink:0 }}>×{it.quantity}</div>
                </div>
              ))}
            </div>

            {o.statusUrl && (
              <a href={o.statusUrl} target="_blank" rel="noopener" style={{ display:'block', marginTop:10, textAlign:'center', padding:'8px', fontSize:9, color:S.muted, letterSpacing:1.5, textTransform:'uppercase', textDecoration:'none', border:`1px solid ${S.border}`, borderRadius:2 }}>Track order →</a>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── WISHLIST DRAWER ────────────────────────────────────────────
function WishlistDrawer({ items, open, onClose, onRemove, onAddToCart, onAddAllToCart, onOpenItem, isLoggedIn, onSignInClick }) {
  const [bulkAdding, setBulkAdding] = useState(false);
  const handleBulkAdd = async () => {
    if (bulkAdding || !onAddAllToCart) return;
    setBulkAdding(true);
    try { await onAddAllToCart(); } finally { setBulkAdding(false); }
  };
  return (
    <>
      {open && <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:1099, backdropFilter:'blur(2px)' }} />}
      <div style={{ position:'fixed', top:0, right:0, height:'100vh', width:360, maxWidth:'100vw', background:S.surf, borderLeft:`1px solid ${S.border}`, transform:open?'translateX(0)':'translateX(100%)', transition:'transform 0.25s', zIndex:1100, display:'flex', flexDirection:'column' }}>
        <div style={{ padding:'18px 20px', borderBottom:`1px solid ${S.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontSize:11, color:S.muted, letterSpacing:2, textTransform:'uppercase', fontWeight:700 }}>Wishlist {items.length>0 && `(${items.length})`}</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:S.muted, cursor:'pointer', fontSize:22, padding:0, lineHeight:1 }}>×</button>
        </div>

        {items.length > 1 && (
          <div style={{ padding:'10px 20px', borderBottom:`1px solid ${S.border}` }}>
            <button
              onClick={handleBulkAdd}
              disabled={bulkAdding}
              style={{ width:'100%', background:bulkAdding?S.border:S.accent, color:bulkAdding?S.muted:'#080808', border:'none', borderRadius:2, padding:'9px 12px', fontSize:10, fontWeight:700, letterSpacing:1.5, textTransform:'uppercase', cursor:bulkAdding?'wait':'pointer', fontFamily:'inherit', transition:'background 0.15s' }}>
              {bulkAdding ? 'Adding…' : `+ Add all to cart (${items.length})`}
            </button>
          </div>
        )}

        {!isLoggedIn && items.length > 0 && (
          <div style={{ padding:'10px 20px', background:S.bg, borderBottom:`1px solid ${S.border}`, fontSize:10, color:S.muted, lineHeight:1.5 }}>
            <button onClick={onSignInClick} style={{ background:'none', border:'none', color:S.accent, padding:0, cursor:'pointer', fontFamily:'inherit', fontSize:10, textDecoration:'underline' }}>Sign in</button>
            {' '}to sync this wishlist across your devices.
          </div>
        )}

        <div style={{ flex:1, overflow:'auto' }}>
          {items.length === 0 ? (
            <div style={{ padding:'48px 20px', textAlign:'center', color:S.muted, fontSize:11, lineHeight:1.6 }}>
              <div style={{ fontSize:28, marginBottom:10, opacity:0.4 }}>♡</div>
              Your wishlist is empty.<br/>Tap the heart on any record to save it for later.
            </div>
          ) : (
            <div>
              {items.map(it => (
                <div key={it.handle} style={{ display:'flex', gap:12, padding:'14px 20px', borderBottom:`1px solid ${S.border}` }}>
                  <div onClick={()=>onOpenItem(it)} style={{ width:60, height:60, flexShrink:0, background:S.bg, backgroundImage:it.coverUrl?`url(${it.coverUrl})`:'none', backgroundSize:'cover', backgroundPosition:'center', borderRadius:2, cursor:'pointer' }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:9, color:S.muted, letterSpacing:1.5, textTransform:'uppercase', marginBottom:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{it.label}</div>
                    <div onClick={()=>onOpenItem(it)} style={{ fontSize:12, fontWeight:700, color:S.text, marginBottom:2, cursor:'pointer', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{it.title}</div>
                    <div style={{ fontSize:10, color:S.muted, marginBottom:6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{it.artist}</div>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:6 }}>
                      <span style={{ fontSize:12, fontWeight:800, color:S.accent }}>€{it.price}</span>
                      <div style={{ display:'flex', gap:5 }}>
                        <button onClick={()=>onAddToCart(it)} style={{ background:S.accent, color:'#080808', border:'none', borderRadius:2, padding:'4px 9px', fontSize:9, fontWeight:700, letterSpacing:1.5, textTransform:'uppercase', cursor:'pointer', fontFamily:'inherit' }}>+ Cart</button>
                        <button onClick={()=>onRemove(it.handle)} aria-label="Remove from wishlist" title="Remove from wishlist" style={{ background:'transparent', border:`1px solid ${S.border}`, borderRadius:2, padding:'4px 8px', cursor:'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'center', color:S.accent }}>
                          <HeartIcon wished={true} size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}


// ── RESET / ACTIVATE PASSWORD PAGE ──────────────────────────────
// Standalone page rendered when the user lands on:
//   /account/reset/<id>/<token>     (forgot-password flow)
//   /account/activate/<id>/<token>  (new-account activation from invitation email)
// Both flows have the same UI shape — pick a password, auto-login on success —
// and differ only in copy and which mutation we call.
function ResetPasswordPage({ mode, resetUrl, onSuccess, onCancel }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const isActivate = mode === 'activate';
  const copy = isActivate ? {
    label: 'Activate Account',
    heading: 'Set up your account',
    intro: "Choose a password to activate your account. You'll be signed in automatically once it's saved.",
    submit: 'Activate & Sign In',
    expiredErr: 'This activation link has expired or already been used. Please contact support for a new one.',
  } : {
    label: 'Reset Password',
    heading: 'Choose a new password',
    intro: "Enter a new password below. You'll be signed in automatically once it's saved.",
    submit: 'Save Password & Sign In',
    expiredErr: 'This reset link has expired or already been used. Please request a new one.',
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    setErr('');
    if (pw.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    if (pw !== pw2) { setErr('Passwords do not match.'); return; }
    setBusy(true);
    try {
      const tk = isActivate
        ? await customerActivateByUrl(resetUrl, pw)
        : await customerResetByUrl(resetUrl, pw);
      onSuccess(tk);
    } catch (e) {
      const msg = e?.message || 'Something went wrong.';
      if (/expired|invalid/i.test(msg)) {
        setErr(copy.expiredErr);
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = { background:S.bg, border:`1px solid ${S.border}`, color:S.text, borderRadius:2, padding:'11px 14px', fontSize:16, fontFamily:'inherit', outline:'none', width:'100%', boxSizing:'border-box' };

  return (
    <div style={{background:S.bg, minHeight:'100vh', color:S.text, fontFamily:"'Inter',system-ui,sans-serif"}}>
      <Nav onLogo={onCancel}>
        <button onClick={onCancel} style={{background:'none', border:`1px solid ${S.border}`, color:S.muted, cursor:'pointer', fontSize:9, letterSpacing:1.5, textTransform:'uppercase', padding:'5px 12px', borderRadius:2, whiteSpace:'nowrap', fontFamily:'inherit'}}>← Shop</button>
      </Nav>
      <div style={{maxWidth:420, margin:'60px auto', padding:'0 20px'}}>
        <div style={{fontSize:11, color:S.muted, letterSpacing:2, textTransform:'uppercase', fontWeight:700, marginBottom:8}}>{copy.label}</div>
        <h1 style={{fontSize:28, fontWeight:800, color:S.text, margin:'0 0 12px', letterSpacing:-0.5}}>{copy.heading}</h1>
        <p style={{fontSize:13, color:S.muted, lineHeight:1.6, margin:'0 0 28px'}}>{copy.intro}</p>

        <form onSubmit={submit} style={{display:'flex', flexDirection:'column', gap:12}}>
          <input
            type="password"
            required
            autoComplete="new-password"
            placeholder="New password (min 8 characters)"
            value={pw}
            onChange={e=>setPw(e.target.value)}
            style={inputStyle}
          />
          <input
            type="password"
            required
            autoComplete="new-password"
            placeholder="Confirm new password"
            value={pw2}
            onChange={e=>setPw2(e.target.value)}
            style={inputStyle}
          />

          {err && <div style={{fontSize:11, color:S.danger, padding:'4px 0', lineHeight:1.5}}>{err}</div>}

          <button
            type="submit"
            disabled={busy}
            style={{marginTop:6, padding:'14px', background:S.accent, border:'none', borderRadius:2, color:'#080808', fontSize:11, letterSpacing:1.5, textTransform:'uppercase', fontWeight:800, cursor:busy?'wait':'pointer', fontFamily:'inherit', opacity:busy?0.6:1}}
          >
            {busy ? '…' : copy.submit}
          </button>

          <button
            type="button"
            onClick={onCancel}
            style={{background:'none', border:'none', color:S.muted, fontSize:10, cursor:'pointer', textAlign:'center', padding:8, fontFamily:'inherit', textDecoration:'underline'}}
          >
            Cancel and return to shop
          </button>
        </form>
      </div>
    </div>
  );
}


function Filters({ filters, onChange, records, allLabels, allGenres, allYears }) {
  // Prefer the catalog-wide arrays (computed from a separate lightweight Shopify
  // query that fetches every product's tags, regardless of pagination). Fall
  // back to deriving from `records` while that fetch is still in flight, so
  // filters at least show something on first paint.
  const labels = allLabels?.length ? allLabels : [...new Set(records.map(r=>r.label))].filter(Boolean).sort();
  const genres = allGenres?.length ? allGenres : [...new Set(records.map(r=>r.genre))].filter(Boolean).sort();
  const years  = allYears?.length  ? allYears  : [...new Set(records.map(r=>r.year).filter(Boolean))].sort((a,b)=>b-a);
  const pill = (key,val,label) => {
    const active = filters[key]===val;
    return <button key={String(val)} onClick={()=>onChange(key,active?null:val)} style={{ background:active?S.accent:S.border, color:active?'#080808':S.muted, border:'none', borderRadius:20, cursor:'pointer', fontSize:9, fontWeight:active?700:400, letterSpacing:1.5, padding:'6px 14px', textTransform:'uppercase', transition:'all 0.15s', whiteSpace:'nowrap', flexShrink:0 }}>{label||val}</button>;
  };
  const sel = (key, opts, placeholder) => (
    <div style={{ position:'relative', flexShrink:0 }}>
      <select value={filters[key]||''} onChange={e=>onChange(key,e.target.value||null)} style={{ appearance:'none', WebkitAppearance:'none', background:filters[key]?S.accent:S.surf, color:filters[key]?'#080808':S.muted, border:`1px solid ${filters[key]?S.accent:S.border}`, borderRadius:20, cursor:'pointer', fontSize:9, fontWeight:filters[key]?700:400, letterSpacing:1.5, padding:'6px 28px 6px 14px', textTransform:'uppercase', fontFamily:'inherit', outline:'none', minWidth:100 }}>
        <option value="">{placeholder}</option>
        {opts.map(o=><option key={o} value={o}>{o}</option>)}
      </select>
      <span style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', pointerEvents:'none', fontSize:8, color:filters[key]?'#080808':S.muted }}>▼</span>
    </div>
  );
  return (
    <div style={{ marginBottom:24 }}>
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:10 }}>
        {sel('genre', genres, 'All Genres')}{sel('label', labels, 'All Labels')}
        <div style={{ position:'relative', flexShrink:0 }}>
          <select value={filters.sort||'newest'} onChange={e=>onChange('sort',e.target.value)} style={{ appearance:'none', WebkitAppearance:'none', background:S.surf, color:S.muted, border:`1px solid ${S.border}`, borderRadius:20, cursor:'pointer', fontSize:9, fontWeight:400, letterSpacing:1.5, padding:'6px 28px 6px 14px', textTransform:'uppercase', fontFamily:'inherit', outline:'none', minWidth:120 }}>
            <option value="newest">New Arrivals</option>
            {filters.forthcoming && <option value="release-asc">Soonest Release</option>}
            <option value="price-asc">Price: Low → High</option>
            <option value="price-desc">Price: High → Low</option>
          </select>
          <span style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', pointerEvents:'none', fontSize:8, color:S.muted }}>▼</span>
        </div>
      </div>
      <div style={{ display:'flex', gap:6, overflowX:'auto', paddingBottom:4, scrollbarWidth:'none' }}>
        {pill('year',null,'All')}{years.map(y=>pill('year',y,y))}
      </div>
    </div>
  );
}

// ── CLAUDE API ─────────────────────────────────────────────────
function extractJSON(txt) {
  const si = txt.indexOf('[') === -1 ? txt.indexOf('{') : txt.indexOf('{') === -1 ? txt.indexOf('[') : Math.min(txt.indexOf('['), txt.indexOf('{'));
  if (si === -1) throw new Error('No JSON found');
  const open=txt[si], close=open==='['?']':'}';
  let depth=0,inStr=false,esc=false;
  for (let i=si;i<txt.length;i++) {
    const c=txt[i];
    if(esc){esc=false;continue;} if(c==='\\'&&inStr){esc=true;continue;}
    if(c==='"'){inStr=!inStr;continue;} if(inStr) continue;
    if(c===open) depth++; if(c===close){depth--;if(depth===0) return JSON.parse(txt.slice(si,i+1));}
  }
  throw new Error('Malformed JSON');
}

async function claudeJSON(sys, msg, search=false) {
  const body={model:"claude-sonnet-4-20250514",max_tokens:3000,system:sys,messages:[{role:"user",content:msg}]};
  if(search) body.tools=[{type:"web_search_20250305",name:"web_search"}];
  const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  const d=await r.json(); if(d.error) throw new Error(d.error.message);
  return extractJSON((d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join(''));
}

const SCHEMA=`{"title":"","artist":"","label":"","genre":"","year":0,"price":18.99,"catalog":"","tracks":[{"t":"","d":""}],"desc":"","coverUrl":"","audioUrl":""}`;
const GLIST='Deep House, Tech House, Afro House, Chicago House, Soulful House, Acid House, Detroit House, Disco House';

// ── DESCRIPTION BUILDERS (shared by all importers) ─────────────
// Customer-first: every product gets a consistent, well-formatted, SEO-friendly
// description. Source notes (from W&S salespapers, Kudos API, DBH CSV) are
// included only when they pass quality checks. No "Pfei ff er" disasters.

function decodeHtmlEntities(s) {
  if (!s) return '';
  let out = String(s);
  // Multi-pass for double-encoding (e.g. &amp;amp; → &amp; → &)
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&euro;/g, '€').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
      .replace(/&hellip;/g, '…').replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
      .replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"').replace(/&bdquo;/g, '„');
  }
  return out;
}

// Cleans source notes from PDFs/APIs. Aggressive: prioritises customer-facing
// prose. Strips B2B junk, metadata blocks, distributor footers, embedded
// tracklists, teaser links, copyright/credit lines, and PDF ligature damage.
//
// Philosophy: when we can't be sure something is real prose, drop it. The
// fallback (lead paragraph + tracklist + closing) is always presentable; an
// imperfect description is not.
function cleanSourceNotes(text) {
  if (!text) return '';
  let s = decodeHtmlEntities(text);

  // 1) Strip HTML tags but preserve paragraph breaks
  s = s.replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');

  // 2) Strip well-known footer leakage (W&S salespapers + DBH distributor lines)
  s = s.replace(/\bSicherheits-\s*und\s*Herstellerinformationen[\s\S]*$/i, '');
  s = s.replace(/\bWAS\s*-\s*Word\s+and\s+Sound[\s\S]*$/i, '');
  s = s.replace(/\bWord\s+and\s+Sound[\s\S]*$/i, '');
  s = s.replace(/\bwordandsound\.net[\s\S]*$/i, '');
  s = s.replace(/\b\d+\s+of\s+\d+\s+WAS[\s\S]*$/i, '');
  s = s.replace(/\bWorldwide\s+(?:exclusive\s+)?distributed\s+by[\s\S]*$/i, '');
  s = s.replace(/\bdbh-music\.com[^\s]*/gi, '');
  s = s.replace(/\bsoundcloud\.com\/[^\s]+/gi, '');
  s = s.replace(/\bbandcamp\.com\/[^\s]+/gi, '');
  s = s.replace(/\bbit\.ly\/[^\s]+/gi, '');

  // 3) Strip embedded tracklists ANYWHERE (we render our own from the tracks array)
  // Greedy: starts at "Tracklist:" / "Track list:" / "Tracklisting:" and runs to
  // the next blank line or end of text.
  s = s.replace(/^[ \t]*track\s*list(?:ing)?[^\n]*[:.][\s\S]*?(?=\n\s*\n|$)/gim, '');

  // 4) Strip metadata + credit blocks anywhere.
  // We use a comprehensive list of fields that appear in DBH/W&S/Kudos descriptions.
  // The block detection is greedy: once we enter a meta block, we stay in it
  // through continuation lines until we see a blank or real prose.
  // Separator can be ":", "#", or "." (some labels use period instead of colon).
  const META_FIELDS = new RegExp(
    '^(' + [
      // identification (English + German + caps variants)
      'artists?', 'title', 'titel', 'label', 'labelname',
      'catalogue?\\s*(?:no\\.?|number|nr\\.?)?', 'cat\\.?\\s*no\\.?',
      'cat(?:alog)?', 'release\\s*date', 'rel\\.?\\s*date',
      'format', 'genre', 'style', 'upc', 'barcode',
      // credits
      'distributor', 'distributed', 'press\\s*contact', 'copyright',
      'mastered(?:\\s*by)?', 'remastered(?:\\s*by)?', 'cut\\s*by',
      'artwork(?:\\s*by)?', 'originally\\s*released', 'licensed(?:\\s*from)?',
      'produced(?:\\s*by)?', 'mixed(?:\\s*by)?', 'written(?:\\s*by)?',
      // promo/preview links (with common typos)
      'teaser', 'soundcloud(?:[_\\s-]*teaser)?', 'sc[\\s-]*teaser',
      'shop\\s*teaser', 'bandcamp', 'youtube', 'preview', 'stream',
      'listen', 'buy', 'direct\\s*o[dr]er', 'pre\\s*[- ]?order'
    ].join('|') + ')\\s*[:#.]',
    'i'
  );

  // Also detect lines that start with an UPPERCASE meta field name without a
  // separator at all — e.g. "LABELNAME Pingouin Musique" / "ARTIST Zied Jouini".
  // Used by some labels. We strip the entire line.
  const META_FIELDS_CAPS = /^(?:LABELNAME|ARTISTS?|TITLE|TITEL|LABEL|CATALOGUE(?:\s*NUMBER)?|CATNO|CAT\s*NO|FORMAT|GENRE|RELEASE\s*DATE|TRACKLISTING|UPC|BARCODE|DISTRIBUT(?:OR|ED))\b/;

  // 4b) Strip credit-style lines that are formatted as prose, not "Field: value".
  // Examples: "Distributed by DBH", "Mastered by X", "originally released on Y, 1993.",
  // "cut by Andreas Kauffelt", "artwork by Z". These are not customer-facing.
  s = s.split('\n').filter(line => {
    const t = line.trim();
    if (!t) return true;
    // Match short credit-style lines (under 100 chars, contain typical credit verbs)
    if (t.length < 100 && /^(originally\s+released|distributed\s+by|mastered\s+by|remastered\s+by|cut\s+by|artwork\s+by|produced\s+by|mixed\s+by|written\s+by|licensed\s+from|copyright\s+(?:by\s+|©\s*)?)/i.test(t)) {
      return false;
    }
    // Standalone "Format. 12"" / "Format: 12"" lines (period or colon variant)
    if (t.length < 30 && /^format\s*[:.]\s*\d/i.test(t)) return false;
    // "SC: https://..." preview links (with possibly empty URL)
    if (/^SC\s*:\s*https?:\/\//i.test(t)) return false;
    // Stray "info@..." footer junk
    if (/^info@/i.test(t)) return false;
    // Worldwide-distributed footer (any spelling, including typos like Wporldwide)
    if (/^w[a-z]{0,3}orldwide\s+(?:exclusive\s+)?(?:manufacturing|distribut)/i.test(t)) return false;
    return true;
  }).join('\n');

  // 5) Drop standalone B2B URL lines and apply meta-block stripping in one pass.
  //    Also strip orphaned tracklist line items (A1, A2, B1, B2 etc) that survive
  //    after their "Tracklisting:" header was stripped above.
  const TRACK_LINE = /^[ \t]*[A-Z][12]?[\s.\-–:)]+\S/;          // A1 ... or A. ... or A: ...
  const NUM_TRACK_LINE = /^[ \t]*\d{1,2}[\s.\-–:)]+[A-Z]/;       // "1. Artist - Title"
  {
    const lines = s.split('\n');
    const keep = [];
    let inMetaBlock = false;
    for (const line of lines) {
      const t = line.trim();
      if (!t) {
        if (inMetaBlock) { inMetaBlock = false; continue; }
        keep.push(line);
        continue;
      }
      // Standalone URL line — drop it.
      if (/^https?:\/\/\S+$/i.test(t)) continue;
      // Orphaned tracklist line items
      if (TRACK_LINE.test(t) && t.length < 80) continue;
      if (NUM_TRACK_LINE.test(t) && t.length < 80) continue;
      // Caps-style meta field (e.g. "LABELNAME Pingouin Musique" / "ARTIST Zied Jouini")
      if (META_FIELDS_CAPS.test(t)) { inMetaBlock = true; continue; }
      // Worldwide-distributed footer — match any W-word + exclusive variant + distribution verb.
      // Captures: Worldwide, Worldide, Wporldwide, Wordwide, etc — and with typos
      // in "exclusive" too: excusive, excosive.
      if (/^W[a-z]+\s+(?:exc[a-z]+\s+)?(?:with|by|distribut|manufacturing)/i.test(t)) continue;
      // Standalone "Direct order: ..." / "Direct oder: ..." (with typo)
      if (/^direct\s+o(?:rd|d|r)er[\s:.]/i.test(t)) continue;
      // Standalone "All tracks written/produced/published by ..." credit lines
      if (t.length < 200 && /^(?:all\s+tracks?\s+)?(?:written|produced|composed|published)(?:\s*[&,]\s*\w+)*\s+by\b/i.test(t)) continue;
      // Meta field — start/continue a meta block.
      if (META_FIELDS.test(t)) {
        inMetaBlock = true;
        while (keep.length && !keep[keep.length-1].trim()) keep.pop();
        continue;
      }
      // Continuation of a meta value: short line, no sentence punctuation,
      // while we're still inside a meta block.
      if (inMetaBlock && t.length < 60 && !/[.!?]/.test(t)) continue;
      // Real prose.
      inMetaBlock = false;
      keep.push(line);
    }
    s = keep.join('\n');
  }

  // 6) Safe ligature fixes — only apply where the join is unambiguous:
  // a letter, then space, then a ligature pair, then space, then a lowercase letter.
  // Catches "Pfei ff er" → "Pfeiffer" but doesn't touch "She fi nished"
  // (which would need a dictionary to resolve correctly).
  s = s.replace(/([a-zA-Z])\s+(ff[il]?|fi|fl)\s+([a-z])/g, '$1$2$3');

  // 7) Normalize whitespace, collapse runs of blank lines (intermediate)
  s = s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

  // 8) Final pass: drop paragraph-level junk that survived line-level filtering.
  // A paragraph is junk if it's short and matches credit/footer patterns:
  //   - "Mastering by", "Mixed at", "W+P by", "Vinyl cut by"
  //   - Format declarations: "Format. 12"" / "Format: 12""
  //   - Stray "SC: https://", malformed URLs, "info@"
  //   - "Worldwide ... distributed/manufactured" (any spelling, including typos)
  //   - "Digital only:" lists
  const JUNK_PARA = [
    /\b(?:mastering|mixing|cutting)\s+by\b/i,
    /\bvinyl\s+cut\s+by\b/i,
    /\b(?:additional\s+remix|w\+p|w\/p)\s+by\b/i,
    /\b(?:vocals?|lyrics)\s*\/?\s*(?:lyrics?|vocals?)?\s*by\b/i,
    /\bmastered\s+(?:at|@)\b/i,
    /\bmixed\s+(?:at|@)\b/i,
    /\b(?:w(?:p|porld)?)?worldwide\s+(?:exclusive\s+)?(?:manufacturing|distribut)/i,
    /^\s*format\s*[:.]\s*\d/im,
    /\bSC\s*:\s*https?:\/\//i,
    /\binfo@\b/i,
    /^\s*Digital\s*only\s*:/im,
    /\bLhaudio\.com\b/i,
  ];
  const paragraphs = s.split(/\n{2,}/);
  const kept = paragraphs.filter(p => {
    const t = p.trim();
    if (!t) return false;
    // Short paragraphs that match any junk pattern → drop
    if (t.length < 400 && JUNK_PARA.some(rx => rx.test(t))) return false;
    return true;
  });
  s = kept.join('\n\n').trim();

  return s;
}

// Quality check: should we include the source notes at all?
// We measure damage in the RAW text (before cleaning), because the cleaner
// fixes some patterns and would mask the original damage level.
function notesPassQualityCheck(rawText, cleanedText) {
  if (!cleanedText || cleanedText.length < 50) return false;          // too short = noise
  // Count "obvious break" patterns in the raw text:
  //  - "<letter> fi/fl/ff <letter>"  (Pfei ff er)
  //  - "<letters>fi/fl <space><letter>"  (herfi rst, thefl ipside)
  const raw = String(rawText || '');
  const damageA = (raw.match(/[a-z]\s+(ff[il]?|fi|fl)\s+[a-z]/gi) || []).length;
  const damageB = (raw.match(/[a-z](fi|fl|ff)\s+[a-z]/gi) || []).length;
  const damage = damageA + damageB;
  const wordCount = raw.split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) return false;
  // If more than 2% of words show ligature damage, the cleaning would leave
  // residual artifacts that hurt the customer experience. Better to omit.
  return (damage / wordCount) <= 0.02;
}

// Build the canonical description HTML for a product. Used by all importers
// so every product gets the same clean, SEO-friendly format.
function buildDescriptionHtml({ artist, title, label, year, tracks, sourceNotes }) {
  const parts = [];

  // Lead paragraph: facts in prose, with keywords for SEO.
  const leadBits = [];
  if (artist && title) leadBits.push(`<strong>${title}</strong> by ${artist}`);
  else if (title)      leadBits.push(`<strong>${title}</strong>`);
  if (label)           leadBits.push(`released on ${label}`);
  if (year)            leadBits.push(`(${year})`);
  if (leadBits.length) {
    parts.push(`<p>${leadBits.join(' ')}.</p>`);
  }

  // Source notes — included only if they pass quality checks
  const cleaned = cleanSourceNotes(sourceNotes);
  if (notesPassQualityCheck(sourceNotes, cleaned)) {
    const paragraphs = cleaned.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    parts.push(...paragraphs.map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`));
  }

  // Tracklist — formatted as ordered list when we have it
  if (tracks && tracks.length) {
    const items = tracks.map(t => {
      // Track may be {name, url} (from importer ZIP) or {t, d} (legacy)
      const label = t.name || t.t || '';
      const dur   = t.d ? ` <span style="opacity:.6">(${t.d})</span>` : '';
      return `<li>${label}${dur}</li>`;
    }).join('');
    parts.push(`<p><strong>Tracklist</strong></p><ol>${items}</ol>`);
  }

  // Closing line: format + shipping. Universal across the catalogue.
  parts.push(`<p>12" vinyl. Worldwide shipping from House Only.</p>`);

  return parts.join('');
}


// ── ZIP IMPORTER ───────────────────────────────────────────────
async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => res(window.JSZip);
    s.onerror = () => rej(new Error('Failed to load JSZip'));
    document.head.appendChild(s);
  });
}

async function loadXLSX() {
  if (window.XLSX) return window.XLSX;
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => res(window.XLSX);
    s.onerror = () => rej(new Error('Failed to load XLSX'));
    document.head.appendChild(s);
  });
}

function catnoFromFilename(name) {
  const base = name.replace(/\.zip$/i, '').replace(/\s*\(\d+\)\s*$/, '').trim();
  const m = base.match(/^\d+-(.+)$/);
  return (m ? m[1] : base).toUpperCase().trim();
}

async function loadPDFJS() {
  if (window.pdfjsLib) return window.pdfjsLib;
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      res(window.pdfjsLib);
    };
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

async function extractSalesPaperText(pdfBlob) {
  try {
    const pdfjsLib = await loadPDFJS();
    const arrayBuffer = await pdfBlob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      fullText += content.items.map(i => i.str).join(' ') + '\n';
    }
    // pdf.js flattens the SALESPAPER to a single space-joined string with NO
    // newlines, so a greedy "[^\n\r]+" capture runs PAST the field value into
    // the next fields (e.g. "Genre: House" would capture
    // "House Label: … EAN: … Tracklist: …"). Bound each capture at the next
    // known field marker so we get exactly the field's value. The SALESPAPER
    // DOES contain the real genre ("House", "House / Techno", "Disco" …); the
    // bug was the overrun, not the data. Fixes BOTH importers.
    const FIELD = '(?:Label|EAN|Tracklist|Format|Cat-?No|Release-?Date|Artist|Title|Releasetext|Genre|Style)\\s*:';
    const extractField = (name) => {
      const m = fullText.match(new RegExp(name + '\\s*:\\s*(.+?)\\s*(?:' + FIELD + '|$)', 'i'));
      return m ? m[1].trim() : '';
    };
    const label    = extractField('Label');
    const genreRaw = extractField('(?:Genre|Style)');
    // Preserve the real W&S genre(s). W&S writes multi-genre as "House /
    // Techno" — we keep BOTH so the record shows under each genre filter and
    // the operator sees the full classification. Split on slash/comma/semicolon,
    // title-case each, dedupe, rejoin comma-separated (Shopify treats each
    // comma-separated value as its own tag). Callers feed this into the Tags
    // list which is itself comma-joined, so the genres land as separate tags.
    let genre = '';
    if (genreRaw) {
      const parts = genreRaw.split(/[\/,;|]/)
        .map(s => s.trim().replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
        .filter(Boolean);
      genre = [...new Set(parts)].join(', ');
    }
    const descMatch = fullText.match(/Releasetext:\s*([\s\S]+)/i);
    let desc = '';
    if (descMatch) {
      desc = descMatch[1].trim();
      // Strip GPSR safety block (German "Sicherheits-" intro to manufacturer info)
      desc = desc.replace(/\bSicherheits-\s*und\s*Herstellerinformationen[\s\S]*/i, '').trim();
      // Strip WAS abbreviation (Word and Sound)
      desc = desc.replace(/\bWAS\s*-\s*Word\s+and\s+Sound[\s\S]*/i, '').trim();
      desc = desc.replace(/\bWord\s+and\s+Sound[\s\S]*/i, '').trim();
      desc = desc.replace(/\bwordandsound\.net[\s\S]*/i, '').trim();
      // Strip trailing "WAS -" dangling abbreviation
      desc = desc.replace(/\bWAS\s*-\s*$/i, '').trim();
      // Strip page footer "1 of 1" pattern
      desc = desc.replace(/\b\d+\s+of\s+\d+\s+WAS[\s\S]*/i, '').trim();
      desc = desc.replace(/\s{3,}/g, '\n\n').trim();
    }
    return { desc, label, genre };
  } catch { return { desc: '', label: '', genre: '' }; }
}

function ZipImporter() {
  const [excelFile, setExcelFile] = useState(null);
  const [zipFiles, setZipFiles]   = useState([]);
  const [status, setStatus]       = useState('idle');
  const [progress, setProgress]   = useState({ done:0, total:0, current:'' });
  const [results, setResults]     = useState([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [error, setError]         = useState('');
  const [margin, setMargin]       = useState(60);
  const excelRef = useRef(null);
  const zipRef   = useRef(null);

  const assignFiles = (files) => {
    const xlsxFiles = files.filter(f => /\.xlsx?$/i.test(f.name));
    const zips      = files.filter(f => /\.zip$/i.test(f.name));
    if (xlsxFiles[0]) setExcelFile(xlsxFiles[0]);
    if (zips.length)  setZipFiles(prev => {
      const existing = new Set(prev.map(f => f.name));
      return [...prev, ...zips.filter(f => !existing.has(f.name))];
    });
  };

  const process = async () => {
    if (!excelFile || !zipFiles.length) return;
    setError(''); setStatus('processing'); setResults([]);
    try {
      setProgress({ done:0, total:0, current:'Loading libraries…' });
      const [JSZip, XLSX] = await Promise.all([loadJSZip(), loadXLSX()]);
      setProgress({ done:0, total:0, current:'Parsing Excel…' });
      const buf = await excelFile.arrayBuffer();
      const wb  = XLSX.read(buf);
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval:'' });
      const rowMap = {};
      rows.forEach(r => {
        const catno = String(r.ArtNo || '').toUpperCase().trim();
        if (catno) rowMap[catno] = r;
      });
      const matchedZips = zipFiles.filter(f => rowMap[catnoFromFilename(f.name)]);
      const total = matchedZips.length;
      const processed = [];
      for (let i = 0; i < matchedZips.length; i++) {
        const zipFile = matchedZips[i];
        const catno   = catnoFromFilename(zipFile.name);
        const row     = rowMap[catno];
        const safeKey = catno.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g,'-').replace(/^-|-$/g,'');
        setProgress({ done:i, total, current:`${catno} — extracting…` });
        let coverUrl='', tracks=[], desc='', pdfLabel='', pdfGenre='', itemError='';
        try {
          const zip   = await JSZip.loadAsync(zipFile);
          const files = Object.values(zip.files).filter(f => !f.dir);
          const imgFiles  = files.filter(f => /\.(jpg|jpeg|png)$/i.test(f.name));
          const coverFile = imgFiles.find(f => /front|cover|artwork/i.test(f.name.toLowerCase())) || imgFiles[0];
          const pdfFile = files.find(f => /SALESPAPER\.pdf$/i.test(f.name));
          const audioFiles = files.filter(f => /\.(mp3|wav|flac|aac|ogg)$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
          if (coverFile) {
            setProgress({ done:i, total, current:`${catno} — uploading cover…` });
            const rawBlob = await coverFile.async('blob');
            const ext     = coverFile.name.split('.').pop().toLowerCase();
            // Resize if needed. resizeImageIfNeeded returns the original blob
            // untouched when within bounds, so this is cheap in the common
            // case. If a resize happens, the output is always JPEG.
            const resizedBlob = await resizeImageIfNeeded(rawBlob, 2000, 0.92);
            const wasResized  = resizedBlob !== rawBlob;
            const outExt      = wasResized ? 'jpg' : ext;
            const outMime     = wasResized ? 'image/jpeg' : (ext==='png' ? 'image/png' : 'image/jpeg');
            coverUrl = await uploadToR2(resizedBlob, `covers/${safeKey}.${outExt}`, outMime);
          }
          if (pdfFile) {
            setProgress({ done:i, total, current:`${catno} — reading press text…` });
            const blob = await pdfFile.async('blob');
            const extracted = await extractSalesPaperText(blob);
            desc=extracted.desc; pdfLabel=extracted.label; pdfGenre=extracted.genre;
          }
          for (const af of audioFiles) {
            const filename = af.name.split('/').pop();
            const safeFilename = filename.replace(/[^A-Za-z0-9._-]+/g, '-');
            setProgress({ done:i, total, current:`${catno} — uploading ${filename}…` });
            const blob = await af.async('blob');
            const url  = await uploadToR2(blob, `audio/${safeKey}/${safeFilename}`, 'audio/mpeg');
            // Clean the track name from W&S filename convention:
            //   "1_1_Various Artists - A1. Dez Andres - The World.mp3"
            //   → "A1. Dez Andres - The World"
            //   "1_1_Taron-Trekka - Black Magic.mp3"
            //   → "A1 Black Magic" (we use track number to add side label A1/A2/B1/B2)
            let trackName = filename.replace(/\.[^.]+$/, '');     // strip extension
            // Strip "{disc}_{track}_" prefix
            const prefixMatch = trackName.match(/^(\d+)_(\d+)_(.+)$/);
            let trackIdx = tracks.length + 1;
            if (prefixMatch) {
              trackIdx = parseInt(prefixMatch[2], 10) || trackIdx;
              trackName = prefixMatch[3];
            }
            // Strip "{album_artist} - " prefix to leave just the track info
            // Pattern variants:
            //   "Various Artists - A1. Dez Andres - The World"  → keep all after first " - "
            //   "Taron-Trekka - Black Magic"                    → keep just "Black Magic"
            // Heuristic: if there's "A1." / "B2." style side designator in the rest,
            // it's a VA — keep everything from the artist name onwards.
            // Otherwise it's single-artist — strip the artist prefix.
            const dashIdx = trackName.indexOf(' - ');
            if (dashIdx > -1) {
              const after = trackName.slice(dashIdx + 3);
              if (/^[A-D]\d?\.?\s/.test(after)) {
                // VA format: "Various Artists - A1. Dez Andres - The World" → "A1. Dez Andres - The World"
                trackName = after;
              } else {
                // Single-artist: "Taron-Trekka - Black Magic" → "Black Magic"
                trackName = after;
              }
            }
            // Add side designator if missing (single-artist case).
            // For an N-track record, split evenly: half on A, half on B.
            // (Most W&S vinyl is 4 tracks → A1 A2 B1 B2; some are 6 → A1 A2 A3 B1 B2 B3.)
            if (!/^[A-D]\d?[\s.:)-]/.test(trackName)) {
              const total = audioFiles.length;
              const halfPoint = Math.ceil(total / 2);
              const sideLetter = trackIdx <= halfPoint ? 'A' : 'B';
              const sideNum = trackIdx <= halfPoint ? trackIdx : trackIdx - halfPoint;
              trackName = `${sideLetter}${sideNum} ${trackName}`;
            }
            // W&S sometimes appends duration as " 06:55" or " (06:55)" at end of filename.
            // Strip into a separate field so the tracklist isn't cluttered.
            let duration = '';
            const durMatch = trackName.match(/\s*\(?(\d{1,2}:\d{2})\)?\s*$/);
            if (durMatch) {
              duration = durMatch[1];
              trackName = trackName.slice(0, durMatch.index);
            }
            tracks.push({ name: trackName.trim(), d: duration, url });
          }
        } catch (e) { itemError = e.message; }
        const title  = String(row.Title  || '');
        const artist = String(row.Artist || '');
        const ean    = row.EAN ? String(Math.round(Number(row.EAN))) : '';
        const label  = pdfLabel || String(row.Label || row.label || '');
        const genre  = pdfGenre || 'Deep House';
        const year   = row.Releasedate ? new Date(row.Releasedate).getFullYear() : '';
        const rawPrice = parseFloat(row.UnitPrice || 18.99) * (1 + margin / 100);
        const price  = String((Math.ceil(rawPrice) - 0.01).toFixed(2));
        const is2LP  = /2[\s-]?lp|double\s*lp|3[\s-]?lp/i.test(title) || /2[\s-]?lp|3[\s-]?lp/i.test(catno);
        const grams  = is2LP ? '900' : '500';
        const qty    = String(row.Qty || '1');
        const handle = catno.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
        const descHtml  = buildDescriptionHtml({ artist, title, label, year, tracks, sourceNotes: desc });
        const audioHtml = tracks.length ? `<script type="application/json" id="tracks">${JSON.stringify(tracks)}</script>` : '';
        processed.push({
          _catno: catno, _title: title, _artist: artist, _coverUrl: coverUrl, _tracks: tracks, _error: itemError,
          'Handle': handle, 'Title': title || catno, 'Body (HTML)': `${descHtml}${audioHtml}`, 'Vendor': artist,
          'Product Category': 'Media > Music & Sound Recordings > Vinyl', 'Type': '',
          'Tags': ['vinyl', 'source:ws', label ? `label:${label}` : '', genre, String(year)].filter(Boolean).join(', '),
          'Published': 'TRUE', 'Option1 Name': 'Title', 'Option1 Value': 'Default Title', 'Option1 Linked To': '',
          'Option2 Name': '', 'Option2 Value': '', 'Option2 Linked To': '',
          'Option3 Name': '', 'Option3 Value': '', 'Option3 Linked To': '',
          'Variant SKU': catno, 'Variant Grams': grams, 'Variant Inventory Tracker': 'shopify',
          'Variant Inventory Qty': qty, 'Variant Inventory Policy': 'continue',
          'Variant Fulfillment Service': 'manual', 'Variant Price': price,
          'Variant Compare At Price': '', 'Variant Requires Shipping': 'TRUE', 'Variant Taxable': 'TRUE',
          'Unit Price Total Measure': '', 'Unit Price Total Measure Unit': '',
          'Unit Price Base Measure': '', 'Unit Price Base Measure Unit': '',
          'Variant Barcode': ean, 'Image Src': coverUrl, 'Image Position': coverUrl ? '1' : '',
          'Image Alt Text': coverUrl ? `${title} - ${artist}` : '',
          'Gift Card': 'FALSE', 'SEO Title': '', 'SEO Description': '',
          'Variant Image': '', 'Variant Weight Unit': 'kg', 'Variant Tax Code': '', 'Cost per item': '', 'Status': 'active',
        });
        setProgress({ done:i+1, total, current:'' });
      }
      setResults(processed);
      setSkippedCount(zipFiles.length - matchedZips.length);
      setStatus('review');
    } catch (e) { setError(e.message); setStatus('idle'); }
  };

  const downloadCSV = () => {
    const CSV_KEYS = results.length ? Object.keys(results[0]).filter(k => !k.startsWith('_')) : [];
    const lines = [CSV_KEYS.join(','), ...results.map(row => CSV_KEYS.map(h => `"${String(row[h]||'').replace(/"/g,'""')}"`).join(','))];
    const blob = new Blob([lines.join('\n')], { type:'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'shopify_import_ws.csv'; a.click();
  };

  const pct=progress.total?Math.round((progress.done/progress.total)*100):0;
  const covered=results.filter(r=>r._coverUrl).length;
  const withAudio=results.filter(r=>r._tracks?.length>0).length;
  const errors=results.filter(r=>r._error).length;

  return (
    <div>
      <p style={{ fontSize:10, color:S.muted, margin:'0 0 14px', lineHeight:1.6 }}>Upload your Word & Sound Excel + all ZIP files together. Covers and audio are uploaded to R2 automatically, then download the Shopify CSV.</p>
      <div onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();assignFiles([...e.dataTransfer.files]);}} style={{ border:`2px dashed ${(excelFile||zipFiles.length)?S.accent:S.border}`, borderRadius:3, padding:'20px', textAlign:'center', marginBottom:14, transition:'border 0.15s' }}>
        <div style={{ fontSize:28, marginBottom:6 }}>📦</div>
        <div style={{ fontSize:11, color:(excelFile||zipFiles.length)?S.accent:S.muted, fontWeight:700, letterSpacing:1, textTransform:'uppercase', marginBottom:10 }}>Drag Excel + ZIPs here, or use buttons below</div>
        <div style={{ display:'flex', gap:8, justifyContent:'center' }}>
          <input ref={excelRef} type="file" accept=".xlsx,.xls" style={{ display:'none' }} onChange={e=>e.target.files[0]&&assignFiles([...e.target.files])} />
          <input ref={zipRef}   type="file" accept=".zip" multiple style={{ display:'none' }} onChange={e=>assignFiles([...e.target.files])} />
          <button onClick={()=>excelRef.current.click()} style={{ background:excelFile?S.accent:S.border, border:'none', color:excelFile?'#080808':S.muted, cursor:'pointer', fontSize:9, padding:'6px 14px', borderRadius:2, letterSpacing:1, textTransform:'uppercase', fontFamily:'inherit', fontWeight:700 }}>{excelFile?`✓ ${excelFile.name}`:'+ Excel'}</button>
          <button onClick={()=>zipRef.current.click()} style={{ background:zipFiles.length?S.accent:S.border, border:'none', color:zipFiles.length?'#080808':S.muted, cursor:'pointer', fontSize:9, padding:'6px 14px', borderRadius:2, letterSpacing:1, textTransform:'uppercase', fontFamily:'inherit', fontWeight:700 }}>{zipFiles.length?`✓ ${zipFiles.length} ZIPs`:'+ ZIPs'}</button>
          {zipFiles.length>0&&<button onClick={()=>setZipFiles([])} style={{ background:'none', border:`1px solid ${S.border}`, color:S.muted, cursor:'pointer', fontSize:9, padding:'6px 10px', borderRadius:2, fontFamily:'inherit' }}>Clear</button>}
        </div>
      </div>
      {zipFiles.length>0&&<div style={{ maxHeight:100, overflowY:'auto', marginBottom:12, fontSize:9, color:S.muted, fontFamily:'monospace', display:'flex', flexWrap:'wrap', gap:4 }}>{zipFiles.map((f,i)=><span key={i} style={{ background:S.border, padding:'2px 8px', borderRadius:10, color:S.text }}>{catnoFromFilename(f.name)}</span>)}</div>}
      {status==='idle'&&excelFile&&zipFiles.length>0&&(
        <div style={{marginBottom:10}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
            <span style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',whiteSpace:'nowrap'}}>Margin %</span>
            <input type="number" value={margin} onChange={e=>setMargin(Math.max(0,parseFloat(e.target.value)||0))} min="0" max="500" style={{width:70,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'5px 10px',fontSize:12,fontFamily:'inherit',outline:'none',textAlign:'center'}} />
            <span style={{fontSize:9,color:S.muted}}>→ e.g. €11 × {(1+margin/100).toFixed(2)} = €{(11*(1+margin/100)).toFixed(2)}</span>
          </div>
          <Btn ch={`🚀 Process ${zipFiles.length} Releases → Upload to R2`} onClick={process} full />
        </div>
      )}
      {status==='processing'&&(
        <div style={{ padding:14, background:S.bg, borderRadius:2, border:`1px solid ${S.border}` }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}><span style={{ fontSize:10, color:S.accent, fontWeight:700, letterSpacing:1 }}>PROCESSING…</span><span style={{ fontSize:10, color:S.muted }}>{progress.done} / {progress.total} · {pct}%</span></div>
          <div style={{ height:3, background:S.border, borderRadius:2, overflow:'hidden', marginBottom:8 }}><div style={{ height:'100%', background:S.accent, width:`${pct}%`, transition:'width 0.3s' }} /></div>
          {progress.current&&<div style={{ fontSize:9, color:S.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>→ {progress.current}</div>}
        </div>
      )}
      {error&&<div style={{ marginTop:8, padding:10, background:'#1a0000', border:`1px solid ${S.danger}44`, borderRadius:2, fontSize:10, color:S.danger }}>{error}</div>}
      {status==='review'&&results.length===0&&(
        <div style={{ padding:16, background:'#1a0a00', border:`1px solid #ff8800`, borderRadius:2, fontSize:11, color:'#ff8800', lineHeight:1.6 }}>
          <div style={{fontWeight:700,marginBottom:6}}>⚠ No releases processed</div>
          <div style={{color:S.muted}}>
            None of the {zipFiles.length} ZIP{zipFiles.length!==1?'s':''} matched any catalog number in the Excel invoice.
            Check that the ZIP filename contains a catalog number that appears in the <code>ArtNo</code> column of your Word & Sound xlsx.
          </div>
          <button onClick={()=>{setStatus('idle');setResults([]);}} style={{ marginTop:10, background:'none', border:`1px solid #ff8800`, color:'#ff8800', cursor:'pointer', fontSize:9, letterSpacing:1, textTransform:'uppercase', padding:'5px 12px', borderRadius:2, fontFamily:'inherit' }}>Back</button>
        </div>
      )}
      {status==='review'&&results.length>0&&(
        <div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, flexWrap:'wrap', gap:8 }}>
            <div><span style={{ fontSize:11, color:S.accent, fontWeight:700 }}>✓ {results.length} releases processed</span><span style={{ fontSize:9, color:S.muted, marginLeft:10 }}>{covered} covers · {withAudio} with audio{errors>0?` · ${errors} errors`:''}{ skippedCount>0?` · ${skippedCount} skipped (no Excel match)`:''}</span></div>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:8, maxHeight:500, overflowY:'auto', padding:4 }}>
            {results.map((r,i)=>(
              <div key={i} style={{ background:S.surf, border:`1px solid ${r._error?S.danger:r._coverUrl?S.border:'#ff8800'}`, borderRadius:3, overflow:'hidden' }}>
                <div style={{ position:'relative', paddingBottom:'100%', background:'#1a1a2e' }}>
                  {r._coverUrl?<img src={r._coverUrl} alt="" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} onError={e=>e.target.style.display='none'} />:<div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:24 }}>🎵</div>}
                  {r._error&&<div style={{ position:'absolute', top:4, right:4, background:S.danger, borderRadius:2, fontSize:7, color:'#fff', padding:'2px 5px', fontWeight:700 }}>ERR</div>}
                  {r._tracks?.length>0&&<div style={{ position:'absolute', bottom:4, left:4, background:'rgba(0,0,0,0.75)', borderRadius:2, fontSize:8, color:S.accent, padding:'2px 6px' }}>▶ {r._tracks.length} tracks</div>}
                  {!r._coverUrl&&!r._error&&<div style={{ position:'absolute', top:4, right:4, background:'#ff8800', borderRadius:2, fontSize:7, color:'#080808', padding:'2px 5px', fontWeight:700 }}>NO IMG</div>}
                </div>
                <div style={{ padding:'8px 8px 6px' }}>
                  <div style={{ fontSize:9, color:S.muted, fontFamily:'monospace', marginBottom:2 }}>{r._catno}</div>
                  <div style={{ fontSize:10, fontWeight:700, color:S.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r._title||r._catno}</div>
                  <div style={{ fontSize:9, color:S.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r._artist}</div>
                  {r._error&&<div style={{ fontSize:8, color:S.danger, marginTop:4, lineHeight:1.4 }}>{r._error}</div>}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop:14, display:'flex', justifyContent:'flex-end' }}><Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} /></div>
        </div>
      )}
    </div>
  );
}

// ── TRIPLE VISION IMPORTER (Drum & Bass) ──────────────────────
// ── TRIPLE VISION IMPORTER ─────────────────────────────────────
// Drum & Bass importer (Signature, Fokuz, Soul:R via Triple Vision).
// Mirrors ZipImporter, but its inputs are:
//   • the promopack ZIPs (downloaded from xcdn.triplevision.nl) — named {CATNO}.zip
//     internal files: {CATNO}_{pos}.mp3, {CATNO}_front.jpg, {CATNO}_back.jpg, {CATNO}.jpg, {CATNO}.txt
//   • tv_metadata.json — harvested from release pages (artist/title/format/style/released/desc/promopack)
//   • TV_COSTS — the invoice list price per catno (baked in for invoice 202631612)
// Join key across all three is the SPACE-NORMALIZED catno (invoice "FOKUZ 016.2" == CDN "FOKUZ016.2").
// Reuses shared helpers: loadJSZip, uploadToR2, resizeImageIfNeeded, buildDescriptionHtml, Btn, S.

// ── TRIPLE VISION IMPORTER (Drum & Bass) ──────────────────────
// ── TRIPLE VISION helpers (invoice-PDF-driven; nothing hardcoded per-order) ──

// Space-normalized join key. "FOKUZ 016.2" -> "FOKUZ016.2"; upper-cased.
function tvKey(catno) {
  return String(catno || '').replace(/\s+/g, '').toUpperCase().trim();
}

// Map a TV "label" string to the storefront label tag (real names in dropdown).
function tvLabelTag(label, catno) {
  const l = (label || '').trim();
  if (l) return l;
  const k = tvKey(catno);
  if (k.startsWith('SOULR'))  return 'Soul:R';
  if (k.startsWith('SIG'))    return 'Signature';
  if (k.startsWith('FOKUZ'))  return 'Fokuz';
  return '';
}

// Disc count from TV "Format"/title, then grams = discs * 500.
// Handles "2x12\"", "3x12\"", "4x12\"", "2LP", "double", single 12"/10"/LP.
function tvDiscCount(format, title) {
  const s = `${format || ''} ${title || ''}`.toLowerCase();
  const m = s.match(/(\d+)\s*x?\s*(?:12"|10"|lp)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 6) return n;
  }
  if (/double|2\s*lp/.test(s)) return 2;
  return 1;
}
function tvGrams(format, title) {
  return String(tvDiscCount(format, title) * 500);
}

// Normalize a TV style string for the genre tag.
function tvGenre(style) {
  const s = (style || '').toLowerCase();
  if (/liquid/.test(s)) return 'Liquid Funk';
  if (/drum\s*n?\s*bass|dnb|d&b/.test(s)) return 'Drum n Bass';
  return (style || 'Drum n Bass').trim();
}

// Parse a Triple Vision invoice PDF (text layer) into { key: {catno, qty, cost} }.
// Each item line looks like:
//   "0000183841 BLAKE001RP2 - The F Word EP [black vinyl repress] 2 8,89 IL 8 16,36"
//   10-digit productcode, then cat-no + description, then QTY, PRICE, "IL", pct, total.
// We anchor on the trailing "<qty> <price> IL <pct> <total>" and the leading code.
async function parseTvInvoicePdf(pdfBlob) {
  const pdfjsLib = await loadPDFJS();
  const arrayBuffer = await pdfBlob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Group items into lines by their y-position so the row stays intact.
    const byLine = {};
    for (const it of content.items) {
      const y = Math.round(it.transform[5]);
      (byLine[y] = byLine[y] || []).push(it.str);
    }
    const ys = Object.keys(byLine).map(Number).sort((a, b) => b - a);
    for (const y of ys) text += byLine[y].join(' ').replace(/\s+/g, ' ').trim() + '\n';
  }
  const out = {};
  // In-browser pdfjs lays each item row out as:
  //   {10-digit code} {catno(+spaced)} {TOTAL} IL {QTY} {description} {pct} {PRICE}
  // (Different from the server text layer — price is LAST, total comes early.)
  const lineRe = /^\d{10}\s+(.+?)\s+([\d.,]+)\s+IL\s+(\d+)\s+(.+?)\s+\d+\s+([\d.,]+)$/;
  // cat-no = leading token(s); TV cat-nos can contain a space ("FOKUZ 016.2",
  // "FOKUZLP 003"), a dot (".1"/".2"), a hyphen suffix ("-2024"), or trailing "_".
  const catRe = /^([A-Z0-9]+(?:\.\d+)?(?:LP)?(?:[\s-][0-9][\w.]*)?[A-Z0-9]*_?)/i;
  const eu = (s) => parseFloat(s.replace(/\./g, '').replace(',', '.')); // "8,89" / "1.234,56"
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = lineRe.exec(line);
    if (!m) continue;
    const head = m[1];                 // catno (+ maybe leading desc tokens)
    const qty  = parseInt(m[3], 10);   // QTY
    const cost = eu(m[5]);             // PRICE (per item) — last column
    const cm = catRe.exec(head);
    const catno = (cm ? cm[1] : head.split(/\s+/)[0]).trim();
    const key = tvKey(catno);
    if (key) out[key] = { catno, qty: qty || 1, cost: isNaN(cost) ? null : cost };
  }
  return out;
}

function TripleVisionImporter() {
  const [pdfFile, setPdfFile]     = useState(null);   // invoice PDF (cost + qty)
  const [invoice, setInvoice]     = useState(null);   // parsed { key: {catno,qty,cost} }
  const [metaFile, setMetaFile]   = useState(null);   // tv_metadata.json
  const [metaRecords, setMetaRecords] = useState(null);
  const [zipFiles, setZipFiles]   = useState([]);
  const [status, setStatus]       = useState('idle');
  const [progress, setProgress]   = useState({ done:0, total:0, current:'' });
  const [results, setResults]     = useState([]);
  const [error, setError]         = useState('');
  const [margin, setMargin]       = useState(60);
  const pdfRef  = useRef(null);
  const metaRef = useRef(null);
  const zipRef  = useRef(null);

  const assignFiles = async (files) => {
    const pdfs  = files.filter(f => /\.pdf$/i.test(f.name));
    const jsons = files.filter(f => /\.json$/i.test(f.name));
    const zips  = files.filter(f => /\.zip$/i.test(f.name));
    if (pdfs[0]) {
      setPdfFile(pdfs[0]);
      try { setInvoice(await parseTvInvoicePdf(pdfs[0])); }
      catch (e) { setError('Could not read invoice PDF: ' + e.message); }
    }
    if (jsons[0]) {
      setMetaFile(jsons[0]);
      jsons[0].text().then(t => {
        try { const parsed = JSON.parse(t); setMetaRecords(parsed.records || parsed); }
        catch { setError('tv_metadata.json is not valid JSON'); }
      });
    }
    if (zips.length) setZipFiles(prev => {
      const existing = new Set(prev.map(f => f.name));
      return [...prev, ...zips.filter(f => !existing.has(f.name))];
    });
  };

  const process = async () => {
    if (!invoice || !metaRecords) return;
    setError(''); setStatus('processing'); setResults([]);
    try {
      setProgress({ done:0, total:0, current:'Loading libraries…' });
      const JSZip = await loadJSZip();

      const metaByKey = {};
      metaRecords.forEach(r => { metaByKey[tvKey(r.catno)] = r; });
      const zipByKey = {};
      zipFiles.forEach(f => { zipByKey[tvKey(f.name.replace(/\.zip$/i,'').replace(/\s*\(\d+\)\s*$/,''))] = f; });

      // SPINE = the invoice. Every invoiced record gets a row, ZIP or not.
      const keys = Object.keys(invoice);
      const total = keys.length;
      const processed = [];

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const inv = invoice[key];
        const meta = metaByKey[key] || {};
        const zipFile = zipByKey[key];
        const safeKey = key.replace(/[^A-Za-z0-9_-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
        setProgress({ done:i, total, current:`${key} — processing…` });

        let coverUrl='', tracks=[], itemError='';
        if (zipFile) {
          try {
            const zip   = await JSZip.loadAsync(zipFile);
            const files = Object.values(zip.files).filter(f => !f.dir);
            const imgFiles  = files.filter(f => /\.(jpg|jpeg|png)$/i.test(f.name));
            const coverFile =
                imgFiles.find(f => /_front\.(jpg|jpeg|png)$/i.test(f.name))
             || imgFiles.find(f => /\/?[^\/]*\.(jpg|jpeg|png)$/i.test(f.name) && !/_back/i.test(f.name) && !/_front/i.test(f.name))
             || imgFiles.find(f => /_back\.(jpg|jpeg|png)$/i.test(f.name))
             || imgFiles[0];
            const audioFiles = files
              .filter(f => /\.(mp3|wav|flac|aac|ogg)$/i.test(f.name))
              .sort((a,b) => a.name.localeCompare(b.name));

            if (coverFile) {
              setProgress({ done:i, total, current:`${key} — uploading cover…` });
              const rawBlob = await coverFile.async('blob');
              const ext     = coverFile.name.split('.').pop().toLowerCase();
              const resizedBlob = await resizeImageIfNeeded(rawBlob, 2000, 0.92);
              const wasResized  = resizedBlob !== rawBlob;
              const outExt      = wasResized ? 'jpg' : ext;
              const outMime     = wasResized ? 'image/jpeg' : (ext==='png' ? 'image/png' : 'image/jpeg');
              coverUrl = await uploadToR2(resizedBlob, `covers/${safeKey}.${outExt}`, outMime);
            }
            for (const af of audioFiles) {
              const filename = af.name.split('/').pop();
              const safeFilename = filename.replace(/[^A-Za-z0-9._-]+/g,'-');
              setProgress({ done:i, total, current:`${key} — uploading ${filename}…` });
              const blob = await af.async('blob');
              const url  = await uploadToR2(blob, `audio/${safeKey}/${safeFilename}`, 'audio/mpeg');
              let pos = '';
              const m = filename.replace(/\.[^.]+$/,'').match(/_([A-D]\d?)$/i);
              if (m) pos = m[1].toUpperCase();
              const trackName = pos || filename.replace(/\.[^.]+$/,'');
              tracks.push({ name: trackName, d:'', url });
            }
          } catch (e) { itemError = e.message; }
        }

        const title  = String(meta.title  || inv.catno || key);
        const artist = String(meta.artist || '').trim();
        const label  = tvLabelTag(meta.label, key);
        const genre  = tvGenre(meta.style);
        const year   = (meta.released && (meta.released.match(/\b(19|20)\d{2}\b/)||[])[0]) || '';
        const desc   = String(meta.description || '');
        const grams  = tvGrams(meta.format, title);
        const qty    = String(inv.qty || 1);

        // Pricing from invoice cost: ceil(cost * (1+margin)) - 0.01 → ends .99.
        let price = '', priceFlag = '';
        if (typeof inv.cost === 'number') {
          price = String((Math.ceil(inv.cost * (1 + margin/100)) - 0.01).toFixed(2));
        } else {
          priceFlag = 'NO COST IN INVOICE';
        }

        const handle = key.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+$/,'');
        const descHtml  = buildDescriptionHtml({ artist, title, label, year, tracks, sourceNotes: desc });
        const audioHtml = tracks.length ? `<script type="application/json" id="tracks">${JSON.stringify(tracks)}</script>` : '';
        const tags = ['vinyl','source:tv', label?`label:${label}`:'', genre, 'dnb', String(year)]
          .filter(Boolean).join(', ');

        processed.push({
          _catno: key, _title: title, _artist: artist, _coverUrl: coverUrl, _tracks: tracks,
          _error: itemError, _priceFlag: priceFlag, _noZip: !zipFile,
          'Handle': handle, 'Title': title || key, 'Body (HTML)': `${descHtml}${audioHtml}`, 'Vendor': artist,
          'Product Category': 'Media > Music & Sound Recordings > Vinyl', 'Type': '',
          'Tags': tags,
          'Published': 'TRUE', 'Option1 Name': 'Title', 'Option1 Value': 'Default Title', 'Option1 Linked To': '',
          'Option2 Name': '', 'Option2 Value': '', 'Option2 Linked To': '',
          'Option3 Name': '', 'Option3 Value': '', 'Option3 Linked To': '',
          'Variant SKU': key, 'Variant Grams': grams, 'Variant Inventory Tracker': 'shopify',
          'Variant Inventory Qty': qty, 'Variant Inventory Policy': 'continue',
          'Variant Fulfillment Service': 'manual', 'Variant Price': price,
          'Variant Compare At Price': '', 'Variant Requires Shipping': 'TRUE', 'Variant Taxable': 'TRUE',
          'Unit Price Total Measure': '', 'Unit Price Total Measure Unit': '',
          'Unit Price Base Measure': '', 'Unit Price Base Measure Unit': '',
          'Variant Barcode': '', 'Image Src': coverUrl, 'Image Position': coverUrl ? '1' : '',
          'Image Alt Text': coverUrl ? `${title} - ${artist}` : '',
          'Gift Card': 'FALSE', 'SEO Title': '', 'SEO Description': '',
          'Variant Image': '', 'Variant Weight Unit': 'kg', 'Variant Tax Code': '', 'Cost per item': inv.cost!=null?String(inv.cost):'', 'Status': 'active',
        });
        setProgress({ done:i+1, total, current:'' });
      }

      setResults(processed);
      setStatus('review');
    } catch (e) { setError(e.message); setStatus('idle'); }
  };

  const downloadCSV = () => {
    const CSV_KEYS = results.length ? Object.keys(results[0]).filter(k => !k.startsWith('_')) : [];
    const lines = [CSV_KEYS.join(','), ...results.map(row => CSV_KEYS.map(h => `"${String(row[h]||'').replace(/"/g,'""')}"`).join(','))];
    const blob = new Blob([lines.join('\n')], { type:'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'shopify_import_tv.csv'; a.click();
  };

  const pct=progress.total?Math.round((progress.done/progress.total)*100):0;
  const covered=results.filter(r=>r._coverUrl).length;
  const withAudio=results.filter(r=>r._tracks?.length>0).length;
  const errors=results.filter(r=>r._error).length;
  const noPrice=results.filter(r=>r._priceFlag).length;
  const noZip=results.filter(r=>r._noZip).length;
  const invCount = invoice ? Object.keys(invoice).length : 0;
  const ready = invoice && metaRecords;

  return (
    <div>
      <p style={{ fontSize:10, color:S.muted, margin:'0 0 14px', lineHeight:1.6 }}>
        Drum &amp; Bass import (Signature / Fokuz / Soul:R via Triple Vision). Drop the <strong>invoice PDF</strong> (cost + quantity per record), <strong>tv_metadata.json</strong> (from the release-page harvester), and all promopack ZIPs. The invoice is the spine: every invoiced record gets a row — those with a ZIP get cover + audio, the rest come through cover-less (add art in Shopify). Prices = invoice list price × margin.
      </p>
      <div onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();assignFiles([...e.dataTransfer.files]);}} style={{ border:`2px dashed ${ready?S.accent:S.border}`, borderRadius:3, padding:'20px', textAlign:'center', marginBottom:14, transition:'border 0.15s' }}>
        <div style={{ fontSize:28, marginBottom:6 }}>🥁</div>
        <div style={{ fontSize:11, color:ready?S.accent:S.muted, fontWeight:700, letterSpacing:1, textTransform:'uppercase', marginBottom:10 }}>Drag invoice PDF + tv_metadata.json + ZIPs here</div>
        <div style={{ display:'flex', gap:8, justifyContent:'center', flexWrap:'wrap' }}>
          <input ref={pdfRef}  type="file" accept=".pdf,.PDF" style={{ display:'none' }} onChange={e=>e.target.files[0]&&assignFiles([...e.target.files])} />
          <input ref={metaRef} type="file" accept=".json" style={{ display:'none' }} onChange={e=>e.target.files[0]&&assignFiles([...e.target.files])} />
          <input ref={zipRef}  type="file" accept=".zip" multiple style={{ display:'none' }} onChange={e=>assignFiles([...e.target.files])} />
          <button onClick={()=>pdfRef.current.click()} style={{ background:pdfFile?S.accent:S.border, border:'none', color:pdfFile?'#080808':S.muted, cursor:'pointer', fontSize:9, padding:'6px 14px', borderRadius:2, letterSpacing:1, textTransform:'uppercase', fontFamily:'inherit', fontWeight:700 }}>{pdfFile?`✓ Invoice (${invCount})`:'+ Invoice PDF'}</button>
          <button onClick={()=>metaRef.current.click()} style={{ background:metaFile?S.accent:S.border, border:'none', color:metaFile?'#080808':S.muted, cursor:'pointer', fontSize:9, padding:'6px 14px', borderRadius:2, letterSpacing:1, textTransform:'uppercase', fontFamily:'inherit', fontWeight:700 }}>{metaFile?`✓ Metadata`:'+ Metadata JSON'}</button>
          <button onClick={()=>zipRef.current.click()} style={{ background:zipFiles.length?S.accent:S.border, border:'none', color:zipFiles.length?'#080808':S.muted, cursor:'pointer', fontSize:9, padding:'6px 14px', borderRadius:2, letterSpacing:1, textTransform:'uppercase', fontFamily:'inherit', fontWeight:700 }}>{zipFiles.length?`✓ ${zipFiles.length} ZIPs`:'+ ZIPs'}</button>
          {zipFiles.length>0&&<button onClick={()=>setZipFiles([])} style={{ background:'none', border:`1px solid ${S.border}`, color:S.muted, cursor:'pointer', fontSize:9, padding:'6px 10px', borderRadius:2, fontFamily:'inherit' }}>Clear ZIPs</button>}
        </div>
      </div>
      {invoice&&<div style={{fontSize:9,color:S.muted,marginBottom:4}}>Invoice: {invCount} records parsed (cost + qty)</div>}
      {metaRecords&&<div style={{fontSize:9,color:S.muted,marginBottom:8}}>Metadata: {metaRecords.length} releases · ZIPs: {zipFiles.length} (cover-less: {Math.max(0, invCount - zipFiles.length)})</div>}
      {status==='idle'&&ready&&(
        <div style={{marginBottom:10}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
            <span style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',whiteSpace:'nowrap'}}>Margin %</span>
            <input type="number" value={margin} onChange={e=>setMargin(Math.max(0,parseFloat(e.target.value)||0))} min="0" max="500" style={{width:70,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'5px 10px',fontSize:12,fontFamily:'inherit',outline:'none',textAlign:'center'}} />
            <span style={{fontSize:9,color:S.muted}}>→ e.g. €8.89 × {(1+margin/100).toFixed(2)} → €{(Math.ceil(8.89*(1+margin/100))-0.01).toFixed(2)}</span>
          </div>
          <Btn ch={`🚀 Process ${invCount} Invoiced Records → Upload to R2`} onClick={process} full />
        </div>
      )}
      {status==='processing'&&(
        <div style={{ padding:14, background:S.bg, borderRadius:2, border:`1px solid ${S.border}` }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}><span style={{ fontSize:10, color:S.accent, fontWeight:700, letterSpacing:1 }}>PROCESSING…</span><span style={{ fontSize:10, color:S.muted }}>{progress.done} / {progress.total} · {pct}%</span></div>
          <div style={{ height:3, background:S.border, borderRadius:2, overflow:'hidden', marginBottom:8 }}><div style={{ height:'100%', background:S.accent, width:`${pct}%`, transition:'width 0.3s' }} /></div>
          {progress.current&&<div style={{ fontSize:9, color:S.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>→ {progress.current}</div>}
        </div>
      )}
      {error&&<div style={{ marginTop:8, padding:10, background:'#1a0000', border:`1px solid ${S.danger}44`, borderRadius:2, fontSize:10, color:S.danger }}>{error}</div>}
      {status==='review'&&results.length>0&&(
        <div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, flexWrap:'wrap', gap:8 }}>
            <div><span style={{ fontSize:11, color:S.accent, fontWeight:700 }}>✓ {results.length} records processed</span><span style={{ fontSize:9, color:S.muted, marginLeft:10 }}>{covered} covers · {withAudio} with audio{noZip>0?` · ${noZip} cover-less`:''}{errors>0?` · ${errors} errors`:''}{noPrice>0?` · ${noPrice} no price`:''}</span></div>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:8, maxHeight:500, overflowY:'auto', padding:4 }}>
            {results.map((r,i)=>(
              <div key={i} style={{ background:S.surf, border:`1px solid ${r._error?S.danger:r._coverUrl?S.border:'#ff8800'}`, borderRadius:3, overflow:'hidden' }}>
                <div style={{ position:'relative', paddingBottom:'100%', background:'#1a1a2e' }}>
                  {r._coverUrl?<img src={r._coverUrl} alt="" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} onError={e=>e.target.style.display='none'} />:<div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:24 }}>🥁</div>}
                  {r._error&&<div style={{ position:'absolute', top:4, right:4, background:S.danger, borderRadius:2, fontSize:7, color:'#fff', padding:'2px 5px', fontWeight:700 }}>ERR</div>}
                  {r._priceFlag&&<div style={{ position:'absolute', top:4, left:4, background:S.danger, borderRadius:2, fontSize:7, color:'#fff', padding:'2px 5px', fontWeight:700 }}>NO €</div>}
                  {r._tracks?.length>0&&<div style={{ position:'absolute', bottom:4, left:4, background:'rgba(0,0,0,0.75)', borderRadius:2, fontSize:8, color:S.accent, padding:'2px 6px' }}>▶ {r._tracks.length} tracks</div>}
                  {!r._coverUrl&&!r._error&&<div style={{ position:'absolute', top:4, right:4, background:'#ff8800', borderRadius:2, fontSize:7, color:'#080808', padding:'2px 5px', fontWeight:700 }}>NO IMG</div>}
                </div>
                <div style={{ padding:'8px 8px 6px' }}>
                  <div style={{ fontSize:9, color:S.muted, fontFamily:'monospace', marginBottom:2 }}>{r._catno}</div>
                  <div style={{ fontSize:10, fontWeight:700, color:S.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r._title||r._catno}</div>
                  <div style={{ fontSize:9, color:S.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r._artist}</div>
                  {r._error&&<div style={{ fontSize:8, color:S.danger, marginTop:4, lineHeight:1.4 }}>{r._error}</div>}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop:14, display:'flex', justifyContent:'flex-end' }}><Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} /></div>
        </div>
      )}
    </div>
  );
}

// ── EDIT MODAL ─────────────────────────────────────────────────
const GENRE_OPTS=['Deep House','Tech House','Afro House','Chicago House','Soulful House','Acid House','Detroit House','Disco House'];
function EditModal({ record, onSave, onClose }) {
  const [f,setF]=useState({...record});
  const set=(k,v)=>setF(p=>({...p,[k]:v}));
  const inp=(label,key,type='text',opts=null)=>(
    <div style={{marginBottom:14}}>
      <div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:5}}>{label}</div>
      {opts?<select value={f[key]||''} onChange={e=>set(key,e.target.value)} style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:12,fontFamily:'inherit',outline:'none'}}>{opts.map(o=><option key={o} value={o}>{o}</option>)}</select>
      :type==='textarea'?<textarea value={f[key]||''} onChange={e=>set(key,e.target.value)} rows={3} style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:12,fontFamily:'inherit',outline:'none',resize:'vertical',boxSizing:'border-box'}} />
      :<input type={type} value={f[key]||''} onChange={e=>set(key,type==='number'?parseFloat(e.target.value)||0:e.target.value)} style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}} />}
    </div>
  );
  return (
    <div onClick={onClose} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.88)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:2000,padding:20,backdropFilter:'blur(4px)'}}>
      <div onClick={e=>e.stopPropagation()} style={{background:S.surf,border:`1px solid ${S.border}`,borderRadius:4,width:'100%',maxWidth:580,maxHeight:'90vh',overflow:'auto'}}>
        <div style={{padding:'20px 24px 0',display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
          <div style={{fontSize:11,fontWeight:800,letterSpacing:2,textTransform:'uppercase'}}>Edit Release</div>
          <button onClick={onClose} style={{background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:20}}>×</button>
        </div>
        <div style={{padding:'0 24px 24px'}}>
          <div style={{display:'flex',gap:14,marginBottom:20,alignItems:'flex-start'}}>
            <div style={{width:80,height:80,borderRadius:2,flexShrink:0,background:`linear-gradient(${f.g})`,backgroundImage:coverSrc(f.coverUrl)?`url(${coverSrc(f.coverUrl)})`:'none',backgroundSize:'cover',backgroundPosition:'center'}} />
            <div style={{flex:1}}><div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:5}}>Cover Image URL</div><input value={f.coverUrl||''} onChange={e=>set('coverUrl',e.target.value)} placeholder="https://…" style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:11,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}} /></div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 16px'}}>
            <div>{inp('Title','title')}</div><div>{inp('Artist','artist')}</div>
            <div>{inp('Label','label')}</div><div>{inp('Catalog #','catalog')}</div>
            <div>{inp('Genre','genre','text',GENRE_OPTS)}</div><div>{inp('Year','year','number')}</div>
            <div>{inp('Price (€)','price','number')}</div><div>{inp('Stock','stock','number')}</div>
          </div>
          {inp('Description','desc','textarea')}
          <div style={{marginBottom:20}}><div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:5}}>Audio Snippet URL</div><input value={f.audio||''} onChange={e=>set('audio',e.target.value)} placeholder="https://… .mp3 or .ogg" style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:11,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}} />{f.audio&&<AudioPlayer src={f.audio} />}</div>
          <div style={{marginBottom:20}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}><div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase'}}>Tracklist</div><button onClick={()=>set('tracks',[...(f.tracks||[]),{t:'',d:''}])} style={{background:S.border,border:'none',color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1,textTransform:'uppercase',padding:'3px 10px',borderRadius:2}}>+ Track</button></div>
            {(f.tracks||[]).map((t,i)=>(
              <div key={i} style={{display:'flex',gap:8,marginBottom:6}}>
                <input value={t.t} onChange={e=>set('tracks',f.tracks.map((x,j)=>j===i?{...x,t:e.target.value}:x))} placeholder="Track title" style={{flex:1,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'6px 10px',fontSize:11,fontFamily:'inherit',outline:'none'}} />
                <input value={t.d} onChange={e=>set('tracks',f.tracks.map((x,j)=>j===i?{...x,d:e.target.value}:x))} placeholder="0:00" style={{width:60,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'6px 8px',fontSize:11,fontFamily:'inherit',outline:'none',textAlign:'center'}} />
                <button onClick={()=>set('tracks',f.tracks.filter((_,j)=>j!==i))} style={{background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:14,padding:'0 4px'}}>×</button>
              </div>
            ))}
          </div>
          <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}><Btn ch="Cancel" variant="ghost" onClick={onClose} /><Btn ch="Save Changes" onClick={()=>{onSave(f);onClose();}} /></div>
        </div>
      </div>
    </div>
  );
}

// ── KUDOS IMPORTER ─────────────────────────────────────────────
function KudosImporter() {
  const [pickingRows, setPickingRows] = useState([]);
  const [enrichment, setEnrichment]   = useState({});
  const [pickFile, setPickFile]       = useState(null);
  const [jsonFile, setJsonFile]       = useState(null);
  const [step2Ready, setStep2Ready]   = useState(false);
  const [scriptCopied, setScriptCopied] = useState(false);
  const [fx, setFx]         = useState(1.15);
  const [margin, setMargin] = useState(60);
  const [minRetail, setMinRetail] = useState(9.99);
  const [stdW, setStdW]     = useState(500);
  const [dblW, setDblW]     = useState(900);
  const pickRef = useRef(null);
  const jsonRef = useRef(null);

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows=[]; let cur=[],field='',inQ=false,i=0; const len=text.length;
    while(i<len){const ch=text[i];if(inQ){if(ch==='"'){if(text[i+1]==='"'){field+='"';i+=2;continue;}inQ=false;i++;continue;}field+=ch;i++;continue;}if(ch==='"'){inQ=true;i++;continue;}if(ch===','){cur.push(field);field='';i++;continue;}if(ch==='\r'){i++;continue;}if(ch==='\n'){cur.push(field);rows.push(cur);cur=[];field='';i++;continue;}field+=ch;i++;}
    if(field.length>0||cur.length>0){cur.push(field);rows.push(cur);}
    return rows;
  }

  function decodeHtml(s){if(!s)return'';const t=document.createElement('textarea');t.innerHTML=s;return t.value;}

  function loadPicking(text, filename) {
    const rows = parseCSV(text);
    if (rows.length < 2) return;
    const h = rows[0].map(c=>c.trim().toUpperCase());
    const g = (names) => { for(const n of names){const i=h.indexOf(n);if(i>=0)return i;} return -1; };
    const ci = { sku:g(['SKU']), upc:g(['UPC']), format:g(['FORMAT']), title:g(['DESCRIPTION/TITLE','TITLE']), artist:g(['DESCRIPTION/ARTIST','ARTIST']), requested:g(['REQUESTED']), fulfilled:g(['FULFILLED']) };
    if (ci.sku < 0 || ci.upc < 0) { alert('Missing SKU/UPC columns'); return; }
    const parsed = [];
    for (let r=1;r<rows.length;r++) {
      const row=rows[r]; const sku=(row[ci.sku]||'').trim(); if(!sku) continue;
      parsed.push({ sku, upc:(row[ci.upc]||'').trim(), format:ci.format>=0?(row[ci.format]||'').trim():'', title:ci.title>=0?(row[ci.title]||'').trim():'', artist:ci.artist>=0?(row[ci.artist]||'').trim():'', requested:ci.requested>=0?parseInt(row[ci.requested])||0:1, fulfilled:ci.fulfilled>=0?parseInt(row[ci.fulfilled])||0:1, isBlack:/BLACK/i.test(row[ci.sku]||'') });
    }
    setPickingRows(parsed); setPickFile(filename); setStep2Ready(true);
  }

  function loadEnrichment(text, filename) {
    try { setEnrichment(JSON.parse(text)); setJsonFile(filename); }
    catch(e) { alert('Invalid JSON: '+e.message); }
  }

  function generateScript() {
    const upcs = pickingRows.filter(r=>!r.isBlack&&r.fulfilled>0).map(r=>r.upc).filter(Boolean);
    return `(async()=>{const upcs=${JSON.stringify(upcs)};const results={};let done=0;for(const upc of upcs){done++;console.log(\`[\${done}/\${upcs.length}] \${upc}\`);try{const r=await fetch('/api/kudos_lookup.json?upc='+upc);const d=await r.json();if(d.results&&d.results[0])results[upc]=d.results[0];else console.warn('No result '+upc);}catch(e){console.error(e)}if(done<upcs.length)await new Promise(r=>setTimeout(r,300));}const blob=new Blob([JSON.stringify(results,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='kudos-enrichment.json';document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);console.log('Done! '+Object.keys(results).length+'/'+upcs.length);})();`;
  }

  function copyScript() {
    const script = generateScript();
    navigator.clipboard.writeText(script).then(()=>setScriptCopied(true)).catch(()=>{
      const ta=document.createElement('textarea');ta.value=script;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);setScriptCopied(true);
    });
  }

  function getEnriched(r) {
    const e=enrichment[r.upc]; if(!e) return null;
    const fmt=e.formats?(e.formats[r.sku]||Object.values(e.formats)[0]):null;
    return {api:e,fmt};
  }

  function exportShopify() {
    const m=margin/100;
    const cols=['Handle','Title','Body (HTML)','Vendor','Product Category','Type','Tags','Published','Option1 Name','Option1 Value','Option1 Linked To','Option2 Name','Option2 Value','Option2 Linked To','Option3 Name','Option3 Value','Option3 Linked To','Variant SKU','Variant Grams','Variant Inventory Tracker','Variant Inventory Qty','Variant Inventory Policy','Variant Fulfillment Service','Variant Price','Variant Compare At Price','Variant Requires Shipping','Variant Taxable','Variant Barcode','Image Src','Image Position','Image Alt Text','Gift Card','SEO Title','SEO Description','Variant Image','Variant Weight Unit','Variant Tax Code','Cost per item','Status'];
    const csvRows=[cols];
    pickingRows.filter(r=>!r.isBlack&&r.fulfilled>0).forEach(r=>{
      const en=getEnriched(r); const api=en?en.api:null; const fmt=en?en.fmt:null;
      const artist=api?decodeHtml(api.main_artist):r.artist; const title=api?decodeHtml(api.title):r.title;
      const label=api?decodeHtml(api.label):''; const genre=api?api.genre:''; const subgenre=api?api.subgenre:'';
      const handle=r.sku.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+$/,'');
      const dealerGBP=fmt?parseFloat(fmt.dealer)||0:0; const dealerEUR=dealerGBP>0?dealerGBP*fx:0;
      const rawRetail=dealerEUR>0?dealerEUR*(1+m):0;
      const formatDisplay=fmt?fmt.display:r.format;
      const is2LP=/2[\s-]?(?:x\s*)?lp|double\s*lp|3[\s-]?lp|2xlp/i.test(title)||/2[\s-]?(?:x\s*)?lp|2xlp/i.test(formatDisplay);
      // Floor applies only to single 12" releases. 7" can legitimately retail below the
      // floor; 2LPs have higher dealer prices so the formula already lifts them past it.
      const isTwelveInch = !is2LP && /(?:^|[^0-9])12\s*[″'"]?|12\s*inch|^lp$/i.test(formatDisplay);
      const flooredRetail = rawRetail > 0
        ? (isTwelveInch ? Math.max(rawRetail, minRetail) : rawRetail)
        : 0;
      const retailP = flooredRetail > 0 ? (Math.ceil(flooredRetail) - 0.01).toFixed(2) : '';
      const costEUR=dealerEUR>0?dealerEUR.toFixed(2):'';
      const grams=is2LP?String(dblW):String(stdW);
      let bodyHtml='';
      let audioTracksJson = '';
      if(api){
        // Build tracklist for the helper: include duration in `d` field
        const tracksForHelper = api.tracks
          ? Object.values(api.tracks).sort((a,b)=>a.sequence-b.sequence).map(t=>({
              name: decodeHtml(t.title),
              d: t.duration || ''
            }))
          : [];
        // Build inline audio tracks JSON (separate from description, for the modal player)
        if(api.tracks){
          const audioArr = Object.values(api.tracks)
            .sort((a,b)=>a.sequence-b.sequence)
            .filter(t=>t.audio_clip)
            .map(t=>({ name: decodeHtml(t.title), url: t.audio_clip.replace(/\.ka$/,'.mp3') }));
          if(audioArr.length){
            audioTracksJson = '<script type="application/json" id="tracks">'+JSON.stringify(audioArr)+'<\/script>';
          }
        }
        // Year — try common API fields
        const releaseYear = api.release_date ? new Date(api.release_date).getFullYear()
                          : api.year ? parseInt(api.year)
                          : undefined;
        bodyHtml = buildDescriptionHtml({
          artist, title, label,
          year: releaseYear,
          tracks: tracksForHelper,
          sourceNotes: api.b2c_notes || api.b2b_notes || '',
        }) + audioTracksJson;
      } else {
        bodyHtml = buildDescriptionHtml({ artist, title, label });
      }
      const tags=['vinyl','kudos'];if(label)tags.push('label:'+label);if(subgenre)tags.push(subgenre);if(genre)tags.push(genre);
      const imgUrl=api?(api.img_url||'').replace(/\.ki$/,'.jpg'):'';
      csvRows.push([handle,title+' - '+artist,bodyHtml||'<p></p>',artist,'Media > Music & Sound Recordings > Vinyl','',tags.join(', '),'TRUE','Title','Default Title','','','','','','','',r.sku,grams,'shopify',String(r.fulfilled),'continue','manual',retailP,'','TRUE','TRUE',r.upc,imgUrl,imgUrl?'1':'',imgUrl?title+' - '+artist:'','FALSE','','','','g','',costEUR,'active']);
    });
    const csv=csvRows.map(row=>row.map(cell=>{const s=String(cell==null?'':cell);return s.includes(',')||s.includes('"')||s.includes('\n')?'"'+s.replace(/"/g,'""')+'"':s;}).join(',')).join('\n');
    const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download='shopify-kudos-'+new Date().toISOString().slice(0,10)+'.csv';
    document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
  }

  const importable  = pickingRows.filter(r=>!r.isBlack&&r.fulfilled>0);
  const excluded    = pickingRows.filter(r=>r.isBlack).length;
  const unfulfilled = pickingRows.filter(r=>!r.isBlack&&r.fulfilled<=0).length;
  const enrichedCount = importable.filter(r=>getEnriched(r)).length;

  const baseStep = { borderRadius:6, padding:'18px 14px', textAlign:'center', transition:'all 0.2s', flex:1, minWidth:160 };
  const stepDone = { ...baseStep, border:`2px solid ${S.accent}`, background:'rgba(200,255,0,0.03)', cursor:'pointer' };
  const stepIdle = { ...baseStep, border:`2px dashed ${S.border}`, background:S.bg, cursor:'pointer' };
  const stepOff  = { ...baseStep, border:`2px dashed ${S.border}`, background:S.bg, cursor:'not-allowed', opacity:0.4 };

  return (
    <div>
      <p style={{fontSize:10,color:S.muted,margin:'0 0 16px',lineHeight:1.6}}>
        3-step: upload Kudos picking CSV → run enrichment script on b2b.kudosdistribution.co.uk → upload JSON → export Shopify CSV.
      </p>

      <div style={{display:'flex',gap:10,marginBottom:16,flexWrap:'wrap'}}>
        {/* Step 1 */}
        <div style={pickFile?stepDone:stepIdle} onClick={()=>pickRef.current.click()}>
          <div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:6}}>Step 1</div>
          <div style={{fontSize:22,marginBottom:6}}>📋</div>
          <div style={{fontSize:11,fontWeight:700,color:pickFile?S.accent:S.text,marginBottom:4}}>Picking Summary CSV</div>
          <div style={{fontSize:9,color:S.muted}}>{pickFile||'K######_Picking_Summary.csv'}</div>
          <input ref={pickRef} type="file" accept=".csv" style={{display:'none'}} onChange={e=>{const f=e.target.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>loadPicking(rd.result,f.name);rd.readAsText(f,'UTF-8');e.target.value='';}} />
        </div>

        {/* Step 2 */}
        <div style={scriptCopied?stepDone:(step2Ready?stepIdle:stepOff)}>
          <div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:6}}>Step 2</div>
          <div style={{fontSize:22,marginBottom:6}}>💻</div>
          <div style={{fontSize:11,fontWeight:700,color:S.text,marginBottom:4}}>Run Enrichment Script</div>
          <div style={{fontSize:9,color:S.muted,marginBottom:10}}>Paste in Kudos B2B console</div>
          <button disabled={!step2Ready} onClick={e=>{e.stopPropagation();copyScript();}} style={{background:scriptCopied?S.accent:S.border,border:'none',color:scriptCopied?'#080808':S.muted,cursor:step2Ready?'pointer':'not-allowed',fontSize:9,padding:'6px 14px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
            {scriptCopied?'✓ Copied!':'Copy Script'}
          </button>
        </div>

        {/* Step 3 */}
        <div style={jsonFile?stepDone:(step2Ready?stepIdle:stepOff)} onClick={()=>step2Ready&&jsonRef.current.click()}>
          <div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:6}}>Step 3</div>
          <div style={{fontSize:22,marginBottom:6}}>📤</div>
          <div style={{fontSize:11,fontWeight:700,color:jsonFile?S.accent:S.text,marginBottom:4}}>Upload Enrichment JSON</div>
          <div style={{fontSize:9,color:S.muted}}>{jsonFile||'kudos-enrichment.json'}</div>
          <input ref={jsonRef} type="file" accept=".json" style={{display:'none'}} onChange={e=>{const f=e.target.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>loadEnrichment(rd.result,f.name);rd.readAsText(f,'UTF-8');e.target.value='';}} />
        </div>
      </div>

      {/* Controls */}
      {pickFile && (
        <div style={{display:'flex',gap:14,alignItems:'center',flexWrap:'wrap',padding:'12px 16px',background:S.bg,border:`1px solid ${S.border}`,borderRadius:4,marginBottom:10}}>
          {[['GBP→EUR',fx,setFx,0.01],['Margin %',margin,setMargin,1],['12" floor €',minRetail,setMinRetail,0.5],['Weight g',stdW,setStdW,100],['2LP g',dblW,setDblW,100]].map(([label,val,setter,step])=>(
            <div key={label} style={{display:'flex',alignItems:'center',gap:6}}>
              <span style={{fontSize:10,color:S.muted,whiteSpace:'nowrap'}}>{label}</span>
              <input type="number" value={val} step={step} onChange={e=>setter(parseFloat(e.target.value)||val)} style={{width:72,padding:'5px 8px',background:S.surf,border:`1px solid ${S.border}`,borderRadius:2,color:S.text,fontFamily:'monospace',fontSize:12,textAlign:'center',outline:'none'}} />
            </div>
          ))}
          <div style={{flex:1}} />
          <Btn ch="⬇ Export Shopify CSV" onClick={exportShopify} disabled={importable.length===0} />
        </div>
      )}

      {/* Stats */}
      {pickFile && (
        <div style={{display:'flex',gap:16,flexWrap:'wrap',padding:'8px 14px',background:S.bg,border:`1px solid ${S.border}`,borderRadius:4,marginBottom:12,fontSize:10,fontFamily:'monospace'}}>
          <span>Total: <b style={{color:S.text}}>{pickingRows.length}</b></span>
          <span>Import: <b style={{color:S.accent}}>{importable.length}</b></span>
          <span>2000Black: <b style={{color:S.danger}}>{excluded}</b></span>
          <span>Unfulfilled: <b style={{color:'#ff8800'}}>{unfulfilled}</b></span>
          <span>Enriched: <b style={{color:S.accent}}>{enrichedCount}/{importable.length}</b></span>
        </div>
      )}

      {/* Table */}
      {pickingRows.length > 0 && (
        <div style={{overflowX:'auto',border:`1px solid ${S.border}`,borderRadius:4}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead>
              <tr>{['','SKU','Artist','Title','Label','Fmt','Qty','Dealer €','Retail €','Tracks','Status'].map(h=>(
                <th key={h} style={{textAlign:'left',padding:'8px 10px',fontSize:9,textTransform:'uppercase',letterSpacing:0.5,color:S.muted,borderBottom:`1px solid ${S.border}`,whiteSpace:'nowrap',background:S.surf}}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {pickingRows.map((r,i)=>{
                const en=getEnriched(r); const api=en?en.api:null; const fmt=en?en.fmt:null;
                const artist=api?(api.main_artist||r.artist):r.artist;
                const title=api?(api.title||r.title):r.title;
                const label=api?api.label:'';
                const dealerGBP=fmt?parseFloat(fmt.dealer)||0:0;
                const dealerEUR=dealerGBP>0?(dealerGBP*fx).toFixed(2):'—';
                const rawR=dealerGBP>0?dealerGBP*fx*(1+margin/100):0;
                const retail=rawR>0?'€'+(Math.ceil(rawR)-0.01).toFixed(2):'—';
                const trackCount=api&&api.tracks?Object.keys(api.tracks).length:0;
                const imgUrl=api?(api.img_url||'').replace(/\.ki$/,'.jpg'):'';
                const opacity=r.isBlack||r.fulfilled<=0?0.35:1;
                let statusEl;
                if(r.isBlack) statusEl=<span style={{fontSize:9,padding:'2px 6px',borderRadius:2,background:'#2a1a1a',color:S.danger}}>2000Black</span>;
                else if(r.fulfilled<=0) statusEl=<span style={{fontSize:9,padding:'2px 6px',borderRadius:2,background:'#2a2218',color:'#e8c840'}}>Unfulfilled</span>;
                else if(api) statusEl=<span style={{fontSize:9,padding:'2px 6px',borderRadius:2,background:'#1a2a1e',color:'#3ecf7a'}}>Enriched</span>;
                else statusEl=<span style={{fontSize:9,padding:'2px 6px',borderRadius:2,background:S.border,color:S.muted}}>Pending</span>;
                return (
                  <tr key={i} style={{opacity,borderBottom:`1px solid ${S.border}`}}>
                    <td style={{padding:'4px 8px',width:44}}>
                      {imgUrl?<img src={imgUrl} alt="" style={{width:36,height:36,objectFit:'cover',borderRadius:3,display:'block'}} onError={e=>e.target.style.display='none'} />:<div style={{width:36,height:36,borderRadius:3,background:S.border,display:'flex',alignItems:'center',justifyContent:'center',fontSize:14}}>🎵</div>}
                    </td>
                    <td style={{padding:'4px 10px',fontFamily:'monospace',fontSize:10,color:S.muted}}>{r.sku}</td>
                    <td style={{padding:'4px 10px',maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontWeight:600,color:S.text}}>{artist}</td>
                    <td style={{padding:'4px 10px',maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:S.muted}}>{title}</td>
                    <td style={{padding:'4px 10px',fontSize:10,color:'#e8c840',maxWidth:100,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{label}</td>
                    <td style={{padding:'4px 10px',fontSize:10,color:S.muted}}>{fmt?fmt.display:r.format}</td>
                    <td style={{padding:'4px 10px',fontFamily:'monospace',fontSize:11,color:r.fulfilled>0?'#3ecf7a':S.danger}}>{r.fulfilled}/{r.requested}</td>
                    <td style={{padding:'4px 10px',fontFamily:'monospace',fontSize:11,color:S.muted}}>{dealerEUR!=='—'?'€'+dealerEUR:dealerEUR}</td>
                    <td style={{padding:'4px 10px',fontFamily:'monospace',fontSize:11,color:S.accent}}>{retail}</td>
                    <td style={{padding:'4px 10px',fontSize:10,color:S.muted}}>{trackCount>0?trackCount+' tracks':''}</td>
                    <td style={{padding:'4px 10px'}}>{statusEl}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── DBH IMPORTER ───────────────────────────────────────────────
function DBHImporter() {
  const [csvFile, setCsvFile]   = useState(null);
  const [zipFiles, setZipFiles] = useState([]);
  const [csvRows, setCsvRows]   = useState([]);
  const [status, setStatus]     = useState('idle');
  const [progress, setProgress] = useState({ done:0, total:0, current:'' });
  const [results, setResults]   = useState([]);
  const [error, setError]       = useState('');
  const [margin, setMargin]     = useState(60);
  const csvRef = useRef(null);
  const zipRef = useRef(null);

  function parseDBHCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // Parse CSV with semicolon delimiter, handling quoted multiline fields
    const rows = []; let cur = [], field = '', inQ = false, i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"' && text[i+1] === '"') { field += '"'; i += 2; continue; }
        if (ch === '"') { inQ = false; i++; continue; }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ';') { cur.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    if (field || cur.length) { cur.push(field); rows.push(cur); }
    if (rows.length < 2) return [];
    const headers = rows[0].map(h => h.trim());
    return rows.slice(1).map(vals => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = (vals[i] || '').trim());
      return obj;
    }).filter(r => r['Catalog']);
  }

  function decodeHtml(s) {
    if (!s) return '';
    return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&rsquo;/g,"'").replace(/&lsquo;/g,"'").replace(/&ndash;/g,'–').replace(/&mdash;/g,'—').replace(/&hellip;/g,'…').replace(/&nbsp;/g,' ').replace(/&ldquo;/g,'"').replace(/&rdquo;/g,'"').replace(/&bdquo;/g,'„').replace(/&euro;/g,'€');
  }

  function mapGenre(genreStr) {
    const g = genreStr.toLowerCase();
    if (g.includes('deep house') || g.includes('deep')) return 'Deep House';
    if (g.includes('tech house')) return 'Tech House';
    if (g.includes('afro')) return 'Afro House';
    if (g.includes('chicago')) return 'Chicago House';
    if (g.includes('soulful')) return 'Soulful House';
    if (g.includes('acid')) return 'Acid House';
    if (g.includes('detroit')) return 'Detroit House';
    if (g.includes('disco')) return 'Disco House';
    if (g.includes('house')) return 'Deep House';
    return genreStr || 'Deep House';
  }

  function catnoFromZip(name) {
    return name.replace(/\.zip$/i,'').replace(/\s*\(\d+\)\s*$/,'').trim().toUpperCase();
  }

  const loadCsv = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      const rows = parseDBHCsv(rd.result);
      setCsvRows(rows);
      setCsvFile(file.name);
    };
    rd.readAsText(file, 'UTF-8');
  };

  const assignZips = (files) => {
    const zips = [...files].filter(f => /\.zip$/i.test(f.name));
    setZipFiles(prev => {
      const existing = new Set(prev.map(f=>f.name));
      return [...prev, ...zips.filter(f=>!existing.has(f.name))];
    });
  };

  const process = async () => {
    if (!csvRows.length) return;
    setError(''); setStatus('processing'); setResults([]);

    try {
      const JSZip = await loadJSZip();
      const total = csvRows.length;
      const processed = [];

      // Build zip map by catalog number
      const zipMap = {};
      zipFiles.forEach(f => { zipMap[catnoFromZip(f.name)] = f; });

      for (let i = 0; i < csvRows.length; i++) {
        const row = csvRows[i];
        const qtyShipped = parseInt(row['QTY Shipped'] || 0);
        if (qtyShipped === 0) { setProgress({ done:i+1, total, current:'' }); continue; } // skip presale
        const isPresale = false;
        const catno   = row['Catalog'].toUpperCase().trim();
        const title   = decodeHtml(row['Title'] || '');
        const artist  = decodeHtml(row['Artist'] || '');
        const label   = decodeHtml(row['Label'] || '');
        const genre   = mapGenre(row['Genre'] || '');
        const year    = row['Release Date'] ? new Date(row['Release Date']).getFullYear() : '';
        const ppu     = parseFloat(row['PPU'] || 0);
        const rawPrice = ppu * (1 + margin / 100);
        const price   = (Math.ceil(rawPrice) - 0.01).toFixed(2);
        const qtyOrdered = parseInt(row['QTY Ordered'] || 1);
        const format  = row['Format'] || '';
        const is2LP   = /2\s*x\s*12|double\s*lp|3\s*x\s*12/i.test(format) || /2[\s-]?lp/i.test(title);
        const grams   = is2LP ? '900' : '500';
        const tags    = row['Tags'] || '';
        const desc    = decodeHtml(row['Description'] || '');
        const handle  = catno.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+$/,'');

        setProgress({ done:i, total, current:`${catno} — processing…` });

        let coverUrl = '';
        let tracks   = [];
        let itemError = '';

        // Try to find matching ZIP
        const zipFile = zipMap[catno] || zipFiles.find(f => {
          const zcat = catnoFromZip(f.name);
          return zcat.includes(catno) || catno.includes(zcat);
        });

        // Sanitize catno for use in URLs/R2 keys: replace any char that's not
        // alphanumeric/dash/underscore with '-'. Keeps SKU/handle untouched.
        const safeKey = catno.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g,'-').replace(/^-|-$/g,'');

        if (zipFile) {
          try {
            setProgress({ done:i, total, current:`${catno} — extracting ZIP…` });
            const zip   = await JSZip.loadAsync(zipFile);
            const files = Object.values(zip.files).filter(f=>!f.dir);

            // Cover image
            const imgFiles  = files.filter(f=>/\.(jpg|jpeg|png)$/i.test(f.name));
            const coverFile = imgFiles.find(f=>/front|cover|artwork/i.test(f.name.toLowerCase())) || imgFiles[0];
            if (coverFile) {
              setProgress({ done:i, total, current:`${catno} — uploading cover…` });
              const blob = await coverFile.async('blob');
              const ext  = coverFile.name.split('.').pop().toLowerCase();
              coverUrl = await uploadToR2(blob, `covers/${safeKey}.${ext}`, ext==='png'?'image/png':'image/jpeg');
            }

            // Audio
            const audioFiles = files.filter(f=>/\.(mp3|wav|flac|aac|ogg)$/i.test(f.name)).sort((a,b)=>a.name.localeCompare(b.name));
            for (const af of audioFiles) {
              const filename = af.name.split('/').pop();
              const safeFilename = filename.replace(/[^A-Za-z0-9._-]+/g, '-');
              setProgress({ done:i, total, current:`${catno} — uploading ${filename}…` });
              const blob = await af.async('blob');
              const url  = await uploadToR2(blob, `audio/${safeKey}/${safeFilename}`, 'audio/mpeg');
              tracks.push({ name: filename.replace(/\.[^.]+$/,''), url });
            }
          } catch(e) { itemError = e.message; }
        }

        // Build description HTML using shared helper
        const descHtml  = buildDescriptionHtml({ artist, title, label, year, tracks, sourceNotes: desc });
        const audioHtml = tracks.length ? `<script type="application/json" id="tracks">${JSON.stringify(tracks)}<\/script>` : '';

        const shopifyTags = ['vinyl','source:dbh', label?`label:${label}`:'', genre, String(year), tags?tags:''].filter(Boolean).join(', ');

        processed.push({
          _catno: catno, _title: title, _artist: artist,
          _coverUrl: coverUrl, _tracks: tracks, _error: itemError,
          _isPresale: isPresale, _zipFound: !!zipFile,
          'Handle': handle,
          'Title': title || catno,
          'Body (HTML)': `${descHtml}${audioHtml}`,
          'Vendor': artist,
          'Product Category': 'Media > Music & Sound Recordings > Vinyl',
          'Type': '',
          'Tags': shopifyTags,
          'Published': 'TRUE',
          'Option1 Name':'Title','Option1 Value':'Default Title','Option1 Linked To':'',
          'Option2 Name':'','Option2 Value':'','Option2 Linked To':'',
          'Option3 Name':'','Option3 Value':'','Option3 Linked To':'',
          'Variant SKU': catno,
          'Variant Grams': grams,
          'Variant Inventory Tracker': 'shopify',
          'Variant Inventory Qty': String(qtyOrdered),
          'Variant Inventory Policy': 'continue',
          'Variant Fulfillment Service': 'manual',
          'Variant Price': price,
          'Variant Compare At Price': '',
          'Variant Requires Shipping': 'TRUE',
          'Variant Taxable': 'TRUE',
          'Unit Price Total Measure':'','Unit Price Total Measure Unit':'',
          'Unit Price Base Measure':'','Unit Price Base Measure Unit':'',
          'Variant Barcode': '',
          'Image Src': coverUrl,
          'Image Position': coverUrl ? '1' : '',
          'Image Alt Text': coverUrl ? `${title} - ${artist}` : '',
          'Gift Card': 'FALSE','SEO Title':'','SEO Description':'',
          'Variant Image':'','Variant Weight Unit':'kg',
          'Variant Tax Code':'','Cost per item': ppu ? ppu.toFixed(2) : '','Status':'active',
        });

        setProgress({ done:i+1, total, current:'' });
      }

      setResults(processed);
      setStatus('review');
    } catch(e) {
      setError(e.message);
      setStatus('idle');
    }
  };

  const downloadCSV = () => {
    const CSV_KEYS = results.length ? Object.keys(results[0]).filter(k=>!k.startsWith('_')) : [];
    const lines = [CSV_KEYS.join(','), ...results.map(row=>CSV_KEYS.map(h=>`"${String(row[h]||'').replace(/"/g,'""')}"`).join(','))];
    const blob = new Blob([lines.join('\n')], { type:'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dbh_shopify_import.csv';
    a.click();
  };

  const pct       = progress.total ? Math.round((progress.done/progress.total)*100) : 0;
  const covered   = results.filter(r=>r._coverUrl).length;
  const withAudio = results.filter(r=>r._tracks?.length>0).length;
  const presales  = csvRows.filter(r=>parseInt(r['QTY Shipped']||0)===0).length;
  const noZip     = results.filter(r=>!r._zipFound).length;
  const errors    = results.filter(r=>r._error).length;

  return (
    <div>
      <p style={{fontSize:10,color:S.muted,margin:'0 0 14px',lineHeight:1.6}}>
        Upload your DBH order CSV + ZIP files. Description and price come from the CSV. ZIPs provide cover art and audio snippets.
      </p>

      {/* Drop zone */}
      <div
        onDragOver={e=>e.preventDefault()}
        onDrop={e=>{e.preventDefault();const files=[...e.dataTransfer.files];const csv=files.find(f=>/\.csv$/i.test(f.name));if(csv)loadCsv(csv);assignZips(files);}}
        style={{border:`2px dashed ${(csvFile||zipFiles.length)?S.accent:S.border}`,borderRadius:3,padding:'20px',textAlign:'center',marginBottom:14,transition:'border 0.15s'}}
      >
        <div style={{fontSize:28,marginBottom:6}}>🏠</div>
        <div style={{fontSize:11,color:(csvFile||zipFiles.length)?S.accent:S.muted,fontWeight:700,letterSpacing:1,textTransform:'uppercase',marginBottom:10}}>
          Drag DBH order CSV + ZIPs here
        </div>
        <div style={{display:'flex',gap:8,justifyContent:'center'}}>
          <input ref={csvRef} type="file" accept=".csv" style={{display:'none'}} onChange={e=>{if(e.target.files[0])loadCsv(e.target.files[0]);e.target.value='';}} />
          <input ref={zipRef} type="file" accept=".zip" multiple style={{display:'none'}} onChange={e=>{assignZips(e.target.files);e.target.value='';}} />
          <button onClick={()=>csvRef.current.click()} style={{background:csvFile?S.accent:S.border,border:'none',color:csvFile?'#080808':S.muted,cursor:'pointer',fontSize:9,padding:'6px 14px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
            {csvFile?`✓ ${csvFile}`:'+ Order CSV'}
          </button>
          <button onClick={()=>zipRef.current.click()} style={{background:zipFiles.length?S.accent:S.border,border:'none',color:zipFiles.length?'#080808':S.muted,cursor:'pointer',fontSize:9,padding:'6px 14px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
            {zipFiles.length?`✓ ${zipFiles.length} ZIPs`:'+ ZIPs'}
          </button>
          {zipFiles.length>0&&<button onClick={()=>setZipFiles([])} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,padding:'6px 10px',borderRadius:2,fontFamily:'inherit'}}>Clear</button>}
        </div>
      </div>

      {/* CSV preview */}
      {csvRows.length>0&&status==='idle'&&(
        <div style={{marginBottom:12,fontSize:10,color:S.muted,display:'flex',gap:16,flexWrap:'wrap',padding:'8px 14px',background:S.bg,border:`1px solid ${S.border}`,borderRadius:4}}>
          <span>Releases: <b style={{color:S.text}}>{csvRows.length}</b></span>
          <span>ZIPs matched: <b style={{color:S.accent}}>{csvRows.filter(r=>zipFiles.some(f=>catnoFromZip(f.name).includes(r['Catalog'].toUpperCase())||r['Catalog'].toUpperCase().includes(catnoFromZip(f.name)))).length}/{csvRows.length}</b></span>
          <span>Presale (QTY=0): <b style={{color:'#ff8800'}}>{csvRows.filter(r=>parseInt(r['QTY Shipped']||0)===0).length}</b></span>
        </div>
      )}

      {/* Margin + process */}
      {csvRows.length>0&&status==='idle'&&(
        <div style={{display:'flex',gap:12,alignItems:'center',marginBottom:12,flexWrap:'wrap'}}>
          <div style={{display:'flex',alignItems:'center',gap:6}}>
            <span style={{fontSize:10,color:S.muted}}>Margin %</span>
            <input type="number" value={margin} onChange={e=>setMargin(parseFloat(e.target.value)||60)} style={{width:70,padding:'5px 8px',background:S.surf,border:`1px solid ${S.border}`,borderRadius:2,color:S.text,fontFamily:'monospace',fontSize:12,textAlign:'center',outline:'none'}} />
          </div>
          <span style={{fontSize:9,color:S.muted}}>e.g. €8.80 × {(1+margin/100).toFixed(2)} = €{(8.80*(1+margin/100)).toFixed(2)} → €{(Math.ceil(8.80*(1+margin/100))-0.01).toFixed(2)}</span>
          <div style={{flex:1}}/>
          <Btn ch={`🚀 Process ${csvRows.length} releases`} onClick={process} full />
        </div>
      )}

      {/* Progress */}
      {status==='processing'&&(
        <div style={{padding:14,background:S.bg,borderRadius:2,border:`1px solid ${S.border}`,marginBottom:12}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
            <span style={{fontSize:10,color:S.accent,fontWeight:700,letterSpacing:1}}>PROCESSING…</span>
            <span style={{fontSize:10,color:S.muted}}>{progress.done} / {progress.total} · {pct}%</span>
          </div>
          <div style={{height:3,background:S.border,borderRadius:2,overflow:'hidden',marginBottom:8}}>
            <div style={{height:'100%',background:S.accent,width:`${pct}%`,transition:'width 0.3s'}} />
          </div>
          {progress.current&&<div style={{fontSize:9,color:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>→ {progress.current}</div>}
        </div>
      )}

      {error&&<div style={{marginBottom:12,padding:10,background:'#1a0000',border:`1px solid ${S.danger}44`,borderRadius:2,fontSize:10,color:S.danger}}>{error}</div>}

      {/* Results */}
      {status==='review'&&results.length>0&&(
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
            <div>
              <span style={{fontSize:11,color:S.accent,fontWeight:700}}>✓ {results.length} releases</span>
              <span style={{fontSize:9,color:S.muted,marginLeft:10}}>
                {covered} covers · {withAudio} audio
                {presales>0?` · ${presales} presale`:''}
                {noZip>0?` · ${noZip} no ZIP`:''}
                {errors>0?` · ${errors} errors`:''}
              </span>
            </div>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>

          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:8,maxHeight:500,overflowY:'auto',padding:4}}>
            {results.map((r,i)=>(
              <div key={i} style={{background:S.surf,border:`1px solid ${r._error?S.danger:r._coverUrl?S.border:'#ff8800'}`,borderRadius:3,overflow:'hidden'}}>
                <div style={{position:'relative',paddingBottom:'100%',background:'#1a1a2e'}}>
                  {r._coverUrl
                    ?<img src={r._coverUrl} alt="" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'}} onError={e=>e.target.style.display='none'} />
                    :<div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:24}}>🎵</div>
                  }
                  {r._tracks?.length>0&&<div style={{position:'absolute',bottom:4,left:4,background:'rgba(0,0,0,0.75)',borderRadius:2,fontSize:8,color:S.accent,padding:'2px 6px'}}>▶ {r._tracks.length}</div>}
                  {r._isPresale&&<div style={{position:'absolute',top:4,left:4,background:'#ff8800',borderRadius:2,fontSize:7,color:'#080808',padding:'2px 5px',fontWeight:700}}>PRESALE</div>}
                  {r._error&&<div style={{position:'absolute',top:4,right:4,background:S.danger,borderRadius:2,fontSize:7,color:'#fff',padding:'2px 5px',fontWeight:700}}>ERR</div>}
                  {!r._coverUrl&&!r._error&&<div style={{position:'absolute',top:4,right:4,background:'#ff8800',borderRadius:2,fontSize:7,color:'#080808',padding:'2px 5px',fontWeight:700}}>{r._zipFound?'NO IMG':'NO ZIP'}</div>}
                </div>
                <div style={{padding:'8px 8px 6px'}}>
                  <div style={{fontSize:9,color:S.muted,fontFamily:'monospace',marginBottom:2}}>{r._catno}</div>
                  <div style={{fontSize:10,fontWeight:700,color:S.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r._title||r._catno}</div>
                  <div style={{fontSize:9,color:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r._artist}</div>
                  <div style={{fontSize:10,color:S.accent,marginTop:3,fontWeight:700}}>€{r['Variant Price']}</div>
                  {r._error&&<div style={{fontSize:8,color:S.danger,marginTop:4,lineHeight:1.4}}>{r._error}</div>}
                </div>
              </div>
            ))}
          </div>

          <div style={{marginTop:14,display:'flex',justifyContent:'flex-end'}}>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── MOTHER TONGUE IMPORTER ─────────────────────────────────────
// Combines 3 sources to build the Shopify CSV:
//   1. Invoice PDF      → catno, qty, dealer price (with discount detection)
//   2. Listener HTML    → artist, title, label, format, description, GENRES,
//                         and a fallback cover URL from mothertonguerecords.com
//   3. Distributor folder → cover image + audio snippets (uploaded to R2)
//
// Folder is dropped via webkitdirectory; we walk every file and index by
// "normalized catno" (uppercase, alphanumeric only). Tolerates the chaotic
// distributor structure: covers can be flat or in subfolders (Artwork/,
// snippets/, CLIPS/, MP3/, THIS/THAT, drive-download-*/, etc.).
//
// Five product policy decisions (frozen 2026-05-07):
//   D1. Tag policy is label-only — no operational `mothertongue` tag exposed
//       to customers. The `label:` prefix already identifies the imprint.
//   D2. Releases with no listener metadata (no artist, no title) come out as
//       Status=draft so customers don't see catno-only placeholders.
//   D3. If no real sleeve cover is available (folder + listener), accept a
//       side-label/spindle/promo image as last resort rather than no image.
//   D4. Genre tags come from the WooCommerce categories scraped per product.
//       Filter out operational categories (What's New / Distribution / We Dig)
//       and split slash-separated multi-genres ("House / Electronic" → both).
//   D5. Cover priority: folder real-sleeve → listener real-sleeve →
//       folder anything → listener anything → empty.
function MotherTongueImporter() {
  const [pdfFile, setPdfFile]       = useState(null);
  const [htmlFile, setHtmlFile]     = useState(null);
  const [folderFiles, setFolderFiles] = useState([]); // raw File[] from webkitdirectory
  const [invoiceItems, setInvoiceItems] = useState([]); // [{catno, qty, dealerPrice}]
  const [releaseMeta, setReleaseMeta]   = useState({}); // catnoNorm → meta object
  const [folderIndex, setFolderIndex]   = useState({}); // catnoNorm → {covers:[File], audio:[File]}
  const [status, setStatus]   = useState('idle');
  const [progress, setProgress] = useState({ done:0, total:0, current:'' });
  const [results, setResults] = useState([]);
  const [error, setError]     = useState('');
  const [margin, setMargin]   = useState(60);
  const pdfRef    = useRef(null);
  const htmlRef   = useRef(null);
  const folderRef = useRef(null);

  // Normalize catno for matching: uppercase + alphanumeric only.
  // "BLDT007r" → "BLDT007R"; "MT-NERO-002" → "MTNERO002"; "WW-019" → "WW019".
  const normCatno = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // ── PDF PARSER ────────────────────────────────────────────────
  // Mother Tongue invoices have a 7-column table:
  //   CÓDIGO | DESCRIPCIÓN | CANTIDAD | DESCUENTO | PRECIO POR UNIDAD | IMPORTE | % IVA
  //
  // Three line patterns appear in the wild — the parser handles all of them:
  //   1. Single-line item (no discount, short title):
  //      "BLACKLP010 dego - love was never your goal 2 € 12.08 € 24.16 0"
  //   2. Multi-line title (no discount, long title): title wraps but the catno
  //      line still carries qty + prices.
  //   3. Discount item (10% promo): the catno line has only "qty 10% 0", and
  //      the discounted unit price (3-decimal, e.g. "€ 7.911") sits on a
  //      SIBLING line just above; the original (struck-through) price is below.
  //
  // Heuristics that took several iterations to land:
  //   - "qty" is the integer immediately preceding the FIRST €-prefixed number
  //     (NOT just the first integer — defends against titles like "(2024 Reissue)"
  //     or "33.10.3402 Labyrinths" that contain numbers).
  //   - Discounted unit price is identified by 3-decimal format ("7.911"); we
  //     scan ±20px Y for the closest sibling line containing one.
  //   - Trailing "0" on a candidate line is required as the % IVA marker —
  //     prevents legal-text lines like "Decreto legge 331/93" from registering
  //     as items even though "legge" passes the catno regex.
  async function parseInvoicePDF(file) {
    const pdfjsLib = await loadPDFJS();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const c = await page.getTextContent();
      const vp = page.getViewport({ scale: 1 });
      const byY = new Map();
      for (const it of c.items) {
        const x = it.transform[4];
        const y = vp.height - it.transform[5];
        const s = String(it.str || '');
        if (!s) continue;
        const key = Math.round(y / 4) * 4;
        if (!byY.has(key)) byY.set(key, []);
        byY.get(key).push({ s, x, x1: x + (it.width || 0) });
      }
      for (const [y, toks] of byY.entries()) {
        toks.sort((a, b) => a.x - b.x);
        let text = '', lastX = null;
        for (const t of toks) {
          if (lastX !== null && t.x - lastX > 1.0) text += ' ';
          text += t.s;
          lastX = t.x1;
        }
        lines.push({ page: p, y, text: text.trim() });
      }
    }
    lines.sort((a, b) => a.page - b.page || a.y - b.y);

    const SKIP_PATTERNS = [
      /^Mother Tongue srl/i, /^Lungadige/i, /^N\.?i\.?f\.?/i,
      /^FACTURA/i, /^Factura/i, /^info@/i, /^tel:/i,
      /^OBJETO/i, /^MAILORDER/i, /^CÓDIGO/i, /^DESCRIPCIÓN/i,
      /^Ordine/i, /^EMAIL\b/i, /^DESTINATARIO/i, /^Telsnap/i,
      /^Avenida/i, /^\d{5}\s*Madrid/i, /^Spain\s*$/i,
      /^NOTE\b/i, /\bPlease use the invoice/i, /^In riferimento/i,
      /^FORMA DE PAGO/i, /^Bonifico/i, /^IBAN/i, /^SWIFT/i,
      /^PLAZOS/i, /^RESUMEN DE IVA/i, /^GRAVABLE/i,
      /^Gravable/i, /^Non\s+imponibile/i,
      /^0%\s*-\s*Non\s+imponibile/i,
      /^legge\s+\d/i,
      /^Documento/i, /^SH001\b/i, /^SHIPPING\s*$/i, /^HS CODE/i,
      /^vinyl\s+records\s*$/i, /^N\.I\.F\./i,
    ];
    const skip = (t) => SKIP_PATTERNS.some(rx => rx.test(t));

    const items = [];
    const CATNO_RX = /^([A-Za-z0-9][A-Za-z0-9._\-]{2,29})/;

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.text) continue;
      if (skip(ln.text)) continue;

      const m = CATNO_RX.exec(ln.text);
      if (!m) continue;
      const catno = m[1];
      if (!/[A-Za-z]/.test(catno)) continue;
      const rest = ln.text.slice(catno.length);

      const allNums = [];
      const numRx = /(\d+(?:[.,]\d+)?)/g;
      let nm;
      while ((nm = numRx.exec(rest)) !== null) {
        const raw = nm[1];
        allNums.push({
          val: parseFloat(raw.replace(',', '.')),
          decimal: raw.includes('.') || raw.includes(','),
          idx: nm.index,
        });
      }
      if (allNums.length === 0 || allNums[allNums.length - 1].val !== 0) continue;

      const euroPrices = [];
      const euroRx = /€\s*(\d+(?:[.,]\d+)?)/g;
      let em;
      while ((em = euroRx.exec(rest)) !== null) {
        euroPrices.push({
          val: parseFloat(em[1].replace(',', '.')),
          idx: em.index + em[0].indexOf(em[1]),
        });
      }

      const discountMatch = rest.match(/(\d{1,2})%/);
      const hasDiscount = !!discountMatch;
      let qty = null, dealerPrice = null;

      if (hasDiscount) {
        const pct = parseInt(discountMatch[1]);
        const pctIdx = allNums.findIndex(n => n.val === pct && !n.decimal);
        if (pctIdx > 0) qty = Math.round(allNums[pctIdx - 1].val);
        let bestDy = Infinity, bestPrice = null;
        for (let j = 0; j < lines.length; j++) {
          if (j === i) continue;
          if (lines[j].page !== ln.page) continue;
          const dy = Math.abs(lines[j].y - ln.y);
          if (dy > 20) continue;
          const pm = lines[j].text.match(/(\d+\.\d{3})/);
          if (pm && dy < bestDy) {
            bestDy = dy;
            bestPrice = parseFloat(pm[1]);
          }
        }
        dealerPrice = bestPrice;
      } else {
        if (euroPrices.length >= 1) {
          const firstPriceIdx = euroPrices[0].idx;
          const qtyCandidates = allNums.filter(n =>
            n.idx < firstPriceIdx && !n.decimal && n.val >= 1 && n.val <= 99
          );
          if (qtyCandidates.length > 0) {
            qty = Math.round(qtyCandidates[qtyCandidates.length - 1].val);
            dealerPrice = euroPrices[0].val;
          }
        }
      }

      if (qty && dealerPrice && qty > 0 && dealerPrice > 0 && qty < 100) {
        items.push({ catno, qty, dealerPrice });
      }
    }
    return items;
  }

  // ── HTML LISTENER PARSER ──────────────────────────────────────
  // Extracts `const RELEASES = [...]` and indexes by normalized catno.
  // The listener now (post 2026-05-07) carries a `genres` array per release.
  async function parseListenerHTML(file) {
    const text = await file.text();
    const m = text.match(/const\s+RELEASES\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) throw new Error('Could not find RELEASES array in HTML file');
    let data;
    try { data = JSON.parse(m[1]); }
    catch (e) { throw new Error('RELEASES JSON parse failed: ' + e.message); }

    // Index by normalized catno; on duplicates, prefer the entry with most data.
    const score = (r) =>
      (r.cover ? 4 : 0) + (r.tracks?.length ? 2 : 0) +
      (r.description ? 1 : 0) + (r.genres?.length ? 1 : 0);
    const map = {};
    for (const r of data) {
      const key = normCatno(r.cat);
      if (!key) continue;
      if (!map[key] || score(r) > score(map[key])) map[key] = r;
    }
    return map;
  }

  // ── FOLDER INDEXER ────────────────────────────────────────────
  function buildFolderIndex(files, knownCatnos) {
    const index = {};
    const knownSet = new Set(knownCatnos.map(normCatno));
    const SKIP_FILE = (n) =>
      n.startsWith('._') || n === '.DS_Store' || n === 'Thumbs.db';
    const SKIP_DIR  = (seg) => seg === '__MACOSX';

    for (const f of files) {
      const path = f.webkitRelativePath || f.name;
      const segs = path.split('/');
      const fname = segs[segs.length - 1];
      if (SKIP_FILE(fname)) continue;
      if (segs.some(SKIP_DIR)) continue;

      let matchedKey = null;
      for (const seg of segs) {
        const k = normCatno(seg);
        if (k && knownSet.has(k)) matchedKey = k;
      }
      if (!matchedKey) continue;

      const ext = (fname.match(/\.([a-z0-9]+)$/i) || [,''])[1].toLowerCase();
      const isImg   = ['jpg','jpeg','png','webp'].includes(ext);
      const isAudio = ['mp3','wav','flac','aac','ogg','m4a'].includes(ext);
      if (!isImg && !isAudio) continue;

      if (!index[matchedKey]) index[matchedKey] = { covers: [], audio: [] };
      if (isImg)   index[matchedKey].covers.push(f);
      if (isAudio) index[matchedKey].audio.push(f);
    }
    return index;
  }

  // ── COVER-CANDIDATE CLASSIFIER ────────────────────────────────
  // Decision D5: pick a real sleeve image first; fall back to label/spindle
  // only if nothing better exists. These predicates classify a filename or URL
  // into one of three buckets:
  //   - "real":  explicit front/sleeve/cover/artwork (use first)
  //   - "label": center sticker, side-A/B image, promo sheet (use last)
  //   - "back":  back cover (skip — never use)
  // Names that match nothing fall through to a "neutral" category and are
  // treated as "real" by default (better than nothing).
  const isBack = (s) => /\bback\b|_back\b|-back\b/i.test(s);
  const isLabel = (s) => {
    const l = s.toLowerCase();
    return (
      // Side-letter markers — A/B/C/D side labels
      /\bside[-_\s]*[abcd]\b/i.test(l) ||
      /\b[abcd][-_\s]*side\b/i.test(l) ||
      /[-_]([abcd])[-_\s]*(?:side|label)?(?:\.|$|[-_\s])/i.test(l) ||
      // Explicit center-label names
      /\blabel[\s_-]*[abcd]?\b/i.test(l) ||
      /\bspindle\b/i.test(l) ||
      /\bsticker\b/i.test(l) ||
      /\bcenter[\s_-]*label\b/i.test(l) ||
      // Promo/press-release/info-sheet (Mother Tongue style)
      /\bpromo\b/i.test(l) ||
      /\bpress[\s_-]*release\b/i.test(l) ||
      /\binfo[\s_-]*sheet\b/i.test(l) ||
      /\brelease[\s_-]*info\b/i.test(l) ||
      /\bone[\s_-]*sheet\b/i.test(l) ||
      // Mother Tongue WordPress slug patterns: -sideA-, _side-a, sideA-scaled
      /side[-_]?[ab]/i.test(l)
    );
  };
  const isRealSleeve = (s) => {
    const l = s.toLowerCase();
    if (isBack(s)) return false;
    if (isLabel(s)) return false;
    return /(\bfront\b|\bcover\b|\bsleeve\b|\bartwork\b|\bjacket\b|\bart\b|\bmain\b)/i.test(l);
  };

  // ── COVER SELECTION FROM FOLDER ───────────────────────────────
  // Two-pass strategy reflecting D5:
  //   Pass 1: find a clearly "real" sleeve image. If found, return it.
  //   Pass 2: nothing real — split images into "neutral" (no marker) vs label.
  //           Prefer neutral over label (some folders just have generic names
  //           like "BLACKLP010.jpg" which are usually the front sleeve).
  //   Pass 3: only labels left → return the largest one (the front-of-vinyl
  //           shot, if any, tends to be larger). D3 says we accept this.
  function selectCover(images) {
    if (!images || images.length === 0) return null;
    const usable = images.filter(f => !isBack(f.name));
    if (usable.length === 0) return null;
    const real = usable.filter(f => isRealSleeve(f.name));
    if (real.length > 0) {
      return real.slice().sort((a,b) => b.size - a.size)[0];
    }
    const neutral = usable.filter(f => !isLabel(f.name));
    if (neutral.length > 0) {
      return neutral.slice().sort((a,b) => b.size - a.size)[0];
    }
    // Only labels remain — D3: accept anyway as last resort.
    return usable.slice().sort((a,b) => b.size - a.size)[0];
  }

  // Listener URL classifier — same predicates applied to the URL string.
  // mothertonguerecords.com sometimes only hosts side-label photos; if so,
  // we still try to use them as last resort per D3 / D5.
  function classifyListenerUrl(url) {
    if (!url) return 'none';
    if (isBack(url)) return 'back';
    if (isRealSleeve(url)) return 'real';
    if (isLabel(url)) return 'label';
    return 'neutral';
  }

  // ── AUDIO ORDERING ────────────────────────────────────────────
  function orderAudio(audioFiles) {
    if (!audioFiles || audioFiles.length === 0) return [];
    const byBase = {};
    for (const f of audioFiles) {
      const base = f.name.replace(/\.[^.]+$/, '').toLowerCase();
      const ext  = (f.name.match(/\.([a-z0-9]+)$/i) || [,''])[1].toLowerCase();
      const score = ext === 'mp3' ? 3 : ext === 'm4a' ? 2 : ext === 'wav' ? 1 : 0;
      if (!byBase[base] || score > byBase[base].score) byBase[base] = { f, score };
    }
    const filtered = Object.values(byBase).map(x => x.f);
    const keyOf = (f) => {
      const path = f.webkitRelativePath || f.name;
      const inThis = /\/THIS\//i.test(path);
      const inThat = /\/THAT\//i.test(path);
      const fname = f.name;
      let side = 99, num = 999;
      let m;
      if ((m = fname.match(/^(?:\d+\s*[-_.]?\s*)?Side\s+([A-D])[.\s]+(\d+)/i))) {
        side = m[1].toUpperCase().charCodeAt(0) - 65;
        num  = parseInt(m[2]);
      } else if ((m = fname.match(/^(?:\d+\s*[-_.]?\s*)?([A-D])\s*(\d+)\b/i))) {
        side = m[1].toUpperCase().charCodeAt(0) - 65;
        num  = parseInt(m[2]);
      } else if ((m = fname.match(/^([A-D])\s+Side\b/i))) {
        side = m[1].toUpperCase().charCodeAt(0) - 65;
        num  = 0;
      } else if ((m = fname.match(/^(\d+)[.\s_-]/))) {
        side = inThat ? 1 : (inThis ? 0 : 50);
        num  = parseInt(m[1]);
      } else {
        side = inThat ? 1 : (inThis ? 0 : 99);
      }
      return [side, num, fname.toLowerCase()];
    };
    return filtered.slice().sort((a,b) => {
      const ka = keyOf(a), kb = keyOf(b);
      return (ka[0]-kb[0]) || (ka[1]-kb[1]) || (ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0);
    });
  }

  // ── TRACK NAME EXTRACTION ─────────────────────────────────────
  // Strip prefixes (A1, B2, Side A.1, 01., catalog number) and suffixes
  // (Snippet, Clip, Preview, "60 sec taster", "[1.30MIN SNIPPET]", " - 2000BLACK").
  // Catno is passed in so we can recognize SKU-prefixed track names like
  // "DTW082 A1 Don't Forget Your Hiss" or "MT19022- 1-A1 Terra de Luz".
  function trackNameFromFilename(fname, catno) {
    let n = fname.replace(/\.[^.]+$/, '');
    n = n.replace(/_/g, ' ');
    n = n.replace(/\s*\[\s*\d+\.?\d*\s*MIN\s*SNIPPET\s*\]\s*/i, '');

    const skuRx = catno ? catno.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
    for (let i = 0; i < 5; i++) {
      const before = n;
      n = n.replace(/^[\s\-–]+/, '');
      if (skuRx) n = n.replace(new RegExp('^' + skuRx + '\\s*', 'i'), '');
      n = n.replace(/^[AB]\s*[-–]\s+/i, '');
      n = n.replace(/^\d+\s*[-–]\s*/, '');
      n = n.replace(/^[AB]\d+\.?\s*[-–]?\s*/i, '');
      n = n.replace(/^Side\s+[A-D][.\s_-]*\d*\s*[-–]?\s*/i, '');
      n = n.replace(/^TRACK\s+\d+[\s_\-]*/i, '');
      n = n.replace(/^\d{1,2}[\s_.\-]+/, '');
      if (n === before) break;
    }
    n = n.replace(/[\s_.\-]*\(?\s*(snippet|snip|preview|clip|teaser|taster)s?\s*\)?\s*$/i, '');
    n = n.replace(/[\s_-]*\(\s*\d+\s*sec\s+taster\s*\)\s*$/i, '');
    n = n.replace(/\s*-\s*2000BLACK\s*$/i, '');
    n = n.replace(/\s{2,}/g, ' ').trim();
    return n || fname.replace(/\.[^.]+$/, '');
  }

  // ── GENRE TAG NORMALIZATION ───────────────────────────────────
  // Decision D4: WooCommerce categories include some operational ones
  // ("What's New", "Distribution (Wholesale)", "We Dig", "International")
  // that aren't real genres and shouldn't appear as customer-facing tags.
  // Plus, multi-genre values come slash-separated ("House / Electronic" or
  // "Soul / Hip Hop / RnB") — split them so customers can filter by atomic
  // genres.
  const NON_GENRE_CATEGORIES = new Set([
    "what's new", 'whats new', 'distribution (wholesale)',
    'distribution', 'wholesale', 'we dig', 'international',
    'all releases', 'releases', 'shop', 'mailorder',
  ]);
  function normalizeGenres(rawGenres) {
    if (!Array.isArray(rawGenres)) return [];
    const out = new Set();
    for (const raw of rawGenres) {
      if (!raw) continue;
      // Split "House / Electronic" → ["House", "Electronic"]
      for (const piece of String(raw).split(/\s*\/\s*/)) {
        const trimmed = piece.trim();
        if (!trimmed) continue;
        if (NON_GENRE_CATEGORIES.has(trimmed.toLowerCase())) continue;
        out.add(trimmed);
      }
    }
    return Array.from(out);
  }

  // ── DERIVE WEIGHT FROM FORMAT ─────────────────────────────────
  function gramsFromFmt(fmt) {
    const f = String(fmt || '').toLowerCase();
    if (/3\s*x\s*12|3x12|triple/.test(f)) return '1300';
    if (/2\s*x\s*12|2x12|double/.test(f)) return '900';
    if (/7"|7\s*inch/.test(f))            return '180';
    return '500';
  }

  // ── INPUT HANDLERS ────────────────────────────────────────────
  const onPdf = async (file) => {
    if (!file) return;
    setError(''); setStatus('parsing');
    try {
      const items = await parseInvoicePDF(file);
      setInvoiceItems(items);
      setPdfFile(file.name);
      setStatus('idle');
    } catch (e) {
      setError('PDF parse error: ' + e.message); setStatus('idle');
    }
  };

  const onHtml = async (file) => {
    if (!file) return;
    setError(''); setStatus('parsing');
    try {
      const map = await parseListenerHTML(file);
      setReleaseMeta(map);
      setHtmlFile(file.name);
      setStatus('idle');
    } catch (e) {
      setError('HTML parse error: ' + e.message); setStatus('idle');
    }
  };

  const onFolder = (filesList) => {
    const arr = Array.from(filesList || []);
    setFolderFiles(arr);
  };

  useEffect(() => {
    if (!folderFiles.length || !invoiceItems.length) {
      setFolderIndex({});
      return;
    }
    const idx = buildFolderIndex(folderFiles, invoiceItems.map(i => i.catno));
    setFolderIndex(idx);
  }, [folderFiles, invoiceItems]);

  // ── PROCESSING PIPELINE ───────────────────────────────────────
  const process = async () => {
    if (!invoiceItems.length) { setError('Need invoice PDF first'); return; }
    setError(''); setStatus('processing'); setResults([]);
    try {
      const total = invoiceItems.length;
      const processed = [];
      for (let i = 0; i < invoiceItems.length; i++) {
        const item = invoiceItems[i];
        const key  = normCatno(item.catno);
        const meta = releaseMeta[key] || {};
        const assets = folderIndex[key] || { covers: [], audio: [] };
        setProgress({ done:i, total, current:`${item.catno} — preparing…` });

        // ── METADATA + D1 (no operational tag) + D2 (draft fallback) ──
        const rawArtist = (meta.artist || '').trim();
        const rawTitle  = (meta.title  || '').trim();
        const labelMeta = (meta.label  || '').trim();
        const fmtNorm   = meta.fmt_norm || meta.format || '';
        const grams     = gramsFromFmt(fmtNorm);

        // Vendor cleanup: V.A. (Various Artists) doesn't help in the storefront —
        // substitute the label name when available. Skip the "House Only" fallback;
        // empty Vendor is fine in Shopify.
        let artist = rawArtist;
        if (/^V\.?\s*A\.?$/i.test(artist) || /^V\.?\s*A\.?\s*\(/i.test(artist) || /^Various/i.test(artist)) {
          artist = labelMeta || 'Various Artists';
        } else if (artist.length > 50) {
          // Take first artist before "/", "feat", "ft.", ","
          const firstArtist = artist.split(/\s*(?:\/|feat\.?|ft\.?|,)\s*/i)[0].trim();
          if (firstArtist && firstArtist.length >= 3) artist = firstArtist;
        }

        // Title cleanup: strip "...." artifacts, strip lone "/", fall back to catno.
        let title = rawTitle.replace(/\s*\.{3,}\s*/g, ' ').replace(/\s+/g, ' ').trim();
        if (!title || title === '/' || title.length < 2) title = item.catno;

        // Description cleanup: scraper truncates at ~500 chars regardless of
        // sentence boundary. Append "…" when text doesn't end on punctuation.
        let desc = (meta.description || '').trim();
        if (desc.length > 100 && !/[.!?:;)]$/.test(desc)) desc += '…';

        // D2: draft if NO listener metadata was matched at all.
        const hasMeta = !!(rawArtist || rawTitle);
        const productStatus = hasMeta ? 'active' : 'draft';

        // Derive label-clean (drop suffix "- (Worldwide except UK)" etc.)
        const labelClean = labelMeta.replace(/\s*-\s*\(.*?\)\s*$/, '').trim();

        const handle = item.catno.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+$/,'');
        const safeKey = item.catno.replace(/[^A-Za-z0-9_-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');

        // Pricing: dealer × (1+margin%) → ceil − 0.01.
        const rawPrice = item.dealerPrice * (1 + margin / 100);
        const price    = (Math.ceil(rawPrice) - 0.01).toFixed(2);

        // ── COVER (D5: folder-real → listener-real → folder-any → listener-any) ──
        let coverUrl = '';
        let itemError = '';
        const folderCover = selectCover(assets.covers);
        const folderCoverIsReal = folderCover && isRealSleeve(folderCover.name);
        const listenerUrlClass = classifyListenerUrl(meta.cover);

        // Helper: upload a File to R2 and return the public URL.
        const uploadFolderCover = async (file) => {
          const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [,'jpg'])[1].toLowerCase();
          const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
          return await uploadToR2(file, `covers/${safeKey}.${ext}`, mime);
        };
        // Helper: ask the Worker to mirror an external image URL to R2.
        // The browser can't fetch mothertonguerecords.com directly because
        // their server omits CORS headers; the Worker can, since fetch() at
        // the edge isn't subject to CORS. The Worker validates the host
        // against an allowlist, hard-caps size/timeout, and refuses anything
        // that isn't an image/* response, so we just trust its return URL.
        const mirrorListenerCover = async (url) => {
          if (!url) return '';
          const urlExt = (url.match(/\.(jpg|jpeg|png|webp)(\?|$)/i) || [,'jpg'])[1].toLowerCase();
          const ext = urlExt === 'jpeg' ? 'jpg' : urlExt;
          const r = await fetch(`${WORKER_URL}?action=mirror`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, key: `covers/${safeKey}.${ext}` }),
          });
          if (!r.ok) return '';
          const data = await r.json().catch(() => ({}));
          return data.url || '';
        };

        // Pass 1: prefer a real sleeve from the folder.
        if (folderCoverIsReal) {
          try {
            setProgress({ done:i, total, current:`${item.catno} — uploading cover (folder real)…` });
            coverUrl = await uploadFolderCover(folderCover);
          } catch (e) { itemError = 'Cover upload: ' + e.message; }
        }
        // Pass 2: try a real listener URL.
        if (!coverUrl && listenerUrlClass === 'real') {
          try {
            setProgress({ done:i, total, current:`${item.catno} — fetching listener cover (real)…` });
            coverUrl = await mirrorListenerCover(meta.cover);
          } catch (_) { /* CORS or 404 — continue */ }
        }
        // Pass 3: folder cover even if it's a label/spindle/promo (D3).
        if (!coverUrl && folderCover) {
          try {
            setProgress({ done:i, total, current:`${item.catno} — uploading cover (folder fallback)…` });
            coverUrl = await uploadFolderCover(folderCover);
          } catch (e) { if (!itemError) itemError = 'Cover upload: ' + e.message; }
        }
        // Pass 4: listener URL even if it's a label.
        if (!coverUrl && (listenerUrlClass === 'label' || listenerUrlClass === 'neutral')) {
          try {
            setProgress({ done:i, total, current:`${item.catno} — fetching listener cover (fallback)…` });
            coverUrl = await mirrorListenerCover(meta.cover);
          } catch (_) { /* swallow */ }
        }

        // ── AUDIO ────────────────────────────────────────────
        const tracks = [];
        const audioOrdered = orderAudio(assets.audio);
        for (let a = 0; a < audioOrdered.length; a++) {
          const af = audioOrdered[a];
          const safeFilename = af.name.replace(/[^A-Za-z0-9._-]+/g, '-');
          try {
            setProgress({ done:i, total, current:`${item.catno} — audio ${a+1}/${audioOrdered.length}…` });
            const url = await uploadToR2(af, `audio/${safeKey}/${safeFilename}`, 'audio/mpeg');
            tracks.push({ name: trackNameFromFilename(af.name, item.catno), url });
          } catch (_) {
            if (!itemError) itemError = 'Audio upload partial fail';
          }
        }

        // ── TAGS (D1 label-only + D4 genres) ────────────────────
        const genres = normalizeGenres(meta.genres);
        const tagParts = ['vinyl', 'source:kudos'];
        if (labelClean) tagParts.push(`label:${labelClean}`);
        for (const g of genres) tagParts.push(`genre:${g}`);
        tagParts.push(String(new Date().getFullYear()));
        const shopifyTags = tagParts.join(', ');

        // ── BUILD CSV ROW ────────────────────────────────────
        const descHtml  = buildDescriptionHtml({ artist, title, label: labelClean, year:'', tracks, sourceNotes: desc });
        const audioHtml = tracks.length ? `<script type="application/json" id="tracks">${JSON.stringify(tracks)}<\/script>` : '';

        processed.push({
          _catno: item.catno, _title: title, _artist: artist,
          _coverUrl: coverUrl, _tracks: tracks, _error: itemError,
          _hasMeta: hasMeta, _hasAssets: !!(assets.covers.length || assets.audio.length),
          _draft: productStatus === 'draft',
          'Handle': handle,
          'Title': title || item.catno,
          'Body (HTML)': `${descHtml}${audioHtml}`,
          'Vendor': artist,
          'Product Category': 'Media > Music & Sound Recordings > Vinyl',
          'Type': '',
          'Tags': shopifyTags,
          'Published': productStatus === 'active' ? 'TRUE' : 'FALSE',
          'Option1 Name':'Title','Option1 Value':'Default Title','Option1 Linked To':'',
          'Option2 Name':'','Option2 Value':'','Option2 Linked To':'',
          'Option3 Name':'','Option3 Value':'','Option3 Linked To':'',
          'Variant SKU': item.catno,
          'Variant Grams': grams,
          'Variant Inventory Tracker': 'shopify',
          'Variant Inventory Qty': String(item.qty),
          'Variant Inventory Policy': 'continue',
          'Variant Fulfillment Service': 'manual',
          'Variant Price': price,
          'Variant Compare At Price': '',
          'Variant Requires Shipping': 'TRUE',
          'Variant Taxable': 'TRUE',
          'Unit Price Total Measure':'','Unit Price Total Measure Unit':'',
          'Unit Price Base Measure':'','Unit Price Base Measure Unit':'',
          'Variant Barcode': '',
          'Image Src': coverUrl,
          'Image Position': coverUrl ? '1' : '',
          'Image Alt Text': coverUrl ? `${title} - ${artist}` : '',
          'Gift Card': 'FALSE','SEO Title':'','SEO Description':'',
          'Variant Image':'','Variant Weight Unit':'kg',
          'Variant Tax Code':'','Cost per item': item.dealerPrice.toFixed(2),
          'Status': productStatus,
        });
        setProgress({ done:i+1, total, current:'' });
      }
      setResults(processed);
      setStatus('review');
    } catch (e) {
      setError(e.message); setStatus('idle');
    }
  };

  const downloadCSV = () => {
    const CSV_KEYS = results.length ? Object.keys(results[0]).filter(k => !k.startsWith('_')) : [];
    const lines = [
      CSV_KEYS.join(','),
      ...results.map(row => CSV_KEYS.map(h => `"${String(row[h]||'').replace(/"/g,'""')}"`).join(','))
    ];
    const blob = new Blob([lines.join('\n')], { type:'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mothertongue_shopify_import.csv';
    a.click();
  };

  // ── DERIVED STATS ─────────────────────────────────────────────
  const pct = progress.total ? Math.round((progress.done/progress.total)*100) : 0;
  const matchedMeta   = invoiceItems.filter(it => releaseMeta[normCatno(it.catno)]).length;
  const matchedAssets = invoiceItems.filter(it => folderIndex[normCatno(it.catno)]).length;
  const itemsWithCover = invoiceItems.filter(it => {
    const idx = folderIndex[normCatno(it.catno)];
    return idx && idx.covers.length > 0;
  }).length;
  const itemsWithAudio = invoiceItems.filter(it => {
    const idx = folderIndex[normCatno(it.catno)];
    return idx && idx.audio.length > 0;
  }).length;
  const itemsWithGenres = invoiceItems.filter(it => {
    const m = releaseMeta[normCatno(it.catno)];
    return m && Array.isArray(m.genres) && normalizeGenres(m.genres).length > 0;
  }).length;

  // ── RENDER ────────────────────────────────────────────────────
  return (
    <div>
      <p style={{fontSize:10,color:S.muted,margin:'0 0 14px',lineHeight:1.6}}>
        Drop the invoice PDF, the listener HTML (descriptions/artist/title/genres), and the
        full distributor folder. The importer matches catnos across all three
        sources and builds the Shopify CSV.
      </p>

      <div
        onDragOver={e=>e.preventDefault()}
        onDrop={e=>{
          e.preventDefault();
          const fl = [...e.dataTransfer.files];
          const pdf  = fl.find(f => /\.pdf$/i.test(f.name));
          const html = fl.find(f => /\.html?$/i.test(f.name));
          if (pdf)  onPdf(pdf);
          if (html) onHtml(html);
        }}
        style={{
          border:`2px dashed ${(pdfFile||htmlFile||folderFiles.length)?S.accent:S.border}`,
          borderRadius:3, padding:'20px', textAlign:'center', marginBottom:14,
          transition:'border 0.15s'
        }}
      >
        <div style={{fontSize:28,marginBottom:6}}>🇮🇹</div>
        <div style={{fontSize:11,color:(pdfFile||htmlFile||folderFiles.length)?S.accent:S.muted,fontWeight:700,letterSpacing:1,textTransform:'uppercase',marginBottom:10}}>
          Mother Tongue · Drop invoice PDF + listener HTML, then pick folder
        </div>
        <div style={{display:'flex',gap:8,justifyContent:'center',flexWrap:'wrap'}}>
          <input ref={pdfRef}  type="file" accept=".pdf"  style={{display:'none'}} onChange={e=>{if(e.target.files[0])onPdf(e.target.files[0]);e.target.value='';}} />
          <input ref={htmlRef} type="file" accept=".html,.htm" style={{display:'none'}} onChange={e=>{if(e.target.files[0])onHtml(e.target.files[0]);e.target.value='';}} />
          <input ref={folderRef} type="file" webkitdirectory="" directory="" multiple style={{display:'none'}} onChange={e=>{onFolder(e.target.files);e.target.value='';}} />
          <button onClick={()=>pdfRef.current.click()}
            style={{background:pdfFile?S.accent:S.border,border:'none',color:pdfFile?'#080808':S.muted,cursor:'pointer',fontSize:9,padding:'6px 14px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
            {pdfFile?`✓ ${pdfFile}`:'+ Invoice PDF'}
          </button>
          <button onClick={()=>htmlRef.current.click()}
            style={{background:htmlFile?S.accent:S.border,border:'none',color:htmlFile?'#080808':S.muted,cursor:'pointer',fontSize:9,padding:'6px 14px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
            {htmlFile?`✓ ${htmlFile}`:'+ Listener HTML'}
          </button>
          <button onClick={()=>folderRef.current.click()}
            style={{background:folderFiles.length?S.accent:S.border,border:'none',color:folderFiles.length?'#080808':S.muted,cursor:'pointer',fontSize:9,padding:'6px 14px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
            {folderFiles.length?`✓ ${folderFiles.length} files`:'+ Distributor folder'}
          </button>
          {folderFiles.length>0&&<button onClick={()=>setFolderFiles([])} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,padding:'6px 10px',borderRadius:2,fontFamily:'inherit'}}>Clear</button>}
        </div>
      </div>

      {(invoiceItems.length>0 || Object.keys(releaseMeta).length>0 || folderFiles.length>0) && status==='idle' && (
        <div style={{marginBottom:12,fontSize:10,color:S.muted,display:'flex',gap:16,flexWrap:'wrap',padding:'8px 14px',background:S.bg,border:`1px solid ${S.border}`,borderRadius:4}}>
          <span>Invoice items: <b style={{color:S.text}}>{invoiceItems.length}</b></span>
          {Object.keys(releaseMeta).length>0 && (
            <span>Listener releases: <b style={{color:S.text}}>{Object.keys(releaseMeta).length}</b></span>
          )}
          {invoiceItems.length>0 && (
            <span>Meta matched: <b style={{color: matchedMeta===invoiceItems.length ? S.accent : '#ff8800'}}>{matchedMeta}/{invoiceItems.length}</b></span>
          )}
          {invoiceItems.length>0 && Object.keys(releaseMeta).length>0 && (
            <span>With genres: <b style={{color: itemsWithGenres===invoiceItems.length ? S.accent : '#ff8800'}}>{itemsWithGenres}/{invoiceItems.length}</b></span>
          )}
          {invoiceItems.length>0 && folderFiles.length>0 && (
            <>
              <span>Assets matched: <b style={{color: matchedAssets===invoiceItems.length ? S.accent : '#ff8800'}}>{matchedAssets}/{invoiceItems.length}</b></span>
              <span>With cover: <b style={{color:S.accent}}>{itemsWithCover}</b></span>
              <span>With audio: <b style={{color:S.accent}}>{itemsWithAudio}</b></span>
            </>
          )}
        </div>
      )}

      {invoiceItems.length>0 && status==='idle' && (
        <div style={{display:'flex',gap:12,alignItems:'center',marginBottom:12,flexWrap:'wrap'}}>
          <div style={{display:'flex',alignItems:'center',gap:6}}>
            <span style={{fontSize:10,color:S.muted}}>Margin %</span>
            <input type="number" value={margin} onChange={e=>setMargin(parseFloat(e.target.value)||60)}
              style={{width:70,padding:'5px 8px',background:S.surf,border:`1px solid ${S.border}`,borderRadius:2,color:S.text,fontFamily:'monospace',fontSize:12,textAlign:'center',outline:'none'}} />
          </div>
          <span style={{fontSize:9,color:S.muted}}>
            e.g. €8.24 × {(1+margin/100).toFixed(2)} = €{(8.24*(1+margin/100)).toFixed(2)} → €{(Math.ceil(8.24*(1+margin/100))-0.01).toFixed(2)}
          </span>
          <div style={{flex:1}}/>
          <Btn ch={`🚀 Process ${invoiceItems.length} releases`} onClick={process} full />
        </div>
      )}

      {status==='processing' && (
        <div style={{padding:14,background:S.bg,borderRadius:2,border:`1px solid ${S.border}`,marginBottom:12}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
            <span style={{fontSize:10,color:S.accent,fontWeight:700,letterSpacing:1}}>PROCESSING…</span>
            <span style={{fontSize:10,color:S.muted}}>{progress.done} / {progress.total} · {pct}%</span>
          </div>
          <div style={{height:3,background:S.border,borderRadius:2,overflow:'hidden',marginBottom:8}}>
            <div style={{height:'100%',background:S.accent,width:`${pct}%`,transition:'width 0.3s'}} />
          </div>
          {progress.current && <div style={{fontSize:9,color:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>→ {progress.current}</div>}
        </div>
      )}

      {error && (
        <div style={{marginBottom:12,padding:10,background:'#1a0000',border:`1px solid ${S.danger}44`,borderRadius:2,fontSize:10,color:S.danger}}>{error}</div>
      )}

      {status==='review' && results.length>0 && (
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
            <div>
              <span style={{fontSize:11,color:S.accent,fontWeight:700}}>✓ {results.length} releases</span>
              <span style={{fontSize:9,color:S.muted,marginLeft:10}}>
                {results.filter(r=>r._coverUrl).length} covers · {results.filter(r=>r._tracks?.length>0).length} audio
                {results.filter(r=>r._draft).length>0 ? ` · ${results.filter(r=>r._draft).length} draft` : ''}
                {results.filter(r=>r._error).length>0 ? ` · ${results.filter(r=>r._error).length} errors` : ''}
              </span>
            </div>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:8,maxHeight:500,overflowY:'auto',padding:4}}>
            {results.map((r,i)=>(
              <div key={i} style={{background:S.surf,border:`1px solid ${r._error?S.danger:r._draft?'#ff8800':S.border}`,borderRadius:3,overflow:'hidden',opacity:r._draft?0.7:1}}>
                <div style={{position:'relative',paddingBottom:'100%',background:'#1a1a2e'}}>
                  {r._coverUrl
                    ? <img src={r._coverUrl} alt="" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'}} onError={e=>e.target.style.display='none'} />
                    : <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:24}}>🎵</div>
                  }
                  {r._tracks?.length>0 && <div style={{position:'absolute',bottom:4,left:4,background:'rgba(0,0,0,0.75)',borderRadius:2,fontSize:8,color:S.accent,padding:'2px 6px'}}>▶ {r._tracks.length}</div>}
                  {r._draft && <div style={{position:'absolute',top:4,left:4,background:'#ff8800',borderRadius:2,fontSize:7,color:'#080808',padding:'2px 5px',fontWeight:700}}>DRAFT</div>}
                  {!r._coverUrl && !r._draft && <div style={{position:'absolute',top:4,right:4,background:'#ff8800',borderRadius:2,fontSize:7,color:'#080808',padding:'2px 5px',fontWeight:700}}>NO IMG</div>}
                  {r._error && <div style={{position:'absolute',bottom:4,right:4,background:S.danger,borderRadius:2,fontSize:7,color:'#fff',padding:'2px 5px',fontWeight:700}}>ERR</div>}
                </div>
                <div style={{padding:'8px 8px 6px'}}>
                  <div style={{fontSize:9,color:S.muted,fontFamily:'monospace',marginBottom:2}}>{r._catno}</div>
                  <div style={{fontSize:10,fontWeight:700,color:S.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r._title||r._catno}</div>
                  <div style={{fontSize:9,color:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r._artist||'—'}</div>
                  <div style={{fontSize:10,color:S.accent,marginTop:3,fontWeight:700}}>€{r['Variant Price']}</div>
                  {r._error && <div style={{fontSize:8,color:S.danger,marginTop:4,lineHeight:1.4}}>{r._error}</div>}
                </div>
              </div>
            ))}
          </div>
          <div style={{marginTop:14,display:'flex',justifyContent:'flex-end'}}>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── RUSH HOUR IMPORTER ─────────────────────────────────────────
// Combines 2 sources to build the Shopify CSV:
//   1. Order JSON (from the bookmarklet) → catno, qty, dealerPrice, slug,
//      artist, title, label, format, barcode, tag, release, tracks[],
//      description, artworkUrl, snippetsUrl. Everything that used to come
//      from the invoice PDF is now read straight from the order page DOM.
//   2. ZIPs (artwork + snippets, 2 per release) → cover image + audio MP3s,
//      uploaded to R2.
//
// JSON / ZIP matching: by slug. The bookmarklet records each release's slug
// (from /record/vinyl/<slug>); the ZIPs are named
// "artwork_<slug>_<DD-MM-YYYY>_<HHMM>.zip" and "snippets_<slug>_..." but
// slug normalization in the filename varies — sometimes hyphens, sometimes
// underscores, sometimes a different word ("dismantled-juice" →
// "dismantled_into_juice"). We match by stripping prefix/suffix and
// comparing as alphanumeric-only with subset-in-either-direction.
//
// Five product policy decisions (frozen 2026-05-09):
//   D1. Tag policy is label-only (`label:<name>`) plus genre tags from the
//       JSON `tag` field (Rush Hour assigns one or two tags per release —
//       e.g. "House\nDetroit" → ["House","Detroit"]). No operational
//       `rushhour` tag is exposed to customers.
//   D2. Cover image comes from the artwork ZIP (every Rush Hour release
//       carries one — `album_cover.jpg`). No fallback needed in practice.
//   D3. Audio tracks come from the snippets ZIP (typically 2-4 MP3s per
//       release, side-ordered by the leading "a1/a2/b1/b2" naming). Track
//       NAMES come from the JSON `tracks[]` array, which the bookmarklet
//       extracted from the product page in vinyl side order.
//   D4. Year comes from the JSON `release` field ("W 07 - 2023" → 2023).
//   D5. Format-driven weight: 12" → 500g, 2LP → 900g, 3LP → 1300g, 7" → 180g.

function RushHourImporter() {
  const [jsonFile, setJsonFile]     = useState(null);
  const [zipFiles, setZipFiles]     = useState([]); // raw File[]
  const [orderItems, setOrderItems] = useState([]); // [{catno, slug, qty, dealerPrice, ...}]
  const [zipIndex, setZipIndex]     = useState({}); // slugNorm → {artwork:File, snippets:File}
  const [status, setStatus]   = useState('idle');
  const [progress, setProgress] = useState({ done:0, total:0, current:'' });
  const [results, setResults] = useState([]);
  const [error, setError]     = useState('');
  const [margin, setMargin]   = useState(60);
  const jsonRef = useRef(null);
  const zipRef  = useRef(null);

  // ── JSON PARSER ───────────────────────────────────────────────
  // Bookmarklet output:
  //   { orderNumber: "1778948",
  //     items: [
  //       { catno, label, artist, title, slug, productUrl, format, barcode,
  //         dealerPrice, qty, total,
  //         nodeId, artworkUrl, snippetsUrl, h1Title,
  //         tag, release, sku, tracks: [...], description }
  //     ] }
  async function parseOrderJSON(file) {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('Invalid JSON: ' + e.message); }
    const arr = Array.isArray(data) ? data
              : Array.isArray(data.items) ? data.items
              : [];
    if (!arr.length) throw new Error('No items found in JSON');
    // Filter out malformed rows (need at least slug + dealerPrice + qty)
    const valid = arr.filter(it => it.slug && it.dealerPrice > 0 && it.qty > 0);
    if (!valid.length) throw new Error('JSON has no items with slug + dealerPrice + qty');
    return valid;
  }

  // Normalize catno for matching across JSON ↔ ZIP filename.
  // The bookmarklet now writes ZIP files as "artwork_<CATNOSAFE>.zip" and
  // "snippets_<CATNOSAFE>.zip" where CATNOSAFE = uppercase alphanumeric only.
  // Examples: "WPH LP 004" → "WPHLP004", "RHMC 006-1" → "RHMC0061",
  // "FARO 153LP" → "FARO153LP". This makes JSON↔ZIP matching deterministic
  // and survives Rush Hour's SEO slug rewrites (the URL slug doesn't always
  // agree with the title-derived ZIP slug).
  const normCatno = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // ── ZIP INDEXER ───────────────────────────────────────────────
  // Filename pattern (deterministic since bookmarklet rev 2):
  //   "artwork_WPHLP004.zip"
  //   "snippets_RHMC0061.zip"
  function buildZipIndex(files, jsonItems) {
    const catnoToFiles = {};
    for (const it of jsonItems) {
      const k = normCatno(it.catno);
      if (k) catnoToFiles[k] = { artwork: null, snippets: null, _catno: it.catno };
    }
    for (const f of files) {
      const m = f.name.match(/^(artwork|snippets)_([A-Z0-9]+)\.zip$/i);
      if (!m) continue;
      const kind = m[1].toLowerCase();
      const zipCatno = m[2].toUpperCase();
      if (catnoToFiles[zipCatno]) {
        if (kind === 'artwork')  catnoToFiles[zipCatno].artwork  = f;
        if (kind === 'snippets') catnoToFiles[zipCatno].snippets = f;
      }
    }
    return catnoToFiles;
  }

  // ── DERIVATIONS ───────────────────────────────────────────────
  // Year from JSON `release` field. Examples: "W 07 - 2023" / "Week 03 / 2024".
  function yearFromRelease(release) {
    const m = String(release || '').match(/(20\d{2}|19\d{2})/);
    return m ? parseInt(m[1], 10) : '';
  }

  // Weight from format string. Falls back to 500g (standard 12").
  function gramsFromFormat(fmt) {
    const f = String(fmt || '').toLowerCase();
    if (/3\s*(?:x\s*)?lp|3lp|triple/.test(f)) return '1300';
    if (/2\s*(?:x\s*)?lp|2lp|double|2\s*x\s*12/.test(f)) return '900';
    if (/7\s*"|7\s*inch|7''/.test(f))                     return '180';
    return '500';
  }

  // Genre tags from JSON `tag` field. Rush Hour stacks tags newline-separated
  // ("House\nDetroit"). We split, trim, dedupe.
  function genresFromTag(tag) {
    if (!tag) return [];
    const out = new Set();
    for (const piece of String(tag).split(/[\n,;/]/)) {
      const t = piece.trim();
      if (t) out.add(t);
    }
    return Array.from(out);
  }

  // ── INPUT HANDLERS ────────────────────────────────────────────
  const onJson = async (file) => {
    if (!file) return;
    setError(''); setStatus('parsing');
    try {
      const items = await parseOrderJSON(file);
      setOrderItems(items);
      setJsonFile(file.name);
      setStatus('idle');
    } catch (e) {
      setError('JSON parse error: ' + e.message); setStatus('idle');
    }
  };

  const assignZips = (filesList) => {
    const arr = [...filesList].filter(f => /\.zip$/i.test(f.name));
    setZipFiles(prev => {
      const existing = new Set(prev.map(f => f.name));
      return [...prev, ...arr.filter(f => !existing.has(f.name))];
    });
  };

  // Recompute ZIP index when either input changes
  useEffect(() => {
    if (!zipFiles.length || !orderItems.length) {
      setZipIndex({});
      return;
    }
    setZipIndex(buildZipIndex(zipFiles, orderItems));
  }, [zipFiles, orderItems]);

  // ── PROCESSING PIPELINE ───────────────────────────────────────
  const process = async () => {
    if (!orderItems.length) { setError('Need order JSON first'); return; }
    setError(''); setStatus('processing'); setResults([]);
    try {
      const JSZip = await loadJSZip();
      const total = orderItems.length;
      const processed = [];

      for (let i = 0; i < orderItems.length; i++) {
        const meta = orderItems[i];
        const catno = meta.catno || '';
        setProgress({ done:i, total, current:`${catno} — preparing…` });

        const qty = meta.qty || 1;
        const dealerPrice = meta.dealerPrice;
        const rawPrice = dealerPrice * (1 + margin / 100);
        const price = (Math.ceil(rawPrice) - 0.01).toFixed(2);

        const artist = (meta.artist || '').trim();
        const title  = (meta.title  || '').trim() || catno;
        const label  = (meta.label  || '').trim();
        const year   = yearFromRelease(meta.release);
        const grams  = gramsFromFormat(meta.format);
        const desc   = (meta.description || '').trim();
        const slug   = meta.slug || '';
        const catnoKey = normCatno(catno);
        const handle = catno.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+$/,'') || slug || 'unknown';
        const safeKey = catno.replace(/[^A-Za-z0-9_-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'') || slug;

        // ── COVER (artwork ZIP → R2) ──────────────────────────
        let coverUrl = '';
        let itemError = '';
        const zipPair = zipIndex[catnoKey];
        const artworkZip = zipPair?.artwork;
        if (artworkZip) {
          try {
            setProgress({ done:i, total, current:`${catno} — extracting artwork…` });
            const zip = await JSZip.loadAsync(artworkZip);
            const files = Object.values(zip.files).filter(f => !f.dir);
            const imgFiles = files.filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f.name));
            const real = imgFiles.find(f => /album_cover|front|cover|sleeve/i.test(f.name));
            const coverFile = real || imgFiles[0];
            if (coverFile) {
              setProgress({ done:i, total, current:`${catno} — uploading cover…` });
              const blob = await coverFile.async('blob');
              const ext  = (coverFile.name.match(/\.([a-z0-9]+)$/i) || [,'jpg'])[1].toLowerCase();
              const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
              coverUrl = await uploadToR2(blob, `covers/${safeKey}.${ext}`, mime);
            }
          } catch (e) { itemError = 'Artwork: ' + e.message; }
        }

        // ── COVER FALLBACK: coverImageUrl from product page ───
        // For releases where Rush Hour has no "Download Artwork" file but the
        // product page does show a cover inline (objectstore.true.nl, ~285x285).
        // The bookmarklet records this URL on each item.
        //
        // We can't fetch objectstore.true.nl directly from the browser — they
        // don't return CORS headers. Use the worker's mirror endpoint, which
        // does the fetch server-side and stores the image straight into R2.
        // Allowlist enforced server-side; see worker MIRROR_ALLOWED_HOSTS.
        if (!coverUrl && meta.coverImageUrl) {
          try {
            setProgress({ done:i, total, current:`${catno} — fetching inline cover…` });
            // Pick extension from URL (usually .jpg.webp or .jpg). Default to .jpg.
            const ext = (meta.coverImageUrl.match(/\.(jpe?g|png|webp)(?:[?#]|$)/i) || [,'jpg'])[1].toLowerCase();
            const r = await fetch(`${WORKER_URL}?action=mirror`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: meta.coverImageUrl, key: `covers/${safeKey}.${ext}` }),
            });
            const d = await r.json();
            if (r.ok && d.url) {
              coverUrl = d.url;
              itemError = ''; // clear any prior "Artwork:" error if fallback succeeded
            } else if (!itemError) {
              itemError = 'Cover fallback: ' + (d.error || `HTTP ${r.status}`);
            }
          } catch (e) { if (!itemError) itemError = 'Cover fallback: ' + e.message; }
        }

        if (!coverUrl && !itemError) itemError = 'No artwork available';

        // ── AUDIO (snippets ZIP → R2 per track) ───────────────
        const tracks = [];
        const snippetsZip = zipPair?.snippets;
        if (snippetsZip) {
          try {
            setProgress({ done:i, total, current:`${catno} — extracting snippets…` });
            const zip = await JSZip.loadAsync(snippetsZip);
            const files = Object.values(zip.files).filter(f => !f.dir);
            const audioFiles = files
              .filter(f => /\.(mp3|wav|flac|aac|ogg|m4a)$/i.test(f.name))
              .sort((a, b) => a.name.localeCompare(b.name));

            const jsonTracks = Array.isArray(meta.tracks) ? meta.tracks : [];
            for (let a = 0; a < audioFiles.length; a++) {
              const af = audioFiles[a];
              const safeFilename = af.name.split('/').pop().replace(/[^A-Za-z0-9._-]+/g, '-');
              setProgress({ done:i, total, current:`${catno} — audio ${a+1}/${audioFiles.length}…` });
              const blob = await af.async('blob');
              const url = await uploadToR2(blob, `audio/${safeKey}/${safeFilename}`, 'audio/mpeg');
              const trackName = (jsonTracks[a] || '').trim()
                || af.name.split('/').pop().replace(/\.[^.]+$/, '').replace(/^[ab]\d+[\s_.\-]*/i, '');
              tracks.push({ name: trackName, url });
            }
          } catch (e) { if (!itemError) itemError = 'Snippets: ' + e.message; }
        } else if (!itemError) {
          itemError = 'No snippets ZIP';
        }

        // ── TAGS (D1) ────────────────────────────────────────
        const genres = genresFromTag(meta.tag);
        const tagParts = ['vinyl', 'source:mt'];
        if (label) tagParts.push(`label:${label}`);
        for (const g of genres) tagParts.push(`genre:${g}`);
        if (year) tagParts.push(String(year));
        const shopifyTags = tagParts.join(', ');

        // ── BUILD CSV ROW ────────────────────────────────────
        const descHtml  = buildDescriptionHtml({ artist, title, label, year, tracks, sourceNotes: desc });
        const audioHtml = tracks.length ? `<script type="application/json" id="tracks">${JSON.stringify(tracks)}<\/script>` : '';

        processed.push({
          _catno: catno, _title: title, _artist: artist,
          _coverUrl: coverUrl, _tracks: tracks, _error: itemError,
          _draft: false,
          'Handle': handle,
          'Title': title,
          'Body (HTML)': `${descHtml}${audioHtml}`,
          'Vendor': artist,
          'Product Category': 'Media > Music & Sound Recordings > Vinyl',
          'Type': '',
          'Tags': shopifyTags,
          'Published': 'TRUE',
          'Option1 Name':'Title','Option1 Value':'Default Title','Option1 Linked To':'',
          'Option2 Name':'','Option2 Value':'','Option2 Linked To':'',
          'Option3 Name':'','Option3 Value':'','Option3 Linked To':'',
          'Variant SKU': catno,
          'Variant Grams': grams,
          'Variant Inventory Tracker': 'shopify',
          'Variant Inventory Qty': String(qty),
          'Variant Inventory Policy': 'continue',
          'Variant Fulfillment Service': 'manual',
          'Variant Price': price,
          'Variant Compare At Price': '',
          'Variant Requires Shipping': 'TRUE',
          'Variant Taxable': 'TRUE',
          'Unit Price Total Measure':'','Unit Price Total Measure Unit':'',
          'Unit Price Base Measure':'','Unit Price Base Measure Unit':'',
          'Variant Barcode': meta.barcode || meta.sku || '',
          'Image Src': coverUrl,
          'Image Position': coverUrl ? '1' : '',
          'Image Alt Text': coverUrl ? `${title} - ${artist}` : '',
          'Gift Card': 'FALSE','SEO Title':'','SEO Description':'',
          'Variant Image':'','Variant Weight Unit':'kg',
          'Variant Tax Code':'','Cost per item': dealerPrice.toFixed(2),
          'Status':'active',
        });
        setProgress({ done:i+1, total, current:'' });
      }
      setResults(processed);
      setStatus('review');
    } catch (e) {
      setError(e.message); setStatus('idle');
    }
  };

  const downloadCSV = () => {
    const CSV_KEYS = results.length ? Object.keys(results[0]).filter(k => !k.startsWith('_')) : [];
    const lines = [
      CSV_KEYS.join(','),
      ...results.map(row => CSV_KEYS.map(h => `"${String(row[h]||'').replace(/"/g,'""')}"`).join(','))
    ];
    const blob = new Blob([lines.join('\n')], { type:'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rushhour_shopify_import.csv';
    a.click();
  };

  // ── DERIVED STATS ─────────────────────────────────────────────
  const pct = progress.total ? Math.round((progress.done/progress.total)*100) : 0;
  const matchedBoth = Object.values(zipIndex).filter(v => v.artwork && v.snippets).length;

  // ── RENDER ────────────────────────────────────────────────────
  return (
    <div>
      <p style={{fontSize:10,color:S.muted,margin:'0 0 14px',lineHeight:1.6}}>
        Drop the order JSON (from the bookmarklet) and all artwork+snippets
        ZIPs. The JSON carries dealer prices, quantities, and metadata —
        catnos match JSON↔ZIPs to attach covers and audio. Builds the Shopify
        CSV in one pass.
      </p>

      <div
        onDragOver={e=>e.preventDefault()}
        onDrop={e=>{
          e.preventDefault();
          const fl = [...e.dataTransfer.files];
          const json = fl.find(f => /\.json$/i.test(f.name));
          if (json) onJson(json);
          assignZips(fl);
        }}
        style={{
          border:`2px dashed ${(jsonFile||zipFiles.length)?S.accent:S.border}`,
          borderRadius:3, padding:'20px', textAlign:'center', marginBottom:14,
          transition:'border 0.15s'
        }}
      >
        <div style={{fontSize:28,marginBottom:6}}>💎</div>
        <div style={{fontSize:11,color:(jsonFile||zipFiles.length)?S.accent:S.muted,fontWeight:700,letterSpacing:1,textTransform:'uppercase',marginBottom:10}}>
          Rush Hour · Drop order JSON + ZIPs
        </div>
        <div style={{display:'flex',gap:8,justifyContent:'center',flexWrap:'wrap'}}>
          <input ref={jsonRef} type="file" accept=".json" style={{display:'none'}} onChange={e=>{if(e.target.files[0])onJson(e.target.files[0]);e.target.value='';}} />
          <input ref={zipRef}  type="file" accept=".zip"  multiple style={{display:'none'}} onChange={e=>{assignZips(e.target.files);e.target.value='';}} />
          <button onClick={()=>jsonRef.current.click()}
            style={{background:jsonFile?S.accent:S.border,border:'none',color:jsonFile?'#080808':S.muted,cursor:'pointer',fontSize:9,padding:'6px 14px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
            {jsonFile?`✓ ${jsonFile}`:'+ Order JSON'}
          </button>
          <button onClick={()=>zipRef.current.click()}
            style={{background:zipFiles.length?S.accent:S.border,border:'none',color:zipFiles.length?'#080808':S.muted,cursor:'pointer',fontSize:9,padding:'6px 14px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
            {zipFiles.length?`✓ ${zipFiles.length} ZIPs`:'+ ZIPs'}
          </button>
          {zipFiles.length>0&&<button onClick={()=>setZipFiles([])} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,padding:'6px 10px',borderRadius:2,fontFamily:'inherit'}}>Clear ZIPs</button>}
        </div>
      </div>

      {(orderItems.length>0 || zipFiles.length>0) && status==='idle' && (
        <div style={{marginBottom:12,fontSize:10,color:S.muted,display:'flex',gap:16,flexWrap:'wrap',padding:'8px 14px',background:S.bg,border:`1px solid ${S.border}`,borderRadius:4}}>
          <span>JSON items: <b style={{color:S.text}}>{orderItems.length}</b></span>
          {orderItems.length>0 && zipFiles.length>0 && (
            <>
              <span>ZIPs: <b style={{color:S.text}}>{zipFiles.length}</b> ({matchedBoth} pairs)</span>
              <span>Catnos matched: <b style={{color: matchedBoth===orderItems.length ? S.accent : '#ff8800'}}>{matchedBoth}/{orderItems.length}</b></span>
            </>
          )}
        </div>
      )}

      {orderItems.length>0 && status==='idle' && (
        <div style={{display:'flex',gap:12,alignItems:'center',marginBottom:12,flexWrap:'wrap'}}>
          <div style={{display:'flex',alignItems:'center',gap:6}}>
            <span style={{fontSize:10,color:S.muted}}>Margin %</span>
            <input type="number" value={margin} onChange={e=>setMargin(parseFloat(e.target.value)||60)}
              style={{width:70,padding:'5px 8px',background:S.surf,border:`1px solid ${S.border}`,borderRadius:2,color:S.text,fontFamily:'monospace',fontSize:12,textAlign:'center',outline:'none'}} />
          </div>
          <span style={{fontSize:9,color:S.muted}}>
            e.g. €8.10 × {(1+margin/100).toFixed(2)} = €{(8.10*(1+margin/100)).toFixed(2)} → €{(Math.ceil(8.10*(1+margin/100))-0.01).toFixed(2)}
          </span>
          <div style={{flex:1}}/>
          <Btn ch={`🚀 Process ${orderItems.length} releases`} onClick={process} full />
        </div>
      )}

      {status==='processing' && (
        <div style={{padding:14,background:S.bg,borderRadius:2,border:`1px solid ${S.border}`,marginBottom:12}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
            <span style={{fontSize:10,color:S.accent,fontWeight:700,letterSpacing:1}}>PROCESSING…</span>
            <span style={{fontSize:10,color:S.muted}}>{progress.done} / {progress.total} · {pct}%</span>
          </div>
          <div style={{height:3,background:S.border,borderRadius:2,overflow:'hidden',marginBottom:8}}>
            <div style={{height:'100%',background:S.accent,width:`${pct}%`,transition:'width 0.3s'}} />
          </div>
          {progress.current && <div style={{fontSize:9,color:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>→ {progress.current}</div>}
        </div>
      )}

      {error && (
        <div style={{marginBottom:12,padding:10,background:'#1a0000',border:`1px solid ${S.danger}44`,borderRadius:2,fontSize:10,color:S.danger}}>{error}</div>
      )}

      {status==='review' && results.length>0 && (
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
            <div>
              <span style={{fontSize:11,color:S.accent,fontWeight:700}}>✓ {results.length} releases</span>
              <span style={{fontSize:9,color:S.muted,marginLeft:10}}>
                {results.filter(r=>r._coverUrl).length} covers · {results.filter(r=>r._tracks?.length>0).length} audio
                {results.filter(r=>r._error).length>0 ? ` · ${results.filter(r=>r._error).length} errors` : ''}
              </span>
            </div>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:8,maxHeight:500,overflowY:'auto',padding:4}}>
            {results.map((r,i)=>(
              <div key={i} style={{background:S.surf,border:`1px solid ${r._error?S.danger:S.border}`,borderRadius:3,overflow:'hidden'}}>
                <div style={{position:'relative',paddingBottom:'100%',background:'#1a1a2e'}}>
                  {r._coverUrl
                    ? <img src={r._coverUrl} alt="" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'}} onError={e=>e.target.style.display='none'} />
                    : <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:24}}>🎵</div>
                  }
                  {r._tracks?.length>0 && <div style={{position:'absolute',bottom:4,left:4,background:'rgba(0,0,0,0.75)',borderRadius:2,fontSize:8,color:S.accent,padding:'2px 6px'}}>▶ {r._tracks.length}</div>}
                  {!r._coverUrl && <div style={{position:'absolute',top:4,right:4,background:'#ff8800',borderRadius:2,fontSize:7,color:'#080808',padding:'2px 5px',fontWeight:700}}>NO IMG</div>}
                  {r._error && <div style={{position:'absolute',bottom:4,right:4,background:S.danger,borderRadius:2,fontSize:7,color:'#fff',padding:'2px 5px',fontWeight:700}}>ERR</div>}
                </div>
                <div style={{padding:'8px 8px 6px'}}>
                  <div style={{fontSize:9,color:S.muted,fontFamily:'monospace',marginBottom:2}}>{r._catno}</div>
                  <div style={{fontSize:10,fontWeight:700,color:S.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r._title||r._catno}</div>
                  <div style={{fontSize:9,color:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r._artist||'—'}</div>
                  <div style={{fontSize:10,color:S.accent,marginTop:3,fontWeight:700}}>€{r['Variant Price']}</div>
                  {r._error && <div style={{fontSize:8,color:S.danger,marginTop:4,lineHeight:1.4}}>{r._error}</div>}
                </div>
              </div>
            ))}
          </div>
          <div style={{marginTop:14,display:'flex',justifyContent:'flex-end'}}>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── ADMIN PANEL ────────────────────────────────────────────────
// ── INSTAGRAM STORIES GENERATOR ────────────────────────────────
// Builds a 3-shot Instagram Story for a release:
//   Shot 1 — cover + kick-synced waveform (audio 0:00–0:05)
//   Shot 2 — artist photo (Spotify) + editable quote (audio 0:05–0:10)
//   Shot 3 — House Only logo + title + "Tap to shop →" (audio 0:10–0:15)
// Audio is always the store's own R2 snippet (curated highlight). Spotify is
// used ONLY to fetch the artist press photo for Shot 2.
//
// PHASE 1 (this commit): release search + pick + load raw materials into a
// preview panel. No canvas/MP4 yet — that's a later phase. This proves the
// data pipeline (Shopify search → cover, audio snippets, description, artist
// photo from Spotify) before we build rendering on top of it.
// ── KICK DETECTION (Stories Shot 1) ────────────────────────────
// Analyzes an audio snippet to find the kick drum and score how strong/steady
// its 4/4 is. For a house music store, we want Shot 1 to feature the track with
// the best four-to-the-floor — "people expect that from House Only."
//
// How it works: decode the audio, run it through a low-pass filter (~120Hz) to
// isolate the kick band, then find energy peaks (onsets). Score combines:
//   - presence: is there real low-end energy at all? (rules out beatless intros)
//   - regularity: are the kicks evenly spaced? (a steady 4/4 scores high)
//   - tempo fit: ~115-130 BPM (house range) scores highest
// Returns { kicks:[seconds], score:0-100, bpm } — or score 0 on no clear kick.
async function analyzeKicks(audioUrl) {
  try {
    const resp = await fetch(audioUrl);
    if (!resp.ok) return { kicks: [], score: 0, bpm: 0, error: `fetch ${resp.status}` };
    const arrayBuf = await resp.arrayBuffer();
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    // Decode with a temporary online context (decodeAudioData needs one).
    const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuf = await tmpCtx.decodeAudioData(arrayBuf.slice(0));
    tmpCtx.close();

    const duration = audioBuf.duration;
    const sampleRate = audioBuf.sampleRate;
    // Render through a BANDPASS centered on the kick body (~45-100Hz) to reduce
    // overlap with sustained bass lines that share the low-end. A lowpass alone
    // (old approach) let bass notes through and made the pulse fire on bass.
    const offline = new AC(1, Math.ceil(duration * sampleRate), sampleRate);
    const src = offline.createBufferSource();
    src.buffer = audioBuf;
    const hp = offline.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 45;    // cut sub-rumble below the kick fundamental
    hp.Q.value = 0.7;
    const lp = offline.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 130;   // kick body extends to ~120-150Hz; widen to catch it
    lp.Q.value = 0.7;
    src.connect(hp);
    hp.connect(lp);
    lp.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    const data = rendered.getChannelData(0);

    // Energy envelope in ~10ms windows.
    const win = Math.floor(sampleRate * 0.01);
    const env = [];
    for (let i = 0; i < data.length; i += win) {
      let sum = 0;
      for (let j = i; j < i + win && j < data.length; j++) sum += data[j] * data[j];
      env.push(Math.sqrt(sum / win));
    }
    if (!env.length) return { kicks: [], score: 0, bpm: 0 };
    const maxEnv = Math.max(...env);
    if (maxEnv < 0.005) return { kicks: [], score: 0, bpm: 0 }; // basically silent low-end

    // ONSET DETECTION (transient, not energy level). A kick is a SUDDEN RISE in
    // low-band energy — a sharp attack. A sustained bass note has high but FLAT
    // energy (its flux is ~0 once sounding), so it won't trigger. We compute the
    // positive energy flux (rise vs the previous window) and pick peaks in THAT,
    // not in raw energy. This is what stops the pulse firing on bass lines.
    const flux = [0];
    for (let i = 1; i < env.length; i++) flux.push(Math.max(0, env[i] - env[i - 1]));
    const maxFlux = Math.max(...flux);
    if (maxFlux < 0.002) return { kicks: [], score: 0, bpm: 0, kickStrength: 0, energy: 0 };
    // Threshold on the RISE, plus require the absolute energy to be substantial
    // (so we don't catch tiny rises in quiet passages).
    const fluxThresh = maxFlux * 0.30;   // moderate threshold; grid filter below cleans the rest
    const energyFloor = maxEnv * 0.20;   // body requirement
    const minGapWins = Math.floor(0.12 / 0.01); // 120ms min between kicks
    const kicks = [];
    let lastIdx = -minGapWins;
    for (let i = 1; i < flux.length - 1; i++) {
      const isRisePeak = flux[i] >= fluxThresh && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1];
      const hasBody = env[i] >= energyFloor || (env[i + 1] || 0) >= energyFloor;
      if (isRisePeak && hasBody && (i - lastIdx) >= minGapWins) {
        kicks.push(i * 0.01);
        lastIdx = i;
      }
    }
    if (kicks.length < 3) return { kicks, score: kicks.length ? 15 : 0, bpm: 0, kickStrength: 0, energy: 0 };

    // Intervals between kicks → tempo + a sanity check on steadiness.
    const intervals = [];
    for (let i = 1; i < kicks.length; i++) intervals.push(kicks[i] - kicks[i - 1]);
    const meanInt = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((a, b) => a + (b - meanInt) ** 2, 0) / intervals.length;
    const cv = meanInt > 0 ? Math.sqrt(variance) / meanInt : 1; // lower = steadier

    // Raw BPM, then TEMPO FOLDING: hi-hats/claps/off-beats can double the
    // detected rate (e.g. 240bpm = real 120). Fold anything >150 down by halving
    // until it lands in the house-realistic 90-150 range. Also fold very low
    // (half-time detections) up.
    let bpm = meanInt > 0 ? Math.round(60 / meanInt) : 0;
    while (bpm > 150) bpm = Math.round(bpm / 2);
    while (bpm > 0 && bpm < 90) bpm = bpm * 2;

    // GRID FILTER — the raw detector is intentionally generous (it over-detects:
    // hi-hats, bass transients, ghost notes). Rather than fight the threshold,
    // we keep only detections that land ON the beat grid. Build a grid from the
    // folded BPM (beat = 60/bpm seconds), then for each grid slot keep the
    // single strongest nearby detection (within ±35% of a beat). This collapses
    // ~575 noisy onsets down to the ~50-70 real kicks aligned to the pulse, so
    // the cover punches exactly on the four-to-the-floor.
    let gridKicks = kicks;
    if (bpm >= 90 && bpm <= 150 && kicks.length > 6) {
      const beat = 60 / bpm;                       // seconds per beat
      const tol = beat * 0.35;                     // how close to a grid slot counts
      const start = kicks[0];
      const end = kicks[kicks.length - 1];
      // Strength of a detection ≈ the low-band energy at its window.
      const strengthAt = (t) => env[Math.round(t / 0.01)] || 0;
      const snapped = [];
      for (let g = start; g <= end + beat; g += beat) {
        // candidates near this grid slot
        let best = null, bestS = -1;
        for (const k of kicks) {
          if (Math.abs(k - g) <= tol) {
            const s = strengthAt(k);
            if (s > bestS) { bestS = s; best = k; }
          }
        }
        if (best != null && (snapped.length === 0 || best - snapped[snapped.length - 1] > beat * 0.5)) {
          snapped.push(best);
        }
      }
      if (snapped.length >= 4) gridKicks = snapped;
    }

    // SCORING — for a House Only story we want the track that HITS HARDEST with
    // a solid 4/4, not the most skeletal/clean one. So we reward kick strength
    // and overall energy, and treat steadiness as a pass/fail floor rather than
    // the dominant factor (the old scoring favored sparse dubs — wrong).
    //
    // kickStrength: how punchy the kick band is (peak low-end amplitude).
    const kickStrength = Math.min(1, maxEnv / 0.18);
    // energy: overall RMS of the low-passed signal = how much "drive"/density.
    const meanEnv = env.reduce((a, b) => a + b, 0) / env.length;
    const energy = Math.min(1, meanEnv / 0.06);
    // steadyFloor: 1 if it holds a recognizable 4/4 (cv reasonably low), else
    // scaled down. Acts as a gate, not the main driver.
    const steadyFloor = cv < 0.45 ? 1 : Math.max(0.4, 1 - (cv - 0.45));
    // tempoInRange: small bonus for sitting in the house pocket once folded.
    const tempoInRange = bpm >= 110 && bpm <= 132 ? 1 : (bpm >= 100 && bpm <= 140 ? 0.6 : 0.2);

    // Final: punch (45) + energy (35) + tempo pocket (20), all gated by steadiness.
    const score = Math.round((kickStrength * 45 + energy * 35 + tempoInRange * 20) * steadyFloor);
    return { kicks: gridKicks, rawKicks: kicks, env, winSec: 0.01, score: Math.min(100, score), bpm, kickStrength: Math.round(kickStrength * 100), energy: Math.round(energy * 100) };
  } catch (e) {
    return { kicks: [], score: 0, bpm: 0, kickStrength: 0, energy: 0, error: e?.message || 'analyze failed' };
  }
}

// Analyze all snippets for a release and pick the one with the strongest 4/4.
// Returns { tracks:[{name,url,score,bpm,kicks}], bestIndex }.
async function pickBestTrack(tracks) {
  const analyzed = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t || !t.url) { analyzed.push({ ...t, origIndex: i, score: 0, bpm: 0, kicks: [], kickStrength: 0, energy: 0 }); continue; }
    const a = await analyzeKicks(t.url);
    analyzed.push({ ...t, origIndex: i, score: a.score, bpm: a.bpm, kicks: a.kicks, rawKicks: a.rawKicks || [], env: a.env || [], winSec: a.winSec || 0.01, kickStrength: a.kickStrength || 0, energy: a.energy || 0 });
  }
  // B-intermediate: sort by score descending so the punchiest tracks rise to the
  // top as a triage aid. The top one is pre-selected as a SOFT suggestion (no
  // authoritative "best" label) — Eduardo's ear makes the final call.
  analyzed.sort((a, b) => b.score - a.score);
  const bestIndex = 0; // after sort, the strongest is first
  return { tracks: analyzed, bestIndex };
}

// ── SHOT 1 CANVAS (Stories) ────────────────────────────────────
// Renders Shot 1 at 1080x1920 (story vertical): cover full-bleed, House Only
// system overlay (logo, catno/label/title), a reactive waveform, and — the
// signature touch — the cover PUNCHES 1-2% on each detected kick. Plays the
// chosen snippet and animates in sync using the kicks[] timestamps from the
// analysis. This is preview-only (4A-2); MP4 export is Phase 5.
//
// Cover image is loaded with crossOrigin='anonymous' so the canvas stays
// untainted — required for the later MP4 export. R2 now serves permissive CORS
// (configured today), so this works for both cover and audio.
function Shot1Canvas({ release, track }) {
  const canvasRef = useRef(null);
  const audioRef  = useRef(null);
  const rafRef    = useRef(null);
  const coverImgRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);

  const W = 1080, H = 1920;
  // SYNTHETIC PULSE — the detected kick timestamps proved unreliable (low-end
  // energy is a continuous mass in mastered house, not clean peaks). Instead we
  // drive the cover punch from a perfectly regular four-to-the-floor grid: use
  // the detected BPM IF it lands in the believable house range (115-128),
  // otherwise fall back to a steady 120. Result: a clean, danceable pulse every
  // time, no fragile detection.
  const detectedBpm = track?.bpm || 0;
  const pulseBpm = (detectedBpm >= 115 && detectedBpm <= 128) ? detectedBpm : 120;
  const beatSec = 60 / pulseBpm;

  // Load the cover once (crossOrigin for untainted canvas).
  useEffect(() => {
    setReady(false);
    coverImgRef.current = null;
    const url = coverSrc(release?.coverUrl);
    if (!url) { drawFrame(0, 1); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { coverImgRef.current = img; setReady(true); drawFrame(0, 1); };
    img.onerror = () => { coverImgRef.current = null; setReady(true); drawFrame(0, 1); };
    img.src = url;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [release?.coverUrl, track?.url]);

  // Punch factor at time t: 1.0 baseline, spiking right on each synthetic beat,
  // decaying over ~160ms for a sharp, dry hit (not a soft throb).
  const punchAt = (t) => {
    const phase = t % beatSec;        // time since the last beat
    if (phase < 0.16) {
      const p = 1 - phase / 0.16;     // linear decay over 160ms
      return 1 + p * 0.025;           // up to +2.5%
    }
    return 1;
  };

  const drawFrame = (t, scaleOverride) => {
    const cv = canvasRef.current; if (!cv) return;
    const ctx = cv.getContext('2d');
    const scale = scaleOverride != null ? scaleOverride : punchAt(t);

    // Background black.
    ctx.fillStyle = '#080808';
    ctx.fillRect(0, 0, W, H);

    // Cover: square, centered horizontally, upper-middle. Punch scales it.
    const img = coverImgRef.current;
    const coverSize = W * 0.70;
    const cx = W / 2, cy = H * 0.32;
    const s = coverSize * scale;
    if (img) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.drawImage(img, -s / 2, -s / 2, s, s);
      ctx.restore();
    } else {
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
    }

    // Logo top-left.
    ctx.textBaseline = 'top';
    ctx.font = '900 44px Inter, sans-serif';
    ctx.fillStyle = '#efefef';
    ctx.fillText('HOUSE', 60, 70);
    ctx.fillStyle = '#c8ff00';
    ctx.fillText('ONLY', 60, 116);

    // Catno top-right (mono).
    ctx.font = '500 26px "JetBrains Mono", monospace';
    ctx.fillStyle = '#585858';
    ctx.textAlign = 'right';
    ctx.fillText(`${release?.catalog || ''}`, W - 60, 80);
    ctx.textAlign = 'left';

    // Waveform band low on the frame, pulsing on kicks.
    const wfY = H * 0.56, wfH = 80, bars = 60, gap = 6;
    const bw = (W - 120 - gap * (bars - 1)) / bars;
    for (let i = 0; i < bars; i++) {
      const base = Math.abs(Math.sin(i * 0.5) * Math.cos(i * 0.3));
      const h = (12 + base * 60) * (scale > 1.001 ? 1 + (scale - 1) * 6 : 1);
      ctx.fillStyle = '#c8ff00';
      ctx.globalAlpha = 0.35 + base * 0.5;
      ctx.fillRect(60 + i * (bw + gap), wfY + (wfH - h) / 2, bw, h);
    }
    ctx.globalAlpha = 1;

    // Label / title / artist anchored bottom.
    let by = H * 0.64;
    ctx.font = '700 22px Inter, sans-serif';
    ctx.fillStyle = '#585858';
    ctx.fillText((release?.label || '').toUpperCase(), 60, by);
    by += 40;
    ctx.font = '800 56px Inter, sans-serif';
    ctx.fillStyle = '#efefef';
    // Wrap title if long.
    const title = release?.title || '';
    const maxW = W - 120;
    let line = '', yy = by;
    const words = title.split(' ');
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, 60, yy); yy += 64; line = w; }
      else line = test;
    }
    ctx.fillText(line, 60, yy);
    by = yy + 64;
    ctx.font = '500 30px Inter, sans-serif';
    ctx.fillStyle = '#585858';
    ctx.fillText(release?.artist || '', 60, by);
  };

  // Animation loop while playing.
  const loop = () => {
    const a = audioRef.current;
    if (a) drawFrame(a.currentTime);
    rafRef.current = requestAnimationFrame(loop);
  };

  const togglePlay = () => {
    const a = audioRef.current; if (!a) return;
    if (playing) {
      a.pause(); setPlaying(false);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      drawFrame(a.currentTime || 0, 1);
    } else {
      a.currentTime = 0;
      a.play().then(() => {
        setPlaying(true);
        rafRef.current = requestAnimationFrame(loop);
      }).catch(() => {});
    }
  };

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={{ width: 240, height: 427, borderRadius: 4, border: `1px solid ${S.border}`, background: S.bg, display: 'block' }}
      />
      <audio ref={audioRef} src={track?.url || ''} crossOrigin="anonymous" preload="auto" onEnded={() => { setPlaying(false); if (rafRef.current) cancelAnimationFrame(rafRef.current); }} />
      <button onClick={togglePlay} disabled={!track?.url} style={{ marginTop: 10, width: 240, background: playing ? S.border : S.accent, color: playing ? S.text : '#080808', border: 'none', borderRadius: 2, cursor: track?.url ? 'pointer' : 'not-allowed', fontSize: 10, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase', padding: '9px 0' }}>
        {playing ? '■ Stop preview' : '▶ Preview Shot 1'}
      </button>
      <div style={{ fontSize: 9, color: S.accent, marginTop: 6, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 700 }}>
        Pulse {pulseBpm} bpm {pulseBpm === detectedBpm ? '(detected)' : '(fixed)'}
      </div>
    </div>
  );
}

// ── SHOT 2 CANVAS (Stories) ────────────────────────────────────
// Renders the knowledge line at 1080x1920 in the House Only system. Editorial
// reveal: the line wraps into rows and each row fades+slides in, staggered,
// over the first ~2.5s — then holds. Black background, the words are the hero.
// Preview-only (no audio here; audio is continuous and assembled in Phase 5).
function Shot2Canvas({ release, line }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const startRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const W = 1080, H = 1920;
  const text = (line || '').trim();
  // Match the exporter: duration depends on the line length (reveal + read).
  const DUR = (() => {
    try {
      const mc = document.createElement('canvas').getContext('2d');
      return shot2Layout(mc, W, H, text).dur;
    } catch { return 5.0; }
  })();

  // Wrap the line into rows at a given font size, returns array of strings.
  const wrapText = (ctx, str, font, maxW) => {
    ctx.font = font;
    const words = str.split(/\s+/);
    const rows = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && cur) { rows.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) rows.push(cur);
    return rows;
  };

  const drawFrame = (elapsed) => {
    const cv = canvasRef.current; if (!cv) return;
    const ctx = cv.getContext('2d');
    // Background: near-black with a very subtle vertical gradient.
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0c0c0c');
    g.addColorStop(1, '#060606');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Logo top, signature size.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '900 40px Inter, sans-serif';
    ctx.fillStyle = '#efefef';
    ctx.fillText('HOUSE', 70, 90);
    ctx.fillStyle = '#c8ff00';
    ctx.fillText('ONLY', 70, 134);

    // Knowledge line — top-anchored, adaptive font, revealed by row.
    // Uses the shared shot2Layout so the preview matches the export exactly.
    const L = shot2Layout(ctx, W, H, text);
    const { rows, fontSize, font, beat, cadence, startY, lineH } = L;

    ctx.font = font;
    ctx.textAlign = 'left';
    rows.forEach((row, i) => {
      const rowStart = beat + i * cadence;     // first line at beat 1 (0.5s)
      const dt = elapsed - rowStart;
      // Fade-in over ~0.35s.
      const fade = Math.max(0, Math.min(1, dt / 0.35));
      const alpha = 1 - Math.pow(1 - fade, 2); // easeOut
      // Subtle punch: scale 1.03 → 1.0 over 150ms right as the line lands.
      let punch = 1;
      if (dt >= 0 && dt < 0.15) punch = 1.03 - 0.03 * (dt / 0.15);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#efefef';
      const cyRow = startY + i * lineH;
      ctx.save();
      // Scale around the row's left-center for the punch.
      ctx.translate(80, cyRow + fontSize * 0.4);
      ctx.scale(punch, punch);
      ctx.fillText(row, 0, -fontSize * 0.4);
      ctx.restore();
    });
    ctx.globalAlpha = 1;

    // Context line at the bottom: artist · catalog (muted, mono). Lands one
    // half-bar after the last line.
    const metaStart = beat + rows.length * cadence;
    const ctxAlpha = Math.max(0, Math.min(1, (elapsed - metaStart) / 0.5));
    ctx.globalAlpha = ctxAlpha;
    ctx.font = '500 30px "JetBrains Mono", monospace';
    ctx.fillStyle = '#585858';
    ctx.textAlign = 'left';
    const meta = [release?.artist, release?.catalog].filter(Boolean).join('  ·  ');
    ctx.fillText(meta, 80, H - 540);
    ctx.globalAlpha = 1;
  };

  const loop = () => {
    const elapsed = (performance.now() - startRef.current) / 1000;
    drawFrame(elapsed);
    if (elapsed < DUR) rafRef.current = requestAnimationFrame(loop);
    else setPlaying(false);
  };

  const play = () => {
    if (playing) {
      setPlaying(false);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      drawFrame(DUR); // settle to final
      return;
    }
    startRef.current = performance.now();
    setPlaying(true);
    rafRef.current = requestAnimationFrame(loop);
  };

  // Draw the final (fully-revealed) frame on mount / when the line changes.
  useEffect(() => { drawFrame(DUR); if (rafRef.current) cancelAnimationFrame(rafRef.current); setPlaying(false); /* eslint-disable-next-line */ }, [text, release?.catalog]);
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  return (
    <div>
      <canvas ref={canvasRef} width={W} height={H} style={{ width: 240, height: 427, borderRadius: 4, border: `1px solid ${S.border}`, background: S.bg, display: 'block' }} />
      <button onClick={play} disabled={!text} style={{ marginTop: 10, width: 240, background: playing ? S.border : S.accent, color: playing ? S.text : '#080808', border: 'none', borderRadius: 2, cursor: text ? 'pointer' : 'not-allowed', fontSize: 10, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase', padding: '9px 0' }}>
        {playing ? '■ Replaying…' : '▶ Preview Shot 2'}
      </button>
      {!text && <div style={{ fontSize: 8, color: '#ff8800', marginTop: 6, letterSpacing: 1, textTransform: 'uppercase' }}>Generate & pick a knowledge line first</div>}
    </div>
  );
}

// ── SHOT 3 CANVAS (Stories) ────────────────────────────────────
// The closing brand shot at 1080x1920: HOUSE ONLY logo as the hero, a small
// cover reminder, title/artist/catalog, and a "Tap to shop →" CTA that pulses
// subtly on the 120 BPM beat — same heartbeat as Shots 1 and 2. The CTA pulse
// draws the eye to the call-to-action at the moment of the tap. Preview-only.
function Shot3Canvas({ release }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const startRef = useRef(0);
  const coverImgRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const W = 1080, H = 1920;
  const DUR = 5.0;
  const beatSec = 60 / 120; // 120 BPM

  useEffect(() => {
    coverImgRef.current = null;
    const url = coverSrc(release?.coverUrl);
    if (url) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { coverImgRef.current = img; drawFrame(0); };
      img.onerror = () => { coverImgRef.current = null; drawFrame(0); };
      img.src = url;
    } else { drawFrame(0); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [release?.coverUrl]);

  const drawFrame = (elapsed) => {
    const cv = canvasRef.current; if (!cv) return;
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0c0c0c'); g.addColorStop(1, '#060606');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // HOUSE ONLY logo — large but secondary (cover is the protagonist).
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 92px Inter, sans-serif';
    ctx.fillStyle = '#efefef';
    ctx.fillText('HOUSE', W / 2, H * 0.14);
    ctx.fillStyle = '#c8ff00';
    ctx.fillText('ONLY', W / 2, H * 0.14 + 92);

    // Cover — protagonist: large, centered upper-middle (~56% width).
    const cs = W * 0.56;
    const cxv = W / 2, cyv = H * 0.44;
    const img = coverImgRef.current;
    if (img) {
      ctx.drawImage(img, cxv - cs / 2, cyv - cs / 2, cs, cs);
    } else {
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(cxv - cs / 2, cyv - cs / 2, cs, cs);
    }

    // Title / artist / catalog under the cover.
    let ty = cyv + cs / 2 + 64;
    ctx.fillStyle = '#efefef';
    ctx.font = '800 52px Inter, sans-serif';
    ctx.fillText(release?.title || '', W / 2, ty);
    ty += 62;
    ctx.fillStyle = '#9a9a9a';
    ctx.font = '500 36px Inter, sans-serif';
    ctx.fillText(release?.artist || '', W / 2, ty);
    ty += 48;
    ctx.fillStyle = '#585858';
    ctx.font = '500 28px "JetBrains Mono", monospace';
    ctx.fillText(release?.catalog || '', W / 2, ty);

    // No drawn CTA — the Instagram link sticker (always visible) is the real,
    // tappable link. The bottom band is left clear so the sticker can sit there.
  };

  const loop = () => {
    const elapsed = (performance.now() - startRef.current) / 1000;
    drawFrame(elapsed);
    if (elapsed < DUR) rafRef.current = requestAnimationFrame(loop);
    else { setPlaying(false); drawFrame(0); }
  };

  const play = () => {
    if (playing) { setPlaying(false); if (rafRef.current) cancelAnimationFrame(rafRef.current); drawFrame(0); return; }
    startRef.current = performance.now();
    setPlaying(true);
    rafRef.current = requestAnimationFrame(loop);
  };

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  return (
    <div>
      <canvas ref={canvasRef} width={W} height={H} style={{ width: 240, height: 427, borderRadius: 4, border: `1px solid ${S.border}`, background: S.bg, display: 'block' }} />
      <button onClick={play} style={{ marginTop: 10, width: 240, background: playing ? S.border : S.accent, color: playing ? S.text : '#080808', border: 'none', borderRadius: 2, cursor: 'pointer', fontSize: 10, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase', padding: '9px 0' }}>
        {playing ? '■ Stop' : '▶ Preview Shot 3'}
      </button>
    </div>
  );
}

// ── STORY EXPORT (Phase 5) ─────────────────────────────────────
// Pure draw functions (ctx, W, H, data, t) that replicate each shot's render.
// The preview components keep their own draw logic untouched; these mirror it
// so the master export canvas can draw all three shots on one 15s timeline
// without disturbing what already works.

function exDrawShot1(ctx, W, H, release, coverImg, t) {
  const beatSec = 0.5; // 120 BPM pulse for the cover punch
  const phase = t % beatSec;
  const scale = phase < 0.16 ? 1 + (1 - phase / 0.16) * 0.025 : 1;
  ctx.fillStyle = '#080808'; ctx.fillRect(0, 0, W, H);
  // Cover lifted slightly (center at 0.35H) so the waveform + info below it all
  // finish above the sticker lane (~y1450). The bottom band is left clear for
  // the Instagram link sticker, which is visible across all 3 shots.
  const coverSize = W * 0.70, cx = W / 2, cy = H * 0.32, s = coverSize * scale;
  if (coverImg) { ctx.save(); ctx.translate(cx, cy); ctx.drawImage(coverImg, -s/2, -s/2, s, s); ctx.restore(); }
  else { ctx.fillStyle = '#1a1a2e'; ctx.fillRect(cx - s/2, cy - s/2, s, s); }
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  ctx.font = '900 44px Inter, sans-serif'; ctx.fillStyle = '#efefef'; ctx.fillText('HOUSE', 60, 70);
  ctx.fillStyle = '#c8ff00'; ctx.fillText('ONLY', 60, 116);
  ctx.font = '500 26px "JetBrains Mono", monospace'; ctx.fillStyle = '#585858';
  ctx.textAlign = 'right'; ctx.fillText(`${release?.catalog || ''}`, W - 60, 80); ctx.textAlign = 'left';
  const wfY = H * 0.56, wfH = 80, bars = 60, gap = 6;
  const bw = (W - 120 - gap * (bars - 1)) / bars;
  for (let i = 0; i < bars; i++) {
    const base = Math.abs(Math.sin(i * 0.5) * Math.cos(i * 0.3));
    const h = (12 + base * 60) * (scale > 1.001 ? 1 + (scale - 1) * 6 : 1);
    ctx.fillStyle = '#c8ff00'; ctx.globalAlpha = 0.35 + base * 0.5;
    ctx.fillRect(60 + i * (bw + gap), wfY + (wfH - h) / 2, bw, h);
  }
  ctx.globalAlpha = 1;
  let by = H * 0.64;
  ctx.font = '700 22px Inter, sans-serif'; ctx.fillStyle = '#585858';
  ctx.fillText((release?.label || '').toUpperCase(), 60, by);
  by += 40; ctx.font = '800 56px Inter, sans-serif'; ctx.fillStyle = '#efefef';
  const title = release?.title || '', maxW = W - 120;
  let line = '', yy = by;
  for (const w of title.split(' ')) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, 60, yy); yy += 64; line = w; }
    else line = test;
  }
  ctx.fillText(line, 60, yy); by = yy + 64;
  ctx.font = '500 30px Inter, sans-serif'; ctx.fillStyle = '#585858';
  ctx.fillText(release?.artist || '', 60, by);
}

// Shot 2 layout + timing. The knowledge line varies in length, so Shot 2 must
// last long enough to reveal every line AND leave time to read the full text.
// We wrap the text exactly as exDrawShot2 draws it, reveal one line per beat
// (1s, on the 120 BPM grid — the rhythm Eduardo likes), then hold the complete
// text for a read pause proportional to its length. Returns { rows, fontSize,
// font, beat, cadence, dur }. `measureCtx` is any 2D context for text metrics.
function shot2Layout(measureCtx, W, H, text) {
  text = (text || '').trim();
  const maxW = W - 160;
  // Vertical area for the line: below the logo (~220) down to above the meta
  // row (~H-220). The text is anchored to the TOP of this band (not centered),
  // so long phrases grow downward into the full available space instead of
  // overflowing off-screen.
  const topY = 300;
  const bottomY = H - 580;   // text ends ~y1340; the band below is the sticker lane (clear in all 3 shots)
  const availH = bottomY - topY;
  // Pick the largest font (from a preferred ladder) at which the wrapped text
  // fits availH. Long phrases automatically use a smaller size so every line
  // shows; short phrases stay big and punchy.
  const sizes = [80, 72, 64, 58, 52, 46, 42, 38];
  let chosen = sizes[sizes.length - 1], rows = [];
  for (const fs of sizes) {
    measureCtx.font = `800 ${fs}px Inter, sans-serif`;
    const words = text.split(/\s+/); const r = []; let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (measureCtx.measureText(test).width > maxW && cur) { r.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) r.push(cur);
    const lineH = fs * 1.3;
    if (r.length * lineH <= availH) { chosen = fs; rows = r; break; }
    chosen = fs; rows = r; // keep last (smallest) if none fit
  }
  const fontSize = chosen;
  const font = `800 ${fontSize}px Inter, sans-serif`;
  const lineH = fontSize * 1.3;
  const beat = 0.5;                 // 120 BPM
  const cadence = 1.0;              // one line per half-bar (constant — no compression)
  const lastLineStart = beat + (rows.length - 1) * cadence;
  const revealDone = lastLineStart + 0.35;            // last line finished fading in
  // Read pause after the full text is on screen: hold for 4s so the viewer can
  // actually read the whole knowledge line before cutting to Shot 3. (Reading
  // also happens progressively as each line lands, but the last line needs real
  // dwell time — 1s felt far too fast on first play.)
  const readPause = 4.0;
  const dur = Math.min(25, Math.max(5, revealDone + readPause));
  return { rows, fontSize, font, beat, cadence, dur, startY: topY, lineH };
}

function exDrawShot2(ctx, W, H, release, lineText, elapsed) {
  const text = (lineText || '').trim();
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0c0c0c'); g.addColorStop(1, '#060606');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = '900 40px Inter, sans-serif'; ctx.fillStyle = '#efefef'; ctx.fillText('HOUSE', 70, 90);
  ctx.fillStyle = '#c8ff00'; ctx.fillText('ONLY', 70, 134);
  const maxW = W - 160;
  const L = shot2Layout(ctx, W, H, text);
  const { rows, fontSize, font, beat, cadence, startY, lineH } = L;
  ctx.font = font;
  ctx.textAlign = 'left';
  rows.forEach((row, i) => {
    const rowStart = beat + i * cadence, dt = elapsed - rowStart;
    const fade = Math.max(0, Math.min(1, dt / 0.35));
    const alpha = 1 - Math.pow(1 - fade, 2);
    let punch = 1; if (dt >= 0 && dt < 0.15) punch = 1.03 - 0.03 * (dt / 0.15);
    ctx.globalAlpha = alpha; ctx.fillStyle = '#efefef';
    const cyRow = startY + i * lineH;
    ctx.save(); ctx.translate(80, cyRow + fontSize * 0.4); ctx.scale(punch, punch);
    ctx.fillText(row, 0, -fontSize * 0.4); ctx.restore();
  });
  ctx.globalAlpha = 1;
  const metaStart = beat + rows.length * cadence;
  const ctxAlpha = Math.max(0, Math.min(1, (elapsed - metaStart) / 0.5));
  ctx.globalAlpha = ctxAlpha;
  ctx.font = '500 30px "JetBrains Mono", monospace'; ctx.fillStyle = '#585858'; ctx.textAlign = 'left';
  ctx.fillText([release?.artist, release?.catalog].filter(Boolean).join('  ·  '), 80, H - 540);
  ctx.globalAlpha = 1;
}

function exDrawShot3(ctx, W, H, release, coverImg, elapsed) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0c0c0c'); g.addColorStop(1, '#060606');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // Logo: large but secondary (the cover is the protagonist of the close).
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '900 92px Inter, sans-serif'; ctx.fillStyle = '#efefef'; ctx.fillText('HOUSE', W/2, H*0.14);
  ctx.fillStyle = '#c8ff00'; ctx.fillText('ONLY', W/2, H*0.14 + 92);
  // Cover: protagonist — large, centered in the upper-middle.
  const cs = W * 0.56, cxv = W/2, cyv = H*0.44;
  if (coverImg) ctx.drawImage(coverImg, cxv - cs/2, cyv - cs/2, cs, cs);
  else { ctx.fillStyle = '#1a1a2e'; ctx.fillRect(cxv - cs/2, cyv - cs/2, cs, cs); }
  // Title / artist / catalog under the cover.
  let ty = cyv + cs/2 + 64;
  ctx.fillStyle = '#efefef'; ctx.font = '800 52px Inter, sans-serif'; ctx.fillText(release?.title || '', W/2, ty);
  ty += 62; ctx.fillStyle = '#9a9a9a'; ctx.font = '500 36px Inter, sans-serif'; ctx.fillText(release?.artist || '', W/2, ty);
  ty += 48; ctx.fillStyle = '#585858'; ctx.font = '500 28px "JetBrains Mono", monospace'; ctx.fillText(release?.catalog || '', W/2, ty);
  // NOTE: no drawn CTA button — the Instagram link sticker (always visible) is
  // the real, tappable link. The bottom band (~y 1450-1700) is left clear so
  // the sticker can sit there without covering anything.
}

// StoryExporter — master 15s timeline: Shot1 (0-5s), Shot2 (5-10s), Shot3
// (10-15s), with the chosen track's audio playing under it. Records the canvas
// + audio via MediaRecorder to a WebM and downloads it. (MP4 conversion is 5B.)
// Also copies the product URL to the clipboard for the Instagram link sticker.
function StoryExporter({ release, track, line }) {
  const canvasRef = useRef(null);
  const audioRef = useRef(null);
  const coverImgRef = useRef(null);
  const recRef = useRef(null);
  const rafRef = useRef(null);
  const [status, setStatus] = useState('idle'); // idle | preparing | recording | done | error
  const [msg, setMsg] = useState('');
  const W = 1080, H = 1920, SHOT = 5;
  // Shot 2 duration depends on the knowledge line's length (reveal + read time).
  // Compute it once from the layout helper using an offscreen measuring context.
  const shot2Dur = (() => {
    try {
      const mc = document.createElement('canvas').getContext('2d');
      return shot2Layout(mc, W, H, line).dur;
    } catch { return 5; }
  })();
  const SHOT2_END = SHOT + shot2Dur;       // Shot 2 runs [SHOT, SHOT2_END)
  const TOTAL = SHOT2_END + SHOT;          // Shot 3 is a fixed 5s after Shot 2

  useEffect(() => {
    const url = coverSrc(release?.coverUrl);
    if (!url) { coverImgRef.current = null; return; }
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { coverImgRef.current = img; };
    img.onerror = () => { coverImgRef.current = null; };
    img.src = url;
  }, [release?.coverUrl]);

  const drawAt = (ctx, elapsed) => {
    if (elapsed < SHOT) exDrawShot1(ctx, W, H, release, coverImgRef.current, elapsed);
    else if (elapsed < SHOT2_END) exDrawShot2(ctx, W, H, release, line, elapsed - SHOT);
    else exDrawShot3(ctx, W, H, release, coverImgRef.current, elapsed - SHOT2_END);
  };

  const copyProductUrl = async () => {
    // Real product route is https://houseonly.store/products/{slug}/ — build it
    // robustly (strip leading/trailing slashes and a leading "products/").
    let s = (release?.slug || release?.handle || '').trim();
    s = s.replace(/^\/+/, '').replace(/\/+$/, '').replace(/^products\//, '');
    const url = s ? `https://houseonly.store/products/${s}/` : 'https://houseonly.store';
    try { await navigator.clipboard.writeText(url); } catch {}
    return url;
  };

  const exportStory = async () => {
    setStatus('preparing'); setMsg('Setting up…');
    const cv = canvasRef.current;
    const ctx = cv.getContext('2d');

    // Audio is optional. When the release has a snippet we route the <audio>
    // element through Web Audio and mix it into the recording. When it doesn't,
    // we record the canvas video only (silent WebM) — Instagram's own audio can
    // be added after upload.
    const hasAudio = !!track?.url;
    let ac = null, dest = null;
    const canvasStream = cv.captureStream(30);
    const streamTracks = [...canvasStream.getVideoTracks()];

    if (hasAudio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ac = new AC();
      const a = audioRef.current;
      a.currentTime = 0;
      let srcNode;
      try { srcNode = ac.createMediaElementSource(a); } catch (e) { setStatus('error'); setMsg('Audio routing failed: ' + (e?.message||'')); return; }
      dest = ac.createMediaStreamDestination();
      srcNode.connect(dest);
      // (Intentionally NOT connecting to ac.destination — we don't need to blast
      // the audio out loud during export; the recording captures it from dest.)
      streamTracks.push(...dest.stream.getAudioTracks());
    }

    // Combine canvas video + (optional) audio into one stream.
    const mixed = new MediaStream(streamTracks);

    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';
    const rec = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    recRef.current = rec;
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const aTag = document.createElement('a');
      const safe = (release?.catalog || 'story').replace(/[^a-z0-9]+/gi, '-');
      aTag.href = url; aTag.download = `houseonly-${safe}.webm`;
      document.body.appendChild(aTag); aTag.click(); aTag.remove();
      const purl = await copyProductUrl();
      try { if (ac) ac.close(); } catch {}
      setStatus('done'); setMsg(`Done — WebM downloaded · product URL copied: ${purl}${hasAudio ? '' : ' · (silent — add audio in Instagram)'}`);
    };

    // Go: start audio (if any) + recorder, drive the canvas for the full length.
    setStatus('recording'); setMsg(`Recording ${TOTAL.toFixed(1)}s…`);
    const a = audioRef.current;
    if (hasAudio) { await ac.resume(); a.play().catch(()=>{}); }
    const start = performance.now();
    rec.start();
    const loop = () => {
      const elapsed = (performance.now() - start) / 1000;
      if (elapsed >= TOTAL) { drawAt(ctx, TOTAL - 0.001); if (hasAudio) a.pause(); rec.stop(); return; }
      drawAt(ctx, elapsed);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const busy = status === 'preparing' || status === 'recording';
  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${S.border}` }}>
      <div style={{ fontSize:9, color:S.muted, letterSpacing:2, textTransform:'uppercase', fontWeight:700, marginBottom:8 }}>Export — full story</div>
      <canvas ref={canvasRef} width={W} height={H} style={{ display: 'none' }} />
      <audio ref={audioRef} src={track?.url || ''} crossOrigin="anonymous" preload="auto" />
      <button onClick={exportStory} disabled={busy || !line} style={{ width: 260, background: busy ? S.border : S.accent, color: busy ? S.muted : '#080808', border: 'none', borderRadius: 2, cursor: busy ? 'wait' : 'pointer', fontSize: 11, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase', padding: '12px 0' }}>
        {status === 'recording' ? 'Recording 15s…' : status === 'preparing' ? 'Preparing…' : '⬇ Export story (WebM)'}
      </button>
      {!line && <div style={{ fontSize: 9, color: '#ff8800', marginTop: 8, letterSpacing: 1, textTransform: 'uppercase' }}>Pick a knowledge line first</div>}
      {msg && <div style={{ fontSize: 10, color: status === 'error' ? S.danger : status === 'done' ? S.accent : S.muted, marginTop: 8, lineHeight: 1.5 }}>{msg}</div>}
      <div style={{ fontSize: 9, color: S.muted, marginTop: 8, lineHeight: 1.6 }}>
        Records the 3 shots{track?.url ? ' with the track audio' : ' (silent — no snippet for this release)'} (length varies with the knowledge line). Downloads a WebM and copies the product URL. Upload to Google Drive → phone → Instagram, then add a link sticker in the clear area near the bottom{track?.url ? '' : ', and add audio in the app'}.
      </div>
    </div>
  );
}

function StoriesGenerator() {
  const [query, setQuery]       = useState('');
  const [results, setResults]   = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState('');
  const [selected, setSelected] = useState(null);   // the picked release (parseProduct shape)
  // Shot 2 = AI-generated "knowledge line": genuine musical context, not
  // marketing bluff. We fetch 3 options from the worker's story-context
  // endpoint (Anthropic), Eduardo picks one and can edit it before export.
  const [ctxOptions, setCtxOptions] = useState([]);   // 3 generated lines
  const [ctxChosen, setCtxChosen]   = useState('');   // the selected/edited line
  const [ctxLoading, setCtxLoading] = useState(false);
  const [ctxErr, setCtxErr]         = useState('');
  // Optional steer for the generator: your instruction is sent ALONGSIDE the
  // track metadata (augment, not replace) so Claude writes the 3 lines with
  // your angle in mind (e.g. "focus on the Detroit lineage").
  const [ctxPrompt, setCtxPrompt]   = useState('');
  // Fully manual path: write your own blurb and it goes straight to Shot 2,
  // bypassing Claude entirely. Whatever lands in ctxChosen is what exports, so
  // a manual blurb simply overrides the generated one.
  const [manualBlurb, setManualBlurb] = useState('');
  // Shot 1 = cover + kick-synced waveform. We analyze every snippet on pick,
  // auto-select the one with the strongest 4/4 (house store = four-to-the-floor),
  // and keep its kick timestamps for the waveform pulse (canvas comes in 4A-2).
  const [kickAnalysis, setKickAnalysis] = useState(null);   // {tracks:[{...,score,bpm,kicks}], bestIndex}
  const [kickLoading, setKickLoading]   = useState(false);
  const [chosenTrack, setChosenTrack]   = useState(null);   // index into analyzed tracks

  // Debounced server-side search over the WHOLE catalog (reuses the same
  // Storefront `search` endpoint the storefront uses). We don't auto-fire on
  // every keystroke beyond a small debounce to avoid hammering Shopify.
  const searchTimer = useRef(null);
  const runSearch = (term) => {
    setQuery(term);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!term.trim()) { setResults([]); setSearchErr(''); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true); setSearchErr('');
      try {
        const { products } = await fetchShopifyProductSearch({ searchTerm: term.trim() });
        setResults(products);
      } catch (e) {
        setSearchErr('Search failed: ' + (e?.message || 'unknown error'));
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  };

  // When a release is picked: load it and clear any previous knowledge line.
  // No artist photo, no hunting — Shot 2 is the AI-generated knowledge line.
  const pickRelease = async (r) => {
    setSelected(r);
    setCtxOptions([]); setCtxChosen(''); setCtxErr(''); setCtxPrompt(''); setManualBlurb('');
    setKickAnalysis(null); setChosenTrack(null);
    // Analyze all snippets for their 4/4 kick and auto-pick the strongest.
    const tracks = (r.tracks || []).filter(t => t && t.url);
    if (tracks.length) {
      setKickLoading(true);
      try {
        const result = await pickBestTrack(tracks);
        setKickAnalysis(result);
        setChosenTrack(result.bestIndex);
      } catch (e) {
        setKickAnalysis({ tracks: tracks.map(t => ({ ...t, score: 0, bpm: 0, kicks: [] })), bestIndex: 0, error: e?.message });
        setChosenTrack(0);
      } finally {
        setKickLoading(false);
      }
    }
  };

  // Generate 3 knowledge-line options from the worker's story-context endpoint
  // (Anthropic). Genuine musical context, anti-bluff. Eduardo picks/edits.
  const generateContext = async () => {
    if (!selected) return;
    setCtxLoading(true); setCtxErr(''); setCtxOptions([]);
    try {
      const res = await fetch(`${WORKER_URL}?action=story-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artist: selected.artist || '',
          title: selected.title || '',
          label: selected.label || '',
          catalog: selected.catalog || '',
          genre: selected.genre || '',
          year: selected.year || '',
          description: selected.desc || '',
          tracks: (selected.tracks || []).map(t => t && t.name).filter(Boolean),
          prompt: ctxPrompt.trim(),   // optional steer — augments the metadata above
        }),
      });
      const data = await res.json();
      if (data && Array.isArray(data.options) && data.options.length) {
        setCtxOptions(data.options);
        setCtxChosen(data.options[0]);
      } else {
        // The worker sends a friendly `hint` + `retryable` for transient
        // overload/rate-limit (429/529). Prefer that over the raw error code.
        const friendly = data?.hint
          ? data.hint
          : data?.retryable
            ? 'Anthropic is busy — wait a moment and press Generate again.'
            : (data?.error ? `Generation failed: ${data.error}` : 'No lines generated.');
        setCtxErr(friendly);
      }
    } catch (e) {
      setCtxErr('Generation failed: ' + (e?.message || 'unknown'));
    } finally {
      setCtxLoading(false);
    }
  };

  const lbl = { fontSize:9, color:S.muted, letterSpacing:2, textTransform:'uppercase', fontWeight:700, marginBottom:8 };
  const audioTracks = (selected?.tracks || []).filter(t => t && t.url);

  return (
    <div>
      {/* Search box */}
      <div style={lbl}>Find a release</div>
      <input
        value={query}
        onChange={e => runSearch(e.target.value)}
        placeholder="Search by artist, title, label…"
        style={{ background:S.bg, border:`1px solid ${S.border}`, color:S.text, borderRadius:2, padding:'9px 12px', fontSize:13, fontFamily:'inherit', outline:'none', width:'100%', boxSizing:'border-box' }}
      />
      {searching && <div style={{ fontSize:10, color:S.muted, marginTop:8 }}>Searching…</div>}
      {searchErr && <div style={{ fontSize:10, color:S.danger, marginTop:8 }}>{searchErr}</div>}

      {/* Results list */}
      {results.length > 0 && !selected && (
        <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:1, maxHeight:320, overflowY:'auto' }}>
          {results.map(r => (
            <div key={r.id} onClick={() => pickRelease(r)} style={{ display:'flex', alignItems:'center', gap:12, background:S.surf, padding:'8px 12px', borderRadius:2, cursor:'pointer' }}>
              <div style={{ width:40, height:40, borderRadius:2, background:`linear-gradient(${r.g})`, backgroundImage:coverSrc(r.coverUrl)?`url(${coverSrc(r.coverUrl)})`:'none', backgroundSize:'cover', flexShrink:0 }} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:700, color:S.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.title}</div>
                <div style={{ fontSize:9, color:S.muted }}>{r.artist} · {r.label} · {r.catalog}</div>
              </div>
              <div style={{ fontSize:9, color:(r.tracks||[]).some(t=>t?.url)?S.accent:S.muted, letterSpacing:1, textTransform:'uppercase' }}>
                {(r.tracks||[]).filter(t=>t?.url).length} ♫
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Selected release — raw materials preview (Phase 1 endpoint) */}
      {selected && (
        <div style={{ marginTop:16, background:S.surf, border:`1px solid ${S.border}`, borderRadius:3, padding:18 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
            <div style={{ fontSize:11, fontWeight:800, color:S.text, letterSpacing:1, textTransform:'uppercase' }}>Story materials</div>
            <button onClick={() => { setSelected(null); setCtxOptions([]); setCtxChosen(''); }} style={{ background:'none', border:`1px solid ${S.border}`, color:S.muted, cursor:'pointer', fontSize:9, letterSpacing:1.5, textTransform:'uppercase', padding:'5px 12px', borderRadius:2 }}>← Back to search</button>
          </div>

          <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
            {/* Cover */}
            <div>
              <div style={lbl}>Cover</div>
              <div style={{ width:120, height:120, borderRadius:2, background:`linear-gradient(${selected.g})`, backgroundImage:coverSrc(selected.coverUrl)?`url(${coverSrc(selected.coverUrl)})`:'none', backgroundSize:'cover', backgroundPosition:'center', border:`1px solid ${S.border}` }} />
              <div style={{ fontSize:8, color:selected.coverUrl?S.accent:S.danger, marginTop:6, letterSpacing:1, textTransform:'uppercase' }}>{selected.coverUrl ? '✓ loaded' : '✗ no cover'}</div>
            </div>

            {/* Metadata */}
            <div style={{ flex:1, minWidth:200 }}>
              <div style={lbl}>Release</div>
              <div style={{ fontSize:14, fontWeight:800, color:S.text }}>{selected.title}</div>
              <div style={{ fontSize:11, color:S.muted, marginBottom:8 }}>{selected.artist}</div>
              <div style={{ fontSize:10, color:S.muted, lineHeight:1.7 }}>
                <div><span style={{ color:S.text }}>Label:</span> {selected.label || '—'}</div>
                <div><span style={{ color:S.text }}>Catno:</span> {selected.catalog || '—'}</div>
                <div><span style={{ color:S.text }}>Genre:</span> {selected.genre || '—'} · {selected.year || '—'}</div>
                <div><span style={{ color:S.text }}>Slug:</span> <span style={{ fontFamily:'monospace', fontSize:9 }}>/products/{selected.slug}</span></div>
              </div>
            </div>
          </div>

          {/* Shot 2 — knowledge line (AI-generated context, not bluff) */}
          <div style={{ marginTop:16, paddingTop:16, borderTop:`1px solid ${S.border}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
              <div style={lbl}>Shot 2 — knowledge line</div>
              <button onClick={generateContext} disabled={ctxLoading} style={{ background:ctxLoading?S.border:S.accent, color:ctxLoading?S.muted:'#080808', border:'none', borderRadius:2, cursor:ctxLoading?'wait':'pointer', fontSize:9, fontWeight:800, letterSpacing:1.5, textTransform:'uppercase', padding:'7px 14px' }}>
                {ctxLoading ? 'Generating…' : (ctxOptions.length ? '↻ Regenerate' : '✦ Generate 3 lines')}
              </button>
            </div>
            <div style={{ fontSize:10, color:S.muted, lineHeight:1.6, marginBottom:12 }}>
              Genuine musical context — artist lineage, label, or era. Not marketing copy. Pick one, edit if needed. You are the final fact-check.
            </div>

            {/* Optional steer — augments the track metadata sent to Claude */}
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:8, color:S.muted, letterSpacing:1.5, textTransform:'uppercase', marginBottom:6 }}>Your prompt (optional) — steers the 3 lines</div>
              <textarea
                value={ctxPrompt}
                onChange={e => setCtxPrompt(e.target.value)}
                rows={2}
                placeholder="e.g. focus on the Detroit lineage / keep it to one punchy sentence / mention the label's history…"
                style={{ width:'100%', boxSizing:'border-box', background:S.bg, border:`1px solid ${S.border}`, color:S.text, borderRadius:2, padding:'8px 10px', fontSize:12, fontFamily:'inherit', lineHeight:1.5, outline:'none', resize:'vertical' }}
              />
              <div style={{ fontSize:9, color:S.muted, marginTop:4 }}>Sent together with artist, title, label & track names — leave blank to let Claude work from the metadata alone.</div>
            </div>

            {ctxErr && <div style={{ fontSize:10, color:S.danger, marginBottom:10 }}>{ctxErr}</div>}

            {ctxOptions.length > 0 && (
              <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:12 }}>
                {ctxOptions.map((opt, i) => (
                  <div key={i} onClick={() => { setCtxChosen(opt); setManualBlurb(''); }} style={{ display:'flex', gap:10, alignItems:'flex-start', background:ctxChosen===opt?S.bg:S.surf, border:`1px solid ${ctxChosen===opt?S.accent:S.border}`, borderRadius:2, padding:'10px 12px', cursor:'pointer' }}>
                    <span style={{ fontSize:9, color:ctxChosen===opt?S.accent:S.muted, fontWeight:800, marginTop:2 }}>{ctxChosen===opt?'●':'○'}</span>
                    <span style={{ fontSize:12, color:S.text, lineHeight:1.5 }}>{opt}</span>
                  </div>
                ))}
              </div>
            )}

            {ctxChosen && (
              <div>
                <div style={{ fontSize:8, color:S.muted, letterSpacing:1.5, textTransform:'uppercase', marginBottom:6 }}>Final line (editable)</div>
                <textarea
                  value={ctxChosen}
                  onChange={e => setCtxChosen(e.target.value)}
                  rows={2}
                  style={{ width:'100%', boxSizing:'border-box', background:S.bg, border:`1px solid ${S.border}`, color:S.text, borderRadius:2, padding:'8px 10px', fontSize:12, fontFamily:'inherit', lineHeight:1.5, outline:'none', resize:'vertical' }}
                />
                <div style={{ fontSize:9, color:S.muted, marginTop:4 }}>{ctxChosen.length} chars · {ctxChosen.trim().split(/\s+/).filter(Boolean).length} words</div>
              </div>
            )}

            {/* Fully manual path — write your own blurb, skip Claude entirely. */}
            <div style={{ marginTop:14, paddingTop:14, borderTop:`1px dashed ${S.border}` }}>
              <div style={{ fontSize:8, color:S.muted, letterSpacing:1.5, textTransform:'uppercase', marginBottom:6 }}>Or write your own blurb</div>
              <textarea
                value={manualBlurb}
                onChange={e => { setManualBlurb(e.target.value); setCtxChosen(e.target.value); }}
                rows={2}
                placeholder="Type your own knowledge line here — it goes straight to Shot 2 (overrides any generated line)."
                style={{ width:'100%', boxSizing:'border-box', background:S.bg, border:`1px solid ${manualBlurb.trim() ? S.accent : S.border}`, color:S.text, borderRadius:2, padding:'8px 10px', fontSize:12, fontFamily:'inherit', lineHeight:1.5, outline:'none', resize:'vertical' }}
              />
              <div style={{ fontSize:9, color:S.muted, marginTop:4 }}>
                {manualBlurb.trim()
                  ? <span style={{ color:S.accent }}>● Using your own blurb for Shot 2.</span>
                  : 'Leave blank to use a generated line above.'}
              </div>
            </div>
          </div>

          {/* Shot 1 — audio + kick analysis */}
          <div style={{ marginTop:16 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div style={lbl}>Shot 1 — audio (auto-picks the strongest 4/4)</div>
              {kickLoading && <span style={{ fontSize:9, color:S.accent, letterSpacing:1, textTransform:'uppercase' }}>Analyzing kicks…</span>}
            </div>
            {audioTracks.length === 0 && <div style={{ fontSize:10, color:S.danger }}>No audio snippets found for this release — story needs audio.</div>}

            {(kickAnalysis?.tracks || audioTracks).map((t, i) => {
              const analyzed = !!kickAnalysis;
              const isTop = analyzed && i === 0; // sorted by score: first is the soft suggestion
              const isChosen = chosenTrack === i;
              const score = analyzed ? (t.score || 0) : null;
              // Bar of 5 blocks to visualize the kick strength.
              const blocks = analyzed ? Math.round((score / 100) * 5) : 0;
              return (
                <div key={i} onClick={() => analyzed && setChosenTrack(i)} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 10px', marginTop:4, borderRadius:2, cursor:analyzed?'pointer':'default', background:isChosen?S.bg:'transparent', border:`1px solid ${isChosen?S.accent:'transparent'}` }}>
                  <span style={{ fontSize:9, color:isChosen?S.accent:S.muted, width:14 }}>{isChosen?'●':'○'}</span>
                  <span style={{ fontSize:11, color:S.text, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.name || `Track ${i+1}`}</span>
                  {analyzed && (
                    <span style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ fontFamily:'monospace', fontSize:9, color:S.muted, width:54, textAlign:'right' }}>{t.bpm ? `${t.bpm} bpm` : 'no kick'}</span>
                      <span style={{ display:'flex', gap:2 }}>
                        {[0,1,2,3,4].map(b => <span key={b} style={{ width:5, height:12, borderRadius:1, background:b<blocks?S.accent:S.border }} />)}
                      </span>
                      {isTop && <span style={{ fontSize:7, color:S.accent, letterSpacing:1, textTransform:'uppercase', fontWeight:800 }}>suggested</span>}
                    </span>
                  )}
                  <AudioPlayer src={t.url} />
                </div>
              );
            })}

            {kickAnalysis && (
              <div style={{ fontSize:9, color:S.muted, marginTop:10, fontStyle:'italic', lineHeight:1.6 }}>
                {kickAnalysis.tracks.some(t => t.score > 0)
                  ? `Sorted by punch + energy — strongest at top, pre-selected as a suggestion. Your ear decides: play a few and tap the one you want.`
                  : 'No clear kick detected in any snippet — the waveform will animate without a pulse. Tap whichever you prefer.'}
              </div>
            )}
          </div>

          {/* Shots 1, 2 & 3 — canvas previews side by side. Renders whether or
              not the release has audio: Shot 1's pulse is a synthetic 120bpm
              grid, so it needs no track. With audio, the chosen snippet drives
              the preview play button and is recorded into the export; without,
              the story is silent (you can add Instagram's own audio later). */}
          {selected && (() => {
            const exTrack = (kickAnalysis && chosenTrack != null && kickAnalysis.tracks[chosenTrack]) || null;
            return (
            <div style={{ marginTop:16, paddingTop:16, borderTop:`1px solid ${S.border}` }}>
              <div style={lbl}>Shot previews</div>
              {!exTrack && (
                <div style={{ fontSize:9, color:S.muted, letterSpacing:0.5, marginBottom:10, lineHeight:1.6 }}>
                  No audio snippet for this release — the story exports silently. Add audio in the Instagram app after uploading.
                </div>
              )}
              <div style={{ display:'flex', gap:24, flexWrap:'wrap' }}>
                <div>
                  <div style={{ fontSize:8, color:S.muted, letterSpacing:1.5, textTransform:'uppercase', marginBottom:8 }}>Shot 1 — cover + pulse</div>
                  <Shot1Canvas release={selected} track={exTrack} />
                </div>
                <div>
                  <div style={{ fontSize:8, color:S.muted, letterSpacing:1.5, textTransform:'uppercase', marginBottom:8 }}>Shot 2 — knowledge line</div>
                  <Shot2Canvas release={selected} line={ctxChosen} />
                </div>
                <div>
                  <div style={{ fontSize:8, color:S.muted, letterSpacing:1.5, textTransform:'uppercase', marginBottom:8 }}>Shot 3 — tap to shop</div>
                  <Shot3Canvas release={selected} />
                </div>
              </div>
              <StoryExporter release={selected} track={exTrack} line={ctxChosen} />
            </div>
            );
          })()}

          {/* Description (reference) */}
          <div style={{ marginTop:16 }}>
            <div style={lbl}>Description (label marketing — reference only)</div>
            <div style={{ fontSize:11, color:S.muted, lineHeight:1.6, maxHeight:80, overflowY:'auto', background:S.bg, border:`1px solid ${S.border}`, borderRadius:2, padding:'8px 10px' }}>
              {selected.desc || '(no description)'}
            </div>
          </div>

          <div style={{ marginTop:18, padding:'10px 12px', background:S.bg, border:`1px dashed ${S.border}`, borderRadius:2, fontSize:10, color:S.muted, lineHeight:1.6 }}>
            <strong style={{ color:S.accent }}>Checkpoint 4A-1.</strong> Tracks scored on punch + energy (tempo-folded BPM), sorted strongest-first, top pre-selected as a soft suggestion. Next (4A-2): render Shot 1 on canvas with the cover punching on each detected kick.
          </div>
        </div>
      )}
    </div>
  );
}

// ── FASE 3.5C: DISCOGS REVIEW DASHBOARD ────────────────────────
// Consumes the worker review endpoints (pending-review-list/approve/reject).
// Most underground 12"s lack barcodes and match via catno+label (MEDIUM) →
// manual review, so this queue is the PRIMARY listing workflow, not a
// fallback. For ambiguous matches it shows candidates as a picker.
//
// Auth: the endpoints are Bearer BOOTSTRAP_AUTH_SECRET. We never bundle the
// secret — the user pastes it once and it lives only in component state
// (gone on refresh). Points at the PROD worker (switched at the Fase 3.5
// cutover, May 22 2026). For local dev against staging, temporarily swap
// this to houseonly-worker-staging.emontagut.workers.dev.
const REVIEW_WORKER_URL = 'https://houseonly-worker.emontagut.workers.dev';

function confidenceColor(conf) {
  if (conf === 'HIGH') return S.accent;
  if (conf === 'MEDIUM') return '#ffd24a';
  if (conf === 'LOW') return '#ff9a4a';
  return S.muted; // NOT_FOUND
}

function DiscogsReviewPanel() {
  const [secret, setSecret]       = useState('');
  const [authed, setAuthed]       = useState(false);
  const [records, setRecords]     = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [busy, setBusy]           = useState({});      // {sku: true} while approving/rejecting
  const [picked, setPicked]       = useState({});      // {sku: release_id} chosen candidate
  const [manualId, setManualId]   = useState({});      // {sku: "12345"} manual release_id entry

  const authHeaders = () => ({ 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' });

  async function loadQueue(sec) {
    const useSecret = sec ?? secret;
    setLoading(true); setError('');
    try {
      const r = await fetch(`${REVIEW_WORKER_URL}?action=pending-review-list&status=pending`, {
        headers: { 'Authorization': `Bearer ${useSecret}` },
      });
      if (r.status === 401) { setError('Unauthorized — check the admin secret.'); setAuthed(false); setLoading(false); return; }
      if (!r.ok) { setError(`List failed (HTTP ${r.status})`); setLoading(false); return; }
      const data = await r.json();
      const recs = data.records || [];
      setRecords(recs);
      setAuthed(true);
      // pre-select single-candidate matches
      const pre = {};
      recs.forEach(rec => {
        if (rec.release_id) pre[rec.sku] = rec.release_id;
        else if (rec.candidates && rec.candidates.length === 1) pre[rec.sku] = rec.candidates[0].release_id;
      });
      setPicked(p => ({ ...pre, ...p }));
    } catch (e) {
      setError(`Network error: ${e.message}`);
    }
    setLoading(false);
  }

  async function approve(sku) {
    const releaseId = picked[sku] || (manualId[sku] ? Number(manualId[sku]) : null);
    if (!releaseId) { setError(`Pick a release for ${sku} first.`); return; }
    setBusy(b => ({ ...b, [sku]: true })); setError('');
    try {
      const r = await fetch(`${REVIEW_WORKER_URL}?action=pending-review-approve`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ sku, release_id: releaseId }),
      });
      const data = await r.json();
      if (!r.ok) { setError(`Approve failed for ${sku}: ${data.error || r.status}`); }
      else { setRecords(rs => rs.filter(x => x.sku !== sku)); }
    } catch (e) { setError(`Network error: ${e.message}`); }
    setBusy(b => ({ ...b, [sku]: false }));
  }

  async function reject(sku) {
    setBusy(b => ({ ...b, [sku]: true })); setError('');
    try {
      const r = await fetch(`${REVIEW_WORKER_URL}?action=pending-review-reject`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ sku }),
      });
      const data = await r.json();
      if (!r.ok) { setError(`Reject failed for ${sku}: ${data.error || r.status}`); }
      else { setRecords(rs => rs.filter(x => x.sku !== sku)); }
    } catch (e) { setError(`Network error: ${e.message}`); }
    setBusy(b => ({ ...b, [sku]: false }));
  }

  // ── Secret gate ──
  if (!authed) {
    return (
      <div style={{maxWidth:340}}>
        <div style={{fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase',marginBottom:12}}>Discogs Review · Admin Secret</div>
        <div style={{fontSize:10,color:S.muted,marginBottom:12,lineHeight:1.5}}>Paste the worker BOOTSTRAP_AUTH_SECRET. Held in memory only — never stored.</div>
        <input
          type="password" value={secret} onChange={e=>setSecret(e.target.value)}
          onKeyDown={e=>e.key==='Enter'&&loadQueue()}
          placeholder="BOOTSTRAP_AUTH_SECRET"
          style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'9px 12px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box',marginBottom:12}}
        />
        <Btn ch={loading?'Connecting…':'Connect'} onClick={()=>loadQueue()} disabled={!secret||loading} full />
        {error && <div style={{fontSize:10,color:S.danger,marginTop:10}}>{error}</div>}
      </div>
    );
  }

  // ── Queue ──
  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <div style={{fontSize:10,color:S.muted}}>{records.length} pending {records.length===1?'item':'items'} · staging worker</div>
        <Btn ch={loading?'Refreshing…':'↻ Refresh'} variant="ghost" onClick={()=>loadQueue()} disabled={loading} />
      </div>
      {error && <div style={{fontSize:10,color:S.danger,marginBottom:12}}>{error}</div>}
      {records.length===0 && !loading && (
        <div style={{fontSize:11,color:S.muted,padding:'24px 0',textAlign:'center'}}>Queue empty — no products awaiting review.</div>
      )}
      <div style={{display:'flex',flexDirection:'column',gap:14}}>
        {records.map(rec => {
          const cands = rec.candidates || [];
          const hasCands = cands.length > 0;
          return (
            <div key={rec.sku} style={{background:S.bg,border:`1px solid ${S.border}`,borderRadius:3,padding:16}}>
              {/* header row */}
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,marginBottom:10}}>
                <div style={{minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:700,color:S.text,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{rec.artist} — {rec.title}</div>
                  <div style={{fontSize:10,color:S.muted,marginTop:3}}>SKU {rec.sku} · {rec.label||'no label'} · {rec.barcode?`barcode ${rec.barcode}`:'no barcode'}</div>
                </div>
                <div style={{textAlign:'right',whiteSpace:'nowrap'}}>
                  <span style={{fontSize:9,fontWeight:700,letterSpacing:1,textTransform:'uppercase',color:'#080808',background:confidenceColor(rec.confidence),padding:'3px 7px',borderRadius:2}}>{rec.confidence}</span>
                  <div style={{fontSize:10,color:S.muted,marginTop:5}}>{rec.match_method}</div>
                </div>
              </div>
              {/* price */}
              <div style={{fontSize:10,color:S.muted,marginBottom:hasCands?12:8}}>
                Shopify €{rec.shopify_price?.toFixed?.(2) ?? rec.shopify_price} → Discogs €{rec.discogs_price?.toFixed?.(2) ?? rec.discogs_price} · {rec.weight}g
              </div>

              {/* candidate picker */}
              {hasCands ? (
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:8}}>
                    {rec.ambiguous ? `Pick the correct release (${cands.length} candidates)` : 'Matched release'}
                  </div>
                  <div style={{display:'flex',flexDirection:'column',gap:6}}>
                    {cands.map(c => {
                      const sel = picked[rec.sku] === c.release_id;
                      return (
                        <button key={c.release_id} onClick={()=>setPicked(p=>({...p,[rec.sku]:c.release_id}))}
                          style={{display:'flex',alignItems:'center',gap:10,textAlign:'left',background:sel?S.surf:'transparent',border:`1px solid ${sel?S.accent:S.border}`,borderRadius:2,padding:8,cursor:'pointer',fontFamily:'inherit'}}>
                          {c.thumb
                            ? <img src={coverSrc(c.thumb)} alt="" style={{width:38,height:38,objectFit:'cover',borderRadius:2,flexShrink:0}} />
                            : <div style={{width:38,height:38,background:S.border,borderRadius:2,flexShrink:0}} />}
                          <div style={{minWidth:0,flex:1}}>
                            <div style={{fontSize:11,color:S.text,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{c.title}</div>
                            <div style={{fontSize:9,color:S.muted,marginTop:2}}>{c.catno||'—'}{c.year?` · ${c.year}`:''} · id {c.release_id}</div>
                          </div>
                          {sel && <span style={{fontSize:9,color:S.accent,fontWeight:700,flexShrink:0}}>✓</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                /* NOT_FOUND — manual release_id entry */
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:6}}>No match — enter Discogs release ID manually</div>
                  <input value={manualId[rec.sku]||''} onChange={e=>setManualId(m=>({...m,[rec.sku]:e.target.value.replace(/[^0-9]/g,'')}))}
                    placeholder="e.g. 37346160"
                    style={{width:'100%',maxWidth:200,background:S.surf,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'7px 10px',fontSize:11,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}} />
                </div>
              )}

              {/* actions */}
              <div style={{display:'flex',gap:8}}>
                <Btn ch={busy[rec.sku]?'…':'✓ Approve & List'} onClick={()=>approve(rec.sku)} disabled={busy[rec.sku]} />
                <Btn ch="✕ Reject" variant="ghost" onClick={()=>reject(rec.sku)} disabled={busy[rec.sku]} />
                {(picked[rec.sku]||manualId[rec.sku]) && <span style={{fontSize:9,color:S.muted,alignSelf:'center'}}>→ release {picked[rec.sku]||manualId[rec.sku]}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── RADAR PAGE (daily Bandcamp house-discovery crate) ─────────
// A standalone /radar page. The global pipeline (Worker cron, 08:00 UTC) scrapes
// Bandcamp Daily, scores each release against the House Only taste profile with
// Haiku, and writes an ever-growing crate to KV. This page reads that crate, lets
// us audition every record via its Bandcamp embed, and vote Keep/Pass to sharpen
// the profile. Admin-gated for now with the same BOOTSTRAP_AUTH_SECRET as the
// other panels; Phase 2 swaps the secret gate for per-subscriber auth + per-user
// re-ranking. All /radar/* endpoints are Bearer-gated and CORS-open (prod Worker).
function radarScoreColor(s) {
  if (s >= 70) return S.accent;   // strong match
  if (s >= 60) return '#ffd24a';  // solid
  return '#ff9a4a';               // borderline — kept by the genre-gate floor
}
function bandcampEmbedSrc(id) {
  return `https://bandcamp.com/EmbeddedPlayer/album=${id}/size=large/bgcol=111111/linkcol=c8ff00/tracklist=false/transparent=true/`;
}

function RadarItemCard({ item, busy, onVote }) {
  const [showAbout, setShowAbout] = useState(false);
  const kept = item.vote === 1;
  const passed = item.vote === -1;
  const about = (item.about || '').trim();
  const longAbout = about.length > 220;
  return (
    <div style={{background:S.bg,border:`1px solid ${kept?S.accent:S.border}`,borderRadius:3,padding:16,opacity:passed?0.5:1,transition:'opacity 0.15s'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,marginBottom:10}}>
        <div style={{minWidth:0}}>
          <div style={{fontSize:14,fontWeight:800,color:S.text,lineHeight:1.25}}>{item.artist} — {item.title}</div>
          <div style={{fontSize:10,color:S.muted,marginTop:4}}>
            {item.label || 'self-released'}{item.year?` · ${item.year}`:''}{item.tracks?` · ${item.tracks} ${item.tracks===1?'track':'tracks'}`:''}
            <span style={{marginLeft:8,fontSize:8.5,fontWeight:700,letterSpacing:1,textTransform:'uppercase',color:item.route==='stock'?'#080808':S.muted,background:item.route==='stock'?S.accent:'transparent',border:item.route==='stock'?'none':`1px solid ${S.border}`,padding:'2px 6px',borderRadius:2}}>{item.route==='stock'?'Vinyl':'Press watch'}</span>
          </div>
        </div>
        <div style={{textAlign:'right',whiteSpace:'nowrap',flexShrink:0}}>
          <span style={{fontSize:11,fontWeight:800,color:'#080808',background:radarScoreColor(item.score),padding:'3px 8px',borderRadius:2}}>{item.score}</span>
          {item.axis && <div style={{fontSize:9,color:S.muted,marginTop:5,maxWidth:150,whiteSpace:'normal',lineHeight:1.4}}>{item.axis}</div>}
        </div>
      </div>

      <div style={{borderRadius:3,overflow:'hidden',marginBottom:10,maxWidth:400,position:'relative',paddingBottom:'calc(100% + 120px)'}}>
        <iframe title={`${item.artist} — ${item.title}`} src={bandcampEmbedSrc(item.id)} loading="lazy"
          style={{border:0,position:'absolute',top:0,left:0,width:'100%',height:'100%',display:'block',background:'#111'}}>
          <a href={item.url}>{item.artist} — {item.title}</a>
        </iframe>
      </div>

      {item.reason && <div style={{fontSize:11,color:S.text,lineHeight:1.5,marginBottom:8}}>{item.reason}</div>}

      {Array.isArray(item.tags) && item.tags.length>0 && (
        <div style={{display:'flex',flexWrap:'wrap',gap:5,marginBottom:about?10:12}}>
          {item.tags.slice(0,10).map((t,i)=>(
            <span key={i} style={{fontSize:8.5,color:S.muted,letterSpacing:0.5,textTransform:'uppercase',border:`1px solid ${S.border}`,padding:'2px 6px',borderRadius:2}}>{t}</span>
          ))}
        </div>
      )}

      {about && (
        <div style={{fontSize:10.5,color:S.muted,lineHeight:1.6,marginBottom:12}}>
          {longAbout && !showAbout ? about.slice(0,220).trimEnd()+'…' : about}
          {longAbout && <button onClick={()=>setShowAbout(s=>!s)} style={{background:'none',border:'none',color:S.accent,cursor:'pointer',fontSize:10,fontFamily:'inherit',marginLeft:6,padding:0}}>{showAbout?'less':'more'}</button>}
        </div>
      )}

      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <button onClick={()=>onVote(item.id, kept?null:1)} disabled={busy} style={{flex:1,background:kept?S.accent:'transparent',color:kept?'#080808':S.text,border:`1px solid ${kept?S.accent:S.border}`,borderRadius:2,padding:'9px 14px',cursor:busy?'wait':'pointer',fontSize:10,fontWeight:700,letterSpacing:1.5,textTransform:'uppercase',fontFamily:'inherit',opacity:busy?0.5:1}}>{kept?'♥ Kept':'♥ Keep'}</button>
        <button onClick={()=>onVote(item.id, passed?null:-1)} disabled={busy} style={{flex:1,background:passed?S.danger:'transparent',color:passed?'#fff':S.muted,border:`1px solid ${passed?S.danger:S.border}`,borderRadius:2,padding:'9px 14px',cursor:busy?'wait':'pointer',fontSize:10,fontWeight:700,letterSpacing:1.5,textTransform:'uppercase',fontFamily:'inherit',opacity:busy?0.5:1}}>{passed?'✕ Passed':'✕ Pass'}</button>
        <a href={item.url} target="_blank" rel="noreferrer" style={{fontSize:9,color:S.muted,letterSpacing:1,textTransform:'uppercase',textDecoration:'none',border:`1px solid ${S.border}`,borderRadius:2,padding:'9px 12px',whiteSpace:'nowrap'}}>Bandcamp ↗</a>
      </div>
    </div>
  );
}

function RadarPage({ onBack }) {
  const [secret, setSecret]   = useState('');
  const [authed, setAuthed]   = useState(false);
  const [items, setItems]     = useState([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [busy, setBusy]       = useState({});    // {id:true} while a vote is in flight
  const [filter, setFilter]   = useState('all'); // all | stock | press | kept

  const authHeaders = () => ({ 'Authorization': `Bearer ${secret}`, 'Content-Type':'application/json' });

  async function loadFeed(sec) {
    const useSecret = sec ?? secret;
    setLoading(true); setError('');
    try {
      const r = await fetch(`${WORKER_URL}/radar/feed?limit=80`, { headers:{ 'Authorization':`Bearer ${useSecret}` } });
      if (r.status === 401) { setError('Unauthorized — check the admin secret.'); setAuthed(false); setLoading(false); return; }
      if (!r.ok) { setError(`Feed failed (HTTP ${r.status})`); setLoading(false); return; }
      const data = await r.json();
      setItems(data.items || []);
      setTotal(data.total || 0);
      setAuthed(true);
    } catch (e) { setError(`Network error: ${e.message}`); }
    setLoading(false);
  }

  async function vote(id, v) {
    const prev = items;
    setBusy(b=>({...b,[id]:true}));
    setItems(list=>list.map(it=>it.id===id?{...it,vote:v}:it)); // optimistic
    try {
      const r = await fetch(`${WORKER_URL}/radar/vote`, { method:'POST', headers:authHeaders(), body:JSON.stringify({ id, vote:v }) });
      if (!r.ok) { setItems(prev); setError(`Vote failed (HTTP ${r.status})`); }
    } catch (e) { setItems(prev); setError(`Network error: ${e.message}`); }
    setBusy(b=>({...b,[id]:false}));
  }

  const backBtn = <button onClick={onBack} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'5px 12px',borderRadius:2,whiteSpace:'nowrap'}}>← Shop</button>;

  // ── Secret gate ──
  if (!authed) {
    return (
      <div style={{background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
        <Nav onLogo={onBack}>{backBtn}</Nav>
        <div style={{maxWidth:340,margin:'0 auto',padding:'48px 20px'}}>
          <div style={{fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase',marginBottom:12}}>Radar · Admin Secret</div>
          <div style={{fontSize:10,color:S.muted,marginBottom:12,lineHeight:1.5}}>Paste the worker BOOTSTRAP_AUTH_SECRET. Held in memory only — never stored.</div>
          <input type="password" value={secret} onChange={e=>setSecret(e.target.value)} onKeyDown={e=>e.key==='Enter'&&loadFeed()} placeholder="BOOTSTRAP_AUTH_SECRET"
            style={{width:'100%',background:S.surf,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'9px 12px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box',marginBottom:12}} />
          <Btn ch={loading?'Connecting…':'Connect'} onClick={()=>loadFeed()} disabled={!secret||loading} full />
          {error && <div style={{fontSize:10,color:S.danger,marginTop:10}}>{error}</div>}
        </div>
      </div>
    );
  }

  // ── Feed ──
  const keptCount = items.filter(i=>i.vote===1).length;
  const passedCount = items.filter(i=>i.vote===-1).length;
  const shown = items.filter(i =>
    filter==='stock' ? i.route==='stock' :
    filter==='press' ? i.route==='press' :
    filter==='kept'  ? i.vote===1 : true
  );
  const fBtn = (key,label) => (
    <button onClick={()=>setFilter(key)} style={{background:filter===key?S.accent:'transparent',color:filter===key?'#080808':S.muted,border:`1px solid ${filter===key?S.accent:S.border}`,borderRadius:2,padding:'5px 12px',cursor:'pointer',fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:'uppercase',fontFamily:'inherit',whiteSpace:'nowrap'}}>{label}</button>
  );

  return (
    <div style={{background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
      <Nav onLogo={onBack}>{backBtn}</Nav>
      <div style={{maxWidth:760,margin:'0 auto',padding:'40px 16px 60px'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',gap:12,marginBottom:6,flexWrap:'wrap'}}>
          <div>
            <h1 style={{margin:0,fontSize:20,fontWeight:800,letterSpacing:-0.5}}>Radar</h1>
            <div style={{fontSize:11,color:S.muted,marginTop:4,letterSpacing:2,textTransform:'uppercase'}}>Daily house discovery</div>
          </div>
          <Btn ch={loading?'Refreshing…':'↻ Refresh'} variant="ghost" onClick={()=>loadFeed()} disabled={loading} />
        </div>
        <p style={{fontSize:11,color:S.muted,lineHeight:1.6,margin:'12px 0 0',maxWidth:560}}>Fresh house surfaced from Bandcamp every morning, scored against the House Only taste and growing daily. Audition each one, then Keep or Pass to sharpen what the radar brings back.</p>

        <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap',margin:'22px 0 18px'}}>
          {fBtn('all',`All ${total}`)}
          {fBtn('stock','Vinyl')}
          {fBtn('press','Press watch')}
          {fBtn('kept',`♥ Kept ${keptCount}`)}
          {passedCount>0 && <span style={{fontSize:9,color:S.muted,marginLeft:'auto'}}>{passedCount} passed</span>}
        </div>

        {error && <div style={{fontSize:10,color:S.danger,marginBottom:12}}>{error}</div>}
        {loading && items.length===0 && <div style={{fontSize:11,color:S.muted,padding:'32px 0',textAlign:'center'}}>Loading the crate…</div>}
        {!loading && total===0 && <div style={{fontSize:11,color:S.muted,padding:'32px 0',textAlign:'center'}}>The crate is empty — the radar runs daily at 08:00 UTC, or seed it now with a manual run.</div>}
        {!loading && total>0 && shown.length===0 && <div style={{fontSize:11,color:S.muted,padding:'32px 0',textAlign:'center'}}>Nothing under this filter.</div>}

        <div style={{display:'flex',flexDirection:'column',gap:16}}>
          {shown.map(it => <RadarItemCard key={it.id} item={it} busy={!!busy[it.id]} onVote={vote} />)}
        </div>
      </div>
    </div>
  );
}

// ── NEWSLETTER PANEL (build a broadcast draft in Resend) ───────
// Flow: paste BOOTSTRAP_AUTH_SECRET → load preview (3 sections from the Worker)
// → tick which records go in the email (✓) and which show large → set subject +
// window → "Create draft". The Worker creates a DRAFT broadcast in Resend
// (never sends); Eduardo reviews and sends from the Resend dashboard.
//
// Uses WORKER_URL (env-aware via VITE_WORKER_URL) so it follows staging/prod
// automatically — no hardcoded host.

function NewsletterSectionList({ title, sub, items, included, large, toggleInclude, toggleLarge, onIncludeAll, onClearSection, collapsed, onToggleCollapse }) {
  const count = items ? items.length : 0;
  const includedHere = items ? items.filter(p => included.includes(p.productId)).length : 0;
  // Count records in THIS section marked large (no cap).
  const idsHere = new Set((items || []).map(p => p.productId));
  const largeHere = large.filter(id => idsHere.has(id)).length;

  return (
    <div style={{marginBottom:16,border:`1px solid ${S.border}`,borderRadius:3,overflow:'hidden'}}>
      {/* header — click to collapse/expand */}
      <div onClick={onToggleCollapse} style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,padding:'12px 14px',cursor:'pointer',background:S.surf,userSelect:'none'}}>
        <div style={{display:'flex',alignItems:'center',gap:10,minWidth:0}}>
          <span style={{fontSize:11,color:S.accent,transform:collapsed?'rotate(0deg)':'rotate(90deg)',transition:'transform 0.15s',display:'inline-block'}}>▶</span>
          <div style={{minWidth:0}}>
            <div style={{fontSize:11,color:S.accent,letterSpacing:1.5,textTransform:'uppercase',fontWeight:700}}>{title}</div>
            <div style={{fontSize:10,color:S.muted,marginTop:2}}>{sub} · {count} in window · {includedHere} selected{largeHere?` · ${largeHere} large`:''}</div>
          </div>
        </div>
        {!collapsed && count > 0 && (
          <div style={{display:'flex',gap:6,flexShrink:0}} onClick={e=>e.stopPropagation()}>
            <button onClick={onIncludeAll} style={{background:'transparent',color:S.muted,border:`1px solid ${S.border}`,borderRadius:2,cursor:'pointer',fontSize:8,fontWeight:700,letterSpacing:1,textTransform:'uppercase',padding:'4px 8px',fontFamily:'inherit'}}>+ All</button>
            <button onClick={onClearSection} style={{background:'transparent',color:S.muted,border:`1px solid ${S.border}`,borderRadius:2,cursor:'pointer',fontSize:8,fontWeight:700,letterSpacing:1,textTransform:'uppercase',padding:'4px 8px',fontFamily:'inherit'}}>Clear</button>
          </div>
        )}
      </div>

      {/* body */}
      {!collapsed && (
        <div style={{padding:'10px 12px'}}>
          {count === 0
            ? <div style={{fontSize:10,color:S.muted,padding:'6px 2px'}}>None in this window.</div>
            : (
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                {items.map((p) => {
                  const isIn = included.includes(p.productId);
                  const isLarge = large.includes(p.productId);
                  return (
                    <div key={p.productId} style={{display:'flex',alignItems:'center',gap:10,background:isIn?S.surf:'transparent',border:`1px solid ${isIn?S.accent:S.border}`,borderRadius:2,padding:8}}>
                      {/* include checkbox — visible border even when unchecked */}
                      <button
                        onClick={()=>toggleInclude(p.productId)}
                        title={isIn?'Remove from email':'Include in email'}
                        style={{flexShrink:0,width:24,height:24,borderRadius:4,border:`2px solid ${isIn?S.accent:'#6a6a6a'}`,background:isIn?S.accent:'transparent',color:'#080808',cursor:'pointer',fontSize:14,fontWeight:900,lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'inherit',padding:0}}>
                        {isIn?'✓':''}
                      </button>
                      {p.imageUrl
                        ? <img src={p.imageUrl} alt="" style={{width:40,height:40,objectFit:'cover',borderRadius:2,flexShrink:0}} />
                        : <div style={{width:40,height:40,background:S.border,borderRadius:2,flexShrink:0}} />}
                      <div style={{minWidth:0,flex:1}}>
                        <div style={{fontSize:11,color:S.text,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{p.artist} — {p.title}</div>
                        <div style={{fontSize:9,color:S.muted,marginTop:2}}>{p.label||'—'} · {p.price}</div>
                      </div>
                      {/* large toggle — enabled only if included; no cap */}
                      <button
                        onClick={()=>toggleLarge(p.productId)}
                        disabled={!isIn}
                        title={!isIn ? 'Include it first' : 'Show this one as a big card'}
                        style={{flexShrink:0,background:isLarge?S.accent:'transparent',color:isLarge?'#080808':(isIn?S.muted:'#555'),border:`1px solid ${isLarge?S.accent:S.border}`,borderRadius:2,cursor:!isIn?'not-allowed':'pointer',fontSize:9,fontWeight:700,letterSpacing:1,textTransform:'uppercase',padding:'6px 10px',fontFamily:'inherit'}}>
                        {isLarge?'⬆ Large':'Large'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function NewsletterPanel() {
  const [secret, setSecret]   = useState('');
  const [authed, setAuthed]   = useState(false);
  const [days, setDays]       = useState(7);
  const [subject, setSubject] = useState('New this week at House Only');
  const [data, setData]       = useState(null);   // {preorders, new_arrivals, backorders, counts}
  const [included, setIncluded] = useState([]);    // [productId] — records to put in the email
  const [large, setLarge]     = useState([]);      // [productId] — records shown as big cards
  const [collapsed, setCollapsed] = useState({ pre:false, arr:false, bak:false });
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError]     = useState('');
  const [result, setResult]   = useState(null);    // {broadcast_id, ...}

  const authHeaders = () => ({ 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' });

  async function loadPreview(sec) {
    const useSecret = sec ?? secret;
    setLoading(true); setError(''); setResult(null);
    try {
      const r = await fetch(`${WORKER_URL}?action=newsletter-build-broadcast&preview=1&days=${days}`, {
        headers: { 'Authorization': `Bearer ${useSecret}` },
      });
      if (r.status === 401) { setError('Unauthorized — check the admin secret.'); setAuthed(false); setLoading(false); return; }
      if (!r.ok) { setError(`Preview failed (HTTP ${r.status})`); setLoading(false); return; }
      const d = await r.json();
      setData(d);
      setAuthed(true);
      setIncluded([]); setLarge([]); // reset selection on a fresh load
      // collapse all by default so you see the 3 section headers at once
      setCollapsed({ pre:true, arr:true, bak:true });
    } catch (e) {
      setError(`Network error: ${e.message}`);
    }
    setLoading(false);
  }

  function toggleInclude(productId) {
    setIncluded(inc => {
      if (inc.includes(productId)) {
        setLarge(l => l.filter(x => x !== productId)); // removing also drops "large"
        return inc.filter(x => x !== productId);
      }
      return [...inc, productId];
    });
  }

  // Toggle "large" (big card). Must be included first (UI enforces; guard too).
  function toggleLarge(productId) {
    setLarge(l => {
      if (l.includes(productId)) return l.filter(x => x !== productId);
      if (!included.includes(productId)) return l;
      return [...l, productId];
    });
  }

  function includeAll(items) {
    setIncluded(inc => {
      const set = new Set(inc);
      items.forEach(p => set.add(p.productId));
      return [...set];
    });
  }

  function clearSection(items) {
    const ids = new Set(items.map(p => p.productId));
    setIncluded(inc => inc.filter(x => !ids.has(x)));
    setLarge(l => l.filter(x => !ids.has(x)));
  }

  async function createDraft() {
    setBuilding(true); setError(''); setResult(null);
    try {
      const r = await fetch(`${WORKER_URL}?action=newsletter-build-broadcast`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ days, included, large, subject }),
      });
      const d = await r.json();
      if (!r.ok) { setError(`Build failed: ${d.error || r.status}${d.detail?` — ${d.detail}`:''}`); }
      else { setResult(d); }
    } catch (e) { setError(`Network error: ${e.message}`); }
    setBuilding(false);
  }

  // ── Secret gate ──
  if (!authed) {
    return (
      <div style={{maxWidth:340}}>
        <div style={{fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase',marginBottom:12}}>Newsletter · Admin Secret</div>
        <div style={{fontSize:10,color:S.muted,marginBottom:12,lineHeight:1.5}}>Paste the worker BOOTSTRAP_AUTH_SECRET. Held in memory only — never stored.</div>
        <input
          type="password" value={secret} onChange={e=>setSecret(e.target.value)}
          onKeyDown={e=>e.key==='Enter'&&loadPreview()}
          placeholder="BOOTSTRAP_AUTH_SECRET"
          style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'9px 12px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box',marginBottom:12}}
        />
        <Btn ch={loading?'Connecting…':'Connect'} onClick={()=>loadPreview()} disabled={!secret||loading} full />
        {error && <div style={{fontSize:10,color:S.danger,marginTop:10}}>{error}</div>}
      </div>
    );
  }

  // ── Builder ──
  const totalIncluded = included.length;
  const totalLarge = large.length;
  return (
    <div>
      {/* controls */}
      <div style={{display:'flex',gap:10,alignItems:'flex-end',flexWrap:'wrap',marginBottom:18}}>
        <div>
          <div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:5}}>Window (days)</div>
          <input type="number" min="1" max="90" value={days} onChange={e=>setDays(Math.max(1,Math.min(90,Number(e.target.value)||7)))}
            style={{width:70,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}} />
        </div>
        <div style={{flex:1,minWidth:200}}>
          <div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:5}}>Subject</div>
          <input value={subject} onChange={e=>setSubject(e.target.value)}
            style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}} />
        </div>
        <Btn ch={loading?'Loading…':'↻ Reload'} variant="ghost" onClick={()=>loadPreview()} disabled={loading} />
      </div>

      <div style={{fontSize:10,color:S.muted,marginBottom:16,lineHeight:1.5}}>
        Click a section to expand it. Tick the records you want in the email (✓), from any section — the email shows exactly what you pick, nothing else. Mark "Large" on the ones you want as a big card (prominent cover); the rest show as compact rows. <strong style={{color:S.text}}>{totalIncluded} included · {totalLarge} large</strong>.
      </div>

      {error && <div style={{fontSize:10,color:S.danger,marginBottom:12}}>{error}</div>}

      {data && (
        <>
          <NewsletterSectionList title="Pre-orders" sub="forthcoming this window" items={data.preorders} included={included} large={large} toggleInclude={toggleInclude} toggleLarge={toggleLarge} onIncludeAll={()=>includeAll(data.preorders)} onClearSection={()=>clearSection(data.preorders)} collapsed={collapsed.pre} onToggleCollapse={()=>setCollapsed(c=>({...c,pre:!c.pre}))} />
          <NewsletterSectionList title="New arrivals" sub="in stock now" items={data.new_arrivals} included={included} large={large} toggleInclude={toggleInclude} toggleLarge={toggleLarge} onIncludeAll={()=>includeAll(data.new_arrivals)} onClearSection={()=>clearSection(data.new_arrivals)} collapsed={collapsed.arr} onToggleCollapse={()=>setCollapsed(c=>({...c,arr:!c.arr}))} />
          <NewsletterSectionList title="Back in the catalogue" sub="released, awaiting stock" items={data.backorders} included={included} large={large} toggleInclude={toggleInclude} toggleLarge={toggleLarge} onIncludeAll={()=>includeAll(data.backorders)} onClearSection={()=>clearSection(data.backorders)} collapsed={collapsed.bak} onToggleCollapse={()=>setCollapsed(c=>({...c,bak:!c.bak}))} />
        </>
      )}

      {/* build */}
      <div style={{borderTop:`1px solid ${S.border}`,paddingTop:16,marginTop:8}}>
        <Btn ch={building?'Creating draft…':`Create draft in Resend${totalIncluded?` (${totalIncluded})`:''}`} onClick={createDraft} disabled={building||!data||!totalIncluded} />
        {!totalIncluded && data && <span style={{fontSize:10,color:S.muted,marginLeft:12}}>Tick at least one record to include.</span>}
        {result && result.ok && (
          <div style={{fontSize:11,color:S.text,marginTop:12,background:S.surf,border:`1px solid ${S.accent}`,borderRadius:3,padding:14,lineHeight:1.6}}>
            <div style={{color:S.accent,fontWeight:700,marginBottom:4}}>✓ Draft created in Resend</div>
            Subject: <strong>{result.subject}</strong><br/>
            In email: {result.shown?.preorders||0} pre-orders · {result.shown?.new_arrivals||0} new arrivals · {result.shown?.backorders||0} backorders · {result.large_count||0} large<br/>
            <span style={{color:S.muted}}>Broadcast id {result.broadcast_id}. Review &amp; send it from the Resend dashboard → Broadcasts.</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── PRE-ORDER / FORTHCOMING IMPORTER ───────────────────────────
// Lists distributor-announced records that have NOT yet arrived as paid
// pre-orders. Differs from the invoice-driven DBHImporter in its FRONT half:
//   • input is a MANIFEST (cat-no → artist/title/label/genre/release/price),
//     generated from the distributor "Coming soon" emails (CSV or JSON), not an
//     order invoice CSV. Pre-orders have no invoice.
//   • each release is matched to a ZIP folder (operator-downloaded) by cat-no.
//   • a RECONCILIATION view shows: ready (manifest+ZIP), manifest-but-no-ZIP
//     ("download these"), and ZIP-but-no-manifest ("need date/price").
// The BACK half (ZIP → R2 assets → row → Shopify CSV) reuses the existing
// machinery: uploadToR2, buildDescriptionHtml, loadJSZip, mapGenre, catnoFromZip.
//
// Pre-order rows carry the markers the Part-1 display layer reads:
//   • Variant Inventory Qty   : 0
//   • Variant Inventory Policy: continue   (oversell → negative stock = demand)
//   • Tags                    : + forthcoming + release:YYYY-MM-DD
// After bulk-upload to Shopify, the Forthcoming section shows them automatically.
function PreorderImporter() {
  const [manifest, setManifest]     = useState([]);   // [{catno, artist, title, label, genre, release, dealerPrice, tracks, format, coverUrl, zipUrl, source}]
  const [manifestName, setManifestName] = useState(null);
  const [zipFiles, setZipFiles]     = useState([]);
  const [edits, setEdits]           = useState({});   // catno -> {artist?, title?} operator overrides
  const [status, setStatus]         = useState('idle');// idle | processing | review
  const [progress, setProgress]     = useState({ done:0, total:0, current:'' });
  const [results, setResults]       = useState([]);
  const [excluded, setExcluded]     = useState({}); // catno -> true: dropped from CSV export
  const [liveHandles, setLiveHandles] = useState(null); // Set of lowercased live handles+SKUs (null = not yet fetched)
  const [error, setError]           = useState('');
  const [margin, setMargin]         = useState(60);
  const [downloading, setDownloading] = useState(false);
  const [downloadDone, setDownloadDone] = useState(false);   // true after a full download-all run completes
  const [downloadProgress, setDownloadProgress] = useState(0); // n of total fired, for live button label
  const [downloadStats, setDownloadStats] = useState({ ok: 0, missing: 0, failed: 0 }); // download-all outcome breakdown
  const manifestRef = useRef(null);
  const zipRef = useRef(null);

  // ── manifest parsing ────────────────────────────────────────
  // Genre mapping mirrors DBHImporter.mapGenre but keeps non-house genres
  // (e.g. "Techno - Dub") intact rather than forcing them into a house bucket.
  // Maps ONE genre token to a normalized value.
  function mapOneGenre(genreStr) {
    const g = (genreStr || '').toLowerCase();
    if (g.includes('deep house') || g.includes('deep')) return 'Deep House';
    if (g.includes('tech house')) return 'Tech House';
    if (g.includes('afro')) return 'Afro House';
    if (g.includes('chicago')) return 'Chicago House';
    if (g.includes('soulful')) return 'Soulful House';
    if (g.includes('acid')) return 'Acid House';
    if (g.includes('detroit')) return 'Detroit House';
    if (g.includes('disco')) return 'Disco House';
    if (g.includes('house')) return 'House';
    // Non-house: title-case the raw value ("Techno - Dub" → "Techno - Dub").
    return genreStr ? genreStr.replace(/\b\w/g, c => c.toUpperCase()) : '';
  }
  // W&S may carry multiple genres ("House, Techno"). Map EACH independently so
  // both survive as separate tags; dedupe and rejoin comma-separated.
  function mapGenrePreorder(genreStr) {
    if (!genreStr) return '';
    const mapped = String(genreStr).split(',')
      .map(s => mapOneGenre(s.trim()))
      .filter(Boolean);
    return [...new Set(mapped)].join(', ');
  }

  // Light title-casing for messy feed values ("various artist" → "Various
  // Artists", "houseworx" → "Houseworx"). Operator can override in the
  // reconciliation view; we never block on cosmetics.
  function titleCaseSoft(s) {
    if (!s) return '';
    // Normalize "various artist(s)" → "Various Artists" regardless of case.
    if (/^various\s+artist(s)?$/i.test(s.trim())) return 'Various Artists';
    // Leave strings that already contain an uppercase letter alone (likely
    // already correct, e.g. "M.S.", "Raw House EP").
    if (/[A-Z]/.test(s)) return s;
    return s.replace(/\b\w/g, c => c.toUpperCase());
  }

  // Is this release a Various-Artists compilation? VA cat-nos end in _va/-va,
  // or the artist field is some flavour of "various artist(s)".
  function isVA(m) {
    return /[-_]va$/i.test(String(m.catno || '').trim()) ||
           /^various\s+artist/i.test(String(m.artist || '').trim());
  }

  // VA titles from the DBH feed are junk ("va_10", "VA_10"). Derive a real
  // title from the cat-no instead: strip the trailing _va, swap separators for
  // spaces, uppercase the series token. "stardub_10_va" → "STARDUB 10".
  // Non-VA releases keep their real title (title-cased softly).
  function deriveTitle(m) {
    const raw = String(m.title || '').trim();
    if (!isVA(m)) return titleCaseSoft(raw);
    // If the manifest title is itself a junk "va_NN" style value, rebuild it.
    if (!raw || /^va[\s_-]*\d*$/i.test(raw)) {
      const base = String(m.catno || '').trim().replace(/[-_]va$/i, '');
      const derived = base.replace(/[_-]+/g, ' ').trim().toUpperCase();
      return derived || 'Various';
    }
    return titleCaseSoft(raw);
  }

  function deriveArtist(m) {
    if (isVA(m)) return 'Various Artists';
    return titleCaseSoft(String(m.artist || '').trim());
  }

  function catnoFromZip(name) {
    return name.replace(/\.zip$/i,'').replace(/\s*\(\d+\)\s*$/,'').trim().toUpperCase();
  }

  function parseManifestCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // Standard comma-delimited CSV with quoted fields (matches build_manifest output).
    const rows = []; let cur = [], field = '', inQ = false, i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"' && text[i+1] === '"') { field += '"'; i += 2; continue; }
        if (ch === '"') { inQ = false; i++; continue; }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ',') { cur.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    if (field || cur.length) { cur.push(field); rows.push(cur); }
    if (rows.length < 2) return [];
    const headers = rows[0].map(h => h.trim());
    return rows.slice(1).map(vals => {
      const obj = {};
      headers.forEach((h, idx) => obj[h] = (vals[idx] || '').trim());
      return obj;
    }).filter(r => r.catno);
  }

  // Normalize a parsed row (from CSV or JSON) into the canonical manifest shape.
  function normalizeRow(r) {
    const dp = r.dealerPrice;
    return {
      catno: String(r.catno || '').trim(),
      artist: String(r.artist || '').trim(),
      title: String(r.title || '').trim(),
      label: String(r.label || '').trim(),
      genre: String(r.genre || '').trim(),
      release: String(r.release || '').trim(),
      dealerPrice: dp === '' || dp == null ? null : Number(dp),
      tracks: r.tracks === '' || r.tracks == null ? null : Number(r.tracks),
      format: String(r.format || '').trim(),
      coverUrl: String(r.coverUrl || '').trim(),
      zipUrl: String(r.zipUrl || '').trim(),
      source: String(r.source || 'dbh').trim(),
    };
  }

  const loadManifest = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        let rows;
        const txt = rd.result;
        const isJson = /\.json$/i.test(file.name) || /^\s*[[{]/.test(txt);
        if (isJson) {
          const parsed = JSON.parse(txt);
          rows = Array.isArray(parsed) ? parsed : (parsed.releases || parsed.items || []);
        } else {
          rows = parseManifestCsv(txt);
        }
        const norm = rows.map(normalizeRow).filter(r => r.catno);
        setManifest(norm);
        setManifestName(file.name);
        setError('');
        setDownloadDone(false);     // new manifest → clear any prior "done" signal
        setDownloadProgress(0);
        setDownloadStats({ ok: 0, missing: 0, failed: 0 });
        // Fetch live catalogue handles/SKUs so the reconciliation view can
        // auto-exclude any pre-order whose cat-no already exists as a product.
        setLiveHandles(null);
        fetchLiveHandles()
          .then(setLiveHandles)
          .catch(() => setLiveHandles(new Set())); // on failure: no exclusions, never blocks the import
      } catch (e) {
        setError(`Manifest parse failed: ${e.message}`);
      }
    };
    rd.readAsText(file, 'UTF-8');
  };

  // Download every pre-sale ZIP the manifest references. Anchor-click per URL on
  // a 2.5s stagger (the proven mechanism — pop-up blockers kill window.open).
  const downloadAllZips = async () => {
    // Source-aware. Two distributor URL shapes need two mechanisms:
    //   • DBH  → https://.../release_zip/{id}  — no CORS headers, so we CANNOT
    //     fetch it from the browser. We proxy through our own Worker
    //     (?action=dbh-zip&id=...) which fetches server-side and re-streams
    //     WITH CORS, letting us await each blob to full completion.
    //   • W&S  → https://wordandsound.net/release/{id}-{catno}-.../assets — this
    //     is a session-authenticated direct ZIP download. A cross-origin fetch()
    //     would be blocked AND would not carry the W&S session cookies, so we do
    //     a plain anchor-click on the real URL (same as opening it by hand): the
    //     browser downloads it with the user's cookies. Pop-up blockers kill
    //     window.open, but a same-gesture anchor-click on a stagger works.
    const rows = manifest
      .filter(m => m.zipUrl)
      .map(m => {
        const url = String(m.zipUrl).trim();
        const dbhId = url.match(/\/release_zip\/(\d+)/)?.[1];
        return { url, catno: m.catno, dbhId, isDbh: !!dbhId };
      });
    if (!rows.length) { setError('No ZIP URLs in the manifest to download.'); return; }
    setDownloadDone(false);
    setDownloadProgress(0);
    setDownloadStats({ ok: 0, missing: 0, failed: 0 });
    setDownloading(true);

    let ok = 0, missing = 0, failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const { url, catno, dbhId, isDbh } = rows[i];
      try {
        if (isDbh) {
          // DBH: proxy through the Worker so we can await the full blob. If the
          // release has no ZIP yet the proxy returns JSON {ok:false,missing:true};
          // a real ZIP comes back as application/zip.
          const res = await fetch(`${WORKER_URL}?action=dbh-zip&id=${dbhId}`);
          const ctype = res.headers.get('content-type') || '';
          if (!res.ok || ctype.includes('application/json')) {
            missing++;
            setDownloadStats({ ok, missing, failed });
            setDownloadProgress(i + 1);
            await new Promise(r => setTimeout(r, 200));
            continue;
          }
          const blob = await res.blob();      // waits for the FULL file
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = blobUrl;
          // Name by CAT-NO so the importer's catnoFromZip() can match the
          // dropped ZIP back to its manifest row. Sanitize path separators only.
          const safeCatno = (catno || `dbh_${dbhId}`).replace(/[\/\\]/g, '_');
          a.download = `${safeCatno}.zip`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }, 4000);
          ok++;
          setDownloadStats({ ok, missing, failed });
          setDownloadProgress(i + 1);
          await new Promise(r => setTimeout(r, 300)); // breather between DBH files
        } else {
          // W&S / any direct session-auth URL: anchor-click the real URL. We
          // can't set a.download to force a name (cross-origin downloads ignore
          // it for security) — the server's content-disposition decides the
          // filename, which for W&S already carries the cat-no. We let it open
          // in the same gesture; the browser saves the ZIP with W&S cookies.
          const a = document.createElement('a');
          a.href = url;
          a.rel = 'noreferrer';
          document.body.appendChild(a);
          a.click();
          a.remove();
          ok++;
          setDownloadStats({ ok, missing, failed });
          setDownloadProgress(i + 1);
          // Longer stagger for direct downloads — each one is a separate browser
          // navigation/download; too fast and the browser drops some.
          await new Promise(r => setTimeout(r, 2500));
        }
      } catch (e) {
        // Network/proxy error for this one — count and continue, never abort.
        failed++;
        setDownloadStats({ ok, missing, failed });
        setDownloadProgress(i + 1);
      }
    }
    setDownloading(false);
    setDownloadDone(true);
  };

  const assignZips = (files) => {
    const zips = [...files].filter(f => /\.zip$/i.test(f.name));
    setZipFiles(prev => {
      const existing = new Set(prev.map(f=>f.name));
      return [...prev, ...zips.filter(f=>!existing.has(f.name))];
    });
  };

  // ── reconciliation ──────────────────────────────────────────
  // Build a map of ZIP-by-catno (uppercased), and classify each side.
  const zipMap = useMemo(() => {
    const m = {};
    zipFiles.forEach(f => { m[catnoFromZip(f.name)] = f; });
    return m;
  }, [zipFiles]);

  function zipForCatno(catno) {
    const up = catno.toUpperCase();
    return zipMap[up] || zipFiles.find(f => {
      const zc = catnoFromZip(f.name);
      return zc.includes(up) || up.includes(zc);
    }) || null;
  }

  const recon = useMemo(() => {
    const ready = [], needZip = [], orphanZip = [];
    const matchedZipNames = new Set();
    const isLive = (catno) => liveHandles ? liveHandles.has((catno||'').trim().toLowerCase()) : false;
    for (const m of manifest) {
      const alreadyLive = isLive(m.catno);
      const zf = zipForCatno(m.catno);
      if (zf) { ready.push({ ...m, _zip: zf.name, _alreadyLive: alreadyLive }); matchedZipNames.add(zf.name); }
      else needZip.push({ ...m, _alreadyLive: alreadyLive });
    }
    for (const f of zipFiles) {
      if (!matchedZipNames.has(f.name)) {
        const zc = catnoFromZip(f.name);
        const inManifest = manifest.some(m => m.catno.toUpperCase() === zc || zc.includes(m.catno.toUpperCase()) || m.catno.toUpperCase().includes(zc));
        if (!inManifest) orphanZip.push({ catno: zc, name: f.name });
      }
    }
    return { ready, needZip, orphanZip };
  }, [manifest, zipFiles, liveHandles]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── processing (back half — mirrors DBHImporter) ────────────
  const process = async () => {
    if (!recon.ready.length) return;
    setError(''); setStatus('processing'); setResults([]);
    try {
      const JSZip = await loadJSZip();
      const list = recon.ready;
      const total = list.length;
      const processed = [];

      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        const catno  = m.catno.toUpperCase().trim();
        const ov     = edits[m.catno] || {};
        const artist = (ov.artist != null ? ov.artist : deriveArtist(m)).trim();
        const title  = (ov.title  != null ? ov.title  : deriveTitle(m)).trim();
        const label  = m.label;
        let   genre  = mapGenrePreorder(m.genre);   // may be empty (W&S); filled from ZIP SALESPAPER below
        const release = m.release;                          // YYYY-MM-DD (raw street date)
        const year    = release ? new Date(release).getFullYear() : '';
        const dealer  = m.dealerPrice != null ? m.dealerPrice : 0;
        const rawPrice = dealer * (1 + margin / 100);
        let price = Math.ceil(rawPrice) - 0.01;
        // €9.99 floor (per existing pricing rules).
        if (price < 9.99) price = 9.99;
        price = price.toFixed(2);
        const format = m.format || '';
        const is2LP  = /2\s*x\s*12|double\s*lp|3\s*x\s*12/i.test(format) || /2[\s-]?lp/i.test(title);
        const grams  = is2LP ? '900' : '500';
        const handle = catno.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+$/,'');
        const safeKey = catno.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g,'-').replace(/^-|-$/g,'');

        setProgress({ done:i, total, current:`${catno} — processing…` });

        let coverUrl = '';
        let tracks   = [];
        let itemError = '';
        let zipDesc  = '';   // press text from ZIP SALESPAPER.pdf (W&S), enriches description

        const zipFile = zipForCatno(catno);
        if (zipFile) {
          try {
            setProgress({ done:i, total, current:`${catno} — extracting ZIP…` });
            const zip   = await JSZip.loadAsync(zipFile);
            const files = Object.values(zip.files).filter(f=>!f.dir);

            const imgFiles  = files.filter(f=>/\.(jpg|jpeg|png)$/i.test(f.name));
            const coverFile = imgFiles.find(f=>/front|cover|artwork/i.test(f.name.toLowerCase())) || imgFiles[0];
            if (coverFile) {
              setProgress({ done:i, total, current:`${catno} — uploading cover…` });
              const blob = await coverFile.async('blob');
              const ext  = coverFile.name.split('.').pop().toLowerCase();
              coverUrl = await uploadToR2(blob, `covers/${safeKey}.${ext}`, ext==='png'?'image/png':'image/jpeg');
            }

            const audioFiles = files.filter(f=>/\.(mp3|wav|flac|aac|ogg)$/i.test(f.name)).sort((a,b)=>a.name.localeCompare(b.name));
            for (const af of audioFiles) {
              const filename = af.name.split('/').pop();
              const safeFilename = filename.replace(/[^A-Za-z0-9._-]+/g, '-');
              setProgress({ done:i, total, current:`${catno} — uploading ${filename}…` });
              const blob = await af.async('blob');
              const url  = await uploadToR2(blob, `audio/${safeKey}/${safeFilename}`, 'audio/mpeg');
              tracks.push({ name: filename.replace(/\.[^.]+$/,''), url });
            }

            // W&S genre solution: the email never carries genre, but the ZIP's
            // SALESPAPER.pdf does. Reuse the same extractSalesPaperText helper
            // the main W&S ZipImporter uses. Only fill genre when the manifest
            // didn't already provide one (DBH manifests do; W&S don't). The
            // press text also enriches the description.
            const pdfFile = files.find(f => /SALESPAPER\.pdf$/i.test(f.name)) || files.find(f => /\.pdf$/i.test(f.name));
            if (pdfFile) {
              try {
                setProgress({ done:i, total, current:`${catno} — reading press text…` });
                const pblob = await pdfFile.async('blob');
                const extracted = await extractSalesPaperText(pblob);
                if (extracted) {
                  if (!genre && extracted.genre) genre = mapGenrePreorder(extracted.genre);
                  if (extracted.desc) zipDesc = extracted.desc;
                }
              } catch (e) { /* PDF parse is best-effort; never block the import */ }
            }
          } catch(e) { itemError = e.message; }
        }

        // Fallback cover: if no ZIP cover, use the manifest's distributor cover
        // URL (img.php). It's an external hotlink, not on R2, but better than
        // a blank pre-order tile until the ZIP lands.
        if (!coverUrl && m.coverUrl) coverUrl = m.coverUrl;

        const descHtml  = buildDescriptionHtml({ artist, title, label, year, tracks, sourceNotes: zipDesc });
        const audioHtml = tracks.length ? `<script type="application/json" id="tracks">${JSON.stringify(tracks)}<\/script>` : '';

        // Tags: the forthcoming markers + release date are what the Part-1
        // display layer keys off. release: tag stores the RAW street date;
        // the +14-day buffer is applied at display time only.
        const tagList = [
          'vinyl',
          `source:${m.source || 'dbh'}`,
          label ? `label:${label}` : '',
          genre,
          year ? String(year) : '',
          'forthcoming',
          release ? `release:${release}` : '',
        ].filter(Boolean);
        const shopifyTags = tagList.join(', ');

        processed.push({
          _catno: catno, _title: title, _artist: artist,
          _coverUrl: coverUrl, _tracks: tracks, _error: itemError,
          _zipFound: !!zipFile, _release: release,
          _alreadyLive: !!m._alreadyLive,             // exact cat-no already a live product
          _genre: genre,                              // editable in review; rebuilds Tags
          _label: label, _source: (m.source || 'dbh'), _year: year ? String(year) : '',
          'Handle': handle,
          'Title': title || catno,
          'Body (HTML)': `${descHtml}${audioHtml}`,
          'Vendor': artist,
          'Product Category': 'Media > Music & Sound Recordings > Vinyl',
          'Type': '',
          'Tags': shopifyTags,
          'Published': 'TRUE',
          'Option1 Name':'Title','Option1 Value':'Default Title','Option1 Linked To':'',
          'Option2 Name':'','Option2 Value':'','Option2 Linked To':'',
          'Option3 Name':'','Option3 Value':'','Option3 Linked To':'',
          'Variant SKU': catno,
          'Variant Grams': grams,
          'Variant Inventory Tracker': 'shopify',
          'Variant Inventory Qty': '0',                 // pre-order: no stock yet
          'Variant Inventory Policy': 'continue',        // oversell on → demand ledger
          'Variant Fulfillment Service': 'manual',
          'Variant Price': price,
          'Variant Compare At Price': '',
          'Variant Requires Shipping': 'TRUE',
          'Variant Taxable': 'TRUE',
          'Unit Price Total Measure':'','Unit Price Total Measure Unit':'',
          'Unit Price Base Measure':'','Unit Price Base Measure Unit':'',
          'Variant Barcode': '',
          'Image Src': coverUrl,
          'Image Position': coverUrl ? '1' : '',
          'Image Alt Text': coverUrl ? `${title} - ${artist}` : '',
          'Gift Card': 'FALSE','SEO Title':'','SEO Description':'',
          'Variant Image':'','Variant Weight Unit':'kg',
          'Variant Tax Code':'','Cost per item': dealer ? dealer.toFixed(2) : '','Status':'active',
        });

        setProgress({ done:i+1, total, current:'' });
      }

      setResults(processed);
      setStatus('review');
    } catch(e) {
      setError(e.message);
      setStatus('idle');
    }
  };

  // Rebuild the Tags string for a row from its (possibly edited) _genre so a
  // genre change in the review view flows into the exported CSV.
  const tagsForRow = (r) => [
    'vinyl',
    `source:${r._source || 'dbh'}`,
    r._label ? `label:${r._label}` : '',
    r._genre || '',
    r._year || '',
    'forthcoming',
    r._release ? `release:${r._release}` : '',
  ].filter(Boolean).join(', ');

  const downloadCSV = () => {
    const kept = results.filter(r => !excluded[r._catno] && !r._alreadyLive);
    if (!kept.length) return;
    const CSV_KEYS = Object.keys(kept[0]).filter(k=>!k.startsWith('_'));
    const lines = [CSV_KEYS.join(','), ...kept.map(row=>CSV_KEYS.map(h=>{
      const val = h==='Tags' ? tagsForRow(row) : row[h];
      return `"${String(val||'').replace(/"/g,'""')}"`;
    }).join(','))];
    const blob = new Blob([lines.join('\n')], { type:'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'preorder_shopify_import.csv';
    a.click();
  };

  const pct       = progress.total ? Math.round((progress.done/progress.total)*100) : 0;
  const covered   = results.filter(r=>r._coverUrl).length;
  const withAudio = results.filter(r=>r._tracks?.length>0).length;
  const errors    = results.filter(r=>r._error).length;

  const setEdit = (catno, key, val) =>
    setEdits(prev => ({ ...prev, [catno]: { ...(prev[catno]||{}), [key]: val } }));

  return (
    <div>
      <p style={{fontSize:10,color:S.muted,margin:'0 0 14px',lineHeight:1.6}}>
        Pre-order / Forthcoming. Upload a <b style={{color:S.text}}>manifest</b> (CSV or JSON, generated from the distributor "Coming soon" emails) plus the <b style={{color:S.text}}>ZIP folders</b> you downloaded. Matched by catalog number. Listed as <b style={{color:S.accent}}>paid pre-orders</b>: stock 0, oversell on, tagged <span style={{background:S.bg,color:S.accent,padding:'1px 6px',borderRadius:3,fontFamily:'monospace',fontSize:9,border:`1px solid ${S.border}`}}>forthcoming</span> + <span style={{background:S.bg,color:S.accent,padding:'1px 6px',borderRadius:3,fontFamily:'monospace',fontSize:9,border:`1px solid ${S.border}`}}>release:</span>. Customers reserve now; you ship when it lands.
      </p>

      {/* Drop zone */}
      <div
        onDragOver={e=>e.preventDefault()}
        onDrop={e=>{e.preventDefault();const files=[...e.dataTransfer.files];const mf=files.find(f=>/\.(csv|json)$/i.test(f.name));if(mf)loadManifest(mf);assignZips(files);}}
        style={{border:`2px dashed ${(manifestName||zipFiles.length)?S.accent:S.border}`,borderRadius:3,padding:'20px',textAlign:'center',marginBottom:14,transition:'border 0.15s'}}
      >
        <div style={{fontSize:28,marginBottom:6}}>📅</div>
        <div style={{fontSize:11,color:(manifestName||zipFiles.length)?S.accent:S.muted,fontWeight:700,letterSpacing:1,textTransform:'uppercase',marginBottom:10}}>
          Drag manifest (CSV/JSON) + ZIPs here
        </div>
        <div style={{display:'flex',gap:8,justifyContent:'center',flexWrap:'wrap'}}>
          <input ref={manifestRef} type="file" accept=".csv,.json" style={{display:'none'}} onChange={e=>{if(e.target.files[0])loadManifest(e.target.files[0]);e.target.value='';}} />
          <input ref={zipRef} type="file" accept=".zip" multiple style={{display:'none'}} onChange={e=>{assignZips(e.target.files);e.target.value='';}} />
          <button onClick={()=>manifestRef.current.click()} style={{background:manifestName?S.accent:S.border,border:'none',color:manifestName?'#080808':S.muted,cursor:'pointer',fontSize:9,padding:'6px 14px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
            {manifestName?`✓ ${manifestName}`:'+ Manifest'}
          </button>
          <button onClick={()=>zipRef.current.click()} style={{background:zipFiles.length?S.accent:S.border,border:'none',color:zipFiles.length?'#080808':S.muted,cursor:'pointer',fontSize:9,padding:'6px 14px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
            {zipFiles.length?`✓ ${zipFiles.length} ZIPs`:'+ ZIPs'}
          </button>
          {zipFiles.length>0&&<button onClick={()=>setZipFiles([])} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,padding:'6px 10px',borderRadius:2,fontFamily:'inherit'}}>Clear ZIPs</button>}
          {manifest.length>0&&manifest.some(m=>m.zipUrl)&&(()=>{
            const total = manifest.filter(m=>m.zipUrl).length;
            const label = downloading
              ? `Downloading… ${downloadProgress}/${total}`
              : downloadDone
                ? `✓ Done — ${downloadStats.ok} downloaded${downloadStats.missing?`, ${downloadStats.missing} no ZIP yet`:''}${downloadStats.failed?`, ${downloadStats.failed} failed`:''}`
                : `↓ Download all ZIPs (${total})`;
            const col = downloadDone && !downloading ? S.accent : S.accent;
            return (
            <button onClick={downloadAllZips} disabled={downloading} title={downloadDone?'Click to download again':''} style={{background:downloadDone&&!downloading?`${S.accent}22`:'none',border:`1px solid ${col}`,color:col,cursor:downloading?'default':'pointer',fontSize:9,padding:'6px 16px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
              {label}
            </button>
            );
          })()}
        </div>
      </div>

      {/* Reconciliation view */}
      {manifest.length>0&&status==='idle'&&(
        <div style={{marginBottom:12}}>
          <div style={{fontSize:10,color:S.muted,display:'flex',gap:16,flexWrap:'wrap',padding:'8px 14px',background:S.bg,border:`1px solid ${S.border}`,borderRadius:4,marginBottom:10}}>
            <span>Manifest: <b style={{color:S.text}}>{manifest.length}</b></span>
            <span>✅ Ready: <b style={{color:S.accent}}>{recon.ready.length}</b></span>
            <span>⚠ Need ZIP: <b style={{color:'#ff8800'}}>{recon.needZip.length}</b></span>
            <span>⚠ Orphan ZIP: <b style={{color:'#ff8800'}}>{recon.orphanZip.length}</b></span>
            {liveHandles===null
              ? <span style={{color:S.muted}}>⊘ Already live: <b>checking…</b></span>
              : (()=>{const n=[...recon.ready,...recon.needZip].filter(r=>r._alreadyLive).length; return <span>⊘ Already live: <b style={{color:n>0?'#ff8800':S.muted}}>{n}</b>{n>0?' (auto-excluded)':''}</span>;})()
            }
          </div>

          {/* Need-ZIP list: tell the operator exactly what to download */}
          {recon.needZip.length>0&&(
            <div style={{padding:'8px 14px',background:'#1a1200',border:`1px solid #ff880044`,borderRadius:4,marginBottom:10}}>
              <div style={{fontSize:9,color:'#ff8800',fontWeight:700,letterSpacing:1,textTransform:'uppercase',marginBottom:6}}>Download these ZIPs ({recon.needZip.length})</div>
              <div style={{display:'flex',flexDirection:'column',gap:4}}>
                {recon.needZip.map((m,i)=>(
                  <div key={i} style={{fontSize:10,color:S.text,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                    <span style={{fontFamily:'monospace',color:'#ff8800'}}>{m.catno}</span>
                    <span style={{color:S.muted}}>{m.artist} — {m.title}</span>
                    {m.zipUrl&&<a href={m.zipUrl} target="_blank" rel="noreferrer" style={{fontSize:9,color:S.accent,textDecoration:'none',border:`1px solid ${S.border}`,borderRadius:2,padding:'2px 8px'}}>↓ ZIP link</a>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Orphan-ZIP list: ZIPs with no manifest entry */}
          {recon.orphanZip.length>0&&(
            <div style={{padding:'8px 14px',background:'#1a1200',border:`1px solid #ff880044`,borderRadius:4,marginBottom:10}}>
              <div style={{fontSize:9,color:'#ff8800',fontWeight:700,letterSpacing:1,textTransform:'uppercase',marginBottom:6}}>ZIPs with no manifest entry ({recon.orphanZip.length})</div>
              <div style={{fontSize:10,color:S.muted}}>{recon.orphanZip.map(z=>z.catno).join(' · ')}</div>
              <div style={{fontSize:9,color:S.muted,marginTop:4}}>These need a manifest row (release date + price) before they can be listed.</div>
            </div>
          )}

          {/* Ready list: editable artist/title for messy feed values */}
          {recon.ready.length>0&&(
            <div style={{border:`1px solid ${S.border}`,borderRadius:4,overflow:'hidden',marginBottom:10}}>
              <div style={{fontSize:9,color:S.accent,fontWeight:700,letterSpacing:1,textTransform:'uppercase',padding:'8px 12px',background:S.bg}}>Ready to list ({recon.ready.length}) — edit artist/title if needed</div>
              <div style={{maxHeight:280,overflowY:'auto'}}>
                {recon.ready.map((m,i)=>{
                  const ov = edits[m.catno]||{};
                  const artistVal = ov.artist!=null?ov.artist:deriveArtist(m);
                  const titleVal  = ov.title!=null?ov.title:deriveTitle(m);
                  const previewPrice = (()=>{const dp=m.dealerPrice!=null?m.dealerPrice:0;let p=Math.ceil(dp*(1+margin/100))-0.01;if(p<9.99)p=9.99;return p.toFixed(2);})();
                  return (
                    <div key={i} style={{display:'flex',gap:8,alignItems:'center',padding:'7px 12px',borderTop:`1px solid ${S.border}`,flexWrap:'wrap'}}>
                      <span style={{fontFamily:'monospace',fontSize:10,color:S.accent,minWidth:90}}>{m.catno}</span>
                      <input value={artistVal} onChange={e=>setEdit(m.catno,'artist',e.target.value)} placeholder="Artist" style={{flex:1,minWidth:90,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'4px 8px',fontSize:11,fontFamily:'inherit',outline:'none'}} />
                      <input value={titleVal} onChange={e=>setEdit(m.catno,'title',e.target.value)} placeholder="Title" style={{flex:1,minWidth:90,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'4px 8px',fontSize:11,fontFamily:'inherit',outline:'none'}} />
                      <span style={{fontSize:9,color:S.muted,minWidth:120}}>{formatExpected(addDays(m.release,14))}</span>
                      <span style={{fontSize:10,color:S.accent,fontWeight:700,minWidth:48,textAlign:'right'}}>€{previewPrice}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Margin + process */}
      {recon.ready.length>0&&status==='idle'&&(
        <div style={{display:'flex',gap:12,alignItems:'center',marginBottom:12,flexWrap:'wrap'}}>
          <div style={{display:'flex',alignItems:'center',gap:6}}>
            <span style={{fontSize:10,color:S.muted}}>Margin %</span>
            <input type="number" value={margin} onChange={e=>setMargin(parseFloat(e.target.value)||60)} style={{width:70,padding:'5px 8px',background:S.surf,border:`1px solid ${S.border}`,borderRadius:2,color:S.text,fontFamily:'monospace',fontSize:12,textAlign:'center',outline:'none'}} />
          </div>
          <span style={{fontSize:9,color:S.muted}}>dealer €8.00 × {(1+margin/100).toFixed(2)} = €{(8*(1+margin/100)).toFixed(2)} → €{(Math.ceil(8*(1+margin/100))-0.01).toFixed(2)} (floor €9.99)</span>
          <div style={{flex:1}}/>
          <Btn ch={`📅 List ${recon.ready.length} pre-orders`} onClick={process} full />
        </div>
      )}

      {/* Progress */}
      {status==='processing'&&(
        <div style={{padding:14,background:S.bg,borderRadius:2,border:`1px solid ${S.border}`,marginBottom:12}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
            <span style={{fontSize:10,color:S.accent,fontWeight:700,letterSpacing:1}}>LISTING PRE-ORDERS…</span>
            <span style={{fontSize:10,color:S.muted}}>{progress.done} / {progress.total} · {pct}%</span>
          </div>
          <div style={{height:3,background:S.border,borderRadius:2,overflow:'hidden',marginBottom:8}}>
            <div style={{height:'100%',background:S.accent,width:`${pct}%`,transition:'width 0.3s'}} />
          </div>
          {progress.current&&<div style={{fontSize:9,color:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>→ {progress.current}</div>}
        </div>
      )}

      {error&&<div style={{marginBottom:12,padding:10,background:'#1a0000',border:`1px solid ${S.danger}44`,borderRadius:2,fontSize:10,color:S.danger}}>{error}</div>}

      {/* Results */}
      {status==='review'&&results.length>0&&(
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
            <div>
              <span style={{fontSize:11,color:S.accent,fontWeight:700}}>✓ {results.filter(r=>!excluded[r._catno]&&!r._alreadyLive).length} pre-orders</span>
              <span style={{fontSize:9,color:S.muted,marginLeft:10}}>
                {covered} covers · {withAudio} audio
                {errors>0?` · ${errors} errors`:''}
                {Object.values(excluded).filter(Boolean).length>0?` · ${Object.values(excluded).filter(Boolean).length} removed`:''}
              </span>
            </div>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>

          <div style={{padding:'8px 12px',background:'#0a1200',border:`1px solid ${S.accent}33`,borderRadius:4,marginBottom:12,fontSize:9,color:S.muted,lineHeight:1.6}}>
            After uploading to Shopify admin (bulk product import, handle-matched), these appear in the <b style={{color:S.accent}}>Forthcoming</b> section automatically — stock 0, oversell on, "Expected" date = release + 14 days.
          </div>

          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:8,maxHeight:500,overflowY:'auto',padding:4}}>
            {results.map((r,i)=>{
              const isOut = !!excluded[r._catno] || r._alreadyLive;
              return (
              <div key={i} style={{background:S.surf,border:`1px solid ${r._alreadyLive?'#ff8800':isOut?S.danger:r._error?S.danger:r._coverUrl?S.border:'#ff8800'}`,borderRadius:3,overflow:'hidden',opacity:isOut?0.4:1,transition:'opacity 0.15s'}}>
                <div style={{position:'relative',paddingBottom:'100%',background:'#1a1a2e'}}>
                  {r._coverUrl
                    ?<img src={r._coverUrl} alt="" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'}} onError={e=>e.target.style.display='none'} />
                    :<div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:24}}>🎵</div>
                  }
                  {r._tracks?.length>0&&<div style={{position:'absolute',bottom:4,left:4,background:'rgba(0,0,0,0.75)',borderRadius:2,fontSize:8,color:S.accent,padding:'2px 6px'}}>▶ {r._tracks.length}</div>}
                  <div style={{position:'absolute',top:4,left:4,background:S.accent,borderRadius:2,fontSize:7,color:'#080808',padding:'2px 5px',fontWeight:700}}>PRE-ORDER</div>
                  {r._alreadyLive
                    ? <div title="Already a live product — excluded from export" style={{position:'absolute',top:4,right:4,background:'#ff8800',border:'none',borderRadius:2,fontSize:7,color:'#080808',padding:'2px 5px',fontWeight:700,lineHeight:1}}>ALREADY LIVE</div>
                    : <button title={isOut?'Restore':'Remove from CSV'} onClick={()=>setExcluded(p=>({...p,[r._catno]:!p[r._catno]}))} style={{position:'absolute',top:4,right:4,background:isOut?S.accent:'rgba(220,40,40,0.9)',border:'none',borderRadius:2,fontSize:9,color:'#fff',padding:'2px 6px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',lineHeight:1}}>{isOut?'↺':'✕'}</button>
                  }
                  {r._error&&<div style={{position:'absolute',top:4,right:30,background:S.danger,borderRadius:2,fontSize:7,color:'#fff',padding:'2px 5px',fontWeight:700}}>ERR</div>}
                  {!r._coverUrl&&!r._error&&!r._alreadyLive&&<div style={{position:'absolute',top:4,right:30,background:'#ff8800',borderRadius:2,fontSize:7,color:'#080808',padding:'2px 5px',fontWeight:700}}>{r._zipFound?'NO IMG':'NO ZIP'}</div>}
                </div>
                <div style={{padding:'8px 8px 6px'}}>
                  <div style={{fontSize:9,color:S.muted,fontFamily:'monospace',marginBottom:2}}>{r._catno}</div>
                  <div style={{fontSize:10,fontWeight:700,color:S.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r._title||r._catno}</div>
                  <div style={{fontSize:9,color:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r._artist}</div>
                  <input value={r._genre||''} placeholder="(no genre)" onChange={e=>{const v=e.target.value;setResults(rs=>rs.map(x=>x._catno===r._catno?{...x,_genre:v}:x));}} style={{width:'100%',boxSizing:'border-box',marginTop:4,background:r._genre?'#0d0d0d':'#1a0d0d',border:`1px solid ${r._genre?S.border:'#ff8800'}`,borderRadius:2,color:r._genre?S.accent:'#ff8800',fontSize:9,fontFamily:'inherit',padding:'3px 5px',outline:'none'}} />
                  <div style={{fontSize:8,color:S.muted,marginTop:3}}>{formatExpected(addDays(r._release,14))}</div>
                  <div style={{fontSize:10,color:S.accent,marginTop:2,fontWeight:700}}>€{r['Variant Price']}</div>
                  {r._error&&<div style={{fontSize:8,color:S.danger,marginTop:4,lineHeight:1.4}}>{r._error}</div>}
                </div>
              </div>
              );
            })}
          </div>

          <div style={{marginTop:14,display:'flex',justifyContent:'flex-end'}}>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>
        </div>
      )}
    </div>
  );
}

function AdminPanel({ records, onUpdate, onAdd, onDelete, onLogout, onLoadMore, hasMore, loadingMore }) {
  const [tab,setTab]=useState('zip');
  const [editing,setEditing]=useState(null);
  const [invPage,setInvPage]=useState(1);
  const [invSearch,setInvSearch]=useState('');
  const PAGE_SIZE = 20;
  const adj=(id,d)=>{const r=records.find(r=>r.id===id);onUpdate(id,{stock:Math.max(0,(r?.stock||0)+d)});};
  const tabBtn=(key,label)=><button onClick={()=>setTab(key)} style={{background:tab===key?S.accent:S.border,color:tab===key?'#080808':S.muted,border:'none',borderRadius:2,cursor:'pointer',fontSize:9,fontWeight:tab===key?700:400,letterSpacing:1.5,textTransform:'uppercase',padding:'7px 16px'}}>{label}</button>;
  const filtered = records.filter(r => !invSearch || `${r.title} ${r.artist} ${r.label} ${r.catalog}`.toLowerCase().includes(invSearch.toLowerCase()));
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRecords = filtered.slice((invPage-1)*PAGE_SIZE, invPage*PAGE_SIZE);
  return (
    <div style={{maxWidth:860,margin:'0 auto',padding:'36px 20px'}}>
      {editing&&<EditModal record={editing} onSave={updated=>onUpdate(updated.id,updated)} onClose={()=>setEditing(null)} />}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:28}}>
        <div><h1 style={{margin:0,fontSize:18,fontWeight:800}}>Admin Panel</h1><div style={{fontSize:10,color:S.muted,marginTop:4}}>{records.length} records · {records.reduce((s,r)=>s+r.stock,0)} units in stock{hasMore?' · more in Shopify':''}</div></div>
        <Btn ch="Logout" variant="ghost" onClick={onLogout} />
      </div>
      <div style={{background:S.surf,border:`1px solid ${S.border}`,borderRadius:3,padding:22,marginBottom:28}}>
        <div style={{fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase',marginBottom:14}}>Add New Record</div>
        <div style={{display:'flex',gap:6,marginBottom:18,flexWrap:'wrap'}}>
          {tabBtn('zip','📦 W&S Import')}
          {tabBtn('kudos','🎵 Kudos Import')}
          {tabBtn('dbh','🏠 DBH Import')}
          {tabBtn('mt','🇮🇹 MT Import')}
          {tabBtn('rh','💎 Rush Hour Import')}
          {tabBtn('tv','🥁 Triple Vision')}
          {tabBtn('preorder','📅 Pre-order')}
          {tabBtn('review','💿 Discogs Review')}
          {tabBtn('newsletter','✉️ Newsletter')}
        </div>
        {tab==='zip'   && <ZipImporter />}
        {tab==='kudos' && <KudosImporter />}
        {tab==='dbh'   && <DBHImporter />}
        {tab==='mt'    && <MotherTongueImporter />}
        {tab==='rh'    && <RushHourImporter />}
        {tab==='tv'    && <TripleVisionImporter />}
        {tab==='preorder' && <PreorderImporter />}
        {tab==='review'&& <DiscogsReviewPanel />}
        {tab==='newsletter'&& <NewsletterPanel />}
      </div>
      <div style={{background:S.surf,border:`1px solid ${S.border}`,borderRadius:3,padding:22,marginBottom:28}}>
        <div style={{fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase',marginBottom:14}}>📸 Content · Instagram Stories</div>
        <StoriesGenerator />
      </div>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10,flexWrap:'wrap'}}>
        <div style={{fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase'}}>Inventory</div>
        <input value={invSearch} onChange={e=>{setInvSearch(e.target.value);setInvPage(1);}} placeholder="Search inventory…" style={{background:S.surf,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'4px 10px',fontSize:11,fontFamily:'inherit',outline:'none',flex:1,minWidth:120,maxWidth:220}} />
        <span style={{fontSize:9,color:S.muted}}>{filtered.length} records</span>
        {hasMore&&<button onClick={onLoadMore} disabled={loadingMore} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1,textTransform:'uppercase',padding:'4px 10px',borderRadius:2}}>{loadingMore?'Loading…':'Load All from Shopify'}</button>}
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:1}}>
        {pageRecords.map(r=>(
          <div key={r.id} style={{display:'flex',alignItems:'center',gap:12,background:S.surf,padding:'10px 14px',borderRadius:2,flexWrap:'wrap'}}>
            <div style={{width:40,height:40,borderRadius:2,background:`linear-gradient(${r.g})`,backgroundImage:coverSrc(r.coverUrl)?`url(${coverSrc(r.coverUrl)})`:'none',backgroundSize:'cover',flexShrink:0}} />
            <div style={{flex:1,minWidth:120}}><div style={{fontSize:12,fontWeight:700,color:S.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.title}</div><div style={{fontSize:9,color:S.muted}}>{r.artist} · {r.label}</div></div>
            <div style={{fontSize:12,color:S.accent,fontWeight:800}}>€{r.price.toFixed(2)}</div>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <button onClick={()=>adj(r.id,-1)} style={{width:22,height:22,borderRadius:2,background:S.border,border:'none',cursor:'pointer',color:S.text,fontSize:14}}>-</button>
              <span style={{fontSize:13,fontWeight:700,color:r.stock===0?S.danger:r.stock<=3?'#ff8800':S.text,width:24,textAlign:'center'}}>{r.stock}</span>
              <button onClick={()=>adj(r.id,1)} style={{width:22,height:22,borderRadius:2,background:S.border,border:'none',cursor:'pointer',color:S.text,fontSize:14}}>+</button>
            </div>
            <button onClick={()=>setEditing(r)} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1,textTransform:'uppercase',padding:'4px 10px',borderRadius:2}}>Edit</button>
            <button onClick={()=>onDelete(r.id)} style={{background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:13,padding:4}}>🗑</button>
          </div>
        ))}
      </div>
      {totalPages > 1 && (
        <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:8,marginTop:16}}>
          <button onClick={()=>setInvPage(p=>Math.max(1,p-1))} disabled={invPage===1} style={{background:S.border,border:'none',color:invPage===1?S.muted:S.text,cursor:invPage===1?'not-allowed':'pointer',borderRadius:2,padding:'5px 12px',fontSize:10}}>← Prev</button>
          <span style={{fontSize:10,color:S.muted}}>{invPage} / {totalPages} · {filtered.length} records</span>
          <button onClick={()=>setInvPage(p=>Math.min(totalPages,p+1))} disabled={invPage===totalPages} style={{background:S.border,border:'none',color:invPage===totalPages?S.muted:S.text,cursor:invPage===totalPages?'not-allowed':'pointer',borderRadius:2,padding:'5px 12px',fontSize:10}}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ── LOGIN ──────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [pw,setPw]=useState(''); const [err,setErr]=useState(false);
  const attempt=()=>{if(pw==='waxlab2024') onLogin(); else {setErr(true);setTimeout(()=>setErr(false),1500);}};
  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center'}}>
      <div style={{width:280,background:S.surf,border:`1px solid ${S.border}`,borderRadius:3,padding:32}}>
        <div style={{fontSize:9,letterSpacing:3,color:S.muted,textTransform:'uppercase',marginBottom:24}}>Admin Access</div>
        <input type="password" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==='Enter'&&attempt()} placeholder="Password" style={{width:'100%',background:S.bg,border:`1px solid ${err?S.danger:S.border}`,color:S.text,borderRadius:2,padding:'9px 12px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box',marginBottom:12}} />
        <Btn ch="Enter" onClick={attempt} full />
        {err&&<div style={{fontSize:10,color:S.danger,marginTop:8,textAlign:'center'}}>Incorrect password</div>}
      </div>
    </div>
  );
}

// ── POLICY DRAWER ──────────────────────────────────────────────
const POLICY_SLUGS = {
  'privacy-policy':      'privacyPolicy',
  'terms-of-service':    'termsOfService',
  'refund-policy':       'refundPolicy',
  'shipping-policy':     'shippingPolicy',
  'legal-notice':        'hardcoded',
  'contact-information': 'hardcoded',
};

const HARDCODED_POLICIES = {
  'legal-notice': {
    title: 'Legal Notice',
    body: `
      <p><strong>HOUSEONLY</strong> is operated by:</p>
      <p><strong>Telsnap S.L.</strong><br/>
      NIF: B75303990<br/>
      Registered in Spain</p>
      <p><strong>Contact:</strong> <a href="mailto:info@houseonly.store">info@houseonly.store</a></p>
      <p>The European Commission provides a platform for online dispute resolution (ODR) accessible at <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noreferrer">ec.europa.eu/consumers/odr</a>.</p>
      <p>All content on this website is the property of Telsnap S.L. or its content suppliers and is protected by applicable intellectual property laws.</p>
    `,
  },
  'contact-information': {
    title: 'Contact',
    body: `
      <p>For any questions about your order, shipping, or general enquiries:</p>
      <p><strong>General:</strong> <a href="mailto:info@houseonly.store">info@houseonly.store</a><br/>
      <strong>Orders:</strong> <a href="mailto:orders@houseonly.store">orders@houseonly.store</a></p>
      <p>We aim to respond within 24–48 hours on business days.</p>
    `,
  },
};

async function fetchPolicy(field) {
  if (!field) return null;
  const data = await shopifyQuery(`{ shop { ${field} { title body } } }`);
  return data?.shop?.[field] || null;
}

function PolicyDrawer({ slug, onClose }) {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!slug) return;
    setContent(null);
    setLoading(true);
    const field = POLICY_SLUGS[slug];
    if (field === 'hardcoded') {
      setContent(HARDCODED_POLICIES[slug] || { title: 'Not found', body: '<p>Content not available.</p>' });
      setLoading(false);
      return;
    }
    fetchPolicy(field)
      .then(p => { setContent(p); setLoading(false); })
      .catch(() => { setContent({ title: 'Error', body: '<p>Could not load policy.</p>' }); setLoading(false); });
  }, [slug]);

  const open = !!slug;

  return (
    <>
      {open && <div onClick={onClose} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.5)',zIndex:900}} />}
      <div style={{position:'fixed',top:0,right:0,bottom:0,width:560,maxWidth:'100vw',background:S.surf,borderLeft:`1px solid ${S.border}`,zIndex:1000,transform:open?'translateX(0)':'translateX(100%)',transition:'transform 0.25s ease',display:'flex',flexDirection:'column',boxSizing:'border-box'}}>
        <div style={{padding:'18px 22px',borderBottom:`1px solid ${S.border}`,display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0}}>
          <span style={{fontWeight:800,fontSize:11,letterSpacing:2,textTransform:'uppercase',color:S.text}}>{content?.title || '…'}</span>
          <button onClick={onClose} style={{background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:20}}>×</button>
        </div>
        <div style={{flex:1,overflowY:'auto',padding:'24px 28px'}}>
          {loading && <div style={{color:S.muted,fontSize:12,textAlign:'center',paddingTop:40}}>Loading…</div>}
          {content && !loading && (
            <>
              <style>{`
                .policy-body { color: ${S.muted}; font-size: 13px; line-height: 1.8; }
                .policy-body h1, .policy-body h2, .policy-body h3 { color: ${S.text}; font-size: 13px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; margin: 24px 0 10px; }
                .policy-body h1:first-child { margin-top: 0; }
                .policy-body p { margin: 0 0 14px; }
                .policy-body a { color: ${S.accent}; text-decoration: none; }
                .policy-body a:hover { text-decoration: underline; }
                .policy-body ul, .policy-body ol { padding-left: 20px; margin: 0 0 14px; }
                .policy-body li { margin-bottom: 6px; }
                .policy-body strong { color: ${S.text}; font-weight: 600; }
              `}</style>
              <div className="policy-body" dangerouslySetInnerHTML={{__html: content.body}} />
            </>
          )}
        </div>
      </div>
    </>
  );
}
function Nav({ onLogo, children }) {
  const isMobile = useIsMobile(720);
  return (
    <nav style={{position:'sticky',top:0,zIndex:200,background:'rgba(8,8,8,0.96)',backdropFilter:'blur(8px)',borderBottom:`1px solid ${S.border}`,padding:isMobile?'8px 14px':'0 16px',minHeight:52,height:isMobile?'auto':52,display:'flex',flexWrap:isMobile?'wrap':'nowrap',alignItems:'center',justifyContent:'space-between',gap:isMobile?8:8}}>
      <Logo scale={0.65} onClick={onLogo} />
      {children}
    </nav>
  );
}

// ── APP ────────────────────────────────────────────────────────
export default function App() {
  const [records,setRecords]             = useState([]);
  const [catalogMeta,setCatalogMeta]     = useState([]); // lite metadata (tags, vendor) for ALL products — drives filter pills
  const [shopifyLoaded,setShopifyLoaded] = useState(false);
  const [shopifyErr,setShopifyErr]       = useState('');
  const [hasMore,setHasMore]             = useState(false);
  const [cursor,setCursor]               = useState(null);
  const [loadingMore,setLoadingMore]     = useState(false);
  const [cart,setCart]                   = useState([]);
  const [cartOpen,setCartOpen]           = useState(false);
  const [policySlug,setPolicySlug]       = useState(null);
  const [selected,setSelected]           = useState(null);
  const [filters,setFilters]             = useState({genre:null,label:null,year:null,sort:'newest',forthcoming:false,dnb:false});
  const [search,setSearch]               = useState('');
  const navMobile = useIsMobile(720); // drives the two-row mobile header layout
  // Debounced version of `search`: updated 300ms after the user stops typing.
  // We use this (not `search`) in fetchParams so we don't fire a Shopify
  // search request on every keystroke.
  const [debouncedSearch,setDebouncedSearch] = useState('');
  useEffect(()=>{
    const handle = setTimeout(()=>setDebouncedSearch(search.trim()), 300);
    return ()=>clearTimeout(handle);
  },[search]);
  const [page,setPage]                   = useState('shop');
  // Forthcoming view mode: 'list' (default, rich rows) or 'grid' (cards).
  // Resets to 'list' every time the user enters the Forthcoming section.
  const [forthcomingView,setForthcomingView] = useState('list');
  const [path,setPath]                   = useState(typeof window!=='undefined'?window.location.pathname:'/');

  // ── AUTH + WISHLIST STATE ────────────────────────────────────
  // On first mount, prefer a session arriving in the URL fragment (just
  // returned from the Worker's /auth/callback); otherwise load the stored one.
  const [auth, setAuth]                   = useState(()=> captureSessionFromUrl() || loadAuth());
  const [profile, setProfile]             = useState(null);
  const [accountOpen, setAccountOpen]     = useState(false);
  const [wishItems, setWishItems]         = useState(()=>loadLocalWishlist());
  const [wishOpen, setWishOpen]           = useState(false);
  // Forthcoming audio gate: clicking play on a forthcoming preview without an
  // account opens this prompt (login/register to listen). Audio gate ONLY.
  const [audioGateOpen, setAudioGateOpen] = useState(false);

  // Gate passed to the player: block forthcoming previews unless logged in.
  // Returns false (and opens the prompt) for forthcoming + no session; else true.
  // Catalogue (non-forthcoming) audio is never gated.
  const playGate = useCallback((r) => {
    if (isForthcoming(r) && !auth?.session) {
      setAudioGateOpen(true);
      return false;
    }
    return true;
  }, [auth]);

  // Persist anonymous wishlist to localStorage on every change
  useEffect(()=>{ saveLocalWishlist(wishItems); }, [wishItems]);

  // Reset Forthcoming to the default list view each time it's entered.
  useEffect(()=>{ if (filters.forthcoming) setForthcomingView('list'); }, [filters.forthcoming]);

  // "Soonest Release" sort is a Forthcoming-only option. If we leave Forthcoming
  // while it's selected, fall back to 'newest' so the main catalogue isn't left
  // with a forthcoming-only sort that only reorders the loaded page.
  useEffect(()=>{ if (!filters.forthcoming && filters.sort === 'release-asc') setFilter('sort','newest'); }, [filters.forthcoming, filters.sort]);

  // When auth (session) changes: load profile, sync wishlist.
  // The merge flow is preserved exactly: if there's a local anonymous list,
  // merge it into the account server-side, otherwise pull the authoritative
  // server list. The customerId behind the session is the SAME numeric id the
  // old token resolved to, so the wishlist record (wl:{customerId}) is identical.
  useEffect(()=>{
    let cancelled = false;
    if (!auth?.session) { setProfile(null); return; }

    (async () => {
      const p = await customerProfile(auth.session);
      if (cancelled) return;
      if (!p) {
        // Session rejected/expired → log out locally.
        saveAuth(null); setAuth(null); setProfile(null);
        return;
      }
      setProfile(p);
      // Merge local list into server, then pull authoritative list
      const localItems = loadLocalWishlist();
      let serverItems = null;
      if (localItems.length > 0) {
        serverItems = await mergeServerWishlist(auth.session, localItems);
      } else {
        serverItems = await fetchServerWishlist(auth.session);
      }
      if (cancelled) return;
      if (Array.isArray(serverItems)) {
        setWishItems(serverItems);
      }
    })();
    return () => { cancelled = true; };
  }, [auth?.session]);

  // Auth actions. Login/logout are now full-page redirects to the Worker's
  // hosted OAuth flow (NCA passwordless). There is no in-app email/password
  // form anymore.
  const handleSignIn = () => {
    window.location.href = workerLoginUrl(typeof window !== 'undefined' ? window.location.pathname : '/');
  };
  const handleLogout = () => {
    const session = auth?.session;
    // Clear local state first so the UI updates immediately, then redirect to
    // the Worker logout (which clears the Shopify-side session too).
    saveAuth(null); setAuth(null); setProfile(null);
    if (session) {
      window.location.href = workerLogoutUrl(session, '/');
    }
  };

  // Wishlist actions
  const isWished = (r) => {
    const handle = r?.slug || r?.handle || (r?.id != null ? String(r.id) : '');
    return wishItems.some(it => it.handle === handle);
  };
  const wishlistToggle = async (r) => {
    const item = recordToWishlistItem(r);
    if (!item.handle) return;
    const wished = wishItems.some(it => it.handle === item.handle);
    if (wished) {
      // Remove
      setWishItems(items => items.filter(it => it.handle !== item.handle));
      if (auth?.session) {
        deleteServerWishlistItem(auth.session, item.handle).catch(()=>{});
      }
    } else {
      // Add (optimistic)
      setWishItems(items => [item, ...items.filter(it=>it.handle!==item.handle)]);
      if (auth?.session) {
        postServerWishlistItem(auth.session, item).catch(()=>{});
      }
    }
  };
  const wishlistRemove = (handle) => {
    setWishItems(items => items.filter(it => it.handle !== handle));
    if (auth?.session) {
      deleteServerWishlistItem(auth.session, handle).catch(()=>{});
    }
  };
  // When a wishlist item is clicked, find the corresponding record (if loaded) and open it
  const openWishlistItem = (item) => {
    const r = records.find(rec => (rec.slug||'') === item.handle);
    if (r) {
      setWishOpen(false);
      openProduct(r);
    } else {
      // Not loaded — navigate to product page so the prerendered HTML loads
      setWishOpen(false);
      window.location.href = `/products/${item.handle}/`;
    }
  };
  // Add a wishlist item to the cart, then remove from wishlist (standard pattern).
  // If the record isn't in our loaded list yet (e.g. user is on page 1 but item is from page 5),
  // fetch it from Shopify directly so we get the shopifyVariantId needed for checkout.
  const addWishlistItemToCart = async (item) => {
    let r = records.find(rec => (rec.slug||'') === item.handle);
    if (!r) {
      try {
        r = await fetchShopifyProductByHandle(item.handle);
      } catch { /* ignore */ }
    }
    if (!r) return;
    addToCart(r);
    wishlistRemove(item.handle);
  };

  // Bulk: resolve every wishlist item, add in-stock ones to cart, remove them from wishlist.
  // Out-of-stock and unresolvable items stay in the wishlist so the customer can deal with
  // them separately (e.g., submit a backorder request).
  const addAllWishlistToCart = async () => {
    if (wishItems.length === 0) return;
    const toAdd = [];
    for (const item of wishItems) {
      let r = records.find(rec => (rec.slug||'') === item.handle);
      if (!r) {
        try { r = await fetchShopifyProductByHandle(item.handle); } catch { /* skip */ }
      }
      if (r && r.stock > 0) toAdd.push({ item, r });
    }
    for (const { r } of toAdd) addToCart(r);
    for (const { item } of toAdd) wishlistRemove(item.handle);
    if (toAdd.length > 0) {
      setWishOpen(false);
      setCartOpen(true);
    }
  };

  // Keep `path` in sync with browser back/forward
  useEffect(()=>{
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  },[]);

  // Open modal automatically when URL is /products/<slug>.
  // Fast path: the product is already in the loaded (paginated) `records` —
  // open it directly. Fallback (direct load of a product outside the current
  // page, e.g. a shared/Google/bookmarked link): the product won't be in
  // `records`, so resolve it by SKU. The prerendered HTML (scripts/prerender.mjs)
  // injects a JSON-LD <script> carrying the product's "sku", and the Shopify
  // handle is always that SKU lowercased (verified: FAT072→fat072, etc.). We
  // read the SKU from the DOM and fetch that single product by handle — O(1),
  // independent of catalog size, so it scales as the catalog grows.
  const directFetchedSlug = useRef(null);
  useEffect(()=>{
    const m = path.match(/^\/products\/([^/]+)\/?$/);
    if (!m) { if (selected) setSelected(null); directFetchedSlug.current = null; return; }
    const slug = m[1];
    if (selected && selected.slug === slug) return;
    const found = records.find(r => r.slug === slug);
    if (found) { setSelected(found); return; }
    // Not in the loaded page. Resolve via Shopify's real handle, which the
    // prerender writes into <meta name="shopify-handle"> (scripts/prerender.mjs).
    // We deliberately do NOT derive the handle from the SKU: SKUs can contain
    // spaces or punctuation that Shopify normalizes in the handle (e.g. SKU
    // "SS 004" → handle "ss-004"), so guessing breaks. The meta tag carries the
    // exact handle. Fallback to a sanitized SKU only if the meta is absent.
    // Guard so we attempt the network fetch only once per slug.
    if (directFetchedSlug.current === slug) return;
    directFetchedSlug.current = slug;
    let handle = document.querySelector('meta[name="shopify-handle"]')?.content?.trim() || '';
    if (!handle) {
      // Fallback: derive from JSON-LD SKU (legacy / pre-meta prerenders).
      let sku = '';
      try {
        for (const b of document.querySelectorAll('script[type="application/ld+json"]')) {
          const json = JSON.parse(b.textContent || '{}');
          if (json && json['@type'] === 'Product' && json.sku) { sku = String(json.sku); break; }
        }
      } catch { /* ignore */ }
      handle = sku.toLowerCase().replace(/\s+/g, '-');
    }
    if (!handle) return; // nothing to resolve with (e.g. dev server without prerender)
    fetchShopifyProductByHandle(handle)
      .then(prod => {
        if (!prod) return;
        // Open only if the URL still points at this slug. (No effect-cleanup
        // `cancelled` flag: this effect re-runs when `records` loads, and that
        // cleanup would cancel the in-flight fetch before it resolves. The live
        // URL check stays valid across that re-run and only fails on real nav.)
        if (window.location.pathname.match(/^\/products\/([^/]+)\/?$/)?.[1] === slug) {
          setSelected(prod);
        }
      })
      .catch(()=>{ /* network error — leave on home rather than crash */ });
  },[path, records]);

  // Navigation helpers — push URL + update state in one call
  const navigate = (newPath) => {
    if (window.location.pathname === newPath) return;
    window.history.pushState({}, '', newPath);
    setPath(newPath);
  };
  const openProduct = (r) => {
    if (!r) return;
    // The player bar stores release snapshots that lack description, tracklist, and tags.
    // When opening from the player, prefer the fully-loaded record from `records` so the
    // modal shows complete content. Fall back to the snap if not found in the catalog
    // (rare: release was unpublished mid-session).
    const full = records.find(rec => rec.id === r.id) || records.find(rec => rec.slug && rec.slug === r.slug) || r;
    setSelected(full);
    navigate(`/products/${full.slug}/`);
  };
  const closeProduct = () => {
    setSelected(null);
    if (path.startsWith('/products/')) navigate('/');
  };

  // Admin password gate (same as before — Ctrl+Shift+A toggles, #admin opens)
  useEffect(()=>{
    if (window.location.hash==='#admin') setPage('login');
    const handler = (e) => { if (e.shiftKey && e.ctrlKey && e.key==='A') setPage(p=>p==='shop'?'login':'shop'); };
    window.addEventListener('keydown', handler);
    return ()=>window.removeEventListener('keydown', handler);
  },[]);

  // Translate UI filters/sort into Shopify Storefront API params.
  // Tag formats match what the importers write:
  //   - label tags are prefixed: "label:Word and Sound"
  //   - genre tags are plain values: "Deep House"
  //   - year tags are plain 4-digit years: "2025"
  // useMemo so the effect below only refetches when they actually change.
  // searchTerm uses the debounced value so we don't fire a Shopify query
  // on every keystroke.
  const fetchParams = useMemo(() => {
    const filterTags = [];
    if (filters.genre) filterTags.push(filters.genre);
    if (filters.label) filterTags.push(`label:${filters.label}`);
    if (filters.year)  filterTags.push(String(filters.year));
    let sortKey = 'CREATED_AT', reverse = true;
    if (filters.sort === 'price-asc')  { sortKey = 'PRICE'; reverse = false; }
    if (filters.sort === 'price-desc') { sortKey = 'PRICE'; reverse = true;  }
    return { filterTags, sortKey, reverse, searchTerm: debouncedSearch, forthcoming: !!filters.forthcoming, dnb: !!filters.dnb };
  }, [filters.genre, filters.label, filters.year, filters.sort, filters.forthcoming, filters.dnb, debouncedSearch]);

  // Fetch (or refetch) page 1 whenever sort, filter, OR search params change.
  // Code paths:
  //   - forthcoming view → `products` endpoint requiring tag:'forthcoming'
  //     (free-text search is disabled in the Forthcoming section — the list is
  //     short and curated, so relevance ranking adds nothing)
  //   - searchTerm present → `search` endpoint (relevance-ranked, prefix-match)
  //   - otherwise → `products` endpoint (sortable, paginated), forthcoming
  //     EXCLUDED so pre-orders never appear in the main catalogue
  // The active code path is encapsulated in fetchActivePage so loadMore stays simple.
  const fetchActivePage = useCallback((extraOpts={}) => {
    if (fetchParams.forthcoming) {
      return fetchShopifyProducts({
        sortKey: fetchParams.sortKey,
        reverse: fetchParams.reverse,
        filterTags: fetchParams.filterTags,
        forthcoming: true,
        ...extraOpts,
      });
    }
    if (fetchParams.searchTerm) {
      return fetchShopifyProductSearch({
        searchTerm: fetchParams.searchTerm,
        filterTags: fetchParams.filterTags,
        dnb: fetchParams.dnb,
        ...extraOpts,
      });
    }
    return fetchShopifyProducts({
      sortKey: fetchParams.sortKey,
      reverse: fetchParams.reverse,
      filterTags: fetchParams.filterTags,
      dnb: fetchParams.dnb,
      ...extraOpts,
    });
  }, [fetchParams]);

  useEffect(()=>{
    setShopifyLoaded(false);
    fetchActivePage()
      .then(({ products, hasNextPage, endCursor })=>{
        setRecords(products);
        setShopifyLoaded(true);
        setHasMore(hasNextPage);
        setCursor(endCursor);
      })
      .catch(e=>{ setShopifyErr(e.message); setShopifyLoaded(true); });
  },[fetchActivePage]);

  // Catalog-wide metadata fetch (tags + vendor only, all products). Powers the
  // filter pills so customers can see every genre, year, and label that exists
  // in the catalog from the moment the page loads — not just the genres/years
  // present in the first paginated batch of cards.
  useEffect(()=>{
    fetchAllProductMetadata()
      .then(setCatalogMeta)
      .catch(()=>{ /* non-fatal — Filters falls back to deriving from records */ });
  },[]);

  const loadMore=async()=>{
    if(!hasMore||loadingMore) return; setLoadingMore(true);
    try {
      const {products,hasNextPage,endCursor} = await fetchActivePage({ cursor });
      setRecords(r=>[...r,...products]);
      setHasMore(hasNextPage);
      setCursor(endCursor);
    } catch(e){setShopifyErr(e.message);}
    setLoadingMore(false);
  };

  const addToCart=r=>setCart(c=>{const ex=c.find(i=>i.id===r.id);return ex?c.map(i=>i.id===r.id?{...i,qty:i.qty+1}:i):[...c,{...r,qty:1}];});
  const setFilter=(k,v)=>setFilters(f=>({...f,[k]:v}));

  // Free-text search is now server-side via fetchShopifyProductSearch (above).
  // Records arrives already filtered & sorted by relevance, so we render directly.
  // "Soonest Release" (filters.sort === 'release-asc') is a client-side sort by
  // release date ascending — it can't be server-side because release:YYYY-MM-DD
  // is a free-text tag, not a Shopify sortKey. It's offered only in the
  // Forthcoming view, where all records are loaded (no pagination), so the sort
  // is complete. Records with no release date sort to the bottom (guard).
  const filtered = useMemo(() => {
    if (filters.forthcoming && filters.sort === 'release-asc') {
      return [...records].sort((a, b) => {
        const da = a.releaseDate || '';
        const db = b.releaseDate || '';
        if (!da && !db) return 0;
        if (!da) return 1;   // missing date → bottom
        if (!db) return -1;
        return da.localeCompare(db); // ISO YYYY-MM-DD sorts correctly as string
      });
    }
    return records;
  }, [records, filters.forthcoming, filters.sort]);

  const cartCount=cart.reduce((s,i)=>s+i.qty,0);

  // Derive filter pill values from the catalog-wide metadata (every product's
  // tags). useMemo so we don't recompute on every render. If catalogMeta hasn't
  // arrived yet, these are empty arrays — Filters falls back to deriving from
  // the loaded `records` so something always shows.
  const { allLabels, allGenres, allYears } = useMemo(()=>{
    const labelSet = new Set(), genreSet = new Set(), yearSet = new Set();
    for (const node of catalogMeta) {
      const { genre, year, label } = extractTagMeta(node.tags);
      if (label) labelSet.add(label);
      if (genre) genreSet.add(genre);
      if (year)  yearSet.add(year);
    }
    return {
      allLabels: [...labelSet].sort(),
      allGenres: [...genreSet].sort(),
      allYears:  [...yearSet].sort((a,b)=>b-a),
    };
  }, [catalogMeta]);

  // Legacy password-reset / account-activation deep-links from Shopify's OLD
  // (pre-NCA) emails:
  //   /account/reset/<customer-id>/<token>
  //   /account/activate/<customer-id>/<token>
  // New Customer Accounts is passwordless and no longer issues these. If someone
  // follows an old link from their inbox, send them to the new sign-in flow
  // instead of showing a dead password form.
  const isResetPage    = /^\/account\/reset\/\d+\/[A-Za-z0-9-]+\/?$/.test(path);
  const isActivatePage = /^\/account\/activate\/\d+\/[A-Za-z0-9-]+\/?$/.test(path);

  if (isResetPage || isActivatePage) {
    if (typeof window !== 'undefined') {
      window.location.href = workerLoginUrl('/');
    }
    return null;
  }

  // /join — standalone newsletter landing (the link to paste in IG bio,
  // Discogs profile, mailer QR). Trailing slash optional to match the rest
  // of the site's routing.
  const isJoinPage = /^\/join\/?$/.test(path);
  if (isJoinPage) return <JoinPage onBack={()=>navigate('/')} />;

  // /radar — daily Bandcamp house-discovery crate. Path-routed like /join; the
  // page gates itself behind the admin secret for now (Phase 2: subscriber auth).
  const isRadarPage = /^\/radar\/?$/.test(path);
  if (isRadarPage) return <RadarPage onBack={()=>navigate('/')} />;

  if(page==='login') return (
    <div style={{background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
      <Nav onLogo={()=>setPage('shop')}><button onClick={()=>setPage('shop')} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'5px 12px',borderRadius:2,whiteSpace:'nowrap'}}>← Shop</button></Nav>
      <LoginScreen onLogin={()=>setPage('admin')} />
    </div>
  );

  if(page==='admin') return (
    <div style={{background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
      <Nav onLogo={()=>setPage('shop')}><button onClick={()=>setPage('shop')} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'5px 12px',borderRadius:2,whiteSpace:'nowrap'}}>← Shop</button></Nav>
      <AdminPanel records={records} onUpdate={(id,p)=>setRecords(rs=>rs.map(r=>r.id===id?{...r,...p}:r))} onAdd={rec=>setRecords(rs=>[...rs,rec])} onDelete={id=>setRecords(rs=>rs.filter(r=>r.id!==id))} onLogout={()=>setPage('shop')} onLoadMore={loadMore} hasMore={hasMore} loadingMore={loadingMore} />
    </div>
  );

  return (
    <PlayerProvider gate={playGate}>
    <div style={{background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif",paddingBottom:'var(--player-h, 64px)'}}>
      <Nav onLogo={()=>{setPage('shop');setFilters(f=>({...f,forthcoming:false,dnb:false}));}}>
        {/* Icon buttons — row 1, top-right beside the logo on mobile */}
        <div style={{display:'flex',gap:6,alignItems:'center',order:navMobile?1:2,flexShrink:0,marginLeft:navMobile?'auto':0}}>
          <button onClick={()=>setAccountOpen(true)} title={auth?'My Account':'Sign In'} aria-label={auth?'My Account':'Sign In'} style={{background:S.surf,border:`1px solid ${S.border}`,borderRadius:2,padding:'5px 10px',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={auth?S.accent:S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </button>
          <button onClick={()=>setWishOpen(true)} title="Wishlist" aria-label="Wishlist" style={{background:S.surf,border:`1px solid ${S.border}`,borderRadius:2,padding:'5px 10px',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,gap:5,color:wishItems.length>0?S.accent:S.muted}}>
            <HeartIcon wished={wishItems.length>0} size={13} />
            {wishItems.length>0 && <span style={{fontSize:10,fontWeight:700,letterSpacing:1}}>{wishItems.length}</span>}
          </button>
          <button onClick={()=>{setCartOpen(true);}} style={{background:cartCount>0?S.accent:S.surf,color:cartCount>0?'#080808':S.muted,border:`1px solid ${S.border}`,borderRadius:2,padding:'5px 12px',cursor:'pointer',fontSize:10,fontWeight:700,letterSpacing:1.5,textTransform:'uppercase',whiteSpace:'nowrap',flexShrink:0}}>
            {cartCount>0?`Cart (${cartCount})`:'Cart'}
          </button>
        </div>
        {/* FORTHCOMING + Search — inline on desktop, full-width row 2 on mobile */}
        <div style={{display:'flex',gap:6,alignItems:'center',order:navMobile?2:1,flex:navMobile?'1 1 100%':'1 1 auto',justifyContent:navMobile?'stretch':'flex-end',minWidth:0}}>
          <button onClick={()=>setFilters(f=>({...f, forthcoming:!f.forthcoming, dnb:false, genre:null, label:null, year:null}))} title={filters.forthcoming?'Exit Forthcoming — back to all records':'Forthcoming pre-orders'} style={{background:filters.forthcoming?S.accent:'transparent',color:filters.forthcoming?'#080808':S.accent,border:`1.5px solid ${S.accent}`,borderRadius:2,padding:'5px 12px',cursor:'pointer',fontSize:10,fontWeight:800,letterSpacing:1.5,textTransform:'uppercase',whiteSpace:'nowrap',transition:'all 0.15s',fontFamily:'inherit',flexShrink:0}}>{filters.forthcoming?'✕ Forthcoming':'Forthcoming'}</button>
          <button onClick={()=>setFilters(f=>({...f, dnb:!f.dnb, forthcoming:false, genre:null, label:null, year:null}))} title={filters.dnb?'Exit Drum & Bass — back to all records':'Drum & Bass Only'} style={{background:filters.dnb?S.accent:'transparent',color:filters.dnb?'#080808':S.accent,border:`1.5px solid ${S.accent}`,borderRadius:2,padding:'5px 12px',cursor:'pointer',fontSize:10,fontWeight:800,letterSpacing:1.5,textTransform:'uppercase',whiteSpace:'nowrap',transition:'all 0.15s',fontFamily:'inherit',flexShrink:0}}>{filters.dnb?'✕ Drum & Bass':'Drum & Bass'}</button>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…" style={{background:S.surf,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'5px 10px',fontSize:11,fontFamily:'inherit',outline:'none',maxWidth:navMobile?'none':180,minWidth:80,flex:1,boxSizing:'border-box'}} />
        </div>
      </Nav>

      <div style={{padding:'56px 20px 44px',borderBottom:`1px solid ${S.border}`,maxWidth:1100,margin:'0 auto',textAlign:'left'}}>
        <Logo scale={window.innerWidth<480?1.4:2.2} />
        {filters.forthcoming
          ? <p style={{color:S.accent,fontSize:11,margin:'16px 0 0',letterSpacing:3,textTransform:'uppercase',fontWeight:700,textAlign:'left'}}>Forthcoming · Pre-order Now</p>
          : <p style={{color:S.muted,fontSize:11,margin:'16px 0 0',letterSpacing:3,textTransform:'uppercase',textAlign:'left'}}>Vinyl Delivered Worldwide</p>
        }
        {filters.forthcoming && <p style={{color:S.muted,fontSize:11,margin:'10px 0 0',lineHeight:1.6,maxWidth:520,textAlign:'left'}}>The releases we're most excited about, before they drop. Reserve yours now — we ship the moment they land in Madrid. Estimated arrival shown on each release.</p>}
        {filters.forthcoming && <button onClick={()=>setFilter('forthcoming',false)} style={{marginTop:18,background:'transparent',border:`1px solid ${S.border}`,color:S.text,cursor:'pointer',fontSize:10,fontWeight:700,letterSpacing:1.5,textTransform:'uppercase',padding:'8px 16px',borderRadius:2,fontFamily:'inherit',transition:'all 0.15s'}}>← Back to all records</button>}
      </div>

      <div style={{maxWidth:1100,margin:'0 auto',padding:'28px 16px'}}>
        <Filters filters={filters} onChange={setFilter} records={records} allLabels={allLabels} allGenres={filters.dnb ? allGenres.filter(g=>DNB_TAGS.some(d=>d.toLowerCase()===g.toLowerCase())) : allGenres.filter(g=>!DNB_TAGS.some(d=>d.toLowerCase()===g.toLowerCase()))} allYears={allYears} />
        {filters.forthcoming && (
          <div style={{display:'flex',justifyContent:'flex-end',gap:6,marginBottom:14}}>
            {['list','grid'].map(v=>(
              <button key={v} onClick={()=>setForthcomingView(v)} style={{background:forthcomingView===v?S.accent:'transparent',color:forthcomingView===v?'#080808':S.muted,border:`1px solid ${forthcomingView===v?S.accent:S.border}`,borderRadius:2,padding:'5px 14px',cursor:'pointer',fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:'uppercase',fontFamily:'inherit',transition:'all 0.15s'}}>{v}</button>
            ))}
          </div>
        )}
        {filters.forthcoming && forthcomingView==='list' ? (
          <div>
            {filtered.map(r=><ForthcomingRow key={r.id} r={r} onOpen={openProduct} onAdd={addToCart} isWished={isWished} onWishlistToggle={wishlistToggle} />)}
          </div>
        ) : (
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:12}}>
            {filtered.flatMap((r, i) => {
              const card = <RecordCard key={r.id} r={r} onOpen={openProduct} onAdd={addToCart} isWished={isWished} onWishlistToggle={wishlistToggle} />;
              // Drop a newsletter card into the row after the 12th record, but only
              // when there are enough records that it doesn't look out of place.
              if (i === 11 && filtered.length > 14) {
                return [card, <NewsletterSignup key="nl-grid" variant="grid" source="grid" />];
              }
              return [card];
            })}
          </div>
        )}
        {!filtered.length&&<div style={{textAlign:'center',color:S.muted,fontSize:12,padding:'60px 0'}}>No records found.</div>}
        {hasMore&&(
          <div style={{textAlign:'center',marginTop:32}}>
            <button onClick={loadMore} disabled={loadingMore} style={{background:'none',border:`1px solid ${S.border}`,color:loadingMore?S.muted:S.text,cursor:loadingMore?'not-allowed':'pointer',fontSize:10,fontWeight:700,letterSpacing:2,textTransform:'uppercase',padding:'12px 32px',borderRadius:2}}>
              {loadingMore?'Loading…':'Load More'}
            </button>
          </div>
        )}
      </div>

      <NewsletterSignup variant="footer" source="footer" />

      <div style={{borderTop:`1px solid ${S.border}`,padding:'24px 20px',textAlign:'center',marginTop:40}}>
        <span style={{fontSize:9,color:S.muted,letterSpacing:3}}>HOUSEONLY · VINYL RECORD STORE · WORLDWIDE SHIPPING</span>
        <div style={{marginTop:14,display:'flex',gap:16,justifyContent:'center',flexWrap:'wrap'}}>
          {[['Privacy Policy','privacy-policy'],['Terms of Service','terms-of-service'],['Returns & Refunds','refund-policy'],['Shipping Policy','shipping-policy'],['Legal Notice','legal-notice'],['Contact','contact-information']].map(([label,slug])=>(
            <button key={slug} onClick={()=>{setPolicySlug(slug);setCartOpen(false);}} style={{background:'none',border:'none',cursor:'pointer',fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',padding:0,fontFamily:'inherit',transition:'color 0.15s'}} onMouseEnter={e=>e.target.style.color=S.accent} onMouseLeave={e=>e.target.style.color=S.muted}>{label}</button>
          ))}
        </div>
      </div>

      <PolicyDrawer slug={policySlug} onClose={()=>setPolicySlug(null)} />

      <Modal r={selected} onClose={closeProduct} onAdd={r=>{addToCart(r);setCartOpen(true);}} isWished={isWished} onWishlistToggle={wishlistToggle} />
      <CartDrawer cart={cart} open={cartOpen} onClose={()=>setCartOpen(false)} onRemove={id=>setCart(c=>c.filter(i=>i.id!==id))} onCheckout={async()=>{ await shopifyCheckout(cart, auth?.session||null); setCart([]); setCartOpen(false); }} />
      <AccountDrawer open={accountOpen} onClose={()=>setAccountOpen(false)} auth={auth} profile={profile} onSignIn={handleSignIn} onLogout={()=>{handleLogout();setAccountOpen(false);}} />
      <WishlistDrawer items={wishItems} open={wishOpen} onClose={()=>setWishOpen(false)} onRemove={wishlistRemove} onAddToCart={addWishlistItemToCart} onAddAllToCart={addAllWishlistToCart} onOpenItem={openWishlistItem} isLoggedIn={!!auth} onSignInClick={()=>{setWishOpen(false);setAccountOpen(true);}} />
      {audioGateOpen && (
        <div onClick={()=>setAudioGateOpen(false)} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
          <div onClick={e=>e.stopPropagation()} style={{background:S.surf,border:`1px solid ${S.border}`,borderRadius:6,padding:'28px 26px',maxWidth:360,width:'100%',textAlign:'center'}}>
            <div style={{fontSize:11,color:S.accent,letterSpacing:2,textTransform:'uppercase',fontWeight:700,marginBottom:10}}>Pre-order previews</div>
            <div style={{fontSize:14,color:S.text,lineHeight:1.55,marginBottom:6}}>Create a free account to listen to forthcoming releases before they drop.</div>
            <div style={{fontSize:11,color:S.muted,lineHeight:1.5,marginBottom:20}}>The rest of the catalogue plays freely — this is just for the pre-order previews.</div>
            <button onClick={handleSignIn} style={{width:'100%',background:S.accent,color:'#080808',border:'none',borderRadius:4,padding:'12px 0',cursor:'pointer',fontSize:12,fontWeight:800,letterSpacing:1.5,textTransform:'uppercase',fontFamily:'inherit',marginBottom:10}}>Sign in / Create account</button>
            <button onClick={()=>setAudioGateOpen(false)} style={{background:'transparent',border:'none',color:S.muted,cursor:'pointer',fontSize:11,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit'}}>Not now</button>
          </div>
        </div>
      )}
      <PlayerBar isWished={isWished} onWishlistToggle={wishlistToggle} onOpenRelease={openProduct} />
    </div>
    </PlayerProvider>
  );
}
