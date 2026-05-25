interface Env {
  R2: R2Bucket;
  WISHLIST: KVNamespace;
  // SYNC_STATE: KV namespace for Discogs↔Shopify sync metadata.
  // Used by Fase 3 sync handlers (bootstrap, status, webhook, polling).
  SYNC_STATE: KVNamespace;
  SHOPIFY_ADMIN_CLIENT_ID: string;
  SHOPIFY_ADMIN_CLIENT_SECRET: string;
  // DISCOGS_TOKEN: Personal Access Token for Discogs API.
  // Configured via `wrangler secret put DISCOGS_TOKEN` (separate command for staging).
  // Used by sync handlers in src/lib/sync.ts.
  DISCOGS_TOKEN: string;
  // BOOTSTRAP_AUTH_SECRET: Shared secret protecting the sync-bootstrap endpoint.
  // Configured via `wrangler secret put BOOTSTRAP_AUTH_SECRET`. Required header:
  //   Authorization: Bearer <secret>
  // The endpoint is admin-only and called manually via curl; no third-party use.
  BOOTSTRAP_AUTH_SECRET: string;
  // Spotify credentials for cover-art lookup. Previously hardcoded; moved to
  // wrangler secrets May 19 2026 (see `wrangler secret put SPOTIFY_CLIENT_ID/SECRET`).
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  // Shopify Storefront API token, used by customerIdFromToken() for wishlist auth.
  // Previously hardcoded; moved to wrangler secrets May 19 2026.
  STOREFRONT_TOKEN: string;
  // Anthropic API key for the Stories knowledge-line generator (?action=story-context).
  // Set via `wrangler secret put ANTHROPIC_API_KEY` (separately for staging).
  ANTHROPIC_API_KEY: string;
  // Customer Account API (NCA) confidential-client credentials, used by the
  // OAuth flow in src/lib/auth.ts (/auth/login, /auth/callback, /auth/logout).
  // CLIENT_ID is the UUID from Headless → Customer Account API settings;
  // CLIENT_SECRET appears only after switching the client type to Confidential.
  // Set via `wrangler secret put CAAPI_CLIENT_ID` / `CAAPI_CLIENT_SECRET`
  // (separately for staging). See Fase 1A (May 2026).
  CAAPI_CLIENT_ID: string;
  CAAPI_CLIENT_SECRET: string;
  // Resend API key for the newsletter double opt-in (?action=newsletter-subscribe
  // / newsletter-confirm) and Broadcasts. Sending-access key scoped to the account.
  // Set via `wrangler secret put RESEND_API_KEY` (separately for staging).
  RESEND_API_KEY: string;
}

const R2_PUBLIC = 'https://pub-7e5c9e2f45b3409383e7f23a2cb7028d.r2.dev';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const clean = (s: string) =>
  s.replace(/\(.*?\)/g, '').replace(/feat\.?.*/i, '').trim();

// ── SPOTIFY TOKEN HELPER ────────────────────────────────────────
// Client-credentials OAuth token, shared by the cover-art lookup and the
// Stories generator endpoints (spotify-artist, spotify-tracks). Tokens last
// ~1h; we don't cache across requests (Workers are stateless per invocation
// and a token fetch is cheap), but reusing this helper avoids duplicating the
// btoa/grant_type boilerplate. Returns '' on any failure so callers can fall
// through gracefully rather than throwing.
async function getSpotifyToken(env: Env): Promise<string> {
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      },
      body: 'grant_type=client_credentials',
    });
    const data = await res.json() as any;
    return data?.access_token || '';
  } catch {
    return '';
  }
}

function jsonRes(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── NEWSLETTER HELPERS (double opt-in via Resend) ───────────────
// The "from" the customer sees; Resend handles the technical Return-Path on
// send.houseonly.store under the hood.
const NEWSLETTER_FROM = 'House Only <newsletter@houseonly.store>';
const NEWSLETTER_SITE = 'https://houseonly.store';
const NL_PENDING_PREFIX = 'newsletter-pending:';
const NL_PENDING_TTL_S = 48 * 60 * 60; // 48h
// Resend Segment that the Broadcasts target. Confirmed subscribers are added
// here on double-opt-in confirmation (see newsletter-confirm). The Create
// Broadcast API requires a segmentId; "General" is the catch-all segment for
// all newsletter subscribers. This is an ID, not a credential, so it lives in
// code rather than a secret.
const NEWSLETTER_SEGMENT_ID = '2b12533a-d823-4b05-9804-5cd370d201c3';
const FORTHCOMING_TAG = 'forthcoming';
const GRADUATION_DONE_PREFIX = 'graduation-done:'; // mirrors lib/graduation.ts

function newNlToken(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

async function sendNewsletterConfirmation(env: Env, email: string, confirmUrl: string): Promise<boolean> {
  try {
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#080808;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:48px 28px;">
    <div style="font-weight:800;font-size:22px;letter-spacing:-0.5px;color:#ffffff;margin-bottom:4px;">HOUSE<span style="color:#c8ff00;">ONLY</span></div>
    <div style="color:#8a8a8a;font-size:12px;letter-spacing:1px;text-transform:uppercase;margin-bottom:36px;">Vinyl delivered worldwide</div>
    <h1 style="color:#ffffff;font-size:24px;font-weight:700;line-height:1.25;margin:0 0 16px;">Confirm your subscription</h1>
    <p style="color:#bdbdbd;font-size:15px;line-height:1.6;margin:0 0 28px;">Tap below to confirm and you're in. You'll get first access to pre-orders before they go public, plus the records we think actually matter \u2014 no noise.</p>
    <a href="${confirmUrl}" style="display:inline-block;background:#c8ff00;color:#080808;font-weight:700;font-size:15px;text-decoration:none;padding:14px 32px;border-radius:6px;">Confirm subscription</a>
    <p style="color:#6a6a6a;font-size:13px;line-height:1.6;margin:32px 0 0;">If you didn't sign up, just ignore this email \u2014 nothing happens without your confirmation. This link expires in 48 hours.</p>
  </div>
</body></html>`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: NEWSLETTER_FROM, to: email, subject: 'Confirm your House Only subscription', html }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function createResendContact(env: Env, email: string): Promise<boolean> {
  try {
    // The Create Contact API accepts a `segments` array, so we create the
    // contact AND add it to the newsletter segment ("General") in one call.
    // The segment is what the Broadcast API targets — a contact that isn't in
    // the segment would never receive a broadcast. (Per Resend docs: each
    // object in `segments` just needs the segment id.)
    const res = await fetch('https://api.resend.com/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        email,
        unsubscribed: false,
        segments: [{ id: NEWSLETTER_SEGMENT_ID }],
      }),
    });
    // 409 = contact already exists. In that case the create (and its segment
    // assignment) is a no-op, so we best-effort add the existing contact to the
    // segment by email to cover contacts created before this change.
    if (res.status === 409) {
      try {
        await fetch(
          `https://api.resend.com/contacts/${encodeURIComponent(email)}/segments/${NEWSLETTER_SEGMENT_ID}`,
          { method: 'POST', headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` } },
        );
      } catch { /* best-effort: contact already exists, segment add is bonus */ }
      return true;
    }
    return res.ok;
  } catch {
    return false;
  }
}

function newsletterResultPage(ok: boolean): Response {
  const title = ok ? "You're in." : 'Link expired';
  const msg = ok
    ? "You'll get first access to pre-orders and the records that matter. Welcome to House Only."
    : "This confirmation link has expired or already been used. Head back and sign up again \u2014 it only takes a second.";
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} \u2014 House Only</title>
<meta http-equiv="refresh" content="6;url=${NEWSLETTER_SITE}/">
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#080808;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}.card{max-width:440px;text-align:center;}.logo{font-weight:800;font-size:26px;letter-spacing:-0.5px;margin-bottom:28px;}.logo span{color:#c8ff00;}h1{font-size:30px;font-weight:700;margin-bottom:14px;letter-spacing:-0.5px;}p{color:#bdbdbd;font-size:15px;line-height:1.6;margin-bottom:28px;}a{display:inline-block;background:#c8ff00;color:#080808;font-weight:700;font-size:14px;text-decoration:none;padding:13px 30px;border-radius:6px;}.sub{color:#6a6a6a;font-size:12px;margin-top:24px;}</style></head>
<body><div class="card"><div class="logo">HOUSE<span>ONLY</span></div><h1>${title}</h1><p>${msg}</p><a href="${NEWSLETTER_SITE}/">Back to the shop</a><div class="sub">Redirecting you home\u2026</div></div></body></html>`;
  return new Response(html, { status: 200, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
}


// ── NEWSLETTER BROADCAST (build a draft in Resend) ──────────────
//
// Two-phase flow:
//   1. PREVIEW (GET ?action=newsletter-build-broadcast&preview=1&days=7)
//      Returns three numbered lists — PRE-ORDERS, NEW ARRIVALS, BACKORDERS —
//      so Eduardo can pick which records to feature with an editorial blurb.
//   2. BUILD (POST, body: { days, sections, featured:[productId], subject? })
//      Generates Sonnet blurbs for the (≤2) featured picks, assembles the HTML
//      (5 per section + a "see all" link for the rest), and creates a DRAFT
//      broadcast in Resend (send:false). Eduardo reviews/sends from the
//      Resend dashboard.
//
// Sectioning rule (Eduardo's spec):
//   PRE-ORDERS   = tag `forthcoming` AND created within the window.
//   NEW ARRIVALS = NOT forthcoming, created within the window, stock > 0.
//   BACKORDERS   = graduated within the window (KV `graduation-done:`),
//                  stock <= 0 / not available for sale (release passed but no
//                  stock arrived). Their CREATED_AT is old (created as a
//                  pre-order weeks ago), so they're fetched by id.
//
// Email shows up to 5 per section; everything else → "see all" link to the site.

const NL_MAX_FEATURED = 2;       // max records that get an editorial blurb

interface NLProduct {
  productId: string;   // gid://shopify/Product/...
  handle: string;
  title: string;       // full Shopify title
  vendor: string;      // artist (Shopify vendor)
  label: string;       // parsed from label: tag
  price: string;       // e.g. "12.99"
  currency: string;    // e.g. "EUR"
  imageUrl: string;    // Shopify featuredImage
  createdAt: string;   // ISO
  forthcoming: boolean;
  releaseDate: string; // parsed from release: tag, '' if none
  stock: number;       // quantityAvailable (Storefront) — frontend's +Cart/Request signal
  year: number;        // parsed from year tag, 0 if none (for backorder eligibility)
  descriptionHtml: string; // for richer blurb input
  tracks: string[];    // best-effort tracklist (parsed from description)
}

// Parse label / release out of the Shopify tag array (mirrors the frontend).
function nlLabelFromTags(tags: string[]): string {
  const t = tags.find((x) => x.toLowerCase().startsWith('label:'));
  return t ? t.slice(t.indexOf(':') + 1).trim() : '';
}
function nlReleaseFromTags(tags: string[]): string {
  const t = tags.find((x) => /^release:/i.test(x));
  if (!t) return '';
  const raw = t.slice(t.indexOf(':') + 1).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

// Strip HTML to plain text (for feeding the blurb model the description).
function nlStripHtml(html: string): string {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Best-effort tracklist extraction from a description. Many of our descriptions
// list tracks as "A1 ... / A2 ..." or line-separated. We just pull short lines
// that look like tracks; this is only an input hint for the blurb, never shown.
function nlTracksFromDescription(html: string): string[] {
  const text = nlStripHtml(html);
  // Split on common separators and keep plausibly-track-like fragments.
  const parts = text.split(/\s*\/\s*|\s{2,}|\u2022|\n/).map((s) => s.trim()).filter(Boolean);
  const tracks = parts.filter((p) => /^[A-D]?\d{1,2}[\.\)\:]?\s+\S/.test(p) || /^[A-D][1-9]\b/.test(p));
  return tracks.slice(0, 10);
}

// Parse year out of the tags (mirrors the frontend's `year:` / bare-4-digit tag).
function nlYearFromTags(tags: string[]): number {
  // Frontend stores year either as a bare 4-digit tag or `year:YYYY`.
  const yt = tags.find((x) => /^year:\d{4}$/i.test(x)) || tags.find((x) => /^\d{4}$/.test(x));
  if (!yt) return 0;
  const m = yt.match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : 0;
}

// Map a raw Storefront product node → NLProduct (best-effort; skips if no id).
// IMPORTANT: stock comes from the Storefront `quantityAvailable` field — the
// SAME source the storefront uses to decide +Cart vs Request. Admin API's
// inventoryQuantity is unreliable here because the store runs inventoryPolicy
// "continue" (oversell), so we read stock exactly like the frontend does.
function nlMapNode(node: any): NLProduct | null {
  if (!node?.id) return null;
  const tags: string[] = Array.isArray(node.tags) ? node.tags : [];
  const variant = node?.variants?.edges?.[0]?.node || null;
  const priceAmount = variant?.price?.amount ?? '';
  const currency = variant?.price?.currencyCode || 'EUR';
  // Match the frontend exactly: quantityAvailable ?? 10 (unknown → treat as
  // in stock). A real backorder reports 0 here.
  const qa = typeof variant?.quantityAvailable === 'number' ? variant.quantityAvailable : 10;
  const descriptionHtml = String(node?.descriptionHtml || '');
  const imageUrl = node?.images?.edges?.[0]?.node?.url || node?.featuredImage?.url || '';
  return {
    productId: node.id,
    handle: node.handle || '',
    title: node.title || '',
    vendor: node.vendor || '',
    label: nlLabelFromTags(tags),
    price: priceAmount ? String(priceAmount) : '',
    currency,
    imageUrl,
    createdAt: node.createdAt || '',
    forthcoming: tags.some((t) => t.toLowerCase() === FORTHCOMING_TAG),
    releaseDate: nlReleaseFromTags(tags),
    stock: qa,
    year: nlYearFromTags(tags),
    descriptionHtml,
    tracks: nlTracksFromDescription(descriptionHtml),
  };
}

// Storefront product fields (NOTE: Storefront API shape — handle, vendor,
// quantityAvailable, images — differs from Admin API).
const NL_PRODUCT_FIELDS = `
  id handle title vendor descriptionHtml tags createdAt
  images(first:1) { edges { node { url } } }
  variants(first:1) { edges { node { id sku quantityAvailable price { amount currencyCode } } } }
`;

// Storefront GraphQL call (same endpoint/token the wishlist + checkout use).
async function nlStorefront(env: Env, query: string): Promise<any> {
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/api/2024-04/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': env.STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) return null;
  return await r.json().catch(() => null);
}

// Fetch products created within the last `days` days (sorted newest first) via
// the Storefront API. We sortKey CREATED_AT desc and cut the window in code
// (the created_at: query filter can fail silently). We EXCLUDE forthcoming here
// and fetch pre-orders separately, mirroring the frontend's two-query split.
async function nlFetchRecentProducts(env: Env, days: number): Promise<NLProduct[]> {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const out: NLProduct[] = [];
  // Two passes: forthcoming=true (pre-orders) and forthcoming=false (catalogue).
  // Storefront filters forthcoming via tag: / -tag: exactly like the frontend.
  for (const fc of [true, false]) {
    let cursor: string | null = null;
    const PAGE = 50; // Storefront caps first at 250 but 50/page is safe + fast
    const MAX_PAGES = 12;
    for (let page = 0; page < MAX_PAGES; page++) {
      const after: string = cursor ? `, after: "${cursor}"` : '';
      const tagClause = fc ? `tag:'${FORTHCOMING_TAG}'` : `-tag:'${FORTHCOMING_TAG}'`;
      const query = `
        query {
          products(first: ${PAGE}, sortKey: CREATED_AT, reverse: true${after}, query: ${JSON.stringify(tagClause)}) {
            pageInfo { hasNextPage endCursor }
            edges { node { ${NL_PRODUCT_FIELDS} } }
          }
        }
      `;
      const data: any = await nlStorefront(env, query);
      const conn = data?.data?.products;
      if (!conn) break;
      let reachedOld = false;
      for (const edge of conn.edges || []) {
        const mapped = nlMapNode(edge?.node);
        if (!mapped) continue;
        const createdMs = mapped.createdAt ? Date.parse(mapped.createdAt) : NaN;
        if (!Number.isNaN(createdMs) && createdMs < cutoffMs) { reachedOld = true; break; }
        out.push(mapped);
      }
      if (reachedOld || !conn.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  }
  return out;
}

// Read graduation-done KV records → {productId, handle} graduated in the window.
// We need handles to fetch via Storefront (which keys by handle, not Admin GID).
async function nlRecentlyGraduated(env: Env, days: number): Promise<Array<{ productId: string; handle?: string }>> {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const out: Array<{ productId: string; handle?: string }> = [];
  let listCursor: string | undefined = undefined;
  for (let i = 0; i < 20; i++) {
    const listing: any = await env.SYNC_STATE.list({ prefix: GRADUATION_DONE_PREFIX, cursor: listCursor });
    for (const k of listing.keys || []) {
      const raw = await env.SYNC_STATE.get(k.name);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw);
        const gMs = rec?.graduated_at ? Date.parse(rec.graduated_at) : NaN;
        if (!Number.isNaN(gMs) && gMs >= cutoffMs && rec?.productId) {
          out.push({ productId: rec.productId, handle: rec.handle });
        }
      } catch { /* skip malformed */ }
    }
    if (listing.list_complete) break;
    listCursor = listing.cursor;
  }
  return out;
}

// Fetch specific products by handle via Storefront (for recently-graduated
// products whose CREATED_AT is old, so they're not in nlFetchRecentProducts).
// The graduation-done record may not store a handle; if missing we skip (the
// product will still surface if it falls in the recent window).
async function nlFetchProductsByHandles(env: Env, handles: string[]): Promise<NLProduct[]> {
  const out: NLProduct[] = [];
  for (const handle of handles) {
    if (!handle) continue;
    const query = `query { productByHandle(handle: ${JSON.stringify(handle)}) { ${NL_PRODUCT_FIELDS} } }`;
    try {
      const data: any = await nlStorefront(env, query);
      const mapped = nlMapNode(data?.data?.productByHandle);
      if (mapped) out.push(mapped);
    } catch { /* skip unfetchable */ }
  }
  return out;
}

// In stock = quantityAvailable > 0 (the frontend's +Cart rule). A backorder
// reports 0. (We do NOT use availableForSale — under oversell it's always true.)
function nlInStock(p: NLProduct): boolean {
  return p.stock > 0;
}

// Backorder-eligible = out of stock AND a recent release (year >= currentYear-1).
// Mirrors the storefront's isBackorderEligible: older sold-out records show
// "Out of stock" (not Request), so they don't belong in the backorder section.
function nlBackorderEligible(p: NLProduct): boolean {
  if (p.stock > 0) return false;
  if (!p.year) return false;
  return p.year >= new Date().getFullYear() - 1;
}

// Split products into the three newsletter sections, mirroring the storefront's
// own button logic (isForthcoming / stock>0 / isBackorderEligible):
//   preorders  = forthcoming tag (shows PRE-ORDER)
//   arrivals   = NOT forthcoming, stock > 0 (shows + Cart)
//   backorders = NOT forthcoming, stock <= 0, backorder-eligible (shows Request)
//   (NOT forthcoming, stock <= 0, NOT eligible = "Out of stock" → excluded)
// `graduated` are recently-graduated products that may sit outside the recent
// window; they're merged in and classified by the same rule.
function nlSectionize(
  recent: NLProduct[],
  graduated: NLProduct[],
): { preorders: NLProduct[]; arrivals: NLProduct[]; backorders: NLProduct[] } {
  const seen = new Set<string>();
  const preorders: NLProduct[] = [];
  const arrivals: NLProduct[] = [];
  const backorders: NLProduct[] = [];

  const classify = (p: NLProduct) => {
    if (seen.has(p.productId)) return;
    seen.add(p.productId);
    if (p.forthcoming) { preorders.push(p); return; }
    if (nlInStock(p)) { arrivals.push(p); return; }
    if (nlBackorderEligible(p)) { backorders.push(p); return; }
    // else: out of stock + not eligible → "Out of stock" on the site, skip.
  };

  for (const p of recent) classify(p);
  for (const g of graduated) classify(g);
  return { preorders, arrivals, backorders };
}

// ── Editorial blurb (NEWSLETTER voice — distinct from Stories) ──
// Key differences from the Stories prompt (which Eduardo finds monotonous):
//   - The angle menu is OPEN, not a closed list of 4. We explicitly forbid
//     defaulting to artist-bio / label-history / scene-era every time.
//   - We feed the model the tracklist + description so it can say something
//     specific to THIS record, not generalities.
//   - When generating the 2nd blurb we tell it which angle the 1st used, so the
//     two blurbs in one email never rhyme. Variation is enforced, not hoped for.

const NL_BLURB_SYS = [
  'You are the buyer at House Only, a specialist house music record store, writing the editorial note for ONE record in the weekly newsletter. It should read like a record-shop owner who actually listened — specific, confident, never like marketing copy or an online review.',
  '',
  'LENGTH: 1-2 sentences, 20-40 words. Develop ONE concrete idea well rather than several shallow ones.',
  '',
  'FIND THE MOST INTERESTING TRUE THING about THIS record and lead with it. The angle is wide open — it could be:',
  '- how the groove actually moves / what it does on a floor',
  '- a specific textural or production choice (the drums, a bassline, a sample, the mix)',
  '- the moment of the night or the kind of set it belongs in',
  '- a format or pressing detail that matters',
  '- a contrast: what you would expect from this name/label vs what this record actually does',
  '- an unexpected connection or lineage — ONLY if it is genuinely the most interesting thing',
  '',
  'DO NOT default to the safe trio of (artist biography) / (label history) / (scene-and-era). Those are the easy answers and they make every blurb sound the same. Reach past them unless one is unmistakably the real story here.',
  '',
  'HARD RULES:',
  '1. NEVER fabricate specifics — no invented dates, names, labels, collaborators, chart positions. If unsure of a fact, do not state it.',
  '2. If you do not know this exact record, write about what is concretely in front of you (the sound the title/tracklist/description imply, the format) rather than inventing biography.',
  '3. The supplied description is the label\'s own marketing copy — do NOT echo or paraphrase it. Find what it leaves out.',
  '4. BANNED hype register: "essential", "must-have", "timeless", "classic", "masterpiece", "fire", "heater", "stunning", "perfect for", "if you like X you\'ll love Y". Avoid the empty-praise voice entirely.',
  '',
  'Return ONLY the blurb text — no preamble, no quotes, no markdown.',
].join('\n');

// Label the angle a blurb took (rough heuristic) so the 2nd blurb can avoid it.
function nlBlurbInput(p: NLProduct): string {
  const desc = nlStripHtml(p.descriptionHtml).slice(0, 800);
  return [
    `Title: ${p.title || '(unknown)'}`,
    p.vendor ? `Artist: ${p.vendor}` : '',
    p.label ? `Label: ${p.label}` : '',
    p.tracks.length ? `Tracklist: ${p.tracks.join(', ')}` : '',
    desc ? `Label marketing copy (do NOT repeat, reference only): ${desc}` : '',
  ].filter(Boolean).join('\n');
}

// Generate one blurb. `avoid` is a short instruction about the previous blurb's
// angle so consecutive blurbs in one email don't rhyme. Returns '' on failure.
async function nlGenerateBlurb(env: Env, p: NLProduct, avoid: string): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) return '';
  const userMsg = avoid
    ? `${nlBlurbInput(p)}\n\nThe previous record's note already used this angle: "${avoid}". Take a DIFFERENT angle for this one.`
    : nlBlurbInput(p);
  try {
    const backoffs = [0, 600, 1500, 3000];
    let aiRes: Response | null = null;
    for (let attempt = 0; attempt < backoffs.length; attempt++) {
      if (backoffs[attempt]) await new Promise((r) => setTimeout(r, backoffs[attempt]));
      aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 220,
          system: NL_BLURB_SYS,
          messages: [{ role: 'user', content: userMsg }],
        }),
      });
      if (aiRes.status !== 529 && aiRes.status !== 429) break;
    }
    if (!aiRes || !aiRes.ok) return '';
    const aiData = await aiRes.json() as any;
    const text = (aiData?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
    return text.replace(/^["']|["']$/g, '').trim();
  } catch {
    return '';
  }
}

// Escape user/product text for safe HTML embedding.
function nlEsc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function nlProductUrl(p: NLProduct): string {
  return p.handle ? `${NEWSLETTER_SITE}/products/${p.handle}` : NEWSLETTER_SITE;
}

function nlPriceLabel(p: NLProduct): string {
  if (!p.price) return '';
  const sym = p.currency === 'EUR' ? '\u20ac' : (p.currency ? p.currency + ' ' : '');
  return `${sym}${p.price}`;
}

// A featured card (with editorial blurb).
function nlFeaturedCard(p: NLProduct, blurb: string, ctaLabel: string): string {
  const url = nlProductUrl(p);
  const price = nlPriceLabel(p);
  const img = p.imageUrl
    ? `<img src="${nlEsc(p.imageUrl)}" alt="${nlEsc(p.title)}" width="540" style="display:block;width:100%;max-width:540px;height:auto;border-radius:8px;">`
    : '';
  const blurbHtml = blurb
    ? `<p style="color:#bdbdbd;font-size:14px;line-height:1.6;margin:14px 0 0;">${nlEsc(blurb)}</p>`
    : '';
  const labelLine = p.label ? `<div style="color:#8a8a8a;font-size:12px;letter-spacing:0.5px;text-transform:uppercase;margin:14px 0 2px;">${nlEsc(p.label)}</div>` : '';
  return `
  <a href="${url}" style="text-decoration:none;color:inherit;display:block;">${img}</a>
  ${labelLine}
  <div style="color:#ffffff;font-size:18px;font-weight:700;line-height:1.3;margin:6px 0 0;">${nlEsc(p.title)}</div>
  ${blurbHtml}
  <a href="${url}" style="display:inline-block;background:#c8ff00;color:#080808;font-weight:700;font-size:13px;text-decoration:none;padding:10px 22px;border-radius:6px;margin-top:16px;">${nlEsc(ctaLabel)}${price ? ' \u2014 ' + price : ''}</a>`;
}

// A compact row (no blurb): small cover + title + price.
function nlCompactRow(p: NLProduct): string {
  const url = nlProductUrl(p);
  const price = nlPriceLabel(p);
  const img = p.imageUrl
    ? `<img src="${nlEsc(p.imageUrl)}" alt="${nlEsc(p.title)}" width="64" height="64" style="display:block;width:64px;height:64px;border-radius:5px;object-fit:cover;">`
    : `<div style="width:64px;height:64px;border-radius:5px;background:#1a1a1a;"></div>`;
  return `
  <a href="${url}" style="text-decoration:none;color:inherit;display:block;padding:10px 0;border-top:1px solid #1e1e1e;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td width="64" valign="middle">${img}</td>
      <td valign="middle" style="padding-left:14px;">
        ${p.label ? `<div style="color:#7a7a7a;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;">${nlEsc(p.label)}</div>` : ''}
        <div style="color:#efefef;font-size:14px;font-weight:600;line-height:1.35;">${nlEsc(p.title)}</div>
      </td>
      <td valign="middle" align="right" style="white-space:nowrap;color:#c8ff00;font-size:14px;font-weight:700;padding-left:10px;">${price}</td>
    </tr></table>
  </a>`;
}

function nlSectionHeader(label: string, sub: string): string {
  return `
  <div style="margin:40px 0 18px;">
    <div style="color:#c8ff00;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">${nlEsc(label)}</div>
    <div style="color:#7a7a7a;font-size:13px;margin-top:3px;">${nlEsc(sub)}</div>
  </div>`;
}

function nlSeeAll(label: string, url: string, extraCount: number): string {
  if (extraCount <= 0) return '';
  return `
  <a href="${url}" style="display:inline-block;color:#c8ff00;font-size:13px;font-weight:600;text-decoration:none;margin-top:14px;">${nlEsc(label)} (+${extraCount}) \u2192</a>`;
}

// One section: featured cards (with blurb) at the top, then compact rows.
// Holds exactly the records the user selected — no cap, no "see all".
interface NLSectionRender {
  header: string;
  sub: string;
  cta: string;          // CTA label on featured cards ("Pre-order" / "Shop" / "Request")
  seeAllLabel: string;  // unused (kept for struct stability); pass ''
  seeAllUrl: string;    // unused; pass ''
  featured: Array<{ p: NLProduct; blurb: string }>;
  rows: NLProduct[];    // the chosen records that don't get a blurb
  extraCount: number;   // unused; pass 0
}
function nlRenderSection(s: NLSectionRender): string {
  if (!s.featured.length && !s.rows.length) return '';
  const parts: string[] = [nlSectionHeader(s.header, s.sub)];
  for (const f of s.featured) parts.push(`<div style="margin-bottom:34px;">${nlFeaturedCard(f.p, f.blurb, s.cta)}</div>`);
  if (s.rows.length) parts.push(s.rows.map(nlCompactRow).join(''));
  parts.push(nlSeeAll(s.seeAllLabel, s.seeAllUrl, s.extraCount));
  return parts.join('\n');
}

function nlBuildBroadcastHtml(sections: string[]): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#080808;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;">
    <div style="font-weight:800;font-size:22px;letter-spacing:-0.5px;color:#ffffff;">HOUSE<span style="color:#c8ff00;">ONLY</span></div>
    <div style="color:#8a8a8a;font-size:12px;letter-spacing:1px;text-transform:uppercase;margin-top:4px;">Vinyl delivered worldwide</div>
    ${sections.filter(Boolean).join('\n')}
    <div style="margin-top:48px;padding-top:24px;border-top:1px solid #1e1e1e;color:#6a6a6a;font-size:12px;line-height:1.6;">
      You're getting this because you signed up at houseonly.store.
      <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#8a8a8a;">Unsubscribe</a>.
    </div>
  </div>
</body></html>`;
}

// Create the DRAFT broadcast in Resend (send:false). Returns the broadcast id.
async function nlCreateBroadcastDraft(env: Env, subject: string, html: string): Promise<{ id?: string; error?: string }> {
  try {
    const res = await fetch('https://api.resend.com/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        // REST API uses snake_case (the SDKs translate camelCase → this on the
        // wire). Sending `segmentId` is silently ignored → "missing required
        // field". Verified against Resend's API reference / Go SDK json tags.
        segment_id: NEWSLETTER_SEGMENT_ID,
        from: NEWSLETTER_FROM,
        subject,
        html,
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) return { error: `resend ${res.status}: ${JSON.stringify(body).slice(0, 200)}` };
    return { id: body?.id };
  } catch (e: any) {
    return { error: e?.message || 'broadcast create failed' };
  }
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

async function customerIdFromToken(env: Env, token: string): Promise<string | null> {
  if (!token) return null;
  try {
    const r = await fetch(`https://${SHOPIFY_DOMAIN}/api/2024-04/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': env.STOREFRONT_TOKEN,
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

// ── UNIFIED IDENTITY RESOLVER (Fase 1B — coexistence) ──────────────────────
//
// The wishlist (and, later, every account-hub feature) calls THIS instead of
// customerIdFromToken directly. During the migration both auth systems work:
//
//   1. NEW (CAAPI): the frontend sends an opaque `session` id. We resolve it
//      via customerIdFromSession() — which also transparently refreshes the
//      CAAPI access token from KV when needed.
//   2. OLD (legacy Storefront): the frontend sends a Storefront `token`. We
//      resolve it via the legacy customerIdFromToken().
//
// Both paths return the SAME numeric Shopify customer id, so they map to the
// SAME wl:{customerId} record. This is what guarantees the wishlist never
// breaks across the migration — no data move, no dual storage, just two ways
// to learn the same id. Once the frontend is fully on CAAPI (Fase 2) and we've
// confirmed it, the legacy branch (and customerIdFromToken) can be removed
// (Fase 3).
//
// Inputs are read from whatever the caller has: a `session` id and/or a legacy
// `token`. Session is preferred when both are present.
async function resolveCustomerId(
  env: Env,
  opts: { session?: string | null; token?: string | null },
): Promise<string | null> {
  const session = (opts.session || '').trim();
  if (session) {
    const cid = await customerIdFromSession(env, session);
    if (cid) return cid;
    // Session present but invalid/expired → fall through to legacy token if any
    // (lets a stale CAAPI session degrade gracefully rather than hard-fail).
  }
  const token = (opts.token || '').trim();
  if (token) {
    const cid = await customerIdFromToken(env, token);
    if (cid) return cid;
  }
  return null;
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

// ── SHOPIFY ADMIN API ──────────────────────────────────────────────
//
// Token management and GraphQL helper moved to ./lib/shopify-admin.ts in
// Fase 3B (May 2026) so they can be reused by the new sync flows without
// duplicating code. Behaviour identical to before; only the location
// changed.
//
// The module exports:
//   - getShopifyAdminToken(env, force?) — cached OAuth token retrieval
//   - shopifyAdminGraphQL(env, query, variables?) — wrapper with 401 retry
//   - findVariantBySku(env, sku) — used by Fase 3 sync (new)
//   - getPrimaryLocationId(env) — used by Fase 3 sync (new)
//   - adjustInventory(env, adjustments, idempotencyKey, ...) — used by Fase 3E (new)
//
// See src/lib/shopify-admin.ts for full docs.

import { shopifyAdminGraphQL, getShopifyAdminToken } from './lib/shopify-admin';
import {
  handleSyncBootstrap,
  handleSyncStatus,
  handleRegisterWebhook,
  handleShopifyOrderWebhook,
  handleSyncMode,
  handleProductCreateWebhook,
  handleAutoListMode,
  handlePendingReviewList,
  handlePendingReviewApprove,
  handlePendingReviewReject,
  pollDiscogsForSales,
} from './lib/sync';

import { searchRelease } from './lib/discogs';

import { runGraduation, getGraduationMode, setGraduationMode } from './lib/graduation';

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  customerIdFromAccessToken,
  createSession,
  deleteSession,
  buildLogoutUrl,
  consumeAuthState,
  customerIdFromSession,
  caapiQueryBySession,
  accessTokenFromSession,
} from './lib/auth';



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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    // ── CUSTOMER ACCOUNT API AUTH (NCA, confidential) ──────────────
    //
    // Path-based routes (NOT ?action=) because the Callback URIs registered in
    // the Shopify Customer Account API settings point at `/auth/callback`.
    //
    // Flow (Fase 1A):
    //   GET /auth/login           → redirect the browser to Shopify's hosted
    //                               login (passwordless). ?return_to=<path>
    //                               remembers where to send the user after.
    //   GET /auth/callback        → Shopify redirects here with ?code&state.
    //                               We verify state, exchange the code for tokens
    //                               (server-to-server), resolve the numeric
    //                               customerId, mint an opaque session, and
    //                               redirect to the site with the session id in
    //                               the URL fragment for the frontend to store.
    //   GET /auth/logout          → end the Shopify session + delete our session.
    //
    // The Worker's own callback URL is derived from request.url so prod and
    // staging each use their own registered callback automatically. The site we
    // bounce the user back to is derived from the Worker hostname (the
    // "-staging" worker → staging site; otherwise → production site).
    if (url.pathname === '/auth/login' || url.pathname === '/auth/callback' || url.pathname === '/auth/logout') {
      const workerOrigin = url.origin; // e.g. https://houseonly-worker.emontagut.workers.dev
      const isStaging = url.hostname.includes('-staging');
      const siteOrigin = isStaging ? 'https://staging.houseonly.pages.dev' : 'https://houseonly.store';
      const callbackUri = `${workerOrigin}/auth/callback`;

      // Only allow returning to a same-site path (defense against open redirect).
      const safeReturnTo = (raw: string | null): string => {
        if (!raw) return '/';
        // Accept only root-relative paths beginning with a single slash.
        if (/^\/(?!\/)/.test(raw)) return raw;
        return '/';
      };

      // ── /auth/login ──
      if (url.pathname === '/auth/login' && request.method === 'GET') {
        const returnTo = safeReturnTo(url.searchParams.get('return_to'));
        const loginHint = url.searchParams.get('login_hint') || undefined;
        try {
          const authorizeUrl = await buildAuthorizeUrl(env, callbackUri, returnTo, loginHint);
          return Response.redirect(authorizeUrl, 302);
        } catch (e: any) {
          return jsonRes({ error: 'login_init_failed', detail: e?.message || String(e) }, 500);
        }
      }

      // ── /auth/callback ──
      if (url.pathname === '/auth/callback' && request.method === 'GET') {
        const code = url.searchParams.get('code') || '';
        const state = url.searchParams.get('state') || '';
        const oauthError = url.searchParams.get('error');

        // Shopify can redirect back with an error (e.g. login_required when
        // prompt=none, or user cancelled). Bounce to the site cleanly.
        if (oauthError) {
          return Response.redirect(`${siteOrigin}/?auth_error=${encodeURIComponent(oauthError)}`, 302);
        }
        if (!code || !state) {
          return Response.redirect(`${siteOrigin}/?auth_error=missing_code_or_state`, 302);
        }

        // Verify + consume the state (CSRF) and recover the return-to path.
        const returnTo = await consumeAuthState(env, state);
        if (returnTo === null) {
          return Response.redirect(`${siteOrigin}/?auth_error=bad_state`, 302);
        }

        try {
          const tokens = await exchangeCodeForTokens(env, code, callbackUri);
          const customerId = await customerIdFromAccessToken(tokens.access_token);
          if (!customerId) {
            return Response.redirect(`${siteOrigin}/?auth_error=no_customer`, 302);
          }
          const sessionId = await createSession(env, {
            customerId,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            idToken: tokens.id_token,
            expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
          });
          // Hand the opaque session id to the frontend via the URL fragment
          // (fragments are not sent to servers nor stored in logs). The
          // frontend reads it, saves it to localStorage, and strips it.
          const dest = `${siteOrigin}${returnTo}#session=${encodeURIComponent(sessionId)}`;
          return Response.redirect(dest, 302);
        } catch (e: any) {
          return Response.redirect(
            `${siteOrigin}/?auth_error=${encodeURIComponent('exchange_failed')}`,
            302,
          );
        }
      }

      // ── /auth/logout ──
      // Accepts the session id as ?session=. Deletes our session, then redirects
      // to Shopify's end-session endpoint (which clears the Shopify-side session)
      // with the id_token_hint, finally landing back on the site.
      if (url.pathname === '/auth/logout' && request.method === 'GET') {
        const sessionId = url.searchParams.get('session') || '';
        const returnTo = safeReturnTo(url.searchParams.get('return_to'));
        const postLogout = `${siteOrigin}${returnTo}`;
        try {
          const removed = await deleteSession(env, sessionId);
          const logoutUrl = await buildLogoutUrl(env, removed?.idToken, postLogout);
          return Response.redirect(logoutUrl, 302);
        } catch {
          // Even if the Shopify logout URL build fails, our session is gone;
          // just send the user home.
          return Response.redirect(postLogout, 302);
        }
      }

      return jsonRes({ error: 'method not allowed' }, 405);
    }

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

    // ── SYNC BOOTSTRAP ──────────────────────────────────────
    // POST ?action=sync-bootstrap
    // Header: Authorization: Bearer <BOOTSTRAP_AUTH_SECRET>
    //
    // One-shot endpoint: paginate the Discogs inventory and populate
    // SYNC_STATE KV with sku↔listing_id mappings. Idempotent.
    //
    // Admin-only — called manually by Eduardo via curl after configuring
    // wrangler secrets DISCOGS_TOKEN and BOOTSTRAP_AUTH_SECRET.
    if (action === 'sync-bootstrap' && request.method === 'POST') {
      return await handleSyncBootstrap(request, env);
    }

    // ── SYNC STATUS ─────────────────────────────────────────
    // GET ?action=sync-status
    //
    // Read-only summary: when bootstrap last ran, stats from that run,
    // last polled timestamp (when Fase 3E ships). No auth required —
    // data is non-sensitive (stats only, no SKUs).
    if (action === 'sync-status' && request.method === 'GET') {
      return await handleSyncStatus(request, env);
    }

    // ── SYNC MODE (Fase 3E dry/live switch) ─────────────────
    // GET  ?action=sync-mode  → returns {"mode":"dry"|"live"} (no auth)
    // POST ?action=sync-mode  → set mode (auth: Bearer)
    //   body: {"mode":"dry"} or {"mode":"live"}
    //
    // The scheduled handler reads this flag every run. Switching modes
    // takes effect on the next cron invocation (within 15 min).
    if (action === 'sync-mode') {
      return await handleSyncMode(request, env);
    }

    // ── SYNC REGISTER WEBHOOK ───────────────────────────────
    // POST ?action=sync-register-webhook
    // Header: Authorization: Bearer <BOOTSTRAP_AUTH_SECRET>
    // Body:   { worker_url: "https://houseonly-worker[-staging].emontagut.workers.dev" }
    //
    // One-shot: registers the Shopify orders/create webhook pointing at
    // this Worker. Idempotent — if the same webhook is already registered,
    // returns 200 with already_registered=true.
    if (action === 'sync-register-webhook' && request.method === 'POST') {
      return await handleRegisterWebhook(request, env);
    }

    // ── WEBHOOK: SHOPIFY ORDERS/CREATE ──────────────────────
    // POST ?action=webhook-shopify-order
    // Headers: X-Shopify-Hmac-SHA256, X-Shopify-Topic, etc.
    //
    // Receives Shopify orders/create webhook. Validates HMAC, then for
    // each line item with a SKU mapped in KV, marks the corresponding
    // Discogs listing as Draft. Discogs calls run in the background
    // (ctx.waitUntil) so we respond <5s as Shopify requires.
    if (action === 'webhook-shopify-order' && request.method === 'POST') {
      return await handleShopifyOrderWebhook(request, env, ctx);
    }

    // ── FASE 3.5B: MATCHER TEST (read-only, no side effects) ─
    // GET ?action=discogs-match-test&barcode=...&catno=...&label=...&artist=...&title=...
    // Auth: Bearer BOOTSTRAP_AUTH_SECRET
    //
    // Runs the real-time Discogs matcher (searchRelease) against the given
    // identifiers and returns the confidence tier + candidates WITHOUT
    // creating any listing. Used to validate matching quality before wiring
    // it to the products/create webhook auto-list flow.
    if (action === 'discogs-match-test' && request.method === 'GET') {
      const auth = request.headers.get('authorization') || '';
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (!m || m[1] !== env.BOOTSTRAP_AUTH_SECRET) {
        return jsonRes({ error: 'unauthorized' }, 401);
      }
      if (!env.DISCOGS_TOKEN) {
        return jsonRes({ error: 'DISCOGS_TOKEN not configured' }, 500);
      }
      const result = await searchRelease(env.DISCOGS_TOKEN, {
        barcode: url.searchParams.get('barcode') || undefined,
        catno:   url.searchParams.get('catno')   || undefined,
        label:   url.searchParams.get('label')   || undefined,
        artist:  url.searchParams.get('artist')  || undefined,
        title:   url.searchParams.get('title')   || undefined,
      });
      return jsonRes(result);
    }

    // ── GRADUATION SCOPE TEST (read-only, verifies write_products) ──
    // GET ?action=graduation-scope-test
    // Auth: Bearer BOOTSTRAP_AUTH_SECRET
    //
    // Force-refreshes the Admin token (to pick up scopes granted AFTER the
    // last cached token was issued), then reads the live granted access
    // scopes via currentAppInstallation. Pure read — no mutation. Used once
    // to confirm `write_products` is on the token before building the
    // forthcoming-graduation logic that calls tagsRemove.
    if (action === 'graduation-scope-test' && request.method === 'GET') {
      const auth = request.headers.get('authorization') || '';
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (!m || m[1] !== env.BOOTSTRAP_AUTH_SECRET) {
        return jsonRes({ error: 'unauthorized' }, 401);
      }
      // Force a fresh token so we reflect the post-grant scope set, not a
      // stale cached token issued before write_products was granted.
      await getShopifyAdminToken(env, true);
      const data = await shopifyAdminGraphQL(
        env,
        `query { currentAppInstallation { accessScopes { handle } } }`,
      );
      const scopes = (data?.data?.currentAppInstallation?.accessScopes || [])
        .map((s: any) => s.handle)
        .sort();
      return jsonRes({
        scopes,
        has_write_products: scopes.includes('write_products'),
      });
    }

    // ── GRADUATION MODE (view / set dry|live) ───────────────
    // GET  ?action=graduation-mode → { mode: "dry"|"live" } (no auth — read only)
    // POST ?action=graduation-mode → set mode. Auth: Bearer BOOTSTRAP_AUTH_SECRET
    //   Body: { mode: "dry" | "live" }
    //
    // 'dry' (default) logs intended graduations to KV without writing to
    // Shopify. 'live' actually removes the `forthcoming` tag from overdue
    // pre-orders. Switching takes effect on the next cron run (≤15 min) or
    // immediately via ?action=graduation-run.
    if (action === 'graduation-mode') {
      if (request.method === 'GET') {
        const mode = await getGraduationMode(env);
        return jsonRes({ mode });
      }
      if (request.method === 'POST') {
        const auth = request.headers.get('authorization') || '';
        const m = auth.match(/^Bearer\s+(.+)$/i);
        if (!m || m[1] !== env.BOOTSTRAP_AUTH_SECRET) {
          return jsonRes({ error: 'unauthorized' }, 401);
        }
        let body: any = {};
        try { body = await request.json(); } catch { /* empty body */ }
        const mode = await setGraduationMode(env, String(body?.mode || ''));
        return jsonRes({ mode });
      }
      return jsonRes({ error: 'method not allowed' }, 405);
    }

    // ── GRADUATION RUN (manual trigger) ─────────────────────
    // POST ?action=graduation-run → run the graduation scan now.
    // Auth: Bearer BOOTSTRAP_AUTH_SECRET
    //   Optional body: { mode: "dry" | "live" } to override KV mode for this
    //   run only (does NOT change the stored mode). Useful for testing.
    //
    // Returns the full GraduationResult (scanned / overdue / graduated /
    // skipped_no_date / errors / details). Use this to verify the scan picks
    // the right products before relying on the cron.
    if (action === 'graduation-run' && request.method === 'POST') {
      const auth = request.headers.get('authorization') || '';
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (!m || m[1] !== env.BOOTSTRAP_AUTH_SECRET) {
        return jsonRes({ error: 'unauthorized' }, 401);
      }
      let body: any = {};
      try { body = await request.json(); } catch { /* empty body */ }
      const override = body?.mode === 'live' ? 'live' : body?.mode === 'dry' ? 'dry' : undefined;
      const result = await runGraduation(env, override);
      return jsonRes(result);
    }

    // ── GRADUATION STATUS (last run summary) ────────────────
    // GET ?action=graduation-status → last run summary + current mode.
    // Auth: Bearer BOOTSTRAP_AUTH_SECRET
    if (action === 'graduation-status' && request.method === 'GET') {
      const auth = request.headers.get('authorization') || '';
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (!m || m[1] !== env.BOOTSTRAP_AUTH_SECRET) {
        return jsonRes({ error: 'unauthorized' }, 401);
      }
      const mode = await getGraduationMode(env);
      const lastRaw = await env.SYNC_STATE.get('meta:graduation_last_run');
      let last_run: any = null;
      if (lastRaw) { try { last_run = JSON.parse(lastRaw); } catch { /* ignore */ } }
      return jsonRes({ mode, last_run });
    }

    // ── DBH ZIP PROXY ───────────────────────────────────────
    // GET ?action=dbh-zip&id=16224
    //
    // DBH release asset ZIPs (dbh-music.com/shop/release_zip/{id}) are public
    // (confirmed: download in a logged-out incognito window) but the browser
    // cannot fetch() them cross-origin — DBH sends no CORS headers, so a direct
    // client-side fetch is blocked and the importer can't await completion.
    // This proxy fetches the ZIP server-side (no CORS in Worker-land) and
    // streams it back from our own origin with CORS, so the pre-order importer
    // can fetch → await blob → save → next, downloading strictly one at a time.
    //
    // Locked to DBH release_zip only: id must be all-digits, prefix hardcoded.
    // Not an open proxy. No auth needed (public asset); no Shopify/Discogs touch.
    if (action === 'dbh-zip' && request.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      if (!/^\d+$/.test(id)) {
        return jsonRes({ ok: false, error: 'id must be numeric' }, 400);
      }
      try {
        const upstream = await fetch(`https://dbh-music.com/shop/release_zip/${id}`, {
          redirect: 'follow',
          // Use a normal browser User-Agent. DBH's nginx appears to reject/redirect
          // unknown agents (a custom UA returned no file; a default curl-style UA
          // returns the ZIP). Send browser-like headers so DBH serves the asset.
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept': '*/*',
          },
        });
        const ct = (upstream.headers.get('content-type') || '').toLowerCase();
        const cd = (upstream.headers.get('content-disposition') || '').toLowerCase();
        // Treat as a real file if DBH returns a zip-ish content-type OR an
        // attachment disposition. DBH serves "application/x-zip" (non-standard)
        // with `content-disposition: attachment; filename=...zip`, so accept
        // both the x-zip variant and the attachment header. Anything else
        // (html login page, error) is "no asset yet".
        const looksLikeZip =
          ct.includes('zip') || ct.includes('octet-stream') || cd.includes('attachment');
        if (!upstream.ok || !upstream.body || !looksLikeZip) {
          return jsonRes({
            ok: false, missing: true,
            status: upstream.status, contentType: ct,
          }, 200);
        }
        // Stream the ZIP straight back with CORS so the browser can read+await it.
        return new Response(upstream.body, {
          status: 200,
          headers: {
            ...CORS,
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="dbh_${id}.zip"`,
          },
        });
      } catch (e: any) {
        return jsonRes({ ok: false, error: e.message }, 502);
      }
    }

    // ── FASE 3.5B: PRODUCTS/CREATE WEBHOOK ──────────────────
    // POST ?action=webhook-shopify-product
    // Headers: X-Shopify-Hmac-SHA256, X-Shopify-Topic: products/create
    //
    // Fires when a new product is created in Shopify. For source:dbh
    // products, runs the Discogs matcher and (in live mode) auto-lists
    // HIGH/barcode matches as Draft on Discogs. Everything else goes to
    // the pending-review queue. Gated by meta:sync_35_mode (default dry).
    if (action === 'webhook-shopify-product' && request.method === 'POST') {
      return await handleProductCreateWebhook(request, env, ctx);
    }

    // ── FASE 3.5B: AUTO-LIST MODE (dry/live) ────────────────
    // GET  ?action=sync35-mode → current mode
    // POST ?action=sync35-mode → set mode (Bearer BOOTSTRAP_AUTH_SECRET)
    if (action === 'sync35-mode') {
      return await handleAutoListMode(request, env);
    }

    // ── FASE 3.5C: REVIEW DASHBOARD ─────────────────────────
    // GET  ?action=pending-review-list     → all pending records
    // POST ?action=pending-review-approve  → {sku, release_id} create listing
    // POST ?action=pending-review-reject   → {sku} discard
    // All Bearer BOOTSTRAP_AUTH_SECRET.
    if (action === 'pending-review-list') {
      return await handlePendingReviewList(request, env);
    }
    if (action === 'pending-review-approve') {
      return await handlePendingReviewApprove(request, env);
    }
    if (action === 'pending-review-reject') {
      return await handlePendingReviewReject(request, env);
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

    // ── STORY CONTEXT (Stories knowledge line) ──────────────
    // POST ?action=story-context
    // body: { artist, title, label, catalog, genre, year, description, tracks:[names] }
    //
    // Generates 3 short lines of GENUINE musical context for Shot 2 of an
    // Instagram Story — the "House Only knows its stuff" line. Anti-bluff:
    // no marketing language, no fabricated specifics. If the model doesn't
    // know an artist, it writes about the sound/scene/era instead of inventing
    // biography. The human (Eduardo) picks/edits before publishing — this is a
    // draft aid, not an unreviewed source of truth.
    if (action === 'story-context' && request.method === 'POST') {
      if (!env.ANTHROPIC_API_KEY) return jsonRes({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
      let body: any = {};
      try { body = await request.json(); } catch { return jsonRes({ error: 'invalid json' }, 400); }
      const artist = String(body?.artist || '').trim();
      const title  = String(body?.title || '').trim();
      const label  = String(body?.label || '').trim();
      const catalog= String(body?.catalog || '').trim();
      const genre  = String(body?.genre || '').trim();
      const year   = String(body?.year || '').trim();
      const desc   = String(body?.description || '').trim().slice(0, 1200);
      const tracks = Array.isArray(body?.tracks) ? body.tracks.slice(0, 12).join(', ') : '';
      if (!artist && !title) return jsonRes({ error: 'missing artist/title' }, 400);

      const sys = [
        'You are the buyer at House Only, a specialist house music record store. You write the context line for an Instagram Story — the line that shows the shop genuinely KNOWS this music, the way a respected record-shop owner talks to a regular who trusts their taste.',
        '',
        'WHAT YOU WRITE:',
        '2-3 sentences, 30-50 words total. Develop ONE concrete point of context — do not list several shallow ones. Confident, knowledgeable, specific. The reader should finish it thinking "these people actually know their stuff."',
        '',
        'HARD RULES:',
        '1. NEVER fabricate specifics. No invented labels, dates, cities, real names, or collaborators. If you are not sure of a fact, do not state it as fact.',
        '2. If you do not know this exact artist, write with authority about the SOUND, the SCENE, the LABEL catalog, or the ERA instead — never invent biography.',
        '3. BANNED — the generic record-review / online-comment register. Never use: "essential", "must-have", "a must for fans of", "timeless", "classic", "masterpiece", "highly recommended", "fire", "heater", "stunning", "beautiful", "perfect for", "if you like X you will love Y". These empty phrases are exactly what makes text sound like an internet comment. Avoid them and the vibe behind them.',
        '4. The supplied description is the LABEL own marketing copy. Do NOT echo or paraphrase it. Find the real context it leaves out.',
        '5. Give the angle a knowledgeable shop owner would — something a buyer would NOT already find in the label blurb: artist lineage and where they sit in the scene, the label/series and what it stands for, the production approach, or the historical/regional moment the record comes from.',
        '',
        'GOOD vs GENERIC (match the GOOD voice):',
        'GENERIC (never): "A beautiful deep house record with soulful vibes — essential for any collection."',
        'GOOD: "Rawax Motor City Edition exists to document Detroit functional, stripped-back lineage — these are tools for DJs, not showpieces, and this sits squarely in that tradition of restraint over flash."',
        'GENERIC (never): "Louie Vega delivers another timeless house anthem with this stunning release."',
        'GOOD: "Vega built Nervous into one of New York house defining catalogs across three decades; his remix work here is less about reinvention than about carrying that NYC dancefloor sensibility into the room."',
        '',
        'Write 3 DIFFERENT options, each taking a different real angle (e.g. one on the artist, one on the label, one on the scene/era). Return ONLY a JSON array of exactly 3 strings — no preamble, no markdown.',
        '["option one", "option two", "option three"]',
      ].join('\n');

      const userMsg = [
        `Artist: ${artist || '(unknown)'}`,
        `Title: ${title || '(unknown)'}`,
        label ? `Label: ${label}` : '',
        catalog ? `Catalog: ${catalog}` : '',
        genre ? `Genre: ${genre}` : '',
        year ? `Year: ${year}` : '',
        tracks ? `Tracklist: ${tracks}` : '',
        desc ? `Label marketing copy (do NOT repeat, for reference only): ${desc}` : '',
      ].filter(Boolean).join('\n');

      try {
        // Retry on transient overload (529) / rate-limit (429). Anthropic
        // returns 529 when momentarily saturated; these are NOT billed (the
        // request isn't processed). A short backoff almost always clears it.
        // Up to 4 attempts at 0ms, 600ms, 1500ms, 3000ms.
        const backoffs = [0, 600, 1500, 3000];
        let aiRes: Response | null = null;
        let lastStatus = 0;
        for (let attempt = 0; attempt < backoffs.length; attempt++) {
          if (backoffs[attempt]) await new Promise((r) => setTimeout(r, backoffs[attempt]));
          aiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 700,
              system: sys,
              messages: [{ role: 'user', content: userMsg }],
            }),
          });
          lastStatus = aiRes.status;
          // Retry only on transient statuses; otherwise stop and handle below.
          if (aiRes.status !== 529 && aiRes.status !== 429) break;
        }
        if (!aiRes || !aiRes.ok) {
          const errText = aiRes ? await aiRes.text().catch(() => '') : '';
          const overloaded = lastStatus === 529 || lastStatus === 429;
          return jsonRes({
            error: `anthropic ${lastStatus}`,
            detail: errText.slice(0, 300),
            retryable: overloaded,
            hint: overloaded ? 'Anthropic busy after retries — press Regenerate' : undefined,
          }, 502);
        }
        const aiData = await aiRes.json() as any;
        const text = (aiData?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
        // Parse the JSON array; strip code fences defensively.
        const clean = text.replace(/```json|```/g, '').trim();
        let options: string[] = [];
        try {
          const parsed = JSON.parse(clean);
          if (Array.isArray(parsed)) options = parsed.filter((x) => typeof x === 'string').slice(0, 3);
        } catch {
          // Fallback: split lines if the model didn't return clean JSON.
          options = clean.split('\n').map((l: string) => l.replace(/^[-*\d.\s]+/, '').replace(/^["']|["']$/g, '').trim()).filter(Boolean).slice(0, 3);
        }
        if (!options.length) return jsonRes({ options: [], error: 'no options parsed', raw: clean.slice(0, 300) });
        return jsonRes({ options });
      } catch (e: any) {
        return jsonRes({ options: [], error: e?.message || 'generation failed' }, 502);
      }
    }

    // ── SPOTIFY ARTIST (Stories generator) ──────────────────
    // GET ?action=spotify-artist&q=<artist name>
    //
    // Returns the top artist match for the Instagram Stories generator:
    //   { name, imageUrl, spotifyId, popularity, followers, genres }
    // imageUrl is the largest available artist image (press photo). Empty
    // strings on miss so the frontend can fall back to manual upload.
    if (action === 'spotify-artist' && request.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      if (!q.trim()) return jsonRes({ error: 'missing q' }, 400);
      try {
        const token = await getSpotifyToken(env);
        if (!token) return jsonRes({ name: '', imageUrl: '', spotifyId: '', popularity: 0, followers: 0, genres: [] });
        const res = await fetch(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(clean(q))}&type=artist&limit=5`,
          { headers: { 'Authorization': `Bearer ${token}` } },
        );
        const data = await res.json() as any;
        const items = (data?.artists?.items || []) as any[];
        // Prefer the most-followed exact-ish name match; fall back to the
        // first result (Spotify already ranks by relevance/popularity).
        const wanted = clean(q).toLowerCase();
        const scored = items.map((a) => {
          let score = 0;
          if ((a.name || '').toLowerCase() === wanted) score += 5;
          else if ((a.name || '').toLowerCase().includes(wanted)) score += 2;
          score += Math.min(3, (a.followers?.total || 0) / 100000); // popularity nudge
          return { a, score };
        });
        scored.sort((x, y) => y.score - x.score);
        const top = scored[0]?.a;
        if (!top) return jsonRes({ name: '', imageUrl: '', spotifyId: '', popularity: 0, followers: 0, genres: [] });
        // Spotify returns images largest-first; take the largest.
        const imageUrl = top.images?.[0]?.url || '';
        return jsonRes({
          name: top.name || '',
          imageUrl,
          spotifyId: top.id || '',
          popularity: top.popularity || 0,
          followers: top.followers?.total || 0,
          genres: top.genres || [],
        });
      } catch (e: any) {
        return jsonRes({ name: '', imageUrl: '', spotifyId: '', popularity: 0, followers: 0, genres: [], error: e?.message || 'spotify error' });
      }
    }

    // ── SPOTIFY TRACKS (Stories generator best-track pick) ──
    // GET ?action=spotify-tracks&artist=<artist>&album=<title>[&year=<yyyy>]
    //
    // Finds the best-matching album for a release, returns its tracks sorted
    // by Spotify popularity so the Stories tool can auto-pick the lead track:
    //   { albumName, albumImage, tracks: [{ name, trackNumber, popularity, durationMs, spotifyId }] }
    // NOTE: Spotify's album-tracks endpoint does NOT include per-track
    // popularity. We fetch popularity via the /tracks batch endpoint, which
    // does. Empty tracks array on miss → frontend falls back to A1.
    if (action === 'spotify-tracks' && request.method === 'GET') {
      const artist = url.searchParams.get('artist') || '';
      const album  = url.searchParams.get('album')  || '';
      const year   = url.searchParams.get('year')   || '';
      if (!artist.trim() && !album.trim()) return jsonRes({ error: 'missing artist/album' }, 400);
      try {
        const token = await getSpotifyToken(env);
        if (!token) return jsonRes({ albumName: '', albumImage: '', tracks: [] });
        // 1. Find the best album match (reuse the cover-art scoring approach).
        let q = `${clean(album)} ${clean(artist)}`.trim();
        if (year) q += ` year:${year}`;
        const albRes = await fetch(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=album&limit=5`,
          { headers: { 'Authorization': `Bearer ${token}` } },
        );
        const albData = await albRes.json() as any;
        const albums = (albData?.albums?.items || []) as any[];
        const wantTitle = clean(album).toLowerCase();
        const wantArtist = clean(artist).toLowerCase();
        const scored = albums.map((it) => {
          let score = 0;
          if ((it.name || '').toLowerCase().includes(wantTitle) && wantTitle) score += 3;
          if (year && it.release_date?.slice(0, 4) === String(year)) score += 2;
          if ((it.artists?.[0]?.name || '').toLowerCase().includes(wantArtist) && wantArtist) score += 1;
          return { it, score };
        });
        scored.sort((a, b) => b.score - a.score);
        const bestAlbum = scored[0]?.it;
        if (!bestAlbum?.id) return jsonRes({ albumName: '', albumImage: '', tracks: [] });
        // 2. Get the album's tracks (id, name, track_number, duration_ms).
        const trkRes = await fetch(
          `https://api.spotify.com/v1/albums/${bestAlbum.id}/tracks?limit=50`,
          { headers: { 'Authorization': `Bearer ${token}` } },
        );
        const trkData = await trkRes.json() as any;
        const rawTracks = (trkData?.items || []) as any[];
        if (!rawTracks.length) return jsonRes({ albumName: bestAlbum.name || '', albumImage: bestAlbum.images?.[0]?.url || '', tracks: [] });
        // 3. Batch-fetch full track objects to get per-track popularity.
        const ids = rawTracks.map((t) => t.id).filter(Boolean).slice(0, 50).join(',');
        let popById: Record<string, number> = {};
        try {
          const popRes = await fetch(
            `https://api.spotify.com/v1/tracks?ids=${ids}`,
            { headers: { 'Authorization': `Bearer ${token}` } },
          );
          const popData = await popRes.json() as any;
          for (const t of (popData?.tracks || [])) {
            if (t?.id) popById[t.id] = t.popularity || 0;
          }
        } catch { /* popularity is best-effort; fall back to track order */ }
        const tracks = rawTracks.map((t) => ({
          name: t.name || '',
          trackNumber: t.track_number || 0,
          popularity: popById[t.id] ?? 0,
          durationMs: t.duration_ms || 0,
          spotifyId: t.id || '',
        }));
        // Sort by popularity desc; ties keep album order (stable).
        tracks.sort((a, b) => b.popularity - a.popularity);
        return jsonRes({
          albumName: bestAlbum.name || '',
          albumImage: bestAlbum.images?.[0]?.url || '',
          tracks,
        });
      } catch (e: any) {
        return jsonRes({ albumName: '', albumImage: '', tracks: [], error: e?.message || 'spotify error' });
      }
    }

    // ── WISHLIST ENDPOINTS ──────────────────────────────────
    // GET    ?action=wishlist&token=...                  → fetch user's wishlist
    // POST   ?action=wishlist  body:{token,item}         → add item
    // DELETE ?action=wishlist  body:{token,handle}       → remove item
    // POST   ?action=wishlist-merge body:{token,items}   → merge anon list on login

    // ── ACCOUNT PROFILE (CAAPI) ────────────────────────────────────
    // GET ?action=account-profile&session=<sessionId>
    // Returns { id, email, firstName, lastName } — same shape the frontend's
    // legacy customerProfile() returned, so the AccountDrawer is unchanged.
    if (action === 'account-profile' && request.method === 'GET') {
      const session = url.searchParams.get('session') || '';
      const d = await caapiQueryBySession(env, session,
        `query { customer { id displayName firstName lastName emailAddress { emailAddress } } }`);
      const c = d?.data?.customer;
      if (!c) return jsonRes({ error: 'auth' }, 401);
      return jsonRes({
        id: c.id,
        email: c.emailAddress?.emailAddress || '',
        firstName: c.firstName || '',
        lastName: c.lastName || '',
        displayName: c.displayName || '',
      });
    }

    // ── ACCOUNT ORDERS (CAAPI) ─────────────────────────────────────
    // GET ?action=account-orders&session=<sessionId>
    // Returns { orders: [...] } normalized to the same shape the frontend's
    // legacy customerOrders() produced, so OrdersView renders unchanged.
    if (action === 'account-orders' && request.method === 'GET') {
      const session = url.searchParams.get('session') || '';
      const d = await caapiQueryBySession(env, session, `
        query {
          customer {
            orders(first: 25, sortKey: PROCESSED_AT, reverse: true) {
              nodes {
                id
                name
                number
                processedAt
                financialStatus
                fulfillmentStatus
                totalPrice { amount currencyCode }
                lineItems(first: 25) {
                  nodes {
                    title
                    quantity
                    image { url }
                  }
                }
              }
            }
          }
        }
      `);
      // CAAPI returns 200 with an errors[] on auth/permission issues, or null on
      // transport failure. Either way, if there's no orders connection, treat as
      // unauthenticated rather than crashing the drawer.
      const nodes = d?.data?.customer?.orders?.nodes;
      if (!Array.isArray(nodes)) {
        // Distinguish "logged out" from "logged in, zero orders": if the
        // customer object itself is missing we 401; otherwise return empty.
        if (!d?.data?.customer) return jsonRes({ error: 'auth' }, 401);
        return jsonRes({ orders: [] });
      }
      const orders = nodes.map((o: any) => ({
        id: o.id,
        // CAAPI exposes both name ("#1001") and a numeric `number`. Prefer number.
        number: o.number != null ? o.number : (typeof o.name === 'string' ? o.name.replace(/^#/, '') : o.name),
        date: o.processedAt,
        financialStatus: o.financialStatus || '',
        fulfillmentStatus: o.fulfillmentStatus || '',
        statusUrl: '',
        total: o.totalPrice ? `${Number(o.totalPrice.amount).toFixed(2)} ${o.totalPrice.currencyCode}` : '',
        items: (o.lineItems?.nodes || []).map((li: any) => ({
          title: li.title,
          quantity: li.quantity,
          variantTitle: '',
          imageUrl: li.image?.url || '',
          handle: '',
        })),
      }));
      return jsonRes({ orders });
    }

    // ── NEWSLETTER: double opt-in subscribe ──────────────────────
    // POST ?action=newsletter-subscribe  body:{ email, source? }
    // Stores a pending token in KV and sends a confirmation email. Always
    // returns a generic 200 (we do NOT reveal whether the email already exists).
    if (action === 'newsletter-subscribe' && request.method === 'POST') {
      if (!env.RESEND_API_KEY) return jsonRes({ error: 'RESEND_API_KEY not configured' }, 500);
      let nlBody: any = {};
      try { nlBody = await request.json(); } catch { return jsonRes({ error: 'invalid json' }, 400); }
      const nlEmail = String(nlBody?.email || '').trim().toLowerCase();
      const nlSource = String(nlBody?.source || 'footer').trim().slice(0, 32);
      if (!isValidEmail(nlEmail)) return jsonRes({ error: 'invalid email' }, 400);

      const nlToken = newNlToken();
      await env.WISHLIST.put(
        `${NL_PENDING_PREFIX}${nlToken}`,
        JSON.stringify({ email: nlEmail, source: nlSource, createdAt: Date.now() }),
        { expirationTtl: NL_PENDING_TTL_S },
      );

      const confirmUrl = `${url.origin}/?action=newsletter-confirm&token=${encodeURIComponent(nlToken)}`;
      const nlSent = await sendNewsletterConfirmation(env, nlEmail, confirmUrl);
      if (!nlSent) {
        await env.WISHLIST.delete(`${NL_PENDING_PREFIX}${nlToken}`);
        return jsonRes({ error: 'send_failed' }, 502);
      }
      return jsonRes({ ok: true, status: 'confirmation_sent' });
    }

    // ── NEWSLETTER: confirm (double opt-in) ──────────────────────
    // GET ?action=newsletter-confirm&token=...  (link clicked from email)
    if (action === 'newsletter-confirm' && request.method === 'GET') {
      const nlcToken = url.searchParams.get('token') || '';
      if (!nlcToken) return newsletterResultPage(false);
      const nlcKey = `${NL_PENDING_PREFIX}${nlcToken}`;
      const nlcRaw = await env.WISHLIST.get(nlcKey);
      if (!nlcRaw) return newsletterResultPage(false);
      let nlcPending: any = {};
      try { nlcPending = JSON.parse(nlcRaw); } catch { nlcPending = {}; }
      const nlcEmail = String(nlcPending?.email || '').trim().toLowerCase();
      if (!isValidEmail(nlcEmail)) {
        await env.WISHLIST.delete(nlcKey);
        return newsletterResultPage(false);
      }
      const nlcCreated = await createResendContact(env, nlcEmail);
      await env.WISHLIST.delete(nlcKey);
      return newsletterResultPage(nlcCreated);
    }

    // ── NEWSLETTER: build broadcast draft (admin) ────────────────
    // Auth: Bearer BOOTSTRAP_AUTH_SECRET (admin-only; never called by clients).
    //
    // PREVIEW: GET ?action=newsletter-build-broadcast&preview=1&days=7
    //   Returns numbered PRE-ORDERS, NEW ARRIVALS and BACKORDERS lists for
    //   Eduardo to choose up to 2 featured picks. No Resend write, no blurbs.
    //
    // BUILD:   POST ?action=newsletter-build-broadcast
    //   body: { days?, featured?:[productId] (≤2, any section), subject? }
    //   Generates Sonnet blurbs for the featured picks (2nd takes a different
    //   angle from the 1st), assembles the HTML (≤5 per section + "see all"),
    //   and creates a DRAFT broadcast in Resend (send:false). Returns id.
    if (action === 'newsletter-build-broadcast') {
      const auth = request.headers.get('authorization') || '';
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (!m || m[1] !== env.BOOTSTRAP_AUTH_SECRET) {
        return jsonRes({ error: 'unauthorized' }, 401);
      }
      if (!env.RESEND_API_KEY) return jsonRes({ error: 'RESEND_API_KEY not configured' }, 500);

      // Shared: gather + sectionize products for the window.
      const gatherSections = async (days: number) => {
        const recent = await nlFetchRecentProducts(env, days);
        const graduated = await nlRecentlyGraduated(env, days);
        const recentIds = new Set(recent.map((p) => p.productId));
        // Recently-graduated products not already in the recent window: fetch
        // by handle (Storefront keys by handle, not Admin GID) so they appear.
        const missing = graduated.filter((g) => !recentIds.has(g.productId) && g.handle);
        const gradProducts = missing.length
          ? await nlFetchProductsByHandles(env, missing.map((g) => g.handle as string))
          : [];
        return nlSectionize(recent, gradProducts);
      };

      // ---- PREVIEW ----
      if (request.method === 'GET' && url.searchParams.get('preview')) {
        const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days') || '7', 10) || 7));
        const { preorders, arrivals, backorders } = await gatherSections(days);
        const fmt = (p: NLProduct) => ({
          productId: p.productId,
          title: p.title,
          artist: p.vendor,
          label: p.label,
          price: nlPriceLabel(p),
          imageUrl: p.imageUrl,
          handle: p.handle,
          createdAt: p.createdAt,
          releaseDate: p.releaseDate,
          stock: p.stock,
          year: p.year,
        });
        return jsonRes({
          window_days: days,
          max_blurbs: NL_MAX_FEATURED,
          preorders: preorders.map(fmt),
          new_arrivals: arrivals.map(fmt),
          backorders: backorders.map(fmt),
          counts: { preorders: preorders.length, new_arrivals: arrivals.length, backorders: backorders.length },
          note: `POST body.included = productIds to put in the email (any section, you choose). body.blurbs = up to ${NL_MAX_FEATURED} of those that get an editorial blurb. The email shows exactly what's in body.included — no auto top-N, no "see all".`,
        });
      }

      // ---- BUILD ----
      if (request.method === 'POST') {
        let body: any = {};
        try { body = await request.json(); } catch { return jsonRes({ error: 'invalid json' }, 400); }
        const days = Math.max(1, Math.min(90, parseInt(String(body?.days || '7'), 10) || 7));
        // included: productIds the user chose to put in the email (any section).
        // blurbs:   subset of included that get an editorial blurb. Capped to
        //           NL_MAX_FEATURED PER SECTION (not globally) below.
        const included: string[] = Array.isArray(body?.included) ? body.included.map(String) : [];
        const blurbs: string[] = Array.isArray(body?.blurbs)
          ? body.blurbs.map(String).filter((id: string) => included.includes(id))
          : [];
        const subject = String(body?.subject || 'New this week at House Only').slice(0, 200);

        if (!included.length) {
          return jsonRes({ error: 'nothing_selected', detail: 'Select at least one record to include in the email.' }, 400);
        }

        const { preorders, arrivals, backorders } = await gatherSections(days);
        const includedSet = new Set(included);
        const blurbSet = new Set(blurbs);

        // Keep only the user's chosen records, preserving each section's order.
        const pick = (arr: NLProduct[]) => arr.filter((p) => includedSet.has(p.productId));
        const pre = pick(preorders);
        const arr = pick(arrivals);
        const bak = pick(backorders);

        if (!pre.length && !arr.length && !bak.length) {
          return jsonRes({ error: 'nothing_to_send', detail: 'None of the selected records are still in the window — reload and try again.' }, 400);
        }

        // Generate blurbs PER SECTION: up to NL_MAX_FEATURED per section, and
        // within a section the 2nd blurb is told the 1st's angle so they differ.
        // (Anti-repetition resets per section — a pre-order and an arrival can
        // legitimately share an angle; two records in the SAME section shouldn't.)
        const blurbById = new Map<string, string>();
        const genSectionBlurbs = async (chosen: NLProduct[]) => {
          const picks = chosen.filter((p) => blurbSet.has(p.productId)).slice(0, NL_MAX_FEATURED);
          let prev = '';
          for (const p of picks) {
            const blurb = await nlGenerateBlurb(env, p, prev);
            blurbById.set(p.productId, blurb);
            if (blurb) prev = blurb;
          }
        };
        await genSectionBlurbs(pre);
        await genSectionBlurbs(arr);
        await genSectionBlurbs(bak);

        // Build a section from exactly the chosen records: blurbed ones become
        // feature cards (at the top of their section), the rest compact rows.
        // No top-N cap, no "see all" — the email is exactly what was selected.
        const buildSection = (
          chosen: NLProduct[], header: string, sub: string, cta: string,
        ): NLSectionRender => {
          const feat = chosen.filter((p) => blurbById.has(p.productId))
            .map((p) => ({ p, blurb: blurbById.get(p.productId) || '' }));
          const featIds = new Set(feat.map((f) => f.p.productId));
          const rows = chosen.filter((p) => !featIds.has(p.productId));
          return { header, sub, cta, seeAllLabel: '', seeAllUrl: '', featured: feat, rows, extraCount: 0 };
        };

        const sections = [
          nlRenderSection(buildSection(pre, 'Pre-orders', 'First access \u2014 reserve before they go public', 'Pre-order')),
          nlRenderSection(buildSection(arr, 'New arrivals', 'In stock now \u2014 in the shop this week', 'Shop')),
          nlRenderSection(buildSection(bak, 'Back in the catalogue', 'Released \u2014 request yours', 'Request')),
        ];

        const html = nlBuildBroadcastHtml(sections);
        const created = await nlCreateBroadcastDraft(env, subject, html);
        if (created.error) return jsonRes({ error: 'broadcast_create_failed', detail: created.error }, 502);
        return jsonRes({
          ok: true,
          broadcast_id: created.id,
          status: 'draft',
          subject,
          window_days: days,
          blurb_count: blurbById.size,
          shown: { preorders: pre.length, new_arrivals: arr.length, backorders: bak.length },
          totals: { preorders: preorders.length, new_arrivals: arrivals.length, backorders: backorders.length },
          next: 'Review and send the draft in the Resend dashboard (Broadcasts).',
        });
      }

      return jsonRes({ error: 'method not allowed' }, 405);
    }


    // ── AUTHENTICATED CHECKOUT (CAAPI → Storefront cart) ───────────
    // POST ?action=create-checkout  body: { session?, lines: [{merchandiseId, quantity}] }
    // Creates a Storefront cart server-side. If the session resolves to a valid
    // CAAPI access token, that token is attached as buyerIdentity.customerAccessToken
    // so the buyer stays logged in through to checkout (per Shopify docs). The
    // token never reaches the browser. Falls back to a guest cart if there's no
    // session or the token is unavailable — a checkout always succeeds.
    if (action === 'create-checkout' && request.method === 'POST') {
      let body: any = {};
      try { body = await request.json(); } catch { body = {}; }
      const session: string = body?.session || '';
      const rawLines = Array.isArray(body?.lines) ? body.lines : [];
      // Replicate the frontend's exact filter: only lines with a merchandiseId.
      const lines = rawLines
        .filter((l: any) => l && l.merchandiseId)
        .map((l: any) => ({ merchandiseId: l.merchandiseId, quantity: l.quantity || 1 }));
      if (!lines.length) return jsonRes({ error: 'no-lines' }, 400);

      const input: any = { lines };

      // Try to authenticate the cart. Best-effort: a failure here degrades to a
      // guest cart rather than blocking the sale.
      if (session) {
        const accessToken = await accessTokenFromSession(env, session);
        if (accessToken) {
          input.buyerIdentity = { customerAccessToken: accessToken };
        }
      }

      // Forward the buyer's IP for correct throttling/risk signals on server-side
      // Storefront calls, as recommended by Shopify for headless flows.
      const buyerIp =
        request.headers.get('cf-connecting-ip') ||
        request.headers.get('x-forwarded-for') ||
        '';

      const sfHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': env.STOREFRONT_TOKEN,
      };
      if (buyerIp) sfHeaders['Shopify-Storefront-Buyer-IP'] = buyerIp;

      let checkoutUrl = '';
      try {
        const r = await fetch(`https://${SHOPIFY_DOMAIN}/api/2024-04/graphql.json`, {
          method: 'POST',
          headers: sfHeaders,
          body: JSON.stringify({
            query: `mutation cartCreate($input: CartInput!) {
              cartCreate(input: $input) {
                cart { checkoutUrl }
                userErrors { field message }
              }
            }`,
            variables: { input },
          }),
        });
        const d: any = await r.json().catch(() => ({}));
        const errs = d?.data?.cartCreate?.userErrors;
        if (errs?.length) {
          return jsonRes({ error: errs.map((e: any) => e.message).join(', ') }, 400);
        }
        checkoutUrl = d?.data?.cartCreate?.cart?.checkoutUrl || '';
      } catch (e: any) {
        return jsonRes({ error: 'cart-failed', detail: String(e?.message || e) }, 502);
      }

      if (!checkoutUrl) return jsonRes({ error: 'no-checkout-url' }, 502);

      // Append logged_in=true so the buyer stays authenticated at checkout (CAAPI
      // docs). Rewrite the domain to the store's checkout subdomain, matching the
      // frontend's existing behavior.
      let finalUrl = checkoutUrl.replace('houseonly.store', 'checkout.houseonly.store');
      if (input.buyerIdentity) {
        finalUrl += (finalUrl.includes('?') ? '&' : '?') + 'logged_in=true';
      }
      return jsonRes({ checkoutUrl: finalUrl, authenticated: !!input.buyerIdentity });
    }

    if (action === 'wishlist' || action === 'wishlist-merge') {
      // GET: return wishlist
      if (request.method === 'GET') {
        // Fase 1B coexistence: accept a CAAPI `session` (new) or a legacy
        // Storefront `token` (old). resolveCustomerId prefers session.
        const session = url.searchParams.get('session') || '';
        const token = url.searchParams.get('token') || '';
        const cid = await resolveCustomerId(env, { session, token });
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
      const cid = await resolveCustomerId(env, { session: body.session || '', token: body.token || '' });
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
          'Authorization': 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
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

  // ── SCHEDULED HANDLER (Fase 3E) ───────────────────────────────
  // Runs every 15 min (cron */15 * * * *, configured in wrangler.jsonc).
  // Polls Discogs for new firm sales and (in live mode) reduces Shopify
  // inventory. Starts in 'dry' mode; switch via ?action=sync-mode.
  //
  // ctx.waitUntil ensures the work runs even if the cron event handler
  // returns before pollDiscogsForSales is done. Errors are caught so a
  // bad poll doesn't crash the Worker — we want next run to try again.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      pollDiscogsForSales(env).then(
        (result) => {
          // Store the latest poll result for inspection via sync-status
          // (or just by reading meta:last_poll_result directly from KV).
          return env.SYNC_STATE.put(
            'meta:last_poll_result',
            JSON.stringify({ scheduled_at: new Date(event.scheduledTime).toISOString(), ...result }),
          );
        },
        (err) => {
          // Network error or similar — log to KV so we can see it.
          return env.SYNC_STATE.put(
            'meta:last_poll_result',
            JSON.stringify({
              scheduled_at: new Date(event.scheduledTime).toISOString(),
              ok: false,
              error: err?.message || String(err),
            }),
          );
        },
      ),
    );

    // ── FORTHCOMING GRADUATION ──────────────────────────────
    // Independent of the Discogs poll above (separate waitUntil) so a failure
    // in one never affects the other. Reads its own mode from KV
    // (meta:graduation_mode, default 'dry'). In dry mode it only logs intended
    // graduations to KV; in live mode it removes the `forthcoming` tag from
    // products whose release date has passed. The summary is written to
    // meta:graduation_last_run (see ?action=graduation-status).
    ctx.waitUntil(
      runGraduation(env).then(
        () => { /* summary persisted inside runGraduation */ },
        (err) => {
          return env.SYNC_STATE.put(
            'meta:graduation_last_run',
            JSON.stringify({
              scheduled_at: new Date(event.scheduledTime).toISOString(),
              ok: false,
              error: err?.message || String(err),
            }),
          );
        },
      ),
    );
  },
};
