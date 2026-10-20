import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../src/index";
import * as shopifyAdmin from "../src/lib/shopify-admin";

vi.mock("../src/lib/shopify-admin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/shopify-admin")>();
	return { ...actual, shopifyAdminGraphQL: vi.fn() };
});
const gql = vi.mocked(shopifyAdmin.shopifyAdminGraphQL);

const SECRET = "test-secret";
const get = (bearer: string | null = SECRET) => new Request("https://w/?action=preorder-unlisted", {
	headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
});
async function viaWorker(request: Request) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(request, env as any, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
const nodo = (_handle: string, sku: string, status = "UNLISTED") => ({ status, variants: { nodes: [{ sku }] } });

beforeEach(() => {
	(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
	gql.mockReset();
});

describe("preorder-unlisted", () => {
	it("sin Bearer: 401 y no pregunta a Shopify", async () => {
		expect((await viaWorker(get(null))).status).toBe(401);
		expect(gql).not.toHaveBeenCalled();
	});

	it("devuelve los SKUs de los productos UNLISTED, paginando", async () => {
		gql.mockResolvedValueOnce({ data: { products: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [nodo("warplp324", "WARPLP324"), nodo("pfr36", "PFR36")] } } })
		   .mockResolvedValueOnce({ data: { products: { pageInfo: { hasNextPage: false }, nodes: [nodo("mslp015", "MSLP015"), nodo("activo", "ACT1", "ACTIVE")] } } });
		const d = await (await viaWorker(get())).json() as any;
		expect(d.items.map((i: any) => i.sku)).toEqual(["WARPLP324", "PFR36", "MSLP015"]);
		// Solo SKU y estado: nada de handle, titulo ni otros datos del producto
		for (const it of d.items) expect(Object.keys(it).sort()).toEqual(["estado", "sku"]);
		expect(d.items[0].estado).toBe("UNLISTED");
		// Solo lectura: ninguna mutacion
		for (const [, q] of gql.mock.calls) expect(String(q)).not.toMatch(/mutation/i);
		expect(String(gql.mock.calls[0][1])).toContain('status:unlisted');
		expect(gql.mock.calls[1][2]).toEqual({ after: "c1" });
	});

	it("si Shopify falla: 502, no una lista vacia que diria que no hay ninguno", async () => {
		gql.mockResolvedValueOnce({ errors: [{ message: "Access denied" }] });
		const r = await viaWorker(get());
		expect(r.status).toBe(502);
	});
});
