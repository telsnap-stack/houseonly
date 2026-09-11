import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
	loadFollows, listFollows, addFollow, removeFollow, mergeFollows,
	buildFeed, entityPage, annotate, expandDown,
	clampDays, clampLimit, afterCursor,
	MAX_FOLLOWS, FEED_DAYS_DEFAULT, FEED_DAYS_MAX,
} from "../src/lib/follows";

const CID = "7788990011";

async function wipe() {
	for (const prefix of ["entity:", "alias:", "ignore:", "children:", "follow:", "fanout:", "feedindex:"]) {
		const l = await env.ENTITIES.list({ prefix, limit: 1000 });
		for (const k of l.keys) await env.ENTITIES.delete(k.name);
	}
}

async function entidad(slug: string, display: string, roles: string[] = ["artist"], extra: any = {}) {
	await env.ENTITIES.put(`entity:${slug}`, JSON.stringify({
		slug, display, roles, aliases: [], sources: ["test"], status: "active",
		createdAt: 1, updatedAt: 1, ...extra,
	}));
}

/** Mete un indice ya construido para que el feed no salga a la red. */
async function indice(items: any[], builtAt = Date.now()) {
	await env.ENTITIES.put("feedindex:v1", JSON.stringify({ builtAt, items }));
}

const dias = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

function producto(handle: string, dias_: number, artistSlugs: string[] = [], labelSlugs: string[] = []) {
	return {
		handle, title: handle.toUpperCase(), vendor: "X", createdAt: dias(dias_),
		forthcoming: false, releaseDate: "", imageUrl: "", price: "12.00",
		currency: "EUR", stock: 1, artistSlugs, labelSlugs,
	};
}

describe("follows: alta", () => {
	beforeEach(async () => { await wipe(); await entidad("dj-koze", "DJ Koze"); });

	it("guarda el blob y la clave de fanout", async () => {
		const res: any = await addFollow(env as any, CID, "dj-koze");
		expect(res).toMatchObject({ ok: true, slug: "dj-koze", changed: true });
		expect((await loadFollows(env as any, CID)).entities).toEqual(["dj-koze"]);
		expect(await env.ENTITIES.get(`fanout:dj-koze:${CID}`)).toBe("1");
	});

	it("rechaza un slug que no es ninguna entidad", async () => {
		const res: any = await addFollow(env as any, CID, "no-existe");
		expect(res.status).toBe(400);
		expect(res.error).toMatch(/unknown entity/);
		// Y no deja rastro: un follow a un slug muerto no lo mira nadie nunca mas.
		expect((await loadFollows(env as any, CID)).entities).toEqual([]);
		expect(await env.ENTITIES.get(`fanout:no-existe:${CID}`)).toBeNull();
	});

	it("es idempotente: seguir dos veces no duplica", async () => {
		await addFollow(env as any, CID, "dj-koze");
		const res: any = await addFollow(env as any, CID, "dj-koze");
		expect(res.changed).toBe(false);
		expect((await loadFollows(env as any, CID)).entities).toEqual(["dj-koze"]);
		const fan = await env.ENTITIES.list({ prefix: "fanout:" });
		expect(fan.keys).toHaveLength(1);
	});

	it("un alta repetida reafirma el fanout que se hubiera quedado a medias", async () => {
		await addFollow(env as any, CID, "dj-koze");
		await env.ENTITIES.delete(`fanout:dj-koze:${CID}`);   // simula el fallo entre las dos escrituras
		await addFollow(env as any, CID, "dj-koze");
		expect(await env.ENTITIES.get(`fanout:dj-koze:${CID}`)).toBe("1");
	});

	it("seguir una entidad fusionada sigue a la viva", async () => {
		await entidad("freerange-records", "Freerange Records");
		await entidad("freerange", "Freerange", ["label"], { status: "merged", mergedInto: "freerange-records" });
		const res: any = await addFollow(env as any, CID, "freerange");
		expect(res.slug).toBe("freerange-records");
		expect((await loadFollows(env as any, CID)).entities).toEqual(["freerange-records"]);
	});

	it("no pasa del tope", async () => {
		const llenas = Array.from({ length: MAX_FOLLOWS }, (_, i) => `e${i}`);
		await env.ENTITIES.put(`follow:${CID}`, JSON.stringify({ entities: llenas, updatedAt: 1 }));
		const res: any = await addFollow(env as any, CID, "dj-koze");
		expect(res.status).toBe(400);
		expect(res.error).toMatch(/too many/);
	});
});

describe("follows: baja", () => {
	beforeEach(async () => {
		await wipe();
		await entidad("dj-koze", "DJ Koze");
		await addFollow(env as any, CID, "dj-koze");
	});

	it("quita el fanout y la entrada del blob", async () => {
		const res: any = await removeFollow(env as any, CID, "dj-koze");
		expect(res.changed).toBe(true);
		expect((await loadFollows(env as any, CID)).entities).toEqual([]);
		expect(await env.ENTITIES.get(`fanout:dj-koze:${CID}`)).toBeNull();
	});

	it("es idempotente: quitar lo que no se sigue no es un error", async () => {
		await removeFollow(env as any, CID, "dj-koze");
		const res: any = await removeFollow(env as any, CID, "dj-koze");
		expect(res.ok).toBe(true);
		expect(res.changed).toBe(false);
	});

	it("deja quitarse de encima una entidad que ya no existe", async () => {
		await env.ENTITIES.put(`follow:${CID}`, JSON.stringify({ entities: ["fantasma"], updatedAt: 1 }));
		await env.ENTITIES.put(`fanout:fantasma:${CID}`, "1");
		const res: any = await removeFollow(env as any, CID, "fantasma");
		expect(res.changed).toBe(true);
		expect(await env.ENTITIES.get(`fanout:fantasma:${CID}`)).toBeNull();
	});
});

describe("follows: lista", () => {
	beforeEach(async () => { await wipe(); });

	it("devuelve display y roles, no solo slugs", async () => {
		await entidad("2000black", "2000Black", ["artist", "label"]);
		await addFollow(env as any, CID, "2000black");
		const { entities } = await listFollows(env as any, CID);
		expect(entities).toEqual([{ slug: "2000black", display: "2000Black", roles: ["artist", "label"] }]);
	});

	it("limpia lo que ya no existe y lo guarda limpio", async () => {
		await env.ENTITIES.put(`follow:${CID}`, JSON.stringify({ entities: ["fantasma"], updatedAt: 1 }));
		const { entities } = await listFollows(env as any, CID);
		expect(entities).toEqual([]);
		expect((await loadFollows(env as any, CID)).entities).toEqual([]);
	});
});

describe("follows: merge invitado → logueado", () => {
	beforeEach(async () => { await wipe(); await entidad("dj-koze", "DJ Koze"); await entidad("rawax", "Rawax", ["label"]); });

	it("suma lo que llega sin perder lo que habia, y dice lo que descarta", async () => {
		await addFollow(env as any, CID, "dj-koze");
		const res = await mergeFollows(env as any, CID, ["rawax", "dj-koze", "no-existe"]);
		expect(res.entities).toEqual(["dj-koze", "rawax"]);
		expect(res.added).toEqual(["rawax"]);
		expect(res.skipped).toEqual(["no-existe"]);
		expect(await env.ENTITIES.get(`fanout:rawax:${CID}`)).toBe("1");
	});
});

describe("feed", () => {
	beforeEach(async () => {
		await wipe();
		await entidad("omar-s", "Omar S");
		await entidad("deep-jungle", "Deep Jungle", ["label"]);
		await entidad("otro", "Otro");
	});

	it("sin entidades seguidas, cuerpo vacio y no la portada", async () => {
		const feed = await buildFeed(env as any, CID);
		expect(feed.items).toEqual([]);
		expect(feed.following).toBe(0);
		expect(feed.window.days).toBe(FEED_DAYS_DEFAULT);
	});

	it("cruza por artista y por sello, y dice que entidad lo trajo", async () => {
		await indice([
			producto("suyo", 3, ["omar-s"]),
			producto("delsello", 5, ["quien-sea"], ["deep-jungle"]),
			producto("ajeno", 2, ["otro-artista"], ["otro-sello"]),
		]);
		await addFollow(env as any, CID, "omar-s");
		await addFollow(env as any, CID, "deep-jungle");

		const feed = await buildFeed(env as any, CID);
		expect(feed.items.map(i => i.handle)).toEqual(["suyo", "delsello"]);
		expect(feed.items[0].via).toEqual(["omar-s"]);
		expect(feed.items[1].via).toEqual(["deep-jungle"]);
	});

	it("un disco de fuera de la ventana no sale", async () => {
		await indice([producto("viejo", 120, ["omar-s"]), producto("nuevo", 10, ["omar-s"])]);
		await addFollow(env as any, CID, "omar-s");
		const feed = await buildFeed(env as any, CID);
		expect(feed.items.map(i => i.handle)).toEqual(["nuevo"]);
		// …salvo que se pida una ventana mas ancha, con su tope.
		const ancho = await buildFeed(env as any, CID, { days: 999 });
		expect(ancho.window.days).toBe(FEED_DAYS_MAX);
		expect(ancho.items.map(i => i.handle)).toEqual(["nuevo", "viejo"]);
	});

	it("ordena por fecha descendente y pagina con cursor estable", async () => {
		await indice([producto("a", 1, ["omar-s"]), producto("b", 2, ["omar-s"]), producto("c", 3, ["omar-s"])]);
		await addFollow(env as any, CID, "omar-s");

		const p1 = await buildFeed(env as any, CID, { limit: 2 });
		expect(p1.items.map(i => i.handle)).toEqual(["a", "b"]);
		expect(p1.cursor).toBeTruthy();

		const p2 = await buildFeed(env as any, CID, { limit: 2, cursor: p1.cursor! });
		expect(p2.items.map(i => i.handle)).toEqual(["c"]);
		expect(p2.cursor).toBeNull();
	});

	it("seguir al padre trae al hijo, y el via dice quien lo trajo", async () => {
		await entidad("chiwax", "Chiwax", ["label"]);
		await entidad("chiwax-classic-edition", "Chiwax Classic Edition", ["label"], { parent: "chiwax" });
		await env.ENTITIES.put("children:chiwax:chiwax-classic-edition", "1");
		await indice([producto("delhijo", 4, [], ["chiwax-classic-edition"])]);
		await addFollow(env as any, CID, "chiwax");

		const feed = await buildFeed(env as any, CID);
		expect(feed.items.map(i => i.handle)).toEqual(["delhijo"]);
		expect(feed.items[0].via).toEqual(["chiwax"]);
	});

	it("un split cuenta para cada uno de sus artistas", async () => {
		await indice([producto("split", 1, ["norm-talley", "omar-s", "d-julz"])]);
		await addFollow(env as any, CID, "omar-s");
		const feed = await buildFeed(env as any, CID);
		expect(feed.items).toHaveLength(1);
		expect(feed.items[0].via).toEqual(["omar-s"]);
	});
});

describe("annotate: metafield primero, alias despues", () => {
	beforeEach(async () => { await wipe(); });

	it("usa el metafield cuando esta", async () => {
		const [p] = await annotate(env as any, [{
			handle: "x", title: "X", vendor: "Omar S", tags: ["label:FXHE"],
			artist: { value: "omar-s" }, label: { value: "fxhe" }, variants: { nodes: [] },
		}]);
		expect(p.artistSlugs).toEqual(["omar-s"]);
		expect(p.labelSlugs).toEqual(["fxhe"]);
	});

	it("cae a alias: cuando el metafield falta — el feed funciona desde el primer dia", async () => {
		await env.ENTITIES.put("alias:a:omars", "omar-s");
		await env.ENTITIES.put("alias:l:fxhe", "fxhe");
		const [p] = await annotate(env as any, [{
			handle: "x", title: "X", vendor: "Omar-S", tags: ["Label: FXHE", "forthcoming"],
			artist: null, label: null, variants: { nodes: [] },
		}]);
		expect(p.artistSlugs).toEqual(["omar-s"]);
		expect(p.labelSlugs).toEqual(["fxhe"]);
		expect(p.forthcoming).toBe(true);
	});

	it("un alias con varios slugs se parte en varios", async () => {
		await env.ENTITIES.put("alias:a:delanosmithbriankage", "delano-smith,brian-kage");
		const [p] = await annotate(env as any, [{
			handle: "y", title: "Y", vendor: "Delano Smith & Brian Kage", tags: [],
			artist: null, label: null, variants: { nodes: [] },
		}]);
		expect(p.artistSlugs).toEqual(["delano-smith", "brian-kage"]);
	});
});

describe("ficha publica de entidad", () => {
	beforeEach(async () => { await wipe(); });

	it("devuelve la entidad y sus productos, sin ventana", async () => {
		await entidad("omar-s", "Omar S", ["artist"], { aliases: ["Omar S", "omar s"] });
		await indice([producto("viejo", 400, ["omar-s"]), producto("nuevo", 2, ["omar-s"]), producto("ajeno", 1, ["otro"])]);
		const page = await entityPage(env as any, "omar-s");
		expect(page!.display).toBe("Omar S");
		expect(page!.aliases).toEqual(["Omar S", "omar s"]);
		expect(page!.total).toBe(2);
		expect(page!.products.map(p => p.handle)).toEqual(["nuevo", "viejo"]);
	});

	it("un slug que no existe es 404, no una ficha vacia", async () => {
		expect(await entityPage(env as any, "fantasma")).toBeNull();
	});
});

describe("topes y cursor", () => {
	it("la ventana por defecto son 90 dias y el tope 180", () => {
		expect(clampDays(undefined)).toBe(90);
		expect(clampDays("30")).toBe(30);
		expect(clampDays("500")).toBe(180);
		expect(clampDays("-5")).toBe(90);
		expect(clampDays("abc")).toBe(90);
	});

	it("el limite por pagina tiene tope", () => {
		expect(clampLimit(undefined)).toBe(24);
		expect(clampLimit("1000")).toBe(100);
	});

	it("un cursor que ya no existe no rompe la paginacion", () => {
		const items: any[] = [{ createdAt: "2026-01-01T00:00:00Z", handle: "a" }];
		expect(afterCursor(items, "2026-05-05T00:00:00Z|borrado")).toHaveLength(1);
	});
});

describe("expandDown", () => {
	beforeEach(async () => { await wipe(); });
	it("mapea cada hijo a la entidad seguida que lo trajo", async () => {
		await env.ENTITIES.put("children:rawax:rawax-motor-city-edition", "1");
		const m = await expandDown(env as any, ["rawax"]);
		expect(m.get("rawax")).toBe("rawax");
		expect(m.get("rawax-motor-city-edition")).toBe("rawax");
	});
});
