import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index";
import {
	REJECT_PREFIX,
	DIAS_RECHAZO_TEMPORAL,
	claveCatno,
	claveKV,
	estadoRechazo,
	clasificaFilas,
	nuevoRechazo,
	fechaCorta,
	indiceTienda,
	buscaEnTienda,
	esPedidoAntiguo,
	DIAS_PEDIDO_ANTIGUO,
} from "../src/lib/preorder-rechazos.mjs";

const SECRET = "test-secret";
const DIA = 24 * 60 * 60 * 1000;
const HOY = Date.parse("2026-10-20T10:00:00Z");

function req(method: string, action: string, body?: unknown, bearer: string | null = SECRET) {
	return new Request(`https://w/?action=${action}`, {
		method,
		headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function viaWorker(request: Request) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(request, env as any, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

const fila = (catno: string, extra = {}) => ({ catno, artist: "A", title: "T", source: "rd", ...extra });
const rechazo = (catno: string, tipo: "temporal" | "definitivo", haceDias: number) => ({
	catno, tipo, fecha: new Date(HOY - haceDias * DIA).toISOString(), distribuidor: "rd", artist: "A", title: "T",
});

beforeEach(async () => {
	(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
	const l = await env.SYNC_STATE.list({ prefix: REJECT_PREFIX });
	for (const k of l.keys) await env.SYNC_STATE.delete(k.name);
});

describe("filtro 1: ya en tienda por SKU", () => {
	it("lo que existe en Shopify no se lista; queda aparte para el contador", () => {
		const enTienda = (k: string) => k === "HT001";
		const { visibles, yaEnTienda, rechazados } = clasificaFilas([fila("HT-001"), fila("LOG88")], { enTienda, ahora: HOY });
		expect(visibles.map(r => r.catno)).toEqual(["LOG88"]);
		expect(yaEnTienda.map(r => r.catno)).toEqual(["HT-001"]);
		expect(rechazados).toEqual([]);
	});

	it("en tienda gana a un rechazo: no sale dos veces ni en el contador equivocado", () => {
		const rechazos = new Map([["HT001", rechazo("HT001", "definitivo", 1)]]);
		const r = clasificaFilas([fila("HT001")], { enTienda: () => true, rechazos, ahora: HOY });
		expect(r.yaEnTienda).toHaveLength(1);
		expect(r.rechazados).toHaveLength(0);
	});
});

describe("filtro 1: el mismo disco escrito distinto en Shopify", () => {
	// Casos reales del parseo del 2026-10-20 (SKUs de la tienda ese dia).
	const indice = indiceTienda(["UR-025A", "UR-025J", "FR315R", "LOG088", "ABC001A", "PAMPA046", "PURESHORES-001", "ENVLP00215"]);

	it("UR-025 (pedido W&S) es UR-025A / UR-025J; FR315 es FR315R", () => {
		expect(buscaEnTienda(indice, "UR-025")).toBe("UR025A");
		expect(buscaEnTienda(indice, "FR315")).toBe("FR315R");
		expect(buscaEnTienda(indice, "ur-025j")).toBe("UR025J");
	});

	it("solo ceros a la izquierda: LOG88 = LOG088", () => {
		expect(buscaEnTienda(indice, "LOG88")).toBe("LOG088");
	});

	it("no confunde discos distintos", () => {
		expect(buscaEnTienda(indice, "ABC001B")).toBeNull();      // otra parte de la serie
		expect(buscaEnTienda(indice, "PAMPA045")).toBeNull();     // 046 si esta; 045 no
		expect(buscaEnTienda(indice, "PURESHORES-002")).toBeNull();
		expect(buscaEnTienda(indice, "UR-02")).toBeNull();
		expect(buscaEnTienda(indice, "env014r")).toBeNull();      // ENVLP00215 es otro disco
	});

	it("clasificaFilas lo manda a ya en tienda", () => {
		const r = clasificaFilas([fila("UR-025"), fila("PAMPA045")], { enTienda: k => !!buscaEnTienda(indice, k), ahora: HOY });
		expect(r.yaEnTienda.map(x => x.catno)).toEqual(["UR-025"]);
		expect(r.visibles.map(x => x.catno)).toEqual(["PAMPA045"]);
	});
});

describe("filtro 2: rechazados, los dos tipos", () => {
	it('"No, por ahora" (temporal) vigente: fuera de la lista, tras el contador', () => {
		const rechazos = new Map([["LOG88", rechazo("LOG88", "temporal", 10)]]);
		const r = clasificaFilas([fila("LOG88"), fila("UNI10-002")], { rechazos, ahora: HOY });
		expect(r.visibles.map(x => x.catno)).toEqual(["UNI10-002"]);
		expect(r.rechazados[0]).toMatchObject({ catno: "LOG88", _estadoRechazo: "oculto" });
		expect(r.rechazados[0]._rechazo.tipo).toBe("temporal");
	});

	it('"Nunca" (definitivo): fuera para siempre, aunque pasen anos', () => {
		const rechazos = new Map([["LOG88", rechazo("LOG88", "definitivo", 2000)]]);
		const r = clasificaFilas([fila("LOG88")], { rechazos, ahora: HOY });
		expect(r.visibles).toEqual([]);
		expect(r.rechazados[0]._estadoRechazo).toBe("definitivo");
	});

	it("la clave es el catno normalizado: otra grafia del mismo disco tambien queda rechazada", () => {
		const rechazos = new Map([[claveCatno("YORE-011LTD"), rechazo("YORE-011LTD", "definitivo", 1)]]);
		expect(clasificaFilas([fila("YORE 011 LTD")], { rechazos, ahora: HOY }).rechazados).toHaveLength(1);
		expect(claveKV("yore-011ltd")).toBe("preorder:rejected:YORE011LTD");
	});
});

describe("pedidos sin alta en la tienda (mas de 4 semanas)", () => {
	const pedido = (catno: string, haceDias: number, extra = {}) =>
		fila(catno, { _ordered: true, _fechaPedido: new Date(HOY - haceDias * DIA).toISOString().slice(0, 10), ...extra });

	it("mas de 28 dias va a su bloque; 27 sigue en la lista", () => {
		expect(DIAS_PEDIDO_ANTIGUO).toBe(28);
		const r = clasificaFilas([pedido("FRLP44", 160), pedido("ARK010", 1), pedido("X27", 27)], { ahora: HOY });
		expect(r.antiguos.map(x => x.catno)).toEqual(["FRLP44"]);
		expect(r.visibles.map(x => x.catno)).toEqual(["ARK010", "X27"]);
	});

	it("nunca se oculta solo: a los 400 dias sigue en el bloque", () => {
		expect(clasificaFilas([pedido("PAMPA045", 400)], { ahora: HOY }).antiguos).toHaveLength(1);
	});

	it("sale del bloque solo al darlo de alta o al rechazarlo", () => {
		const rechazos = new Map([["ENV014R", rechazo("env014r", "temporal", 3)]]);
		const r = clasificaFilas([pedido("env014r", 160), pedido("UR-025", 120)], { rechazos, enTienda: k => k === "UR025", ahora: HOY });
		expect(r.antiguos).toEqual([]);
		expect(r.rechazados.map(x => x.catno)).toEqual(["env014r"]);
		expect(r.yaEnTienda.map(x => x.catno)).toEqual(["UR-025"]);
	});

	it("solo cuenta lo pedido: un anuncio viejo sin pedido no es pedido sin alta", () => {
		expect(esPedidoAntiguo(fila("RD123", { _fechaPedido: "2026-01-01" }), HOY)).toBe(false);
		expect(esPedidoAntiguo(fila("RD123", { _ordered: true }), HOY)).toBe(false);   // sin fecha: no se adivina
	});
});

describe("caducidad del temporal (90 dias)", () => {
	it("a los 89 dias sigue oculto; a los 90 vuelve a la lista marcado con su fecha", () => {
		expect(DIAS_RECHAZO_TEMPORAL).toBe(90);
		expect(estadoRechazo(rechazo("X", "temporal", 89), HOY)).toBe("oculto");
		expect(estadoRechazo(rechazo("X", "temporal", 90), HOY)).toBe("caducado");
		const rec = rechazo("LOG88", "temporal", 91);
		const r = clasificaFilas([fila("LOG88")], { rechazos: new Map([["LOG88", rec]]), ahora: HOY });
		expect(r.visibles[0]).toMatchObject({ catno: "LOG88", _rechazadoEl: rec.fecha });
		expect(r.rechazados).toEqual([]);
		expect(fechaCorta(rec.fecha)).toBe("21/07/2026");
	});

	it("el definitivo no caduca", () => {
		expect(estadoRechazo(rechazo("X", "definitivo", 365), HOY)).toBe("definitivo");
	});
});

describe("nuevoRechazo", () => {
	it("exige catno y un tipo valido; fecha la pone el servidor", () => {
		expect(nuevoRechazo({ tipo: "temporal" })).toEqual({ error: "catno required" });
		expect((nuevoRechazo({ catno: "X1", tipo: "luego" }) as any).error).toMatch(/temporal or definitivo/);
		expect(nuevoRechazo({ catno: " LOG88 ", tipo: "definitivo", distribuidor: "rd", fecha: "1999-01-01" }, HOY))
			.toMatchObject({ catno: "LOG88", tipo: "definitivo", distribuidor: "rd", fecha: "2026-10-20T10:00:00.000Z" });
	});
});

describe("endpoints (Bearer admin)", () => {
	it("sin Bearer o con uno malo: 401 en los tres", async () => {
		for (const bearer of [null, "malo"]) {
			expect((await viaWorker(req("GET", "preorder-rejects", undefined, bearer))).status).toBe(401);
			expect((await viaWorker(req("POST", "preorder-reject", { catno: "X1", tipo: "temporal" }, bearer))).status).toBe(401);
			expect((await viaWorker(req("DELETE", "preorder-reject", { catno: "X1" }, bearer))).status).toBe(401);
		}
		expect((await env.SYNC_STATE.list({ prefix: REJECT_PREFIX })).keys).toHaveLength(0);
	});

	it("guarda los dos tipos en KV con fecha, distribuidor y tipo, y los lista", async () => {
		let r = await viaWorker(req("POST", "preorder-reject", { catno: "LOG-88", tipo: "temporal", distribuidor: "rd", artist: "Hot Towel", title: "EP" }));
		expect(r.status).toBe(200);
		r = await viaWorker(req("POST", "preorder-reject", { catno: "UNI10-002", tipo: "definitivo", distribuidor: "tv" }));
		expect(r.status).toBe(200);

		const guardado = await env.SYNC_STATE.get("preorder:rejected:LOG88", "json") as any;
		expect(guardado).toMatchObject({ catno: "LOG-88", tipo: "temporal", distribuidor: "rd", artist: "Hot Towel" });
		expect(Date.parse(guardado.fecha)).toBeGreaterThan(0);

		const lista = await (await viaWorker(req("GET", "preorder-rejects"))).json() as any;
		expect(lista.items.map((i: any) => `${i.catno}:${i.tipo}`).sort()).toEqual(["LOG-88:temporal", "UNI10-002:definitivo"]);
	});

	it("tipo invalido: 400 y no guarda nada", async () => {
		expect((await viaWorker(req("POST", "preorder-reject", { catno: "X1", tipo: "nunca-jamas" }))).status).toBe(400);
		expect((await env.SYNC_STATE.list({ prefix: REJECT_PREFIX })).keys).toHaveLength(0);
	});

	it("recuperar borra el rechazo, tambien un definitivo; recuperar dos veces da 404", async () => {
		await viaWorker(req("POST", "preorder-reject", { catno: "UNI10-002", tipo: "definitivo", distribuidor: "tv" }));
		expect((await viaWorker(req("DELETE", "preorder-reject", { catno: "uni10 002" }))).status).toBe(200);
		expect(await env.SYNC_STATE.get("preorder:rejected:UNI10002")).toBeNull();
		expect((await viaWorker(req("DELETE", "preorder-reject", { catno: "UNI10-002" }))).status).toBe(404);
	});
});
