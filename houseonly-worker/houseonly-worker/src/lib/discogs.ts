// ── DISCOGS API CLIENT ───────────────────────────────────────────────
//
// Wraps the Discogs API v2.0 with the auth and rate-limit handling we need
// for Fase 3 (sync) and Fase 3.5 (auto-listing).
//
// Auth: Personal Access Token, passed as header `Authorization: Discogs token=XXX`.
// Token is read from env.DISCOGS_TOKEN (wrangler secret).
//
// Rate limit: 60 req/min authenticated. We don't enforce this client-side
// because the Worker's natural concurrency is low (one webhook at a time,
// one cron every 5 min). On 429 we sleep 60s and retry once.
//
// User-Agent: per Discogs ToS, must identify the application.

const DISCOGS_BASE = 'https://api.discogs.com';
const USER_AGENT = 'HouseOnlyWorker/1.0 +https://houseonly.store';

// ── TYPES ───────────────────────────────────────────────────────────

export type DiscogsCondition =
  | 'Mint (M)'
  | 'Near Mint (NM or M-)'
  | 'Very Good Plus (VG+)'
  | 'Very Good (VG)'
  | 'Good Plus (G+)'
  | 'Good (G)'
  | 'Fair (F)'
  | 'Poor (P)';

export type DiscogsSleeveCondition =
  | DiscogsCondition
  | 'Generic'
  | 'Not Graded'
  | 'No Cover';

export type DiscogsListingStatus = 'For Sale' | 'Draft';

export interface DiscogsListingInput {
  release_id: number;
  condition: DiscogsCondition;
  sleeve_condition?: DiscogsSleeveCondition;
  price: number;
  comments?: string;
  allow_offers?: boolean;
  status?: DiscogsListingStatus;
  external_id?: string;
  location?: string;
  weight?: number;
  format_quantity?: number;
}

export interface DiscogsListing {
  id: number;
  status: DiscogsListingStatus;
  price: { currency: string; value: number };
  release: {
    id: number;
    catalog_number: string;
    description: string;
  };
  external_id?: string;
  location?: string;
  uri: string;
}

export interface DiscogsOrderItem {
  id: number;
  release: {
    id: number;
    description: string;
  };
  price: { currency: string; value: number };
  // Note: external_id and location come back as part of the listing, not the
  // order item. We need to fetch the listing separately to get the SKU.
}

export interface DiscogsOrder {
  id: string;  // format: "1234567-1"
  status: string;  // "New Order", "Buyer contacted", "Payment Received", etc.
  created: string;  // ISO 8601
  items: DiscogsOrderItem[];
}

export interface DiscogsApiError {
  message: string;
  status?: number;
}

// ── INTERNAL FETCH HELPER ───────────────────────────────────────────

async function discogsFetch(
  token: string,
  path: string,
  init?: RequestInit & { _retry?: boolean },
): Promise<Response> {
  const url = path.startsWith('http') ? path : `${DISCOGS_BASE}${path}`;
  const headers: Record<string, string> = {
    'Authorization': `Discogs token=${token}`,
    'User-Agent': USER_AGENT,
    'Accept': 'application/json',
    ...((init?.headers as Record<string, string>) || {}),
  };

  const r = await fetch(url, { ...init, headers });

  // Rate limited: wait and retry once
  if (r.status === 429 && !init?._retry) {
    const retryAfter = parseInt(r.headers.get('retry-after') || '60', 10);
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    return discogsFetch(token, path, { ...init, _retry: true });
  }

  return r;
}

// ── INVENTORY (used for bootstrap mapping) ──────────────────────────

export interface InventoryPage {
  pagination: {
    page: number;
    pages: number;
    per_page: number;
    items: number;
  };
  listings: DiscogsListing[];
}

/**
 * Fetch one page of the authenticated user's inventory.
 * Used by Fase 3C bootstrap to build the SKU → listing_id mapping in KV.
 *
 * @param token Discogs personal access token
 * @param username Discogs username (e.g. "houseonly")
 * @param page 1-indexed page number
 * @param status Optional filter: only listings with this status
 */
export async function getInventory(
  token: string,
  username: string,
  page = 1,
  status?: DiscogsListingStatus,
): Promise<InventoryPage> {
  const params = new URLSearchParams({
    page: String(page),
    per_page: '100',
  });
  if (status) params.set('status', status);

  const r = await discogsFetch(
    token,
    `/users/${encodeURIComponent(username)}/inventory?${params}`,
  );

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Discogs getInventory failed: ${r.status} ${text.slice(0, 200)}`);
  }

  return await r.json() as InventoryPage;
}

// ── LISTING MANAGEMENT ──────────────────────────────────────────────

/**
 * Update a listing's status (e.g. mark For Sale → Draft when sold on Shopify).
 * Per Discogs API: POST /marketplace/listings/{listing_id} with the changed fields.
 *
 * @param token Discogs personal access token
 * @param listingId Numeric listing ID
 * @param status New status
 */
export async function updateListingStatus(
  token: string,
  listingId: number,
  status: DiscogsListingStatus,
): Promise<void> {
  const r = await discogsFetch(
    token,
    `/marketplace/listings/${listingId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    },
  );

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Discogs updateListingStatus failed: ${r.status} ${text.slice(0, 200)}`);
  }
}

/**
 * Create a new marketplace listing.
 * Used by Fase 3.5 auto-listing flow when a new product is imported into Shopify.
 *
 * Discogs returns 201 with the new listing's resource_url; we parse the ID from there.
 *
 * @param token Discogs personal access token
 * @param input Listing fields
 * @returns The new listing's numeric ID
 */
export async function createListing(
  token: string,
  input: DiscogsListingInput,
): Promise<number> {
  const r = await discogsFetch(
    token,
    `/marketplace/listings`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Discogs createListing failed: ${r.status} ${text.slice(0, 200)}`);
  }

  const data: any = await r.json();
  const resourceUrl: string = data?.resource_url || '';
  const match = resourceUrl.match(/\/listings\/(\d+)/);
  if (!match) {
    throw new Error(`Discogs createListing: no listing ID in response: ${resourceUrl}`);
  }
  return parseInt(match[1], 10);
}

/**
 * Permanently delete a listing.
 * Generally we prefer to mark Draft instead, but Fase 3.5 may need this
 * for rejected pendings.
 */
export async function deleteListing(
  token: string,
  listingId: number,
): Promise<void> {
  const r = await discogsFetch(
    token,
    `/marketplace/listings/${listingId}`,
    { method: 'DELETE' },
  );

  if (!r.ok && r.status !== 404) {
    const text = await r.text();
    throw new Error(`Discogs deleteListing failed: ${r.status} ${text.slice(0, 200)}`);
  }
}

// ── ORDERS (polling for Fase 3E) ────────────────────────────────────

export interface OrdersPage {
  pagination: {
    page: number;
    pages: number;
    per_page: number;
    items: number;
  };
  orders: DiscogsOrder[];
}

/**
 * Fetch orders, paginated and filterable by status and creation timestamp.
 * Used by Fase 3E scheduled handler to detect new sales.
 *
 * @param token Discogs personal access token
 * @param opts Filter options
 */
export async function getOrders(
  token: string,
  opts: {
    status?: string;  // e.g. "New Order"
    createdAfter?: string;  // ISO 8601
    sort?: 'id' | 'created' | 'modified';
    sortOrder?: 'asc' | 'desc';
    page?: number;
  } = {},
): Promise<OrdersPage> {
  const params = new URLSearchParams({
    page: String(opts.page || 1),
    per_page: '50',
    sort: opts.sort || 'created',
    sort_order: opts.sortOrder || 'asc',
  });
  if (opts.status) params.set('status', opts.status);
  if (opts.createdAfter) params.set('created_after', opts.createdAfter);

  const r = await discogsFetch(
    token,
    `/marketplace/orders?${params}`,
  );

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Discogs getOrders failed: ${r.status} ${text.slice(0, 200)}`);
  }

  return await r.json() as OrdersPage;
}

/**
 * Fetch one order's full details, including line items with release info.
 * The items in /marketplace/orders are summarised; this endpoint returns more.
 */
export async function getOrder(
  token: string,
  orderId: string,
): Promise<DiscogsOrder> {
  const r = await discogsFetch(
    token,
    `/marketplace/orders/${encodeURIComponent(orderId)}`,
  );

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Discogs getOrder failed: ${r.status} ${text.slice(0, 200)}`);
  }

  return await r.json() as DiscogsOrder;
}

/**
 * Get one listing's full details. Useful when an order item only gives us
 * the listing ID and we need external_id (SKU) for Shopify sync.
 */
export async function getListing(
  token: string,
  listingId: number,
): Promise<DiscogsListing> {
  const r = await discogsFetch(
    token,
    `/marketplace/listings/${listingId}`,
  );

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Discogs getListing failed: ${r.status} ${text.slice(0, 200)}`);
  }

  return await r.json() as DiscogsListing;
}
