import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";

// account-profile decide si la tienda cierra la sesion del cliente: el frontend
// borra la sesion guardada cuando esto no contesta 200. Solo debe contestar 401
// cuando la sesion de verdad no vale; un fallo pasajero de Shopify es 502.
// (2026-10-14: un cliente veia "crea una cuenta" en un pre-order recien
// entrado; cualquier fallo de CAAPI se convertia en 401 y le sacaba.)

const TOKEN_URL = "https://account.houseonly.store/authentication/oauth/token";
const GRAPHQL_URL = "https://account.houseonly.store/customer/api/2026-04/graphql";
const CUSTOMER = { id: "gid://shopify/Customer/123", displayName: "Ana", firstName: "Ana", lastName: "", emailAddress: { emailAddress: "ana@example.com" } };

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function perfil(session: string) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`https://w/?action=account-profile&session=${session}`), env as any, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function sesion(id: string, { caducada = false, refreshToken = "r1" } = {}) {
	await env.WISHLIST.put(`sess:${id}`, JSON.stringify({
		customerId: "123", accessToken: caducada ? "viejo" : "bueno", refreshToken,
		expiresAt: caducada ? Date.now() - 1000 : Date.now() + 3600e3, createdAt: Date.now(),
	}));
}

describe("account-profile: 401 solo si la sesion no vale", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let refrescos: string[];

	beforeEach(async () => {
		(env as any).CAAPI_CLIENT_ID = "cid";
		(env as any).CAAPI_CLIENT_SECRET = "csecret";
		await env.WISHLIST.put("meta:caapi_discovery", JSON.stringify({
			authorization_endpoint: "https://account.houseonly.store/authentication/oauth/authorize",
			token_endpoint: TOKEN_URL,
			end_session_endpoint: "https://account.houseonly.store/authentication/logout",
		}));
		refrescos = [];
	});
	afterEach(() => fetchSpy?.mockRestore());

	/** Shopify falso. `refresco(rt)` contesta al token endpoint; `graphql(token)` a CAAPI. */
	function shopify({ refresco, graphql }: { refresco?: (rt: string) => Promise<Response> | Response; graphql?: (token: string) => Response }) {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
			const url = String(input?.url ?? input);
			if (url.includes("/.well-known/customer-account-api")) return new Response("", { status: 404 });
			if (url === TOKEN_URL) {
				const rt = new URLSearchParams(String(init?.body)).get("refresh_token") || "";
				refrescos.push(rt);
				return refresco ? refresco(rt) : json({ error: "invalid_grant" }, 400);
			}
			if (url === GRAPHQL_URL) return graphql ? graphql(init?.headers?.authorization) : json({ data: { customer: CUSTOMER } });
			throw new Error(`fetch inesperado: ${url}`);
		});
	}

	it("sesion buena: 200 con el perfil", async () => {
		await sesion("s-ok");
		shopify({});
		const res = await perfil("s-ok");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ email: "ana@example.com", firstName: "Ana" });
	});

	it("sesion que no existe: 401", async () => {
		shopify({});
		expect((await perfil("no-existe")).status).toBe(401);
	});

	it("CAAPI cae (red): 502, no 401", async () => {
		await sesion("s-red");
		shopify({ graphql: () => { throw new TypeError("fetch failed"); } });
		expect((await perfil("s-red")).status).toBe(502);
	});

	it("CAAPI contesta 500 / 429: 502, no 401", async () => {
		await sesion("s-500");
		shopify({ graphql: () => json({ errors: [{ message: "Internal error" }] }, 500) });
		expect((await perfil("s-500")).status).toBe(502);
		shopify({ graphql: () => json({ errors: [{ message: "Throttled" }] }, 429) });
		expect((await perfil("s-500")).status).toBe(502);
	});

	it("CAAPI rechaza el token (401): 401", async () => {
		await sesion("s-revocada");
		shopify({ graphql: () => json({ errors: [{ message: "Unauthorized" }] }, 401) });
		expect((await perfil("s-revocada")).status).toBe(401);
	});

	it("refresco con el token endpoint caido (503 o red): 502, la sesion sigue", async () => {
		await sesion("s-503", { caducada: true });
		shopify({ refresco: () => json({ error: "unavailable" }, 503) });
		expect((await perfil("s-503")).status).toBe(502);
		shopify({ refresco: () => { throw new TypeError("fetch failed"); } });
		expect((await perfil("s-503")).status).toBe(502);
		expect(await env.WISHLIST.get("sess:s-503")).not.toBeNull();
	});

	it("refresh token revocado de verdad (invalid_grant y nadie mas refresco): 401", async () => {
		await sesion("s-revocado", { caducada: true });
		shopify({ refresco: () => json({ error: "invalid_grant" }, 400) });
		expect((await perfil("s-revocado")).status).toBe(401);
	});

	it("dos peticiones a la vez con el token caducado: Shopify rota el refresh token y las dos salen 200", async () => {
		// Al cargar la pagina, perfil, wishlist y follows piden a la vez. Shopify
		// acepta el refresh token r1 UNA vez y devuelve r2; la segunda peticion
		// llega con r1 y recibe invalid_grant aunque la sesion este bien.
		await sesion("s-carrera", { caducada: true, refreshToken: "r1" });
		let usado = false;
		shopify({
			refresco: async (rt) => {
				if (rt === "r1" && !usado) {
					usado = true;
					await new Promise((r) => setTimeout(r, 50));
					return json({ access_token: "nuevo", refresh_token: "r2", expires_in: 3600 });
				}
				return json({ error: "invalid_grant" }, 400);
			},
		});
		const [a, b] = await Promise.all([perfil("s-carrera"), perfil("s-carrera")]);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(refrescos.filter((r) => r === "r1").length).toBe(2);
		const guardada = JSON.parse((await env.WISHLIST.get("sess:s-carrera")) || "{}");
		expect(guardada.refreshToken).toBe("r2");
	});
});
