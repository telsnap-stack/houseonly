#!/usr/bin/env node
/**
 * Backfill: rename the legacy `dbh` product tag to `source:dbh` across all
 * Shopify products that currently carry it. Aligns existing catalog with the
 * Fase 3.5A importer change (DBHImporter now emits `source:dbh`).
 *
 * Uses Shopify Admin GraphQL `tagsAdd` + `tagsRemove` (per Shopify docs, the
 * canonical way to "rename" a tag is remove-old + add-new, one product at a
 * time). Only touches the two tags; every other tag on each product is left
 * untouched.
 *
 * Required env vars (same Custom App as the webhook migration — houseonly-backorder):
 *   SHOPIFY_ADMIN_CLIENT_ID
 *   SHOPIFY_ADMIN_CLIENT_SECRET
 *
 * Usage:
 *   # DRY RUN (default) — lists every product that WOULD change, mutates nothing:
 *   SHOPIFY_ADMIN_CLIENT_ID=... SHOPIFY_ADMIN_CLIENT_SECRET=... node backfill-dbh-tag.mjs
 *
 *   # COMMIT — actually performs the tag changes:
 *   SHOPIFY_ADMIN_CLIENT_ID=... SHOPIFY_ADMIN_CLIENT_SECRET=... node backfill-dbh-tag.mjs --commit
 *
 * Idempotent: re-running is safe. Products already migrated (no `dbh` tag) won't
 * be returned by the query, so they're skipped automatically.
 */

const SHOPIFY_DOMAIN = 'house-only-2.myshopify.com';
const API_VERSION    = '2026-04';
const OLD_TAG        = 'dbh';
const NEW_TAG        = 'source:dbh';
const COMMIT         = process.argv.includes('--commit');

const CID = process.env.SHOPIFY_ADMIN_CLIENT_ID;
const CS  = process.env.SHOPIFY_ADMIN_CLIENT_SECRET;

if (!CID || !CS) {
  console.error('ERROR: SHOPIFY_ADMIN_CLIENT_ID and SHOPIFY_ADMIN_CLIENT_SECRET must be set.');
  process.exit(1);
}

async function mintToken() {
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     CID,
    client_secret: CS,
  });
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  if (!r.ok) throw new Error(`Token endpoint ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (!data.access_token) throw new Error(`No access_token: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function gql(token, query, variables) {
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method:  'POST',
    headers: {
      'Content-Type':           'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`GraphQL ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (data.errors) throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  return data.data;
}

// Collect every product with the OLD_TAG, paginating through all pages.
async function fetchAllTaggedProducts(token) {
  const products = [];
  let cursor = null;
  let page = 0;
  do {
    page++;
    const data = await gql(token, `
      query($cursor: String) {
        products(first: 100, after: $cursor, query: "tag:${OLD_TAG}") {
          edges {
            cursor
            node { id title tags }
          }
          pageInfo { hasNextPage }
        }
      }
    `, { cursor });

    const edges = data.products.edges;
    for (const e of edges) products.push(e.node);
    const hasNext = data.products.pageInfo.hasNextPage;
    cursor = hasNext && edges.length ? edges[edges.length - 1].cursor : null;
    console.log(`  page ${page}: fetched ${edges.length} (running total ${products.length})`);
  } while (cursor);
  return products;
}

async function addTag(token, id) {
  const data = await gql(token, `
    mutation($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
    }
  `, { id, tags: [NEW_TAG] });
  const errs = data.tagsAdd.userErrors;
  if (errs && errs.length) throw new Error(`tagsAdd: ${JSON.stringify(errs)}`);
}

async function removeTag(token, id) {
  const data = await gql(token, `
    mutation($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
    }
  `, { id, tags: [OLD_TAG] });
  const errs = data.tagsRemove.userErrors;
  if (errs && errs.length) throw new Error(`tagsRemove: ${JSON.stringify(errs)}`);
}

(async () => {
  console.log(`\n=== DBH tag backfill: "${OLD_TAG}" -> "${NEW_TAG}" ===`);
  console.log(COMMIT ? 'MODE: COMMIT (will modify products)\n' : 'MODE: DRY RUN (no changes — pass --commit to apply)\n');

  const token = await mintToken();
  console.log('Token minted. Fetching tagged products...');

  const products = await fetchAllTaggedProducts(token);
  console.log(`\nFound ${products.length} products tagged "${OLD_TAG}".\n`);

  if (products.length === 0) {
    console.log('Nothing to do. (Either already migrated, or no products tagged.)');
    return;
  }

  // Sanity: flag any product that somehow already has the new tag (idempotency check)
  const alreadyHasNew = products.filter(p => p.tags.includes(NEW_TAG));
  if (alreadyHasNew.length) {
    console.log(`Note: ${alreadyHasNew.length} of these already have "${NEW_TAG}" — tagsAdd will no-op for them, tagsRemove will still strip "${OLD_TAG}".\n`);
  }

  let ok = 0, failed = 0;
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const label = `[${String(i + 1).padStart(3)}/${products.length}] ${p.title.slice(0, 50)}`;
    if (!COMMIT) {
      console.log(`${label}  →  would add "${NEW_TAG}", remove "${OLD_TAG}"`);
      ok++;
      continue;
    }
    try {
      await addTag(token, p.id);
      await removeTag(token, p.id);
      console.log(`${label}  ✓`);
      ok++;
    } catch (e) {
      console.error(`${label}  ✗ ${e.message}`);
      failed++;
    }
    // gentle pacing to stay well under Shopify's GraphQL cost rate limit
    await new Promise(r => setTimeout(r, 120));
  }

  console.log('\n══════════════════════════════════════════════════');
  if (COMMIT) {
    console.log(`  DONE — ${ok} updated, ${failed} failed (of ${products.length})`);
  } else {
    console.log(`  DRY RUN complete — ${ok} products would be updated`);
    console.log(`  Re-run with --commit to apply.`);
  }
  console.log('══════════════════════════════════════════════════');
})().catch(e => {
  console.error('\nFAILED: ' + e.message);
  process.exit(1);
});
