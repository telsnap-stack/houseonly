import { describe, it, expect } from "vitest";
import {
	ENTITY_MF_NAMESPACE,
	ENTITY_MF_KEYS,
	ENTITY_MF_DEFINITIONS,
	definitionFor,
	joinSlugs,
	parseSlugs,
	csvHeader,
	sameSlugs,
	isDefinitionTaken,
} from "../src/lib/entity-metafields";

describe("nombres de los metafields", () => {
	it("son plurales los dos, en el namespace houseonly", () => {
		expect(ENTITY_MF_NAMESPACE).toBe("houseonly");
		expect(ENTITY_MF_KEYS).toEqual({ artist: "artist_slugs", label: "label_slugs" });
	});

	it("la cabecera del CSV lleva el formato que Shopify sabe importar", () => {
		expect(csvHeader("artist")).toBe("Artist entities (product.metafields.houseonly.artist_slugs)");
		expect(csvHeader("label")).toBe("Label entities (product.metafields.houseonly.label_slugs)");
		// `Nombre (product.metafields.{namespace}.{key})`, tal cual lo documenta Shopify.
		for (const kind of ["artist", "label"] as const) {
			expect(csvHeader(kind)).toMatch(/^.+ \(product\.metafields\.[a-z0-9_-]+\.[a-z0-9_-]+\)$/);
		}
	});

	it("el nombre de la cabecera es el mismo que el de la definicion", () => {
		for (const kind of ["artist", "label"] as const) {
			expect(csvHeader(kind).startsWith(definitionFor(kind).name + " (")).toBe(true);
		}
	});
});

describe("definiciones", () => {
	it("son dos, de producto, texto de una linea", () => {
		expect(ENTITY_MF_DEFINITIONS).toHaveLength(2);
		for (const d of ENTITY_MF_DEFINITIONS) {
			expect(d.ownerType).toBe("PRODUCT");
			// list.single_line_text_field NO se importa por CSV: por eso texto simple
			// con los slugs separados por coma.
			expect(d.type).toBe("single_line_text_field");
			expect(d.namespace).toBe("houseonly");
		}
	});

	it("la tienda puede leerlas — sin esto el feed de la fase 5 se queda ciego", () => {
		for (const d of ENTITY_MF_DEFINITIONS) expect(d.access.storefront).toBe("PUBLIC_READ");
	});

	it("son filtrables en el admin y estan fijadas", () => {
		for (const d of ENTITY_MF_DEFINITIONS) {
			expect(d.capabilities.adminFilterable.enabled).toBe(true);
			expect(d.pin).toBe(true);
		}
	});

	it("las claves caben en el limite de Shopify (2-64) y el namespace en 3-255", () => {
		for (const d of ENTITY_MF_DEFINITIONS) {
			expect(d.key).toMatch(/^[a-z0-9_-]{2,64}$/);
			expect(d.namespace).toMatch(/^[a-z0-9_-]{3,255}$/);
		}
	});
});

describe("joinSlugs / parseSlugs", () => {
	it("une por coma respetando el orden: el primero es el artista principal", () => {
		expect(joinSlugs(["delano-smith", "brian-kage"])).toBe("delano-smith,brian-kage");
	});

	it("quita vacios, espacios y repetidos", () => {
		expect(joinSlugs([" dj-koze ", "", null, undefined, "dj-koze"])).toBe("dj-koze");
		expect(joinSlugs([])).toBe("");
	});

	it("parsea tolerando espacios alrededor de la coma", () => {
		expect(parseSlugs("delano-smith, brian-kage")).toEqual(["delano-smith", "brian-kage"]);
		expect(parseSlugs("")).toEqual([]);
		expect(parseSlugs(null)).toEqual([]);
		expect(parseSlugs("a,,b,")).toEqual(["a", "b"]);
	});

	it("ida y vuelta", () => {
		const slugs = ["chaos-in-the-cbd", "freerange-records"];
		expect(parseSlugs(joinSlugs(slugs))).toEqual(slugs);
	});
});

describe("sameSlugs — lo que hara el backfill para no reescribir", () => {
	it("ignora espacios y repetidos, pero NO el orden", () => {
		expect(sameSlugs(["a", "b"], [" a ", "b", "b"])).toBe(true);
		expect(sameSlugs(["a", "b"], ["b", "a"])).toBe(false);
	});

	it("vacio contra vacio es igual", () => {
		expect(sameSlugs([], [""])).toBe(true);
	});
});

describe("isDefinitionTaken", () => {
	it("una definicion que ya existe no es un fallo", () => {
		expect(isDefinitionTaken([{ code: "TAKEN", message: "Key has already been taken" }])).toBe(true);
		expect(isDefinitionTaken([{ code: null, message: "Key has already been taken" }])).toBe(true);
	});

	it("cualquier otro error si lo es", () => {
		expect(isDefinitionTaken([{ code: "INVALID_TYPE", message: "no" }])).toBe(false);
		// Si viene mezclado con uno de verdad, no se traga ninguno.
		expect(isDefinitionTaken([
			{ code: "TAKEN", message: "taken" },
			{ code: "INVALID_OPTION", message: "no" },
		])).toBe(false);
		expect(isDefinitionTaken([])).toBe(false);
		expect(isDefinitionTaken(null)).toBe(false);
	});
});
