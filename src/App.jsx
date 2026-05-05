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

const GENRE_TAGS = ['Detroit House','Chicago House','Afro House','Soulful House','Acid House','Disco House','Tech House','Deep House','Electronic','Nu-Disco','Funk','Soul','Jazz','Electronica','Ambient','Techno','Drum & Bass','Breakbeat','Reggae','Dub','Hip Hop','R&B'];
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
  const genre = GENRE_TAGS.find(g => tags.some(t => t.toLowerCase() === g.toLowerCase()))
    || tags.find(t => !SKIP_TAGS.some(s => s.toLowerCase()===t.toLowerCase()) && !/^\d{4}$/.test(t) && !/^label:/i.test(t) && !/^(12|excl|lp|ep|single|vinyl|kudos)/i.test(t))
    || '';
  const year = parseInt(tags.find(t => /^\d{4}$/.test(t)) || '0');
  const label = tags.find(t => t.toLowerCase().startsWith('label:'))?.slice(6).trim()
    || tags.find(t => !SKIP_TAGS.some(s => s.toLowerCase()===t.toLowerCase()) && !/^\d{4}$/.test(t) && !/^(12|excl|lp|ep|single)/i.test(t)) || '';
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
  const artist= node.vendor || (desc.includes(' — ') ? desc.split(' — ')[0].trim() : '');
  let tracks = [];
  const tracksMatch = bodyHtml.match(/<script[^>]+id="tracks"[^>]*>([\s\S]*?)<\/script>/);
  if (tracksMatch) { try { tracks = JSON.parse(tracksMatch[1]); } catch {} }
  const catalog = v?.sku||'';
  const title = node.title||'';
  return {
    id: node.id, shopifyVariantId: v?.id,
    title, artist, label,
    catalog, genre, year,
    slug: makeSlug(artist, title, catalog),
    month: new Date().getMonth()+1,
    price: parseFloat(v?.price?.amount||18.99),
    stock: v?.quantityAvailable??10,
    coverUrl: img?.url||null, tracks, desc, g:'135deg,#1a1a2e,#16213e',
  };
}

async function fetchShopifyProducts(cursor=null) {
  const after = cursor ? `, after: "${cursor}"` : '';
  const data = await shopifyQuery(`{
    products(first: 24${after}) {
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
async function shopifyCheckout(cartItems, customerAccessToken=null) {
  const lines = cartItems
    .filter(i => i.shopifyVariantId)
    .map(i => ({ merchandiseId: i.shopifyVariantId, quantity: i.qty }));
  if (!lines.length) throw new Error('No items in cart.');
  const input = { lines };
  if (customerAccessToken) {
    input.buyerIdentity = { customerAccessToken };
  }
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
// Customer accounts use Shopify Storefront API. Access tokens are stored
// in localStorage. Anonymous users still get a working wishlist via local
// storage (the useWishlist hook below).

const AUTH_KEY  = 'houseonly_customer_auth';
const WISH_KEY  = 'houseonly_wishlist';

function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.token || !parsed?.expiresAt) return null;
    if (new Date(parsed.expiresAt).getTime() < Date.now()) {
      localStorage.removeItem(AUTH_KEY);
      return null;
    }
    return parsed;
  } catch { return null; }
}

function saveAuth(auth) {
  if (auth) localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
  else localStorage.removeItem(AUTH_KEY);
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

async function customerProfile(token) {
  if (!token) return null;
  try {
    const d = await shopifyQuery(`
      query($t: String!) {
        customer(customerAccessToken: $t) {
          id email firstName lastName
        }
      }`, { t: token });
    return d.customer || null;
  } catch { return null; }
}

async function customerOrders(token) {
  if (!token) return [];
  try {
    const d = await shopifyQuery(`
      query($t: String!) {
        customer(customerAccessToken: $t) {
          orders(first: 25, sortKey: PROCESSED_AT, reverse: true) {
            edges {
              node {
                id
                orderNumber
                processedAt
                financialStatus
                fulfillmentStatus
                statusUrl
                totalPrice { amount currencyCode }
                lineItems(first: 25) {
                  edges {
                    node {
                      title
                      quantity
                      variant {
                        title
                        image { url(transform: {maxWidth:120, maxHeight:120}) }
                        product { handle }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`, { t: token });
    const edges = d?.customer?.orders?.edges || [];
    return edges.map(e => {
      const o = e.node;
      return {
        id: o.id,
        number: o.orderNumber,
        date: o.processedAt,
        financialStatus: o.financialStatus,
        fulfillmentStatus: o.fulfillmentStatus,
        statusUrl: o.statusUrl,
        total: o.totalPrice ? `${Number(o.totalPrice.amount).toFixed(2)} ${o.totalPrice.currencyCode}` : '',
        items: (o.lineItems?.edges || []).map(le => ({
          title: le.node.title,
          quantity: le.node.quantity,
          variantTitle: le.node.variant?.title || '',
          imageUrl: le.node.variant?.image?.url || '',
          handle: le.node.variant?.product?.handle || '',
        })),
      };
    });
  } catch (e) {
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

async function fetchServerWishlist(token) {
  const r = await fetch(`${WORKER_URL}?action=wishlist&token=${encodeURIComponent(token)}`);
  if (!r.ok) return null;
  const d = await r.json();
  if (d.error) return null;
  return d.items || [];
}

async function postServerWishlistItem(token, item) {
  const r = await fetch(`${WORKER_URL}?action=wishlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, item }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  if (d.error) return null;
  return d.items || null;
}

async function deleteServerWishlistItem(token, handle) {
  const r = await fetch(`${WORKER_URL}?action=wishlist`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, handle }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  if (d.error) return null;
  return d.items || null;
}

async function mergeServerWishlist(token, items) {
  const r = await fetch(`${WORKER_URL}?action=wishlist-merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, items }),
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

function PlayerProvider({ children }) {
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

  const playRelease = useCallback((r) => {
    const items = itemsFromRelease(r);
    if (!items.length) return;
    setQueue(items);
    setCurIdx(0);
    setPlaying(true);
  }, []);

  const addToQueue = useCallback((r) => {
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
  }, [currentIdx]);

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
    if (a.src !== cur.url) {
      a.src = cur.url;
    }
    if (isPlaying) {
      a.play().catch(() => setPlaying(false));
    } else {
      a.pause();
    }
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

// ── PLAYER BAR (sticky bottom) ──────────────────────────────────
function PlayerBar({ isWished, onWishlistToggle, onOpenRelease }) {
  const p = usePlayer();
  const [queueOpen, setQueueOpen] = useState(false);
  if (!p) return null;
  const { current, currentRelease, isPlaying, progress, duration, position, volume, muted, queue, currentIdx,
          playNext, playPrev, togglePlayPause, seek, setVolPct, toggleMute } = p;

  // Hide entirely if nothing has been played yet
  if (!current || !currentRelease) return null;

  const wished = isWished && currentRelease ? isWished(currentRelease) : false;
  const trackName = (current.name || '').replace(/^\d+_\d+_/, '').replace(/\.(mp3|wav|flac|aac|ogg)$/i, '');
  const onScrub = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    seek(Math.max(0, Math.min(1, pct)));
  };

  return (
    <>
      {queueOpen && <QueuePanel onClose={()=>setQueueOpen(false)} onOpenRelease={onOpenRelease} />}
      <div style={{ position:'fixed', bottom:0, left:0, right:0, background:S.surf, borderTop:`1px solid ${S.border}`, zIndex:900, padding:'10px 14px', display:'flex', alignItems:'center', gap:14, fontFamily:"'Inter',system-ui,sans-serif" }}>
        {/* Transport controls */}
        <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
          <button onClick={playPrev} aria-label="Previous" style={transportBtnStyle(currentIdx > 0)}>⏮</button>
          <button onClick={togglePlayPause} aria-label={isPlaying?'Pause':'Play'} style={{ ...transportBtnStyle(true), width:34, height:34, background:S.accent, color:'#080808' }}>{isPlaying?'⏸':'▶'}</button>
          <button onClick={playNext} aria-label="Next" style={transportBtnStyle(currentIdx < queue.length - 1)}>⏭</button>
        </div>

        {/* Time + scrubber */}
        <div style={{ display:'flex', alignItems:'center', gap:8, flex:1, minWidth:0 }}>
          <span style={{ fontSize:10, color:S.muted, fontFamily:'monospace', flexShrink:0 }}>{fmtTime(position)}</span>
          <div onClick={onScrub} style={{ flex:1, height:4, background:S.border, borderRadius:2, cursor:'pointer', position:'relative' }}>
            <div style={{ width:`${progress*100}%`, height:'100%', background:S.accent, borderRadius:2, transition:'width 0.1s' }} />
          </div>
          <span style={{ fontSize:10, color:S.muted, fontFamily:'monospace', flexShrink:0 }}>{fmtTime(duration)}</span>
        </div>

        {/* Volume */}
        <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
          <button onClick={toggleMute} aria-label={muted?'Unmute':'Mute'} style={transportBtnStyle(true)}>{muted||volume===0?'🔇':volume<0.5?'🔉':'🔊'}</button>
          <input type="range" min="0" max="1" step="0.05" value={muted?0:volume} onChange={e=>setVolPct(parseFloat(e.target.value))} style={{ width:60, accentColor:S.accent, cursor:'pointer' }} />
        </div>

        {/* Cover + track info */}
        <div onClick={()=>currentRelease && onOpenRelease && onOpenRelease(currentRelease)} style={{ display:'flex', alignItems:'center', gap:10, minWidth:0, maxWidth:280, cursor:'pointer', flexShrink:0 }}>
          <div style={{ width:36, height:36, flexShrink:0, background:`linear-gradient(${currentRelease.g||'135deg,#1a1a2e,#16213e'})`, backgroundImage:coverSrc(currentRelease.coverUrl)?`url(${coverSrc(currentRelease.coverUrl)})`:'none', backgroundSize:'cover', backgroundPosition:'center', borderRadius:2 }} />
          <div style={{ minWidth:0, lineHeight:1.3 }}>
            <div style={{ fontSize:11, fontWeight:700, color:S.text, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{trackName}</div>
            <div style={{ fontSize:10, color:S.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{currentRelease.artist} — {currentRelease.title}</div>
          </div>
        </div>

        {/* Heart (wishlist current release) */}
        {onWishlistToggle && (
          <button onClick={()=>onWishlistToggle(currentRelease)} aria-label={wished?'Remove from wishlist':'Add to wishlist'} title={wished?'Remove from wishlist':'Add to wishlist'} style={{ background:'transparent', border:`1px solid ${wished?S.accent:S.border}`, color:wished?S.accent:S.muted, borderRadius:2, padding:'5px 7px', cursor:'pointer', display:'flex', alignItems:'center', flexShrink:0 }}>
            <HeartIcon wished={wished} size={12} />
          </button>
        )}

        {/* Queue toggle */}
        <button onClick={()=>setQueueOpen(o=>!o)} aria-label="Queue" title="Queue" style={{ background:queueOpen?S.accent:'transparent', border:`1px solid ${queueOpen?S.accent:S.border}`, color:queueOpen?'#080808':S.muted, borderRadius:2, padding:'5px 9px', cursor:'pointer', flexShrink:0, fontSize:11 }}>
          ☰ {queue.length}
        </button>
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
  const { queue, currentIdx, removeFromQueue, clearQueue } = p;

  return (
    <div style={{ position:'fixed', bottom:64, right:14, width:340, maxHeight:'60vh', background:S.surf, border:`1px solid ${S.border}`, borderRadius:4, zIndex:899, display:'flex', flexDirection:'column', boxShadow:'0 8px 24px rgba(0,0,0,0.5)', fontFamily:"'Inter',system-ui,sans-serif" }}>
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
              <div onClick={()=>onOpenRelease && onOpenRelease(r)} style={{ width:32, height:32, flexShrink:0, background:`linear-gradient(${r.g||'135deg,#1a1a2e,#16213e'})`, backgroundImage:coverSrc(r.coverUrl)?`url(${coverSrc(r.coverUrl)})`:'none', backgroundSize:'cover', backgroundPosition:'center', borderRadius:2, cursor:'pointer' }} />
              <div style={{ minWidth:0, flex:1, lineHeight:1.3 }}>
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
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:6 }}>
          <span style={{ fontSize:15, fontWeight:800, color:S.accent }}>€{r.price.toFixed(2)}</span>
          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
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
              const eligible = isBackorderEligible(r);
              if (r.stock > 0) {
                return <button onClick={e=>{e.stopPropagation();onAdd(r);}} style={{ background:hov?S.accent:S.border, color:hov?'#080808':S.muted, border:'none', borderRadius:2, cursor:'pointer', fontSize:9, fontWeight:700, letterSpacing:1.5, padding:'5px 10px', textTransform:'uppercase', transition:'all 0.15s' }}>+ Cart</button>;
              }
              if (eligible) {
                return <button onClick={e=>{e.stopPropagation();onOpen(r);}} title="Request this release — we'll confirm availability" style={{ background:hov?S.accent:'transparent', color:hov?'#080808':S.accent, border:`1px solid ${S.accent}`, borderRadius:2, cursor:'pointer', fontSize:9, fontWeight:700, letterSpacing:1.5, padding:'5px 10px', textTransform:'uppercase', transition:'all 0.15s' }}>Request</button>;
              }
              return <button disabled style={{ background:S.border, color:S.muted, border:'none', borderRadius:2, cursor:'not-allowed', fontSize:9, fontWeight:700, letterSpacing:1.5, padding:'5px 10px', textTransform:'uppercase', opacity:0.4 }}>Sold Out</button>;
            })()}
          </div>
        </div>
        {r.stock>0&&r.stock<=3&&<div style={{ fontSize:8, color:'#ff8800', marginTop:5, letterSpacing:1, textTransform:'uppercase' }}>Only {r.stock} left</div>}
        {r.stock===0 && isBackorderEligible(r) && <div style={{ fontSize:8, color:S.accent, marginTop:5, letterSpacing:1, textTransform:'uppercase' }}>Backorder available</div>}
        {r.stock===0 && !isBackorderEligible(r) && <div style={{ fontSize:8, color:S.danger, marginTop:5, letterSpacing:1, textTransform:'uppercase' }}>Out of stock</div>}
      </div>
    </div>
  );
}

// ── BACKORDER REQUEST FORM ─────────────────────────────────────
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
    // Different release (or nothing playing): replace queue with this release and start at clicked track
    player.playRelease({ ...release, tracks });
    // playRelease starts at idx 0; jump forward to the clicked track once state has propagated.
    // Use a microtask to let the queue state apply before jumping.
    if (i > 0) Promise.resolve().then(() => player.jumpToQueueIdx(i));
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
            {r.stock === 0 && isBackorderEligible(r) ? (
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
                  {r.stock > 0
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
      <div style={{ position:'fixed', top:0, right:0, bottom:0, width:Math.min(340,window.innerWidth), background:S.surf, borderLeft:`1px solid ${S.border}`, zIndex:1000, transform:open?'translateX(0)':'translateX(100%)', transition:'transform 0.25s ease', display:'flex', flexDirection:'column' }}>
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
function AccountDrawer({ open, onClose, auth, profile, onLogin, onSignup, onLogout, onRecover }) {
  const [mode, setMode] = useState('login'); // login | signup | recover
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');

  // Orders panel state
  const [view, setView] = useState('home'); // home | orders
  const [orders, setOrders] = useState(null); // null = not loaded, [] = empty
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersErr, setOrdersErr] = useState('');

  useEffect(() => { setErr(''); setInfo(''); }, [mode]);
  // Reset to home view when drawer closes or auth changes
  useEffect(() => { if (!open) setView('home'); }, [open]);
  useEffect(() => { setOrders(null); setView('home'); }, [auth?.token]);

  const loadOrders = async () => {
    if (!auth?.token) return;
    setOrdersLoading(true); setOrdersErr('');
    try {
      const list = await customerOrders(auth.token);
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

  const submit = async (e) => {
    e?.preventDefault?.();
    setErr(''); setInfo(''); setBusy(true);
    try {
      if (mode === 'login') {
        await onLogin(email.trim(), pw);
        setEmail(''); setPw('');
      } else if (mode === 'signup') {
        await onSignup(email.trim(), pw, firstName.trim(), lastName.trim());
        setEmail(''); setPw(''); setFirstName(''); setLastName('');
      } else if (mode === 'recover') {
        await onRecover(email.trim());
        setInfo('Check your email for a reset link.');
      }
    } catch (e) {
      setErr(e?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = { background:S.bg, border:`1px solid ${S.border}`, color:S.text, borderRadius:2, padding:'9px 12px', fontSize:12, fontFamily:'inherit', outline:'none', width:'100%', boxSizing:'border-box' };
  const tabStyle = (active) => ({ flex:1, background:'none', border:'none', borderBottom:`2px solid ${active?S.accent:'transparent'}`, color:active?S.text:S.muted, padding:'10px 0', fontSize:10, letterSpacing:1.5, textTransform:'uppercase', fontWeight:700, cursor:'pointer', fontFamily:'inherit' });

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
              <div style={{ fontSize:14, fontWeight:700, color:S.text, marginBottom:6 }}>{profile?.firstName ? `${profile.firstName} ${profile.lastName||''}`.trim() : 'Welcome'}</div>
              <div style={{ fontSize:11, color:S.muted, marginBottom:24 }}>{profile?.email || ''}</div>
              <button onClick={goToOrders} style={{ display:'block', width:'100%', textAlign:'center', padding:'10px 14px', background:S.bg, border:`1px solid ${S.border}`, borderRadius:2, color:S.text, fontSize:10, letterSpacing:1.5, textTransform:'uppercase', fontWeight:700, cursor:'pointer', fontFamily:'inherit', marginBottom:10 }}>My Orders →</button>
              <button onClick={onLogout} style={{ width:'100%', padding:'10px 14px', background:'transparent', border:`1px solid ${S.border}`, borderRadius:2, color:S.muted, fontSize:10, letterSpacing:1.5, textTransform:'uppercase', fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>Sign Out</button>
            </div>
          ) : (
            <>
              {mode !== 'recover' && (
                <div style={{ marginBottom:20, paddingBottom:14, borderBottom:`1px solid ${S.border}` }}>
                  <div style={{ fontSize:10, color:S.muted, letterSpacing:2, textTransform:'uppercase', fontWeight:700 }}>Sign In</div>
                </div>
              )}

              <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:10 }}>
                <input type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" autoComplete="email" style={inputStyle} />
                {mode !== 'recover' && (
                  <input type="password" required value={pw} onChange={e=>setPw(e.target.value)} placeholder="Password" autoComplete="current-password" style={inputStyle} />
                )}

                {err && <div style={{ fontSize:10, color:S.danger, padding:'4px 0' }}>{err}</div>}
                {info && <div style={{ fontSize:10, color:S.accent, padding:'4px 0' }}>{info}</div>}

                <button type="submit" disabled={busy} style={{ marginTop:6, padding:'12px 14px', background:S.accent, border:'none', borderRadius:2, color:'#080808', fontSize:11, letterSpacing:1.5, textTransform:'uppercase', fontWeight:800, cursor:busy?'wait':'pointer', fontFamily:'inherit', opacity:busy?0.6:1 }}>
                  {busy ? '…' : (mode==='login' ? 'Sign In' : 'Send Reset Link')}
                </button>

                {mode === 'login' && (
                  <button type="button" onClick={()=>setMode('recover')} style={{ background:'none', border:'none', color:S.muted, fontSize:10, cursor:'pointer', textAlign:'center', padding:6, fontFamily:'inherit', textDecoration:'underline' }}>Forgot password?</button>
                )}
                {mode === 'recover' && (
                  <button type="button" onClick={()=>setMode('login')} style={{ background:'none', border:'none', color:S.muted, fontSize:10, cursor:'pointer', textAlign:'center', padding:6, fontFamily:'inherit', textDecoration:'underline' }}>← Back to sign in</button>
                )}
              </form>

              <div style={{ marginTop:24, padding:'14px', background:S.bg, border:`1px solid ${S.border}`, borderRadius:2, fontSize:10, color:S.muted, lineHeight:1.6 }}>
                New here? Your account is created automatically when you place your first order. No separate sign-up needed.
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
function WishlistDrawer({ items, open, onClose, onRemove, onAddToCart, onOpenItem, isLoggedIn, onSignInClick }) {
  return (
    <>
      {open && <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:1099, backdropFilter:'blur(2px)' }} />}
      <div style={{ position:'fixed', top:0, right:0, height:'100vh', width:360, maxWidth:'100vw', background:S.surf, borderLeft:`1px solid ${S.border}`, transform:open?'translateX(0)':'translateX(100%)', transition:'transform 0.25s', zIndex:1100, display:'flex', flexDirection:'column' }}>
        <div style={{ padding:'18px 20px', borderBottom:`1px solid ${S.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontSize:11, color:S.muted, letterSpacing:2, textTransform:'uppercase', fontWeight:700 }}>Wishlist {items.length>0 && `(${items.length})`}</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:S.muted, cursor:'pointer', fontSize:22, padding:0, lineHeight:1 }}>×</button>
        </div>

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
    const extract = (pattern) => {
      const m = fullText.match(pattern);
      return m ? m[1].trim().split(/\s{2,}|\n/)[0].trim() : '';
    };
    const label = extract(/Label[:\s]+([^\n\r]+)/i);
    const genreRaw = extract(/(?:Genre|Style)[:\s]+([^\n\r]+)/i);
    const GENRE_MAP = {
      'deep house': 'Deep House', 'tech house': 'Tech House',
      'afro house': 'Afro House', 'chicago house': 'Chicago House',
      'soulful house': 'Soulful House', 'acid house': 'Acid House',
      'detroit house': 'Detroit House', 'disco house': 'Disco House',
      'electronic': 'Electronic', 'house': 'Deep House',
    };
    const genreLower = genreRaw.toLowerCase();
    const genre = Object.entries(GENRE_MAP).find(([k]) => genreLower.includes(k))?.[1] || '';
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
            const blob = await coverFile.async('blob');
            const ext  = coverFile.name.split('.').pop().toLowerCase();
            coverUrl = await uploadToR2(blob, `covers/${safeKey}.${ext}`, ext==='png'?'image/png':'image/jpeg');
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
          'Tags': ['vinyl', label ? `label:${label}` : '', genre, String(year)].filter(Boolean).join(', '),
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
      const rawRetail=dealerEUR>0?dealerEUR*(1+m):0; const retailP=rawRetail>0?(Math.ceil(rawRetail)-0.01).toFixed(2):'';
      const costEUR=dealerEUR>0?dealerEUR.toFixed(2):'';
      const formatDisplay=fmt?fmt.display:r.format;
      const is2LP=/2[\s-]?(?:x\s*)?lp|double\s*lp|3[\s-]?lp|2xlp/i.test(title)||/2[\s-]?(?:x\s*)?lp|2xlp/i.test(formatDisplay);
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
          {[['GBP→EUR',fx,setFx,0.01],['Margin %',margin,setMargin,1],['Weight g',stdW,setStdW,100],['2LP g',dblW,setDblW,100]].map(([label,val,setter,step])=>(
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

        const shopifyTags = ['vinyl','dbh', label?`label:${label}`:'', genre, String(year), tags?tags:''].filter(Boolean).join(', ');

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

// ── ADMIN PANEL ────────────────────────────────────────────────
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
        </div>
        {tab==='zip'   && <ZipImporter />}
        {tab==='kudos' && <KudosImporter />}
        {tab==='dbh'   && <DBHImporter />}
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
      <div style={{position:'fixed',top:0,right:0,bottom:0,width:Math.min(560,window.innerWidth),background:S.surf,borderLeft:`1px solid ${S.border}`,zIndex:1000,transform:open?'translateX(0)':'translateX(100%)',transition:'transform 0.25s ease',display:'flex',flexDirection:'column'}}>
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
  return (
    <nav style={{position:'sticky',top:0,zIndex:200,background:'rgba(8,8,8,0.96)',backdropFilter:'blur(8px)',borderBottom:`1px solid ${S.border}`,padding:'0 16px',height:52,display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
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
  const [filters,setFilters]             = useState({genre:null,label:null,year:null});
  const [search,setSearch]               = useState('');
  const [page,setPage]                   = useState('shop');
  const [path,setPath]                   = useState(typeof window!=='undefined'?window.location.pathname:'/');

  // ── AUTH + WISHLIST STATE ────────────────────────────────────
  const [auth, setAuth]                   = useState(()=>loadAuth());
  const [profile, setProfile]             = useState(null);
  const [accountOpen, setAccountOpen]     = useState(false);
  const [wishItems, setWishItems]         = useState(()=>loadLocalWishlist());
  const [wishOpen, setWishOpen]           = useState(false);

  // Persist anonymous wishlist to localStorage on every change
  useEffect(()=>{ saveLocalWishlist(wishItems); }, [wishItems]);

  // When auth changes: load profile, sync wishlist
  useEffect(()=>{
    let cancelled = false;
    if (!auth?.token) { setProfile(null); return; }

    (async () => {
      const p = await customerProfile(auth.token);
      if (cancelled) return;
      if (!p) {
        // Token rejected → log out
        saveAuth(null); setAuth(null); setProfile(null);
        return;
      }
      setProfile(p);
      // Merge local list into server, then pull authoritative list
      const localItems = loadLocalWishlist();
      let serverItems = null;
      if (localItems.length > 0) {
        serverItems = await mergeServerWishlist(auth.token, localItems);
      } else {
        serverItems = await fetchServerWishlist(auth.token);
      }
      if (cancelled) return;
      if (Array.isArray(serverItems)) {
        setWishItems(serverItems);
      }
    })();
    return () => { cancelled = true; };
  }, [auth?.token]);

  // Auth actions
  const handleLogin = async (email, password) => {
    const tk = await customerLogin(email, password);
    const a = { token: tk.accessToken, expiresAt: tk.expiresAt };
    saveAuth(a); setAuth(a);
  };
  const handleSignup = async (email, password, firstName, lastName) => {
    const tk = await customerSignup(email, password, firstName, lastName);
    const a = { token: tk.accessToken, expiresAt: tk.expiresAt };
    saveAuth(a); setAuth(a);
  };
  const handleLogout = () => { saveAuth(null); setAuth(null); setProfile(null); };
  const handleRecover = async (email) => { await customerRecover(email); };

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
      if (auth?.token) {
        deleteServerWishlistItem(auth.token, item.handle).catch(()=>{});
      }
    } else {
      // Add (optimistic)
      setWishItems(items => [item, ...items.filter(it=>it.handle!==item.handle)]);
      if (auth?.token) {
        postServerWishlistItem(auth.token, item).catch(()=>{});
      }
    }
  };
  const wishlistRemove = (handle) => {
    setWishItems(items => items.filter(it => it.handle !== handle));
    if (auth?.token) {
      deleteServerWishlistItem(auth.token, handle).catch(()=>{});
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

  // Keep `path` in sync with browser back/forward
  useEffect(()=>{
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  },[]);

  // Open modal automatically when URL is /products/<slug> and that record is loaded
  useEffect(()=>{
    const m = path.match(/^\/products\/([^/]+)\/?$/);
    if (!m) { if (selected) setSelected(null); return; }
    const slug = m[1];
    if (selected && selected.slug === slug) return;
    const found = records.find(r => r.slug === slug);
    if (found) setSelected(found);
  },[path, records]);

  // Navigation helpers — push URL + update state in one call
  const navigate = (newPath) => {
    if (window.location.pathname === newPath) return;
    window.history.pushState({}, '', newPath);
    setPath(newPath);
  };
  const openProduct = (r) => {
    setSelected(r);
    navigate(`/products/${r.slug}`);
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

  // Initial Shopify products fetch
  useEffect(()=>{
    fetchShopifyProducts()
      .then(({ products, hasNextPage, endCursor })=>{
        if(products.length){ setRecords(products); setShopifyLoaded(true); setHasMore(hasNextPage); setCursor(endCursor); }
      })
      .catch(e=>setShopifyErr(e.message));
  },[]);

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
    try { const {products,hasNextPage,endCursor}=await fetchShopifyProducts(cursor); setRecords(r=>[...r,...products]); setHasMore(hasNextPage); setCursor(endCursor); } catch(e){setShopifyErr(e.message);}
    setLoadingMore(false);
  };

  const addToCart=r=>setCart(c=>{const ex=c.find(i=>i.id===r.id);return ex?c.map(i=>i.id===r.id?{...i,qty:i.qty+1}:i):[...c,{...r,qty:1}];});
  const setFilter=(k,v)=>setFilters(f=>({...f,[k]:v}));
  const filtered=records.filter(r=>{
    if(filters.genre&&r.genre!==filters.genre) return false;
    if(filters.label&&r.label!==filters.label) return false;
    if(filters.year&&r.year!==filters.year) return false;
    if(search){
      const haystack=`${r.title} ${r.artist} ${r.label} ${r.catalog} ${r.desc} ${r.genre}`.toLowerCase();
      const words=search.toLowerCase().trim().split(/\s+/);
      if(!words.every(w=>haystack.includes(w))) return false;
    }
    return true;
  });
  const cartCount=cart.reduce((s,i)=>s+i.qty,0);

  // When a filter narrows visible results below a threshold but more products
  // exist in the catalog, auto-load the next page in the background. This
  // prevents the "No records found" / nearly-empty state when a customer
  // filters on, say, 2018 but no 2018 products are in the first 24 loaded.
  // Stops when threshold is hit or catalog is exhausted.
  useEffect(()=>{
    const hasActiveFilter = filters.genre || filters.label || filters.year || search;
    if (!hasActiveFilter) return;
    if (loadingMore || !hasMore) return;
    const visibleMatches = filtered.length;
    if (visibleMatches < 6) {
      loadMore();
    }
  }, [filters, search, records.length, hasMore, loadingMore]);

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

  // Password reset / account activation deep-link from Shopify's emails.
  // URL shapes:
  //   /account/reset/<customer-id>/<token>?syclid=...     (forgot password)
  //   /account/activate/<customer-id>/<token>?syclid=...  (new account invitation)
  // We pass the full URL (origin + path + query) to the relevant mutation;
  // Shopify validates it server-side, so we don't parse the token ourselves.
  const isResetPage    = /^\/account\/reset\/\d+\/[A-Za-z0-9-]+\/?$/.test(path);
  const isActivatePage = /^\/account\/activate\/\d+\/[A-Za-z0-9-]+\/?$/.test(path);

  if(isResetPage || isActivatePage) return (
    <ResetPasswordPage
      mode={isActivatePage ? 'activate' : 'reset'}
      resetUrl={typeof window!=='undefined' ? window.location.href : ''}
      onSuccess={(tk)=>{
        setAuth(tk);
        saveAuth(tk);
        window.history.replaceState({}, '', '/');
        setPath('/');
      }}
      onCancel={()=>{
        window.history.replaceState({}, '', '/');
        setPath('/');
      }}
    />
  );

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
    <PlayerProvider>
    <div style={{background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif",paddingBottom:64}}>
      <Nav onLogo={()=>setPage('shop')}>
        <div style={{display:'flex',gap:6,alignItems:'center',flex:1,justifyContent:'flex-end'}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…" style={{background:S.surf,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'5px 10px',fontSize:11,fontFamily:'inherit',outline:'none',width:'100%',maxWidth:180,minWidth:80}} />
          <button onClick={()=>setAccountOpen(true)} title={auth?'My Account':'Sign In'} aria-label={auth?'My Account':'Sign In'} style={{background:S.surf,border:`1px solid ${S.border}`,borderRadius:2,padding:'5px 10px',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={auth?S.accent:S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </button>
          <button onClick={()=>setWishOpen(true)} title="Wishlist" aria-label="Wishlist" style={{background:S.surf,border:`1px solid ${S.border}`,borderRadius:2,padding:'5px 10px',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,gap:5,color:wishItems.length>0?S.accent:S.muted}}>
            <HeartIcon wished={wishItems.length>0} size={13} />
            {wishItems.length>0 && <span style={{fontSize:10,fontWeight:700,letterSpacing:1}}>{wishItems.length}</span>}
          </button>
          <button onClick={()=>{setCartOpen(true);}} style={{background:cartCount>0?S.accent:S.surf,color:cartCount>0?'#080808':S.muted,border:`1px solid ${S.border}`,borderRadius:2,padding:'5px 12px',cursor:'pointer',fontSize:10,fontWeight:700,letterSpacing:1.5,textTransform:'uppercase',whiteSpace:'nowrap'}}>
            {cartCount>0?`Cart (${cartCount})`:'Cart'}
          </button>
        </div>
      </Nav>

      <div style={{padding:'56px 20px 44px',borderBottom:`1px solid ${S.border}`,maxWidth:1100,margin:'0 auto'}}>
        <Logo scale={window.innerWidth<480?1.4:2.2} />
        <p style={{color:S.muted,fontSize:11,margin:'16px 0 0',letterSpacing:3,textTransform:'uppercase'}}>Vinyl Delivered Worldwide</p>
      </div>

      <div style={{maxWidth:1100,margin:'0 auto',padding:'28px 16px'}}>
        <Filters filters={filters} onChange={setFilter} records={records} allLabels={allLabels} allGenres={allGenres} allYears={allYears} />
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:12}}>
          {filtered.map(r=><RecordCard key={r.id} r={r} onOpen={openProduct} onAdd={addToCart} isWished={isWished} onWishlistToggle={wishlistToggle} />)}
        </div>
        {!filtered.length&&<div style={{textAlign:'center',color:S.muted,fontSize:12,padding:'60px 0'}}>No records found.</div>}
        {hasMore&&(
          <div style={{textAlign:'center',marginTop:32}}>
            <button onClick={loadMore} disabled={loadingMore} style={{background:'none',border:`1px solid ${S.border}`,color:loadingMore?S.muted:S.text,cursor:loadingMore?'not-allowed':'pointer',fontSize:10,fontWeight:700,letterSpacing:2,textTransform:'uppercase',padding:'12px 32px',borderRadius:2}}>
              {loadingMore?'Loading…':'Load More'}
            </button>
          </div>
        )}
      </div>

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
      <CartDrawer cart={cart} open={cartOpen} onClose={()=>setCartOpen(false)} onRemove={id=>setCart(c=>c.filter(i=>i.id!==id))} onCheckout={async()=>{ await shopifyCheckout(cart, auth?.token||null); setCart([]); setCartOpen(false); }} />
      <AccountDrawer open={accountOpen} onClose={()=>setAccountOpen(false)} auth={auth} profile={profile} onLogin={handleLogin} onSignup={handleSignup} onLogout={()=>{handleLogout();setAccountOpen(false);}} onRecover={handleRecover} />
      <WishlistDrawer items={wishItems} open={wishOpen} onClose={()=>setWishOpen(false)} onRemove={wishlistRemove} onAddToCart={addWishlistItemToCart} onOpenItem={openWishlistItem} isLoggedIn={!!auth} onSignInClick={()=>{setWishOpen(false);setAccountOpen(true);}} />
      <PlayerBar isWished={isWished} onWishlistToggle={wishlistToggle} onOpenRelease={openProduct} />
    </div>
    </PlayerProvider>
  );
}
