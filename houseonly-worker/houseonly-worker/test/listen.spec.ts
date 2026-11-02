import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zipSync } from "fflate";
import {
	runListenIngest, emailsCandidatos, eligeFicheros, urlFirmada, handleListenFile, handleListenList,
	ZIP_MAX_BYTES, dropboxDescarga, handleListenDecide, limpiaBandeja, enlacesDePista, cuentaPistas, esElPromopack,
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
		// Libras del email y el cambio unico (RD_GBP_EUR) con que se paso a coste dealer.
		expect(d).toMatchObject({ gbp: 8.99, fx: 1.17, dealerPrice: 10.52 });
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

	// MYD015: sin "Download Zip", el Dropbox colgado del nombre de la primera pista.
	const sinBoton = (cat: string, link = "https://us.list-manage.com/track/click?u=pista") =>
		rdEmail(cat).replace(/<p>A1\. Uno <a[^>]*>Download Zip<\/a><\/p>/, `<p><a href="${link}">A1.&nbsp;Uno</a></p><p>A2. Dos</p><p>B1. Tres</p>`);

	it("enlaces y pistas del email; que cuenta como el promopack", () => {
		const h = sinBoton("PIS001");
		expect(enlacesDePista(h)).toEqual(["https://us.list-manage.com/track/click?u=pista"]);
		expect(cuentaPistas(h)).toBe(3);
		expect(esElPromopack("PIS001", "PIS001.zip", [], 0, 3)).toBe(true);
		expect(esElPromopack("PIS001", "", [{ name: "PIS001_front.jpg" }], 1, 3)).toBe(true);
		expect(esElPromopack("PIS001", "pack.zip", [], 3, 3)).toBe(true);
		expect(esElPromopack("PIS001", "pack.zip", [], 1, 3)).toBe(false);
	});

	it("sin Download Zip: el Dropbox de la pista si baja el promopack del disco", async () => {
		const pista = "https://www.dropbox.com/scl/fo/pista/X?rlkey=k&dl=0";
		redes(zipDe({}), {
			"https://us.list-manage.com/track/click?u=pista": () => new Response(null, { status: 302, headers: { location: pista } }),
			"https://www.dropbox.com/scl/fo/pista/": () => new Response(zipDe({ "A1 - Uno.mp3": 10, "A2 - Dos.mp3": 10, "B1 - Tres.mp3": 10 }),
				{ headers: { "content-type": "application/zip", "content-disposition": "attachment; filename=\"PIS001.zip\"" } }),
		});
		await archiva("RD__X---Y-PIS001__2026-11-01.html", sinBoton("PIS001"));
		expect(await runListenIngest(E, { now: NOW })).toMatchObject({ nuevos: 1, por_estado: { listo: 1 } });
		expect(await rel("PIS001")).toMatchObject({ estado: "listo", detalle: expect.stringContaining("enlace de la pista") });
		expect((await rel("PIS001")).tracks).toHaveLength(3);
	});

	it("sin Download Zip: si la pista baja otra cosa, o es un fichero suelto, descarga manual", async () => {
		redes(zipDe({}), {
			"https://us.list-manage.com/track/click?u=otra": () => new Response(null, { status: 302, headers: { location: "https://www.dropbox.com/scl/fo/otra/X?rlkey=k&dl=0" } }),
			"https://www.dropbox.com/scl/fo/otra/": () => new Response(zipDe({ "A1 - Uno.mp3": 10 }), { headers: { "content-type": "application/zip" } }),
			"https://us.list-manage.com/track/click?u=suelto": () => new Response(null, { status: 302, headers: { location: "https://www.dropbox.com/scl/fi/uno/A1.mp3?rlkey=k&dl=0" } }),
		});
		await archiva("RD__X---Y-OTR001__2026-11-01.html", sinBoton("OTR001", "https://us.list-manage.com/track/click?u=otra"));
		await archiva("RD__X---Y-SUE001__2026-11-01.html", sinBoton("SUE001", "https://us.list-manage.com/track/click?u=suelto"));
		expect(await runListenIngest(E, { now: NOW })).toMatchObject({ nuevos: 2, por_estado: { descarga_manual: 2 } });
		expect(await rel("OTR001")).toMatchObject({ estado: "descarga_manual", zip_link: "https://www.dropbox.com/scl/fo/otra/X?rlkey=k&dl=1", tracks: [] });
		expect(await rel("SUE001")).toMatchObject({ estado: "descarga_manual", zip_link: "https://www.dropbox.com/scl/fi/uno/A1.mp3?rlkey=k&dl=0" });
		expect((await E.R2.list({ prefix: "listen/OTR001/" })).objects).toHaveLength(0);
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
		expect(body).toMatchObject({ vista: "por_decidir", count: 1, cursor: null });
		expect(body.items[0].tracks[0].url).toMatch(/^https:\/\/w\.example\/\?action=listen-file&k=listen%2FTST001%2F01-a\.mp3&exp=\d+&sig=[0-9a-f]{64}$/);
		const audio = await pide(body.items[0].tracks[0].url);
		expect(audio.status).toBe(200);
		await audio.arrayBuffer();
	});
});

describe("listen: decisiones y limpieza", () => {
	const base = (clave: string, over: any = {}) => ({
		clave, catno: clave, distribuidor: "RD", artist: "A", title: "T", estado: "listo",
		tracks: [{ name: "a", key: `listen/${clave}/01-a.mp3`, bytes: 10 }], cover: { key: `listen/${clave}/cover.jpg`, from: "zip" },
		bytes: 15, ingested_at: "2026-11-01T10:00:00Z", ...over,
	});
	const pon = async (r: any) => {
		await E.R2.put(r.tracks[0].key, new Uint8Array(10));
		await E.R2.put(r.cover.key, new Uint8Array(5));
		await E.SYNC_STATE.put(`listen:rel:${r.clave}`, JSON.stringify(r),
			{ metadata: { c: r.catno, e: r.estado, n: r.tracks.length, at: r.ingested_at, x: r.decision, dt: r.decided_at } });
	};
	const decide = (body: any, ok = true) => handleListenDecide(new Request("https://w/?action=listen-decide", { method: "POST", body: JSON.stringify(body) }), E, ok, NOW.getTime());

	it("rechazar escribe el filtro del 20-10; deshacer lo borra; pre-order y pendiente solo marcan", async () => {
		await pon(base("DEC001"));
		expect((await decide({ clave: "DEC001", decision: "rechazado" }, false)).status).toBe(401);
		expect((await decide({ clave: "DEC001", decision: "rechazado", tipo: "quizas" })).status).toBe(400);
		expect((await decide({ clave: "NOPE01", decision: "pendiente" })).status).toBe(404);

		expect((await decide({ clave: "DEC001", decision: "rechazado", tipo: "temporal" })).status).toBe(200);
		expect(JSON.parse(await E.SYNC_STATE.get("preorder:rejected:DEC001"))).toMatchObject({ catno: "DEC001", tipo: "temporal", distribuidor: "rd" });
		expect(await rel("DEC001")).toMatchObject({ decision: "rechazado", rechazo: "temporal", decided_at: NOW.toISOString() });

		await decide({ clave: "DEC001", decision: null });
		expect(await E.SYNC_STATE.get("preorder:rejected:DEC001")).toBeNull();
		expect((await rel("DEC001")).decision).toBeUndefined();

		await decide({ clave: "DEC001", decision: "preorder" });
		expect((await rel("DEC001")).decision).toBe("preorder");
		expect(await E.SYNC_STATE.get("preorder:rejected:DEC001")).toBeNull();
	});

	it("rechazado de 7 dias fuera (KV y R2); pendiente o sin decidir de 30 dias pierde el audio; pre-order intacto", async () => {
		const hace = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();
		await pon(base("REJ007", { decision: "rechazado", decided_at: hace(7) }));
		await pon(base("REJ006", { decision: "rechazado", decided_at: hace(6) }));
		await pon(base("PEN030", { decision: "pendiente", decided_at: hace(1), ingested_at: hace(30) }));
		await pon(base("NON031", { ingested_at: hace(31) }));
		await pon(base("NON029", { ingested_at: hace(29) }));
		await pon(base("PRE040", { decision: "preorder", decided_at: hace(35), ingested_at: hace(40) }));
		expect(await limpiaBandeja(E, NOW)).toEqual({ rechazados: 1, sin_audio: 2, fuera: 0 });
		expect(await rel("REJ007")).toBeNull();
		expect((await E.R2.list({ prefix: "listen/REJ007/" })).objects).toHaveLength(0);
		expect((await rel("REJ006")).tracks).toHaveLength(1);
		for (const c of ["PEN030", "NON031"]) {
			expect(await rel(c)).toMatchObject({ tracks: [], bytes: 5, audio_limpiado_at: NOW.toISOString() });
			expect((await E.R2.list({ prefix: `listen/${c}/` })).objects.map((o: any) => o.key)).toEqual([`listen/${c}/cover.jpg`]);
		}
		expect((await rel("NON029")).tracks).toHaveLength(1);
		expect((await rel("PRE040")).tracks).toHaveLength(1);
		// Ya sin audio: la siguiente pasada no lo vuelve a tocar...
		expect(await limpiaBandeja(E, NOW)).toEqual({ rechazados: 0, sin_audio: 0, fuera: 0 });
		// ...hasta 30 dias despues de borrarle el audio: entonces sale de la bandeja.
		const luego = new Date(NOW.getTime() + 30 * 86400000);
		expect((await limpiaBandeja(E, luego)).fuera).toBe(2);
		for (const c of ["PEN030", "NON031"]) {
			expect(await rel(c)).toBeNull();
			expect((await E.R2.list({ prefix: `listen/${c}/` })).objects).toHaveLength(0);
		}
		expect(await rel("PRE040")).not.toBeNull();
	});

	it("con prefijo de staging no borra nada fuera de listen-staging/ aunque el registro lo apunte", async () => {
		const hace = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();
		await pon(base("PRD001", { decision: "rechazado", decided_at: hace(8) }));   // claves en listen/ (prod)
		E.LISTEN_R2_PREFIX = "listen-staging/";
		try {
			expect(await limpiaBandeja(E, NOW)).toEqual({ rechazados: 1, sin_audio: 0, fuera: 0 });
			expect((await E.R2.list({ prefix: "listen/PRD001/" })).objects).toHaveLength(2);
		} finally { delete E.LISTEN_R2_PREFIX; }
	});

	it("listen-list pagina por vista con cursor, da los recuentos y sirve claves sueltas", async () => {
		const hace = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();
		for (let i = 1; i <= 5; i++) await pon(base(`PAG00${i}`, { ingested_at: hace(i) }));
		await pon(base("ELE001", { decision: "preorder", decided_at: hace(1) }));
		await pon(base("PEN001", { decision: "pendiente", decided_at: hace(1) }));
		const pide = async (qs: string) => (await handleListenList(new Request(`https://w/?action=listen-list&${qs}`), E, true)).json() as any;

		const p1 = await pide("vista=por_decidir&limit=2");
		expect(p1.counts).toEqual({ por_decidir: 5, pendientes: 1, elegidos: 1, rechazados: 0 });
		expect(p1.items.map((x: any) => x.clave)).toEqual(["PAG001", "PAG002"]);
		expect(p1).toMatchObject({ count: 5, cursor: "2" });
		const p3 = await pide("vista=por_decidir&limit=2&cursor=4");
		expect(p3.items.map((x: any) => x.clave)).toEqual(["PAG005"]);
		expect(p3.cursor).toBeNull();

		expect((await pide("vista=elegidos")).items.map((x: any) => x.clave)).toEqual(["ELE001"]);
		expect((await pide("vista=pendientes")).items.map((x: any) => x.clave)).toEqual(["PEN001"]);
		expect((await handleListenList(new Request("https://w/?action=listen-list&vista=otra"), E, true)).status).toBe(400);

		const sueltas = await pide("claves=PAG003,ele-001,NOPE99");
		expect(sueltas.items.map((x: any) => x.clave).sort()).toEqual(["ELE001", "PAG003"]);
		expect(sueltas.items[0].tracks[0].url).toMatch(/sig=[0-9a-f]{64}$/);
	});
});
