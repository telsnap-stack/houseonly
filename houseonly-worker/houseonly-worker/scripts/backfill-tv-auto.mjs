#!/usr/bin/env node
import { createHmac } from 'node:crypto';
const SHOPIFY_DOMAIN = 'house-only-2.myshopify.com';
const API_VERSION    = '2026-04';
const SOURCE_TAG     = 'source:tv';
const PROD_BASE      = 'https://houseonly-worker.emontagut.workers.dev';
const WEBHOOK_URL    = `${PROD_BASE}/?action=webhook-shopify-product&sync=1`;
const REVIEW_LIST_URL = `${PROD_BASE}/?action=pending-review-list`;
const SEND       = process.argv.includes('--send');
const MAX_PASSES = 8;
const SEND_DELAY_MS = 250;
const REQ_TIMEOUT_MS = 45000;
const CID = process.env.SHOPIFY_ADMIN_CLIENT_ID;
const CS  = process.env.SHOPIFY_ADMIN_CLIENT_SECRET;
const BS  = process.env.PROD_BS;
if (!CID || !CS) { console.error('ERROR: SHOPIFY_ADMIN_CLIENT_ID and SHOPIFY_ADMIN_CLIENT_SECRET must be set.'); process.exit(1); }
if (!BS) { console.error('ERROR: PROD_BS must be set.'); process.exit(1); }
const TERMINAL_REASONS = new Set([
  'forthcoming pre-order — not listed on Discogs',
  'sku already mapped', 'no sku', 'no recognized source tag', 'no product id',
]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchWithTimeout(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}
async function mintToken() {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CID, client_secret: CS });
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  if (!r.ok) throw new Error(`Token endpoint ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (!data.access_token) throw new Error(`No access_token: ${JSON.stringify(data)}`);
  return data.access_token;
}
async function gql(token, query, variables) {
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`GraphQL ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (data.errors) throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  return data.data;
}
async function fetchAllTvProducts(token) {
  const products = []; let cursor = null; let page = 0;
  do {
    page++;
    const data = await gql(token, `
      query($cursor: String) {
        products(first: 100, after: $cursor, query: "tag:'${SOURCE_TAG}'") {
          edges { cursor node { id title vendor tags variants(first: 1) { edges { node { id sku price barcode } } } } }
          pageInfo { hasNextPage }
        }
      }`, { cursor });
    const edges = data.products.edges;
    for (const e of edges) {
      const n = e.node;
      if (!Array.isArray(n.tags) || !n.tags.includes(SOURCE_TAG)) continue;
      const v = (n.variants?.edges?.[0]?.node) || {};
      products.push({
        id: n.id, title: n.title || '', vendor: n.vendor || '', tags: n.tags.join(', '),
        variants: [{ id: v.id, sku: (v.sku || '').trim(), price: v.price != null ? String(v.price) : '', barcode: (v.barcode || '').trim() }],
      });
    }
    const hasNext = data.products.pageInfo.hasNextPage;
    cursor = hasNext && edges.length ? edges[edges.length - 1].cursor : null;
    console.log(`  page ${page}: fetched ${edges.length} (running total ${products.length})`);
  } while (cursor);
  return products;
}
function signedHeaders(rawBody) {
  const hmac = createHmac('sha256', CS).update(rawBody, 'utf8').digest('base64');
  return { 'Content-Type': 'application/json', 'X-Shopify-Hmac-SHA256': hmac, 'X-Shopify-Topic': 'products/create' };
}
async function sendOne(product) {
  const rawBody = JSON.stringify(product);
  const headers = signedHeaders(rawBody);
  let lastErr = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetchWithTimeout(WEBHOOK_URL, { method: 'POST', headers, body: rawBody }, REQ_TIMEOUT_MS);
      const text = await r.text();
      let json = {}; try { json = JSON.parse(text); } catch {}
      if (r.status === 429 || r.status >= 500) { lastErr = `HTTP ${r.status}: ${text.slice(0,200)}`; await sleep(1000 * 2 ** (attempt-1)); continue; }
      const reason = json.reason || (json.queued ? 'queued' : `http ${r.status}`);
      return { ok: r.ok && (json.queued === true || TERMINAL_REASONS.has(json.reason)), status: r.status, reason, terminal: TERMINAL_REASONS.has(json.reason), queued: json.queued === true };
    } catch (e) { lastErr = e?.message || String(e); await sleep(1000 * 2 ** (attempt-1)); }
  }
  return { ok: false, status: 0, reason: lastErr || 'send failed', terminal: false, queued: false };
}
async function fetchReviewRecords() {
  const r = await fetchWithTimeout(REVIEW_LIST_URL, { method: 'GET', headers: { 'Authorization': `Bearer ${BS}` } }, REQ_TIMEOUT_MS);
  if (!r.ok) throw new Error(`pending-review-list ${r.status}: ${(await r.text()).slice(0,200)}`);
  const data = await r.json();
  const map = new Map();
  for (const rec of (data.records || [])) if (rec?.sku) map.set(rec.sku, rec.status || 'pending');
  return map;
}
function countOurStatuses(reviewMap, skuSet) {
  const counts = {};
  for (const sku of skuSet) if (reviewMap.has(sku)) { const s = reviewMap.get(sku); counts[s] = (counts[s]||0)+1; }
  return counts;
}
(async () => {
  console.log(`\n=== Triple Vision (${SOURCE_TAG}) → Discogs review queue backfill ===`);
  console.log(SEND ? 'MODE: SEND\n' : 'MODE: DRY RUN (pass --send to replay)\n');
  const token = await mintToken();
  console.log('Shopify token minted. Fetching source:tv products...');
  const products = await fetchAllTvProducts(token);
  const sendable = products.filter(p => p.variants[0].sku);
  const noSku = products.length - sendable.length;
  const skuSet = new Set(sendable.map(p => p.variants[0].sku));
  const bySku = new Map(sendable.map(p => [p.variants[0].sku, p]));
  console.log(`\nFound ${products.length} products tagged "${SOURCE_TAG}" (${sendable.length} with a SKU${noSku ? `, ${noSku} without` : ''}).`);
  if (!SEND) {
    let queued = new Map();
    try { queued = await fetchReviewRecords(); } catch (e) { console.log(`  (could not read review queue: ${e.message})`); }
    const already = [...skuSet].filter(s => queued.has(s)).length;
    console.log(`\nDRY RUN — would send ${sendable.length} webhooks. Already queued now: ${already}.`);
    return;
  }
  const terminalSkip = new Map(); let pass = 0;
  while (pass < MAX_PASSES) {
    pass++;
    const reviewMap = await fetchReviewRecords();
    const queuedNow = [...skuSet].filter(s => reviewMap.has(s)).length;
    const pending = [...skuSet].filter(s => !reviewMap.has(s) && !terminalSkip.has(s));
    console.log(`\n── Pass ${pass} ──  queued: ${queuedNow}/${sendable.length}  •  to (re)send: ${pending.length}  •  terminal-skipped: ${terminalSkip.size}`);
    if (pending.length === 0) { console.log('  Nothing left to send. Done.'); break; }
    let sent = 0, failed = 0;
    for (const sku of pending) {
      const res = await sendOne(bySku.get(sku));
      if (res.terminal) { terminalSkip.set(sku, res.reason); console.log(`  • ${sku.padEnd(18)} skip (${res.reason})`); }
      else if (res.ok || res.queued) sent++;
      else { failed++; console.log(`  ✗ ${sku.padEnd(18)} ${res.reason}`); }
      await sleep(SEND_DELAY_MS);
    }
    console.log(`  pass ${pass}: ${sent} sent ok, ${failed} failed`);
  }
  const finalMap = await fetchReviewRecords();
  const finalQueued = [...skuSet].filter(s => finalMap.has(s)).length;
  const byStatus = countOurStatuses(finalMap, skuSet);
  const stillMissing = [...skuSet].filter(s => !finalMap.has(s));
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  TRIPLE VISION BACKFILL COMPLETE`);
  console.log(`  source:tv products with a SKU : ${sendable.length}`);
  console.log(`  In Discogs review queue       : ${finalQueued}`);
  console.log(`  By status                     : ${JSON.stringify(byStatus)}`);
  if (terminalSkip.size) { const reasons = {}; for (const r of terminalSkip.values()) reasons[r]=(reasons[r]||0)+1; console.log(`  Terminal-skipped (server)     : ${terminalSkip.size} ${JSON.stringify(reasons)}`); }
  if (stillMissing.length) console.log(`  STILL NOT QUEUED              : ${stillMissing.length}`);
  console.log('══════════════════════════════════════════════════');
  if (stillMissing.some(s => !terminalSkip.has(s))) process.exit(2);
})().catch(e => { console.error('\nFAILED: ' + e.message); process.exit(1); });
