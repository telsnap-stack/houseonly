#!/usr/bin/env node
// backfill-discogs-sku.mjs — write the SKU into `external_id` + `location` of
// live Discogs listings that are missing them (same pattern the worker uses
// when it creates listings: external_id = location = Shopify SKU/catno).
//
// Context (2026-07-26): the Deep Jungle lot was listed on Discogs without
// these fields, so sales of those listings can't self-resolve to a Shopify
// variant (sale #147628-20 / DAT114 was the first casualty).
//
// Dry-run by default: prints every live listing with a missing field, the SKU
// it WOULD write and where that SKU came from. Apply with --send.
//
//   DISCOGS_TOKEN=...   node scripts/backfill-discogs-sku.mjs [--send] [--limit N] [--force]
//
// Optional: SHOPIFY_ADMIN_CLIENT_ID / SHOPIFY_ADMIN_CLIENT_SECRET — when set,
// every candidate SKU is verified against Shopify (variant with that exact
// SKU must exist). --send only writes verified rows; --force also writes
// unverified ones (use only after eyeballing the dry-run table).
//
// After a successful --send, re-run the worker's KV bootstrap so the
// sku:/listing: mappings catch up:
//   curl -X POST -H "Authorization: Bearer $PROD_BS" \
//     'https://houseonly-worker.emontagut.workers.dev/?action=sync-bootstrap'

const DISCOGS_BASE = 'https://api.discogs.com';
const USERNAME     = 'houseonly';
const UA           = 'houseonly-backfill-discogs-sku/1.0 +https://houseonly.pages.dev';
const SHOPIFY_DOMAIN = 'house-only-2.myshopify.com';
const API_VERSION    = '2026-04';

const SEND  = process.argv.includes('--send');
const FORCE = process.argv.includes('--force');
const limitIx = process.argv.indexOf('--limit');
const LIMIT = limitIx > -1 ? parseInt(process.argv[limitIx + 1], 10) : Infinity;
// --map FILE: JSON { "<listing_id>": "<sku>" } of pre-approved writes. When
// given, --send writes exactly those rows with those SKUs (the file is the
// verification — built by cross-checking the dry-run against Shopify).
const mapIx = process.argv.indexOf('--map');
const MAP_FILE = mapIx > -1 ? process.argv[mapIx + 1] : null;

const TOKEN = process.env.DISCOGS_TOKEN;
if (!TOKEN) { console.error('ERROR: DISCOGS_TOKEN must be set.'); process.exit(1); }
const CID = process.env.SHOPIFY_ADMIN_CLIENT_ID;
const CS  = process.env.SHOPIFY_ADMIN_CLIENT_SECRET;
const VERIFY = Boolean(CID && CS);

const EDIT_DELAY_MS = 1200; // Discogs auth'd rate limit is 60 req/min

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function discogs(path, opts = {}) {
  for (;;) {
    const r = await fetch(`${DISCOGS_BASE}${path}`, {
      ...opts,
      headers: {
        'Authorization': `Discogs token=${TOKEN}`,
        'User-Agent': UA,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
    if (r.status === 429) {
      console.log('  rate-limited, sleeping 65s…');
      await sleep(65000);
      continue;
    }
    return r;
  }
}

// Discogs catnos often carry a space between label prefix and number
// ("DAT 114") while this shop's Shopify SKUs don't ("DAT114"). Collapse ONLY
// that first prefix/number gap; keep the rest verbatim so multi-part catnos
// like "DAT 088 A/B" become "DAT088 A/B", not "DAT088A/B".
function catnoToSku(catno) {
  const c = (catno || '').trim().replace(/\s+/g, ' ');
  return c.replace(/^([A-Za-z]+) (\d)/, '$1$2');
}

async function mintShopifyToken() {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CID, client_secret: CS });
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  if (!r.ok) throw new Error(`Shopify token endpoint ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (!data.access_token) throw new Error(`No access_token: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function shopifyHasSku(token, sku) {
  const q = `query($q: String!) { productVariants(first: 5, query: $q) { edges { node { sku } } } }`;
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: q, variables: { q: `sku:"${sku.replace(/"/g, '\\"')}"` } }),
  });
  if (!r.ok) throw new Error(`Shopify GraphQL ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (data.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
  // query "sku:X" is a loose match — require the exact SKU among the hits
  return (data.data.productVariants.edges || []).some(e => (e.node.sku || '').trim() === sku);
}

async function fetchLiveInventory() {
  const listings = [];
  let page = 1, pages = 1;
  while (page <= pages) {
    const r = await discogs(`/users/${USERNAME}/inventory?status=${encodeURIComponent('For Sale')}&per_page=100&page=${page}&sort=item&sort_order=asc`);
    if (!r.ok) throw new Error(`inventory page ${page}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    pages = data.pagination.pages;
    listings.push(...data.listings);
    console.log(`  inventory page ${page}/${pages}: ${data.listings.length} listings (running total ${listings.length})`);
    page++;
  }
  return listings;
}

async function editListing(l, sku) {
  // Discogs edit = POST with the required fields resent; include the optional
  // ones we know so nothing gets cleared.
  const body = {
    release_id: l.release.id,
    condition: l.condition,
    price: l.price.value,
    status: l.status,
    external_id: sku,
    location: sku,
  };
  if (l.sleeve_condition) body.sleeve_condition = l.sleeve_condition;
  if (l.comments) body.comments = l.comments;
  if (typeof l.allow_offers === 'boolean') body.allow_offers = l.allow_offers;
  if (l.format_quantity) body.format_quantity = l.format_quantity;
  if (l.weight) body.weight = l.weight;
  const r = await discogs(`/marketplace/listings/${l.id}`, { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
}

const main = async () => {
  console.log(`Mode: ${SEND ? 'SEND (writing to Discogs)' : 'DRY-RUN (no writes)'}${VERIFY ? ' + Shopify SKU verification' : ' (no Shopify creds — SKUs unverified)'}`);
  console.log('Fetching live inventory…');
  const all = await fetchLiveInventory();

  const complete = [];
  const rows = [];
  for (const l of all) {
    const ext = (l.external_id || '').trim();
    const loc = (l.location || '').trim();
    if (ext && loc) { complete.push(l); continue; }
    const catno = l.release?.catalog_number || '';
    const sku = ext || catnoToSku(catno);
    rows.push({
      listing: l, listing_id: l.id, catno, sku,
      sku_source: ext ? 'external_id (filling location only)' : 'release catno (normalised)',
      missing: !ext && !loc ? 'both' : (!ext ? 'external_id' : 'location'),
      release_desc: l.release?.description || '',
      verified: null,
    });
  }

  let shopifyToken = null;
  if (VERIFY && rows.length) {
    shopifyToken = await mintShopifyToken();
    for (const row of rows) {
      row.verified = row.sku ? await shopifyHasSku(shopifyToken, row.sku) : false;
      await sleep(150);
    }
  }

  console.log('');
  console.log(`Live listings           : ${all.length}`);
  console.log(`OK (both fields set)    : ${complete.length}`);
  console.log(`Missing field(s)        : ${rows.length}`);
  if (VERIFY) {
    console.log(`  SKU verified in Shopify   : ${rows.filter(r => r.verified).length}`);
    console.log(`  SKU NOT found in Shopify  : ${rows.filter(r => !r.verified).length}`);
  }
  console.log('');
  for (const r of rows) {
    const v = r.verified === null ? 'unverified' : (r.verified ? 'shopify ✓' : 'SHOPIFY ✗');
    console.log(`  ${String(r.listing_id).padEnd(12)} missing=${r.missing.padEnd(11)} catno="${r.catno}" → sku="${r.sku}" [${r.sku_source}] [${v}]  ${r.release_desc.slice(0, 60)}`);
  }

  if (!SEND) {
    console.log('\nDry-run complete. Re-run with --send to write.');
    return;
  }

  let writable, skipped;
  if (MAP_FILE) {
    const { readFileSync } = await import('node:fs');
    const approved = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
    writable = rows.filter(r => approved[String(r.listing_id)])
      .map(r => ({ ...r, sku: approved[String(r.listing_id)] }));
    skipped = rows.filter(r => !approved[String(r.listing_id)]);
  } else {
    writable = rows.filter(r => r.sku && (r.verified === true || (FORCE && r.verified !== true) || (!VERIFY && FORCE)));
    skipped = rows.filter(r => !writable.includes(r));
    if (!VERIFY && !FORCE) {
      console.log('\nRefusing to --send without Shopify verification. Set SHOPIFY_ADMIN_CLIENT_ID/SECRET, use --map, or add --force after reviewing the dry-run.');
      process.exit(1);
    }
  }
  console.log(`\nWriting ${Math.min(writable.length, LIMIT)} of ${writable.length} listings (${skipped.length} skipped)…`);
  let done = 0, failed = 0;
  for (const r of writable.slice(0, LIMIT)) {
    try {
      await editListing(r.listing, r.sku);
      done++;
      console.log(`  ✓ ${r.listing_id} ← "${r.sku}"`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${r.listing_id}: ${e.message}`);
    }
    await sleep(EDIT_DELAY_MS);
  }
  console.log(`\nDone. written=${done} failed=${failed} skipped=${skipped.length}`);
  if (done) console.log('Now re-run the worker KV bootstrap (see header) so sku:/listing: mappings catch up.');
};

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
