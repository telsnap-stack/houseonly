import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index";
import {
	addToFeed,
	removeFromFeed,
	getIgFeed,
	handleIgFeedAdd,
	handleIgFeedRemove,
	cleanHandle,
	IG_FEED_KEY,
	IG_FEED_MAX,
	type IgFeedItem,
} from "../src/lib/ig-feed";

const SECRET = "test-secret";

function post(action: string, body: unknown, bearer: string | null = SECRET) {
	return new Request(`https://w/?action=${action}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
		body: JSON.stringify(body),
	});
}

async function viaWorker(request: Request) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(request, env as any, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

const disco = (n: number) => ({ handle: `disco-${n}`, sku: `CAT-${n}`, title: `Title ${n}`, artist: `Artist ${n}` });

beforeEach(async () => {
	await env.SYNC_STATE.delete(IG_FEED_KEY);
	(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
});

describe("addToFeed / removeFromFeed", () => {
	it("add inserta al principio", () => {
		let f: IgFeedItem[] = [];
		f = addToFeed(f, disco(1), 1);
		f = addToFeed(f, disco(2), 2);
		expect(f.map(i => i.handle)).toEqual(["disco-2", "disco-1"]);
	});

	it("add repetido no duplica: sube al principio y actualiza addedAt", () => {
		let f: IgFeedItem[] = [];
		f = addToFeed(f, disco(1), 1);
		f = addToFeed(f, disco(2), 2);
		f = addToFeed(f, { ...disco(1), title: "Nuevo" }, 3);
		expect(f.map(i => i.handle)).toEqual(["disco-1", "disco-2"]);
		expect(f[0]).toMatchObject({ addedAt: 3, title: "Nuevo" });
	});

	it("remove quita solo ese handle", () => {
		const f = [disco(1), disco(2), disco(3)].reduce<IgFeedItem[]>((acc, d, i) => addToFeed(acc, d, i), []);
		expect(removeFromFeed(f, "disco-2").map(i => i.handle)).toEqual(["disco-3", "disco-1"]);
	});

	it("el tope es 200: caben los 137 Reels de la siembra y sobra sitio", () => {
		expect(IG_FEED_MAX).toBe(200);
		let f: IgFeedItem[] = [];
		for (let n = 1; n <= 137; n++) f = addToFeed(f, disco(n), n);
		expect(f).toHaveLength(137);
		expect(f[0].handle).toBe("disco-137");
		expect(f.at(-1)!.handle).toBe("disco-1");
	});

	it(`tope de ${IG_FEED_MAX}: el mas antiguo sale`, () => {
		let f: IgFeedItem[] = [];
		for (let n = 1; n <= IG_FEED_MAX + 5; n++) f = addToFeed(f, disco(n), n);
		expect(f).toHaveLength(IG_FEED_MAX);
		expect(f[0].handle).toBe(`disco-${IG_FEED_MAX + 5}`);
		expect(f.some(i => i.handle === "disco-5")).toBe(false);
		expect(f.at(-1)!.handle).toBe("disco-6");
	});

	it("cleanHandle solo acepta handles de Shopify", () => {
		expect(cleanHandle(" UR-081 ")).toBe("ur-081");
		expect(cleanHandle("a/b")).toBe("");
		expect(cleanHandle("")).toBe("");
	});
});

describe("handlers contra KV", () => {
	it("add persiste en SYNC_STATE y el repetido no duplica", async () => {
		await handleIgFeedAdd(post("ig-feed-add", disco(1)), env, true);
		await handleIgFeedAdd(post("ig-feed-add", disco(2)), env, true);
		const r = await handleIgFeedAdd(post("ig-feed-add", disco(1)), env, true);
		expect(r.status).toBe(200);
		expect((await getIgFeed(env)).map(i => i.handle)).toEqual(["disco-1", "disco-2"]);
	});

	it("remove quita y 404 si no estaba", async () => {
		await handleIgFeedAdd(post("ig-feed-add", disco(1)), env, true);
		expect((await handleIgFeedRemove(post("ig-feed-remove", { handle: "disco-1" }), env, true)).status).toBe(200);
		expect(await getIgFeed(env)).toEqual([]);
		expect((await handleIgFeedRemove(post("ig-feed-remove", { handle: "disco-1" }), env, true)).status).toBe(404);
	});

	it("sin handle valido: 400", async () => {
		expect((await handleIgFeedAdd(post("ig-feed-add", { title: "x" }), env, true)).status).toBe(400);
	});
});

describe("rutas del worker", () => {
	it("GET ig-feed es publico, con cache corta", async () => {
		await handleIgFeedAdd(post("ig-feed-add", disco(7)), env, true);
		const r = await viaWorker(new Request("https://w/?action=ig-feed"));
		expect(r.status).toBe(200);
		expect(r.headers.get("Cache-Control")).toBe("public, max-age=60");
		expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
		const d = await r.json() as { items: IgFeedItem[] };
		expect(d.items[0].handle).toBe("disco-7");
	});

	it("POST sin Bearer (o con uno malo) devuelve 401 y no escribe", async () => {
		expect((await viaWorker(post("ig-feed-add", disco(1), null))).status).toBe(401);
		expect((await viaWorker(post("ig-feed-add", disco(1), "otro"))).status).toBe(401);
		expect((await viaWorker(post("ig-feed-remove", { handle: "disco-1" }, null))).status).toBe(401);
		expect(await getIgFeed(env)).toEqual([]);
	});

	it("POST con Bearer bueno: add y remove por la ruta real", async () => {
		expect((await viaWorker(post("ig-feed-add", disco(1)))).status).toBe(200);
		expect((await viaWorker(post("ig-feed-add", disco(2)))).status).toBe(200);
		const d = await (await viaWorker(new Request("https://w/?action=ig-feed"))).json() as { items: IgFeedItem[] };
		expect(d.items.map(i => i.handle)).toEqual(["disco-2", "disco-1"]);
		expect((await viaWorker(post("ig-feed-remove", { handle: "disco-2" }))).status).toBe(200);
		expect((await getIgFeed(env)).map(i => i.handle)).toEqual(["disco-1"]);
	});
});
