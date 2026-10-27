import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import * as shopifyAdmin from "../src/lib/shopify-admin";
import * as discogs from "../src/lib/discogs";
import {
	buildEbayListing, ebayTitle, gradesFor, conditionFromTags, holdReason, priceFromCost, toSourceProduct, GRADE_MINT, ASPECTS,
	roundUpTo99, stripShippingText,
	type EbaySourceProduct, type EbayPrice,
} from "../src/lib/ebay-listing";
import {
	challengeResponse, derToRawSignature, verifyNotificationSignature, getPolicyIds, EBAY_POLICY_NAMES,
} from "../src/lib/ebay-api";
import {
	runEbayAutolist, pollEbayOrders, includeSkus, requeueEanFailures, withdrawOnEbayForShopifyOrder, runEbayBackfill, runEbayAutoBackfill,
	EBAY_CRON, EBAY_BATCH_SIZE, EBAY_CHECKS_PER_RUN, EBAY_DISCOGS_READS_PER_RUN, EBAY_BACKFILL_FIRST, EBAY_BACKFILL_NEXT,
} from "../src/lib/ebay";
import { runRelinkCron } from "../src/lib/sync";

vi.mock("../src/lib/shopify-admin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/shopify-admin")>();
	return {
		...actual, shopifyAdminGraphQL: vi.fn(), findVariantBySkuLoose: vi.fn(), getVariantsStock: vi.fn(),
		createDiscogsOrder: vi.fn(), validateShopifyWebhookHmac: vi.fn(), searchVariantsBySkus: vi.fn(),
	};
});
vi.mock("../src/lib/discogs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/discogs")>();
	return { ...actual, getListing: vi.fn(), updateListingStatus: vi.fn(), getInventory: vi.fn(), searchRelease: vi.fn() };
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
	variant: { id: "gid://shopify/ProductVariant/9", sku: "BOND12081C", price: "14.99", barcode: "4006381333931", inventoryQuantity: 2, unitCost: 9.5, ...v },
	...over,
});
const CFG = {
	categoryId: "176985", merchantLocationKey: "madrid",
	policies: { fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1" },
};
const DISCOGS_PRICE: EbayPrice = { value: 21.5, source: "discogs", detail: "Discogs listing 555" };
// Admin API node as PRODUCT_BY_SKU_QUERY returns it.
const node = (p = product()) => ({
	id: p.productId, status: p.status, title: p.title, vendor: p.vendor, tags: p.tags, descriptionHtml: p.descriptionHtml,
	media: { nodes: p.images.map(url => ({ image: { url } })) },
	variants: { nodes: [{ ...p.variant, inventoryItem: p.variant.unitCost ? { unitCost: { amount: String(p.variant.unitCost), currencyCode: "EUR" } } : null }] },
});

// ── Shopify + Discogs fakes ─────────────────────────────────────────
// catalog: what the Admin API knows, by SKU. backfillList: the catalogue in
// CREATED_AT order for the backfill query. listings: our Discogs listings.
let catalog: Map<string, EbaySourceProduct>;
let backfillList: string[];
let listings: Map<number, any>;
const addProduct = (sku: string, over: Partial<EbaySourceProduct> = {}, v: Partial<EbaySourceProduct["variant"]> = {}) =>
	catalog.set(sku, product(over, { sku, ...v }));
const linkDiscogs = async (sku: string, listingId: number, listing: any = {}) => {
	await E.SYNC_STATE.put(`sku:${sku}`, JSON.stringify({ listing_id: listingId, status: "For Sale", synced_at: "x" }));
	listings.set(listingId, { id: listingId, status: "For Sale", price: { value: 21.5, currency: "EUR" }, condition: "Near Mint (NM or M-)", sleeve_condition: "Near Mint (NM or M-)", ...listing });
};
function installShopifyAndDiscogs() {
	catalog = new Map();
	backfillList = [];
	listings = new Map();
	addProduct("BOND12081C");
	vi.mocked(shopifyAdmin.shopifyAdminGraphQL).mockImplementation(async (_e, q: string, vars: any) => {
		if (q.includes("ebayProductBySku")) {
			const sku = /sku:"(.+)"/.exec(vars.q)![1];
			const p = catalog.get(sku);
			return { data: { products: { nodes: p ? [node(p)] : [] } } } as any;
		}
		if (q.includes("ebayBackfill")) {
			const start = vars.after ? Number(vars.after) : 0;
			const slice = backfillList.slice(start, start + vars.first);
			const end = start + slice.length;
			return { data: { products: {
				pageInfo: { hasNextPage: end < backfillList.length, endCursor: String(end) },
				nodes: slice.map(sku => ({ variants: { nodes: [{ sku }] } })),
			} } } as any;
		}
		return { data: { orders: { pageInfo: { hasNextPage: false }, nodes: [] }, productVariants: { nodes: [] } } } as any;
	});
	vi.mocked(discogs.getListing).mockImplementation(async (_t, id: number) => {
		const l = listings.get(id);
		if (!l) throw new Error(`Discogs getListing failed: 404`);
		return l;
	});
}

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
	route("GET", /^\/sell\/account\/v1\/privilege$/, { sellerRegistrationCompleted: true });
	route("GET", /^\/sell\/account\/v1\/subscription/, { total: 1, subscriptions: [{ subscriptionType: "STORE_PLAN", subscriptionLevel: "Featured", subscriptionId: "681522847", marketplaceId: "EBAY_ES", term: { value: 1, unit: "MONTH" } }] });
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
	installShopifyAndDiscogs();
	await linkDiscogs("BOND12081C", 555);
	vi.mocked(shopifyAdmin.findVariantBySkuLoose).mockResolvedValue({ variantId: "gid://shopify/ProductVariant/9", sku: "BOND12081C" } as any);
	vi.mocked(shopifyAdmin.getVariantsStock).mockImplementation(async (_e, ids) => new Map(ids.map(id => [id, 1])));
	vi.mocked(shopifyAdmin.createDiscogsOrder).mockResolvedValue({ ok: true, orderId: "gid://shopify/Order/7", orderName: "#1077" } as any);
});
afterEach(() => { vi.restoreAllMocks(); });

const item = async (sku: string) => JSON.parse(await E.SYNC_STATE.get(`ebay:item:${sku}`));
const live = () => E.SYNC_STATE.put("meta:ebay_autolist_mode", "live");

// ── listing content ─────────────────────────────────────────────────

describe("listing content from the Shopify product", () => {
	it("maps title, artist, label, catno, genre, images and grades; price is the one passed in", () => {
		const p = buildEbayListing(product(), gradesFor(product().tags)!, DISCOGS_PRICE, { ...CFG, withEan: true });
		const pr = p.inventoryItem.product;
		expect(pr.title).toBe("Dilby & Pornbugs - Between Us BOND12081C Vinilo");
		expect(pr.aspects[ASPECTS.artist]).toEqual(["Dilby & Pornbugs"]);
		expect(pr.aspects[ASPECTS.label]).toEqual(["Bond Street"]);
		expect(pr.aspects[ASPECTS.catno]).toEqual(["BOND12081C"]);
		expect(pr.aspects[ASPECTS.genre]).toEqual(["DJ, dance, house"]);
		expect(pr.aspects[ASPECTS.subgenre]).toEqual(["House"]);
		// Only eBay's names plus label/catno; no grades on a NEW record.
		expect(Object.keys(pr.aspects).sort()).toEqual(["Artista", "Discográfica", "Género", "Número de catálogo", "Subgénero"]);
		expect(pr.imageUrls).toEqual(["https://cdn.shopify.com/s/files/a.jpg"]);
		expect(pr.ean).toEqual(["4006381333931"]);
		expect(p.inventoryItem.condition).toBe("NEW");
		expect(p.inventoryItem.availability.shipToLocationAvailability.quantity).toBe(1);
		expect(p.offer).toMatchObject({
			sku: "BOND12081C", marketplaceId: "EBAY_ES", format: "FIXED_PRICE", categoryId: "176985",
			availableQuantity: 1, merchantLocationKey: "madrid", includeCatalogProductDetails: false,
			// Discogs price, NOT the Shopify 14.99.
			pricingSummary: { price: { value: "21.50", currency: "EUR" } },
			listingPolicies: { fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1" },
		});
	});

	it("refuses to build without a price", () => {
		expect(() => buildEbayListing(product(), gradesFor([])!, { value: 0, source: "cost", detail: "" }, { ...CFG, withEan: true })).toThrow();
	});

	it("cost price: unitCost x multiplier, nothing without a cost", () => {
		expect(priceFromCost(product(), 2)).toEqual({ value: 19, source: "cost", detail: "cost 9.50 × 2" });
		expect(priceFromCost(product({}, { unitCost: 7.33 }), 2.5)?.value).toBe(18.33);
		expect(priceFromCost(product({}, { unitCost: null }), 2)).toBeNull();
	});

	it("never adds Canarias / exclusion text and strips active content", () => {
		const p = buildEbayListing(product(), gradesFor([])!, DISCOGS_PRICE, { ...CFG, withEan: true });
		expect(JSON.stringify(p)).not.toMatch(/canari|excluid|península/i);
		expect(p.offer.listingDescription).not.toMatch(/<script/i);
		expect(p.offer.listingDescription).toContain("<p>Deep cuts.</p>");
	});

	it("drops shipping sentences from the Shopify description, keeps the rest", () => {
		const html = '<p>Tracklist</p><p>12" vinyl. Worldwide shipping from House Only.</p><p>Envío desde Madrid. Gran disco.</p>';
		expect(stripShippingText(html)).toBe('<p>Tracklist</p><p>12" vinyl.</p><p> Gran disco.</p>');
		expect(stripShippingText("<p>Worldwide shipping from House Only.</p>")).toBe("");
		const p = buildEbayListing(product({ descriptionHtml: html }), gradesFor([])!, DISCOGS_PRICE, { ...CFG, withEan: true });
		expect(JSON.stringify(p)).not.toMatch(/shipping|env[ií]o/i);
		expect(p.offer.listingDescription).toContain('12" vinyl.');
		expect(p.inventoryItem.product.description).toContain("Gran disco.");
	});

	it("NEW: no grades in aspects or the table; used: grades in both, plus conditionDescription", () => {
		const nm = { condition: "Near Mint (NM or M-)", sleeve_condition: "Very Good Plus (VG+)" };
		const n = buildEbayListing(product(), gradesFor(product().tags, nm)!, DISCOGS_PRICE, { ...CFG, withEan: true });
		expect(n.offer.listingDescription).not.toMatch(/Near Mint|<b>Disco<\/b>|<b>Funda<\/b>/);
		expect(n.inventoryItem.product.aspects[ASPECTS.mediaGrade]).toBeUndefined();
		expect(n.inventoryItem.conditionDescription).toBeUndefined();
		const usedTags = [...product().tags, "used"];
		const u = buildEbayListing(product({ tags: usedTags }), gradesFor(usedTags, nm)!, DISCOGS_PRICE, { ...CFG, withEan: true });
		expect(u.inventoryItem.condition).toBe("USED_EXCELLENT");
		expect(u.inventoryItem.product.aspects[ASPECTS.sleeveGrade]).toEqual(["Very Good Plus (VG+)"]);
		expect(u.offer.listingDescription).toContain("<b>Funda</b></td><td>Very Good Plus (VG+)");
		expect(u.inventoryItem.conditionDescription).toBe("Disco: Near Mint (NM or M-) · Funda: Very Good Plus (VG+)");
	});

	it("maps our genres to eBay's Genero/Subgenero; no genre tag, no genre aspect", () => {
		const g = (tag: string) => buildEbayListing(product({ tags: ["label:X", tag] }), gradesFor([])!, DISCOGS_PRICE, { ...CFG, withEan: true }).inventoryItem.product.aspects;
		expect(g("genre:techno")).toMatchObject({ "Género": ["DJ, dance, house"], "Subgénero": ["Techno, electro"] });
		expect(g("genre:jazz")["Género"]).toEqual(["Jazz"]);
		expect(g("genre:jazz")["Subgénero"]).toBeUndefined();
		expect(g("vinyl")["Género"]).toBeUndefined();
	});

	it("roundUpTo99: up to the next .99", () => {
		expect(roundUpTo99(12.97)).toBe(12.99);
		expect(roundUpTo99(21.23)).toBe(21.99);
		expect(roundUpTo99(12.99)).toBe(12.99);
		expect(roundUpTo99(24)).toBe(24.99);
		expect(roundUpTo99(14.15)).toBe(14.99);
		expect(roundUpTo99(0.5)).toBe(0.99);
	});

	it("uses the Discogs grades when linked, Mint for new stock otherwise", () => {
		expect(gradesFor([], { condition: "Near Mint (NM or M-)", sleeve_condition: "Very Good Plus (VG+)" }))
			.toEqual({ media: "Near Mint (NM or M-)", sleeve: "Very Good Plus (VG+)", source: "discogs" });
		expect(gradesFor(["condition:sealed"])).toEqual({ media: GRADE_MINT, sleeve: GRADE_MINT, source: "condition-tag" });
		expect(gradesFor(["used"])).toBeNull();
		expect(conditionFromTags(["condition:used-vg"])).toBe("USED_EXCELLENT");
	});

	it("drops an invalid barcode and keeps the title within 80 chars", () => {
		const p = buildEbayListing(product({}, { barcode: "123" }), gradesFor([])!, DISCOGS_PRICE, { ...CFG, withEan: true });
		expect(p.inventoryItem.product.ean).toEqual(["No aplicable"]);
		expect(ebayTitle("A Very Long Artist Name Indeed", "An Extremely Long Title That Goes On And On Forever More", "CAT001").length).toBeLessThanOrEqual(80);
		expect(ebayTitle("Artist", "Title", "X1")).toBe("Artist - Title X1 Vinilo");
	});

	it("holds what cannot be sold right now", () => {
		expect(holdReason(product({ tags: ["forthcoming"] }))).toBe("forthcoming");
		expect(holdReason(product({}, { inventoryQuantity: 0 }))).toBe("sin_stock");
		expect(holdReason(product({ images: [] }))).toBe("sin_imagen");
		expect(holdReason(product({ status: "DRAFT" }))).toBe("no_activo");
		expect(holdReason(product())).toBeNull();
	});

	it("picks the exact SKU variant out of the Admin search, with its unit cost", () => {
		const other = { ...node(), variants: { nodes: [{ ...product().variant, sku: "BOND12081" }] } };
		expect(toSourceProduct([other, node()], "BOND12081C")?.variant).toMatchObject({ sku: "BOND12081C", unitCost: 9.5 });
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
		expect(ebayCalls("GET", /get_by_policy_name/)).toHaveLength(3);
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

// ── how records get in ──────────────────────────────────────────────

describe("new Shopify products are queued automatically (products/create)", () => {
	const productCreate = (body: any, qs = "") => new Request(`https://w/?action=webhook-shopify-product${qs}`, {
		method: "POST", body: JSON.stringify(body), headers: { "x-shopify-hmac-sha256": "x" },
	});
	beforeEach(() => { vi.mocked(shopifyAdmin.validateShopifyWebhookHmac).mockResolvedValue(true); });

	it("eBay live: queued, even when the Discogs filters skip the product", async () => {
		await live();
		// No source: tag → the Discogs auto-add ignores it; eBay still takes it.
		const r = await (await viaWorker(productCreate({ id: 1, tags: "vinyl", variants: [{ sku: "NEW001" }] }))).json() as any;
		expect(r).toMatchObject({ reason: "no recognized source tag", ebay: "queued" });
		expect((await item("NEW001"))).toMatchObject({ status: "queued", origin: "webhook" });
		expect(discogs.searchRelease).not.toHaveBeenCalled();
	});

	it("eBay dry: not queued", async () => {
		const r = await (await viaWorker(productCreate({ id: 2, tags: "vinyl", variants: [{ sku: "NEW002" }] }))).json() as any;
		expect(r.ebay).toBe("off");
		expect(await E.SYNC_STATE.get("ebay:item:NEW002")).toBeNull();
	});

	it("an excluded record is never re-queued, and ?sync=1 re-sends don't queue", async () => {
		await live();
		await viaWorker(post("ebay-exclude", { skus: ["NEW003"] }));
		const r = await (await viaWorker(productCreate({ id: 3, tags: "vinyl", variants: [{ sku: "NEW003" }] }))).json() as any;
		expect(r.ebay).toBe("exists");
		expect((await item("NEW003")).status).toBe("excluded");
		await viaWorker(productCreate({ id: 4, tags: "vinyl", variants: [{ sku: "OLD004" }] }, "&sync=1"));
		expect(await E.SYNC_STATE.get("ebay:item:OLD004")).toBeNull();
	});
});

describe("backfill of the existing catalogue", () => {
	beforeEach(() => { backfillList = Array.from({ length: 60 }, (_, i) => `CAT${String(i).padStart(3, "0")}`); });

	it(`first batch is ${EBAY_BACKFILL_FIRST}, then ${EBAY_BACKFILL_NEXT}, resuming where it stopped`, async () => {
		const a = await runEbayBackfill(E);
		expect(a.queued).toEqual(["CAT000", "CAT001", "CAT002", "CAT003", "CAT004"]);
		// Even asking for more, the first batch stays small.
		await E.SYNC_STATE.delete("meta:ebay_backfill");
		for (const s of a.queued) await E.SYNC_STATE.delete(`ebay:item:${s}`);
		expect((await runEbayBackfill(E, { count: 50 })).queued).toHaveLength(EBAY_BACKFILL_FIRST);
		const b = await runEbayBackfill(E);
		expect(b.queued[0]).toBe("CAT005");
		expect(b.queued).toHaveLength(EBAY_BACKFILL_NEXT);
		expect((await item("CAT005")).origin).toBe("backfill");
	});

	it("skips records already in the queue (excluded stays excluded) without counting them", async () => {
		await viaWorker(post("ebay-exclude", { skus: ["CAT001"] }));
		const a = await runEbayBackfill(E);
		expect(a.queued).toEqual(["CAT000", "CAT002", "CAT003", "CAT004", "CAT005"]);
		expect(a.already_in_queue).toBe(1);
		expect((await item("CAT001")).status).toBe("excluded");
	});

	it("respects the monthly selling limit from getPrivileges", async () => {
		route("GET", /^\/sell\/account\/v1\/privilege$/, { sellingLimit: { quantity: 7 } });
		await runEbayBackfill(E);                               // 5 queued
		const b = await runEbayBackfill(E);                     // room for 2 more
		expect(b).toMatchObject({ selling_limit: 7, batch: 2 });
		expect(b.queued).toHaveLength(2);
		const c = await runEbayBackfill(E);
		expect(c.ok).toBe(false);
		expect(c.error).toMatch(/selling limit 7/);
	});

	it("refused while the 25026 pause is on (endpoint answers 409)", async () => {
		await E.SYNC_STATE.put("meta:ebay_limit_hit", JSON.stringify({ until: new Date(Date.now() + 3600e3).toISOString() }));
		const r = await viaWorker(post("ebay-backfill", {}));
		expect(r.status).toBe(409);
		expect(await E.SYNC_STATE.get("ebay:item:CAT000")).toBeNull();
	});

	it("reports done at the end of the catalogue", async () => {
		backfillList = ["A1", "A2"];
		const r = await runEbayBackfill(E);
		expect(r).toMatchObject({ done: true, queued: ["A1", "A2"] });
		expect((await runEbayBackfill(E)).queued).toEqual([]);
	});
});

describe("continuous backfill (cron)", () => {
	const livePass = (over: any = {}) => ({ ok: true, mode: "live", checked: 0, listed: 0, would_list: 0, held: 0, failed: 0, held_by_reason: {}, pending: 0, finished_at: "", ...over }) as any;
	beforeEach(async () => {
		backfillList = Array.from({ length: 60 }, (_, i) => `CAT${String(i).padStart(3, "0")}`);
		await E.SYNC_STATE.put("meta:ebay_backfill", JSON.stringify({ cursor: "5", batches: 1, done: false, queued: 5 }));
		await E.SYNC_STATE.put("meta:ebay_autolist_mode", "live");
	});

	it(`queues the next ${EBAY_BACKFILL_NEXT} when nothing is queued or would_list (held records don't block)`, async () => {
		addProduct("WAIT01"); await includeSkus(E, ["WAIT01"]);
		await runEbayAutolist(E);                                   // no Discogs listing: held
		expect((await item("WAIT01")).status).toBe("held");
		const r: any = await runEbayAutoBackfill(E, livePass());
		expect(r.queued).toHaveLength(EBAY_BACKFILL_NEXT);
		expect(r.queued[0]).toBe("CAT005");
		expect(JSON.parse(await E.SYNC_STATE.get("meta:ebay_autobackfill_last_run")).queued).toHaveLength(EBAY_BACKFILL_NEXT);
	});

	it("waits while something is still queued or would_list", async () => {
		await includeSkus(E, ["BOND12081C"]);
		expect(await runEbayAutoBackfill(E, livePass())).toEqual({ skipped: "1 still waiting to publish" });
		expect(await E.SYNC_STATE.get("ebay:item:CAT005")).toBeNull();
	});

	it("does nothing in dry, after a stopped pass, during the 25026 pause, at the end, or when off", async () => {
		expect(await runEbayAutoBackfill(E, livePass({ mode: "dry" }))).toEqual({ skipped: "autolist not live" });
		expect(await runEbayAutoBackfill(E, livePass({ stopped: "cooldown" }))).toEqual({ skipped: "pass stopped: cooldown" });
		expect(await runEbayAutoBackfill(E, livePass({ mode: "dry", store_guard: "no_store" }))).toEqual({ skipped: "no eBay store (no_store)" });
		await E.SYNC_STATE.put("meta:ebay_limit_hit", JSON.stringify({ until: new Date(Date.now() + 3600e3).toISOString() }));
		expect(await runEbayAutoBackfill(E, livePass())).toMatchObject({ ok: false, error: expect.stringMatching(/selling limit/) });
		await E.SYNC_STATE.delete("meta:ebay_limit_hit");
		await E.SYNC_STATE.put("meta:ebay_autobackfill_mode", "off");
		expect(await runEbayAutoBackfill(E, livePass())).toEqual({ skipped: "off" });
		await E.SYNC_STATE.delete("meta:ebay_autobackfill_mode");
		await E.SYNC_STATE.put("meta:ebay_backfill", JSON.stringify({ cursor: "60", batches: 3, done: true, queued: 60 }));
		expect(await runEbayAutoBackfill(E, livePass())).toMatchObject({ done: true, queued: [] });
		expect(await E.SYNC_STATE.get("ebay:item:CAT005")).toBeNull();
	});
});

// ── auto-list & price ───────────────────────────────────────────────

describe("auto-list cron and price sources", () => {
	it("does nothing with an empty queue - not even a token", async () => {
		await live();
		expect(await runEbayAutolist(E)).toMatchObject({ checked: 0, listed: 0 });
		expect(calls).toHaveLength(0);
	});

	it("dry: prices from Discogs and builds the listing, calls no eBay endpoint", async () => {
		await includeSkus(E, ["BOND12081C"]);
		const r = await runEbayAutolist(E);
		expect(r).toMatchObject({ mode: "dry", would_list: 1 });
		expect(calls).toHaveLength(0);
		const it = await item("BOND12081C");
		expect(it.status).toBe("would_list");
		// Discogs 21.50, rounded up to .99.
		expect(it.preview).toMatchObject({ price: "21.99", price_source: "Discogs listing 555 (21.50 → 21.99)", condition: "NEW" });
	});

	it("live: lists at the CURRENT Discogs listing price, never the Shopify price", async () => {
		await live();
		listings.get(555).price = { value: 24.0, currency: "EUR" };     // repriced on Discogs
		await includeSkus(E, ["BOND12081C"]);
		const r = await runEbayAutolist(E);
		expect(r).toMatchObject({ mode: "live", listed: 1, failed: 0 });
		const seq = ebayCalls().filter(c => /inventory_item|offer/.test(c.path)).map(c => `${c.method} ${c.path.split("?")[0]}`);
		expect(seq).toEqual([
			"PUT /sell/inventory/v1/inventory_item/BOND12081C",
			"GET /sell/inventory/v1/offer",
			"POST /sell/inventory/v1/offer",
			"POST /sell/inventory/v1/offer/OFF-1/publish",
		]);
		expect(ebayCalls("POST", /offer$/)[0].body.pricingSummary.price).toEqual({ value: "24.99", currency: "EUR" });
		expect(ebayCalls("PUT", /inventory_item/)[0].headers["Content-Language"]).toBe("es-ES");
		expect(await item("BOND12081C")).toMatchObject({ status: "listed", offer_id: "OFF-1", listing_id: "LIST-1" });
		expect(await E.SYNC_STATE.get("ebay:listing:LIST-1")).toBe("BOND12081C");
	});

	it("no Discogs listing yet: held, re-checked every run, listed once the listing exists", async () => {
		await live();
		addProduct("HAND01");
		await includeSkus(E, ["HAND01"]);
		await runEbayAutolist(E);
		expect(await item("HAND01")).toMatchObject({ status: "held", hold_reason: "esperando_discogs" });
		expect(ebayCalls("PUT")).toHaveLength(0);
		await runEbayAutolist(E);
		expect((await item("HAND01")).status).toBe("held");
		// The relink cron maps the hand-made Discogs listing.
		await linkDiscogs("HAND01", 777, { price: { value: 30, currency: "EUR" } });
		await runEbayAutolist(E);
		expect(await item("HAND01")).toMatchObject({ status: "listed" });
		expect(ebayCalls("POST", /offer$/).at(-1)!.body.pricingSummary.price.value).toBe("30.99");
	});

	it("Discogs listing sold or in another currency: held, not listed", async () => {
		await live();
		addProduct("SOLD01"); await linkDiscogs("SOLD01", 801, { status: "Sold" });
		addProduct("USD01"); await linkDiscogs("USD01", 802, { price: { value: 20, currency: "USD" } });
		await includeSkus(E, ["SOLD01", "USD01"]);
		await runEbayAutolist(E);
		expect((await item("SOLD01")).hold_reason).toBe("discogs_no_disponible");
		expect((await item("USD01")).hold_reason).toBe("discogs_no_eur");
		expect(ebayCalls("PUT")).toHaveLength(0);
	});

	it("discogs:no with unit cost: cost x 2 (multiplier from KV)", async () => {
		await live();
		addProduct("NODISC1", { tags: ["vinyl", "discogs:no"] }, { unitCost: 8 });
		await includeSkus(E, ["NODISC1"]);
		await runEbayAutolist(E);
		expect(ebayCalls("POST", /offer$/)[0].body.pricingSummary.price.value).toBe("16.00");
		expect(discogs.getListing).not.toHaveBeenCalled();
		await E.SYNC_STATE.put("meta:ebay_cost_multiplier", "2.5");
		addProduct("NODISC2", { tags: ["discogs:no"] }, { unitCost: 8 });
		await includeSkus(E, ["NODISC2"]);
		await runEbayAutolist(E);
		expect(ebayCalls("POST", /offer$/).at(-1)!.body.pricingSummary.price.value).toBe("20.00");
	});

	it("discogs:no without unit cost: held as 'no price source', never listed", async () => {
		await live();
		addProduct("NOCOST", { tags: ["discogs:no"] }, { unitCost: null });
		await includeSkus(E, ["NOCOST"]);
		const r = await runEbayAutolist(E);
		expect(r.held_by_reason).toEqual({ sin_fuente_de_precio: 1 });
		expect(await item("NOCOST")).toMatchObject({ status: "held", hold_reason: "sin_fuente_de_precio" });
		expect(ebayCalls("PUT")).toHaveLength(0);
		const items = await (await viaWorker(new Request("https://w/?action=ebay-items", { headers: { Authorization: `Bearer ${SECRET}` } }))).json() as any;
		expect(items.holds).toEqual({ sin_fuente_de_precio: 1 });
		expect(items.items.find((i: any) => i.sku === "NOCOST")).toMatchObject({ s: "held", r: "sin_fuente_de_precio" });
	});

	it("takes the grades of our Discogs listing (used record)", async () => {
		await live();
		addProduct("USED01", { tags: ["vinyl", "used"] });
		await linkDiscogs("USED01", 556, { sleeve_condition: "Very Good Plus (VG+)" });
		await includeSkus(E, ["USED01"]);
		await runEbayAutolist(E);
		expect(ebayCalls("PUT", /inventory_item/)[0].body.product.aspects[ASPECTS.sleeveGrade]).toEqual(["Very Good Plus (VG+)"]);
	});

	it(`spends at most ${EBAY_DISCOGS_READS_PER_RUN} Discogs reads and ${EBAY_CHECKS_PER_RUN} checks per run`, async () => {
		for (let i = 0; i < EBAY_CHECKS_PER_RUN + 5; i++) {
			const sku = `M${String(i).padStart(2, "0")}`;
			addProduct(sku); await linkDiscogs(sku, 1000 + i);
		}
		await includeSkus(E, [...catalog.keys()].filter(s => s.startsWith("M")));
		E.SYNC_STATE.put("meta:ebay_autolist_mode", "dry");
		const r = await runEbayAutolist(E);
		expect(vi.mocked(discogs.getListing).mock.calls.length).toBeLessThanOrEqual(EBAY_DISCOGS_READS_PER_RUN);
		expect(r.would_list).toBe(EBAY_BATCH_SIZE);
		expect(r.checked).toBeLessThanOrEqual(EBAY_CHECKS_PER_RUN);
	});

	it("no eBay store subscription: the switch says live but the pass runs dry, publishes nothing", async () => {
		route("GET", /^\/sell\/account\/v1\/subscription/, { total: 0 });
		await live();
		await includeSkus(E, ["BOND12081C"]);
		const r = await runEbayAutolist(E);
		expect(r).toMatchObject({ mode: "dry", store_guard: "no_store", listed: 0, would_list: 1 });
		expect(ebayCalls("PUT")).toHaveLength(0);
		expect(ebayCalls("POST", /offer/)).toHaveLength(0);
		expect(await E.SYNC_STATE.get("meta:ebay_autolist_mode")).toBe("live");   // the switch itself is untouched
		expect(JSON.parse(await E.SYNC_STATE.get("meta:ebay_store_check"))).toMatchObject({ has_store: false, subscriptions: [] });
	});

	it("store check: only STORE_PLAN on EBAY_ES counts; a failed check means dry", async () => {
		route("GET", /^\/sell\/account\/v1\/subscription/, { total: 2, subscriptions: [
			{ subscriptionType: "SELLING_MANAGER", marketplaceId: "EBAY_ES" },
			{ subscriptionType: "STORE_PLAN", marketplaceId: "EBAY_DE" },
		] });
		await live();
		await includeSkus(E, ["BOND12081C"]);
		expect(await runEbayAutolist(E)).toMatchObject({ mode: "dry", store_guard: "no_store" });
		route("GET", /^\/sell\/account\/v1\/subscription/, () => ebayError(500, 1000, "boom"));
		await viaWorker(post("ebay-exclude", { skus: ["BOND12081C"] })); await includeSkus(E, ["BOND12081C"]);
		expect(await runEbayAutolist(E)).toMatchObject({ mode: "dry", store_guard: "check_failed", listed: 0 });
		expect(ebayCalls("POST", /publish/)).toHaveLength(0);
	});

	it("with a store the pass publishes as before (and the admin sees the check)", async () => {
		await live();
		await includeSkus(E, ["BOND12081C"]);
		const r = await runEbayAutolist(E);
		expect(r.store_guard).toBeUndefined();
		expect(r).toMatchObject({ mode: "live", listed: 1 });
		const items = await (await viaWorker(new Request("https://w/?action=ebay-items", { headers: { Authorization: `Bearer ${SECRET}` } }))).json() as any;
		expect(items.store).toMatchObject({ has_store: true, subscriptions: [{ type: "STORE_PLAN", level: "Featured", marketplace: "EBAY_ES" }] });
	});

	it("Discogs 429: held, no further Discogs reads this run, flagged for the cron", async () => {
		addProduct("R1"); await linkDiscogs("R1", 901);
		addProduct("R2"); await linkDiscogs("R2", 902);
		vi.mocked(discogs.getListing).mockRejectedValue(new Error('Discogs getListing failed: 429 {"message":"You are making requests too quickly."}'));
		await includeSkus(E, ["R1", "R2"]);
		const r = await runEbayAutolist(E);
		expect(r.discogs_429).toBe(true);
		expect(discogs.getListing).toHaveBeenCalledTimes(1);
		expect(r.held_by_reason).toEqual({ discogs_error: 2 });
		expect(r.listed + r.would_list).toBe(0);
	});

	it("held records come round: the oldest check goes first", async () => {
		await live();
		for (let i = 0; i < EBAY_CHECKS_PER_RUN + 10; i++) addProduct(`W${String(i).padStart(2, "0")}`);   // none on Discogs
		await includeSkus(E, [...catalog.keys()].filter(s => s.startsWith("W")));
		await runEbayAutolist(E);
		const first = await item("W00");
		const unchecked = await item(`W${EBAY_CHECKS_PER_RUN + 5}`);
		expect(first.checked_at).toBeDefined();
		expect(unchecked.checked_at).toBeUndefined();
		await runEbayAutolist(E);
		expect((await item(`W${EBAY_CHECKS_PER_RUN + 5}`)).checked_at).toBeDefined();
	});

	it("does not touch the Discogs auto-add switch", async () => {
		await E.SYNC_STATE.put("meta:sync_35_mode", "dry");
		await live();
		await includeSkus(E, ["BOND12081C"]);
		await runEbayAutolist(E);
		expect(await E.SYNC_STATE.get("meta:sync_35_mode")).toBe("dry");
		expect(discogs.updateListingStatus).not.toHaveBeenCalled();
	});

	it("selling limit (25026): stops the batch, keeps records pending, pauses the cron", async () => {
		await live();
		route("POST", /\/publish$/, () => ebayError(400, 25026, "Selling limit exceeded."));
		for (const s of ["A1", "A2", "A3"]) { addProduct(s); await linkDiscogs(s, s.charCodeAt(1)); }
		await includeSkus(E, ["A1", "A2", "A3"]);
		const r = await runEbayAutolist(E);
		expect(r).toMatchObject({ stopped: "selling_limit", failed: 0, pending: 3 });
		expect(ebayCalls("POST", /\/publish$/)).toHaveLength(1);
		for (const s of ["A1", "A2", "A3"]) expect((await item(s)).status).toBe("queued");
		calls.length = 0;
		expect((await runEbayAutolist(E)).stopped).toBe("cooldown");
		expect(ebayCalls()).toHaveLength(0);
	});

	it("catalogue match refused: retries once as a standalone listing (no EAN)", async () => {
		await live();
		let n = 0;
		route("POST", /\/publish$/, () => (n++ === 0 ? ebayError(400, 25604, "Product not found for the EAN.") : jsonResponse({ listingId: "LIST-2" })));
		await includeSkus(E, ["BOND12081C"]);
		expect((await runEbayAutolist(E)).listed).toBe(1);
		const puts = ebayCalls("PUT", /inventory_item/);
		expect(puts[0].body.product.ean).toEqual(["4006381333931"]);
		expect(puts[1].body.product.ean).toEqual(["No aplicable"]);   // EAN is required on EBAY_ES
	});

	it("no barcode: sends eBay Spain's 'No aplicable' as the EAN (25002 otherwise)", async () => {
		await live();
		addProduct("NOEAN1", {}, { barcode: "" });
		addProduct("BADEAN", {}, { barcode: "123" });                  // not a valid GTIN
		await linkDiscogs("NOEAN1", 950); await linkDiscogs("BADEAN", 951);
		await includeSkus(E, ["NOEAN1", "BADEAN"]);
		expect((await runEbayAutolist(E)).listed).toBe(2);
		for (const c of ebayCalls("PUT", /inventory_item/)) expect(c.body.product.ean).toEqual(["No aplicable"]);
	});

	it("records that failed on the empty EAN (25002) are re-queued and publish on the next pass", async () => {
		await live();
		addProduct("AOW003", {}, { barcode: "" }); await linkDiscogs("AOW003", 960);
		addProduct("OTHERF"); await linkDiscogs("OTHERF", 961);
		await includeSkus(E, ["AOW003", "OTHERF"]);
		const fail = (sku: string, error: string) => E.SYNC_STATE.get(`ebay:item:${sku}`).then(async (raw: string) => {
			const it = JSON.parse(raw);
			await E.SYNC_STATE.put(`ebay:item:${sku}`, JSON.stringify({ ...it, status: "failed", error }), { metadata: { s: "failed", a: it.selected_at } });
		});
		await fail("AOW003", "eBay 400 25002: A user error has occurred. El campo EAN está vacío. Añade EAN al anuncio y vuelve a intentarlo.");
		await fail("OTHERF", "eBay 400 25002: A user error has occurred. Falta la marca.");
		expect(await requeueEanFailures(E)).toEqual(["AOW003"]);
		expect((await item("OTHERF")).status).toBe("failed");          // other errors stay failed
		expect(await runEbayAutolist(E)).toMatchObject({ listed: 1 });
		expect(await item("AOW003")).toMatchObject({ status: "listed" });
	});

	it("a refused record is marked failed and the batch carries on", async () => {
		await live();
		route("PUT", /inventory_item/, () => ebayError(400, 25005, "Invalid category ID."));
		for (const s of ["B1", "B2"]) { addProduct(s, {}, { barcode: null }); await linkDiscogs(s, s.charCodeAt(1) + 100); }
		await includeSkus(E, ["B1", "B2"]);
		expect(await runEbayAutolist(E)).toMatchObject({ failed: 2, listed: 0 });
		expect((await item("B1")).error).toContain("25005");
	});

	it("live without keys: stops as not_configured, no calls", async () => {
		delete E.EBAY_REFRESH_TOKEN;
		await live();
		await includeSkus(E, ["BOND12081C"]);
		expect((await runEbayAutolist(E)).stopped).toBe("not_configured");
		expect(calls).toHaveLength(0);
	});

	it("a pre-order is held until it graduates", async () => {
		await live();
		addProduct("PRE1", { tags: ["forthcoming"] }); await linkDiscogs("PRE1", 901);
		await includeSkus(E, ["PRE1"]);
		await runEbayAutolist(E);
		expect((await item("PRE1")).hold_reason).toBe("forthcoming");
		addProduct("PRE1");                                   // graduated
		await runEbayAutolist(E);
		expect((await item("PRE1")).status).toBe("listed");
	});
});

// ── SKU↔Discogs reconciliation on the cron ──────────────────────────

describe("relink cron keeps sku: mappings current for hand-made listings", () => {
	const inv = (pages: number, ls: any[]) => ({ pagination: { page: 1, pages, items: ls.length, per_page: 100 }, listings: ls });
	beforeEach(() => {
		vi.mocked(shopifyAdmin.searchVariantsBySkus).mockResolvedValue([
			{ id: "gid://v/1", sku: "HAND01", inventoryQuantity: 1, title: "Hand made", status: "ACTIVE" },
		] as any);
	});

	it("maps a listing with no external_id by its catno, one page per run", async () => {
		vi.mocked(discogs.getInventory).mockResolvedValue(inv(2, [
			{ id: 777, status: "For Sale", release: { catalog_number: "HAND01", description: "x" }, price: { value: 30, currency: "EUR" } },
		]) as any);
		const r = await runRelinkCron(E);
		expect(r).toMatchObject({ ok: true, status: "For Sale", page: 1, pages: 2 });
		expect(JSON.parse(await E.SYNC_STATE.get("sku:HAND01")).listing_id).toBe(777);
		expect(discogs.getInventory).toHaveBeenCalledTimes(1);
		expect(JSON.parse(await E.SYNC_STATE.get("meta:relink_cron_cursor"))).toEqual({ status: "For Sale", page: 2 });
	});

	it("walks For Sale, then Draft, then starts over", async () => {
		vi.mocked(discogs.getInventory).mockResolvedValue(inv(1, []) as any);
		await runRelinkCron(E);
		expect(JSON.parse(await E.SYNC_STATE.get("meta:relink_cron_cursor"))).toEqual({ status: "Draft", page: 1 });
		await runRelinkCron(E);
		expect(JSON.parse(await E.SYNC_STATE.get("meta:relink_cron_cursor"))).toEqual({ status: "For Sale", page: 1 });
	});

	it("never overwrites a SKU linked to another listing; a failed page is retried", async () => {
		await E.SYNC_STATE.put("sku:HAND01", JSON.stringify({ listing_id: 1, status: "For Sale" }));
		vi.mocked(discogs.getInventory).mockResolvedValueOnce(inv(1, [
			{ id: 777, status: "For Sale", release: { catalog_number: "HAND01", description: "x" } },
		]) as any);
		const r = await runRelinkCron(E);
		expect(r.counts.conflict).toBe(1);
		expect(JSON.parse(await E.SYNC_STATE.get("sku:HAND01")).listing_id).toBe(1);
		vi.mocked(discogs.getInventory).mockRejectedValueOnce(new Error("429"));
		await E.SYNC_STATE.put("meta:relink_cron_cursor", JSON.stringify({ status: "For Sale", page: 4 }));
		expect((await runRelinkCron(E)).ok).toBe(false);
		expect(JSON.parse(await E.SYNC_STATE.get("meta:relink_cron_cursor"))).toEqual({ status: "For Sale", page: 4 });
	});

	it("kill switch: meta:relink_cron_mode = off", async () => {
		await E.SYNC_STATE.put("meta:relink_cron_mode", "off");
		expect(await runRelinkCron(E)).toEqual({ skipped: "off" });
		expect(discogs.getInventory).not.toHaveBeenCalled();
	});

	const cron = async () => {
		const ctx = createExecutionContext();
		await worker.scheduled({ cron: EBAY_CRON, scheduledTime: Date.now() } as any, E, ctx);
		await waitOnExecutionContext(ctx);
	};

	it(":03 slot runs the eBay pass BEFORE the relink", async () => {
		vi.mocked(discogs.getInventory).mockResolvedValue(inv(1, []) as any);
		await includeSkus(E, ["BOND12081C"]);
		await cron();
		const read = vi.mocked(discogs.getListing).mock.invocationCallOrder[0];
		const page = vi.mocked(discogs.getInventory).mock.invocationCallOrder[0];
		expect(read).toBeLessThan(page);
		expect(JSON.parse(await E.SYNC_STATE.get("meta:relink_cron_last_run"))).toMatchObject({ ok: true, page: 1 });
	});

	it(":03 slot skips the relink when the eBay pass just got a Discogs 429 (same page next run)", async () => {
		await E.SYNC_STATE.put("meta:relink_cron_cursor", JSON.stringify({ status: "For Sale", page: 3 }));
		vi.mocked(discogs.getListing).mockRejectedValue(new Error("Discogs getListing failed: 429 {}"));
		await includeSkus(E, ["BOND12081C"]);
		await cron();
		expect(discogs.getInventory).not.toHaveBeenCalled();
		expect(JSON.parse(await E.SYNC_STATE.get("meta:relink_cron_last_run"))).toMatchObject({ skipped: "discogs_429" });
		expect(JSON.parse(await E.SYNC_STATE.get("meta:relink_cron_cursor"))).toEqual({ status: "For Sale", page: 3 });
	});
});

// ── Shopify / Discogs sale -> eBay ──────────────────────────────────

describe("sale elsewhere ends the eBay listing", () => {
	const listed = (sku: string) => E.SYNC_STATE.put(`ebay:item:${sku}`, JSON.stringify({
		sku, status: "listed", offer_id: "OFF-9", listing_id: "LIST-9", selected_at: "2026-10-01", updated_at: "2026-10-01",
	}));

	it("Shopify order (also how Discogs sales arrive) -> withdrawOffer", async () => {
		await listed("BOND12081C");
		await withdrawOnEbayForShopifyOrder(E, "5001", { line_items: [{ sku: "BOND12081C" }, { sku: "NOT-ON-EBAY" }] });
		expect(ebayCalls("POST", /withdraw/).map(c => c.path)).toEqual(["/sell/inventory/v1/offer/OFF-9/withdraw"]);
		expect((await item("BOND12081C")).status).toBe("withdrawn");
	});

	it("leaves eBay alone when the Shopify order IS the eBay sale", async () => {
		await listed("BOND12081C");
		await withdrawOnEbayForShopifyOrder(E, "5002", {
			source_name: "ebay", note_attributes: [{ name: "ebay_order_id", value: "12-34" }], line_items: [{ sku: "BOND12081C" }],
		});
		expect(ebayCalls()).toHaveLength(0);
	});

	it("a record not listed yet stays in the queue (the cron's stock check decides)", async () => {
		await includeSkus(E, ["BOND12081C"]);
		await withdrawOnEbayForShopifyOrder(E, "5003", { line_items: [{ sku: "BOND12081C" }] });
		expect(ebayCalls()).toHaveLength(0);
		expect((await item("BOND12081C")).status).toBe("queued");
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

	it("exclude (a live listing is withdrawn first) and re-add", async () => {
		expect((await viaWorker(post("ebay-exclude", { skus: ["A1"] }, null))).status).toBe(401);
		await includeSkus(E, ["A1"]);
		await E.SYNC_STATE.put("ebay:item:A2", JSON.stringify({ sku: "A2", status: "listed", offer_id: "OFF-2", listing_id: "L2", selected_at: "x", updated_at: "x" }));
		const ex = await (await viaWorker(post("ebay-exclude", { skus: ["A1", "A2", "A1"] }))).json() as any;
		expect(ex.results).toEqual([{ sku: "A1", result: "excluded" }, { sku: "A2", result: "withdrawn_and_excluded" }]);
		expect(ebayCalls("POST", /OFF-2\/withdraw/)).toHaveLength(1);
		expect((await item("A2")).status).toBe("excluded");
		const inc = await (await viaWorker(post("ebay-include", { skus: ["A2"] }))).json() as any;
		expect(inc.results).toEqual([{ sku: "A2", result: "queued" }]);
		expect((await item("A2")).status).toBe("queued");
	});

	it("ebay-items: summary from list metadata, one full record with &sku=", async () => {
		await includeSkus(E, ["BOND12081C", "Z9"]);
		const d = await (await viaWorker(new Request("https://w/?action=ebay-items", { headers: { Authorization: `Bearer ${SECRET}` } }))).json() as any;
		expect(d.counts).toEqual({ queued: 2 });
		expect(d.cost_multiplier).toBe(2);
		const one = await (await viaWorker(new Request("https://w/?action=ebay-items&sku=Z9", { headers: { Authorization: `Bearer ${SECRET}` } }))).json() as any;
		expect(one).toMatchObject({ sku: "Z9", status: "queued", origin: "admin" });
	});

	it("ebay-run drives the cron by hand (staging has no eBay cron)", async () => {
		await includeSkus(E, ["BOND12081C"]);
		const r = await (await viaWorker(post("ebay-run", { what: "autolist" }))).json() as any;
		expect(r.autolist).toMatchObject({ mode: "dry", would_list: 1 });
		expect(r.orders).toBeUndefined();
	});
});
