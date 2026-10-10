import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as shopifyAdmin from "../src/lib/shopify-admin";
import {
	gtinValido,
	productoAItem,
	renderFeedXml,
	handleGoogleFeed,
	handleGoogleFeedRebuild,
	GOOGLE_FEED_KEY,
	type AdminProduct,
	type FeedItem,
} from "../src/lib/google-feed";

vi.mock("../src/lib/shopify-admin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/shopify-admin")>();
	return { ...actual, shopifyAdminGraphQL: vi.fn() };
});

function producto(over: Partial<AdminProduct> = {}, variante: Partial<AdminProduct["variants"]["nodes"][0]> = {}): AdminProduct {
	return {
		handle: "fat072",
		title: "Black Magic EP (2026 Re-release)",
		vendor: "Taron-Trekka",
		status: "ACTIVE",
		tags: ["vinyl", "label:Freude Am Tanzen", "2026"],
		descriptionHtml: "<p>Deep & dusty.</p>",
		featuredMedia: { preview: { image: { url: "https://cdn.shopify.com/fat072.jpg" } } },
		variants: { nodes: [{ sku: "FAT072", barcode: null, price: "14.99", inventoryQuantity: 2, ...variante }] },
		...over,
	};
}

const esItem = (x: ReturnType<typeof productoAItem>): FeedItem => {
	if ("skip" in x) throw new Error(`saltado: ${x.skip}`);
	return x;
};

/** Comprobacion de buena formacion sin parser: etiquetas equilibradas y nada sin escapar. */
function bienFormado(xml: string): boolean {
	const cuerpo = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
	const pila: string[] = [];
	const re = /<(\/?)([A-Za-z_][\w:.-]*)([^<>]*?)(\/?)>|([<>])|&(?!(amp|lt|gt|quot|apos);)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(cuerpo))) {
		if (m[5] || m[0].startsWith("&")) return false;      // < o > sueltos, o & sin escapar
		const [, cierre, nombre, , auto] = m;
		if (auto) continue;
		if (cierre) { if (pila.pop() !== nombre) return false; }
		else pila.push(nombre);
	}
	return pila.length === 0;
}

describe("gtinValido", () => {
	it("acepta 8, 12, 13 y 14 digitos con control correcto", () => {
		expect(gtinValido("4006381333931")).toBe("4006381333931");   // EAN-13
		expect(gtinValido("036000291452")).toBe("036000291452");     // UPC-12
		expect(gtinValido("96385074")).toBe("96385074");             // EAN-8
		expect(gtinValido("10036000291459")).toBe("10036000291459"); // GTIN-14
		expect(gtinValido(" 4006381-333931 ")).toBe("4006381333931");
	});
	it("rechaza control malo, longitudes raras y basura", () => {
		expect(gtinValido("4006381333932")).toBe("");
		expect(gtinValido("40063813339")).toBe("");
		expect(gtinValido("FAT072")).toBe("");
		expect(gtinValido(null)).toBe("");
	});
});

describe("productoAItem", () => {
	it("sin barcode -> identifier_exists=no, y los campos del feed", () => {
		const it = esItem(productoAItem(producto()));
		expect(it).toMatchObject({
			id: "FAT072",
			title: "Taron-Trekka – Black Magic EP (2026 Re-release)",
			description: "Deep & dusty.",
			link: "https://houseonly.store/products/taron-trekka-black-magic-ep-2026-re-release/",
			image_link: "https://cdn.shopify.com/fat072.jpg",
			price: "14.99 EUR",
			brand: "Freude Am Tanzen",
			mpn: "FAT072",
			gtin: "",
		});
		const xml = renderFeedXml([it], "t");
		expect(xml).toContain("<g:identifier_exists>no</g:identifier_exists>");
		expect(xml).not.toContain("<g:gtin>");
		expect(xml).toContain("<g:google_product_category>543523</g:google_product_category>");
		expect(xml).toContain("<g:product_type>Vinyl</g:product_type>");
		expect(xml).not.toContain("shipping_weight");
	});

	it("barcode de 13 digitos valido -> g:gtin, sin identifier_exists", () => {
		const it = esItem(productoAItem(producto({}, { barcode: "4006381333931" })));
		expect(it.gtin).toBe("4006381333931");
		const xml = renderFeedXml([it], "t");
		expect(xml).toContain("<g:gtin>4006381333931</g:gtin>");
		expect(xml).not.toContain("identifier_exists");
	});

	it("barcode con control malo se trata como sin barcode", () => {
		expect(esItem(productoAItem(producto({}, { barcode: "4006381333932" }))).gtin).toBe("");
	});

	it("forthcoming no entra, aunque tenga stock", () => {
		expect(productoAItem(producto({ tags: ["forthcoming", "release:2026-11-01"] }))).toEqual({ skip: "forthcoming" });
	});

	it("request/backorder (stock 0) no entra", () => {
		expect(productoAItem(producto({}, { inventoryQuantity: 0 }))).toEqual({ skip: "sin_stock" });
		expect(productoAItem(producto({}, { inventoryQuantity: null }))).toEqual({ skip: "sin_stock" });
	});

	it("sin imagen o no activo no entra", () => {
		expect(productoAItem(producto({ featuredMedia: null }))).toEqual({ skip: "sin_imagen" });
		expect(productoAItem(producto({ status: "DRAFT" }))).toEqual({ skip: "no_activo" });
	});

	it("vendor 'House Only' no es artista en el titulo; el enlace sigue al prerender", () => {
		const it = esItem(productoAItem(producto({ vendor: "House Only" })));
		expect(it.title).toBe("Black Magic EP (2026 Re-release)");
		expect(it.link).toBe("https://houseonly.store/products/house-only-black-magic-ep-2026-re-release/");
	});

	it("titulo a 150 y descripcion a 5000 como mucho", () => {
		const it = esItem(productoAItem(producto({ title: "x".repeat(400), descriptionHtml: `<p>${"y".repeat(9000)}</p>` })));
		expect(it.title.length).toBeLessThanOrEqual(150);
		expect(it.description.length).toBeLessThanOrEqual(5000);
	});
});

describe("XML", () => {
	it("bien formado, con & < > y comillas escapados", () => {
		const raro = esItem(productoAItem(producto({ title: `Rock & Roll <"Dub"> 'Mix'`, descriptionHtml: "<p>A &amp; B</p>" })));
		const xml = renderFeedXml([raro, esItem(productoAItem(producto()))], "2026-10-09T00:00:00Z");
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(xml).toContain('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
		expect(bienFormado(xml)).toBe(true);
		expect(xml).toContain("Rock &amp; Roll &lt;&quot;Dub&quot;&gt; &apos;Mix&apos;");
		expect((xml.match(/<item>/g) || []).length).toBe(2);
	});

	it("el comprobador detecta XML roto", () => {
		expect(bienFormado("<a><b></a></b>")).toBe(false);
		expect(bienFormado("<a>R & B</a>")).toBe(false);
	});
});

describe("handlers", () => {
	const gql = vi.mocked(shopifyAdmin.shopifyAdminGraphQL);
	beforeEach(async () => {
		await env.SYNC_STATE.delete(GOOGLE_FEED_KEY);
		gql.mockReset();
		// Dos paginas: la primera con un disco vendible y un forthcoming; la
		// segunda con uno sin stock y otro con barcode.
		gql.mockResolvedValueOnce({ data: { products: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [
			producto(), producto({ handle: "pre1", tags: ["forthcoming"] }),
		] } } });
		gql.mockResolvedValueOnce({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
			producto({ handle: "req1" }, { sku: "REQ1", inventoryQuantity: 0 }),
			producto({ handle: "ean", title: "Otro" }, { sku: "EAN1", barcode: "4006381333931" }),
		] } } });
	});

	it("GET sin nada en KV genera, guarda, y la segunda vez sirve de KV", async () => {
		const r1 = await handleGoogleFeed(env as any);
		expect(r1.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
		expect(r1.headers.get("X-Feed-Items")).toBe("2");
		const xml = await r1.text();
		expect(bienFormado(xml)).toBe(true);
		expect(xml).toContain("<g:id>FAT072</g:id>");
		expect(xml).toContain("<g:id>EAN1</g:id>");
		expect(xml).not.toContain("REQ1");
		expect(gql).toHaveBeenCalledTimes(2);
		expect(gql.mock.calls[1][2]).toEqual({ cursor: "c1" });

		const r2 = await handleGoogleFeed(env as any);
		expect(await r2.text()).toBe(xml);
		expect(gql).toHaveBeenCalledTimes(2);   // no vuelve a la Admin API
	});

	it("rebuild sin Bearer -> 401; con Bearer guarda y resume", async () => {
		expect((await handleGoogleFeedRebuild(env as any, false)).status).toBe(401);
		const r = await handleGoogleFeedRebuild(env as any, true);
		const d = await r.json() as any;
		expect(d).toMatchObject({ ok: true, count: 2, activos: 4, saltados: { forthcoming: 1, sin_stock: 1 } });
		const { metadata } = await env.SYNC_STATE.getWithMetadata<any>(GOOGLE_FEED_KEY);
		expect(metadata.count).toBe(2);
	});
});
