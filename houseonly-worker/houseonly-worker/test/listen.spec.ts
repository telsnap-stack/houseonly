import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zipSync } from "fflate";
import {
	runListenIngest, emailsCandidatos, eligeFicheros, urlFirmada, handleListenFile, handleListenList,
	ZIP_MAX_BYTES, dropboxDescarga,
} from "../src/lib/listen";

const E = env as any;
const SECRET = "listen-test-secret";
const NOW = new Date("2026-11-02T10:00:00Z");
const DROPBOX = "https://www.dropbox.com/scl/fo/abc/DEF?rlkey=k&st=s&dl=0";
const TRACKER = "https://us.list-manage.com/track/click?u=1&id=2";

// Anuncio de Rubadub minimo: marcador de pre-order y fecha ANTES de la ficha,
// portada justo antes, y el "Download Zip" detras (estructura real, sin datos reales).
const rdEmail = (cat: string, link = TRACKER) => `<html><body>
<p>Rubadub World Exclusive</p><p>Please Pre-Order</p><p>Shipping 24th December</p>
<img src="https://mcusercontent.com/x/images/${cat}.jpg">
<p>Artist: Test Artist<br>Title: Test EP<br>Label: Test Rec<br>Cat: ${cat}<br>Format: 12"<br>Price: £8.99</p>
<p>A1. Uno <a href="${link}">Download Zip</a></p></body></html>`;

const zipDe = (files: Record<string, number>) =>
	zipSync(Object.fromEntries(Object.entries(files).map(([n, size]) => [n, new Uint8Array(size).fill(7)])));

async function archiva(name: string, html: string, date = "2026-11-01", prefix = "RD") {
	const idx = JSON.parse((await E.EMAILS.get("idx")) || "[]");
	idx.push({ name, prefix, subject: name.split("__")[1], date, bytes: html.length });
	await E.EMAILS.put("idx", JSON.stringify(idx));
	await E.EMAILS.put(`msg:${name}`, html);
}

function redes(zip: Uint8Array, extra: Record<string, () => Response> = {}) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
		const url = String(input instanceof Request ? input.url : input);
		for (const [pref, res] of Object.entries(extra)) if (url.startsWith(pref)) return res();
		if (url.startsWith("https://us.list-manage.com/")) return new Response(null, { status: 302, headers: { location: DROPBOX } });
		if (url.startsWith("https://www.dropbox.com/")) return new Response(zip, { headers: { "content-type": "application/zip" } });
		if (url.startsWith("https://mcusercontent.com/")) return new Response(new Uint8Array(50), { headers: { "content-type": "image/jpeg" } });
		return new Response("nope", { status: 404 });
	});
}

const rel = async (clave: string) => JSON.parse((await E.SYNC_STATE.get(`listen:rel:${clave}`)) || "null");

beforeEach(async () => {
	for (const ns of [E.SYNC_STATE, E.EMAILS]) for (const k of (await ns.list()).keys) await ns.delete(k.name);
	for (const o of (await E.R2.list({ prefix: "listen/" })).objects) await E.R2.delete(o.key);
	E.BOOTSTRAP_AUTH_SECRET = SECRET;
	await E.SYNC_STATE.put("meta:listen_mode", "live");
});
afterEach(() => vi.restoreAllMocks());

describe("listen: qué emails y qué ficheros", () => {
	it("solo anuncios RD/TV recientes; fuera pedidos, digests, otros distribuidores y lo viejo", () => {
		const e = (prefix: string, subject: string, date = "2026-11-01") => ({ name: `${prefix}__${subject}__${date}.html`, prefix, subject, date });
		const idx = [
			e("RD", "Artist---Title-CAT001"), e("TV", "CAT002---T---A-20-11-2026", "2026-10-31"),
			e("RD", "Fwd-Artist---Title-CAT003"), e("RD", "All-Rubadub-Pre-sales-Week-26th"),
			e("DBH", "Out-soon-DBH001"), e("WS", "Wordandsound-Update"), e("MT", "Fwd-Mother-Tongue"),
			e("RD", "Old-CAT004", "2026-10-29"),
		];
		expect(emailsCandidatos(idx, NOW).map(x => x.subject)).toEqual(["CAT002---T---A-20-11-2026", "Artist---Title-CAT001"]);
	});

	it("MP3 en orden natural, sin __MACOSX ni ._; portada JPG con 'front' antes que la mayor; PNG fuera", () => {
		const r = eligeFicheros([
			{ name: "B1 - x.mp3", size: 1 }, { name: "A10 - x.mp3", size: 1 }, { name: "A2 - x.mp3", size: 1 },
			{ name: "__MACOSX/._A2 - x.mp3", size: 1 }, { name: "._A1.mp3", size: 1 },
			{ name: "Side A.png", size: 900 }, { name: "big.jpg", size: 800 }, { name: "CAT_front.jpeg", size: 100 },
		]);
		expect(r.mp3).toEqual(["A2 - x.mp3", "A10 - x.mp3", "B1 - x.mp3"]);
		expect(r.portada).toBe("CAT_front.jpeg");
		expect(eligeFicheros([{ name: "a.mp3", size: 1 }, { name: "label.png", size: 9 }]).portada).toBeNull();
	});

	it("Dropbox siempre con dl=1", () => {
		expect(dropboxDescarga(DROPBOX)).toBe("https://www.dropbox.com/scl/fo/abc/DEF?rlkey=k&st=s&dl=1");
		expect(dropboxDescarga("https://www.dropbox.com/scl/fo/a/b?rlkey=k")).toBe("https://www.dropbox.com/scl/fo/a/b?rlkey=k&dl=1");
	});
});

describe("listen: ingesta", () => {
	it("sigue el tracker, guarda solo MP3 y portada del ZIP, y no repite el catno", async () => {
		redes(zipDe({ "A1 - Uno.mp3": 300, "B1 - Dos.mp3": 200, "Side A.png": 100, "TST001_front.jpg": 50 }));
		await archiva("RD__Test-Artist---Test-EP-TST001__2026-11-01.html", rdEmail("TST001"));
		const r = await runListenIngest(E, { now: NOW });
		expect(r).toMatchObject({ nuevos: 1, por_estado: { listo: 1 }, emails_cerrados: 1, quedan: false });
		const d = await rel("TST001");
		expect(d).toMatchObject({ catno: "TST001", distribuidor: "RD", estado: "listo", release: "2026-12-24", cover: { key: "listen/TST001/cover.jpg", from: "zip" } });
		expect(d.tracks.map((t: any) => [t.name, t.key])).toEqual([
			["A1 - Uno", "listen/TST001/01-A1-Uno.mp3"], ["B1 - Dos", "listen/TST001/02-B1-Dos.mp3"],
		]);
		const keys = (await E.R2.list({ prefix: "listen/TST001/" })).objects.map((o: any) => o.key).sort();
		expect(keys).toEqual(["listen/TST001/01-A1-Uno.mp3", "listen/TST001/02-B1-Dos.mp3", "listen/TST001/cover.jpg"]);

		// Otro email (una revision) del mismo disco: no se baja otra vez.
		await archiva("RD__UPDATE-Test---TST-001__2026-11-02.html", rdEmail("TST-001"), "2026-11-02");
		expect(await runListenIngest(E, { now: NOW })).toMatchObject({ nuevos: 0, saltados: { duplicado: 1 } });
	});

	it("sin JPG en el ZIP, la portada del email; rechazados y no pre-order no se bajan", async () => {
		const f = redes(zipDe({ "a.mp3": 10, "Side A.png": 10 }));
		await E.SYNC_STATE.put("preorder:rejected:REJ001", JSON.stringify({ catno: "REJ001", tipo: "definitivo" }));
		await archiva("RD__X---Y-NOC001__2026-11-01.html", rdEmail("NOC001"));
		await archiva("RD__X---Y-REJ001__2026-11-01.html", rdEmail("REJ001"));
		await archiva("RD__X---Y-SHP001__2026-11-01.html", rdEmail("SHP001").replace("Please Pre-Order", "Shipping to you today"));
		const r = await runListenIngest(E, { now: NOW });
		expect(r).toMatchObject({ nuevos: 1, saltados: { rechazado: 1, no_preorder: 1 } });
		expect((await rel("NOC001")).cover).toEqual({ key: "listen/NOC001/cover.jpg", from: "email" });
		expect(f.mock.calls.filter(c => String(c[0]).includes("dropbox")).length).toBe(1);
	});

	it("ZIP por encima del tope: descarga manual con el enlace, sin nada en R2, y sigue con el resto", async () => {
		redes(zipDe({ "a.mp3": 10 }), {
			"https://us.list-manage.com/track/click?u=big": () => new Response(null, { status: 302, headers: { location: "https://www.dropbox.com/scl/fo/big/X?rlkey=k&dl=0" } }),
			"https://www.dropbox.com/scl/fo/big/": () => new Response("x", { headers: { "content-length": String(ZIP_MAX_BYTES + 1), "content-type": "application/zip" } }),
		});
		await archiva("RD__X---Y-BIG001__2026-11-01.html", rdEmail("BIG001", "https://us.list-manage.com/track/click?u=big"));
		await archiva("RD__X---Y-OKK001__2026-11-01.html", rdEmail("OKK001"));
		expect(await runListenIngest(E, { now: NOW })).toMatchObject({ nuevos: 2, por_estado: { descarga_manual: 1, listo: 1 } });
		expect(await rel("BIG001")).toMatchObject({ estado: "descarga_manual", zip_link: "https://www.dropbox.com/scl/fo/big/X?rlkey=k&dl=1", tracks: [] });
		expect((await E.R2.list({ prefix: "listen/BIG001/" })).objects).toHaveLength(0);
	});

	it("sin modo live no hace nada", async () => {
		await E.SYNC_STATE.delete("meta:listen_mode");
		const f = redes(zipDe({ "a.mp3": 10 }));
		await archiva("RD__X---Y-TST001__2026-11-01.html", rdEmail("TST001"));
		expect(await runListenIngest(E, { now: NOW })).toMatchObject({ mode: "off", nuevos: 0 });
		expect(f).not.toHaveBeenCalled();
	});
});

describe("listen: URLs firmadas", () => {
	const ORIGIN = "https://w.example";
	beforeEach(async () => { await E.R2.put("listen/TST001/01-a.mp3", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { httpMetadata: { contentType: "audio/mpeg" } }); });
	const pide = (url: string, headers: Record<string, string> = {}) => handleListenFile(new Request(url, { headers }), E);

	it("firmada vale, con Range da 206; firma mala, caducada o fuera de listen/ es 403", async () => {
		const url = await urlFirmada(E, ORIGIN, "listen/TST001/01-a.mp3");
		const ok = await pide(url);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toBe("audio/mpeg");
		expect(new Uint8Array(await ok.arrayBuffer())).toHaveLength(10);

		const parte = await pide(url, { range: "bytes=2-5" });
		expect(parte.status).toBe(206);
		expect(parte.headers.get("content-range")).toBe("bytes 2-5/10");
		expect([...new Uint8Array(await parte.arrayBuffer())]).toEqual([3, 4, 5, 6]);

		expect((await pide(url.replace(/sig=[0-9a-f]/, "sig=z"))).status).toBe(403);
		const vieja = await urlFirmada(E, ORIGIN, "listen/TST001/01-a.mp3", Date.now() - 2 * 3600_000);
		expect((await pide(vieja)).status).toBe(403);
		await E.R2.put("covers/x.jpg", new Uint8Array([1]));
		expect((await pide(await urlFirmada(E, ORIGIN, "covers/x.jpg"))).status).toBe(403);
	});

	it("listen-list exige Bearer y devuelve URLs firmadas que funcionan", async () => {
		await E.SYNC_STATE.put("listen:rel:TST001", JSON.stringify({
			clave: "TST001", catno: "TST001", distribuidor: "RD", artist: "A", title: "T", estado: "listo",
			tracks: [{ name: "a", key: "listen/TST001/01-a.mp3", bytes: 10 }], ingested_at: "2026-11-02T10:00:00Z",
		}));
		const req = new Request(`${ORIGIN}/?action=listen-list`);
		expect((await handleListenList(req, E, false)).status).toBe(401);
		const body: any = await (await handleListenList(req, E, true)).json();
		expect(body.count).toBe(1);
		expect(body.items[0].tracks[0].url).toMatch(/^https:\/\/w\.example\/\?action=listen-file&k=listen%2FTST001%2F01-a\.mp3&exp=\d+&sig=[0-9a-f]{64}$/);
		const audio = await pide(body.items[0].tracks[0].url);
		expect(audio.status).toBe(200);
		await audio.arrayBuffer();
	});
});
