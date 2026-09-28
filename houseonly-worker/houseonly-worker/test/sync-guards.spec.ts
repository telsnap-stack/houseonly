import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pollDiscogsForSales, handleSyncRelink } from "../src/lib/sync";
import { sendSyncAlerts, STUCK_AFTER_MS } from "../src/lib/sync-alerts";
import * as discogs from "../src/lib/discogs";
import * as shopifyAdmin from "../src/lib/shopify-admin";

vi.mock("../src/lib/discogs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/discogs")>();
	return { ...actual, getOrders: vi.fn(), getOrder: vi.fn(), getListing: vi.fn(), getInventory: vi.fn() };
});
vi.mock("../src/lib/shopify-admin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/shopify-admin")>();
	return {
		...actual, findVariantBySkuLoose: vi.fn(), createDiscogsOrder: vi.fn(), getVariantsStock: vi.fn(),
		searchVariantsBySkus: vi.fn(), shopifyAdminGraphQL: vi.fn(),
	};
});

const ORDER_ID = "147628-C-31";
const LISTING_ID = 4190680911;
const VARIANT = "gid://shopify/ProductVariant/58103778607488";
const firmOrder = {
	id: ORDER_ID, status: "Payment Received", created: "2026-09-21T23:43:56-07:00",
	items: [{ id: LISTING_ID, release: { description: "Dilby & Pornbugs - Between Us" } }],
};
const page = (orders: any[]) => ({ pagination: { page: 1, pages: 1, per_page: 50, items: orders.length }, orders });
const audit = async () => JSON.parse((await env.SYNC_STATE.get(`sales-detected:${ORDER_ID}`))!);
const stock = (n: number | null) => vi.mocked(shopifyAdmin.getVariantsStock)
	.mockImplementation(async (_e, ids) => new Map(ids.map((id) => [id, n])));

async function wipe() {
	for (const prefix of ["sales-detected:", "lock:", "listing:", "sku:", "alerted:", "meta:"]) {
		const { keys } = await env.SYNC_STATE.list({ prefix });
		for (const k of keys) await env.SYNC_STATE.delete(k.name);
	}
}

beforeEach(async () => {
	vi.clearAllMocks();
	await wipe();
	await env.SYNC_STATE.put("meta:sync_3e_mode", "live");
	await env.SYNC_STATE.put(`listing:${LISTING_ID}`, JSON.stringify({ sku: "BOND12081C", status: "For Sale" }));
	vi.mocked(shopifyAdmin.findVariantBySkuLoose).mockResolvedValue({ variantId: VARIANT, sku: "BOND12081C" } as any);
	vi.mocked(discogs.getOrder).mockResolvedValue({
		...firmOrder, shipping_address: "Jane Doe\n1 Main St\nMadrid 28001\nSpain", buyer: { email: "j@x.com" },
	} as any);
	vi.mocked(shopifyAdmin.createDiscogsOrder).mockResolvedValue({ ok: true, orderId: "gid://shopify/Order/1", orderName: "#1050" } as any);
	stock(1);
});

// 147628-C-31: the only copy shipped with web order #1040, the listing stayed
// live, and it sold again on Discogs.
describe("oversell guard", () => {
	beforeEach(() => { vi.mocked(discogs.getOrders).mockResolvedValue(page([firmOrder]) as any); });

	it("creates no order when Shopify has no stock, and spends no Discogs call on it", async () => {
		stock(0);
		await pollDiscogsForSales(env as any);
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
		expect(discogs.getOrder).not.toHaveBeenCalled();
		const a = await audit();
		expect(a.order_creation).toMatchObject({ ok: false, oversold: true, will_retry: true });
		expect(a.order_creation.error).toContain("BOND12081C (Shopify stock 0)");
		// No durable lock — a restock must still let the sale through.
		expect(await env.SYNC_STATE.get(`lock:order:${ORDER_ID}`)).toBe("in-flight");
	});

	it("goes through once the record is restocked", async () => {
		stock(0);
		await pollDiscogsForSales(env as any);
		await env.SYNC_STATE.delete(`lock:order:${ORDER_ID}`);
		stock(1);
		await pollDiscogsForSales(env as any);
		expect(shopifyAdmin.createDiscogsOrder).toHaveBeenCalledTimes(1);
	});

	it("never treats a failed stock read as in stock", async () => {
		vi.mocked(shopifyAdmin.getVariantsStock).mockRejectedValue(new Error("Shopify Admin API 503"));
		await pollDiscogsForSales(env as any);
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
		expect((await audit()).order_creation).toMatchObject({ ok: false, will_retry: true });
	});

	it("does not guard variants that don't track inventory", async () => {
		stock(null);
		await pollDiscogsForSales(env as any);
		expect(shopifyAdmin.createDiscogsOrder).toHaveBeenCalledTimes(1);
	});

	it("the parked pass checks stock too, before calling Discogs", async () => {
		await env.SYNC_STATE.put(`sales-detected:${ORDER_ID}`, JSON.stringify({
			order_id: ORDER_ID, status: "Payment Received", first_detected_at: new Date().toISOString(), attempts: 1,
			items: [{ listing_id: LISTING_ID, sku: "BOND12081C", shopify_variant_id: VARIANT, quantity: 1, outcome: "resolved" }],
			order_creation: { ok: false, will_retry: true, error: "getOrder failed: 429" },
		}));
		vi.mocked(discogs.getOrders).mockRejectedValue(new Error("429"));
		stock(0);
		await pollDiscogsForSales(env as any);
		expect(discogs.getOrder).not.toHaveBeenCalled();
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
		expect((await audit()).order_creation.oversold).toBe(true);
	});
});

describe("cancelled / refunded orders", () => {
	const parked = () => env.SYNC_STATE.put(`sales-detected:${ORDER_ID}`, JSON.stringify({
		order_id: ORDER_ID, status: "Payment Received", first_detected_at: new Date().toISOString(), attempts: 3,
		items: [{ listing_id: LISTING_ID, sku: "BOND12081C", shopify_variant_id: VARIANT, quantity: 1, outcome: "resolved" }],
		order_creation: { ok: false, oversold: true, will_retry: true, error: "oversold" },
	}));

	it("the parked pass never invoices an order Discogs now calls cancelled", async () => {
		await parked();
		vi.mocked(discogs.getOrders).mockRejectedValue(new Error("429"));
		vi.mocked(discogs.getOrder).mockResolvedValue({ ...firmOrder, status: "Cancelled (Refund Sent)" } as any);
		await pollDiscogsForSales(env as any);
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
		expect((await audit()).order_creation).toMatchObject({ closed: true, will_retry: false });

		// And it is left alone from then on.
		await env.SYNC_STATE.delete(`lock:order:${ORDER_ID}`);
		const res = await pollDiscogsForSales(env as any);
		expect(res.parked_retried).toBe(0);
	});

	it("the scan closes the audit once the order is no longer firm", async () => {
		await parked();
		vi.mocked(discogs.getOrders).mockResolvedValue(page([{ ...firmOrder, status: "Cancelled (Refund Sent)" }]) as any);
		stock(0);  // keeps the parked pass from finishing it first
		await pollDiscogsForSales(env as any);
		const a = await audit();
		expect(a.order_creation.closed).toBe(true);
		expect(a.status).toBe("Cancelled (Refund Sent)");
	});
});

describe("stuck-sale alerts", () => {
	let sent: any[] = [];
	beforeEach(async () => {
		sent = [];
		(env as any).RESEND_API_KEY = "re_test";
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_u: any, init: any) => {
			sent.push(JSON.parse(init.body));
			return new Response("{}", { status: 200 });
		});
	});
	afterEach(() => vi.restoreAllMocks());

	const stuckAudit = (over: any = {}) => env.SYNC_STATE.put(`sales-detected:${ORDER_ID}`, JSON.stringify({
		order_id: ORDER_ID, first_detected_at: new Date(Date.now() - STUCK_AFTER_MS - 60000).toISOString(), attempts: 5,
		items: [{ release_title: "Between Us", sku: "BOND 12081" }],
		order_creation: { ok: false, will_retry: true, error: "no resolvable line items" }, ...over,
	}));

	it("emails a sale that is still unsynced after an hour, once", async () => {
		await env.SYNC_STATE.put("meta:sync_alert_to", "owner@example.com");
		await stuckAudit();
		const first = await sendSyncAlerts(env as any);
		expect(first).toMatchObject({ found: 1, sent: true, to: "owner@example.com" });
		expect(sent[0].subject).toContain("1 order not in Shopify");
		expect(sent[0].html).toContain(ORDER_ID);
		expect(sent[0].html).toContain("BOND 12081");

		const second = await sendSyncAlerts(env as any);
		expect(second.found).toBe(0);
		expect(sent).toHaveLength(1);
	});

	it("does not alert a sale younger than an hour", async () => {
		await env.SYNC_STATE.put("meta:sync_alert_to", "owner@example.com");
		await stuckAudit({ first_detected_at: new Date().toISOString() });
		expect((await sendSyncAlerts(env as any)).found).toBe(0);
	});

	it("alerts an oversold sale immediately", async () => {
		await env.SYNC_STATE.put("meta:sync_alert_to", "owner@example.com");
		await stuckAudit({
			first_detected_at: new Date().toISOString(),
			order_creation: { ok: false, oversold: true, will_retry: true, error: "oversold: BOND12081C (Shopify stock 0)" },
		});
		const r = await sendSyncAlerts(env as any);
		expect(r.sent).toBe(true);
		expect(sent[0].subject).toContain("oversold");
		expect(sent[0].html).toContain("OVERSOLD");
	});

	it("ignores closed (cancelled) and synced sales", async () => {
		await env.SYNC_STATE.put("meta:sync_alert_to", "owner@example.com");
		await stuckAudit({ order_creation: { ok: false, closed: true, will_retry: false } });
		expect((await sendSyncAlerts(env as any)).found).toBe(0);
	});

	it("sends nothing without a recipient, and says why", async () => {
		await stuckAudit();
		const r = await sendSyncAlerts(env as any);
		expect(r).toMatchObject({ found: 1, sent: false, skipped_reason: "meta:sync_alert_to not set" });
		expect(sent).toHaveLength(0);
	});

	it("retries on the next poll when the send fails", async () => {
		await env.SYNC_STATE.put("meta:sync_alert_to", "owner@example.com");
		await stuckAudit();
		vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response("down", { status: 500 }));
		expect((await sendSyncAlerts(env as any)).sent).toBe(false);
		expect((await sendSyncAlerts(env as any)).sent).toBe(true);
	});

	it("alerts when the poll itself keeps failing", async () => {
		await env.SYNC_STATE.put("meta:sync_alert_to", "owner@example.com");
		await env.SYNC_STATE.put("meta:poll_fail_streak", "8");
		const r = await sendSyncAlerts(env as any);
		expect(r.sent).toBe(true);
		expect(sent[0].subject).toBe("Discogs sync is failing");
	});

	it("runs as part of every poll, even when getOrders is refused", async () => {
		await env.SYNC_STATE.put("meta:sync_alert_to", "owner@example.com");
		await stuckAudit({ items: [] });
		vi.mocked(discogs.getOrders).mockRejectedValue(new Error("429"));
		const res = await pollDiscogsForSales(env as any);
		expect(res.alerts).toMatchObject({ found: 1, sent: true });
	});
});

describe("sync-relink", () => {
	const inv = (listings: any[]) => vi.mocked(discogs.getInventory).mockResolvedValue({
		pagination: { page: 1, pages: 1, per_page: 100, items: listings.length }, listings,
	} as any);
	const req = (qs = "", body: any = {}) => new Request(`https://w.test/?action=sync-relink${qs}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${(env as any).BOOTSTRAP_AUTH_SECRET}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const run = async (qs = "", body: any = {}) => (await handleSyncRelink(req(qs, body), env as any)).json() as any;

	beforeEach(async () => {
		(env as any).BOOTSTRAP_AUTH_SECRET = "bs_test";
		(env as any).DISCOGS_TOKEN = "dt_test";
		await env.SYNC_STATE.delete(`listing:${LISTING_ID}`);
	});

	it("rejects calls without the admin secret", async () => {
		const r = await handleSyncRelink(new Request("https://w.test/?action=sync-relink", { method: "POST" }), env as any);
		expect(r.status).toBe(401);
	});

	it("fixes a separator mismatch only with commit=1", async () => {
		inv([{ id: 1, status: "For Sale", release: { catalog_number: "TEMPA 131", description: "x" } }]);
		vi.mocked(shopifyAdmin.searchVariantsBySkus).mockResolvedValue([
			{ id: "v1", sku: "TEMPA131", inventoryQuantity: 1, title: "T", status: "ACTIVE" },
		]);
		const dry = await run();
		expect(dry.counts.fix).toBe(1);
		expect(await env.SYNC_STATE.get("sku:TEMPA131")).toBeNull();

		const live = await run("&commit=1");
		expect(live.committed).toBe(true);
		expect(JSON.parse((await env.SYNC_STATE.get("sku:TEMPA131"))!).listing_id).toBe(1);
		expect(JSON.parse((await env.SYNC_STATE.get("listing:1"))!).sku).toBe("TEMPA131");

		const again = await run("&commit=1");
		expect(again.counts.ok).toBe(1);
	});

	it("never guesses a suffixed SKU: BOND 12081 is unresolved with BOND12081C as a hint", async () => {
		inv([{ id: LISTING_ID, status: "For Sale", release: { catalog_number: "BOND 12081", description: "Between Us" } }]);
		vi.mocked(shopifyAdmin.searchVariantsBySkus).mockResolvedValue([]);
		vi.mocked(shopifyAdmin.shopifyAdminGraphQL).mockResolvedValue({
			data: { productVariants: { nodes: [{ id: "v", sku: "BOND12081C", inventoryQuantity: 0, product: { title: "Between Us (LTD)" } }] } },
		});
		const r = await run("&commit=1");
		expect(r.counts.unresolved).toBe(1);
		expect(r.listings[0].hints[0].sku).toBe("BOND12081C");
		expect(await env.SYNC_STATE.get("sku:BOND12081C")).toBeNull();
	});

	it("writes an approved pair, and reports it as live on Discogs with no stock", async () => {
		inv([{ id: LISTING_ID, status: "For Sale", release: { catalog_number: "BOND 12081", description: "Between Us" } }]);
		vi.mocked(shopifyAdmin.searchVariantsBySkus).mockResolvedValue([
			{ id: VARIANT, sku: "BOND12081C", inventoryQuantity: 0, title: "Between Us (LTD)", status: "ACTIVE" },
		]);
		const r = await run("&commit=1", { approve: { [LISTING_ID]: "BOND12081C" } });
		expect(r.counts.approved).toBe(1);
		expect(JSON.parse((await env.SYNC_STATE.get("sku:BOND12081C"))!).listing_id).toBe(LISTING_ID);
		expect(r.for_sale_without_stock).toEqual([expect.objectContaining({ listing_id: LISTING_ID, sku: "BOND12081C", stock: 0 })]);
	});

	it("never re-points a SKU that belongs to another listing", async () => {
		await env.SYNC_STATE.put("sku:DAT114", JSON.stringify({ listing_id: 999, status: "For Sale" }));
		inv([{ id: 2, status: "For Sale", release: { catalog_number: "DAT 114", description: "x" } }]);
		vi.mocked(shopifyAdmin.searchVariantsBySkus).mockResolvedValue([
			{ id: "v2", sku: "DAT114", inventoryQuantity: 1, title: "D", status: "ACTIVE" },
		]);
		const r = await run("&commit=1");
		expect(r.counts.conflict).toBe(1);
		expect(JSON.parse((await env.SYNC_STATE.get("sku:DAT114"))!).listing_id).toBe(999);
	});

	it("reports ambiguity instead of picking", async () => {
		inv([{ id: 3, status: "For Sale", release: { catalog_number: "ab-1", description: "x" } }]);
		vi.mocked(shopifyAdmin.searchVariantsBySkus).mockResolvedValue([
			{ id: "v3", sku: "AB1", inventoryQuantity: 1, title: "A", status: "ACTIVE" },
			{ id: "v4", sku: "AB-1", inventoryQuantity: 1, title: "B", status: "ACTIVE" },
		]);
		const r = await run("&commit=1");
		expect(r.counts.ambiguous).toBe(1);
		expect(await env.SYNC_STATE.get("listing:3")).toBeNull();
	});
});
