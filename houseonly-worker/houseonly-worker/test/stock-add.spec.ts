import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as shopifyAdmin from "../src/lib/shopify-admin";
import { handleStockAdd } from "../src/lib/stock-add";

vi.mock("../src/lib/shopify-admin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/shopify-admin")>();
	return { ...actual, shopifyAdminGraphQL: vi.fn(), getShopifyAdminToken: vi.fn() };
});

const gql = vi.mocked(shopifyAdmin.shopifyAdminGraphQL);
const FACTURA = "SI-TEST-001";

/** Shopify falso: responde segun el tipo de consulta. */
function tienda(opts: { tags?: string[]; ajusteFalla?: boolean; tagFalla?: boolean } = {}) {
	gql.mockImplementation(async (_env: any, query: string, vars?: any) => {
		if (query.includes("currentAppInstallation")) return { data: { currentAppInstallation: { accessScopes: [{ handle: "write_inventory" }, { handle: "read_inventory" }, { handle: "read_locations" }] } } };
		if (query.includes("locations(")) return { data: { locations: { edges: [{ node: { id: "gid://shopify/Location/1", name: "Madrid" } }] } } };
		if (query.includes("productVariants")) return { data: { productVariants: { edges: [{ node: {
			sku: "UR-081", product: { id: "gid://shopify/Product/9", title: "Call Me", tags: opts.tags ?? [] },
			inventoryItem: { id: "gid://shopify/InventoryItem/7", tracked: true, inventoryLevel: { quantities: [{ name: "available", quantity: -2 }] } },
		} }] } } };
		if (query.includes("inventoryAdjustQuantities")) {
			if (opts.ajusteFalla) return { data: { inventoryAdjustQuantities: { userErrors: [{ message: "stale", code: "CHANGE_FROM_QUANTITY_STALE" }], inventoryAdjustmentGroup: null } } };
			const d = vars.input.changes[0].delta;
			return { data: { inventoryAdjustQuantities: { userErrors: [], inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1", changes: [{ name: "available", delta: d, quantityAfterChange: -2 + d }] } } } };
		}
		if (query.includes("tagsRemove")) {
			if (opts.tagFalla) return { data: { tagsRemove: { node: null, userErrors: [{ field: ["tags"], message: "no se pudo" }] } } };
			return { data: { tagsRemove: { node: { id: vars.id }, userErrors: [] } } };
		}
		throw new Error(`consulta inesperada: ${query.slice(0, 60)}`);
	});
}

const peticion = (dry: boolean) => new Request("https://w/?action=stock-add", {
	method: "POST", headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ invoice: FACTURA, source: "rd", dry, items: [{ sku: "UR-081", delta: 5 }] }),
});
const llamadasTagsRemove = () => gql.mock.calls.filter(([, q]) => String(q).includes("tagsRemove"));
const registro = async () => env.STOCK_LEDGER.get(`stock:${FACTURA}:UR-081`, "json") as Promise<any>;

beforeEach(async () => {
	gql.mockReset();
	await env.STOCK_LEDGER.delete(`stock:${FACTURA}:UR-081`);
});

describe("stock-add: tag forthcoming", () => {
	it("dry-run con forthcoming: avisa 'quitaria', no toca Shopify ni el libro", async () => {
		tienda({ tags: ["vinyl", "forthcoming", "release:2026-10-30"] });
		const d = await (await handleStockAdd(peticion(true), env as any, true)).json() as any;
		expect(d.resultados[0]).toMatchObject({ sku: "UR-081", estado: "sumaria", antes: -2, despues: 3, forthcoming: "quitaria" });
		expect(llamadasTagsRemove()).toHaveLength(0);
		expect(gql.mock.calls.some(([, q]) => String(q).includes("inventoryAdjustQuantities"))).toBe(false);
		expect(await registro()).toBeNull();
	});

	it("dry-run sin forthcoming: no dice nada del tag", async () => {
		tienda({ tags: ["vinyl"] });
		const d = await (await handleStockAdd(peticion(true), env as any, true)).json() as any;
		expect(d.resultados[0].forthcoming).toBeUndefined();
	});

	it("suma correcta con forthcoming: quita SOLO ese tag y el libro lo registra", async () => {
		tienda({ tags: ["vinyl", "forthcoming", "release:2026-10-30"] });
		const d = await (await handleStockAdd(peticion(false), env as any, true)).json() as any;
		expect(d.resultados[0]).toMatchObject({ estado: "sumado", antes: -2, despues: 3, forthcoming: "quitado" });
		const tr = llamadasTagsRemove();
		expect(tr).toHaveLength(1);
		expect(tr[0][2]).toEqual({ id: "gid://shopify/Product/9", tags: ["forthcoming"] });
		const r = await registro();
		expect(r).toMatchObject({ estado: "aplicado", delta: 5, despues: 3, forthcoming: { estado: "quitado", productId: "gid://shopify/Product/9" } });
		expect(r.forthcoming.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("suma correcta sin forthcoming: no llama a tagsRemove y el libro no menciona el tag", async () => {
		tienda({ tags: ["vinyl"] });
		const d = await (await handleStockAdd(peticion(false), env as any, true)).json() as any;
		expect(d.resultados[0].estado).toBe("sumado");
		expect(llamadasTagsRemove()).toHaveLength(0);
		expect((await registro()).forthcoming).toBeUndefined();
	});

	it("si la suma falla, el tag no se toca y el libro se libera", async () => {
		tienda({ tags: ["forthcoming"], ajusteFalla: true });
		const d = await (await handleStockAdd(peticion(false), env as any, true)).json() as any;
		expect(d.resultados[0].estado).toBe("error");
		expect(llamadasTagsRemove()).toHaveLength(0);
		expect(await registro()).toBeNull();
	});

	it("si quitar el tag falla, la suma se queda: 'sumado', libro 'aplicado' y el error anotado", async () => {
		tienda({ tags: ["forthcoming"], tagFalla: true });
		const d = await (await handleStockAdd(peticion(false), env as any, true)).json() as any;
		expect(d.resultados[0]).toMatchObject({ estado: "sumado", forthcoming: "error", forthcomingMotivo: "no se pudo" });
		expect(await registro()).toMatchObject({ estado: "aplicado", forthcoming: { estado: "error", motivo: "no se pudo" } });
	});

	it("factura ya aplicada: ni suma ni toca el tag", async () => {
		tienda({ tags: ["forthcoming"] });
		await env.STOCK_LEDGER.put(`stock:${FACTURA}:UR-081`, JSON.stringify({ estado: "aplicado", delta: 5, at: "2026-10-01T00:00:00Z" }));
		const d = await (await handleStockAdd(peticion(false), env as any, true)).json() as any;
		expect(d.resultados[0].estado).toBe("ya-aplicado");
		expect(llamadasTagsRemove()).toHaveLength(0);
	});
});
