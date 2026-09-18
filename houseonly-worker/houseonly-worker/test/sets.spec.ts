import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
	parseSetUrl,
	resolveSetMeta,
	filterCandidates,
	getSets,
	handleSetsAdd,
	handleSetsRemove,
	handleSetsOrder,
	handleSetsList,
	handleSetsReviewPut,
	handleSetsReviewList,
	handleSetsReviewApprove,
	handleSetsReviewReject,
	MAX_SETS,
	buildListen,
} from "../src/lib/sets";

// URLs reales: el Boiler Room de Theo Parrish, el episodio de Omar S en NTS
// (Mixcloud) y su version en SoundCloud, comprobadas el 2026-09-18.
const SECRET = "test-secret";
const YT = "https://www.youtube.com/watch?v=7wZ5-lb7bQ4";
const MC = "https://www.mixcloud.com/NTSRadio/omar-s-remote-utopias-2nd-may-2020/";
const SC = "https://soundcloud.com/user-543006032/omar-s-241221";

function req(action: string, body?: any) {
	return new Request(`https://w/?action=${action}`, {
		method: body ? "POST" : "GET",
		headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function wipe() {
	for (const prefix of ["entity:", "sets:", "setreview:"]) {
		const l = await env.ENTITIES.list({ prefix, limit: 1000 });
		for (const k of l.keys) await env.ENTITIES.delete(k.name);
	}
}

async function seed() {
	await wipe();
	(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
	await env.ENTITIES.put("entity:theo-parrish", JSON.stringify({
		slug: "theo-parrish", display: "Theo Parrish", roles: ["artist"], aliases: [], sources: [],
		status: "active", createdAt: 1, updatedAt: 1,
	}));
}

describe("parseSetUrl", () => {
	it("acepta un video, una pista y un show, en sus varias formas", () => {
		expect(parseSetUrl(YT)).toEqual({ source: "youtube", id: "youtube:7wZ5-lb7bQ4", url: YT });
		expect(parseSetUrl("https://youtu.be/7wZ5-lb7bQ4?t=90")).toEqual({ source: "youtube", id: "youtube:7wZ5-lb7bQ4", url: YT });
		expect(parseSetUrl("https://m.youtube.com/watch?v=7wZ5-lb7bQ4&list=X")).toEqual({ source: "youtube", id: "youtube:7wZ5-lb7bQ4", url: YT });
		expect(parseSetUrl(SC)?.id).toBe("soundcloud:user-543006032/omar-s-241221");
		expect(parseSetUrl(MC)?.id).toBe("mixcloud:NTSRadio/omar-s-remote-utopias-2nd-may-2020");
	});

	it("una CUENTA no es un set: eso es un enlace de entidad", () => {
		expect(parseSetUrl("https://soundcloud.com/pamparecords")).toBeNull();
		expect(parseSetUrl("https://www.youtube.com/channel/UCGuRflg2kG0R-RMdxOWPg4g")).toBeNull();
		expect(parseSetUrl("https://www.mixcloud.com/NTSRadio/")).toBeNull();
		expect(parseSetUrl("https://soundcloud.com/x/sets/lista")).toBeNull();
		expect(parseSetUrl("https://bandcamp.com/algo")).toBeNull();
		expect(parseSetUrl("no es una url")).toBeNull();
	});
});

describe("resolveSetMeta", () => {
	it("lee el oEmbed de YouTube", async () => {
		const fake = (async () => new Response(JSON.stringify({
			title: "Theo Parrish Boiler Room London DJ Set", author_name: "Boiler Room",
			thumbnail_url: "https://i.ytimg.com/vi/7wZ5-lb7bQ4/hqdefault.jpg",
		}))) as unknown as typeof fetch;
		expect(await resolveSetMeta(parseSetUrl(YT)!, fake)).toEqual({
			title: "Theo Parrish Boiler Room London DJ Set", author: "Boiler Room",
			thumbnail: "https://i.ytimg.com/vi/7wZ5-lb7bQ4/hqdefault.jpg",
		});
	});

	it("de Mixcloud saca ademas la fecha, que su oembed no da", async () => {
		const fake = (async () => new Response(JSON.stringify({
			name: "Omar S - Remote Utopias - 2nd May 2020", user: { name: "Mixcloud NTS Radio" },
			pictures: { medium: "https://thumbnailer.mixcloud.com/x.jpg" }, created_time: "2020-05-04T12:03:33Z",
		}))) as unknown as typeof fetch;
		expect(await resolveSetMeta(parseSetUrl(MC)!, fake)).toMatchObject({
			title: "Omar S - Remote Utopias - 2nd May 2020", author: "Mixcloud NTS Radio", publishedAt: "2020-05-04T12:03:33Z",
		});
	});

	it("si la fuente no contesta, el set se guarda igual", async () => {
		const fake = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
		expect(await resolveSetMeta(parseSetUrl(YT)!, fake)).toEqual({});
	});
});

describe("pegar, quitar y ordenar", () => {
	beforeEach(seed);

	it("pegar una URL la guarda; repetirla no la duplica", async () => {
		const r1: any = await (await handleSetsAdd(req("sets-add", { slug: "theo-parrish", url: YT }), env as any)).json();
		expect(r1.sets.items).toHaveLength(1);
		expect(r1.sets.items[0]).toMatchObject({ id: "youtube:7wZ5-lb7bQ4", source: "youtube", via: "manual" });
		const r2: any = await (await handleSetsAdd(req("sets-add", { slug: "theo-parrish", url: "https://youtu.be/7wZ5-lb7bQ4" }), env as any)).json();
		expect(r2.already).toBe(true);
		expect(r2.sets.items).toHaveLength(1);
	});

	it("una cuenta o una entidad que no existe se rechazan con su motivo", async () => {
		const a = await handleSetsAdd(req("sets-add", { slug: "theo-parrish", url: "https://soundcloud.com/pamparecords" }), env as any);
		expect(a.status).toBe(400);
		expect((await a.json() as any).error).toMatch(/SoundCloud track/);
		const b = await handleSetsAdd(req("sets-add", { slug: "no-existe", url: YT }), env as any);
		expect(b.status).toBe(404);
	});

	it("quitar uno lo descarta para que la busqueda no lo repropone", async () => {
		await handleSetsAdd(req("sets-add", { slug: "theo-parrish", url: YT }), env as any);
		const r: any = await (await handleSetsRemove(req("sets-remove", { slug: "theo-parrish", id: "youtube:7wZ5-lb7bQ4" }), env as any)).json();
		expect(r.sets.items).toHaveLength(0);
		expect(r.sets.rejected).toEqual(["youtube:7wZ5-lb7bQ4"]);
	});

	it("el orden es el que se enseña, y reordenar no pierde nada", async () => {
		for (const u of [YT, MC, SC]) await handleSetsAdd(req("sets-add", { slug: "theo-parrish", url: u }), env as any);
		const r: any = await (await handleSetsOrder(req("sets-order", {
			slug: "theo-parrish", ids: ["mixcloud:NTSRadio/omar-s-remote-utopias-2nd-may-2020"],
		}), env as any)).json();
		expect(r.sets.items.map((i: any) => i.source)).toEqual(["mixcloud", "youtube", "soundcloud"]);
		const l: any = await (await handleSetsList(req("sets-list") as any, env as any)).json();
		expect(l.error).toBe("slug required");
	});

	it("tope por entidad", async () => {
		const rec = await getSets(env as any, "theo-parrish");
		rec.items = Array.from({ length: MAX_SETS }, (_, i) => ({
			id: `youtube:x${i}`, source: "youtube" as const, url: `https://www.youtube.com/watch?v=x${i}`, addedAt: 1, via: "manual" as const,
		}));
		await env.ENTITIES.put("sets:theo-parrish", JSON.stringify(rec));
		const r = await handleSetsAdd(req("sets-add", { slug: "theo-parrish", url: YT }), env as any);
		expect(r.status).toBe(400);
	});
});

describe("candidatos de la busqueda", () => {
	beforeEach(seed);

	const cand = (url: string, title: string) => ({ url, title, author: "Boiler Room", query: "theo parrish boiler room" });

	it("entran a la cola, se aprueban los elegidos y el resto se descarta", async () => {
		const put: any = await (await handleSetsReviewPut(req("sets-review-put", { items: [
			{ slug: "theo-parrish", candidates: [cand(YT, "Boiler Room London"), cand(MC, "NTS"), cand("https://soundcloud.com/pamparecords", "una cuenta")] },
			{ slug: "no-existe", candidates: [cand(YT, "x")] },
		] }), env as any)).json();
		expect(put).toEqual({ written: 1, dropped: 0, skipped: 1 });

		const list: any = await (await handleSetsReviewList(req("sets-review-list"), env as any)).json();
		expect(list.candidates).toBe(2);   // la cuenta de SoundCloud no cuenta como set

		const ap: any = await (await handleSetsReviewApprove(req("sets-review-approve", {
			slug: "theo-parrish", ids: ["youtube:7wZ5-lb7bQ4"],
		}), env as any)).json();
		expect(ap.added).toBe(1);
		expect(ap.sets.items[0]).toMatchObject({ via: "search", title: "Boiler Room London" });
		expect(ap.sets.rejected).toEqual(["mixcloud:NTSRadio/omar-s-remote-utopias-2nd-may-2020"]);
		expect(await env.ENTITIES.get("setreview:theo-parrish")).toBeNull();
	});

	it("lo aprobado y lo descartado no vuelven a proponerse", async () => {
		await handleSetsAdd(req("sets-add", { slug: "theo-parrish", url: YT }), env as any);
		const put: any = await (await handleSetsReviewPut(req("sets-review-put", {
			items: [{ slug: "theo-parrish", candidates: [cand(YT, "el mismo")] },
		] }), env as any)).json();
		expect(put).toEqual({ written: 0, dropped: 1, skipped: 0 });
	});

	it("rechazar la fila entera los descarta todos", async () => {
		await handleSetsReviewPut(req("sets-review-put", { items: [{ slug: "theo-parrish", candidates: [cand(YT, "a"), cand(MC, "b")] }] }), env as any);
		await handleSetsReviewReject(req("sets-review-reject", { slug: "theo-parrish" }), env as any);
		const rec = await getSets(env as any, "theo-parrish");
		expect(rec.items).toHaveLength(0);
		expect(rec.rejected).toHaveLength(2);
	});

	it("filterCandidates quita duplicados dentro de la misma tanda", () => {
		const c = (id: string) => ({ id, source: "youtube" as const, url: "u", query: "q", foundAt: 1 });
		const out = filterCandidates([c("youtube:a"), c("youtube:a"), c("youtube:b")],
			{ slug: "x", items: [], rejected: ["youtube:b"], updatedAt: 0 });
		expect(out.map(x => x.id)).toEqual(["youtube:a"]);
	});

	it("sin Bearer, 401", async () => {
		const r = await handleSetsList(new Request("https://w/?action=sets-list&slug=theo-parrish"), env as any);
		expect(r.status).toBe(401);
	});
});

describe("bloque Listen (fase 7D)", () => {
	beforeEach(seed);

	const external = (extra: any) => env.ENTITIES.put("external:theo-parrish",
		JSON.stringify({ slug: "theo-parrish", approved: {}, rejected: {}, updatedAt: 1, ...extra }));

	it("sin nada aprobado no hay bloque: un Listen vacio es peor que ninguno", async () => {
		expect(await buildListen(env as any, "theo-parrish")).toBeNull();
	});

	it("el orden es sets, YouTube, SoundCloud, Mixcloud, NTS — y el tour aparte", async () => {
		await external({
			youtube: "UCabcdefghijklmnopqrstuv", soundcloud: "soundsignature",
			mixcloud: "theoparrish", nts: "shows/theo-parrish",
			ra: "dj/theoparrish", songkick: "188726",
		});
		await handleSetsAdd(req("sets-add", { slug: "theo-parrish", url: YT }), env as any);

		const l = (await buildListen(env as any, "theo-parrish"))!;
		expect(l.sets.map(s => s.id)).toEqual(["youtube:7wZ5-lb7bQ4"]);
		expect(l.links.map(x => x.kind)).toEqual(["youtube", "soundcloud", "mixcloud", "nts"]);
		expect(l.tour.map(x => x.kind)).toEqual(["ra", "songkick"]);
		expect(l.links[0].url).toBe("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv");
		expect(l.tour[1].url).toBe("https://www.songkick.com/artists/188726");
	});

	it("la foto del cron pone fecha al enlace de Mixcloud", async () => {
		await external({ mixcloud: "Defectedrecords" });
		await env.ENTITIES.put("mixstat:theo-parrish", JSON.stringify({
			slug: "theo-parrish", username: "Defectedrecords", last: "2026-09-11T12:23:23Z", checkedAt: 1,
		}));
		const l = (await buildListen(env as any, "theo-parrish"))!;
		expect(l.links[0].meta).toBe("last show 11 Sep 2026");
	});

	it("una segunda cuenta aprobada va detras de la principal, no se pierde", async () => {
		await external({ soundcloud: "musicandpower", secondary: { soundcloud: ["ron-trent-official"] } });
		const l = (await buildListen(env as any, "theo-parrish"))!;
		expect(l.links.map(x => x.url)).toEqual([
			"https://soundcloud.com/musicandpower",
			"https://soundcloud.com/ron-trent-official",
		]);
	});

	it("solo con sets, o solo con tour, tambien hay bloque", async () => {
		await handleSetsAdd(req("sets-add", { slug: "theo-parrish", url: MC }), env as any);
		const a = (await buildListen(env as any, "theo-parrish"))!;
		expect(a.sets).toHaveLength(1);
		expect(a.links).toHaveLength(0);
		await external({ ra: "dj/theoparrish" });
		const b = (await buildListen(env as any, "theo-parrish"))!;
		expect(b.tour).toHaveLength(1);
	});
});
