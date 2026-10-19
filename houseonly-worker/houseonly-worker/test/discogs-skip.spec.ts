import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { pollDiscogsForSales } from "../src/lib/sync";
import { collectSyncAlerts } from "../src/lib/sync-alerts";
import { loadShopifyDiscogsIndex, decideSkip } from "../src/lib/discogs-skip";
import * as discogs from "../src/lib/discogs";
import * as shopifyAdmin from "../src/lib/shopify-admin";

vi.mock("../src/lib/discogs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/discogs")>();
	return { ...actual, getOrders: vi.fn(), getOrder: vi.fn(), getListing: vi.fn() };
});
vi.mock("../src/lib/shopify-admin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/shopify-admin")>();
	return { ...actual, findVariantBySkuLoose: vi.fn(), createDiscogsOrder: vi.fn(), getVariantsStock: vi.fn(), shopifyAdminGraphQL: vi.fn() };
});

const gql = vi.mocked(shopifyAdmin.shopifyAdminGraphQL);
const V1 = "gid://shopify/ProductVariant/1";
const V2 = "gid://shopify/ProductVariant/2";

/** A Shopify order as the orders query returns it. */
const so = (name: string, discogsId: string | null, units: number, cancelled = false) => ({
	id: `gid://shopify/Order/${name.slice(1)}`, name, cancelledAt: cancelled ? "2026-10-17T06:20:00Z" : null,
	currentSubtotalLineItemsQuantity: units,
	customAttributes: discogsId ? [{ key: "discogs_order_id", value: discogsId }] : [],
});
const shopify = (...nodes: any[]) => gql.mockResolvedValue(
	{ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } as any);

// 147628-65: two records, RXT-05 R has no Shopify variant under that SKU.
const ORDER_65 = {
	id: "147628-65", status: "Payment Received", created: "2026-10-16T21:57:40-07:00",
	items: [{ id: 11, release: { description: "Fresh & Low - Burnin Love" } }, { id: 12, release: { description: "Fresh & Low - Wind On Water" } }],
};
const page = (orders: any[]) => ({ pagination: { page: 1, pages: 1, per_page: 50, items: orders.length }, orders });
const audit = async (id: string) => JSON.parse((await env.SYNC_STATE.get(`sales-detected:${id}`)) || "null");

beforeEach(async () => {
	vi.clearAllMocks();
	for (const prefix of ["sales-detected:", "lock:", "listing:", "sku:", "alerted:", "meta:", "manual:"]) {
		const { keys } = await env.SYNC_STATE.list({ prefix });
		for (const k of keys) await env.SYNC_STATE.delete(k.name);
	}
	await env.SYNC_STATE.put("meta:sync_3e_mode", "live");
	await env.SYNC_STATE.put("listing:11", JSON.stringify({ sku: "RXT-08" }));
	await env.SYNC_STATE.put("listing:12", JSON.stringify({ sku: "RXT-05 R" }));
	vi.mocked(shopifyAdmin.findVariantBySkuLoose).mockImplementation(async (_e, sku) =>
		(sku === "RXT-08" ? { variantId: V1, sku } : sku === "RXT-05" ? { variantId: V2, sku } : null) as any);
	vi.mocked(shopifyAdmin.getVariantsStock).mockImplementation(async (_e, ids) => new Map(ids.map((id) => [id, 1])));
	vi.mocked(shopifyAdmin.createDiscogsOrder).mockResolvedValue({ ok: true, orderId: "gid://shopify/Order/9", orderName: "#1099" } as any);
	vi.mocked(discogs.getOrder).mockResolvedValue({ ...ORDER_65, shipping_address: "Jane\n1 St\nMadrid 28001\nSpain", buyer: { email: "j@x.com" } } as any);
	vi.mocked(discogs.getOrders).mockResolvedValue(page([ORDER_65]) as any);
	shopify();
});

describe("decideSkip / index", () => {
	const idx = async (...nodes: any[]) => { shopify(...nodes); return loadShopifyDiscogsIndex((q, v) => gql(env as any, q, v), "2026-09-14"); };

	it("matches the attribute value exactly: no prefix, no -C- crossover", async () => {
		const i = await idx(so("#1067", "147628-65", 2), so("#1050", "147628-C-4", 1));
		expect(decideSkip("147628-65", 2, null, i).kind).toBe("in-shopify");
		expect(decideSkip("147628-C-65", 2, null, i).kind).toBe("process");
		expect(decideSkip("147628-6", 1, null, i).kind).toBe("process");
		expect(decideSkip("147628-C-49", 2, null, i).kind).toBe("process");
		expect(decideSkip("147628-C-4", 1, null, i).kind).toBe("in-shopify");
	});

	it("#1066: cancelled, or without the attribute, counts for nothing", async () => {
		const i = await idx(so("#1066", null, 2, true), so("#1034", "147628-33", 19, true), so("#1070", null, 2));
		expect(i.size).toBe(0);
	});

	it("a Shopify order with fewer records than the sale is partial, not synced", async () => {
		const i = await idx(so("#1048", "147628-C-30", 1));
		expect(decideSkip("147628-C-30", 2, null, i)).toMatchObject({ kind: "partial-in-shopify", needed: 2 });
	});

	it("two live orders for one sale: the fuller one decides", async () => {
		const i = await idx(so("#1080", "147628-70", 1), so("#1081", "147628-70", 2));
		expect(decideSkip("147628-70", 2, null, i)).toMatchObject({ kind: "in-shopify", order: { name: "#1081" } });
	});

	it("manual wins before Shopify is even consulted", () => {
		expect(decideSkip("147628-C-49", 2, "shipped from Discogs", new Map()).kind).toBe("manual");
	});

	it("follows pagination, and refuses an incomplete list", async () => {
		gql.mockResolvedValueOnce({ data: { orders: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [] } } } as any)
			.mockResolvedValueOnce({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [so("#1067", "147628-65", 2)] } } } as any);
		const i = await loadShopifyDiscogsIndex((q, v) => gql(env as any, q, v), "2026-09-14");
		expect(i.has("147628-65")).toBe(true);
		expect(gql.mock.calls[1][2]).toMatchObject({ after: "c1" });

		gql.mockResolvedValue({ data: { orders: { pageInfo: { hasNextPage: true, endCursor: "x" }, nodes: [] } } } as any);
		await expect(loadShopifyDiscogsIndex((q, v) => gql(env as any, q, v), "2026-09-14")).rejects.toThrow(/truncated/);
		gql.mockResolvedValue({ errors: [{ message: "Throttled" }] } as any);
		await expect(loadShopifyDiscogsIndex((q, v) => gql(env as any, q, v), "2026-09-14")).rejects.toThrow(/Throttled/);
	});
});

describe("poll: sale already in Shopify (147628-65 -> #1067)", () => {
	it("skips before any variant lookup, locks it, records it synced, no alert", async () => {
		shopify(so("#1067", "147628-65", 2), so("#1066", null, 2, true));
		const r = await pollDiscogsForSales(env as any);
		expect(shopifyAdmin.findVariantBySkuLoose).not.toHaveBeenCalled();
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
		expect(discogs.getOrder).not.toHaveBeenCalled();
		expect(r).toMatchObject({ skipped_in_shopify: 1, variant_not_found: 0 });
		expect(r.failures ?? []).toHaveLength(0);
		expect(await env.SYNC_STATE.get("lock:order:147628-65")).toBe("shopify-existing");
		expect((await audit("147628-65")).order_creation).toMatchObject({ ok: true, already_in_shopify: true, shopify_order_name: "#1067" });
		expect(await collectSyncAlerts(env as any, Date.now() + 2 * 3600_000)).toHaveLength(0);

		// Next poll: the lock answers; Shopify is not asked again.
		gql.mockClear();
		const r2 = await pollDiscogsForSales(env as any);
		expect(r2.skipped_duplicate).toBe(1);
		expect(gql).not.toHaveBeenCalled();
	});

	it("an old stuck audit (153 attempts) is closed as synced, so alerts and parked stop", async () => {
		await env.SYNC_STATE.put("sales-detected:147628-65", JSON.stringify({
			order_id: "147628-65", first_detected_at: "2026-10-17T05:07:50Z", attempts: 153,
			items: [{ sku: "RXT-08", shopify_variant_id: V1, outcome: "resolved" }, { sku: "RXT-05 R", shopify_variant_id: null, outcome: "variant_not_found" }],
			order_creation: { ok: false, needs_manual: true, will_retry: true, error: "variant_not_found" },
		}));
		shopify(so("#1067", "147628-65", 2));
		await pollDiscogsForSales(env as any);
		const a = await audit("147628-65");
		expect(a.attempts).toBe(154);
		expect(a.first_detected_at).toBe("2026-10-17T05:07:50Z");
		expect(a.order_creation.ok).toBe(true);
	});

	it("#1066 alone (cancelled, no attribute) does not count: the sale is examined as before", async () => {
		shopify(so("#1066", null, 2, true));
		const r = await pollDiscogsForSales(env as any);
		expect(shopifyAdmin.findVariantBySkuLoose).toHaveBeenCalled();
		expect(r.skipped_in_shopify).toBe(0);
		expect(r.variant_not_found).toBe(1);
	});

	it("a Shopify order with fewer records stays pending and creates nothing", async () => {
		shopify(so("#1067", "147628-65", 1));
		vi.mocked(shopifyAdmin.findVariantBySkuLoose).mockResolvedValue({ variantId: V1, sku: "X" } as any);
		const r = await pollDiscogsForSales(env as any);
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
		expect((await audit("147628-65")).order_creation).toMatchObject({ ok: false, needs_manual: true, will_retry: true });
		expect(r.failures?.[0].error).toContain("#1067 has 1 of 2");
		expect(await env.SYNC_STATE.get("lock:order:147628-65")).toBe("in-flight");
	});

	it("Shopify unreadable: neither skips nor creates, retries next poll", async () => {
		gql.mockRejectedValue(new Error("Shopify Admin API 503"));
		vi.mocked(shopifyAdmin.findVariantBySkuLoose).mockResolvedValue({ variantId: V1, sku: "X" } as any);
		const r = await pollDiscogsForSales(env as any);
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
		expect(shopifyAdmin.findVariantBySkuLoose).not.toHaveBeenCalled();
		expect((await audit("147628-65")).order_creation).toMatchObject({ ok: false, will_retry: true });
		expect(r.failures?.[0].error).toContain("lookup failed");
		expect(await env.SYNC_STATE.get("lock:order:147628-65")).toBe("in-flight");
	});

	it("a new sale with no Shopify order is still created (one Shopify read per poll)", async () => {
		vi.mocked(shopifyAdmin.findVariantBySkuLoose).mockImplementation(async (_e, sku) => ({ variantId: `gid://shopify/ProductVariant/${sku}`, sku }) as any);
		const other = { ...ORDER_65, id: "147628-66" };
		vi.mocked(discogs.getOrders).mockResolvedValue(page([ORDER_65, other]) as any);
		await pollDiscogsForSales(env as any);
		expect(shopifyAdmin.createDiscogsOrder).toHaveBeenCalledTimes(2);
		expect(gql).toHaveBeenCalledTimes(1);
	});

	it("parked pass: a sale built by hand while parked is not invoiced again after a restock", async () => {
		await env.SYNC_STATE.put("sales-detected:147628-C-60", JSON.stringify({
			order_id: "147628-C-60", first_detected_at: new Date().toISOString(), attempts: 4,
			items: [{ sku: "DAT124", shopify_variant_id: V1, quantity: 1, outcome: "resolved" }],
			order_creation: { ok: false, oversold: true, will_retry: true, error: "oversold" },
		}));
		vi.mocked(discogs.getOrders).mockRejectedValue(new Error("429"));
		shopify(so("#1090", "147628-C-60", 1));
		const r = await pollDiscogsForSales(env as any);
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
		expect(discogs.getOrder).not.toHaveBeenCalled();
		expect(r.skipped_in_shopify).toBe(1);
		expect(await env.SYNC_STATE.get("lock:order:147628-C-60")).toBe("shopify-existing");
	});
});

describe("poll: manual:<order_id> (147628-C-49)", () => {
	const C49 = {
		id: "147628-C-49", status: "Shipped", created: "2026-10-17T14:04:25-07:00",
		items: [{ id: 21, release: { description: "Kid Lib - Controlling Us" } }, { id: 22, release: { description: "Kid Lib - Living In The Zone" } }],
	};
	const parkedOversold = () => env.SYNC_STATE.put("sales-detected:147628-C-49", JSON.stringify({
		order_id: "147628-C-49", first_detected_at: "2026-10-17T21:07:30Z", attempts: 137,
		items: [{ sku: "DAT093", shopify_variant_id: V1, quantity: 1, outcome: "resolved" }, { sku: "DAT124", shopify_variant_id: V2, quantity: 1, outcome: "resolved" }],
		order_creation: { ok: false, oversold: true, needs_manual: true, will_retry: true, error: "oversold: DAT124 (Shopify stock 0)" },
	}));

	it("without the key, a Shipped oversold sale keeps being retried (today's behaviour)", async () => {
		await parkedOversold();
		vi.mocked(discogs.getOrders).mockResolvedValue(page([C49]) as any);
		vi.mocked(shopifyAdmin.getVariantsStock).mockImplementation(async (_e, ids) => new Map(ids.map((id) => [id, id === V2 ? 0 : 1])));
		const r = await pollDiscogsForSales(env as any);
		expect(r.parked_retried).toBe(1);
		expect(r.failures?.[0].order_id).toBe("147628-C-49");
	});

	it("with the key: no stock check, no Discogs call, no order, audit closed, no alert: and it stays that way", async () => {
		await parkedOversold();
		await env.SYNC_STATE.put("manual:147628-C-49", "shipped from Discogs 2026-10-19");
		vi.mocked(discogs.getOrders).mockResolvedValue(page([C49]) as any);
		const r = await pollDiscogsForSales(env as any);
		expect(shopifyAdmin.getVariantsStock).not.toHaveBeenCalled();
		expect(discogs.getOrder).not.toHaveBeenCalled();
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
		expect(r.parked_retried).toBe(0);
		expect(r.skipped_manual).toBeGreaterThanOrEqual(1);
		expect(r.failures ?? []).toHaveLength(0);
		const a = await audit("147628-C-49");
		expect(a.order_creation).toMatchObject({ closed: true, manual: true, will_retry: false });
		expect(a.attempts).toBe(137);
		// Also the oversold alert, which would otherwise fire immediately.
		expect(await collectSyncAlerts(env as any, Date.now() + 2 * 3600_000)).toHaveLength(0);
		// Manual needs no lock; the key itself persists.
		expect(await env.SYNC_STATE.get("lock:order:147628-C-49")).toBeNull();

		const r2 = await pollDiscogsForSales(env as any);
		expect(r2.parked_retried).toBe(0);
		expect(r2.failures ?? []).toHaveLength(0);
	});

	it("works even when Shopify is down (the key is pure KV)", async () => {
		await env.SYNC_STATE.put("manual:147628-C-49", "x");
		gql.mockRejectedValue(new Error("503"));
		vi.mocked(discogs.getOrders).mockResolvedValue(page([C49]) as any);
		const r = await pollDiscogsForSales(env as any);
		expect(r.skipped_manual).toBe(1);
		expect(r.failures ?? []).toHaveLength(0);
	});
});
