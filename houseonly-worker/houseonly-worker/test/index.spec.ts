import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../src";
import { pollDiscogsForSales } from "../src/lib/sync";
import * as discogs from "../src/lib/discogs";
import * as shopifyAdmin from "../src/lib/shopify-admin";

// Mock only the network-touching functions; keep the pure helpers (e.g.
// parseDiscogsShippingAddress) real so the poll exercises its real logic.
vi.mock("../src/lib/discogs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/discogs")>();
	return { ...actual, getOrders: vi.fn(), getOrder: vi.fn() };
});
vi.mock("../src/lib/shopify-admin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/shopify-admin")>();
	return { ...actual, findVariantBySku: vi.fn(), createDiscogsOrder: vi.fn() };
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
		expect(call!.createdAfter).toBe("2030-01-01T00:00:00.000Z");
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
