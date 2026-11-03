import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { handleWsZips, dedupeItems, esZip, artIdValido, prefijoWs } from "../src/lib/ws-zips";

const CORS = { "Access-Control-Allow-Origin": "*" };
const W = "https://w.test/";
// Prefijo propio por ejecucion: el R2 local se comparte entre tests.
const wenv = () => ({ LISTEN_R2: (env as any).LISTEN_R2, WS_ZIPS_R2_PREFIX: `t-${crypto.randomUUID()}/` });
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

function req(action: string, qs = "", init: RequestInit = {}, token = "") {
	const headers = new Headers(init.headers);
	if (token) headers.set("authorization", `Bearer ${token}`);
	return new Request(`${W}?action=${action}${qs}`, { ...init, headers });
}

describe("helpers", () => {
	it("dedupe por ArtId, descarta ArtId no numericos", () => {
		expect(dedupeItems([
			{ artId: "170379", artNo: "NUIT014" },
			{ artId: "170379", artNo: "NUIT014 (dup)" },
			{ artId: "../x", artNo: "BAD" },
			{ artId: 155799, artNo: "WHYT085" },
		])).toEqual([{ artId: "170379", artNo: "NUIT014" }, { artId: "155799", artNo: "WHYT085" }]);
	});
	it("solo acepta la cabecera de ZIP local", () => {
		expect(esZip(ZIP)).toBe(true);
		expect(esZip(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(false);
		expect(esZip(new TextEncoder().encode("<html>"))).toBe(false);
	});
	it("ArtId valido", () => {
		expect(artIdValido("170379")).toBe(true);
		expect(artIdValido("17a")).toBe(false);
	});
	it("prefijo por defecto ws-zips/", () => {
		expect(prefijoWs({ LISTEN_R2: null as any })).toBe("ws-zips/");
	});
});

describe("flujo bookmarklet", () => {
	it("trabajo, status, upload, none, get, clean", async () => {
		const e = wenv();
		// Sin admin no se crea trabajo
		expect((await handleWsZips("ws-zips-job", req("ws-zips-job", "", { method: "POST", body: "{}" }), e, false, CORS)).status).toBe(401);

		const r = await handleWsZips("ws-zips-job", req("ws-zips-job", "", {
			method: "POST", body: JSON.stringify({ items: [{ artId: "1", artNo: "AAA001" }, { artId: "2", artNo: "NUIT014" }, { artId: "1", artNo: "AAA001" }] }),
		}), e, true, CORS);
		const job: any = await r.json();
		expect(job.items.map((i: any) => i.estado)).toEqual(["pendiente", "pendiente"]);
		const t = job.token;

		// Token de trabajo: un ArtId ajeno no se puede subir
		const ajeno = await handleWsZips("ws-zips-upload", req("ws-zips-upload", "&artid=9", { method: "POST", body: ZIP, headers: { "content-type": "application/zip" } }, t), e, false, CORS);
		expect(ajeno.status).toBe(403);
		// Solo ZIP
		const html = await handleWsZips("ws-zips-upload", req("ws-zips-upload", "&artid=1", { method: "POST", body: "<html>", headers: { "content-type": "application/zip" } }, t), e, false, CORS);
		expect(html.status).toBe(415);
		const ct = await handleWsZips("ws-zips-upload", req("ws-zips-upload", "&artid=1", { method: "POST", body: ZIP, headers: { "content-type": "text/html" } }, t), e, false, CORS);
		expect(ct.status).toBe(415);
		// Tope de tamano por content-length
		const grande = await handleWsZips("ws-zips-upload", req("ws-zips-upload", "&artid=1", { method: "POST", body: ZIP, headers: { "content-type": "application/zip", "content-length": String(61 * 1024 * 1024) } }, t), e, false, CORS);
		expect(grande.status).toBe(413);

		expect((await handleWsZips("ws-zips-upload", req("ws-zips-upload", "&artid=1", { method: "POST", body: ZIP, headers: { "content-type": "application/zip" } }, t), e, false, CORS)).status).toBe(200);
		expect((await handleWsZips("ws-zips-none", req("ws-zips-none", "&artid=2", { method: "POST" }, t), e, false, CORS)).status).toBe(200);

		const st: any = await (await handleWsZips("ws-zips-status", req("ws-zips-status", "", {}, t), e, false, CORS)).json();
		expect(st.items.map((i: any) => [i.artId, i.estado])).toEqual([["1", "ok"], ["2", "sin_assets"]]);

		// Un 404 posterior no tapa un ZIP ya subido
		const n2: any = await (await handleWsZips("ws-zips-none", req("ws-zips-none", "&artid=1", { method: "POST" }, t), e, false, CORS)).json();
		expect(n2.estado).toBe("ok");

		// El token de trabajo no lee ni borra
		expect((await handleWsZips("ws-zips-get", req("ws-zips-get", "&artid=1", {}, t), e, false, CORS)).status).toBe(401);
		const g = await handleWsZips("ws-zips-get", req("ws-zips-get", "&artid=1"), e, true, CORS);
		expect(new Uint8Array(await g.arrayBuffer())).toEqual(ZIP);

		await handleWsZips("ws-zips-clean", req("ws-zips-clean", "&artid=1", { method: "POST" }), e, true, CORS);
		const st2: any = await (await handleWsZips("ws-zips-status", req("ws-zips-status", "&artids=1,2"), e, true, CORS)).json();
		expect(st2.items.map((i: any) => i.estado)).toEqual(["pendiente", "sin_assets"]);
	});

	it("token inventado o caducado da 401", async () => {
		const e = wenv();
		const r = await handleWsZips("ws-zips-status", req("ws-zips-status", "", {}, "a".repeat(64)), e, false, CORS);
		expect(r.status).toBe(401);
	});
});
