import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as discogs from "../src/lib/discogs";
import * as ebay from "../src/lib/ebay";
import { runDiscogsRelist } from "../src/lib/discogs-relist";

vi.mock("../src/lib/discogs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/discogs")>();
	return { ...actual, getListing: vi.fn(), createListing: vi.fn() };
});
vi.mock("../src/lib/ebay", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/ebay")>();
	return { ...actual, fetchSourceProduct: vi.fn() };
});

const E = env as any;
const get = async (k: string) => JSON.parse((await E.SYNC_STATE.get(k)) || "null");
const sold = (id: number, over: any = {}) => ({
	id, status: "Sold", price: { currency: "EUR", value: 20.99 }, release: { id: 9000 + id, catalog_number: "X", description: "" },
	condition: "Mint (M)", sleeve_condition: "Near Mint (NM or M-)", uri: "", ...over,
});
const inShopify = (stock: number, status = "ACTIVE") => ({ status, variant: { inventoryQuantity: stock } }) as any;

beforeEach(async () => {
	vi.clearAllMocks();
	for (const k of (await E.SYNC_STATE.list()).keys) await E.SYNC_STATE.delete(k.name);
	E.DISCOGS_TOKEN = "t";
	await E.SYNC_STATE.put("sku:AAA", JSON.stringify({ listing_id: 1, status: "For Sale", synced_at: "x" }));
	await E.SYNC_STATE.put("sku:BBB", JSON.stringify({ listing_id: 2, status: "For Sale", synced_at: "x" }));
	await E.SYNC_STATE.put("meta:discogs_relist_queue", JSON.stringify(["AAA", "BBB"]));
	vi.mocked(discogs.getListing).mockImplementation(async (_t, id) => sold(id) as any);
	vi.mocked(discogs.createListing).mockResolvedValue(555);
});

describe("discogs relist of sold listings", () => {
	it("dry: plans once, creates nothing, keeps the queue", async () => {
		vi.mocked(ebay.fetchSourceProduct).mockResolvedValue(inShopify(1));
		expect(await runDiscogsRelist(E)).toEqual({ mode: "dry", done: 2, left: 0 });
		expect(discogs.createListing).not.toHaveBeenCalled();
		expect((await get("meta:discogs_relist_log")).AAA).toMatchObject({ result: "would_create", input: { release_id: 9001, price: 20.99, status: "For Sale", external_id: "AAA" } });
		expect(await get("meta:discogs_relist_queue")).toEqual(["AAA", "BBB"]);
		expect(await runDiscogsRelist(E)).toEqual({ mode: "dry", done: 0, left: 0 });
	});

	it("live: new listing with the old one's release, grades and price; mappings moved; no Shopify stock, no listing", async () => {
		await E.SYNC_STATE.put("meta:discogs_relist_mode", "live");
		vi.mocked(ebay.fetchSourceProduct).mockImplementation(async (_e, sku) => inShopify(sku === "AAA" ? 1 : 0));
		expect(await runDiscogsRelist(E)).toEqual({ mode: "live", done: 2, left: 0 });
		expect(discogs.createListing).toHaveBeenCalledTimes(1);
		expect(vi.mocked(discogs.createListing).mock.calls[0][1]).toEqual({
			release_id: 9001, condition: "Mint (M)", sleeve_condition: "Near Mint (NM or M-)", price: 20.99, status: "For Sale", external_id: "AAA", location: "AAA",
		});
		expect(await get("sku:AAA")).toMatchObject({ listing_id: 555, status: "For Sale" });
		expect(await get("listing:555")).toEqual({ sku: "AAA", status: "For Sale" });
		expect((await get("meta:discogs_relist_log")).BBB).toMatchObject({ result: "no_shopify_stock", stock: 0 });
		expect(await get("sku:BBB")).toMatchObject({ listing_id: 2 });
		expect(await get("meta:discogs_relist_queue")).toEqual([]);
	});

	it("live: a listing no longer sold is left alone; a 429 stops the run and keeps the rest queued", async () => {
		await E.SYNC_STATE.put("meta:discogs_relist_mode", "live");
		vi.mocked(ebay.fetchSourceProduct).mockResolvedValue(inShopify(1));
		vi.mocked(discogs.getListing).mockImplementation(async (_t, id) => {
			if (id === 2) throw new Error("Discogs getListing failed: 429 Too Many Requests");
			return sold(id, { status: "For Sale" }) as any;
		});
		expect(await runDiscogsRelist(E)).toEqual({ mode: "live", done: 2, left: 1, stopped: "discogs_429" });
		expect((await get("meta:discogs_relist_log")).AAA).toMatchObject({ result: "not_sold", status: "For Sale" });
		expect(discogs.createListing).not.toHaveBeenCalled();
		expect(await get("meta:discogs_relist_queue")).toEqual(["BBB"]);
	});
});
