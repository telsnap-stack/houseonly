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
