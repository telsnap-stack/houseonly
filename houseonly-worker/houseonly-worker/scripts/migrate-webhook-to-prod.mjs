#!/usr/bin/env node
/**
 * One-shot migration script for the Discogs sync webhook.
 *
 * Moves the existing Shopify webhook subscription (ID 2245981176192) from
 * the staging Worker URL to the production Worker URL. Uses the Shopify
 * Admin GraphQL `webhookSubscriptionUpdate` mutation, which is documented
 * to apply atomically without interrupting webhook delivery.
 *
 * Required env vars:
 *   SHOPIFY_ADMIN_CLIENT_ID
 *   SHOPIFY_ADMIN_CLIENT_SECRET
 *
 * Usage:
 *   SHOPIFY_ADMIN_CLIENT_ID=... SHOPIFY_ADMIN_CLIENT_SECRET=... node migrate-webhook-to-prod.mjs
 *
 * Or interactively (zsh, doesn't leak to scrollback):
 *   read -s "?CID: " CID && echo ""
 *   read -s "?CSECRET: " CS && echo ""
 *   SHOPIFY_ADMIN_CLIENT_ID="$CID" SHOPIFY_ADMIN_CLIENT_SECRET="$CS" node migrate-webhook-to-prod.mjs
 *   unset CID CS
 *
 * Safety: queries the current state before mutating. Aborts with a clear
 * message if the webhook is missing, has the wrong topic, or already points
 * at prod.
 */

const SHOPIFY_DOMAIN  = 'house-only-2.myshopify.com';
const API_VERSION     = '2026-04';
const WEBHOOK_ID      = 'gid://shopify/WebhookSubscription/2245981176192';
const EXPECTED_TOPIC  = 'ORDERS_CREATE';
const STAGING_URI     = 'https://houseonly-worker-staging.emontagut.workers.dev/?action=webhook-shopify-order';
const PROD_URI        = 'https://houseonly-worker.emontagut.workers.dev/?action=webhook-shopify-order';

const CID = process.env.SHOPIFY_ADMIN_CLIENT_ID;
const CS  = process.env.SHOPIFY_ADMIN_CLIENT_SECRET;

if (!CID || !CS) {
  console.error('ERROR: SHOPIFY_ADMIN_CLIENT_ID and SHOPIFY_ADMIN_CLIENT_SECRET must be set.');
  process.exit(1);
}

// ── Step 1: Mint an OAuth access token ────────────────────────────────
async function mintToken() {
  console.log('Step 1/4: Minting OAuth access token...');
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
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Token endpoint ${r.status}: ${text}`);
  }
  const data = await r.json();
  if (!data.access_token) {
    throw new Error(`Token response missing access_token: ${JSON.stringify(data)}`);
  }
  console.log('  ✓ Token minted (length: ' + data.access_token.length + ' chars)');
  return data.access_token;
}

// ── GraphQL helper ────────────────────────────────────────────────────
async function gql(token, query, variables) {
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type':         'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GraphQL ${r.status}: ${text}`);
  }
  const data = await r.json();
  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

// ── Step 2: Query current state ────────────────────────────────────────
async function fetchCurrent(token) {
  console.log('\nStep 2/4: Querying current webhook state...');
  const data = await gql(token, `
    query($id: ID!) {
      webhookSubscription(id: $id) {
        id
        topic
        endpoint {
          __typename
          ... on WebhookHttpEndpoint { callbackUrl }
        }
        createdAt
        updatedAt
      }
    }
  `, { id: WEBHOOK_ID });

  const wh = data.webhookSubscription;
  if (!wh) {
    throw new Error(`Webhook ${WEBHOOK_ID} not found. Was it deleted?`);
  }
  const currentUri = wh.endpoint?.callbackUrl || '(not an HTTP endpoint)';
  console.log('  ✓ Webhook found:');
  console.log('      id:        ' + wh.id);
  console.log('      topic:     ' + wh.topic);
  console.log('      uri:       ' + currentUri);
  console.log('      createdAt: ' + wh.createdAt);
  console.log('      updatedAt: ' + wh.updatedAt);

  // Safety checks
  if (wh.topic !== EXPECTED_TOPIC) {
    throw new Error(`Topic mismatch. Expected ${EXPECTED_TOPIC}, got ${wh.topic}. Refusing to update.`);
  }
  if (currentUri === PROD_URI) {
    console.log('\n  ⚠ Webhook is ALREADY pointing at prod. Nothing to do. Exiting.');
    process.exit(0);
  }
  if (currentUri !== STAGING_URI) {
    console.log(`\n  ⚠ Current URI is neither staging nor prod:\n      ${currentUri}`);
    console.log('  This script expected to migrate from staging → prod.');
    console.log('  Aborting. Verify webhook state manually before proceeding.');
    process.exit(1);
  }
  console.log('  ✓ Safety checks passed (topic matches, currently on staging URI)');
  return wh;
}

// ── Step 3: Run the update mutation ────────────────────────────────────
async function runUpdate(token) {
  console.log('\nStep 3/4: Updating webhook URI to prod...');
  const data = await gql(token, `
    mutation($id: ID!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionUpdate(id: $id, webhookSubscription: $webhookSubscription) {
        userErrors { field message }
        webhookSubscription {
          id
          topic
          endpoint {
            __typename
            ... on WebhookHttpEndpoint { callbackUrl }
          }
          updatedAt
        }
      }
    }
  `, {
    id: WEBHOOK_ID,
    webhookSubscription: { callbackUrl: PROD_URI },
  });

  const result = data.webhookSubscriptionUpdate;
  if (result.userErrors && result.userErrors.length > 0) {
    throw new Error(`Mutation userErrors: ${JSON.stringify(result.userErrors)}`);
  }
  const newUri = result.webhookSubscription?.endpoint?.callbackUrl;
  console.log('  ✓ Mutation succeeded:');
  console.log('      new uri:   ' + newUri);
  console.log('      updatedAt: ' + result.webhookSubscription.updatedAt);
  if (newUri !== PROD_URI) {
    throw new Error(`Post-mutation URI mismatch. Expected ${PROD_URI}, got ${newUri}.`);
  }
  return result.webhookSubscription;
}

// ── Step 4: Re-query to confirm ────────────────────────────────────────
async function verify(token) {
  console.log('\nStep 4/4: Re-querying to confirm new state...');
  // small delay to ensure read-after-write consistency
  await new Promise(r => setTimeout(r, 1000));
  const data = await gql(token, `
    query($id: ID!) {
      webhookSubscription(id: $id) {
        id
        topic
        endpoint {
          __typename
          ... on WebhookHttpEndpoint { callbackUrl }
        }
        updatedAt
      }
    }
  `, { id: WEBHOOK_ID });

  const wh = data.webhookSubscription;
  const verifiedUri = wh.endpoint?.callbackUrl;
  console.log('  ✓ Verified state:');
  console.log('      id:        ' + wh.id);
  console.log('      topic:     ' + wh.topic);
  console.log('      uri:       ' + verifiedUri);
  console.log('      updatedAt: ' + wh.updatedAt);
  if (verifiedUri !== PROD_URI) {
    throw new Error(`Verification failed. URI is ${verifiedUri}, expected ${PROD_URI}.`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────
(async () => {
  try {
    const token = await mintToken();
    await fetchCurrent(token);
    await runUpdate(token);
    await verify(token);
    console.log('\n══════════════════════════════════════════════════');
    console.log('  SUCCESS — webhook now points at prod Worker');
    console.log('  Future Shopify orders/create events will be');
    console.log('  delivered to:');
    console.log('  ' + PROD_URI);
    console.log('══════════════════════════════════════════════════');
  } catch (e) {
    console.error('\n──────────────────────────────────────────────────');
    console.error('  FAILED: ' + e.message);
    console.error('──────────────────────────────────────────────────');
    process.exit(1);
  }
})();
