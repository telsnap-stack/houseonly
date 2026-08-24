import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../src";
import {
	pollDiscogsForSales,
	skuCandidates,
	handleSalesAudit,
	handleSalesMap,
	handleSalesRetry,
} from "../src/lib/sync";
import * as discogs from "../src/lib/discogs";
import * as shopifyAdmin from "../src/lib/shopify-admin";

// Mock only the network-touching functions; keep the pure helpers (e.g.
// parseDiscogsShippingAddress) real so the poll exercises its real logic.
vi.mock("../src/lib/discogs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/discogs")>();
	return { ...actual, getOrders: vi.fn(), getOrder: vi.fn(), getListing: vi.fn() };
});
vi.mock("../src/lib/shopify-admin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/shopify-admin")>();
	return {
		...actual,
		findVariantBySku: vi.fn(),
		createDiscogsOrder: vi.fn(),
		findOrderByDiscogsOrderId: vi.fn(),
	};
});

describe("Hello World user worker", () => {
	describe("request for /message", () => {
		it('/ responds with "Hello, World!" (unit style)', async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>(
				"http://example.com/message"
			);
			// Create an empty context to pass to `worker.fetch()`.
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
			await waitOnExecutionContext(ctx);
			expect(await response.text()).toMatchInlineSnapshot(`"Hello, World!"`);
		});

		it('responds with "Hello, World!" (integration style)', async () => {
			const request = new Request("http://example.com/message");
			const response = await SELF.fetch(request);
			expect(await response.text()).toMatchInlineSnapshot(`"Hello, World!"`);
		});
	});

	describe("request for /random", () => {
		it("/ responds with a random UUID (unit style)", async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>(
				"http://example.com/random"
			);
			// Create an empty context to pass to `worker.fetch()`.
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
			await waitOnExecutionContext(ctx);
			expect(await response.text()).toMatch(
				/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/
			);
		});

		it("responds with a random UUID (integration style)", async () => {
			const request = new Request("http://example.com/random");
			const response = await SELF.fetch(request);
			expect(await response.text()).toMatch(
				/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/
			);
		});
	});
});

// ── FASE 3H: poll window / cursor regression ────────────────────────
//
// Reproduces the 147628-C-2 incident: an order that is still pre-firm the
// first time it is polled must NOT be permanently skipped — it must be
// processed once it becomes a firm sale on a later poll. The old
// created-timestamp high-water cursor advanced past the order on sight and
// `created_after` (exclusive) then excluded it forever.
describe("pollDiscogsForSales - pending to firm order recovery", () => {
	// An order id WITH a letter segment, to also confirm ids like "147628-C-2"
	// flow through KV keys / order fetch unparsed.
	const ORDER_ID = "147628-C-2";
	const LISTING_ID = 555;

	const pendingOrder = {
		id: ORDER_ID,
		status: "New Order",
		created: "2026-07-06T05:41:58-07:00",
		items: [{ id: LISTING_ID, release: { description: "Some Record" } }],
	};
	const firmOrder = { ...pendingOrder, status: "Payment Received" };

	function ordersPage(orders: any[]) {
		return {
			pagination: { page: 1, pages: 1, per_page: 50, items: orders.length },
			orders,
		};
	}

	beforeEach(async () => {
		vi.clearAllMocks();
		for (const k of [
			"meta:last_polled_ts",
			"meta:sync_3e_mode",
			"meta:sync_go_live_ts",
			`lock:order:${ORDER_ID}`,
			`sales-detected:${ORDER_ID}`,
			`listing:${LISTING_ID}`,
		]) {
			await env.SYNC_STATE.delete(k);
		}
		// Seed the listing→SKU mapping so the item resolves.
		await env.SYNC_STATE.put(
			`listing:${LISTING_ID}`,
			JSON.stringify({ sku: "SKU1", status: "Draft" }),
		);
		vi.mocked(shopifyAdmin.findVariantBySku).mockResolvedValue({
			variantId: "gid://shopify/ProductVariant/1",
		} as any);
		vi.mocked(discogs.getOrder).mockResolvedValue({
			...firmOrder,
			shipping_address: "Jane Doe\n1 Main St\nMadrid 28001\nSpain",
			buyer: { email: "jane@example.com" },
		} as any);
	});

	it("fetches a rolling window (recent-first), not a high-water cursor", async () => {
		vi.mocked(discogs.getOrders).mockResolvedValue(ordersPage([]) as any);
		await pollDiscogsForSales(env as any);
		const call = vi.mocked(discogs.getOrders).mock.calls[0][1];
		expect(call?.sortOrder).toBe("desc");
		// createdAfter is a lookback window (~10 days ago), not a stored cursor.
		expect(new Date(call!.createdAfter!).getTime()).toBeLessThan(Date.now());
		expect(new Date(call!.createdAfter!).getTime()).toBeGreaterThan(
			Date.now() - 40 * 24 * 60 * 60 * 1000,
		);
	});

	it("never fetches orders created before the go-live cutoff", async () => {
		vi.mocked(discogs.getOrders).mockResolvedValue(ordersPage([]) as any);
		await pollDiscogsForSales(env as any);
		const call = vi.mocked(discogs.getOrders).mock.calls[0][1];
		// The window is floored at the cutoff, so it can never back-process
		// history and create duplicate facturas — regardless of the lookback.
		expect(Date.parse(call!.createdAfter!)).toBeGreaterThanOrEqual(
			Date.parse("2026-07-06T12:40:00Z"),
		);
	});

	it("honors a runtime go-live override (meta:sync_go_live_ts)", async () => {
		await env.SYNC_STATE.put("meta:sync_go_live_ts", "2030-01-01T00:00:00Z");
		vi.mocked(discogs.getOrders).mockResolvedValue(ordersPage([]) as any);
		await pollDiscogsForSales(env as any);
		const call = vi.mocked(discogs.getOrders).mock.calls[0][1];
		// Same instant as the override, but rendered in the account offset (NOT
		// UTC "Z") because Discogs reads created_after as account-local time.
		expect(Date.parse(call!.createdAfter!)).toBe(Date.parse("2030-01-01T00:00:00Z"));
		expect(call!.createdAfter).toMatch(/[+-]\d{2}:\d{2}$/);
	});

	it("derives the timezone offset from meta:last_polled_ts", async () => {
		// A Discogs-native cursor with a -05:00 offset must be echoed back, so the
		// boundary self-corrects across the account's DST instead of hardcoding.
		await env.SYNC_STATE.put("meta:last_polled_ts", "2030-01-01T00:00:00-05:00");
		await env.SYNC_STATE.put("meta:sync_go_live_ts", "2030-06-01T00:00:00Z");
		vi.mocked(discogs.getOrders).mockResolvedValue(ordersPage([]) as any);
		await pollDiscogsForSales(env as any);
		const call = vi.mocked(discogs.getOrders).mock.calls[0][1];
		expect(call!.createdAfter!.endsWith("-05:00")).toBe(true);
		expect(Date.parse(call!.createdAfter!)).toBe(Date.parse("2030-06-01T00:00:00Z"));
	});

	it("skips the order while pre-firm (no lock, no audit)", async () => {
		vi.mocked(discogs.getOrders).mockResolvedValue(
			ordersPage([pendingOrder]) as any,
		);
		const res = await pollDiscogsForSales(env as any);
		expect(res.firm_sales_found).toBe(0);
		expect(await env.SYNC_STATE.get(`lock:order:${ORDER_ID}`)).toBeNull();
		expect(await env.SYNC_STATE.get(`sales-detected:${ORDER_ID}`)).toBeNull();
	});

	it("processes the SAME order once it turns firm on a later poll", async () => {
		// Poll #1: still pre-firm → skipped, cursor must NOT lock it out.
		vi.mocked(discogs.getOrders).mockResolvedValueOnce(
			ordersPage([pendingOrder]) as any,
		);
		await pollDiscogsForSales(env as any);

		// Poll #2: now firm (dry mode) → must be processed this time.
		vi.mocked(discogs.getOrders).mockResolvedValueOnce(
			ordersPage([firmOrder]) as any,
		);
		const res = await pollDiscogsForSales(env as any);

		expect(res.firm_sales_found).toBe(1);
		const lock = await env.SYNC_STATE.get(`lock:order:${ORDER_ID}`);
		expect(lock).toBe("1");
		const auditRaw = await env.SYNC_STATE.get(`sales-detected:${ORDER_ID}`);
		expect(auditRaw).not.toBeNull();
		const audit = JSON.parse(auditRaw!);
		expect(audit.status).toBe("Payment Received");
		expect(audit.order_creation?.ok).toBe(true);
	});

	it("self-heals an unmapped listing via the Discogs external_id (SKU)", async () => {
		// No KV mapping for this listing (record listed after the last bootstrap).
		await env.SYNC_STATE.delete(`listing:${LISTING_ID}`);
		vi.mocked(discogs.getListing).mockResolvedValue({
			id: LISTING_ID,
			status: "For Sale",
			external_id: "SKU1",
		} as any);
		vi.mocked(discogs.getOrders).mockResolvedValue(
			ordersPage([firmOrder]) as any,
		);
		const res = await pollDiscogsForSales(env as any);

		expect(res.unmapped_listings).toBe(0);
		expect(res.shopify_adjustments_succeeded).toBe(1);
		// The resolved mapping is cached back so future polls skip the lookup.
		const cached = await env.SYNC_STATE.get(`listing:${LISTING_ID}`);
		expect(JSON.parse(cached!).sku).toBe("SKU1");
	});

	it("self-heals via the release catalog number when external_id is missing", async () => {
		// Listing created outside our auto-list flow: no external_id, but the
		// release catno IS the Shopify SKU (this shop's convention).
		await env.SYNC_STATE.delete(`listing:${LISTING_ID}`);
		vi.mocked(discogs.getListing).mockResolvedValue({
			id: LISTING_ID,
			status: "For Sale",
			external_id: "",
			release: { id: 1, catalog_number: "SKU1", description: "x" },
		} as any);
		vi.mocked(discogs.getOrders).mockResolvedValue(
			ordersPage([firmOrder]) as any,
		);
		const res = await pollDiscogsForSales(env as any);
		expect(res.unmapped_listings).toBe(0);
		expect(res.shopify_adjustments_succeeded).toBe(1);
		expect(JSON.parse((await env.SYNC_STATE.get(`listing:${LISTING_ID}`))!).sku).toBe("SKU1");
	});

	it("flags unmapped only when neither external_id nor catno is present", async () => {
		await env.SYNC_STATE.delete(`listing:${LISTING_ID}`);
		vi.mocked(discogs.getListing).mockResolvedValue({
			id: LISTING_ID,
			status: "For Sale",
			external_id: "",
			release: { id: 1, catalog_number: "", description: "x" },
		} as any);
		vi.mocked(discogs.getOrders).mockResolvedValue(
			ordersPage([firmOrder]) as any,
		);
		const res = await pollDiscogsForSales(env as any);
		expect(res.unmapped_listings).toBe(1);
		expect(res.shopify_adjustments_succeeded).toBe(0);
	});

	it("does not re-process (no duplicate) once locked", async () => {
		vi.mocked(discogs.getOrders).mockResolvedValue(
			ordersPage([firmOrder]) as any,
		);
		const first = await pollDiscogsForSales(env as any);
		expect(first.shopify_adjustments_attempted).toBe(1);

		const second = await pollDiscogsForSales(env as any);
		expect(second.skipped_duplicate).toBe(1);
		expect(second.shopify_adjustments_attempted).toBe(0);
	});
});

// ── FASE 3I: sales audit / repair endpoints ─────────────────────────
//
// The recurring incident these serve: a paid Discogs sale never becomes a
// Shopify order, the audit in KV already says why, but the lock:order that
// stops duplicate facturas also stops the cron from ever trying again.
describe("sales audit / repair endpoints", () => {
	const SECRET = "test-secret";
	const ORDER_ID = "147628-33";
	const LISTING_ID = 991;

	// Real KV binding + the admin secrets the handlers check.
	const adminEnv = () =>
		({ ...env, BOOTSTRAP_AUTH_SECRET: SECRET, DISCOGS_TOKEN: "tok" }) as any;

	const authed = (url: string, init: RequestInit = {}) =>
		new Request(url, {
			...init,
			headers: { authorization: `Bearer ${SECRET}`, ...(init.headers || {}) },
		});

	const firmOrder = {
		id: ORDER_ID,
		status: "Payment Received",
		created: "2026-08-24T01:50:00-07:00",
		items: [{ id: LISTING_ID, release: { description: "Some Record" } }],
	};

	/** The audit a failed (unmapped item) run leaves behind. */
	const parkedAudit = {
		order_id: ORDER_ID,
		status: "Payment Received",
		created: firmOrder.created,
		mode: "live",
		processed_at: "2026-08-24T09:15:00.000Z",
		items: [
			{
				listing_id: LISTING_ID,
				release_title: "Some Record",
				sku: null,
				outcome: "unmapped_listing",
				error: null,
			},
		],
		order_creation: {
			ok: false,
			needs_manual: true,
			error: "order has unmapped item(s); skipped to avoid partial factura",
		},
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		for (const k of [
			`lock:order:${ORDER_ID}`,
			`sales-detected:${ORDER_ID}`,
			`listing:${LISTING_ID}`,
			"sku:SKU9",
			"meta:sync_3e_mode",
		]) {
			await env.SYNC_STATE.delete(k);
		}
		vi.mocked(discogs.getOrder).mockResolvedValue({
			...firmOrder,
			shipping_address: "Jane Doe\n1 Main St\nMadrid 28001\nSpain",
			buyer: { email: "jane@example.com" },
		} as any);
		vi.mocked(shopifyAdmin.findVariantBySku).mockResolvedValue({
			variantId: "gid://shopify/ProductVariant/9",
		} as any);
		vi.mocked(shopifyAdmin.findOrderByDiscogsOrderId).mockResolvedValue(null);
		vi.mocked(shopifyAdmin.createDiscogsOrder).mockResolvedValue({
			ok: true,
			orderId: "gid://shopify/Order/1",
			orderName: "#1034",
			draftOrderId: "gid://shopify/DraftOrder/1",
		} as any);
	});

	it("requires the bearer secret", async () => {
		const res = await handleSalesAudit(
			new Request(`http://w/?action=sales-audit&order_id=${ORDER_ID}`),
			adminEnv(),
		);
		expect(res.status).toBe(401);
	});

	it("reports the audit, the lock, and that the lock blocks the cron", async () => {
		await env.SYNC_STATE.put(
			`sales-detected:${ORDER_ID}`,
			JSON.stringify(parkedAudit),
		);
		await env.SYNC_STATE.put(`lock:order:${ORDER_ID}`, "1");

		const res = await handleSalesAudit(
			authed(`http://w/?action=sales-audit&order_id=${ORDER_ID}`),
			adminEnv(),
		);
		const body: any = await res.json();

		expect(res.status).toBe(200);
		expect(body.found).toBe(true);
		expect(body.order_created).toBe(false);
		expect(body.lock.present).toBe(true);
		expect(body.lock.blocks_cron_retry).toBe(true);
		expect(body.audit.items[0].outcome).toBe("unmapped_listing");
		// The mapping the operator has to write is spelled out, with its
		// current (missing) value.
		expect(body.mappings[0].listing_kv_key).toBe(`listing:${LISTING_ID}`);
		expect(body.mappings[0].listing_kv).toBeNull();
	});

	it("lists only parked sales with parked=1", async () => {
		await env.SYNC_STATE.put(
			`sales-detected:${ORDER_ID}`,
			JSON.stringify(parkedAudit),
		);
		await env.SYNC_STATE.put(
			"sales-detected:147628-C-20",
			JSON.stringify({
				order_id: "147628-C-20",
				processed_at: "2026-08-17T07:15:00.000Z",
				items: [],
				order_creation: { ok: true, shopify_order_name: "#1033" },
			}),
		);

		const res = await handleSalesAudit(
			authed("http://w/?action=sales-audit&parked=1"),
			adminEnv(),
		);
		const body: any = await res.json();
		expect(body.audits.map((a: any) => a.order_id)).toContain(ORDER_ID);
		expect(body.audits.map((a: any) => a.order_id)).not.toContain("147628-C-20");

		await env.SYNC_STATE.delete("sales-detected:147628-C-20");
	});

	it("writes both directions of a listing↔SKU mapping", async () => {
		const res = await handleSalesMap(
			authed("http://w/?action=sales-map", {
				method: "POST",
				body: JSON.stringify({ listing_id: LISTING_ID, sku: "SKU9" }),
			}),
			adminEnv(),
		);
		expect(res.status).toBe(200);
		expect(
			JSON.parse((await env.SYNC_STATE.get(`listing:${LISTING_ID}`))!).sku,
		).toBe("SKU9");
		expect(
			JSON.parse((await env.SYNC_STATE.get("sku:SKU9"))!).listing_id,
		).toBe(LISTING_ID);
	});

	it("rejects a mapping write with a missing sku", async () => {
		const res = await handleSalesMap(
			authed("http://w/?action=sales-map", {
				method: "POST",
				body: JSON.stringify({ listing_id: LISTING_ID }),
			}),
			adminEnv(),
		);
		expect(res.status).toBe(400);
	});

	it("refuses to retry a sale our audit says already became an order", async () => {
		await env.SYNC_STATE.put(
			`sales-detected:${ORDER_ID}`,
			JSON.stringify({
				...parkedAudit,
				order_creation: { ok: true, shopify_order_name: "#1034" },
			}),
		);
		const res = await handleSalesRetry(
			authed("http://w/?action=sales-retry", {
				method: "POST",
				body: JSON.stringify({ order_id: ORDER_ID }),
			}),
			adminEnv(),
		);
		expect(res.status).toBe(409);
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
	});

	it("refuses to retry when Shopify already has the order", async () => {
		await env.SYNC_STATE.put(`lock:order:${ORDER_ID}`, "1");
		vi.mocked(shopifyAdmin.findOrderByDiscogsOrderId).mockResolvedValue({
			id: "gid://shopify/Order/2",
			name: "#1034",
			note: `Discogs order ${ORDER_ID}`,
		} as any);

		const res = await handleSalesRetry(
			authed("http://w/?action=sales-retry", {
				method: "POST",
				body: JSON.stringify({ order_id: ORDER_ID }),
			}),
			adminEnv(),
		);
		expect(res.status).toBe(409);
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
		// The lock must survive a refused retry — clearing it would let the
		// next cron run create the duplicate this refusal just prevented.
		expect(await env.SYNC_STATE.get(`lock:order:${ORDER_ID}`)).toBe("1");
	});

	it("fails closed when Shopify can't be checked", async () => {
		vi.mocked(shopifyAdmin.findOrderByDiscogsOrderId).mockRejectedValue(
			new Error("Shopify Admin API 500"),
		);
		const res = await handleSalesRetry(
			authed("http://w/?action=sales-retry", {
				method: "POST",
				body: JSON.stringify({ order_id: ORDER_ID }),
			}),
			adminEnv(),
		);
		expect(res.status).toBe(502);
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
	});

	it("refuses to retry an order that isn't a firm sale", async () => {
		vi.mocked(discogs.getOrder).mockResolvedValue({
			...firmOrder,
			status: "Payment Pending",
		} as any);
		const res = await handleSalesRetry(
			authed("http://w/?action=sales-retry", {
				method: "POST",
				body: JSON.stringify({ order_id: ORDER_ID }),
			}),
			adminEnv(),
		);
		expect(res.status).toBe(409);
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
	});

	it("clears the lock and re-runs the order once the mapping is fixed", async () => {
		await env.SYNC_STATE.put("meta:sync_3e_mode", "live");
		await env.SYNC_STATE.put(
			`sales-detected:${ORDER_ID}`,
			JSON.stringify(parkedAudit),
		);
		await env.SYNC_STATE.put(`lock:order:${ORDER_ID}`, "1");
		// The repair: the mapping the audit said was missing.
		await env.SYNC_STATE.put(
			`listing:${LISTING_ID}`,
			JSON.stringify({ sku: "SKU9", status: "For Sale" }),
		);

		const res = await handleSalesRetry(
			authed("http://w/?action=sales-retry", {
				method: "POST",
				body: JSON.stringify({ order_id: ORDER_ID }),
			}),
			adminEnv(),
		);
		const body: any = await res.json();

		expect(res.status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.audit.order_creation.shopify_order_name).toBe("#1034");
		expect(shopifyAdmin.createDiscogsOrder).toHaveBeenCalledTimes(1);
		// The lock is back, so the next cron run still can't duplicate it.
		expect(await env.SYNC_STATE.get(`lock:order:${ORDER_ID}`)).toBe("1");
		// And the audit now records the created order.
		const stored = JSON.parse(
			(await env.SYNC_STATE.get(`sales-detected:${ORDER_ID}`))!,
		);
		expect(stored.order_creation.ok).toBe(true);
	});

	it("re-refuses a second retry of a sale it just created", async () => {
		await env.SYNC_STATE.put("meta:sync_3e_mode", "live");
		await env.SYNC_STATE.put(
			`listing:${LISTING_ID}`,
			JSON.stringify({ sku: "SKU9", status: "For Sale" }),
		);

		const first = await handleSalesRetry(
			authed("http://w/?action=sales-retry", {
				method: "POST",
				body: JSON.stringify({ order_id: ORDER_ID }),
			}),
			adminEnv(),
		);
		expect(first.status).toBe(200);

		const second = await handleSalesRetry(
			authed("http://w/?action=sales-retry", {
				method: "POST",
				body: JSON.stringify({ order_id: ORDER_ID }),
			}),
			adminEnv(),
		);
		expect(second.status).toBe(409);
		expect(shopifyAdmin.createDiscogsOrder).toHaveBeenCalledTimes(1);
	});
});

// ── SKU resolution: the space that parked a 19-item order ───────────
//
// Discogs prints catalog numbers with a space ("DAT 125"); this shop's Shopify
// SKUs don't ("DAT125"). Resolving only the raw catno silently failed, and
// caching it in KV made the failure permanent.
describe("SKU candidate resolution", () => {
	const ORDER_ID = "147628-90";
	const LISTING_ID = 771;

	const firmOrder = {
		id: ORDER_ID,
		status: "Payment Received",
		created: "2026-08-24T01:50:00-07:00",
		items: [{ id: LISTING_ID, release: { description: "Some Record" } }],
	};
	const ordersPage = (orders: any[]) => ({
		pagination: { page: 1, pages: 1, per_page: 50, items: orders.length },
		orders,
	});

	/** Shopify only knows the un-spaced SKU. */
	const shopifyKnows = (known: string[]) =>
		vi.mocked(shopifyAdmin.findVariantBySku).mockImplementation(
			async (_env: any, sku: string) =>
				known.includes(sku)
					? ({ variantId: `gid://shopify/ProductVariant/${sku}` } as any)
					: null,
		);

	beforeEach(async () => {
		vi.clearAllMocks();
		for (const k of [
			`lock:order:${ORDER_ID}`,
			`sales-detected:${ORDER_ID}`,
			`listing:${LISTING_ID}`,
			"sku:DAT125",
			"sku:DAT 125",
			"meta:sync_3e_mode",
			"meta:last_polled_ts",
			"meta:sync_go_live_ts",
		]) {
			await env.SYNC_STATE.delete(k);
		}
		vi.mocked(discogs.getOrders).mockResolvedValue(ordersPage([firmOrder]) as any);
		vi.mocked(discogs.getOrder).mockResolvedValue({
			...firmOrder,
			shipping_address: "Jane Doe\n1 Main St\nMadrid 28001\nSpain",
			buyer: { email: "jane@example.com" },
		} as any);
		vi.mocked(shopifyAdmin.createDiscogsOrder).mockResolvedValue({
			ok: true,
			orderId: "gid://shopify/Order/1",
			orderName: "#1034",
		} as any);
	});

	it("offers the spaced and un-spaced form of every input", () => {
		expect(skuCandidates("DAT 125")).toEqual(["DAT 125", "DAT125"]);
		expect(skuCandidates("", "  DAT 114 ")).toEqual(["DAT 114", "DAT114"]);
		expect(skuCandidates("FR013")).toEqual(["FR013"]);
		expect(skuCandidates(null, undefined, "")).toEqual([]);
	});

	it("resolves a spaced catalog number against the un-spaced Shopify SKU", async () => {
		shopifyKnows(["DAT125"]);
		vi.mocked(discogs.getListing).mockResolvedValue({
			id: LISTING_ID,
			status: "Sold",
			external_id: "",
			release: { id: 1, catalog_number: "DAT 125", description: "x" },
		} as any);

		const res = await pollDiscogsForSales(env as any);
		expect(res.shopify_adjustments_succeeded).toBe(1);
		expect(res.variant_not_found).toBe(0);

		// The mapping cached is the one Shopify recognises, not the spaced catno.
		expect(
			JSON.parse((await env.SYNC_STATE.get(`listing:${LISTING_ID}`))!).sku,
		).toBe("DAT125");
		expect(await env.SYNC_STATE.get("sku:DAT125")).not.toBeNull();
		expect(await env.SYNC_STATE.get("sku:DAT 125")).toBeNull();
	});

	it("self-corrects a KV mapping that was poisoned with the spaced form", async () => {
		shopifyKnows(["DAT125"]);
		await env.SYNC_STATE.put(
			`listing:${LISTING_ID}`,
			JSON.stringify({ sku: "DAT 125", status: "For Sale" }),
		);

		const res = await pollDiscogsForSales(env as any);
		expect(res.shopify_adjustments_succeeded).toBe(1);
		// Fixed in place — no Discogs round-trip needed for a space.
		expect(discogs.getListing).not.toHaveBeenCalled();
		expect(
			JSON.parse((await env.SYNC_STATE.get(`listing:${LISTING_ID}`))!).sku,
		).toBe("DAT125");
	});

	it("vetoes the WHOLE order when one line has no Shopify variant", async () => {
		// Two items: one Shopify knows, one it doesn't.
		vi.mocked(discogs.getOrders).mockResolvedValue(
			ordersPage([
				{
					...firmOrder,
					items: [
						{ id: LISTING_ID, release: { description: "Known" } },
						{ id: 772, release: { description: "Missing from Shopify" } },
					],
				},
			]) as any,
		);
		shopifyKnows(["DAT125"]);
		vi.mocked(discogs.getListing).mockImplementation(async (_t: any, id: number) => ({
			id,
			status: "Sold",
			external_id: "",
			release: {
				id: 1,
				catalog_number: id === LISTING_ID ? "DAT 125" : "DAT 126",
				description: "x",
			},
		}) as any);

		const res = await pollDiscogsForSales(env as any);

		// No partial factura: 14-of-19 is the wrong document, not a fix.
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
		expect(res.variant_not_found).toBe(1);
		const audit = JSON.parse(
			(await env.SYNC_STATE.get(`sales-detected:${ORDER_ID}`))!,
		);
		expect(audit.order_creation.needs_manual).toBe(true);
		expect(audit.order_creation.unresolved).toHaveLength(1);
		expect(audit.order_creation.unresolved[0].sku_candidates).toContain("DAT126");
		// The lock stays, so the cron won't spin on it — sales-retry is the way back.
		expect(await env.SYNC_STATE.get(`lock:order:${ORDER_ID}`)).toBe("1");

		await env.SYNC_STATE.delete("listing:772");
	});
});

// ── The invoice must total what the buyer paid on Discogs ───────────
//
// Discogs 147628-33 was created at Shopify catalog prices and came to €402.81
// against the €390.81 the buyer actually paid. The line price on the factura
// has to be the Discogs price, and Discogs' shipping charge has to ride along.
describe("Discogs prices reach the Shopify order", () => {
	const ORDER_ID = "147628-91";
	const LISTING_ID = 881;

	const firmOrder = {
		id: ORDER_ID,
		status: "Payment Received",
		created: "2026-08-24T01:50:00-07:00",
		items: [
			{
				id: LISTING_ID,
				release: { description: "Some Record" },
				price: { currency: "EUR", value: 19.99 },
			},
		],
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		for (const k of [
			`lock:order:${ORDER_ID}`,
			`sales-detected:${ORDER_ID}`,
			`listing:${LISTING_ID}`,
			"meta:sync_3e_mode",
			"meta:last_polled_ts",
			"meta:sync_go_live_ts",
		]) {
			await env.SYNC_STATE.delete(k);
		}
		await env.SYNC_STATE.put("meta:sync_3e_mode", "live");
		await env.SYNC_STATE.put(
			`listing:${LISTING_ID}`,
			JSON.stringify({ sku: "SKU1", status: "Sold" }),
		);
		vi.mocked(discogs.getOrders).mockResolvedValue({
			pagination: { page: 1, pages: 1, per_page: 50, items: 1 },
			orders: [firmOrder],
		} as any);
		vi.mocked(shopifyAdmin.findVariantBySku).mockResolvedValue({
			variantId: "gid://shopify/ProductVariant/1",
		} as any);
		vi.mocked(shopifyAdmin.createDiscogsOrder).mockResolvedValue({
			ok: true,
			orderId: "gid://shopify/Order/1",
			orderName: "#1035",
		} as any);
	});

	it("passes the Discogs unit price and shipping charge through", async () => {
		vi.mocked(discogs.getOrder).mockResolvedValue({
			...firmOrder,
			shipping_address: "Jane Doe\n1 Main St\nMadrid 28001\nSpain",
			buyer: { email: "jane@example.com" },
			shipping: { currency: "EUR", method: "Standard", value: 4.5 },
		} as any);

		await pollDiscogsForSales(env as any);

		const call = vi.mocked(shopifyAdmin.createDiscogsOrder).mock.calls[0];
		expect(call[2]).toEqual([
			{
				variantId: "gid://shopify/ProductVariant/1",
				quantity: 1,
				unitPrice: 19.99,
				currency: "EUR",
			},
		]);
		expect(call[4]).toEqual({
			title: "Standard",
			amount: 4.5,
			currency: "EUR",
		});
	});

	it("omits shipping when Discogs charged none of it separately", async () => {
		vi.mocked(discogs.getOrder).mockResolvedValue({
			...firmOrder,
			shipping_address: "Jane Doe\n1 Main St\nMadrid 28001\nSpain",
			buyer: { email: "jane@example.com" },
		} as any);

		await pollDiscogsForSales(env as any);
		expect(vi.mocked(shopifyAdmin.createDiscogsOrder).mock.calls[0][4]).toBeUndefined();
	});
});
