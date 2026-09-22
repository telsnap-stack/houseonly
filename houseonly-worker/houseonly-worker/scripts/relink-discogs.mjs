#!/usr/bin/env node
/**
 * Repair Discogs listing ↔ Shopify SKU links (worker ?action=sync-relink).
 *
 * A web-shop sale only takes a record off Discogs if KV holds
 * sku:{exact Shopify SKU}. Listings without external_id were cached under the
 * raw Discogs catno ("BOND 12081" instead of BOND12081C), so #1040 never
 * delisted and the record sold twice (147628-C-31, 2026-09-22).
 *
 * Walks the Discogs inventory one page (100 listings) per call and prints:
 *   fix         exactly one Shopify SKU matches (exact / case / separators) → written with --commit
 *   ambiguous   several match → pick one in the approvals file
 *   unresolved  none match; hints are prefix candidates (BOND12081 → BOND12081C)
 *   conflict    the Shopify SKU is already linked to another listing — check by hand
 * and every listing FOR SALE on Discogs with 0 Shopify stock.
 *
 * Required env:
 *   PROD_BS      BOOTSTRAP_AUTH_SECRET of the target worker
 *   WORKER_URL   optional, default prod
 *
 * Usage:
 *   PROD_BS=... node relink-discogs.mjs                         # dry run, For Sale listings
 *   PROD_BS=... node relink-discogs.mjs --status Draft          # the delisted ones
 *   PROD_BS=... node relink-discogs.mjs --approve approve.json  # {"4190680911": "BOND12081C"}
 *   PROD_BS=... node relink-discogs.mjs --commit [--approve approve.json]
 *
 * Idempotent: listings already linked correctly are counted as ok and untouched.
 * Never deletes keys and never re-points a SKU that belongs to another listing.
 */

import { readFileSync } from 'node:fs';

const WORKER = process.env.WORKER_URL || 'https://houseonly-worker.emontagut.workers.dev';
const BS = process.env.PROD_BS;
const COMMIT = process.argv.includes('--commit');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const STATUS = arg('--status') || 'For Sale';
const APPROVE = arg('--approve') ? JSON.parse(readFileSync(arg('--approve'), 'utf8')) : {};

if (!BS) {
  console.error('ERROR: PROD_BS must be set.');
  process.exit(1);
}

const totals = { ok: 0, fix: 0, approved: 0, ambiguous: 0, unresolved: 0, conflict: 0 };
const needsYou = [];
const noStock = [];

console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} · ${STATUS} · ${WORKER}\n`);

for (let page = 1, pages = 1; page <= pages; page++) {
  const qs = new URLSearchParams({ action: 'sync-relink', page: String(page), status: STATUS });
  if (COMMIT) qs.set('commit', '1');
  const r = await fetch(`${WORKER}/?${qs}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BS}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve: APPROVE }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(`page ${page}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    process.exit(1);
  }
  pages = j.pages || 1;
  for (const [k, v] of Object.entries(j.counts || {})) totals[k] += v;
  noStock.push(...(j.for_sale_without_stock || []));
  for (const l of j.listings || []) {
    const line = `${String(l.listing_id).padEnd(11)} ${l.outcome.padEnd(10)} `
      + `${(l.cached_sku || l.catno || '-').padEnd(20)} → ${(l.shopify_sku || '?').padEnd(16)} ${l.release || ''}`;
    console.log(line);
    if (l.hints) console.log(`${' '.repeat(12)}hints: ${JSON.stringify(l.hints)}`);
    if (['ambiguous', 'unresolved', 'conflict'].includes(l.outcome)) needsYou.push(l);
  }
  console.log(`— page ${page}/${pages}`);
}

console.log(`\nTotals: ${JSON.stringify(totals)}`);
if (noStock.length) {
  console.log(`\nFOR SALE on Discogs with no Shopify stock (${noStock.length}) — take these down on Discogs:`);
  for (const n of noStock) console.log(`  ${n.listing_id}  ${n.sku}  stock ${n.stock}  ${n.title}`);
}
if (needsYou.length) {
  console.log(`\n${needsYou.length} listing(s) need a decision. Put confirmed pairs in an approvals file, e.g.`);
  console.log(`  {"${needsYou[0].listing_id}": "<Shopify SKU>"}`);
}
if (!COMMIT && totals.fix + totals.approved) {
  console.log(`\nRe-run with --commit to write ${totals.fix + totals.approved} link(s).`);
}
