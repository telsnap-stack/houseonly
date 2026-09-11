import { describe, it, expect } from "vitest";
import { normalizeLigatures, suspectLigatureDamage } from "../src/lib/ligatures";

describe("normalizeLigatures", () => {
	it("deshace las ligaduras que trae el PDF como un caracter", () => {
		expect(normalizeLigatures("Ancient Inﬁnity Orchestra")).toBe("Ancient Infinity Orchestra");
		expect(normalizeLigatures("Oﬃcial")).toBe("Official");
		expect(normalizeLigatures("Baﬄe")).toBe("Baffle");
		expect(normalizeLigatures("Oﬀ House")).toBe("Off House");
		expect(normalizeLigatures("ﬂoor filler")).toBe("floor filler");
	});

	it("no toca el texto normal", () => {
		const t = "Deep Jungle presents: Infinity — 12\" vinyl, 2026";
		expect(normalizeLigatures(t)).toBe(t);
	});

	it("aguanta vacio y nulo", () => {
		expect(normalizeLigatures("")).toBe("");
		expect(normalizeLigatures(null as any)).toBe("");
	});
});

describe("suspectLigatureDamage", () => {
	it("señala la ligadura ya rota", () => {
		// El caso real del catalogo: gondlp081.
		expect(suspectLigatureDamage("Ancient In?nity Orchestra return")).toEqual(["In?nity"]);
	});

	it("NO señala un signo de interrogacion de verdad", () => {
		// Tambien real: fit007. Reparar esto automaticamente lo estropearia.
		expect(suspectLigatureDamage("are you ready for a sonic spaceflight?Eternal sunrise")).toEqual([]);
		expect(suspectLigatureDamage("Ready? Of course.")).toEqual([]);
	});

	it("no repite la misma palabra dos veces", () => {
		expect(suspectLigatureDamage("in?nity and more in?nity")).toEqual(["in?nity"]);
	});
});
