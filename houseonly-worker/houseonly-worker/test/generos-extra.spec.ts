import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cuentaGenerosExtra, recalculaGenerosExtra, handleGenerosExtra } from "../src/lib/generos-extra";
import * as shopifyAdmin from "../src/lib/shopify-admin";

const E = env as any;
const disco = (...tags: string[]) => ({ tags });
const muchos = (n: number, ...tags: string[]) => Array.from({ length: n }, () => disco(...tags));

afterEach(() => vi.restoreAllMocks());

describe("generos extra de la rejilla", () => {
	it("solo genre:<x> fuera de la tabla, con 10 o mas discos; nombre del tag plano; recuento por vista", () => {
		const productos = [
			...muchos(8, "genre:housedeephouse", "House - Deep House"),
			...muchos(2, "genre:housedeephouse", "House - Deep House", "forthcoming"),
			...muchos(9, "genre:technodetroit", "Techno - Detroit"),          // 9: no llega
			...muchos(30, "genre:techno", "Techno - Minimal"),               // canonico: ya esta en la tabla
			...muchos(10, "genre:electronicaambient", "genre:drumandbass"),  // sin tag plano: el id
		];
		const g = cuentaGenerosExtra(productos);
		expect(g.map(x => x.id)).toEqual(["electronicaambient", "housedeephouse"]);
		expect(g[1]).toEqual({ id: "housedeephouse", label: "House - Deep House", total: 10,
			vistas: { house: 8, dnb: 0, forthcoming_house: 2, forthcoming_dnb: 0 } });
		expect(g[0]).toMatchObject({ label: "electronicaambient", vistas: { house: 0, dnb: 10 } });
	});

	it("el recalculo lee solo los activos y lo deja en KV; la lectura publica se cachea 1 h", async () => {
		const nodes = [
			...muchos(10, "genre:housedeephouse", "House - Deep House").map(p => ({ status: "ACTIVE", ...p })),
			...muchos(5, "genre:housedeephouse").map(p => ({ status: "DRAFT", ...p })),
		];
		vi.spyOn(shopifyAdmin, "shopifyAdminGraphQL").mockResolvedValue({ data: { products: { pageInfo: { hasNextPage: false }, nodes } } });
		const r = await recalculaGenerosExtra(E, new Date("2026-11-04T06:00:00Z"));
		expect(r).toMatchObject({ activos: 10, generos: [{ id: "housedeephouse", total: 10 }] });
		const res = await handleGenerosExtra(E);
		expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
		expect(await res.json()).toMatchObject({ ok: true, at: "2026-11-04T06:00:00.000Z", generos: [{ id: "housedeephouse", label: "House - Deep House" }] });
	});
});
