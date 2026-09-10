import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
	normalizeName,
	slugify,
	cleanDisplay,
	proposeSplit,
	resolveOne,
	getEntity,
	handleEntityReviewApprove,
	handleEntityReviewReject,
	handleEntityReviewList,
} from "../src/lib/entities";

// Todo lo que se prueba aqui sale de datos reales del catalogo (1266 productos,
// 910 vendors, 493 sellos). Los ejemplos NO son inventados: cada uno esta en
// Shopify hoy.

const SECRET = "test-secret";

function req(url: string, init: RequestInit = {}) {
	return new Request(url, {
		...init,
		headers: { Authorization: `Bearer ${SECRET}`, ...(init.headers || {}) },
	});
}

async function wipe() {
	for (const prefix of ["entity:", "alias:", "ignore:", "children:", "review:"]) {
		const l = await env.ENTITIES.list({ prefix, limit: 1000 });
		for (const k of l.keys) await env.ENTITIES.delete(k.name);
	}
}

describe("normalizacion", () => {
	it("agrupa las grafias que colapsan solas", () => {
		// Los 4 de Omar S del catalogo real.
		const omar = ["Omar S", "Omar s", "omar s", "Omar-S"].map(normalizeName);
		expect(new Set(omar).size).toBe(1);
		// Y las 3 de Johannes Albert.
		const ja = ["JOHANNES ALBERT", "Johannes Albert", "johannes albert"].map(normalizeName);
		expect(new Set(ja).size).toBe(1);
	});

	it("NO junta sellos distintos que solo se parecen", () => {
		// Los falsos positivos conocidos: nunca deben normalizar igual.
		expect(normalizeName("AXIS")).not.toBe(normalizeName("Axis Of People"));
		expect(normalizeName("Base")).not.toBe(normalizeName("Based Faith"));
		expect(normalizeName("NOTON")).not.toBe(normalizeName("Not On Label"));
	});

	it("hace slugs estables y sin diacriticos", () => {
		expect(slugify("DJ Koze")).toBe("dj-koze");
		expect(slugify("Freerange Records")).toBe("freerange-records");
		expect(slugify("David Böning")).toBe("david-boning");
		expect(slugify("  Rip ‘n’ It  ")).toBe("rip-n-it");
	});
});

describe("cleanDisplay", () => {
	it("repara la corrupcion de ligaduras del parseo de PDF", () => {
		// Los 4 casos reales del catalogo.
		expect(cleanDisplay("Bano ff ee Pies")).toBe("Banoffee Pies");
		expect(cleanDisplay("Forti fi ed Audio")).toBe("Fortified Audio");
		expect(cleanDisplay("Synaptic Cli ff s")).toBe("Synaptic Cliffs");
		expect(cleanDisplay("O ff   House")).toBe("Off House");
	});

	it("limpia truncados sin inventar nada", () => {
		expect(cleanDisplay("Cinthie, Fireground, Toobris, DJ Babatr, DJ Maria,"))
			.toBe("Cinthie, Fireground, Toobris, DJ Babatr, DJ Maria");
		expect(cleanDisplay("  DJ   Koze ")).toBe("DJ Koze");
	});
});

describe("proposeSplit", () => {
	it("parte multi-artista por los separadores reales", () => {
		expect(proposeSplit("Delano Smith & Brian Kage").parts)
			.toEqual(["Delano Smith", "Brian Kage"]);
		expect(proposeSplit("Mood II Swing / Jovonn / Roy Davis Jr / Osunlade").parts)
			.toHaveLength(4);
		expect(proposeSplit("Charlie Rice, Nay Barr").parts)
			.toEqual(["Charlie Rice", "Nay Barr"]);
		expect(proposeSplit("10.000 BC | Tam15").parts)
			.toEqual(["10.000 BC", "Tam15"]);
	});

	it("no parte un nombre suelto", () => {
		expect(proposeSplit("DJ Koze").parts).toEqual(["DJ Koze"]);
		expect(proposeSplit("Session Victim").parts).toEqual(["Session Victim"]);
	});

	it("no confunde un parentesis aclaratorio con otro artista", () => {
		// "Echelon (Jeroen Search)" es UNA persona con su nombre real al lado.
		expect(proposeSplit("Echelon (Jeroen Search)").parts).toEqual(["Echelon (Jeroen Search)"]);
		expect(proposeSplit("Presence (Aka Charles Webster)").parts).toHaveLength(1);
	});
});

describe("resolveOne", () => {
	beforeEach(async () => {
		await wipe();
		(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
	});

	it("manda a la cola lo que no conoce, sin crear nada", async () => {
		const r = await resolveOne(env as any, "artist", { raw: "DJ Koze" }, "ws");
		expect(r.status).toBe("review");
		expect(r.slugs).toEqual([]);
		// Lo importante: NO ha creado entidad.
		const l = await env.ENTITIES.list({ prefix: "entity:" });
		expect(l.keys).toHaveLength(0);
		// Y si hay fila en la cola, con propuesta de crear.
		const rec = JSON.parse((await env.ENTITIES.get(`review:artist:${normalizeName("DJ Koze")}`))!);
		expect(rec.proposal.action).toBe("create");
		expect(rec.proposal.parts[0].display).toBe("DJ Koze");
		expect(rec.count).toBe(1);
	});

	it("agrupa variantes en una sola fila; count son PRODUCTOS distintos", async () => {
		// Tres productos, dos grafias, y el tercero repite el handle del primero:
		// son 2 productos distintos, no 3 apariciones.
		const seen: Array<[string, string]> = [
			["DJ Koze", "pampa045"],
			["Dj Koze", "pampa046"],
			["DJ Koze", "pampa045"],
		];
		for (const [raw, handle] of seen) {
			await resolveOne(env as any, "artist", { raw, context: { handle } }, "ws");
		}
		const l = await env.ENTITIES.list({ prefix: "review:artist:" });
		expect(l.keys).toHaveLength(1);
		const rec = JSON.parse((await env.ENTITIES.get(l.keys[0].name))!);
		expect(rec.count).toBe(2);
		expect(rec.variants.sort()).toEqual(["DJ Koze", "Dj Koze"]);
	});

	it("propone el troceo de un multi-artista, marcando lo que ya existe", async () => {
		// Delano Smith ya aprobado.
		await handleEntityReviewApprove(req("https://x/?action=entity-review-approve", {
			method: "POST",
			body: JSON.stringify({ kind: "artist", norm: normalizeName("Delano Smith"), action: "create",
				parts: [{ display: "Delano Smith" }] }),
		}), env as any).catch(() => {});
		// (no habia fila; lo creamos a mano para el escenario)
		await env.ENTITIES.put("entity:delano-smith", JSON.stringify({
			slug: "delano-smith", display: "Delano Smith", roles: ["artist"],
			aliases: [], sources: [], status: "active", createdAt: 1, updatedAt: 1,
		}));
		await env.ENTITIES.put(`alias:a:${normalizeName("Delano Smith")}`, "delano-smith");

		await resolveOne(env as any, "artist", { raw: "Delano Smith & Brian Kage" }, "ws");
		const rec = JSON.parse((await env.ENTITIES.get(
			`review:artist:${normalizeName("Delano Smith & Brian Kage")}`))!);
		expect(rec.proposal.action).toBe("split");
		expect(rec.proposal.parts).toHaveLength(2);
		expect(rec.proposal.parts[0].existingSlug).toBe("delano-smith");
		expect(rec.proposal.parts[1].existingSlug).toBeUndefined();
	});

	it("NUNCA trocea un sello", async () => {
		// "Vibes & Pepper Records" es un solo sello: partirlo seria el error.
		await resolveOne(env as any, "label", { raw: "Vibes & Pepper Records" }, "ws");
		const rec = JSON.parse((await env.ENTITIES.get(
			`review:label:${normalizeName("Vibes & Pepper Records")}`))!);
		expect(rec.proposal.action).toBe("create");
		expect(rec.proposal.parts).toHaveLength(1);
	});

	it("resuelve por alias exacto y por normalizado", async () => {
		await env.ENTITIES.put("entity:dj-koze", JSON.stringify({
			slug: "dj-koze", display: "DJ Koze", roles: ["artist"],
			aliases: [], sources: [], status: "active", createdAt: 1, updatedAt: 1,
		}));
		await env.ENTITIES.put(`alias:a:${normalizeName("DJ Koze")}`, "dj-koze");

		const a = await resolveOne(env as any, "artist", { raw: "DJ Koze" }, "ws");
		expect(a.status).toBe("resolved");
		expect(a.slugs).toEqual(["dj-koze"]);

		// Otra grafia del catalogo real, sin alias propio: cae por normalizado.
		const b = await resolveOne(env as any, "artist", { raw: "Dj Koze" }, "ws");
		expect(b.status).toBe("resolved");
		expect(b.slugs).toEqual(["dj-koze"]);
		expect(b.matchedBy).toBe("alias");
	});

	it("respeta la lista de ignorados", async () => {
		await env.ENTITIES.put(`ignore:a:${normalizeName("V/A")}`, "1");
		const r = await resolveOne(env as any, "artist", { raw: "V/A" }, "ws");
		expect(r.status).toBe("ignored");
		expect(await env.ENTITIES.get(`review:artist:${normalizeName("V/A")}`)).toBeNull();
	});
});

// El valor de alias:{k}:{norm} son slugs separados por COMA — asi es como una
// grafia cruda resuelve a N entidades tras un split. Un slug con una coma
// dentro romperia ese split y resolveria a entidades inexistentes.
describe("un slug nunca lleva coma", () => {
	beforeEach(async () => {
		await wipe();
		(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
	});

	it("slugify no puede producir una, ni con nombres llenos de comas", () => {
		const nasty = [
			"Cinthie, Fireground, Toobris, DJ Babatr, DJ Maria,",
			"luciano, felipe venegas, diego errázuriz",
			"Aybee, Dego, Fred P, Gerald Mitchell, Ian O’Brien, K15",
			"Charlie Rice, Nay Barr",
			",,,",
		];
		for (const n of nasty) expect(slugify(n)).not.toContain(",");
	});

	it("approve saneа un slug con coma en vez de guardarlo tal cual", async () => {
		await resolveOne(env as any, "artist", { raw: "Charlie Rice, Nay Barr" }, "ws");
		const norm = normalizeName("Charlie Rice, Nay Barr");

		await handleEntityReviewApprove(req("https://x/", {
			method: "POST",
			body: JSON.stringify({ kind: "artist", norm, action: "create",
				parts: [{ display: "Charlie Rice", slug: "charlie,rice" }] }),
		}), env as any);

		const l = await env.ENTITIES.list({ prefix: "entity:" });
		for (const k of l.keys) expect(k.name.slice("entity:".length)).not.toContain(",");
	});

	it("ningun slug de un split lleva coma, y el alias sigue partiendose bien", async () => {
		await resolveOne(env as any, "artist", { raw: "Delano Smith & Brian Kage" }, "ws");
		const norm = normalizeName("Delano Smith & Brian Kage");
		await handleEntityReviewApprove(req("https://x/", {
			method: "POST",
			body: JSON.stringify({ kind: "artist", norm, action: "split",
				parts: [{ display: "Delano Smith" }, { display: "Brian Kage" }] }),
		}), env as any);

		const r = await resolveOne(env as any, "artist", { raw: "Delano Smith & Brian Kage" }, "ws");
		expect(r.slugs).toHaveLength(2);
		for (const s of r.slugs) expect(s).not.toContain(",");
	});
});

describe("cola: aprobar y rechazar", () => {
	beforeEach(async () => {
		await wipe();
		(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
	});

	it("exige Bearer", async () => {
		const res = await handleEntityReviewList(
			new Request("https://x/?action=entity-review-list"), env as any);
		expect(res.status).toBe(401);
	});

	it("create: entidad + alias, y la fila desaparece", async () => {
		await resolveOne(env as any, "artist", { raw: "Dj Koze" }, "ws");
		const norm = normalizeName("Dj Koze");

		const res = await handleEntityReviewApprove(req("https://x/", {
			method: "POST",
			body: JSON.stringify({ kind: "artist", norm, action: "create",
				parts: [{ display: "DJ Koze" }] }),
		}), env as any);
		expect(res.status).toBe(200);

		const e = await getEntity(env as any, "dj-koze");
		expect(e?.display).toBe("DJ Koze");
		expect(e?.roles).toEqual(["artist"]);
		expect(await env.ENTITIES.get(`review:artist:${norm}`)).toBeNull();
		// Y a partir de ahora resuelve solo.
		expect((await resolveOne(env as any, "artist", { raw: "Dj Koze" }, "ws")).status).toBe("resolved");
	});

	it("split: una grafia cruda resuelve a N slugs", async () => {
		await resolveOne(env as any, "artist", { raw: "Delano Smith & Brian Kage" }, "ws");
		const norm = normalizeName("Delano Smith & Brian Kage");

		await handleEntityReviewApprove(req("https://x/", {
			method: "POST",
			body: JSON.stringify({ kind: "artist", norm, action: "split",
				parts: [{ display: "Delano Smith" }, { display: "Brian Kage" }] }),
		}), env as any);

		const r = await resolveOne(env as any, "artist", { raw: "Delano Smith & Brian Kage" }, "ws");
		expect(r.status).toBe("resolved");
		expect(r.slugs).toEqual(["delano-smith", "brian-kage"]);
		expect(r.display).toEqual(["Delano Smith", "Brian Kage"]);
	});

	it("merge: la variante pasa a ser alias de la entidad que ya existe", async () => {
		await resolveOne(env as any, "label", { raw: "Freerange" }, "ws");
		await handleEntityReviewApprove(req("https://x/", {
			method: "POST",
			body: JSON.stringify({ kind: "label", norm: normalizeName("Freerange"),
				action: "create", parts: [{ display: "Freerange Records" }] }),
		}), env as any);

		await resolveOne(env as any, "label", { raw: "Freerange Records" }, "ws");
		const norm = normalizeName("Freerange Records");
		await handleEntityReviewApprove(req("https://x/", {
			method: "POST",
			body: JSON.stringify({ kind: "label", norm, action: "merge",
				targetSlug: "freerange-records" }),
		}), env as any);

		// Las dos grafias caen en la misma entidad.
		for (const raw of ["Freerange", "Freerange Records"]) {
			const r = await resolveOne(env as any, "label", { raw }, "ws");
			expect(r.slugs).toEqual(["freerange-records"]);
		}
	});

	it("child: sub-sello real con parent e indice de hijos", async () => {
		await env.ENTITIES.put("entity:chiwax", JSON.stringify({
			slug: "chiwax", display: "chiwax", roles: ["label"],
			aliases: [], sources: [], status: "active", createdAt: 1, updatedAt: 1,
		}));
		await resolveOne(env as any, "label", { raw: "chiwax classic edition" }, "dbh");
		const norm = normalizeName("chiwax classic edition");

		await handleEntityReviewApprove(req("https://x/", {
			method: "POST",
			body: JSON.stringify({ kind: "label", norm, action: "child",
				parentSlug: "chiwax", parts: [{ display: "chiwax classic edition" }] }),
		}), env as any);

		const child = await getEntity(env as any, "chiwax-classic-edition");
		expect(child?.parent).toBe("chiwax");
		expect(await env.ENTITIES.get("children:chiwax:chiwax-classic-edition")).toBe("1");
	});

	it("una sola entidad acumula roles de artista y de sello", async () => {
		// 2000Black es vendor Y sello en el catalogo real.
		for (const kind of ["artist", "label"] as const) {
			await resolveOne(env as any, kind, { raw: "2000Black" }, "ws");
			await handleEntityReviewApprove(req("https://x/", {
				method: "POST",
				body: JSON.stringify({ kind, norm: normalizeName("2000Black"),
					action: "create", parts: [{ display: "2000Black", slug: "2000black" }] }),
			}), env as any);
		}
		const e = await getEntity(env as any, "2000black");
		expect(e?.roles.sort()).toEqual(["artist", "label"]);
	});

	it("reject: a ignorados y fuera de la cola", async () => {
		await resolveOne(env as any, "artist", { raw: "V/A" }, "ws");
		const norm = normalizeName("V/A");
		await handleEntityReviewReject(req("https://x/", {
			method: "POST",
			body: JSON.stringify({ kind: "artist", norm }),
		}), env as any);

		expect(await env.ENTITIES.get(`ignore:a:${norm}`)).toBe("1");
		expect(await env.ENTITIES.get(`review:artist:${norm}`)).toBeNull();
		expect((await resolveOne(env as any, "artist", { raw: "V/A" }, "ws")).status).toBe("ignored");
	});

	it("repetir el barrido no infla el conteo", async () => {
		// Dos pasadas identicas sobre los mismos dos productos.
		for (let pass = 0; pass < 2; pass++) {
			for (const handle of ["pampa045", "pampa046"]) {
				await resolveOne(env as any, "artist", { raw: "DJ Koze", context: { handle } }, "sweep");
			}
		}
		const rec = JSON.parse((await env.ENTITIES.get(`review:artist:${normalizeName("DJ Koze")}`))!);
		expect(rec.count).toBe(2);          // no 4
		expect(rec.countApprox).toBeFalsy();
	});

	it("la cola sale ordenada por count descendente", async () => {
		for (let i = 0; i < 3; i++) await resolveOne(env as any, "artist", { raw: "Calibre" }, "tv");
		await resolveOne(env as any, "artist", { raw: "Sabre" }, "tv");

		const res = await handleEntityReviewList(req("https://x/?action=entity-review-list&kind=artist"), env as any);
		const body: any = await res.json();
		expect(body.records[0].raw).toBe("Calibre");
		expect(body.records[0].count).toBe(3);
	});
});
