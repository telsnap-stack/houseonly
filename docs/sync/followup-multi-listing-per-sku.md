# Follow-up: several Discogs listings per SKU

**Status:** pending. Recorded on 2026-09-22 after the relink (`scripts/relink-discogs.mjs`).

## Problem

KV models the link as 1:1: `sku:{SKU}` → **one** `listing_id`, and `listing:{id}` → SKU.
But when there are several copies, each copy gets its own Discogs listing. On 22-09 there were 7 SKUs with two live listings (ATJ012, COOP007, RMCE021, RMCE028, RXT-08, SOULR055, VP014), and DES133 had two live listings against 1 copy in Shopify.

Consequences:

- A **web-shop sale** only takes down the linked listing (`handleShopifyOrderWebhook` → `delistOnDiscogs`). If Shopify stock drops to 0, the other listing stays for sale with no record behind it, so it is an oversell waiting to happen (like 147628-C-31).
- The relink reports the second listing as `conflict` and does not link it. By design, it never re-points a SKU.
- A **Discogs sale** of the unlinked listing still resolves (via `listing:{id}` or catno), but only if `listing:{id}` exists.

## Proposal

1. **Model:** `sku:{SKU}` holds a list, `{ listings: [{ listing_id, status, synced_at }] }`. Read the old `{ listing_id }` format as a one-item list, so no migration is needed. `listing:{id}` doesn't change.
2. **Web sale, and later any stock change:** after the Shopify order, read the SKU's **current** stock and take down live listings until `live listings ≤ Shopify stock`. Shopify is the source of truth, and Shopify stock is never written.
   - If there are 2 live listings and 1 left in stock, take down 1.
   - If there are 2 live listings and 0 in stock, take both down.
   - Which one to take down: the most recently created. The oldest keeps its history on Discogs.
3. **Relink:** add a listing that belongs to a SKU already linked instead of reporting `conflict`, but only if both listings are the same record (same catno/external_id). Also report `live listings > Shopify stock` as a risk.
4. **Retries:** the Discogs takedowns go on a queue that the cron retries (fix 6 of the original plan), not in `waitUntil`, which gets cancelled during 429s.
5. **Dead links:** relink detects `sku:` pointing at a listing that no longer exists or is Draft while another listing for the same record is live, and proposes re-pointing it. That covers VFS089 / VFS089Y / DEFCL001LP / DES133 / FR315R from 22-09.

## Tests to write

- Web sale with 2 live listings and stock 2 → 1 is taken down.
- Web sale with 2 live listings and stock 1 → both are taken down.
- Old `sku:` format still works.
- A 429 during the takedown gets retried from the queue, and each listing is taken down at most once.
- A dead link is proposed for re-pointing, never re-pointed automatically.

## Out of scope

- Automatically deciding which record a listing is when titles differ (see `manual-check-2026-09-22.md` §1). That stays manual.
