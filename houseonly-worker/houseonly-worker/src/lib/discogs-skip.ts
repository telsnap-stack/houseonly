/**
 * Discogs sales the poll must leave alone (2026-10-19).
 *
 * Two kinds, both decided BEFORE any variant lookup:
 *
 *   in Shopify — a non-cancelled Shopify order already carries the custom
 *                attribute discogs_order_id=<this order>. Eduardo built it by
 *                hand (147628-65 → #1067) or an earlier run did. Creating
 *                another would be a duplicate factura.
 *   manual     — KV key manual:<order_id> exists. Eduardo handled the sale
 *                outside Shopify (147628-C-49, shipped from Discogs with
 *                Shopify stock 0). No order, no retries, no alerts.
 *
 * What must NOT hide a pending sale:
 *   - Match is the attribute value, exact. "147628-65" never covers
 *     "147628-C-65" or "147628-6"; a note mentioning the id counts for nothing,
 *     nor does an order without the attribute (#1066, cancelled duplicate).
 *   - A Shopify order with FEWER units than the Discogs order is not "synced":
 *     that is the 147628-C-30 shape (a one-line #1048 for a two-record sale).
 *     It stays pending and needs a human.
 *   - If Shopify cannot be read in full, absence proves nothing. The caller
 *     neither skips nor creates; the next poll retries.
 *
 * No runtime imports on purpose: GraphQL arrives as a function, so the prod
 * dry run (scripts) can load this file as-is and decide with the same code.
 */

export interface ShopifyDiscogsOrder {
  id: string;
  name: string;
  discogsOrderId: string;
  /** Units still on the order (removed/refunded lines excluded). */
  units: number;
}

export type ShopifyDiscogsIndex = Map<string, ShopifyDiscogsOrder>;

export type Gql = (query: string, variables?: any) => Promise<any>;

/** Longer than the 30-day sales-detected TTL, so parked sales are covered too. */
export const SHOPIFY_INDEX_LOOKBACK_DAYS = 35;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
export const DISCOGS_ORDER_ATTRIBUTE = 'discogs_order_id';

const ORDERS_QUERY = `
  query discogsOrdersInShopify($q: String!, $after: String) {
    orders(first: ${PAGE_SIZE}, query: $q, after: $after, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        cancelledAt
        currentSubtotalLineItemsQuantity
        customAttributes { key value }
      }
    }
  }
`;

/**
 * discogs_order_id → non-cancelled Shopify order, for orders created since
 * `sinceIso`. Throws when the list cannot be read COMPLETELY (API error or the
 * page cap hit): an incomplete index would turn "not found" into a lie.
 */
export async function loadShopifyDiscogsIndex(gql: Gql, sinceIso: string): Promise<ShopifyDiscogsIndex> {
  const index: ShopifyDiscogsIndex = new Map();
  const q = `created_at:>='${sinceIso}'`;
  let after: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await gql(ORDERS_QUERY, { q, after });
    const conn = r?.data?.orders;
    if (r?.errors?.length || !conn) {
      throw new Error(`Shopify orders query failed: ${JSON.stringify(r?.errors || r || 'empty').slice(0, 200)}`);
    }
    for (const o of conn.nodes || []) {
      if (o.cancelledAt) continue;
      const attr = (o.customAttributes || []).find((a: any) => a?.key === DISCOGS_ORDER_ATTRIBUTE);
      const discogsOrderId = String(attr?.value || '').trim();
      if (!discogsOrderId) continue;
      const units = Number(o.currentSubtotalLineItemsQuantity) || 0;
      // Two live orders for one sale (a replacement whose original was never
      // cancelled): keep the fuller one; the duplicate is a human problem.
      const prev = index.get(discogsOrderId);
      if (!prev || units > prev.units) index.set(discogsOrderId, { id: o.id, name: o.name, discogsOrderId, units });
    }
    if (!conn.pageInfo?.hasNextPage) return index;
    after = conn.pageInfo.endCursor;
  }
  throw new Error(`Shopify orders query truncated at ${MAX_PAGES * PAGE_SIZE} orders`);
}

export type SkipDecision =
  | { kind: 'manual'; note: string }
  | { kind: 'in-shopify'; order: ShopifyDiscogsOrder }
  | { kind: 'partial-in-shopify'; order: ShopifyDiscogsOrder; needed: number }
  | { kind: 'process' };

/**
 * @param manualNote value of manual:<orderId>, null when absent
 * @param discogsUnits records on the Discogs order (marketplace items are qty 1)
 */
export function decideSkip(
  orderId: string,
  discogsUnits: number,
  manualNote: string | null,
  index: ShopifyDiscogsIndex,
): SkipDecision {
  if (manualNote !== null) return { kind: 'manual', note: manualNote };
  const order = index.get(orderId.trim());
  if (!order) return { kind: 'process' };
  if (order.units < discogsUnits) return { kind: 'partial-in-shopify', order, needed: discogsUnits };
  return { kind: 'in-shopify', order };
}
