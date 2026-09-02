import {
	env,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { pollDiscogsForSales } from "../src/lib/sync";
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
	return { ...actual, findVariantBySku: vi.fn(), createDiscogsOrder: vi.fn() };
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
		// Dry mode creates nothing, so it takes only the short in-flight claim —
		// it must NOT lock the order out of the eventual live run.
		const lock = await env.SYNC_STATE.get(`lock:order:${ORDER_ID}`);
		expect(lock).toBe("in-flight");
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

	// ── 147628-C-22 regression: transient failure must not pin the order ──
	//
	// A Discogs 429 on getOrder made order creation fail AFTER the durable
	// 60-day lock had already been taken, so every later poll counted the sale
	// as `skipped_duplicate`. The order never reached Shopify and nothing
	// alerted — the sale was silently lost. The lock is now taken in two
	// stages: a short in-flight claim while resolving, promoted to the durable
	// lock only immediately before an order can be created.
	describe("lock staging (transient failure recovery)", () => {
		/** Seconds until the order lock expires, read off the KV listing. */
		async function lockTtlSeconds() {
			const { keys } = await env.SYNC_STATE.list({
				prefix: `lock:order:${ORDER_ID}`,
			});
			expect(keys).toHaveLength(1);
			return keys[0].expiration! - Math.floor(Date.now() / 1000);
		}

		beforeEach(async () => {
			await env.SYNC_STATE.put("meta:sync_3e_mode", "live");
			vi.mocked(shopifyAdmin.createDiscogsOrder).mockResolvedValue({
				ok: true,
				orderId: "gid://shopify/Order/1",
				orderName: "#1001",
			} as any);
			vi.mocked(discogs.getOrders).mockResolvedValue(
				ordersPage([firmOrder]) as any,
			);
		});

		it("keeps the lock SHORT-lived when getOrder fails (429)", async () => {
			vi.mocked(discogs.getOrder).mockRejectedValue(
				new Error('Discogs getOrder failed: 429 {"message":"You are making requests too quickly."}'),
			);
			const res = await pollDiscogsForSales(env as any);

			expect(res.shopify_adjustments_failed).toBe(1);
			expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
			// The bug: this used to be the 60-day durable TTL.
			expect(await env.SYNC_STATE.get(`lock:order:${ORDER_ID}`)).toBe("in-flight");
			expect(await lockTtlSeconds()).toBeLessThanOrEqual(10 * 60);
			// And the audit says so, rather than looking like a dead end.
			const audit = JSON.parse((await env.SYNC_STATE.get(`sales-detected:${ORDER_ID}`))!);
			expect(audit.order_creation.will_retry).toBe(true);
		});

		it("recovers the sale on the next poll after a 429", async () => {
			vi.mocked(discogs.getOrder).mockRejectedValueOnce(new Error("429"));
			await pollDiscogsForSales(env as any);
			expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();

			// The in-flight claim expires before the next cron (10 min < 15 min).
			await env.SYNC_STATE.delete(`lock:order:${ORDER_ID}`);

			const res = await pollDiscogsForSales(env as any);
			// Either route may claim it — the parked pass now runs first and
			// usually wins — but the sale must be created exactly ONCE.
			expect(res.parked_recovered + res.shopify_adjustments_succeeded).toBe(1);
			expect(shopifyAdmin.createDiscogsOrder).toHaveBeenCalledTimes(1);
			const audit = JSON.parse((await env.SYNC_STATE.get(`sales-detected:${ORDER_ID}`))!);
			expect(audit.order_creation.ok).toBe(true);
		});

		it("promotes to the durable lock once an order is created", async () => {
			const res = await pollDiscogsForSales(env as any);
			expect(res.shopify_adjustments_succeeded).toBe(1);
			expect(await env.SYNC_STATE.get(`lock:order:${ORDER_ID}`)).toBe("1");
			// Must outlive the 10-day fetch window, or the next poll inside the
			// window creates a second paid order — a duplicate factura.
			expect(await lockTtlSeconds()).toBeGreaterThan(10 * 24 * 60 * 60);
		});

		it("holds the durable lock even when order creation fails", async () => {
			// createDiscogsOrder may have completed the draft before the error
			// surfaced, so the order can be real. Never retry past this point.
			vi.mocked(shopifyAdmin.createDiscogsOrder).mockResolvedValue({
				ok: false,
				error: "draftOrderComplete userErrors",
			} as any);
			await pollDiscogsForSales(env as any);
			expect(await env.SYNC_STATE.get(`lock:order:${ORDER_ID}`)).toBe("1");
			expect(await lockTtlSeconds()).toBeGreaterThan(10 * 24 * 60 * 60);
		});

		it("a dry-mode rehearsal does not lock the order out of the live run", async () => {
			await env.SYNC_STATE.put("meta:sync_3e_mode", "dry");
			await pollDiscogsForSales(env as any);
			expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
			expect(await lockTtlSeconds()).toBeLessThanOrEqual(10 * 60);

			await env.SYNC_STATE.delete(`lock:order:${ORDER_ID}`);
			await env.SYNC_STATE.put("meta:sync_3e_mode", "live");
			const res = await pollDiscogsForSales(env as any);
			expect(res.shopify_adjustments_succeeded).toBe(1);
			expect(shopifyAdmin.createDiscogsOrder).toHaveBeenCalledTimes(1);
		});
	});

	// #1037 was invoiced at $36.00 USD (= EUR 31.06) when the buyer had paid
	// EUR 34.99 and the variant lists at EUR 29.99. A shippingAddress makes
	// Shopify pick a Market and price the draft in ITS currency, so the invoice
	// must carry the Discogs figure explicitly.
	describe("invoices the price Discogs charged", () => {
		const pricedOrder = {
			...firmOrder,
			items: [{
				id: LISTING_ID,
				release: { description: "Some Record" },
				price: { currency: "EUR", value: 34.99 },
			}],
		};

		beforeEach(async () => {
			await env.SYNC_STATE.put("meta:sync_3e_mode", "live");
			vi.mocked(shopifyAdmin.createDiscogsOrder).mockResolvedValue({
				ok: true, orderId: "gid://shopify/Order/9", orderName: "#1038",
			} as any);
		});

		it("passes the Discogs price and currency on the line", async () => {
			vi.mocked(discogs.getOrders).mockResolvedValue(ordersPage([pricedOrder]) as any);
			await pollDiscogsForSales(env as any);

			const lines = vi.mocked(shopifyAdmin.createDiscogsOrder).mock.calls[0][2];
			expect(lines[0].price).toEqual({ amount: "34.99", currencyCode: "EUR" });
		});

		it("keeps the price through a parked retry", async () => {
			// First pass resolves the line but cannot finish the sale.
			vi.mocked(discogs.getOrders).mockResolvedValue(ordersPage([pricedOrder]) as any);
			vi.mocked(discogs.getOrder).mockRejectedValueOnce(new Error("429"));
			await pollDiscogsForSales(env as any);
			expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();

			await env.SYNC_STATE.delete(`lock:order:${ORDER_ID}`);
			vi.mocked(discogs.getOrders).mockRejectedValue(new Error("429"));
			await pollDiscogsForSales(env as any);

			// Recovered off the stored audit — the price must survive the trip.
			const lines = vi.mocked(shopifyAdmin.createDiscogsOrder).mock.calls[0][2];
			expect(lines[0].price).toEqual({ amount: "34.99", currencyCode: "EUR" });
		});

		it("falls back to the catalog price when Discogs sent none", async () => {
			vi.mocked(discogs.getOrders).mockResolvedValue(ordersPage([firmOrder]) as any);
			await pollDiscogsForSales(env as any);
			const lines = vi.mocked(shopifyAdmin.createDiscogsOrder).mock.calls[0][2];
			expect(lines[0].price).toBeUndefined();
		});
	});

	// A parked sale must not be starved by the order LIST being refused. On
	// 2026-09-02 every run died on getOrders while 147628-C-22 sat one call from
	// done, its variants already resolved.
	describe("parked sale retry (independent of the window scan)", () => {
		beforeEach(async () => {
			await env.SYNC_STATE.put("meta:sync_3e_mode", "live");
			await env.SYNC_STATE.put(`sales-detected:${ORDER_ID}`, JSON.stringify({
				order_id: ORDER_ID,
				status: "Payment Received",
				created: firmOrder.created,
				first_detected_at: new Date().toISOString(),
				attempts: 1,
				items: [{
					listing_id: LISTING_ID,
					sku: "SKU1",
					shopify_variant_id: "gid://shopify/ProductVariant/1",
					quantity: 1,
					outcome: "resolved",
				}],
				order_creation: { ok: false, will_retry: true, error: "getOrder failed: 429" },
			}));
			vi.mocked(shopifyAdmin.createDiscogsOrder).mockResolvedValue({
				ok: true, orderId: "gid://shopify/Order/9", orderName: "#1037",
			} as any);
		});

		it("recovers the sale even when getOrders is refused", async () => {
			vi.mocked(discogs.getOrders).mockRejectedValue(new Error("429 too quickly"));
			const res = await pollDiscogsForSales(env as any);

			expect(res.ok).toBe(false);            // the scan still failed...
			expect(res.parked_recovered).toBe(1);  // ...but the sale went through
			expect(shopifyAdmin.createDiscogsOrder).toHaveBeenCalledTimes(1);
			const audit = JSON.parse((await env.SYNC_STATE.get(`sales-detected:${ORDER_ID}`))!);
			expect(audit.order_creation.ok).toBe(true);
			expect(audit.order_creation.recovered_by).toBe("parked-retry");
			expect(await env.SYNC_STATE.get(`lock:order:${ORDER_ID}`)).toBe("1");
		});

		it("uses the stored variants — no Shopify or listing lookups", async () => {
			vi.mocked(discogs.getOrders).mockRejectedValue(new Error("429"));
			await pollDiscogsForSales(env as any);
			expect(shopifyAdmin.findVariantBySku).not.toHaveBeenCalled();
			expect(discogs.getListing).not.toHaveBeenCalled();
		});

		it("leaves it parked when getOrder is still refused", async () => {
			vi.mocked(discogs.getOrders).mockRejectedValue(new Error("429"));
			vi.mocked(discogs.getOrder).mockRejectedValue(new Error("429 too quickly"));
			const res = await pollDiscogsForSales(env as any);

			expect(res.parked_recovered).toBe(0);
			expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
			// Retryable, and NOT holding the durable lock.
			expect(await env.SYNC_STATE.get(`lock:order:${ORDER_ID}`)).toBe("in-flight");
			const audit = JSON.parse((await env.SYNC_STATE.get(`sales-detected:${ORDER_ID}`))!);
			expect(audit.order_creation.will_retry).toBe(true);
			expect(audit.attempts).toBe(2);
		});

		it("never touches a sale that already became a Shopify order", async () => {
			await env.SYNC_STATE.put(`sales-detected:${ORDER_ID}`, JSON.stringify({
				order_id: ORDER_ID,
				items: [{ shopify_variant_id: "gid://shopify/ProductVariant/1" }],
				order_creation: { ok: true, shopify_order_name: "#1000" },
			}));
			vi.mocked(discogs.getOrders).mockRejectedValue(new Error("429"));
			const res = await pollDiscogsForSales(env as any);
			expect(res.parked_retried).toBe(0);
			expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
		});
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
