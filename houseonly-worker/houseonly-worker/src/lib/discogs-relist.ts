// Relist sold Discogs listings whose record is still in stock in Shopify
// (Eduardo, 2026-10-29: 53 records eBay held as discogs_no_disponible).
// A sold listing can't go back to For Sale: each SKU gets a NEW listing (one
// copy) with the old one's release, grades and price, and sku:/listing: point
// at it. Driven from KV and run by the eBay cron, a few SKUs a run:
// - meta:discogs_relist_queue  ["SKU", …] still to do
// - meta:discogs_relist_mode   'live' creates; anything else only reads and logs the plan
// - meta:discogs_relist_log    { SKU: { at, mode, result, … } }
// Shopify stock is checked right before creating: no stock, no listing.

import { getListing, createListing, type DiscogsListingInput, type DiscogsCondition, type DiscogsSleeveCondition } from './discogs';
import { fetchSourceProduct } from './ebay';

export const RELIST_QUEUE_KEY = 'meta:discogs_relist_queue';
export const RELIST_MODE_KEY = 'meta:discogs_relist_mode';
export const RELIST_LOG_KEY = 'meta:discogs_relist_log';
const PER_RUN = 8;

async function readJson<T>(env: any, key: string, fallback: T): Promise<T> {
  try { return JSON.parse((await env.SYNC_STATE.get(key)) || 'null') ?? fallback; } catch { return fallback; }
}

export async function runDiscogsRelist(env: any): Promise<{ mode: string; done: number; left: number; stopped?: string } | null> {
  if (!env.DISCOGS_TOKEN) return null;
  let queue = await readJson<string[]>(env, RELIST_QUEUE_KEY, []);
  if (!queue.length) return null;
  const mode = (await env.SYNC_STATE.get(RELIST_MODE_KEY)) === 'live' ? 'live' : 'dry';
  const log = await readJson<Record<string, any>>(env, RELIST_LOG_KEY, {});
  // Dry leaves the queue as it is, so each SKU is planned once per mode.
  const todo = queue.filter(s => log[s]?.mode !== mode).slice(0, PER_RUN);
  const finished: string[] = [];
  let stopped: string | undefined;
  for (const sku of todo) {
    const at = new Date().toISOString();
    try {
      const m = await readJson<any>(env, `sku:${sku}`, null);
      if (!m?.listing_id) { log[sku] = { at, mode, result: 'no_mapping' }; finished.push(sku); continue; }
      const old = await getListing(env.DISCOGS_TOKEN, m.listing_id);
      if (old.status !== 'Sold') { log[sku] = { at, mode, result: 'not_sold', listing_id: old.id, status: old.status }; finished.push(sku); continue; }
      const p = await fetchSourceProduct(env, sku);
      const stock = p?.variant.inventoryQuantity ?? 0;
      if (!p || p.status !== 'ACTIVE' || stock <= 0) {
        log[sku] = { at, mode, result: 'no_shopify_stock', status: p?.status || null, stock };
        finished.push(sku); continue;
      }
      const input: DiscogsListingInput = {
        release_id: old.release.id,
        condition: old.condition as DiscogsCondition,
        sleeve_condition: old.sleeve_condition as DiscogsSleeveCondition | undefined,
        price: old.price.value,
        status: 'For Sale',
        external_id: sku,
        location: sku,
      };
      if (mode !== 'live') { log[sku] = { at, mode, result: 'would_create', from: old.id, stock, input }; continue; }
      const id = await createListing(env.DISCOGS_TOKEN, input);
      await env.SYNC_STATE.put(`sku:${sku}`, JSON.stringify({ listing_id: id, status: 'For Sale', synced_at: at }));
      await env.SYNC_STATE.put(`listing:${id}`, JSON.stringify({ sku, status: 'For Sale' }));
      log[sku] = { at, mode, result: 'created', listing_id: id, from: old.id, price: input.price };
      finished.push(sku);
    } catch (e: any) {
      const msg = e?.message || String(e);
      // Discogs counts per IP: stop at the first 429, the next run goes on.
      if (/\b429\b/.test(msg)) { stopped = 'discogs_429'; break; }
      log[sku] = { at, mode, result: 'error', error: msg.slice(0, 200) };
      finished.push(sku);
    }
  }
  await env.SYNC_STATE.put(RELIST_LOG_KEY, JSON.stringify(log));
  if (mode === 'live' && finished.length) {
    queue = queue.filter(s => !finished.includes(s));
    await env.SYNC_STATE.put(RELIST_QUEUE_KEY, JSON.stringify(queue));
  }
  const left = mode === 'live' ? queue.length : queue.filter(s => log[s]?.mode !== mode).length;
  return { mode, done: todo.length, left, ...(stopped ? { stopped } : {}) };
}
