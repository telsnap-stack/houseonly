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
	handleEntityReviewApproveBulk,
	handleEntityReviewRecompute,
	computeBucket,
	pickDisplay,
	shouldSplit,
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

describe("pickDisplay", () => {
	it("prefiere mayusculas mixtas sobre TODO MAYUSCULAS o todo minusculas", () => {
		// Caso real: la fila se creo con ALTON MILLER y proponia eso.
		expect(pickDisplay(["ALTON MILLER", "Alton Miller"])).toEqual({ display: "Alton Miller", auto: false });
		expect(pickDisplay(["omar s", "Omar S", "Omar-S"]).display).toMatch(/Omar/);
		expect(pickDisplay(["JOHANNES ALBERT", "johannes albert", "Johannes Albert"]))
			.toEqual({ display: "Johannes Albert", auto: false });
	});

	it("entre varias mixtas, gana la de mas productos", () => {
		const got = pickDisplay(["Dj Koze", "DJ Koze"], { "Dj Koze": 2, "DJ Koze": 11 });
		expect(got.display).toBe("DJ Koze");
	});

	it("si TODAS son de un solo caso, Title Case y marcado como automatico", () => {
		// "of" se queda en minuscula, igual que en "Axis of People": es la misma regla.
		expect(pickDisplay(["RHYHM OF PARADISE"])).toEqual({ display: "Rhyhm of Paradise", auto: true });
		expect(pickDisplay(["deep space orchestra"])).toEqual({ display: "Deep Space Orchestra", auto: true });
		// Un slug tambien: los sellos de Deep Jungle vienen asi.
		expect(pickDisplay(["deep-jungle"])).toEqual({ display: "Deep Jungle", auto: true });
	});

	it("deja las particulas cortas en minuscula salvo al principio", () => {
		expect(pickDisplay(["LA RAMA RECORDS"]).display).toBe("La Rama Records");
		expect(pickDisplay(["AXIS OF PEOPLE"]).display).toBe("Axis of People");
	});
});

// Los dos casos que Eduardo tiene que ver bien antes de aprobar nada.
describe("recommend contra el catalogo real", () => {
	beforeEach(async () => {
		await wipe();
		(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
	});

	it("Rhythm & Sound queda como NO partir: ni Rhythm ni Sound existen solos", async () => {
		await resolveOne(env as any, "artist", { raw: "Rhythm & Sound" }, "sweep");
		const rec = JSON.parse((await env.ENTITIES.get(
			`review:artist:${normalizeName("Rhythm & Sound")}`))!);
		expect(rec.proposal.action).toBe("split");        // sigue en la vista Split
		expect(rec.proposal.recommend).toBe("keep");      // pero recomienda dejarlo
	});

	it("Delano Smith & Brian Kage SI se parte: Delano Smith existe solo", async () => {
		// Delano Smith tiene discos a su nombre, asi que hay fila propia.
		await resolveOne(env as any, "artist", { raw: "Delano Smith" }, "sweep");
		await resolveOne(env as any, "artist", { raw: "Delano Smith & Brian Kage" }, "sweep");
		const rec = JSON.parse((await env.ENTITIES.get(
			`review:artist:${normalizeName("Delano Smith & Brian Kage")}`))!);
		expect(rec.proposal.recommend).toBe("split");
		expect(rec.proposal.recommendWhy).toContain("por su cuenta");
	});
});

describe("pickDisplay: acronimos", () => {
	it("conserva el acronimo en mayusculas y NO lo marca como automatico", () => {
		// Con digitos.
		expect(pickDisplay(["CV313", "cv313"])).toEqual({ display: "CV313", auto: false });
		expect(pickDisplay(["R2"])).toEqual({ display: "R2", auto: false });
		// Sin vocales.
		expect(pickDisplay(["DRS"])).toEqual({ display: "DRS", auto: false });
		expect(pickDisplay(["STL", "stl"])).toEqual({ display: "STL", auto: false });
		expect(pickDisplay(["BB"])).toEqual({ display: "BB", auto: false });
		// La 'y' cuenta como vocal: "rhythm" es una palabra, no un acronimo.
		expect(pickDisplay(["rhythm"])).toEqual({ display: "Rhythm", auto: true });
	});

	it("si NO existe una grafia en mayusculas, no se inventa", () => {
		// Estos se escriben asi en el catalogo: pasarlos a mayusculas por llevar
		// un digito los estropea igual que Title Case estropeaba CV313.
		expect(pickDisplay(["2lanes"])).toEqual({ display: "2lanes", auto: false });
		expect(pickDisplay(["dot13"])).toEqual({ display: "dot13", auto: false });
		expect(pickDisplay(["4yo4u"])).toEqual({ display: "4yo4u", auto: false });
		expect(pickDisplay(["123.ro"])).toEqual({ display: "123.ro", auto: false });
	});

	it("las palabras de verdad y los slugs si van a Title Case, con badge", () => {
		expect(pickDisplay(["deep-jungle"])).toEqual({ display: "Deep Jungle", auto: true });
		expect(pickDisplay(["RHYHM OF PARADISE"])).toEqual({ display: "Rhyhm of Paradise", auto: true });
		expect(pickDisplay(["deep space orchestra"]).auto).toBe(true);
		// "rawax" tiene vocales y no es corto-sin-vocales: es una palabra.
		expect(pickDisplay(["rawax"])).toEqual({ display: "Rawax", auto: true });
	});

	it("una grafia mixta siempre gana al acronimo", () => {
		expect(pickDisplay(["MSYMIAKOS", "Msymiakos"])).toEqual({ display: "Msymiakos", auto: false });
	});
});

describe("mayusculas de las partes de un troceo", () => {
	beforeEach(async () => {
		await wipe();
		(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
	});

	it("arregla las partes cuando el crudo viene todo en minusculas", async () => {
		await resolveOne(env as any, "artist", { raw: "rhythm & sound" }, "sweep");
		const rec = JSON.parse((await env.ENTITIES.get(
			`review:artist:${normalizeName("rhythm & sound")}`))!);
		// Aunque se recomiende NO partir, si se parte las partes salen bien.
		expect(rec.proposal.parts.map((p: any) => p.display)).toEqual(["Rhythm", "Sound"]);
		expect(rec.proposal.displayAuto).toBe(true);
		expect(rec.proposal.recommend).toBe("keep");
	});

	it("NO toca las partes si el crudo ya venia con mayusculas mezcladas", async () => {
		// "DRS" es un acronimo: pasarlo por Title Case lo convertiria en "Drs".
		await resolveOne(env as any, "artist", { raw: "Calibre & DRS" }, "sweep");
		const rec = JSON.parse((await env.ENTITIES.get(
			`review:artist:${normalizeName("Calibre & DRS")}`))!);
		expect(rec.proposal.parts.map((p: any) => p.display)).toEqual(["Calibre", "DRS"]);
		expect(rec.proposal.displayAuto).toBeUndefined();
	});
});

describe("shouldSplit", () => {
	it("solo parte si hay EVIDENCIA: alguna parte existe sola en el catalogo", () => {
		expect(shouldSplit([true, false]).recommend).toBe("split");
		expect(shouldSplit([true, true]).recommend).toBe("split");
	});

	it("sin evidencia no parte, tenga los productos que tenga", () => {
		// El numero de productos ya no pinta nada: antes habia un umbral de 3 y
		// dejaba fuera lo que menos stock tiene.
		expect(shouldSplit([false, false]).recommend).toBe("keep");
		expect(shouldSplit([false, false, false]).recommend).toBe("keep");
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

describe("bucket: bulk vs decide", () => {
	beforeEach(async () => {
		await wipe();
		(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
	});

	const bucketOf = async (kind: "artist" | "label", raw: string) => {
		await resolveOne(env as any, kind, { raw }, "sweep");
		return JSON.parse((await env.ENTITIES.get(`review:${kind}:${normalizeName(raw)}`))!);
	};

	it("un nombre suelto y limpio es bulk", async () => {
		for (const raw of ["Session Victim", "Ian Pooley", "Theo Parrish"]) {
			const r = await bucketOf("artist", raw);
			expect(r.bucket).toBe("bulk");
			expect(r.bucketWhy).toBeUndefined();
		}
		expect((await bucketOf("label", "Toy Tonics")).bucket).toBe("bulk");
	});

	it("cada motivo de decide sale etiquetado", async () => {
		expect(await bucketOf("artist", "Delano Smith & Brian Kage"))
			.toMatchObject({ bucket: "decide", bucketWhy: "multi" });
		expect(await bucketOf("artist", "Echelon (Jeroen Search)"))
			.toMatchObject({ bucket: "decide", bucketWhy: "parens" });
		expect(await bucketOf("artist", "Cinthie, Fireground, Toobris, DJ Babatr, DJ Maria,"))
			.toMatchObject({ bucket: "decide" });
		for (const raw of ["V/A", "Various Artists", "Unknown Artist", "House Only"]) {
			expect(await bucketOf("artist", raw))
				.toMatchObject({ bucket: "decide", bucketWhy: "va" });
		}
	});

	it("tener candidato manda a decide, por encima de todo lo demas", () => {
		const base: any = {
			raw: "Freerange", variants: [], proposal: { action: "create", parts: [] },
			candidates: [{ slug: "review:freerangerecords", display: "Freerange Records", why: "prefix" }],
		};
		expect(computeBucket(base)).toEqual({ bucket: "decide", bucketWhy: "candidates" });
	});
});

describe("recompute: candidatos fila contra fila", () => {
	beforeEach(async () => {
		await wipe();
		(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
	});

	it("empareja filas de la cola entre si, que es lo que el barrido inicial no podia", async () => {
		// Ninguna entidad aprobada: findCandidates por si solo devolveria vacio.
		for (const raw of ["Freerange", "Freerange Records", "Toy Tonics"]) {
			await resolveOne(env as any, "label", { raw }, "sweep");
		}
		let before = JSON.parse((await env.ENTITIES.get(`review:label:${normalizeName("Freerange")}`))!);
		expect(before.candidates).toHaveLength(0);
		expect(before.bucket).toBe("bulk");

		const res: any = await (await handleEntityReviewRecompute(req("https://x/", {
			method: "POST", body: JSON.stringify({ kind: "label" }),
		}), env as any)).json();
		expect(res.updated).toBe(3);
		expect(res.withCandidates).toBe(2);   // las dos Freerange, no Toy Tonics

		const after = JSON.parse((await env.ENTITIES.get(`review:label:${normalizeName("Freerange")}`))!);
		expect(after.candidates[0].display).toBe("Freerange Records");
		expect(after.bucket).toBe("decide");
		expect(after.bucketWhy).toBe("candidates");

		// Y el que no tiene pariente se queda en bulk.
		const toy = JSON.parse((await env.ENTITIES.get(`review:label:${normalizeName("Toy Tonics")}`))!);
		expect(toy.bucket).toBe("bulk");
	});

	it("una fila que se va a PARTIR no se ofrece como merge", async () => {
		// "Harmony" y "Harmony & Kid Lib" no son la misma cosa escrita de dos
		// maneras: la segunda CONTIENE a la primera y se va a trocear. Ofrecer
		// ahi un merge es invitar a destruir el dato.
		for (const raw of ["Harmony", "Harmony & Kid Lib", "Harmony & Xtreme"]) {
			await resolveOne(env as any, "artist", { raw }, "sweep");
		}
		await handleEntityReviewRecompute(req("https://x/", {
			method: "POST", body: JSON.stringify({ kind: "artist" }),
		}), env as any);

		const h = JSON.parse((await env.ENTITIES.get(`review:artist:${normalizeName("Harmony")}`))!);
		expect(h.candidates).toHaveLength(0);
		expect(h.bucket).toBe("bulk");
	});

	it("un barrido posterior NO borra los candidatos del recompute", async () => {
		for (const raw of ["Text", "Text Records"]) {
			await resolveOne(env as any, "label", { raw }, "sweep");
		}
		await handleEntityReviewRecompute(req("https://x/", {
			method: "POST", body: JSON.stringify({ kind: "label" }),
		}), env as any);
		const before = JSON.parse((await env.ENTITIES.get(`review:label:${normalizeName("Text")}`))!);
		expect(before.candidates).toHaveLength(1);

		// Segunda pasada del barrido sobre la misma fila.
		await resolveOne(env as any, "label", { raw: "Text", context: { handle: "otro" } }, "sweep");

		const after = JSON.parse((await env.ENTITIES.get(`review:label:${normalizeName("Text")}`))!);
		expect(after.candidates).toHaveLength(1);
		expect(after.bucket).toBe("decide");
	});

	it("no empareja siglas cortas ni cosas que solo se parecen de lejos", async () => {
		// Los falsos positivos reales conviven: AXIS es de 4, asi que SI se
		// propone como candidato de Axis Of People — y por eso va a decide, para
		// que lo mire una persona, en vez de fusionarse solo.
		for (const raw of ["R2", "R&S", "Yore", "Yoruba", "Text", "Text Records"]) {
			await resolveOne(env as any, "label", { raw }, "sweep");
		}
		await handleEntityReviewRecompute(req("https://x/", {
			method: "POST", body: JSON.stringify({ kind: "label" }),
		}), env as any);

		// "r2" y "rs" tienen menos de 4 caracteres: no entran a comparar.
		const r2 = JSON.parse((await env.ENTITIES.get(`review:label:${normalizeName("R2")}`))!);
		expect(r2.candidates).toHaveLength(0);

		// "yore" y "yoruba" se parecen a la vista pero divergen en la cuarta
		// letra, asi que no son prefijo uno de otro y NO se emparejan.
		const yore = JSON.parse((await env.ENTITIES.get(`review:label:${normalizeName("Yore")}`))!);
		expect(yore.candidates).toHaveLength(0);
		expect(yore.bucket).toBe("bulk");

		// "text" SI es prefijo de "textrecords": se propone, y ambas a decide.
		const text = JSON.parse((await env.ENTITIES.get(`review:label:${normalizeName("Text")}`))!);
		expect(text.candidates.map((c: any) => c.display)).toContain("Text Records");
		expect(text.bucket).toBe("decide");
	});
});

// El barrido inicial destapa pares donde NINGUNA de las dos es entidad todavia
// —Freerange / Freerange Records—, asi que no hay targetSlug al que apuntar.
describe("merge-rows: fusionar dos filas de la cola", () => {
	beforeEach(async () => {
		await wipe();
		(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
	});

	it("crea UNA entidad y deja los dos raws como alias suyos", async () => {
		await resolveOne(env as any, "label", { raw: "Freerange" }, "sweep");
		await resolveOne(env as any, "label", { raw: "Freerange Records" }, "sweep");

		const res: any = await (await handleEntityReviewApprove(req("https://x/", {
			method: "POST",
			body: JSON.stringify({
				kind: "label",
				norm: normalizeName("Freerange"),
				action: "merge-rows",
				mergeNorms: [normalizeName("Freerange Records")],
				display: "Freerange Records",
			}),
		}), env as any)).json();

		expect(res.merged).toBe(2);
		expect(res.slugs).toEqual(["freerange-records"]);

		// Las dos grafias resuelven a la misma entidad…
		for (const raw of ["Freerange", "Freerange Records"]) {
			const r = await resolveOne(env as any, "label", { raw }, "sweep");
			expect(r.status).toBe("resolved");
			expect(r.slugs).toEqual(["freerange-records"]);
		}
		// …y las dos filas se han ido de la cola.
		expect((await env.ENTITIES.list({ prefix: "review:label:" })).keys).toHaveLength(0);
		const e = await getEntity(env as any, "freerange-records");
		expect(e?.aliases.sort()).toEqual(["Freerange", "Freerange Records"]);
	});

	it("no fusiona nada si alguna fila no existe", async () => {
		await resolveOne(env as any, "label", { raw: "Freerange" }, "sweep");
		const res = await handleEntityReviewApprove(req("https://x/", {
			method: "POST",
			body: JSON.stringify({
				kind: "label", norm: normalizeName("Freerange"),
				action: "merge-rows", mergeNorms: ["noexiste"],
			}),
		}), env as any);
		expect(res.status).toBe(400);
		// La fila buena sigue en su sitio: no se ha aplicado media fusion.
		expect(await env.ENTITIES.get(`review:label:${normalizeName("Freerange")}`)).not.toBeNull();
	});
});

describe("muestras con titulo", () => {
	beforeEach(async () => {
		await wipe();
		(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
	});

	it("guarda handle y titulo, y enriquece una fila vieja sin romperla", async () => {
		// Fila al estilo antiguo: samples eran cadenas sueltas.
		await env.ENTITIES.put(`review:artist:${normalizeName("Calibre")}`, JSON.stringify({
			kind: "artist", norm: normalizeName("Calibre"), raw: "Calibre",
			variants: ["Calibre"], proposal: { action: "create", parts: [] },
			candidates: [], bucket: "bulk", sources: [], samples: ["taciturn"],
			handles: ["taciturn"], count: 1, firstSeen: 1, lastSeen: 1,
		}));

		await resolveOne(env as any, "artist",
			{ raw: "Calibre", context: { handle: "taciturn", title: "Taciturn" } }, "sweep");
		await resolveOne(env as any, "artist",
			{ raw: "Calibre", context: { handle: "planet-hearth", title: "Planet Hearth" } }, "sweep");

		const rec = JSON.parse((await env.ENTITIES.get(`review:artist:${normalizeName("Calibre")}`))!);
		expect(rec.samples[0]).toEqual({ h: "taciturn", t: "Taciturn" });
		expect(rec.samples[1]).toEqual({ h: "planet-hearth", t: "Planet Hearth" });
		expect(rec.count).toBe(2);
	});
});

describe("approve-bulk", () => {
	beforeEach(async () => {
		await wipe();
		(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
	});

	it("aprueba muchas filas de golpe y todas resuelven despues", async () => {
		const names = ["Session Victim", "Ian Pooley", "Theo Parrish"];
		for (const raw of names) await resolveOne(env as any, "artist", { raw }, "sweep");

		const res: any = await (await handleEntityReviewApproveBulk(req("https://x/", {
			method: "POST",
			body: JSON.stringify({
				kind: "artist",
				items: names.map(n => ({ norm: normalizeName(n) })),
			}),
		}), env as any)).json();

		expect(res.approved).toBe(3);
		expect(res.failed).toBe(0);
		for (const n of names) {
			const r = await resolveOne(env as any, "artist", { raw: n }, "sweep");
			expect(r.status).toBe("resolved");
		}
		expect((await env.ENTITIES.list({ prefix: "review:artist:" })).keys).toHaveLength(0);
	});

	it("aprobar dos veces la misma fila es idempotente", async () => {
		await resolveOne(env as any, "artist", { raw: "Session Victim" }, "sweep");
		const norm = normalizeName("Session Victim");
		const body = JSON.stringify({ kind: "artist", items: [{ norm }] });

		const first: any = await (await handleEntityReviewApproveBulk(
			req("https://x/", { method: "POST", body }), env as any)).json();
		expect(first.approved).toBe(1);
		expect(first.results[0].alreadyDone).toBeUndefined();

		// Segunda vez: la fila ya no existe, pero el alias apunta a la entidad.
		const second: any = await (await handleEntityReviewApproveBulk(
			req("https://x/", { method: "POST", body }), env as any)).json();
		expect(second.approved).toBe(1);          // NO cuenta como fallo
		expect(second.failed).toBe(0);
		expect(second.alreadyDone).toBe(1);
		expect(second.results[0].slug).toBe("session-victim");

		// Y no ha duplicado nada.
		const ents = await env.ENTITIES.list({ prefix: "entity:" });
		expect(ents.keys).toHaveLength(1);
		const e = await getEntity(env as any, "session-victim");
		expect(e?.aliases).toEqual(["Session Victim"]);
	});

	it("un norm que no existe SI es un fallo, no un 'ya hecho'", async () => {
		const res: any = await (await handleEntityReviewApproveBulk(req("https://x/", {
			method: "POST",
			body: JSON.stringify({ kind: "artist", items: [{ norm: "nuncaexistio" }] }),
		}), env as any)).json();
		expect(res.failed).toBe(1);
		expect(res.alreadyDone).toBe(0);
		expect(res.results[0].error).toBe("not found");
	});

	it("dos filas que acaban en el MISMO slug no se pisan los alias", async () => {
		// Van al mismo grupo y por tanto en fila india: si fueran en paralelo,
		// la lectura-modificacion-escritura de entity:{slug} perderia un alias.
		await resolveOne(env as any, "artist", { raw: "Los Hermanos" }, "sweep");
		await resolveOne(env as any, "artist", { raw: "los hermanos!" }, "sweep");

		const res: any = await (await handleEntityReviewApproveBulk(req("https://x/", {
			method: "POST",
			body: JSON.stringify({ kind: "artist", items: [
				{ norm: normalizeName("Los Hermanos"), display: "Los Hermanos" },
				{ norm: normalizeName("los hermanos!"), display: "Los Hermanos" },
			] }),
		}), env as any)).json();

		expect(res.approved).toBe(2);
		const e = await getEntity(env as any, "los-hermanos");
		expect(e?.aliases.sort()).toEqual(["Los Hermanos", "los hermanos!"]);
	});

	it("lo que falla no arrastra a lo demas", async () => {
		await resolveOne(env as any, "artist", { raw: "Ian Pooley" }, "sweep");
		const res: any = await (await handleEntityReviewApproveBulk(req("https://x/", {
			method: "POST",
			body: JSON.stringify({ kind: "artist", items: [
				{ norm: normalizeName("Ian Pooley") },
				{ norm: "estonoexiste" },
			] }),
		}), env as any)).json();
		expect(res.approved).toBe(1);
		expect(res.failed).toBe(1);
		expect(res.results.find((r: any) => r.norm === "estonoexiste").error).toBe("not found");
	});

	it("nunca produce un slug con coma, venga como venga el display", async () => {
		await resolveOne(env as any, "artist", { raw: "Charlie Rice, Nay Barr" }, "sweep");
		await handleEntityReviewApproveBulk(req("https://x/", {
			method: "POST",
			body: JSON.stringify({ kind: "artist", items: [
				{ norm: normalizeName("Charlie Rice, Nay Barr"), display: "Charlie Rice, Nay Barr" },
			] }),
		}), env as any);
		for (const k of (await env.ENTITIES.list({ prefix: "entity:" })).keys) {
			expect(k.name).not.toContain(",");
		}
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
