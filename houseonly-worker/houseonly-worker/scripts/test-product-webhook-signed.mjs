#!/usr/bin/env node
/**
 * Send a properly HMAC-signed fake products/create webhook to the STAGING
 * worker, bypassing Shopify delivery entirely. This isolates whether the
 * handler works (writes pending-review) from whether Shopify is delivering.
 *
 * The HMAC is computed exactly as Shopify does: HMAC-SHA256 of the raw body
 * using the app CLIENT SECRET, base64-encoded, in X-Shopify-Hmac-SHA256.
 *
 * Required env: SHOPIFY_ADMIN_CLIENT_SECRET  (the shps_ secret — same one the
 * worker validates against)
 *
 * Usage:
 *   SHOPIFY_ADMIN_CLIENT_SECRET=... node test-product-webhook-signed.mjs
 */
import { createHmac } from 'node:crypto';

const WORKER_URL = 'https://houseonly-worker-staging.emontagut.workers.dev/?action=webhook-shopify-product';
const SECRET = process.env.SHOPIFY_ADMIN_CLIENT_SECRET;
if (!SECRET) { console.error('missing SHOPIFY_ADMIN_CLIENT_SECRET'); process.exit(1); }

// Fake product payload mirroring Shopify's products/create shape
const payload = {
  id: 999999999001,
  title: 'TEST Signed Webhook ZZ',
  vendor: 'Ian Pooley',
  tags: 'source:dbh, label:Pooledmusic',
  variants: [
    { id: 111, sku: 'SIGNED-TEST-ZZ', price: '13.99', barcode: '' },
  ],
};

const rawBody = JSON.stringify(payload);
const hmac = createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('base64');

console.log('POSTing signed webhook to:', WORKER_URL);
console.log('Computed HMAC:', hmac);
console.log('SKU in payload:', payload.variants[0].sku);
console.log('');

const r = await fetch(WORKER_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Hmac-SHA256': hmac,
    'X-Shopify-Topic': 'products/create',
  },
  body: rawBody,
});

console.log('HTTP', r.status);
console.log('Response:', await r.text());
console.log('');
console.log('If 200 + queued:true, the handler accepted it.');
console.log('Then check KV: pending-review:SIGNED-TEST-ZZ');
