import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import * as shopifyAdmin from "../src/lib/shopify-admin";
import * as discogs from "../src/lib/discogs";
import {
	buildEbayListing, ebayTitle, gradesFor, conditionFromTags, skipReason, toSourceProduct, GRADE_MINT, ASPECTS,
	type EbaySourceProduct,
} from "../src/lib/ebay-listing";
import {
	challengeResponse, derToRawSignature, verifyNotificationSignature, getPolicyIds, EBAY_POLICY_NAMES,
} from "../src/lib/ebay-api";
import {
	runEbayAutolist, pollEbayOrders, selectSkus, withdrawOnEbayForShopifyOrder, EBAY_BATCH_SIZE,
} from "../src/lib/ebay";

vi.mock("../src/lib/shopify-admin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/shopify-admin")>();
	return {
		...actual, shopifyAdminGraphQL: vi.fn(), findVariantBySkuLoose: vi.fn(), getVariantsStock: vi.fn(),
		createDiscogsOrder: vi.fn(), validateShopifyWebhookHmac: vi.fn(),
	};
});
vi.mock("../src/lib/discogs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/discogs")>();
	return { ...actual, getListing: vi.fn(), updateListingStatus: vi.fn() };
});

const SECRET = "test-secret";
const E = env as any;

// ── fixtures ────────────────────────────────────────────────────────

const product = (over: Partial<EbaySourceProduct> = {}, v: Partial<EbaySourceProduct["variant"]> = {}): EbaySourceProduct => ({
	productId: "gid://shopify/Product/1",
	status: "ACTIVE",
	title: "Between Us",
	vendor: "Dilby &amp; Pornbugs",
	tags: ["vinyl", "label:Bond Street", "genre:deephouse", "source:ws"],
	descriptionHtml: "<p>Deep cuts.</p><script>alert(1)</script>",
	images: ["https://cdn.shopify.com/s/files/a.jpg"],
	variant: { id: "gid://shopify/ProductVariant/9", sku: "BOND12081C", price: "14.99", barcode: "4006381333931", inventoryQuantity: 2, ...v },
	...over,
});
const CFG = {
	categoryId: "176985", merchantLocationKey: "madrid",
	policies: { fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1" },
};
// Admin API node as PRODUCT_BY_SKU_QUERY returns it.
const node = (p = product()) => ({
	id: p.productId, status: p.status, title: p.title, vendor: p.vendor, tags: p.tags, descriptionHtml: p.descriptionHtml,
	media: { nodes: p.images.map(url => ({ image: { url } })) },
	variants: { nodes: [p.variant] },
});

// ── a tiny eBay fake on top of fetch ─────────────────────────────────

type Call = { method: string; path: string; body: any; headers: Record<string, string> };
let calls: Call[];
let routes: Array<{ method: string; match: RegExp; reply: (c: Call) => Response | Promise<Response> }>;
const jsonResponse = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });
const ebayError = (status: number, errorId: number, message: string) => jsonResponse({ errors: [{ errorId, message, longMessage: message }] }, status);
function route(method: string, match: RegExp, reply: Call["body"] | ((c: Call) => Response | Promise<Response>)) {
	routes.unshift({ method, match, reply: typeof reply === "function" ? reply : () => jsonResponse(reply) });
}
const ebayCalls = (method?: string, re?: RegExp) => calls.filter(c => c.path !== "/identity/v1/oauth2/token"
	&& (!method || c.method === method) && (!re || re.test(c.path)));

function installFetch() {
	calls = [];
	routes = [];
	route("POST", /^\/identity\/v1\/oauth2\/token$/, { access_token: "tok", expires_in: 7200 });
	route("GET", /^\/sell\/account\/v1\/fulfillment_policy\/get_by_policy_name/, { fulfillmentPolicyId: "F1", name: EBAY_POLICY_NAMES.fulfillment });
	route("GET", /^\/sell\/account\/v1\/payment_policy\/get_by_policy_name/, { paymentPolicyId: "P1", name: EBAY_POLICY_NAMES.payment });
	route("GET", /^\/sell\/account\/v1\/return_policy\/get_by_policy_name/, { returnPolicyId: "R1", name: EBAY_POLICY_NAMES.return });
	route("GET", /^\/sell\/inventory\/v1\/location/, { locations: [{ merchantLocationKey: "madrid", merchantLocationStatus: "ENABLED" }] });
	route("PUT", /^\/sell\/inventory\/v1\/inventory_item\//, () => new Response(null, { status: 204 }));
	route("GET", /^\/sell\/inventory\/v1\/offer\?/, () => ebayError(404, 25713, "This Offer is not available."));
	route("POST", /^\/sell\/inventory\/v1\/offer$/, { offerId: "OFF-1" });
	route("POST", /^\/sell\/inventory\/v1\/offer\/[^/]+\/publish$/, { listingId: "LIST-1" });
	route("POST", /^\/sell\/inventory\/v1\/offer\/[^/]+\/withdraw$/, { listingId: "LIST-1" });
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
		const url = new URL(typeof input === "string" ? input : input.url);
		if (url.origin !== "https://api.ebay.com") throw new Error(`unexpected fetch ${url}`);
		const method = (init?.method || "GET").toUpperCase();
		const path = url.pathname + url.search;
		let body: any = init?.body;
		try { body = body && typeof body === "string" && body.startsWith("{") ? JSON.parse(body) : body; } catch { /* raw */ }
		const call: Call = { method, path, body, headers: init?.headers || {} };
		calls.push(call);
		const r = routes.find(x => x.method === method && x.match.test(path));
		if (!r) throw new Error(`no fake for ${method} ${path}`);
		return r.reply(call);
	});
}

async function wipe() {
	for (const prefix of ["ebay", "meta:", "lock:", "sku:", "ebay-"]) {
		const { keys } = await E.SYNC_STATE.list({ prefix });
		for (const k of keys) await E.SYNC_STATE.delete(k.name);
	}
}

async function viaWorker(request: Request) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(request, E, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
const post = (action: string, body: unknown, bearer: string | null = SECRET) => new Request(`https://w/?action=${action}`, {
	method: "POST", body: JSON.stringify(body),
	headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
});

beforeEach(async () => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
	await wipe();
	E.BOOTSTRAP_AUTH_SECRET = SECRET;
	E.EBAY_CLIENT_ID = "cid";
	E.EBAY_CLIENT_SECRET = "csecret";
	E.EBAY_REFRESH_TOKEN = "rtok";
	E.EBAY_VERIFICATION_TOKEN = "verification_token_abcdefghijklmnopqrstuvwxyz_0123";
	E.DISCOGS_TOKEN = "dtok";
	installFetch();
	vi.mocked(shopifyAdmin.shopifyAdminGraphQL).mockResolvedValue({ data: { products: { nodes: [node()] } } } as any);
	vi.mocked(shopifyAdmin.findVariantBySkuLoose).mockResolvedValue({ variantId: "gid://shopify/ProductVariant/9", sku: "BOND12081C" } as any);
	vi.mocked(shopifyAdmin.getVariantsStock).mockImplementation(async (_e, ids) => new Map(ids.map(id => [id, 1])));
	vi.mocked(shopifyAdmin.createDiscogsOrder).mockResolvedValue({ ok: true, orderId: "gid://shopify/Order/7", orderName: "#1077" } as any);
});
afterEach(() => { vi.restoreAllMocks(); });

// ── listing content ─────────────────────────────────────────────────

describe("listing content from the Shopify product", () => {
	it("maps title, artist, label, catno, genre, price, images and grades", () => {
		const p = buildEbayListing(product(), gradesFor(product().tags)!, { ...CFG, withEan: true });
		const pr = p.inventoryItem.product;
		expect(pr.title).toBe("Dilby & Pornbugs - Between Us BOND12081C Vinilo");
		expect(pr.aspects[ASPECTS.artist]).toEqual(["Dilby & Pornbugs"]);
		expect(pr.aspects[ASPECTS.label]).toEqual(["Bond Street"]);
		expect(pr.aspects[ASPECTS.catno]).toEqual(["BOND12081C"]);
		expect(pr.aspects[ASPECTS.genre]).toEqual(["Deep House"]);
		expect(pr.aspects[ASPECTS.mediaGrade]).toEqual([GRADE_MINT]);
		expect(pr.imageUrls).toEqual(["https://cdn.shopify.com/s/files/a.jpg"]);
		expect(pr.ean).toEqual(["4006381333931"]);
		expect(p.inventoryItem.condition).toBe("NEW");
		expect(p.inventoryItem.availability.shipToLocationAvailability.quantity).toBe(1);
		expect(p.offer).toMatchObject({
			sku: "BOND12081C", marketplaceId: "EBAY_ES", format: "FIXED_PRICE", categoryId: "176985",
			availableQuantity: 1, merchantLocationKey: "madrid", includeCatalogProductDetails: false,
			pricingSummary: { price: { value: "14.99", currency: "EUR" } },
			listingPolicies: { fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1" },
		});
	});

	it("never adds Canarias / exclusion text and strips active content", () => {
		const p = buildEbayListing(product(), gradesFor([])!, { ...CFG, withEan: true });
		const all = JSON.stringify(p);
		expect(all).not.toMatch(/canari|excluid|península/i);
		expect(p.offer.listingDescription).not.toMatch(/<script/i);
		expect(p.offer.listingDescription).toContain("<p>Deep cuts.</p>");
	});

	it("uses the Discogs grades when linked, Mint for new stock otherwise", () => {
		expect(gradesFor([], { condition: "Near Mint (NM or M-)", sleeve_condition: "Very Good Plus (VG+)" }))
			.toEqual({ media: "Near Mint (NM or M-)", sleeve: "Very Good Plus (VG+)", source: "discogs" });
		expect(gradesFor(["condition:sealed"])).toEqual({ media: GRADE_MINT, sleeve: GRADE_MINT, source: "condition-tag" });
		expect(gradesFor([])).toMatchObject({ media: GRADE_MINT });
		// Used and not on Discogs: no honest grade -> not listable.
		expect(gradesFor(["used"])).toBeNull();
		expect(conditionFromTags(["condition:used-vg"])).toBe("USED_EXCELLENT");
	});

	it("drops an invalid barcode and keeps the title within 80 chars", () => {
		const p = buildEbayListing(product({}, { barcode: "123" }), gradesFor([])!, { ...CFG, withEan: true });
		expect(p.inventoryItem.product.ean).toBeUndefined();
		const long = ebayTitle("A Very Long Artist Name Indeed", "An Extremely Long Title That Goes On And On Forever More", "CAT001");
		expect(long.length).toBeLessThanOrEqual(80);
		expect(ebayTitle("Artist", "Title", "X1")).toBe("Artist - Title X1 Vinilo");
	});

	it("refuses what cannot be sold right now", () => {
		const g = gradesFor([]);
		expect(skipReason(product({ tags: ["forthcoming"] }), g)).toBe("forthcoming");
		expect(skipReason(product({}, { inventoryQuantity: 0 }), g)).toBe("sin_stock");
		expect(skipReason(product({ images: [] }), g)).toBe("sin_imagen");
		expect(skipReason(product({ status: "DRAFT" }), g)).toBe("no_activo");
		expect(skipReason(product(), null)).toBe("usado_sin_grado");
		expect(skipReason(product(), g)).toBeNull();
	});

	it("picks the exact SKU variant out of the Admin search", () => {
		const other = { ...node(), variants: { nodes: [{ ...product().variant, sku: "BOND12081" }] } };
		expect(toSourceProduct([other, node()], "BOND12081C")?.variant.sku).toBe("BOND12081C");
		expect(toSourceProduct([other], "BOND12081C")).toBeNull();
	});
});

// ── Account API ─────────────────────────────────────────────────────

describe("policies", () => {
	it("resolves the three policies by name on EBAY_ES and caches them", async () => {
		expect(await getPolicyIds(E)).toEqual({ fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1" });
		const q = ebayCalls("GET", /get_by_policy_name/).map(c => decodeURIComponent(c.path));
		expect(q.some(p => p.includes("marketplace_id=EBAY_ES") && p.includes(EBAY_POLICY_NAMES.return))).toBe(true);
		await getPolicyIds(E);
		expect(ebayCalls("GET", /get_by_policy_name/)).toHaveLength(3);   // second time from KV
	});

	it("uses the refresh token with Basic auth and caches the access token", async () => {
		await getPolicyIds(E);
		const tok = calls.filter(c => c.path === "/identity/v1/oauth2/token");
		expect(tok).toHaveLength(1);
		expect(tok[0].headers.Authorization).toBe(`Basic ${btoa("cid:csecret")}`);
		const form = new URLSearchParams(tok[0].body);
		expect(form.get("grant_type")).toBe("refresh_token");
		expect(form.get("refresh_token")).toBe("rtok");
		expect(form.get("scope")).toContain("sell.inventory");
	});
});

// ── auto-list ───────────────────────────────────────────────────────

describe("auto-list cron", () => {
	it("does nothing without selected records - not even a token", async () => {
		await E.SYNC_STATE.put("meta:ebay_autolist_mode", "live");
		const r = await runEbayAutolist(E);
		expect(r).toMatchObject({ processed: 0, listed: 0 });
		expect(calls).toHaveLength(0);
	});

	it("dry: builds the listing, calls no eBay endpoint", async () => {
		await selectSkus(E, ["BOND12081C"]);
		const r = await runEbayAutolist(E);
		expect(r).toMatchObject({ mode: "dry", would_list: 1 });
		expect(calls).toHaveLength(0);
		const it = JSON.parse(await E.SYNC_STATE.get("ebay:item:BOND12081C"));
		expect(it.status).toBe("would_list");
		expect(it.preview).toMatchObject({ price: "14.99", condition: "NEW" });
	});

	it("live: inventory item -> offer -> publish, with Content-Language es-ES", async () => {
		await E.SYNC_STATE.put("meta:ebay_autolist_mode", "live");
		await selectSkus(E, ["BOND12081C"]);
		const r = await runEbayAutolist(E);
		expect(r).toMatchObject({ mode: "live", listed: 1, failed: 0 });
		const seq = ebayCalls().filter(c => /inventory_item|offer/.test(c.path)).map(c => `${c.method} ${c.path.split("?")[0]}`);
		expect(seq).toEqual([
			"PUT /sell/inventory/v1/inventory_item/BOND12081C",
			"GET /sell/inventory/v1/offer",
			"POST /sell/inventory/v1/offer",
			"POST /sell/inventory/v1/offer/OFF-1/publish",
		]);
		expect(ebayCalls("PUT", /inventory_item/)[0].headers["Content-Language"]).toBe("es-ES");
		const it = JSON.parse(await E.SYNC_STATE.get("ebay:item:BOND12081C"));
		expect(it).toMatchObject({ status: "listed", offer_id: "OFF-1", listing_id: "LIST-1" });
		expect(await E.SYNC_STATE.get("ebay:listing:LIST-1")).toBe("BOND12081C");
	});

	it("takes the grades of our Discogs listing when the SKU is linked", async () => {
		await E.SYNC_STATE.put("meta:ebay_autolist_mode", "live");
		await E.SYNC_STATE.put("sku:BOND12081C", JSON.stringify({ listing_id: 555, status: "For Sale" }));
		vi.mocked(discogs.getListing).mockResolvedValue({ id: 555, condition: "Near Mint (NM or M-)", sleeve_condition: "Very Good Plus (VG+)" } as any);
		await selectSkus(E, ["BOND12081C"]);
		await runEbayAutolist(E);
		const aspects = ebayCalls("PUT", /inventory_item/)[0].body.product.aspects;
		expect(aspects[ASPECTS.sleeveGrade]).toEqual(["Very Good Plus (VG+)"]);
	});

	it("does not touch the Discogs auto-add switch", async () => {
		await E.SYNC_STATE.put("meta:sync_35_mode", "dry");
		await E.SYNC_STATE.put("meta:ebay_autolist_mode", "live");
		await selectSkus(E, ["BOND12081C"]);
		await runEbayAutolist(E);
		expect(await E.SYNC_STATE.get("meta:sync_35_mode")).toBe("dry");
		expect(discogs.updateListingStatus).not.toHaveBeenCalled();
	});

	it("selling limit (25026): stops the batch, keeps records queued, pauses the cron", async () => {
		await E.SYNC_STATE.put("meta:ebay_autolist_mode", "live");
		route("POST", /\/publish$/, () => ebayError(400, 25026, "Selling limit exceeded."));
		await selectSkus(E, ["A1", "A2", "A3"]);
		vi.mocked(shopifyAdmin.shopifyAdminGraphQL).mockImplementation(async (_e, _q, vars: any) => {
			const sku = /sku:"(.+)"/.exec(vars.q)![1];
			return { data: { products: { nodes: [node(product({}, { sku }))] } } } as any;
		});
		const r = await runEbayAutolist(E);
		expect(r).toMatchObject({ stopped: "selling_limit", processed: 1, failed: 0, remaining_queued: 3 });
		expect(ebayCalls("POST", /\/publish$/)).toHaveLength(1);
		for (const s of ["A1", "A2", "A3"]) expect(JSON.parse(await E.SYNC_STATE.get(`ebay:item:${s}`)).status).toBe("queued");
		expect(JSON.parse(await E.SYNC_STATE.get("meta:ebay_limit_hit")).sku).toBe("A1");
		// Next cron run: paused, no eBay call at all.
		calls.length = 0;
		expect((await runEbayAutolist(E)).stopped).toBe("cooldown");
		expect(ebayCalls()).toHaveLength(0);
	});

	it(`lists at most ${EBAY_BATCH_SIZE} per run`, async () => {
		await E.SYNC_STATE.put("meta:ebay_autolist_mode", "live");
		const skus = Array.from({ length: EBAY_BATCH_SIZE + 3 }, (_, i) => `S${String(i).padStart(2, "0")}`);
		vi.mocked(shopifyAdmin.shopifyAdminGraphQL).mockImplementation(async (_e, _q, vars: any) => {
			const sku = /sku:"(.+)"/.exec(vars.q)![1];
			return { data: { products: { nodes: [node(product({}, { sku }))] } } } as any;
		});
		await selectSkus(E, skus);
		const r = await runEbayAutolist(E);
		expect(r).toMatchObject({ listed: EBAY_BATCH_SIZE, remaining_queued: 3 });
	});

	it("catalogue match refused: retries once as a standalone listing (no EAN)", async () => {
		await E.SYNC_STATE.put("meta:ebay_autolist_mode", "live");
		let n = 0;
		route("POST", /\/publish$/, () => (n++ === 0 ? ebayError(400, 25604, "Product not found for the EAN.") : jsonResponse({ listingId: "LIST-2" })));
		await selectSkus(E, ["BOND12081C"]);
		const r = await runEbayAutolist(E);
		expect(r.listed).toBe(1);
		const puts = ebayCalls("PUT", /inventory_item/);
		expect(puts[0].body.product.ean).toEqual(["4006381333931"]);
		expect(puts[1].body.product.ean).toBeUndefined();
	});

	it("a refused record is marked failed and the batch carries on", async () => {
		await E.SYNC_STATE.put("meta:ebay_autolist_mode", "live");
		route("PUT", /inventory_item/, () => ebayError(400, 25005, "Invalid category ID."));
		vi.mocked(shopifyAdmin.shopifyAdminGraphQL).mockImplementation(async (_e, _q, vars: any) => {
			const sku = /sku:"(.+)"/.exec(vars.q)![1];
			return { data: { products: { nodes: [node(product({}, { sku, barcode: null }))] } } } as any;
		});
		await selectSkus(E, ["B1", "B2"]);
		const r = await runEbayAutolist(E);
		expect(r).toMatchObject({ failed: 2, listed: 0 });
		expect(JSON.parse(await E.SYNC_STATE.get("ebay:item:B1")).error).toContain("25005");
	});

	it("live without keys: stops as not_configured, no calls", async () => {
		delete E.EBAY_REFRESH_TOKEN;
		await E.SYNC_STATE.put("meta:ebay_autolist_mode", "live");
		await selectSkus(E, ["BOND12081C"]);
		expect((await runEbayAutolist(E)).stopped).toBe("not_configured");
		expect(calls).toHaveLength(0);
	});

	it("skips a pre-order without calling eBay", async () => {
		await E.SYNC_STATE.put("meta:ebay_autolist_mode", "live");
		vi.mocked(shopifyAdmin.shopifyAdminGraphQL).mockResolvedValue({ data: { products: { nodes: [node(product({ tags: ["forthcoming"] }))] } } } as any);
		await selectSkus(E, ["BOND12081C"]);
		const r = await runEbayAutolist(E);
		expect(r.skipped).toBe(1);
		expect(ebayCalls("PUT")).toHaveLength(0);
		expect(JSON.parse(await E.SYNC_STATE.get("ebay:item:BOND12081C")).skip_reason).toBe("forthcoming");
	});
});

// ── Shopify / Discogs sale -> eBay ───────────────────────────────────

describe("sale elsewhere ends the eBay listing", () => {
	const listed = (sku: string) => E.SYNC_STATE.put(`ebay:item:${sku}`, JSON.stringify({
		sku, status: "listed", offer_id: "OFF-9", listing_id: "LIST-9", selected_at: "2026-10-01", updated_at: "2026-10-01",
	}));

	it("Shopify order (also how Discogs sales arrive) -> withdrawOffer", async () => {
		await listed("BOND12081C");
		await withdrawOnEbayForShopifyOrder(E, "5001", { line_items: [{ sku: "BOND12081C" }, { sku: "NOT-ON-EBAY" }] });
		expect(ebayCalls("POST", /withdraw/).map(c => c.path)).toEqual(["/sell/inventory/v1/offer/OFF-9/withdraw"]);
		expect(JSON.parse(await E.SYNC_STATE.get("ebay:item:BOND12081C")).status).toBe("withdrawn");
	});

	it("leaves eBay alone when the Shopify order IS the eBay sale", async () => {
		await listed("BOND12081C");
		await withdrawOnEbayForShopifyOrder(E, "5002", {
			source_name: "ebay", note_attributes: [{ name: "ebay_order_id", value: "12-34" }], line_items: [{ sku: "BOND12081C" }],
		});
		expect(ebayCalls()).toHaveLength(0);
	});

	it("a queued record that sells before listing is dropped from the queue", async () => {
		await selectSkus(E, ["BOND12081C"]);
		await withdrawOnEbayForShopifyOrder(E, "5003", { line_items: [{ sku: "BOND12081C" }] });
		expect(ebayCalls()).toHaveLength(0);
		expect(JSON.parse(await E.SYNC_STATE.get("ebay:item:BOND12081C")).status).toBe("withdrawn");
	});

	it("is wired into the Shopify orders/create webhook", async () => {
		vi.mocked(shopifyAdmin.validateShopifyWebhookHmac).mockResolvedValue(true);
		await listed("BOND12081C");
		const res = await viaWorker(new Request("https://w/?action=webhook-shopify-order", {
			method: "POST", body: JSON.stringify({ id: 6001, line_items: [{ sku: "BOND12081C", quantity: 1 }] }),
			headers: { "x-shopify-hmac-sha256": "x" },
		}));
		expect(res.status).toBe(200);
		expect(ebayCalls("POST", /withdraw/)).toHaveLength(1);
	});
});

// ── eBay sale -> Shopify order ───────────────────────────────────────

describe("eBay orders -> Shopify", () => {
	const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
	const order = (over: any = {}) => ({
		orderId: "12-34567-89012", creationDate: old, orderPaymentStatus: "PAID", cancelStatus: { cancelState: "NONE_REQUESTED" },
		buyer: { username: "buyer1" },
		lineItems: [{ lineItemId: "L1", sku: "BOND12081C", legacyItemId: "LIST-1", quantity: 1 }],
		fulfillmentStartInstructions: [{ shippingStep: { shipTo: {
			fullName: "Ana Buyer", email: "a@b.es",
			contactAddress: { addressLine1: "Calle 1", city: "Madrid", postalCode: "28001", countryCode: "ES" },
		} } }],
		...over,
	});
	const ordersFake = (orders: any[]) => route("GET", /^\/sell\/fulfillment\/v1\/order\?/, { orders, total: orders.length });

	beforeEach(async () => {
		await E.SYNC_STATE.put("meta:ebay_go_live_ts", "2026-01-01T00:00:00Z");
		await E.SYNC_STATE.put("ebay:item:BOND12081C", JSON.stringify({
			sku: "BOND12081C", status: "listed", offer_id: "OFF-1", listing_id: "LIST-1", selected_at: "2026-10-01", updated_at: "2026-10-01",
		}));
	});

	it("live: one paid Shopify order through the eBay channel, then never again", async () => {
		await E.SYNC_STATE.put("meta:ebay_sync_mode", "live");
		ordersFake([order()]);
		const r = await pollEbayOrders(E);
		expect(r).toMatchObject({ created: 1, failed: 0 });
		const [, id, lines, buyer, channel] = vi.mocked(shopifyAdmin.createDiscogsOrder).mock.calls[0];
		expect(id).toBe("12-34567-89012");
		expect(lines).toEqual([{ variantId: "gid://shopify/ProductVariant/9", quantity: 1 }]);
		expect(buyer).toMatchObject({ name: "Ana Buyer", countryCode: "ES", zip: "28001" });
		expect(channel).toBe(shopifyAdmin.EBAY_ORDER_CHANNEL);
		expect(JSON.parse(await E.SYNC_STATE.get("ebay:item:BOND12081C")).status).toBe("sold");
		// Audit keeps no buyer data.
		const audit = await E.SYNC_STATE.get("ebay-sale:12-34567-89012");
		expect(audit).not.toMatch(/Ana|buyer1|Calle|a@b\.es/);
		// Next poll: durable lock, no second factura.
		const r2 = await pollEbayOrders(E);
		expect(r2.skipped_duplicate).toBe(1);
		expect(shopifyAdmin.createDiscogsOrder).toHaveBeenCalledTimes(1);
	});

	it("dry (default): records what it would do, creates nothing", async () => {
		ordersFake([order()]);
		const r = await pollEbayOrders(E);
		expect(r).toMatchObject({ mode: "dry", would_create: 1, created: 0 });
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
	});

	it("ignores unpaid, cancelled and brand-new orders (left to the notification)", async () => {
		await E.SYNC_STATE.put("meta:ebay_sync_mode", "live");
		ordersFake([
			order({ orderId: "unpaid", orderPaymentStatus: "PENDING" }),
			order({ orderId: "cancelled", cancelStatus: { cancelState: "CANCELED" } }),
			order({ orderId: "fresh", creationDate: new Date().toISOString() }),
		]);
		const r = await pollEbayOrders(E);
		expect(r.created).toBe(0);
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
	});

	it("never invoices a record we did not list through this channel", async () => {
		await E.SYNC_STATE.put("meta:ebay_sync_mode", "live");
		ordersFake([order({ lineItems: [{ sku: "HAND-LISTED", quantity: 1 }] })]);
		const r = await pollEbayOrders(E);
		expect(r.not_ours).toBe(1);
		expect(shopifyAdmin.createDiscogsOrder).not.toHaveBeenCalled();
	});

	it("oversold (no Shopify stock): parks the sale for manual handling", async () => {
		await E.SYNC_STATE.put("meta:ebay_sync_mode", "live");
		vi.mocked(shopifyAdmin.getVariantsStock).mockImplementation(async (_e, ids) => new Map(ids.map(id => [id, 0])));
		ordersFake([order()]);
		const r = await pollEbayOrders(E);
		expect(r.failed).toBe(1);
		expect(JSON.parse(await E.SYNC_STATE.get("ebay-sale:12-34567-89012")).order_creation).toMatchObject({ oversold: true, will_retry: true });
		expect(await E.SYNC_STATE.get("lock:ebay-order:12-34567-89012")).toBe("in-flight");
	});

	it("first run sets the go-live floor so older sales are never back-processed", async () => {
		await E.SYNC_STATE.delete("meta:ebay_go_live_ts");
		ordersFake([]);
		await pollEbayOrders(E);
		const floor = await E.SYNC_STATE.get("meta:ebay_go_live_ts");
		expect(Date.now() - Date.parse(floor)).toBeLessThan(60_000);
		const q = decodeURIComponent(ebayCalls("GET", /fulfillment/)[0].path);
		expect(q).toContain(`creationdate:[${floor}..]`);
	});

	it("without keys: reports not_configured and calls nothing", async () => {
		delete E.EBAY_CLIENT_ID;
		const r = await pollEbayOrders(E);
		expect(r.stopped).toBe("not_configured");
		expect(calls).toHaveLength(0);
	});
});

// ── notifications ───────────────────────────────────────────────────

describe("notification endpoint", () => {
	const ENDPOINT = "https://w/?action=ebay-notify";

	async function signer() {
		const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
		const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
		const pem = `-----BEGIN PUBLIC KEY-----${btoa(String.fromCharCode(...spki))}-----END PUBLIC KEY-----`;
		route("GET", /^\/commerce\/notification\/v1\/public_key\/kid-1$/, { algorithm: "ECDSA", digest: "SHA1", key: pem });
		return async (payload: string) => {
			const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-1" }, kp.privateKey, new TextEncoder().encode(payload)));
			return btoa(JSON.stringify({ alg: "ECDSA", kid: "kid-1", signature: btoa(String.fromCharCode(...rawToDer(raw))), digest: "SHA1" }));
		};
	}
	// eBay sends DER; Web Crypto produces raw r‖s. Encode to DER for the fake.
	function rawToDer(raw: Uint8Array): Uint8Array {
		const int = (b: Uint8Array) => {
			let i = 0; while (i < b.length - 1 && b[i] === 0) i++;
			let v = b.slice(i); if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
			return [0x02, v.length, ...v];
		};
		const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
		return new Uint8Array([0x30, body.length, ...body]);
	}
	const notify = (payload: string, sig: string | null) => new Request(ENDPOINT, {
		method: "POST", body: payload, headers: { "Content-Type": "application/json", ...(sig ? { "X-EBAY-SIGNATURE": sig } : {}) },
	});

	it("answers the endpoint challenge: sha256(code + token + endpoint)", async () => {
		const res = await viaWorker(new Request(`${ENDPOINT}&challenge_code=abc123`));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const expected = await challengeResponse("abc123", E.EBAY_VERIFICATION_TOKEN, ENDPOINT);
		expect(await res.json()).toEqual({ challengeResponse: expected });
		// Known vector: independent hex SHA-256 of the concatenation.
		const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`abc123${E.EBAY_VERIFICATION_TOKEN}${ENDPOINT}`));
		expect(expected).toBe([...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""));
	});

	it("DER -> raw signature keeps both integers at curve size", () => {
		const der = new Uint8Array([0x30, 0x08, 0x02, 0x02, 0x00, 0x81, 0x02, 0x02, 0x01, 0x02]);
		const raw = derToRawSignature(der, 4);
		expect([...raw]).toEqual([0, 0, 0, 0x81, 0, 0, 1, 2]);
	});

	it("verifies a valid eBay signature and rejects a tampered body", async () => {
		const sign = await signer();
		const payload = JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { notificationId: "n1" } });
		const sig = await sign(payload);
		expect(await verifyNotificationSignature(E, payload, sig)).toBe(true);
		expect(await verifyNotificationSignature(E, payload.replace("n1", "n2"), sig)).toBe(false);
	});

	it("account deletion: 204, stores nothing about the user", async () => {
		const sign = await signer();
		const payload = JSON.stringify({
			metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION", schemaVersion: "1.0" },
			notification: { notificationId: "n-del", data: { username: "someuser", userId: "u1", eiasToken: "e1" } },
		});
		const res = await viaWorker(notify(payload, await sign(payload)));
		expect(res.status).toBe(204);
		const kept = await E.SYNC_STATE.get("ebay-deletion:n-del");
		expect(kept).not.toMatch(/someuser|u1|e1/);
	});

	it("bad or missing signature: 412", async () => {
		await signer();
		const payload = JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: {} });
		expect((await viaWorker(notify(payload, null))).status).toBe(412);
		expect((await viaWorker(notify(payload, btoa(JSON.stringify({ kid: "kid-1", signature: "AAAA" }))))).status).toBe(412);
	});

	it("ORDER_CONFIRMATION: fetches the order and creates the Shopify order", async () => {
		const sign = await signer();
		await E.SYNC_STATE.put("meta:ebay_sync_mode", "live");
		await E.SYNC_STATE.put("ebay:item:BOND12081C", JSON.stringify({
			sku: "BOND12081C", status: "listed", offer_id: "OFF-1", listing_id: "LIST-1", selected_at: "x", updated_at: "x",
		}));
		route("GET", /^\/sell\/fulfillment\/v1\/order\/99-1$/, {
			orderId: "99-1", orderPaymentStatus: "PAID", cancelStatus: { cancelState: "NONE_REQUESTED" },
			lineItems: [{ sku: "BOND12081C", quantity: 1 }],
			fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: "X", contactAddress: { countryCode: "DE" } } } }],
		});
		const payload = JSON.stringify({
			metadata: { topic: "ORDER_CONFIRMATION", schemaVersion: "1.0" },
			notification: { notificationId: "n-ord", data: { order: { orderId: "99-1", orderLineItems: [{ listingId: "LIST-1", quantity: 1 }] } } },
		});
		const res = await viaWorker(notify(payload, await sign(payload)));
		expect(res.status).toBe(204);
		expect(shopifyAdmin.createDiscogsOrder).toHaveBeenCalledTimes(1);
		expect(vi.mocked(shopifyAdmin.createDiscogsOrder).mock.calls[0][4]).toBe(shopifyAdmin.EBAY_ORDER_CHANNEL);
	});
});

// ── admin endpoints ─────────────────────────────────────────────────

describe("admin endpoints", () => {
	it("ebay-mode: public GET, Bearer POST, independent of sync35-mode", async () => {
		await E.SYNC_STATE.put("meta:sync_35_mode", "dry");
		expect(await (await viaWorker(new Request("https://w/?action=ebay-mode"))).json())
			.toEqual({ autolist: "dry", sync: "dry", configured: true });
		expect((await viaWorker(post("ebay-mode", { autolist: "live" }, null))).status).toBe(401);
		expect((await viaWorker(post("ebay-mode", { autolist: "on" }))).status).toBe(400);
		const r = await (await viaWorker(post("ebay-mode", { autolist: "live" }))).json() as any;
		expect(r).toMatchObject({ autolist: "live", sync: "dry" });
		expect(await E.SYNC_STATE.get("meta:sync_35_mode")).toBe("dry");
	});

	it("select -> items -> unselect (a live listing is withdrawn first)", async () => {
		expect((await viaWorker(post("ebay-select", { skus: ["A1"] }, null))).status).toBe(401);
		const sel = await (await viaWorker(post("ebay-select", { skus: ["A1", "A1", " A2 "] }))).json() as any;
		expect(sel.results).toEqual([{ sku: "A1", result: "queued" }, { sku: "A2", result: "queued" }]);
		await E.SYNC_STATE.put("ebay:item:A2", JSON.stringify({ sku: "A2", status: "listed", offer_id: "OFF-2", listing_id: "L2", selected_at: "x", updated_at: "x" }));
		const items = await (await viaWorker(new Request("https://w/?action=ebay-items", { headers: { Authorization: `Bearer ${SECRET}` } }))).json() as any;
		expect(items.items.map((i: any) => i.sku).sort()).toEqual(["A1", "A2"]);
		const un = await (await viaWorker(post("ebay-unselect", { skus: ["A1", "A2"] }))).json() as any;
		expect(un.results).toEqual([{ sku: "A1", result: "removed" }, { sku: "A2", result: "withdrawn" }]);
		expect(ebayCalls("POST", /OFF-2\/withdraw/)).toHaveLength(1);
		expect(await E.SYNC_STATE.get("ebay:item:A2")).toBeNull();
	});

	it("ebay-run drives the cron by hand (staging has no eBay cron)", async () => {
		await selectSkus(E, ["BOND12081C"]);
		const r = await (await viaWorker(post("ebay-run", { what: "autolist" }))).json() as any;
		expect(r.autolist).toMatchObject({ mode: "dry", would_list: 1 });
		expect(r.orders).toBeUndefined();
	});
});
