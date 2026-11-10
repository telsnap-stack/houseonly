import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zipSync } from "fflate";
import {
	runListenIngest, emailsCandidatos, eligeFicheros, urlFirmada, handleListenFile, handleListenList,
	ZIP_MAX_BYTES, dropboxDescarga, handleListenDecide, limpiaBandeja, enlacesDePista, cuentaPistas, esElPromopack,
	handleListenPromote, handleListenUpload, completaPortadas, productoEnTienda, reparaSinZip, destinoDeTracker, porQueSinZip, mp3Suelto,
} from "../src/lib/listen";
import * as shopifyAdmin from "../src/lib/shopify-admin";
import { parseDbhEmail, parseSubwaxEmail, parseDistributorEmail } from "../src/lib/distributor-email.mjs";
import { SUBWAX_SEMANA45 } from "./fixtures/subwax";
import { RD_THEO_PARRISH, RD_SHORT_SPAN } from "./fixtures/rd-represses";

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

// Anuncio de Triple Vision minimo: portada _front, ficha con "Catalog:" y
// "Release date:", promopack por tracker (estructura real, sin datos reales).
const tvEmail = (cat: string, fecha: string) => `<html><body>
<img src="https://x.ams3.cdn.digitaloceanspaces.com/a/${cat}_front-U1.jpeg">
<p>Artist: Test Artist<br>Title: Test EP<br>Catalog: ${cat}<br>Label: TEST REC<br>Genre: House<br>Release date: ${fecha}<br>Format: Vinyl 12inch<br>Price: €9.5<br>
Promopack: <a href="${TRACKER}">Download</a></p><p>Tracklisting</p><p>A1 Uno</p></body></html>`;

// Ficha de DBH con la estructura real de su tienda (sin datos reales).
const dbhFicha = (id: number, cat: string, etiqueta = "Coming&nbsp;soon", genero = "Techno - Minimal") => `
<table style="width: 100%;margin-top:30px;margin-bottom:30px;"><tr><td style="max-width:50%;width: 50%;">
<img src="https://dbh-music.com/public/script/img.php?v=1&amp;imgsrc=${id}_uploaded.jpg&amp;timestamp=1&amp;id=${id}&amp;size=300x300" alt="${cat}" /></td>
<td><table><tr><td colspan="2"><span  style="text-transform: uppercase;background-color:#f0ad4e;display: inline;">${etiqueta}</span></td></tr>
<tr><td style="color:#999;" valign="top">Catalog</td><td style="color:#fff;padding-bottom:10px;" valign="top">${cat}&nbsp;</td></tr>
<tr><td style="color:#999;" valign="top">Title</td><td style="color:#fff;" valign="top">Test EP&nbsp;</td></tr>
<tr><td style="color:#999;" valign="top">Artist</td><td style="color:#fff;" valign="top">Test Artist&nbsp;</td></tr>
<tr><td style="color:#999;" valign="top">Label</td><td style="color:#fff;" valign="top">test rec&nbsp;</td></tr>
<tr><td style="color:#999;" valign="top">Release</td><td style="color:#fff;" valign="top">2026-12-07&nbsp;</td></tr>
<tr><td style="color:#999;" valign="top">Tracks</td><td style="color:#fff;" valign="top">2&nbsp;</td></tr>
<tr><td style="color:#999;" valign="top">Genres</td><td style="color:#fff;" valign="top">${genero}&nbsp;</td></tr>
<tr><td style="color:#999;" valign="top">Format</td><td style="color:#fff;" valign="top"><span style="background-color: #777;">12"</span></td></tr>
<tr><td colspan="2"><a href="https://dbh-music.com/shop/release_view/${id}"class="vk_retail">&#x1F6D2; 8.80 &euro;</a>
<a href="https://dbh-music.com/shop/release_zip/${id}" rel="nofollow">&darr; ZIP</a></td></tr></table></td></tr></table><hr>`;
const dbhEmail = (prosa: string, ...fichas: string[]) => `<html><head><style>.row {margin:0;}</style></head><body>
<p>Hello Eduardo,<br />${prosa}<br />Direct order: https://dbh-music.com/shop/release_view/1</p><div class="row">${fichas.join("")}</div></body></html>`;

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

// La tienda de Shopify que ve la ingesta (leeTienda): por defecto vacia, sin red.
const tiendaCon = (nodes: any[]) => vi.spyOn(shopifyAdmin, "shopifyAdminGraphQL").mockResolvedValue({
	data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
});
const producto = (handle: string, sku: string, status = "ACTIVE") => ({ handle, status, variants: { nodes: [{ sku }] } });

const rel = async (clave: string) => JSON.parse((await E.SYNC_STATE.get(`listen:rel:${clave}`)) || "null");

beforeEach(async () => {
	for (const ns of [E.SYNC_STATE, E.EMAILS]) for (const k of (await ns.list()).keys) await ns.delete(k.name);
	for (const o of (await E.LISTEN_R2.list({ prefix: "listen/" })).objects) await E.LISTEN_R2.delete(o.key);
	for (const o of (await E.R2.list()).objects) await E.R2.delete(o.key);
	E.BOOTSTRAP_AUTH_SECRET = SECRET;
	await E.SYNC_STATE.put("meta:listen_mode", "live");
	tiendaCon([]);
});
afterEach(() => vi.restoreAllMocks());

describe("parseDbhEmail", () => {
	it("una fila por ficha, con el genero tal cual, precio dealer en EUR y portada a 1000 px", () => {
		const rows = parseDbhEmail(dbhEmail("OUT SOON: DBH-777 - Test<br />Prosa del disco.", dbhFicha(777, "DBH-777"), dbhFicha(555, "OLD555", "Back in Stock", "House - Deep House")));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			catno: "DBH-777", artist: "Test Artist", title: "Test EP", label: "test rec", genre: "Techno - Minimal",
			release: "2026-12-07", dealerPrice: 8.8, format: '12"', source: "dbh", forthcoming: true,
			zipUrl: "https://dbh-music.com/shop/release_zip/777",
			coverUrl: "https://dbh-music.com/public/script/img.php?v=1&imgsrc=777_uploaded.jpg&timestamp=1&id=777&size=1000x1000",
		});
		expect(rows[0]._desc).toBe("OUT SOON: DBH-777 - Test\nProsa del disco.");
		// La prosa es del disco que nombra; la ficha de "Back in Stock" no la hereda.
		expect(rows[1]).toMatchObject({ catno: "OLD555", forthcoming: false, genre: "House - Deep House", _desc: "" });
	});
});

describe("parseDistributorEmail: Triple Vision", () => {
	it("Release date TBA es un pre-order sin fecha; con fecha manda si esta por delante (CNTRL01, KKYV11)", () => {
		const fila = (fecha: string) => parseDistributorEmail(tvEmail("TVT001", fecha), { emailDate: new Date(2026, 10, 6) })[0];
		for (const tba of ["TBA", "To be announced", "TBC"]) expect(fila(tba)).toMatchObject({ source: "tv", forthcoming: true, release: "", dealerPrice: 9.5 });
		expect(fila("08-01-2027")).toMatchObject({ forthcoming: true, release: "2027-01-08" });
		expect(fila("30-10-2026")).toMatchObject({ forthcoming: false, release: "2026-10-30" });
	});
});

describe("parseSubwaxEmail", () => {
	it("una fila por ficha: cabecera, linea de catalogo, euros con coma, portada de la ficha y Download files", () => {
		const rows = parseSubwaxEmail(SUBWAX_SEMANA45);
		expect(rows.map(r => r.catno)).toEqual(["ABOUNAIM002", "HEALER003", "MID-FLOW01", "SKKB032"]);
		expect(rows[0]).toMatchObject({
			artist: "Various", title: "Meet Some Friends EP", label: "Abou Naïm Records", format: '12" Vinyl',
			dealerPrice: 9.19, genre: "", release: "", source: "subwax", forthcoming: true,
			coverUrl: "https://mcusercontent.com/x/images/ficha1.jpeg", _zipLinks: ["https://us.list-manage.com/zip1?e=0"],
			_desc: "Texto de la ficha 1.",
		});
		// El titulo partido con <br> y el "&amp;"; la cabecera del correo no es portada de nadie.
		expect(rows[1]).toMatchObject({ artist: "Squash", title: "Big Motion (Incl. Sleeper & Baby Rollén Remixes)", coverUrl: "https://mcusercontent.com/x/images/ficha2.jpeg" });
		expect(rows[0]._gbp).toBeUndefined();
	});
});

describe("listen: qué emails y qué ficheros", () => {
	it("solo anuncios RD/TV/DBH recientes; fuera pedidos, digests, otros distribuidores y lo viejo", () => {
		const e = (prefix: string, subject: string, date = "2026-11-01") => ({ name: `${prefix}__${subject}__${date}.html`, prefix, subject, date });
		const idx = [
			e("RD", "Artist---Title-CAT001"), e("TV", "CAT002---T---A-20-11-2026", "2026-10-31"),
			e("RD", "Fwd-Artist---Title-CAT003"), e("RD", "All-Rubadub-Pre-sales-Week-26th"),
			e("DBH", "DBH-Music---Out-soon-DBH001"), e("DBH", "DBH-Music---Newsletter-KW45-2026"),
			e("WS", "Wordandsound-Update"), e("MT", "Fwd-Mother-Tongue"),
			e("RD", "Old-CAT004", "2026-10-29"), e("TV", "Newsletter-KW45-2026"),
			e("RD", "Older-CAT005", "2026-10-25"),
			e("RD", "New-Theo-Parrish-Sound-Signature-Represses", "2026-10-30"), e("RD", "Imports-Shipping-Today-X", "2026-10-30"),
		];
		// listen-run a mano: ventana mas larga y una sola fuente.
		expect(emailsCandidatos(idx, NOW, 10, "RD").map(x => x.subject)).toEqual(["Older-CAT005", "Old-CAT004", "New-Theo-Parrish-Sound-Signature-Represses", "Artist---Title-CAT001"]);
		// Las newsletters de DBH entran (traen fichas "Coming soon"); las demas no.
		// La ventana del cron es de 7 dias: CAT004 (hace 4) entra, CAT005 (hace 8) no.
		expect(emailsCandidatos(idx, NOW).map(x => x.subject)).toEqual(
			["Old-CAT004", "New-Theo-Parrish-Sound-Signature-Represses", "CAT002---T---A-20-11-2026", "DBH-Music---Newsletter-KW45-2026", "DBH-Music---Out-soon-DBH001", "Artist---Title-CAT001"]);
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
		// Subwax: _A (o _1_Front) es la frontal aunque la _B pese mas; "{CATNO} info.txt", con espacio.
		expect(eligeFicheros([{ name: "HEALER003_pack/HEALER003_B.jpeg", size: 900 }, { name: "HEALER003_pack/HEALER003_A.jpeg", size: 800 },
			{ name: "HEALER003_pack/HEALER003 info.txt", size: 9 }, { name: "HEALER003_pack/notas.txt", size: 9 }]))
			.toMatchObject({ portada: "HEALER003_pack/HEALER003_A.jpeg", promotext: "HEALER003_pack/HEALER003 info.txt" });
		expect(eligeFicheros([{ name: "X_2_Back.jpeg", size: 900 }, { name: "X_1_Front.jpeg", size: 100 }]).portada).toBe("X_1_Front.jpeg");
		// DBH: la trasera nunca, pese mas o vaya delante; su _info.txt es el texto.
		const dbh = eligeFicheros([{ name: "X1_cover_back.jpg", size: 900 }, { name: "X1_cover.jpg", size: 100 }, { name: "notas.txt", size: 5 }, { name: "X1_info.txt", size: 50 }]);
		expect(dbh).toMatchObject({ portada: "X1_cover.jpg", promotext: "X1_info.txt" });
		expect(eligeFicheros([{ name: "back.jpg", size: 900 }, { name: "x.jpg", size: 100 }]).portada).toBe("x.jpg");
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
		const keys = (await E.LISTEN_R2.list({ prefix: "listen/TST001/" })).objects.map((o: any) => o.key).sort();
		expect(keys).toEqual(["listen/TST001/01-A1-Uno.mp3", "listen/TST001/02-B1-Dos.mp3", "listen/TST001/cover.jpg"]);
		// Nada en el bucket publico (houseonly-audio, servido por r2.dev).
		expect((await E.R2.list()).objects.filter((o: any) => o.key.startsWith("listen"))).toHaveLength(0);

		// Otro email (una revision) del mismo disco: no se baja otra vez.
		await archiva("RD__UPDATE-Test---TST-001__2026-11-02.html", rdEmail("TST-001"), "2026-11-02");
		expect(await runListenIngest(E, { now: NOW })).toMatchObject({ nuevos: 0, saltados: { duplicado: 1 } });
	});

	it("guarda el _promotext.txt y el SALESPAPER.pdf si el ZIP los trae, y listen-list los firma", async () => {
		redes(zipDe({ "A1.mp3": 10, "TXT001_promotext.txt": 40, "SALESPAPER.pdf": 60, "otro.pdf": 5 }));
		await archiva("RD__X---Y-TXT001__2026-11-01.html", rdEmail("TXT001"));
		await runListenIngest(E, { now: NOW });
		const d = await rel("TXT001");
		expect(d.textos).toEqual({ promotext: "listen/TXT001/promotext.txt", salespaper: "listen/TXT001/salespaper.pdf" });
		expect((await E.LISTEN_R2.head("listen/TXT001/salespaper.pdf")).httpMetadata.contentType).toBe("application/pdf");
		const body: any = await (await handleListenList(new Request("https://w/?action=listen-list&claves=TXT001"), E, true)).json();
		expect(body.items[0].textos.promotext).toMatch(/k=listen%2FTXT001%2Fpromotext\.txt&exp=\d+&sig=/);
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

	it("TV con Release date TBA entra en la bandeja sin fecha; el que ya salio sigue fuera", async () => {
		redes(zipDe({ "TVT002_A1.mp3": 10, "TVT002_front.jpg": 20 }));
		await archiva("TV__TVT002---Test-EP---Test-Artist-TBA__2026-11-01.html", tvEmail("TVT002", "TBA"), "2026-11-01", "TV");
		await archiva("TV__TVT003---Test-EP---Test-Artist-30-10-2026__2026-11-01.html", tvEmail("TVT003", "30-10-2026"), "2026-11-01", "TV");
		const r = await runListenIngest(E, { now: NOW });
		expect(r).toMatchObject({ nuevos: 1, por_estado: { listo: 1 }, saltados: { no_preorder: 1 } });
		expect(await rel("TVT002")).toMatchObject({ distribuidor: "TV", release: "", dealerPrice: 9.5 });
		expect(await rel("TVT003")).toBeNull();
	});

	it("lo que ya esta en la tienda no entra (handle o SKU, con las reglas de Cargar elegidos); archivado si", async () => {
		const f = redes(zipDe({ "a.mp3": 10 }));
		tiendaCon([producto("mslp022ltd", "MSLP-022LTD"), producto("otra-cosa", "UR-025A"), producto("viejo", "OLD001", "ARCHIVED")]);
		await archiva("RD__X---Y-MSLP022LTD__2026-11-01.html", rdEmail("MSLP022LTD"));
		await archiva("RD__X---Y-UR025__2026-11-01.html", rdEmail("UR-025"));
		await archiva("RD__X---Y-OLD001__2026-11-01.html", rdEmail("OLD001"));
		const r = await runListenIngest(E, { now: NOW });
		expect(r).toMatchObject({ nuevos: 1, emails_cerrados: 3, saltados: { en_tienda: 2 } });
		expect(r.en_tienda).toEqual(["MSLP022LTD como mslp022ltd", "UR-025 como otra-cosa"]);
		expect(await rel("MSLP022LTD")).toBeNull();
		expect(await rel("OLD001")).toMatchObject({ estado: "listo" });
		expect(f.mock.calls.filter(c => String(c[0]).includes("dropbox")).length).toBe(1);
	});

	it("si no se puede leer la tienda no entra nada y el email queda abierto para la hora siguiente", async () => {
		redes(zipDe({ "a.mp3": 10 }));
		vi.spyOn(shopifyAdmin, "shopifyAdminGraphQL").mockRejectedValue(new Error("Shopify Admin API 503"));
		await archiva("RD__X---Y-TST009__2026-11-01.html", rdEmail("TST009"));
		const r = await runListenIngest(E, { now: NOW });
		expect(r).toMatchObject({ nuevos: 0, emails_cerrados: 0, quedan: true, tienda_error: "Shopify Admin API 503" });
		expect(await E.SYNC_STATE.get("listen:mail:RD__X---Y-TST009__2026-11-01.html")).toBeNull();
		tiendaCon([]);
		expect(await runListenIngest(E, { now: NOW })).toMatchObject({ nuevos: 1, emails_cerrados: 1 });
	});

	it("DBH: entran todas las fichas, el Back in Stock con preorder false; ZIP de release_zip, portada sin trasera, _info.txt como texto", async () => {
		const zip = zipDe({ "DBH777_info.txt": 40, "DBH777_cover_back.jpg": 900, "DBH777_cover.jpg": 100,
			"DBH777 - 1. Test Artist - A1. Uno.mp3": 30, "DBH777 - 2. Test Artist - B1. Dos.mp3": 20 });
		const zip555 = zipDe({ "OLD555 - 1. Test Artist - A1. Viejo.mp3": 30 });
		const f = redes(zip, {
			"https://dbh-music.com/shop/release_zip/777": () => new Response(zip, { headers: { "content-type": "application/x-zip" } }),
			"https://dbh-music.com/shop/release_zip/555": () => new Response(zip555, { headers: { "content-type": "application/x-zip" } }),
		});
		await archiva("DBH__DBH-Music---OUT-SOON-DBH777---Test__2026-11-01.html",
			dbhEmail("OUT SOON: DBH-777 - Test Artist - Test EP<br />Muy recomendado.", dbhFicha(777, "DBH-777"), dbhFicha(555, "OLD555", "Back in Stock")), "2026-11-01", "DBH");
		// La newsletter vuelve a traer el mismo disco: entra una sola vez.
		await archiva("DBH__DBH-Music---Newsletter-KW45-2026__2026-11-02.html", dbhEmail("here's our newest Newsletter", dbhFicha(777, "DBH777")), "2026-11-02", "DBH");
		const r = await runListenIngest(E, { now: NOW });
		expect(r).toMatchObject({ nuevos: 2, por_estado: { listo: 2 }, emails_cerrados: 2, saltados: { no_preorder: 0, duplicado: 1 } });
		const d = await rel("DBH777");
		expect(d).toMatchObject({ catno: "DBH-777", distribuidor: "DBH", dealerPrice: 8.8, release: "2026-12-07", preorder: true,
			cover: { key: "listen/DBH777/cover.jpg", from: "zip" }, textos: { promotext: "listen/DBH777/promotext.txt" } });
		expect(d.gbp).toBeUndefined();
		// Back in Stock: ya se envia, entra marcado como no pre-order.
		expect(await rel("OLD555")).toMatchObject({ catno: "OLD555", distribuidor: "DBH", preorder: false, estado: "listo" });
		expect((await E.LISTEN_R2.head("listen/DBH777/cover.jpg")).size).toBe(100);
		expect(f.mock.calls.filter(c => String(c[0]).includes("release_zip")).length).toBe(2);
		const body: any = await (await handleListenList(new Request("https://w/?action=listen-list&claves=DBH777"), E, true)).json();
		expect(body.items[0].tracks.map((t: any) => t.name)).toEqual(["Uno", "Dos"]);
	});

	it("RD: los represses (asunto de digest) se abren; fuera solo las listas masivas, y el resumen las nombra", async () => {
		redes(zipDe({ "A1.mp3": 30, "cover.jpg": 100 }));
		// Correos reales del archivo: 3 fichas de Short Span y 9 de Theo Parrish
		// (SS093/94 con barra; SS041 sin enlace al ZIP).
		await archiva("RD__Short-Span-Represses---Short11-Short8-Short15__2026-10-27.html", RD_SHORT_SPAN, "2026-10-27");
		await archiva("RD__New-Theo-Parrish-Sound-Signature-Represses__2026-10-30.html", RD_THEO_PARRISH, "2026-10-30");
		await archiva("RD__Imports-Shipping-Today-Synaptic-Voyager__2026-11-02.html", rdEmail("NOPE001"), "2026-11-02");
		await archiva("RD__Fwd-Artist---Title-CAT009__2026-11-01.html", rdEmail("NOPE002"));

		// 12 discos con tope de 6: Short Span entero y 3 de Theo; su correo sigue abierto.
		const r1 = await runListenIngest(E, { now: NOW });
		expect(r1).toMatchObject({ nuevos: 6, emails_cerrados: 1, quedan: true });
		expect(r1.descartados_asunto).toEqual([
			"RD__Fwd-Artist---Title-CAT009__2026-11-01.html (pedido)",
			"RD__Imports-Shipping-Today-Synaptic-Voyager__2026-11-02.html (lista masiva)",
		]);
		expect(await E.SYNC_STATE.get("listen:mail:RD__New-Theo-Parrish-Sound-Signature-Represses__2026-10-30.html")).toBeNull();

		// La pasada siguiente sigue donde lo dejo: las 6 que faltan, y lo cierra.
		const r2 = await runListenIngest(E, { now: NOW });
		expect(r2).toMatchObject({ nuevos: 6, emails_cerrados: 1, quedan: false, saltados: { duplicado: 3 } });
		for (const c of ["SHORT8", "SHORT11", "SHORT15", "SS023", "SS032", "COD1", "SS09394", "ELV001", "SS017", "SS041", "SS049", "SS104105"])
			expect(await rel(c), c).not.toBeNull();
		expect(await rel("SS09394")).toMatchObject({ catno: "SS093/94", artist: "Theo Parrish", release: "2026-11-15", estado: "listo" });
		// SS041 no tiene "Download Zip": su Dropbox cuelga de la tracklist.
		expect(await rel("SS041")).toMatchObject({ estado: "listo", detalle: "promopack de otro enlace de la ficha (sin botón Download Zip)" });
		expect(await rel("NOPE001")).toBeNull();
		expect(await rel("NOPE002")).toBeNull();
	});

	// En el correo de Theo Parrish, 4 de los enlaces cortos de Mailchimp llevan a
	// OTRO tracker (rubadub.us1.../track/click) y ese al Dropbox.
	const DOS_SALTOS = ["enlace02", "enlace04", "enlace08", "enlace99"];   // SS032, ELV001, SS104/105, SS093/94
	function redesTheo(zip: Uint8Array, clickRoto = false) {
		return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
			const url = String(input instanceof Request ? input.url : input);
			const salto = (to: string) => new Response(null, { status: 302, headers: { location: to } });
			// enlace09 es "see our current stocklist", al pie de la ultima ficha.
			if (url.startsWith("https://us.list-manage.com/enlace09?")) return salto("https://www.rubadub.co.uk/stocklist");
			if (url.startsWith("https://us.list-manage.com/"))
				return salto(DOS_SALTOS.some(c => url.includes(`/${c}?`)) ? "https://rubadub.us1.list-manage.com/track/click?u=1&amp;id=9" : DROPBOX);
			if (url.startsWith("https://rubadub.us1.list-manage.com/track/click")) return clickRoto ? new Response("x", { status: 500 }) : salto(DROPBOX);
			if (url.startsWith("https://www.dropbox.com/")) return new Response(zip, { headers: { "content-type": "application/zip" } });
			if (url.startsWith("https://mcusercontent.com/")) return new Response(new Uint8Array(50), { headers: { "content-type": "image/jpeg" } });
			return new Response("nope", { status: 404 });
		});
	}

	it("RD: sigue los dos saltos de Mailchimp hasta el Dropbox; un tracker que no acaba no cuenta", async () => {
		redesTheo(zipDe({ "A1.mp3": 30, "cover.jpg": 100 }));
		await archiva("RD__New-Theo-Parrish-Sound-Signature-Represses__2026-10-30.html", RD_THEO_PARRISH, "2026-10-30");
		await runListenIngest(E, { now: NOW });
		await runListenIngest(E, { now: NOW });
		for (const c of ["SS023", "SS032", "COD1", "SS09394", "ELV001", "SS017", "SS041", "SS049", "SS104105"])
			expect((await rel(c)).estado, c).toBe("listo");
		vi.restoreAllMocks();
		// Un tracker que lleva a otro tracker sin fin: '' (no se sigue mas de SALTOS_TRACKER).
		const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://us.list-manage.com/otro" } }));
		expect(await destinoDeTracker("https://us.list-manage.com/uno")).toBe("");
		expect(f).toHaveBeenCalledTimes(3);
		// Lo que no es un tracker ni se pide.
		expect(await destinoDeTracker("https://example.com/x")).toBe("https://example.com/x");
		expect(f).toHaveBeenCalledTimes(3);
	});

	it("listen-repair: reintenta los sin_zip de correos con Mailchimp, conserva la decision y no repite", async () => {
		// Como entraron antes del arreglo: el segundo salto no llevaba a ningun sitio.
		redesTheo(zipDe({ "A1.mp3": 30, "cover.jpg": 100 }), true);
		await archiva("RD__New-Theo-Parrish-Sound-Signature-Represses__2026-10-30.html", RD_THEO_PARRISH, "2026-10-30");
		await archiva("RD__Sin-tracker---Test-EP-NOTR001__2026-11-01.html", rdEmail("NOTR001", "https://example.com/no-zip"));
		// Mientras el correo sigue abierto, sus sin_zip se reintentan y gastan tope: tres pasadas.
		for (let i = 0; i < 3; i++) await runListenIngest(E, { now: NOW });
		expect((await rel("SS032")).estado).toBe("sin_zip");
		expect((await rel("NOTR001")).estado).toBe("sin_zip");
		await handleListenDecide(new Request("https://w/", { method: "POST", body: JSON.stringify({ clave: "SS032", decision: "pendiente" }) }), E, true, NOW.getTime());
		vi.restoreAllMocks();
		redesTheo(zipDe({ "A1.mp3": 30, "cover.jpg": 100 }));

		// 4 sin_zip de dos saltos en un correo con Mailchimp, y NOTR001, cuyo correo no lleva tracker.
		expect((await rel("NOTR001")).detalle).toBe("sin promopack: ningún enlace de la ficha lleva a uno");
		const r1 = await reparaSinZip(E, NOW);
		expect(r1).toMatchObject({ intentados: 4, por_estado: { listo: 4 }, siguen_sin_zip: [], sin_tracker: 1, quedan: false });
		// La tanda siguiente empieza despues de la ultima clave mirada (la lista de KV
		// tarda en ver la marca): con el cursor no repite aunque la lista vaya atrasada.
		expect(r1.siguiente).toMatch(/^listen:rel:/);
		expect(await reparaSinZip(E, NOW, "listen:rel:ZZZ")).toMatchObject({ intentados: 0, sin_tracker: 0 });
		const d = await rel("SS032");
		expect(d).toMatchObject({ estado: "listo", decision: "pendiente", ingested_at: NOW.toISOString() });
		expect(d.tracks.length).toBe(1);
		expect(d).toMatchObject({ reparado_v: 5 });
		expect((await rel("NOTR001")).estado).toBe("sin_zip");
		// Cada disco una vez.
		expect(await reparaSinZip(E, NOW)).toMatchObject({ intentados: 0, sin_tracker: 0 });
	});

	it("Subwax: los 4 discos de la semana 45, ZIP de subwax.es tras el tracker, euros sin FX, portada _A e info.txt", async () => {
		const zipDeCat = (c: string) => zipDe({ [`${c}_pack/${c}_A.jpeg`]: 100, [`${c}_pack/${c}_B.jpeg`]: 900, [`${c}_pack/${c} info.txt`]: 40,
			[`${c}_pack/${c} A1 Uno (snippet).mp3`]: 30, [`${c}_pack/${c} B1 Dos (snippet).mp3`]: 20, [`__MACOSX/${c}_pack/._${c}_A.jpeg`]: 5 });
		const cats = ["ABOUNAIM002", "HEALER003", "MID-FLOW01", "SKKB032"];
		const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
			const url = String(input instanceof Request ? input.url : input);
			const zipN = url.match(/^https:\/\/us\.list-manage\.com\/zip(\d)/);
			if (zipN) return new Response(null, { status: 302, headers: { location: `https://subwax.es/wp-content/uploads/2026/11/${cats[+zipN[1] - 1]}_pack.zip` } });
			const pack = url.match(/^https:\/\/subwax\.es\/wp-content\/uploads\/2026\/11\/(.+)_pack\.zip$/);
			if (pack) return new Response(zipDeCat(pack[1]), { headers: { "content-type": "application/zip" } });
			return new Response("nope", { status: 404 });
		});
		await archiva("SUBWAX__New-pre-orders---week-452026__2026-11-01.html", SUBWAX_SEMANA45, "2026-11-01", "SUBWAX");
		const r = await runListenIngest(E, { now: NOW, fuente: "SUBWAX" });
		expect(r).toMatchObject({ nuevos: 4, por_estado: { listo: 4 }, emails_cerrados: 1, quedan: false });
		const d = await rel("MIDFLOW01");
		expect(d).toMatchObject({ catno: "MID-FLOW01", distribuidor: "SUBWAX", artist: "Unknown Artist", label: "Mid-Flow Records",
			dealerPrice: 9.39, release: "", cover: { key: "listen/MIDFLOW01/cover.jpg", from: "zip" },
			textos: { promotext: "listen/MIDFLOW01/promotext.txt" }, resumen: "Texto de la ficha 3." });
		expect(d.gbp).toBeUndefined();
		const body: any = await (await handleListenList(new Request("https://w/?action=listen-list&claves=MIDFLOW01"), E, true)).json();
		expect(body.items[0].tracks.map((t: any) => t.name)).toEqual(["Uno", "Dos"]);   // sin catno, cara ni "(snippet)"
		expect((await E.LISTEN_R2.head("listen/MIDFLOW01/cover.jpg")).size).toBe(100);   // la _A, no la _B
		// "Audio clips" (SoundCloud) ni se pide.
		expect(f.mock.calls.some(c => String(c[0]).includes("clips"))).toBe(false);
	});

	it("listen-repair por tandas: 6 por llamada y el cursor sigue donde lo dejo", async () => {
		// 8 discos sin_zip, cada uno en su correo con un tracker roto.
		redes(zipDe({ "A1.mp3": 30 }), { "https://us.list-manage.com/": () => new Response("x", { status: 500 }) });
		for (let i = 1; i <= 8; i++) await archiva(`RD__T---EP-TAN00${i}__2026-11-01.html`, rdEmail(`TAN00${i}`));
		for (let i = 0; i < 3; i++) await runListenIngest(E, { now: NOW });
		vi.restoreAllMocks();
		redes(zipDe({ "A1.mp3": 30 }));
		const a = await reparaSinZip(E, NOW);
		expect(a).toMatchObject({ intentados: 6, quedan: true, siguiente: "listen:rel:TAN006" });
		const b = await reparaSinZip(E, NOW, a.siguiente);
		expect(b).toMatchObject({ intentados: 2, quedan: false });
		for (let i = 1; i <= 8; i++) expect((await rel(`TAN00${i}`)).estado).toBe("listo");
	});

	it("Dropbox caducado: 'caducado' con el enlace, no un error generico; y por que no hay promopack", async () => {
		redes(zipDe({ "A1.mp3": 30 }), { "https://www.dropbox.com/": () => new Response("<html>expired</html>", { headers: { "content-type": "text/html" } }) });
		await archiva("RD__Caducado---EP-CAD001__2026-11-01.html", rdEmail("CAD001"));
		await runListenIngest(E, { now: NOW });
		expect(await rel("CAD001")).toMatchObject({ estado: "caducado", detalle: "el Dropbox del promopack ha caducado: pide el promo" });
		vi.restoreAllMocks();
		tiendaCon([]);
		redes(zipDe({ "A1.mp3": 30 }), { "https://www.dropbox.com/": () => new Response("gone", { status: 410 }) });
		await archiva("RD__Caducado---EP-CAD002__2026-11-01.html", rdEmail("CAD002"));
		await runListenIngest(E, { now: NOW });
		expect((await rel("CAD002")).estado).toBe("caducado");

		expect(porQueSinZip([])).toBe("sin promopack: la ficha no trae ningún enlace");
		expect(porQueSinZip(["http://www.groovedis.com/singles/mo26-a1.mp3", "http://www.groovedis.com/singles/mo26-a2.mp3"]))
			.toBe("sin promopack: MP3 sueltos por pista (groovedis.com)");
		// MO26: un enlace mal escrito no deja un dominio vacio en la lista.
		expect(porQueSinZip(["http://www.groovedis.com/singles/mo26-a1.mp3", "http://%20http://www.groovedis.com/singles/mo26-b1.mp3"]))
			.toBe("sin promopack: MP3 sueltos por pista (groovedis.com)");
		expect(porQueSinZip(["http://%20/x.mp3"])).toBe("sin promopack: MP3 sueltos por pista");
		expect(porQueSinZip(["https://www.youtube.com/watch?v=x"])).toBe("sin promopack: solo enlaces de escucha (YouTube, SoundCloud…)");
		expect(porQueSinZip(["https://www.rubadub.co.uk/stocklist"])).toBe("sin promopack: ningún enlace de la ficha lleva a uno");
	});

	// Un 7" de Fett Distro (RDUB702): sin promopack, cada cara enlazada a su MP3.
	const fettEmail = (cat: string, host: string) => `<html><body><p>Please Pre-Order</p><p>Shipping 24th December</p>
<img src="https://mcusercontent.com/x/images/${cat}.jpg">
<p>Artist: Uno / Dos<br>Title: Split<br>Label: Rubadub<br>Cat: ${cat}<br>Format: 7"<br>Price: £4.59</p>
<p><a href="https://us.list-manage.com/${cat}a?e=0">A. Uno - Dose (Sax Mix)</a></p>
<p><a href="https://us.list-manage.com/${cat}b?e=0">B. Dos - Fuji (Dub)</a></p>
<p>Texto del disco.</p><p><a href="https://us.list-manage.com/stock?e=0">Click here to see our current stocklist</a></p></body></html>`;
	function redesFett(host: string) {
		return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
			const url = String(input instanceof Request ? input.url : input);
			const cara = url.match(/^https:\/\/us\.list-manage\.com\/([A-Z0-9]+)([ab])\?/);
			// Como en el correo real: Mailchimp pega su query al destino (RDUB702 no casaba por eso).
			const ruta = host.includes("groovedis") ? "singles" : "audio";
			if (cara) return new Response(null, { status: 302, headers: { location: `http://${host}/${ruta}/${cara[1].toLowerCase()}${cara[2]}.mp3?utm_source=Blackhole+Subscribers&mc_eid=x` } });
			// (groovedis.com pasa de http a https; el fetch real sigue el 301, el simulado no hace falta.)
			if (url.startsWith("https://us.list-manage.com/stock")) return new Response(null, { status: 302, headers: { location: "https://www.rubadub.co.uk/stocklist" } });
			if (/^https?:\/\/[^/]+\/(audio|singles)\/[a-z0-9]+\.mp3$/.test(url)) return new Response(new Uint8Array(40), { headers: { "content-type": "audio/mpeg" } });
			if (url.startsWith("https://mcusercontent.com/")) return new Response(new Uint8Array(50), { headers: { "content-type": "image/jpeg" } });
			return new Response("nope", { status: 404 });
		});
	}

	it("MP3 sueltos por pista de fett-distro.com y groovedis.com: entran como pistas, sin el query de Mailchimp", async () => {
		const f = redesFett("fett-distro.com");
		await archiva("RD__Uno-Dos---Split-RDUB-702__2026-11-01.html", fettEmail("RDUB702", "fett-distro.com"));
		await runListenIngest(E, { now: NOW });
		const d = await rel("RDUB702");
		expect(d).toMatchObject({ estado: "listo", detalle: "sin promopack: MP3 sueltos por pista de fett-distro.com",
			cover: { key: "listen/RDUB702/cover.jpg", from: "email" } });
		expect(d.tracks.map((t: any) => [t.name, t.key])).toEqual([
			["A. Uno - Dose (Sax Mix)", "listen/RDUB702/01-A.-Uno-Dose-Sax-Mix.mp3"], ["B. Dos - Fuji (Dub)", "listen/RDUB702/02-B.-Dos-Fuji-Dub.mp3"]]);
		expect((await E.LISTEN_R2.head("listen/RDUB702/01-A.-Uno-Dose-Sax-Mix.mp3")).size).toBe(40);
		expect(f.mock.calls.some(c => String(c[0]).includes("rubadub.co.uk"))).toBe(false);   // el destino de la stocklist ni se pide
		// Se piden sin el query de Mailchimp.
		expect(f.mock.calls.map(c => String(c[0])).filter(u => u.includes("fett-distro"))).toEqual(
			["http://fett-distro.com/audio/rdub702a.mp3", "http://fett-distro.com/audio/rdub702b.mp3"]);
		vi.restoreAllMocks();
		tiendaCon([]);
		redesFett("www.groovedis.com");
		await archiva("RD__Uno-Dos---Split-MATH021__2026-11-01.html", fettEmail("MATH021", "www.groovedis.com"));
		await runListenIngest(E, { now: NOW });
		const g = await rel("MATH021");
		expect(g).toMatchObject({ estado: "listo", detalle: "sin promopack: MP3 sueltos por pista de groovedis.com" });
		expect(g.tracks.map((t: any) => t.name)).toEqual(["A. Uno - Dose (Sax Mix)", "B. Dos - Fuji (Dub)"]);
		// Otro host con MP3 sueltos sigue sin entrar, con su motivo.
		vi.restoreAllMocks();
		tiendaCon([]);
		redesFett("audio.example.com");
		await archiva("RD__Uno-Dos---Split-OTRO001__2026-11-01.html", fettEmail("OTRO001", "audio.example.com"));
		await runListenIngest(E, { now: NOW });
		expect(await rel("OTRO001")).toMatchObject({ estado: "sin_zip", detalle: "sin promopack: MP3 sueltos por pista (audio.example.com)" });
		// MO26: el enlace mal escrito se recupera.
		expect(mp3Suelto("http://%20http://www.groovedis.com/singles/mo26-b1.mp3?utm_source=x")).toBe("http://www.groovedis.com/singles/mo26-b1.mp3");
		expect(mp3Suelto("https://www.groovedis.com/otra/cosa.mp3")).toBe("");
	});

	it("los enlaces de baja o perfil de Mailchimp nunca se piden", async () => {
		const f = vi.spyOn(globalThis, "fetch");
		expect(await destinoDeTracker("https://rubadub.us1.list-manage.com/unsubscribe?u=1&id=2")).toBe("");
		expect(await destinoDeTracker("https://rubadub.us1.list-manage.com/profile?u=1&id=2")).toBe("");
		expect(f).not.toHaveBeenCalled();
		const html = rdEmail("SUB001") + '<a href="https://rubadub.us1.list-manage.com/unsubscribe?u=1&amp;id=2">unsubscribe</a>';
		expect(parseDistributorEmail(html, { fx: 1.15, emailDate: new Date(2026, 10, 1) })[0]._enlacesFicha.some((u: string) => /unsubscribe/.test(u))).toBe(false);
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
		// Ningun MP3; solo la portada del correo, para verlo en la bandeja.
		expect((await E.LISTEN_R2.list({ prefix: "listen/BIG001/" })).objects.map((o: any) => o.key)).toEqual(["listen/BIG001/cover.jpg"]);
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
		expect((await E.LISTEN_R2.list({ prefix: "listen/OTR001/" })).objects.map((o: any) => o.key)).toEqual(["listen/OTR001/cover.jpg"]);
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
	beforeEach(async () => { await E.LISTEN_R2.put("listen/TST001/01-a.mp3", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { httpMetadata: { contentType: "audio/mpeg" } }); });
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
		await E.LISTEN_R2.put("covers/x.jpg", new Uint8Array([1]));
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
		await E.LISTEN_R2.put(r.tracks[0].key, new Uint8Array(10));
		await E.LISTEN_R2.put(r.cover.key, new Uint8Array(5));
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
		expect(await limpiaBandeja(E, NOW)).toEqual({ rechazados: 1, sin_audio: 2, fuera: 0, cargados: 0 });
		expect(await rel("REJ007")).toBeNull();
		expect((await E.LISTEN_R2.list({ prefix: "listen/REJ007/" })).objects).toHaveLength(0);
		expect((await rel("REJ006")).tracks).toHaveLength(1);
		for (const c of ["PEN030", "NON031"]) {
			expect(await rel(c)).toMatchObject({ tracks: [], bytes: 5, audio_limpiado_at: NOW.toISOString() });
			expect((await E.LISTEN_R2.list({ prefix: `listen/${c}/` })).objects.map((o: any) => o.key)).toEqual([`listen/${c}/cover.jpg`]);
		}
		expect((await rel("NON029")).tracks).toHaveLength(1);
		expect((await rel("PRE040")).tracks).toHaveLength(1);
		// Ya sin audio: la siguiente pasada no lo vuelve a tocar...
		expect(await limpiaBandeja(E, NOW)).toEqual({ rechazados: 0, sin_audio: 0, fuera: 0, cargados: 0 });
		// ...hasta 30 dias despues de borrarle el audio: entonces sale de la bandeja.
		const luego = new Date(NOW.getTime() + 30 * 86400000);
		expect((await limpiaBandeja(E, luego)).fuera).toBe(2);
		for (const c of ["PEN030", "NON031"]) {
			expect(await rel(c)).toBeNull();
			expect((await E.LISTEN_R2.list({ prefix: `listen/${c}/` })).objects).toHaveLength(0);
		}
		expect(await rel("PRE040")).not.toBeNull();
	});

	it("con prefijo de staging no borra nada fuera de listen-staging/ aunque el registro lo apunte", async () => {
		const hace = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();
		await pon(base("PRD001", { decision: "rechazado", decided_at: hace(8) }));   // claves en listen/ (prod)
		E.LISTEN_R2_PREFIX = "listen-staging/";
		try {
			expect(await limpiaBandeja(E, NOW)).toEqual({ rechazados: 1, sin_audio: 0, fuera: 0, cargados: 0 });
			expect((await E.LISTEN_R2.list({ prefix: "listen/PRD001/" })).objects).toHaveLength(2);
		} finally { delete E.LISTEN_R2_PREFIX; }
	});

	it("listen-list pagina por vista con cursor, da los recuentos y sirve claves sueltas", async () => {
		const hace = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();
		for (let i = 1; i <= 5; i++) await pon(base(`PAG00${i}`, { ingested_at: hace(i) }));
		await pon(base("ELE001", { decision: "preorder", decided_at: hace(1) }));
		await pon(base("PEN001", { decision: "pendiente", decided_at: hace(1) }));
		const pide = async (qs: string) => (await handleListenList(new Request(`https://w/?action=listen-list&${qs}`), E, true)).json() as any;

		const p1 = await pide("vista=por_decidir&limit=2");
		expect(p1.counts).toEqual({ por_decidir: 5, pendientes: 1, elegidos: 1, rechazados: 0, cargados: 0 });
		expect(p1.items.map((x: any) => x.clave)).toEqual(["PAG001", "PAG002"]);
		expect(p1).toMatchObject({ count: 5, cursor: "2" });
		expect(p1.promote).toEqual({ activo: false, audio: "audio/", covers: "covers/", pruebas: false });
		expect(p1.modo).toBe("live");                                    // el interruptor de ahora
		await E.SYNC_STATE.put("meta:listen_mode", "off");
		expect((await pide("vista=por_decidir")).modo).toBe("off");
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

	it("listen-promote: apagado no hace nada; encendido COPIA a los prefijos del entorno, marca cargado y no repite", async () => {
		await pon(base("PRO001", { decision: "preorder", decided_at: NOW.toISOString() }));
		await pon(base("PEN009", { decision: "pendiente", decided_at: NOW.toISOString() }));
		const promo = (body: any, ok = true) => handleListenPromote(new Request("https://w/?action=listen-promote", { method: "POST", body: JSON.stringify(body) }), E, ok, "https://pub.example", NOW.getTime());
		const cuerpo = { clave: "PRO001", safeKey: "PRO001", handle: "pro001" };

		expect((await promo(cuerpo, false)).status).toBe(401);
		expect((await promo(cuerpo)).status).toBe(403);                       // meta:listen_promote sin poner
		await E.SYNC_STATE.put("meta:listen_promote", "on");
		E.LISTEN_PROMOTE_AUDIO_PREFIX = "staging-audio/";
		E.LISTEN_PROMOTE_COVERS_PREFIX = "staging-covers/";
		try {
			expect((await promo({ ...cuerpo, safeKey: "../x" })).status).toBe(400);
			expect((await promo({ clave: "PEN009", safeKey: "PEN009" })).status).toBe(409);   // no elegido
			const r: any = await (await promo(cuerpo)).json();
			expect(r).toMatchObject({ ok: true, coverUrl: "https://pub.example/staging-covers/PRO001.jpg", cover_from: "zip" });
			expect(r.tracks).toEqual([{ name: "a", url: "https://pub.example/staging-audio/PRO001/a.mp3" }]);
			// Copiado al bucket publico con los mismos bytes y tipo; el original sigue en la bandeja.
			const copiado = await E.R2.get("staging-audio/PRO001/a.mp3");
			expect(copiado.size).toBe(10);
			await copiado.arrayBuffer();
			expect((await E.R2.list({ prefix: "audio/" })).objects).toHaveLength(0);
			expect((await E.R2.list({ prefix: "covers/" })).objects).toHaveLength(0);
			expect((await E.LISTEN_R2.list({ prefix: "listen/PRO001/" })).objects).toHaveLength(2);
			expect(await rel("PRO001")).toMatchObject({ decision: "cargado", cargado_at: NOW.toISOString(), handle: "pro001",
				promovidos: ["staging-audio/PRO001/a.mp3", "staging-covers/PRO001.jpg"] });
			// Un Process repetido: mismas URLs, sin copiar otra vez ni cambiar la fecha.
			await E.R2.delete("staging-audio/PRO001/a.mp3");
			const otra: any = await (await promo(cuerpo, true)).json();
			expect(otra).toMatchObject({ ya_cargado: true, tracks: r.tracks, coverUrl: r.coverUrl, cargado_at: NOW.toISOString() });
			expect(await E.R2.head("staging-audio/PRO001/a.mp3")).toBeNull();
			await E.R2.put("staging-audio/PRO001/a.mp3", new Uint8Array(10));

			// Vista Cargados y deshacer: vuelve a Elegidos sin tocar lo copiado.
			const lista = async (v: string) => ((await (await handleListenList(new Request(`https://w/?action=listen-list&vista=${v}`), E, true)).json()) as any).items.map((x: any) => x.clave);
			expect(await lista("cargados")).toEqual(["PRO001"]);
			// El producto ya existe en la tienda: deshacer NO borra lo copiado.
			const deshacer = (existe: boolean | null) => handleListenDecide(new Request("https://w/", { method: "POST", body: JSON.stringify({ clave: "PRO001", decision: "preorder" }) }),
				E, true, NOW.getTime(), async () => existe);
			const d1: any = await (await deshacer(true)).json();
			expect(d1.copias).toEqual({ borradas: 0, conservadas: "el producto pro001 existe en la tienda" });
			expect(await lista("elegidos")).toEqual(["PRO001"]);
			const vuelto = await rel("PRO001");
			expect(vuelto.cargado_at).toBeUndefined();
			expect(vuelto.promovidos).toBeUndefined();
			expect((await E.R2.list({ prefix: "staging-audio/PRO001/" })).objects).toHaveLength(1);

			// Otra carga y deshacer sin producto en la tienda: se borran las copias (audio y portada).
			await promo(cuerpo);
			const d2: any = await (await deshacer(false)).json();
			expect(d2.copias).toEqual({ borradas: 2 });
			expect((await E.R2.list({ prefix: "staging-audio/" })).objects).toHaveLength(0);
			expect((await E.R2.list({ prefix: "staging-covers/" })).objects).toHaveLength(0);

			// Sin poder comprobar la tienda: se conservan.
			await promo(cuerpo);
			expect(((await (await deshacer(null)).json()) as any).copias).toEqual({ borradas: 0, conservadas: "no se pudo comprobar la tienda" });
			expect((await E.R2.list({ prefix: "staging-audio/PRO001/" })).objects).toHaveLength(1);
		} finally { delete E.LISTEN_PROMOTE_AUDIO_PREFIX; delete E.LISTEN_PROMOTE_COVERS_PREFIX; }
	});

	it("cargado hace 7 dias: se borra la copia de la bandeja y el registro, nunca lo copiado al producto", async () => {
		const hace = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();
		await pon(base("CAR007", { decision: "cargado", decided_at: hace(7), cargado_at: hace(7) }));
		await pon(base("CAR006", { decision: "cargado", decided_at: hace(6), cargado_at: hace(6) }));
		await E.R2.put("audio/CAR007/a.mp3", new Uint8Array(3));
		expect(await limpiaBandeja(E, NOW)).toEqual({ rechazados: 0, sin_audio: 0, fuera: 0, cargados: 1 });
		expect(await rel("CAR007")).toBeNull();
		expect((await E.LISTEN_R2.list({ prefix: "listen/CAR007/" })).objects).toHaveLength(0);
		expect((await E.R2.list({ prefix: "audio/CAR007/" })).objects).toHaveLength(1);
		expect(await rel("CAR006")).not.toBeNull();
	});

	it("un elegido ya en tienda pasa a Cargados con su motivo, sin copiar nada; deshacer lo devuelve a Elegidos", async () => {
		await pon(base("TIE001", { decision: "preorder", decided_at: NOW.toISOString() }));
		await pon(base("PEN010", { decision: "pendiente", decided_at: NOW.toISOString() }));
		const decide = (body: any) => handleListenDecide(new Request("https://w/", { method: "POST", body: JSON.stringify(body) }), E, true, NOW.getTime());
		expect((await decide({ clave: "TIE001", decision: "cargado" })).status).toBe(400);              // sin en_tienda, no
		expect((await decide({ clave: "PEN010", decision: "cargado", en_tienda: "x" })).status).toBe(409); // solo elegidos
		const r: any = await (await decide({ clave: "TIE001", decision: "cargado", en_tienda: "tie001" })).json();
		expect(r.item).toMatchObject({ decision: "cargado", en_tienda_como: "tie001", cargado_at: NOW.toISOString() });
		expect(await rel("TIE001")).toMatchObject({ decision: "cargado", en_tienda_como: "tie001" });
		expect((await E.R2.list()).objects).toHaveLength(0);
		await decide({ clave: "TIE001", decision: "preorder" });
		const vuelto = await rel("TIE001");
		expect(vuelto.decision).toBe("preorder");
		expect(vuelto.en_tienda_como).toBeUndefined();
		expect(vuelto.cargado_at).toBeUndefined();
	});

	it("sin promopack: el disco se queda con la portada del correo; con listen-upload pasa a listo con el audio subido a mano", async () => {
		redes(zipDe({}));
		await archiva("RD__X---Y-SIN001__2026-11-01.html", rdEmail("SIN001", "https://example.com/no-es-un-zip"));
		await runListenIngest(E, { now: NOW });
		const d = await rel("SIN001");
		expect(d).toMatchObject({ estado: "sin_zip", tracks: [], cover: { key: "listen/SIN001/cover.jpg", from: "email" } });

		const sube = (body: any, ok = true, clave = "SIN001") =>
			handleListenUpload(new Request(`https://w/?action=listen-upload&clave=${clave}`, { method: "POST", body }), E, ok, NOW.getTime());
		expect((await sube(zipDe({ "a.mp3": 5 }), false)).status).toBe(401);
		expect((await sube(zipDe({ "a.mp3": 5 }), true, "NOPE01")).status).toBe(404);
		expect((await sube(new Uint8Array([1, 2, 3]))).status).toBe(400);              // no es un ZIP
		expect((await sube(zipDe({ "solo.jpg": 5 }))).status).toBe(400);               // sin MP3

		// Sin JPG en el ZIP: se queda la portada del correo.
		const r1: any = await (await sube(zipDe({ "A1 - Uno.mp3": 10, "B1 - Dos.mp3": 20 }))).json();
		expect(r1.item).toMatchObject({ estado: "listo", subido_a_mano_at: NOW.toISOString(), cover: { from: "email" } });
		expect(r1.item.tracks.map((t: any) => t.name)).toEqual(["Uno", "Dos"]);   // humanizados (track-names.mjs)
		expect(r1.item.tracks[0].url).toMatch(/sig=[0-9a-f]{64}$/);
		// Otra subida sustituye: fuera las pistas viejas; con JPG, portada nueva del ZIP.
		await sube(zipDe({ "Otra.mp3": 7, "front.jpg": 4 }));
		const d2 = await rel("SIN001");
		expect(d2.tracks.map((t: any) => t.key)).toEqual(["listen/SIN001/01-Otra.mp3"]);
		expect(d2.cover).toEqual({ key: "listen/SIN001/cover.jpg", from: "zip" });
		expect((await E.LISTEN_R2.list({ prefix: "listen/SIN001/" })).objects.map((o: any) => o.key).sort())
			.toEqual(["listen/SIN001/01-Otra.mp3", "listen/SIN001/cover.jpg"]);
	});

	it("los sin audio que entraron sin portada la recuperan de su correo, una sola vez", async () => {
		const f = redes(zipDe({}));
		await archiva("RD__X---Y-VIE001__2026-11-01.html", rdEmail("VIE001"));
		await E.SYNC_STATE.put("listen:rel:VIE001", JSON.stringify({
			clave: "VIE001", catno: "VIE001", distribuidor: "RD", artist: "A", title: "T", estado: "sin_zip", tracks: [], bytes: 0,
			email: "RD__X---Y-VIE001__2026-11-01.html", email_date: "2026-11-01", ingested_at: "2026-11-01T10:00:00Z",
		}), { metadata: { c: "VIE001", e: "sin_zip", n: 0, at: "2026-11-01T10:00:00Z" } });
		expect(await completaPortadas(E)).toBe(1);
		expect(await rel("VIE001")).toMatchObject({ cover: { key: "listen/VIE001/cover.jpg", from: "email" }, portada_comprobada: true });
		const llamadas = f.mock.calls.length;
		expect(await completaPortadas(E)).toBe(0);                       // ya comprobada: no vuelve a mirar
		expect(f.mock.calls.length).toBe(llamadas);
	});

	it("productoEnTienda pregunta por handle con productByIdentifier (no el indice de busqueda)", async () => {
		const q = vi.spyOn(shopifyAdmin, "shopifyAdminGraphQL");
		q.mockResolvedValueOnce({ data: { productByIdentifier: { id: "gid://shopify/Product/1" } } });
		expect(await productoEnTienda(E, "mslp022ltd")).toBe(true);
		expect(q.mock.calls[0][1]).toContain("productByIdentifier(identifier: { handle: $h })");
		expect(q.mock.calls[0][2]).toEqual({ h: "mslp022ltd" });
		q.mockResolvedValueOnce({ data: { productByIdentifier: null } });
		expect(await productoEnTienda(E, "cits007")).toBe(false);
		q.mockResolvedValueOnce({ errors: [{ message: "Access denied" }] });
		expect(await productoEnTienda(E, "x")).toBeNull();
		q.mockRejectedValueOnce(new Error("sin red"));
		expect(await productoEnTienda(E, "x")).toBeNull();
	});
});
