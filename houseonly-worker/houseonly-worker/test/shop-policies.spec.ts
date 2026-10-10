import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as shopifyAdmin from "../src/lib/shopify-admin";
import { cleanPolicyHtml, prepararPolitica, handleShopPolicies, SHOP_POLICIES_KEY, SHOP_POLICIES_ERROR_KEY } from "../src/lib/shop-policies";

vi.mock("../src/lib/shopify-admin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/shopify-admin")>();
	return { ...actual, shopifyAdminGraphQL: vi.fn() };
});

// Trozo real de la Refund Policy de la tienda (Storefront, 2026-10-09).
const REFUND = `<p>We have a 14-day return policy, which means you have 14 days after receiving your item to request a return. <br><br>To start a return, you can contact us at <a href="mailto:info@houseonly.store">info@houseonly.store</a>.&nbsp;<br><br>You can always contact us. <br></p>
<p><br></p>
<p><strong>Damages and issues</strong> <br>Please inspect your order upon reception and contact us immediately if the item is defective.</p>
<p><br></p>
<p><strong>Exceptions / non-returnable items</strong> <br>Certain types of items cannot be returned.</p>`;

describe("cleanPolicyHtml", () => {
	it("parte los <br><br> en parrafos y el titulo en negrita pasa a h2", () => {
		expect(cleanPolicyHtml(REFUND)).toBe([
			"<p>We have a 14-day return policy, which means you have 14 days after receiving your item to request a return.</p>",
			'<p>To start a return, you can contact us at <a href="mailto:info@houseonly.store">info@houseonly.store</a>.</p>',
			"<p>You can always contact us.</p>",
			"<h2>Damages and issues</h2>",
			"<p>Please inspect your order upon reception and contact us immediately if the item is defective.</p>",
			"<h2>Exceptions / non-returnable items</h2>",
			"<p>Certain types of items cannot be returned.</p>",
		].join("\n"));
	});

	it("fuera clases, estilos, spans y <meta> del body; solo quedan las etiquetas permitidas", () => {
		const out = cleanPolicyHtml(`<meta charset="utf-8"><div class="x" style="color:red"><span data-mce="1">Hola <em>mundo</em></span></div><h3 class="t">Section</h3><ol><li class="a"><p>uno</p></li><li>dos</li></ol><script>alert(1)</script>`);
		expect(out).toBe("<p>Hola <strong>mundo</strong></p>\n<h2>Section</h2>\n<ul><li>uno</li><li>dos</li></ul>");
		expect(out).not.toMatch(/class=|style=|<meta|<span|<em|<script|alert/);   // <em> ya convertido a <strong>
	});

	it("titulo en negrita en linea con el texto -> h2 + p (Shipping real)", () => {
		const raw = `<p class="font-claude-response-body break-words"><strong>Processing time</strong> All orders are processed within 1–3 business days.</p>
<p class="x"><strong>Shipping rates and delivery times</strong></p>
<p class="x"><em>Spain</em> Standard Shipping — €5.00 to €15.00.</p>`;
		expect(cleanPolicyHtml(raw)).toBe([
			"<h2>Processing time</h2>",
			"<p>All orders are processed within 1–3 business days.</p>",
			"<h2>Shipping rates and delivery times</h2>",
			"<p><strong>Spain</strong> Standard Shipping — €5.00 to €15.00.</p>",
		].join("\n"));
	});

	it("enlaces: solo href seguros; javascript: se queda en texto", () => {
		const out = cleanPolicyHtml(`<p><a href="https://houseonly.store/ig" target="_blank" class="l">IG</a> <a href="javascript:alert(1)">mal</a> <a href="/contact">c</a></p>`);
		expect(out).toBe('<p><a href="https://houseonly.store/ig">IG</a> mal <a href="/contact">c</a></p>');
	});

	it("una linea en MAYUSCULAS sola es un titulo; un parrafo normal no", () => {
		expect(cleanPolicyHtml("<p>SECTION 1 - ONLINE STORE TERMS</p><p>By agreeing to these Terms you represent that you are of age.</p>"))
			.toBe("<h2>SECTION 1 - ONLINE STORE TERMS</h2>\n<p>By agreeing to these Terms you represent that you are of age.</p>");
		expect(cleanPolicyHtml("<p><strong>Note:</strong> prices include VAT.</p>")).toBe("<p><strong>Note:</strong> prices include VAT.</p>");
	});
});

// Con la forma real de los textos de Shopify del 2026-10-10.
describe("prepararPolitica", () => {
	it("Terms: titulos numerados en <ol start>, titulo repetido fuera y Last updated aparte", () => {
		const raw = `<h2 dir="ltr" class="x">Terms of Service — House Only</h2>
<p dir="ltr">Last updated: 10 October 2026</p>
<p dir="ltr">These terms apply to every purchase made on houseonly.store.</p>
<p>&nbsp;</p>
<ol><li dir="ltr" class="y"><p>The shop</p></li></ol>
<p>House Only sells new vinyl records.</p>
<ol start="2"><li>Orders</li></ol>
<p>An order is an offer to buy.</p>
<ol start="13"><li>Contact</li></ol>`;
		const r = prepararPolitica("TERMS_OF_SERVICE", "Terms of service", raw);
		expect(r.lastUpdated).toBe("Last updated: 10 October 2026");
		expect(r.html).toBe([
			"<p>These terms apply to every purchase made on houseonly.store.</p>",
			"<h2>1. The shop</h2>",
			"<p>House Only sells new vinyl records.</p>",
			"<h2>2. Orders</h2>",
			"<p>An order is an offer to buy.</p>",
			"<h2>13. Contact</h2>",
		].join("\n"));
		expect(r.html).not.toMatch(/dir=|class=|&nbsp;|<ul>|<ol/);
	});

	it("una lista de verdad (varios puntos, o frases con punto) no se toca", () => {
		expect(prepararPolitica("SHIPPING_POLICY", "Shipping", "<ol><li>Spain — 3–7 days</li><li>EU — 15–30 days</li></ol>").html)
			.toBe("<ul><li>Spain — 3–7 days</li><li>EU — 15–30 days</li></ul>");
		expect(prepararPolitica("X", "X", "<ol><li>Pack it well.</li></ol>").html).toBe("<ul><li>Pack it well.</li></ul>");
	});

	it("/returns: h2 antes de 'If a record arrives damaged' y 'If you're in the EU' (solo en REFUND_POLICY)", () => {
		const raw = "<p>You can return a record within 14 days.</p><p>If a record arrives damaged, defective, or isn’t what you ordered, email us.</p><p>If you’re in the EU, you also have the legal right to cancel.</p>";
		expect(prepararPolitica("REFUND_POLICY", "Refund policy", raw).html).toBe([
			"<p>You can return a record within 14 days.</p>",
			"<h2>Damaged, defective or wrong records</h2>",
			"<p>If a record arrives damaged, defective, or isn’t what you ordered, email us.</p>",
			"<h2>EU customers</h2>",
			"<p>If you’re in the EU, you also have the legal right to cancel.</p>",
		].join("\n"));
		expect(prepararPolitica("SHIPPING_POLICY", "Shipping", raw).html).not.toContain("<h2>");
	});

	it("/contact: fuera la linea de Instagram y el mailto del texto (la pagina los pone una vez)", () => {
		const raw = `<h2>Contact information</h2><p>The fastest way to reach us is email: <a href="mailto:info@houseonly.store">info@houseonly.store</a>. We answer within one business day.</p>
<p>Instagram: @onlyhouseonly (<a href="https://www.instagram.com/onlyhouseonly">https://www.instagram.com/onlyhouseonly</a>)</p>
<p>Postal address: Avenida de Pesadilla 20, 28708 Madrid, Spain</p>`;
		const r = prepararPolitica("CONTACT_INFORMATION", "Contact", raw);
		expect(r.html).toBe([
			"<p>The fastest way to reach us is email: info@houseonly.store. We answer within one business day.</p>",
			"<p>Postal address: Avenida de Pesadilla 20, 28708 Madrid, Spain</p>",
		].join("\n"));
	});

	it("el h2 inicial que repite el titulo con otras palabras se quita", () => {
		expect(prepararPolitica("SHIPPING_POLICY", "Shipping", "<h2>Shipping policy</h2><p>All records ship from Madrid.</p>").html).toBe("<p>All records ship from Madrid.</p>");
		expect(prepararPolitica("X", "Shipping", "<h2>Rates</h2><p>a</p>").html).toBe("<h2>Rates</h2>\n<p>a</p>");
	});
});

describe("handleShopPolicies", () => {
	const gql = vi.mocked(shopifyAdmin.shopifyAdminGraphQL);
	beforeEach(async () => {
		await env.SYNC_STATE.delete(SHOP_POLICIES_KEY);
		await env.SYNC_STATE.delete(SHOP_POLICIES_ERROR_KEY);
		gql.mockReset();
	});

	it("pide a la Admin API, limpia, guarda 1 h y la segunda vez sirve de KV", async () => {
		gql.mockResolvedValue({ data: { shop: { shopPolicies: [
			{ type: "REFUND_POLICY", title: "Refund Policy", body: REFUND, url: "https://checkout.shopify.com/x", updatedAt: "2026-10-01T00:00:00Z" },
			{ type: "LEGAL_NOTICE", title: "Legal notice", body: "", url: "", updatedAt: "" },
		] } } });
		const r = await handleShopPolicies(env as any);
		expect(r.status).toBe(200);
		expect(r.headers.get("Cache-Control")).toBe("public, max-age=3600");
		const d = await r.json() as any;
		expect(d.policies.map((p: any) => p.type)).toEqual(["REFUND_POLICY"]);   // las vacias no se sirven
		expect(d.policies[0].html).toContain("<h2>Damages and issues</h2>");
		await handleShopPolicies(env as any);
		expect(gql).toHaveBeenCalledTimes(1);
	});

	it("el primer h2 igual al titulo se quita (la pagina ya lo pone en su h1)", async () => {
		gql.mockResolvedValue({ data: { shop: { shopPolicies: [
			{ type: "SHIPPING_POLICY", title: "Shipping Policy", body: "<p><strong>Shipping Policy</strong></p><p>Ships in 48 h.</p>", url: "", updatedAt: "" },
		] } } });
		const d = await (await handleShopPolicies(env as any)).json() as any;
		expect(d.policies[0].html).toBe("<p>Ships in 48 h.</p>");
	});

	it("el fallo se recuerda 5 min: la segunda peticion no vuelve a Shopify", async () => {
		gql.mockResolvedValue({ errors: [{ message: "Access denied for shopPolicies field." }] });
		expect((await handleShopPolicies(env as any)).status).toBe(502);
		const llamadas = gql.mock.calls.length;
		const r2 = await handleShopPolicies(env as any);
		expect(r2.status).toBe(502);
		expect(((await r2.json()) as any).cached).toBe(true);
		expect(gql.mock.calls.length).toBe(llamadas);
	});

	it("si la Admin API falla (p. ej. sin scope): 502 con el motivo y nada en KV", async () => {
		gql.mockResolvedValue({ errors: [{ message: "Access denied for shopPolicies field. Required access: `read_legal_policies`" }] });
		const r = await handleShopPolicies(env as any);
		expect(r.status).toBe(502);
		expect(((await r.json()) as any).error).toContain("read_legal_policies");
		expect(await env.SYNC_STATE.get(SHOP_POLICIES_KEY)).toBeNull();
	});
});
