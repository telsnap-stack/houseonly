import { describe, it, expect } from "vitest";
import { trackNameFromFilename, nombreDePista } from "../src/lib/track-names.mjs";

describe("nombres de pista", () => {
	it("el humanizador del importer de Mother Tongue, igual que antes", () => {
		expect(trackNameFromFilename("DTW082 A1 Don't Forget Your Hiss.mp3", "DTW082")).toBe("Don't Forget Your Hiss");
		expect(trackNameFromFilename("MT19022- 1-A1 Terra de Luz.mp3", "MT19022")).toBe("Terra de Luz");
		expect(trackNameFromFilename("B2 Something (Snippet).mp3", "X")).toBe("Something");
		expect(trackNameFromFilename("A1. Tinkertoy - Bassalin - CLIP.mp3", "MYD015")).toBe("Tinkertoy - Bassalin");
	});

	it("los nombres reales de prod del 03-11", () => {
		expect(nombreDePista("A1 Truth Like Memory sound clip", "DPPL001", 0)).toBe("Truth Like Memory");
		expect(nombreDePista("B2 Follow sound clip", "DPPL001", 2)).toBe("Follow");
		expect(nombreDePista("DMSR8411", "DMSR8602-1", 0)).toBe("Pista 1");
		expect(nombreDePista("DMSR8412", "DMSR8602-1", 1)).toBe("Pista 2");
		expect(nombreDePista("1", "DMSR8707-1", 0)).toBe("Pista 1");
		expect(nombreDePista("3", "DMSR8707-1", 1)).toBe("Pista 2");
		expect(nombreDePista("CITS007_A1-snippet", "CITS007", 0)).toBe("A1");
		expect(nombreDePista("CITS007_B2-snippet", "CITS007", 3)).toBe("B2");
		expect(nombreDePista("LN017-Sugar - A1 Heaven is a Place In Flint", "LN-017", 0)).toBe("Sugar - A1 Heaven is a Place In Flint");
	});

	it("sin titulo: la cara del fichero, o Pista N si no la trae", () => {
		expect(nombreDePista("XYZ001 Side B 2 snippet", "XYZ001", 3)).toBe("B2");
		expect(nombreDePista("XYZ001-A01", "XYZ001", 0)).toBe("A1");
		expect(nombreDePista("02", "XYZ001", 1)).toBe("Pista 2");
		expect(nombreDePista("A1 Truth Like Memory", "XYZ001", 0)).toBe("Truth Like Memory");
	});
});
