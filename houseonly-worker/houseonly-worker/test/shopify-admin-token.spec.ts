import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { shopifyAdminGraphQL, esScopeDenegado } from "../src/lib/shopify-admin";

// Un token de client credentials lleva los scopes de cuando se emitio. Tras
// anadir uno a la app, el guardado en KV sigue sin el y Shopify contesta HTTP
// 200 con "Access denied ... access scope" (2026-10-10, read_legal_policies).

const DENEGADO = { errors: [{ message: "Access denied for shopPolicies field. Required access: `read_legal_policies` access scope." }] };
const OK = { data: { shop: { shopPolicies: [] } } };

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("shopifyAdminGraphQL: token con scopes viejos", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let tokensEmitidos = 0;
	let usados: string[] = [];

	beforeEach(async () => {
		(env as any).SHOPIFY_ADMIN_CLIENT_ID = "id";
		(env as any).SHOPIFY_ADMIN_CLIENT_SECRET = "secret";
		await env.WISHLIST.put("shopify_admin_token", JSON.stringify({ token: "viejo", expiresAt: Date.now() + 20 * 3600e3 }));
		await env.WISHLIST.delete("shopify_admin_token_scope_retry");
		tokensEmitidos = 0; usados = [];
	});
	afterEach(() => fetchSpy?.mockRestore());

	function simular(respuestaGraphql: (token: string) => Response) {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
			const url = String(input?.url ?? input);
			if (url.includes("/admin/oauth/access_token")) { tokensEmitidos++; return json({ access_token: `nuevo${tokensEmitidos}` }); }
			const token = init?.headers?.["X-Shopify-Access-Token"];
			usados.push(token);
			return respuestaGraphql(token);
		});
	}

	it("Access denied por scope (HTTP 200): token nuevo y reintento CON ESE token", async () => {
		simular(t => json(t === "viejo" ? DENEGADO : OK));
		const r = await shopifyAdminGraphQL(env as any, "{ shop { shopPolicies { type } } }");
		expect(r).toEqual(OK);
		expect(tokensEmitidos).toBe(1);
		expect(usados).toEqual(["viejo", "nuevo1"]);
		expect(JSON.parse((await env.WISHLIST.get("shopify_admin_token"))!).token).toBe("nuevo1");
	});

	it("si el scope falta de verdad: una sola renovacion cada 5 min, no una por llamada", async () => {
		simular(() => json(DENEGADO));
		expect(await shopifyAdminGraphQL(env as any, "q")).toEqual(DENEGADO);
		expect(await shopifyAdminGraphQL(env as any, "q")).toEqual(DENEGADO);
		expect(tokensEmitidos).toBe(1);
	});

	it("otros errores GraphQL no renuevan el token", async () => {
		const otro = { errors: [{ message: "Field 'foo' doesn't exist on type 'Shop'" }] };
		simular(() => json(otro));
		expect(await shopifyAdminGraphQL(env as any, "q")).toEqual(otro);
		expect(tokensEmitidos).toBe(0);
	});

	it("el 401 sigue renovando como antes", async () => {
		simular(t => (t === "viejo" ? json({}, 401) : json(OK)));
		expect(await shopifyAdminGraphQL(env as any, "q")).toEqual(OK);
		expect(usados).toEqual(["viejo", "nuevo1"]);
	});

	it("esScopeDenegado solo reconoce el error de scope", () => {
		expect(esScopeDenegado(DENEGADO)).toBe(true);
		expect(esScopeDenegado({ errors: [{ message: "Access denied" }] })).toBe(false);
		expect(esScopeDenegado(OK)).toBe(false);
	});
});
