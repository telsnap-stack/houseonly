import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
	parseLinkUrl,
	externalUrl,
	computeExternalBucket,
	filterAgainstRecord,
	applyApproval,
	getExternal,
	handleExternalReviewPut,
	handleExternalReviewList,
	handleExternalReviewApprove,
	handleExternalReviewApproveBulk,
	handleExternalReviewReject,
	type ExternalReview,
	type ExternalCandidate,
} from "../src/lib/external";

// Los datos salen de las consultas reales a MusicBrainz y Wikidata del
// 2026-09-17 (docs/entities.md, "Prueba a mano").

const SECRET = "test-secret";

function req(action: string, body?: any) {
	return new Request(`https://w/?action=${action}`, {
		method: body ? "POST" : "GET",
		headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function wipe() {
	for (const prefix of ["entity:", "external:", "extreview:"]) {
		const l = await env.ENTITIES.list({ prefix, limit: 1000 });
		for (const k of l.keys) await env.ENTITIES.delete(k.name);
	}
}

async function seedEntity(slug: string, display: string, roles: string[]) {
	await env.ENTITIES.put(`entity:${slug}`, JSON.stringify({
		slug, display, roles, aliases: [display], sources: [], status: "active", createdAt: 1, updatedAt: 1,
	}));
}

const lv = (url: string, from: Array<"mb" | "wikidata"> = ["mb"]) => {
	const p = parseLinkUrl(url)!;
	return { value: p.value, url, from };
};

// Omar S: llegado por Discogs 466085, que es el de un disco nuestro.
const omarCand = (): ExternalCandidate => ({
	mbid: "b8311533-0e4c-4f90-80a9-ac27d9fc6ac5", mbKind: "artist", name: "Omar-S", country: "US",
	why: "discogs-id", discogs: ["166506", "466085"], wikidata: "Q3351814",
	links: {
		songkick: [lv("https://www.songkick.com/artists/2437861", ["mb", "wikidata"])],
		ra: [lv("https://ra.co/dj/omars", ["wikidata"])],
	},
});

const omarRow = (): ExternalReview => ({
	slug: "omar-s", display: "Omar S", roles: ["artist"], total: 11, followed: false,
	candidates: [omarCand()],
	evidence: [{ kind: "artist", discogsId: "466085", name: "Omar-S", releaseId: 1, sku: "AOS891" }],
	bucket: "review", fetchedAt: 1,
});

// Pampa: por nombre salen dos sellos. El bueno es el aleman.
const pampaRow = (): ExternalReview => ({
	slug: "pampa", display: "Pampa", roles: ["label"], total: 8, followed: true,
	candidates: [
		{ mbid: "41e0694b-e7ab-4b6e-8f07-c342ef4dfb56", mbKind: "label", name: "Pampa Records", country: "DE",
			why: "name", discogs: ["169006"], links: { soundcloud: [lv("https://soundcloud.com/pamparecords")] } },
		{ mbid: "fa900d62-701b-42e1-97ca-823c4a36906d", mbKind: "label", name: "Pampa Records", disambiguation: "Argentina",
			why: "name", discogs: [], links: {} },
	],
	evidence: [], bucket: "review", fetchedAt: 1,
});

describe("parseLinkUrl", () => {
	it("reconoce las URLs reales de MusicBrainz y Wikidata", () => {
		expect(parseLinkUrl("https://ra.co/dj/djkoze")).toEqual({ field: "ra", value: "dj/djkoze" });
		expect(parseLinkUrl("https://www.residentadvisor.net/dj/OmarS")).toEqual({ field: "ra", value: "dj/omars" });
		expect(parseLinkUrl("https://ra.co/labels/1234")).toEqual({ field: "ra", value: "labels/1234" });
		expect(parseLinkUrl("https://www.songkick.com/artists/188726-theo-parrish")).toEqual({ field: "songkick", value: "188726" });
		expect(parseLinkUrl("https://soundcloud.com/pamparecords")).toEqual({ field: "soundcloud", value: "pamparecords" });
		expect(parseLinkUrl("https://www.mixcloud.com/NTSRadio/")).toEqual({ field: "mixcloud", value: "NTSRadio" });
		expect(parseLinkUrl("https://www.bandsintown.com/a/1150-dj-koze")).toEqual({ field: "bandsintown", value: "1150" });
		expect(parseLinkUrl("https://www.nts.live/artists/378-dj-koze")).toEqual({ field: "nts", value: "artists/378-dj-koze" });
	});

	it("un canal de YouTube escrito de dos maneras es UN valor", () => {
		const a = parseLinkUrl("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv");
		const b = parseLinkUrl("https://music.youtube.com/channel/UCabcdefghijklmnopqrstuv");
		expect(a).toEqual(b);
		expect(externalUrl("youtube", a!.value)).toBe("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv");
	});

	it("no confunde una pista suelta con una cuenta", () => {
		expect(parseLinkUrl("https://soundcloud.com/user-543006032/omar-s-241221")).toBeNull();
		expect(parseLinkUrl("https://www.discogs.com/artist/149")).toBeNull();
		expect(parseLinkUrl("https://www.nts.live/shows/omar-s/episodes/omar-s-24th-december-2021")).toBeNull();
	});
});

describe("computeExternalBucket", () => {
	it("Discogs ID + un candidato + sin conflictos -> confirmed", () => {
		expect(computeExternalBucket(omarRow())).toEqual({ bucket: "confirmed" });
	});

	it("solo por nombre -> review, aunque haya un unico candidato", () => {
		const r = pampaRow();
		r.candidates = [r.candidates[0]];
		expect(computeExternalBucket(r)).toEqual({ bucket: "review", bucketWhy: "no-discogs" });
	});

	it("dos candidatos -> review", () => {
		expect(computeExternalBucket(pampaRow()).bucketWhy).toBe("multi-mb");
	});

	it("un campo con dos valores -> review aunque venga por Discogs", () => {
		const r = omarRow();
		r.candidates[0].links.ra = [lv("https://ra.co/dj/omars"), lv("https://ra.co/dj/omar-s")];
		expect(computeExternalBucket(r)).toEqual({ bucket: "review", bucketWhy: "conflict" });
	});
});

describe("filterAgainstRecord y applyApproval", () => {
	it("elegir el Pampa aleman descarta el argentino y no vuelve a salir", () => {
		const row = pampaRow();
		const rec = applyApproval(null, row, row.candidates[0].mbid, { soundcloud: "pamparecords" }, "row", 5);
		expect(rec.mbid).toBe("41e0694b-e7ab-4b6e-8f07-c342ef4dfb56");
		expect(rec.soundcloud).toBe("pamparecords");
		expect(rec.rejected.mbid).toEqual(["fa900d62-701b-42e1-97ca-823c4a36906d"]);
		// El barrido de la semana que viene trae lo mismo: no queda nada que pedir.
		expect(filterAgainstRecord(pampaRow(), rec)).toBeNull();
	});

	it("un enlace no marcado se descarta; uno nuevo del mismo MBID vuelve a la cola", () => {
		const row = omarRow();
		const rec = applyApproval(null, row, row.candidates[0].mbid, { songkick: "2437861" }, "row", 5);
		expect(rec.ra).toBeUndefined();
		expect(rec.rejected.ra).toEqual(["dj/omars"]);

		const next = omarRow();
		next.candidates[0].links.mixcloud = [lv("https://www.mixcloud.com/omarsfxhe/")];
		const f = filterAgainstRecord(next, rec)!;
		expect(Object.keys(f.candidates[0].links)).toEqual(["mixcloud"]);
	});

	it("no deja aprobar un valor que la fila no ofrece", () => {
		const row = omarRow();
		expect(() => applyApproval(null, row, row.candidates[0].mbid, { ra: "dj/otro" }, "row", 5)).toThrow();
		expect(() => applyApproval(null, row, "no-es-candidato", {}, "row", 5)).toThrow();
	});
});

describe("handlers", () => {
	beforeEach(async () => {
		await wipe();
		(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
		await seedEntity("omar-s", "Omar S", ["artist"]);
		await seedEntity("pampa", "Pampa", ["label"]);
	});

	it("put recalcula el bucket en el servidor y list ordena seguidas primero", async () => {
		const res = await handleExternalReviewPut(req("external-review-put", { items: [
			{ ...omarRow(), bucket: "review" },
			{ ...pampaRow(), bucket: "confirmed" },   // mentira del cliente: se ignora
			{ ...omarRow(), slug: "no-existe" },
		] }), env as any);
		expect(await res.json()).toEqual({ written: 2, dropped: 0, skipped: 1 });

		const list: any = await (await handleExternalReviewList(req("external-review-list"), env as any)).json();
		expect(list.records.map((r: any) => [r.slug, r.bucket])).toEqual([["pampa", "review"], ["omar-s", "confirmed"]]);
		expect(list.counts).toEqual({ confirmed: 1, review: 1 });
	});

	it("bulk solo aprueba confirmed, y lo comprueba el servidor", async () => {
		await handleExternalReviewPut(req("external-review-put", { items: [omarRow(), pampaRow()] }), env as any);
		const d: any = await (await handleExternalReviewApproveBulk(
			req("external-review-approve-bulk", { slugs: ["omar-s", "pampa"] }), env as any)).json();
		expect(d.approved).toBe(1);
		expect(d.results.find((r: any) => r.slug === "pampa").error).toBe("not confirmed");

		const rec = await getExternal(env as any, "omar-s");
		expect(rec).toMatchObject({ mbid: "b8311533-0e4c-4f90-80a9-ac27d9fc6ac5", ra: "dj/omars", songkick: "2437861", wikidata: "Q3351814" });
		expect(rec!.approved.ra.via).toBe("bulk");
		expect(await env.ENTITIES.get("extreview:omar-s")).toBeNull();
	});

	it("approve fila a fila y reject", async () => {
		await handleExternalReviewPut(req("external-review-put", { items: [omarRow(), pampaRow()] }), env as any);

		const bad = await handleExternalReviewApprove(req("external-review-approve", { slug: "pampa", mbid: "x" }), env as any);
		expect(bad.status).toBe(400);

		const ok = await handleExternalReviewApprove(req("external-review-approve", {
			slug: "pampa", mbid: "41e0694b-e7ab-4b6e-8f07-c342ef4dfb56", fields: { soundcloud: "pamparecords" },
		}), env as any);
		expect(ok.status).toBe(200);

		await handleExternalReviewReject(req("external-review-reject", { slug: "omar-s" }), env as any);
		const rec = await getExternal(env as any, "omar-s");
		expect(rec!.mbid).toBeUndefined();
		expect(rec!.rejected.mbid).toEqual(["b8311533-0e4c-4f90-80a9-ac27d9fc6ac5"]);

		// Reenviar lo mismo no resucita nada.
		const again: any = await (await handleExternalReviewPut(req("external-review-put", { items: [omarRow(), pampaRow()] }), env as any)).json();
		expect(again).toEqual({ written: 0, dropped: 2, skipped: 0 });
	});

	it("put construye los enlaces a partir de las URLs que manda el barrido", async () => {
		const { links, ...sinLinks } = omarCand();
		await handleExternalReviewPut(req("external-review-put", { items: [{ ...omarRow(), candidates: [{
			...sinLinks,
			urls: [
				{ url: "https://www.songkick.com/artists/2437861", from: "mb" },
				{ url: "https://www.songkick.com/artists/2437861-omar-s", from: "wikidata" },
				{ url: "https://ra.co/dj/omars", from: "wikidata" },
				{ url: "https://open.spotify.com/artist/xyz", from: "mb" },
				{ url: "https://www.discogs.com/artist/466085", from: "mb" },
			],
		}] }] }), env as any);
		const row = JSON.parse((await env.ENTITIES.get("extreview:omar-s"))!);
		expect(row.candidates[0].links).toEqual({
			songkick: [{ value: "2437861", url: "https://www.songkick.com/artists/2437861", from: ["mb", "wikidata"] }],
			ra: [{ value: "dj/omars", url: "https://ra.co/dj/omars", from: ["wikidata"] }],
		});
		expect(row.bucket).toBe("confirmed");
	});

	it("sin Bearer, 401", async () => {
		const r = await handleExternalReviewList(new Request("https://w/?action=external-review-list"), env as any);
		expect(r.status).toBe(401);
	});
});
