import { describe, it, expect } from "vitest";
import { trackNameFromFilename, nombreDePista, nombreLegible } from "../src/lib/track-names.mjs";

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

	it("DBH: <catno> - <n>. <artista> - <titulo>, de los ZIP reales del 03-11", () => {
		expect(nombreDePista("PLZ014S - 1. Daniel Neighbour - A1. Orcas Chord", "PLZ014S", 0, "Daniel Neighbour")).toBe("Orcas Chord");
		expect(nombreDePista("PLZ014S - 3. Daniel Neighbour - B. Gradien Flow", "PLZ014S", 2, "Daniel Neighbour")).toBe("Gradien Flow");
		expect(nombreDePista("RXP 001 - 2. REX PACIFICATOR - B1 - BluntHead", "RXP 001", 1, "REX PACIFICATOR")).toBe("BluntHead");
		expect(nombreDePista("HWX-07.1 - 1. SHAKA - A1. Groove Therapy", "HWX-07.1", 0, "SHAKA")).toBe("Groove Therapy");
		expect(nombreDePista("ME015 - 1. George Apergis - A1 George Apergis - Psilocybe (Original Mix)", "ME015", 0, "George Apergis")).toBe("Psilocybe (Original Mix)");
		// Sin extension (como se guarda): el punto de "A1." no es una extension.
		expect(nombreDePista("A1. Uno", "TST001", 0)).toBe("Uno");
	});

	it("sin titulo: la cara del fichero, o Pista N si no la trae", () => {
		expect(nombreDePista("XYZ001 Side B 2 snippet", "XYZ001", 3)).toBe("B2");
		expect(nombreDePista("XYZ001-A01", "XYZ001", 0)).toBe("A1");
		expect(nombreDePista("02", "XYZ001", 1)).toBe("Pista 2");
		expect(nombreDePista("A1 Truth Like Memory", "XYZ001", 0)).toBe("Truth Like Memory");
	});

	it("Subwax: nombres UTF-8 leidos como latin1 (acentos descompuestos) y \"(2 min clip)\"", () => {
		// Como los deja fflate cuando el ZIP no marca UTF-8: cada byte, un caracter.
		const latin1 = (t: string) => Array.from(new TextEncoder().encode(t.normalize("NFD")), b => String.fromCharCode(b)).join("");
		expect(nombreDePista(latin1("HEALER003 B2 Squash - Fanta Sí (Baby Rollén Remix) (2 min clip)"), "HEALER003", 3, "Squash"))
			.toBe("Fanta Sí (Baby Rollén Remix)");
		expect(nombreDePista(latin1("ABOUNAIM002 A2. Abou Naïm - Wake Up Bro (Snippet)"), "ABOUNAIM002", 1, "Various")).toBe("Abou Naïm - Wake Up Bro");
		expect(nombreDePista("MID-FLOW01 A1 Sweet Treat (PREVIEW)", "MID-FLOW01", 0, "Unknown Artist")).toBe("Sweet Treat");
		// "A3 . Titulo" (MATHPLUS021).
		expect(nombreDePista("A3 . Whats Going on Inside the Sun", "MATHPLUS021", 2, "Hieroglyphic Being")).toBe("Whats Going on Inside the Sun");
		// Un latin1 de verdad no se toca.
		expect(nombreLegible("Café")).toBe("Café");
	});
});
