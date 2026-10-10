import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as shopifyAdmin from "../src/lib/shopify-admin";
import { cleanPolicyHtml, handleShopPolicies, SHOP_POLICIES_KEY } from "../src/lib/shop-policies";

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
		expect(out).toBe("<p>Hola mundo</p>\n<h2>Section</h2>\n<ul><li>uno</li><li>dos</li></ul>");
		expect(out).not.toMatch(/class=|style=|<meta|<span|<em|<script|alert/);
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

describe("handleShopPolicies", () => {
	const gql = vi.mocked(shopifyAdmin.shopifyAdminGraphQL);
	beforeEach(async () => {
		await env.SYNC_STATE.delete(SHOP_POLICIES_KEY);
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

	it("si la Admin API falla (p. ej. sin scope): 502 con el motivo y nada en KV", async () => {
		gql.mockResolvedValue({ errors: [{ message: "Access denied for shopPolicies field. Required access: `read_legal_policies`" }] });
		const r = await handleShopPolicies(env as any);
		expect(r.status).toBe(502);
		expect(((await r.json()) as any).error).toContain("read_legal_policies");
		expect(await env.SYNC_STATE.get(SHOP_POLICIES_KEY)).toBeNull();
	});
});
