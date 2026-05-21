#!/usr/bin/env node
/**
 * Diagnose the products/create webhook: list all webhook subscriptions with
 * their topic, uri, format, and api version. Helps spot why deliveries aren't
 * arriving (wrong uri, wrong topic, etc.).
 *
 * Required env: SHOPIFY_ADMIN_CLIENT_ID, SHOPIFY_ADMIN_CLIENT_SECRET
 */
const SHOPIFY_DOMAIN = 'house-only-2.myshopify.com';
const API_VERSION = '2026-04';
const CID = process.env.SHOPIFY_ADMIN_CLIENT_ID;
const CS = process.env.SHOPIFY_ADMIN_CLIENT_SECRET;
if (!CID || !CS) { console.error('missing creds'); process.exit(1); }

async function mintToken() {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CID, client_secret: CS });
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}
async function gql(token, query) {
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`gql ${r.status}: ${await r.text()}`);
  const d = await r.json();
  if (d.errors) throw new Error(JSON.stringify(d.errors));
  return d.data;
}

(async () => {
  const token = await mintToken();
  console.log('Token minted.\n');

  const data = await gql(token, `
    query {
      webhookSubscriptions(first: 100) {
        edges {
          node {
            id
            topic
            uri
            format
            apiVersion { handle }
            createdAt
          }
        }
      }
    }
  `);
  const subs = data.webhookSubscriptions.edges.map(e => e.node);
  console.log(`Total webhook subscriptions: ${subs.length}\n`);
  subs.forEach(s => {
    console.log(`  topic:      ${s.topic}`);
    console.log(`  uri:        ${s.uri}`);
    console.log(`  format:     ${s.format}`);
    console.log(`  apiVersion: ${s.apiVersion?.handle}`);
    console.log(`  created:    ${s.createdAt}`);
    console.log(`  id:         ${s.id}`);
    console.log('');
  });
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
