import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { findVariantBySku, findVariantBySkuLoose } from "../src/lib/shopify-admin";

// 147628-C-30 (2026-09-20): the listing cache held the Discogs catno
// "satltd008", Shopify has SATLTD008, and the case-sensitive match dropped the
// record from the order.
describe("findVariantBySku - case", () => {
	let skusReturned: string[] = [];

	beforeEach(async () => {
		// A cached token so no OAuth call is made.
		await env.WISHLIST.put("shopify_admin_token",
			JSON.stringify({ token: "test", expiresAt: Date.now() + 10 * 3600000 }));
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			new Response(JSON.stringify({
				data: { productVariants: { edges: skusReturned.map((sku, i) => ({
					node: { id: `gid://shopify/ProductVariant/${i + 1}`, sku,
						inventoryItem: { id: `gid://shopify/InventoryItem/${i + 1}` },
						product: { id: `gid://shopify/Product/${i + 1}` } },
				})) } },
			}), { status: 200 }));
	});
	afterEach(() => vi.restoreAllMocks());

	it("resolves a lowercase catno to the uppercase Shopify SKU", async () => {
		skusReturned = ["SATLTD008"];
		const v = await findVariantBySkuLoose(env as any, "satltd008");
		expect(v?.variantId).toBe("gid://shopify/ProductVariant/1");
		// The real SKU comes back, so the sync writes it into the cache.
		expect(v?.sku).toBe("SATLTD008");
	});

	it("prefers the exact-case SKU when both exist", async () => {
		skusReturned = ["ABC1", "abc1"];
		expect((await findVariantBySku(env as any, "abc1"))?.variantId)
			.toBe("gid://shopify/ProductVariant/2");
	});

	it("resolves to nothing when only case-variants exist and more than one", async () => {
		skusReturned = ["Abc1", "ABC1"];
		expect(await findVariantBySku(env as any, "abc1")).toBeNull();
	});

	it("still rejects a different SKU that the loose search returned", async () => {
		skusReturned = ["SATLTD0081"];
		expect(await findVariantBySku(env as any, "satltd008")).toBeNull();
	});
});

// 147628-C-51 (2026-10-22): Discogs catno "SJU12R24 (RED)" (the red repress is
// its own release) vs one Shopify product SKU SJU12R24 titled "... (Red Vinyl
// Repress)". Normalising gave SJU12R24RED and the order never resolved.
describe("findVariantBySkuLoose - edition qualifier in the catno", () => {
	// SKU → { product title, variant title }
	let shop: Record<string, { product: string; variant?: string }> = {};
	let asked: string[] = [];

	beforeEach(async () => {
		await env.WISHLIST.put("shopify_admin_token",
			JSON.stringify({ token: "test", expiresAt: Date.now() + 10 * 3600000 }));
		asked = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: any, init: any) => {
			const q: string = JSON.parse(init.body).variables.q;
			const sku = /^sku:"(.*)"$/.exec(q)![1];
			asked.push(sku);
			const p = shop[sku];
			const edges = p ? [{ node: { id: `gid://shopify/ProductVariant/${sku}`, sku,
				title: p.variant || "Default Title",
				inventoryItem: { id: "gid://shopify/InventoryItem/1" },
				product: { id: "gid://shopify/Product/1", title: p.product } } }] : [];
			return new Response(JSON.stringify({ data: { productVariants: { edges } } }), { status: 200 });
		});
	});
	afterEach(() => vi.restoreAllMocks());

	it("resolves SJU12R24 (RED) to SJU12R24 when the Shopify title says Red", async () => {
		shop = { SJU12R24: { product: "Afro Gente (Red Vinyl Repress)" } };
		const v = await findVariantBySkuLoose(env as any, "SJU12R24 (RED)");
		expect(v?.sku).toBe("SJU12R24");
		// Flagged so the sync logs it and marks the audit for review.
		expect(v?.via).toBe("catno_qualifier");
		expect(asked).toEqual(["SJU12R24 (RED)", "SJU12R24RED", "SJU12R24"]);
	});

	it("accepts the qualifier from the variant title (colour editions)", async () => {
		shop = { DJ001: { product: "Some Record", variant: "Red" } };
		expect((await findVariantBySkuLoose(env as any, "DJ001 (Red)"))?.sku).toBe("DJ001");
	});

	it("does NOT resolve the red listing to a product that is not the red edition", async () => {
		shop = { SJU12R24: { product: "Afro Gente / Fuego De Sangre" } };
		expect(await findVariantBySkuLoose(env as any, "SJU12R24 (RED)")).toBeNull();
	});

	it("needs every word of the qualifier", async () => {
		shop = { ABC1: { product: "Title (Red Vinyl)" } };
		expect(await findVariantBySkuLoose(env as any, "ABC1 (RED REPRESS)")).toBeNull();
	});

	it("does not match the qualifier inside another word", async () => {
		shop = { ABC1: { product: "Redshift" } };
		expect(await findVariantBySkuLoose(env as any, "ABC1 (RED)")).toBeNull();
	});

	it("prefers a real SKU that carries the edition", async () => {
		shop = { SJU12R24RED: { product: "Afro Gente (Red)" }, SJU12R24: { product: "Afro Gente (Red)" } };
		const v = await findVariantBySkuLoose(env as any, "SJU12R24 (RED)");
		expect(v?.sku).toBe("SJU12R24RED");
		expect(v?.via).toBeUndefined();
	});

	it("leaves catnos without a qualifier alone", async () => {
		shop = {};
		expect(await findVariantBySkuLoose(env as any, "TEMPA 131")).toBeNull();
		expect(asked).toEqual(["TEMPA 131", "TEMPA131"]);
	});
});
