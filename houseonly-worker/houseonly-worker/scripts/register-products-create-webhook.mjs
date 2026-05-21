#!/usr/bin/env node
/**
 * Register the Shopify `products/create` webhook for Fase 3.5B, pointing at
 * the STAGING worker. Fires when a new product is created in the store;
 * the worker (in dry mode by default) runs the Discogs matcher and writes
 * pending-review records — it lists nothing until sync35-mode is flipped live.
 *
 * Idempotent-ish: checks existing subscriptions first and refuses to create
 * a duplicate for the same topic + uri.
 *
 * Required env vars (houseonly-backorder Custom App — same as other scripts):
 *   SHOPIFY_ADMIN_CLIENT_ID
 *   SHOPIFY_ADMIN_CLIENT_SECRET
 *
 * Usage:
 *   SHOPIFY_ADMIN_CLIENT_ID=... SHOPIFY_ADMIN_CLIENT_SECRET=... node register-products-create-webhook.mjs
 *
 * To target PROD later, change WORKER_URL to the prod worker and re-run.
 */

const SHOPIFY_DOMAIN = 'house-only-2.myshopify.com';
const API_VERSION    = '2026-04';
const TOPIC          = 'PRODUCTS_CREATE';
const WORKER_URL     = 'https://houseonly-worker-staging.emontagut.workers.dev/?action=webhook-shopify-product';

const CID = process.env.SHOPIFY_ADMIN_CLIENT_ID;
const CS  = process.env.SHOPIFY_ADMIN_CLIENT_SECRET;
if (!CID || !CS) {
  console.error('ERROR: SHOPIFY_ADMIN_CLIENT_ID and SHOPIFY_ADMIN_CLIENT_SECRET must be set.');
  process.exit(1);
}

async function mintToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CID,
    client_secret: CS,
  });
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`Token endpoint ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (!data.access_token) throw new Error(`No access_token: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function gql(token, query, variables) {
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`GraphQL ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (data.errors) throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  return data.data;
}

(async () => {
  console.log(`\n=== Register ${TOPIC} webhook → staging worker ===\n`);
  const token = await mintToken();
  console.log('Token minted.');

  // 1. Fetch all subscriptions, filter to our topic in code (avoids
  //    fragile inline-enum filter syntax; the `uri` field is directly
  //    available per Shopify docs).
  const listData = await gql(token, `
    query {
      webhookSubscriptions(first: 100) {
        edges { node { id topic uri } }
      }
    }
  `);
  const all = (listData.webhookSubscriptions.edges || []).map(e => e.node);
  const existing = all.filter(n => n.topic === TOPIC);

  console.log(`Existing ${TOPIC} subscriptions: ${existing.length}`);
  existing.forEach(s => console.log(`   ${s.id}  →  ${s.uri}`));

  const dup = existing.find(s => s.uri === WORKER_URL);
  if (dup) {
    console.log(`\n✓ Already registered to the target URL — nothing to do.`);
    console.log(`   ${dup.id}  →  ${dup.uri}`);
    return;
  }

  // 2. Create the subscription
  console.log(`\nCreating subscription → ${WORKER_URL}`);
  const createData = await gql(token, `
    mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
        webhookSubscription { id topic uri }
        userErrors { field message }
      }
    }
  `, { topic: TOPIC, sub: { uri: WORKER_URL, format: 'JSON' } });

  const payload = createData.webhookSubscriptionCreate;
  if (payload.userErrors && payload.userErrors.length) {
    console.error('userErrors:', JSON.stringify(payload.userErrors, null, 2));
    process.exit(1);
  }
  const sub = payload.webhookSubscription;
  console.log(`\n✓ Registered:`);
  console.log(`   id:    ${sub.id}`);
  console.log(`   topic: ${sub.topic}`);
  console.log(`   uri:   ${sub.uri}`);
  console.log(`\nNote: worker is in DRY mode — it will match + queue, list nothing.`);
})().catch(e => {
  console.error('\nFAILED: ' + e.message);
  process.exit(1);
});
