import { describe, it, expect } from "vitest";
import { pesoDesdeDiscogs, pesoDesdeTexto, gramosDesdeFormato, describirPeso, tramo } from "../src/lib/vinyl-weight.mjs";

describe("pesoDesdeDiscogs (formats del release)", () => {
	it("12\" suelto: 0,15 + 0,30 = 0,45", () => {
		expect(pesoDesdeDiscogs([{ name: "Vinyl", qty: "1", descriptions: ['12"', "33 ⅓ RPM", "EP"] }])?.kg).toBe(0.45);
	});
	it("2LP y 3LP", () => {
		expect(pesoDesdeDiscogs([{ name: "Vinyl", qty: "2", descriptions: ["LP", "Album"] }])?.kg).toBe(0.75);
		expect(pesoDesdeDiscogs([{ name: "Vinyl", qty: "3", descriptions: ["LP", "Album"] }])?.kg).toBe(1.05);
	});
	it("7\" y 10\" (un 10\" LP cuenta como 10\")", () => {
		expect(pesoDesdeDiscogs([{ name: "Vinyl", qty: "1", descriptions: ['7"', "45 RPM", "Single"] }])?.kg).toBe(0.23);
		expect(pesoDesdeDiscogs([{ name: "Vinyl", qty: "1", descriptions: ['10"', "LP"] }])?.kg).toBe(0.35);
	});
	it("box set: +0,20; varios formatos de vinilo se suman; CD e insertos no cuentan", () => {
		const r = pesoDesdeDiscogs([
			{ name: "Box Set", qty: "1", descriptions: ["Limited Edition"] },
			{ name: "Vinyl", qty: "4", descriptions: ["LP", "Album"] },
			{ name: "Vinyl", qty: "1", descriptions: ['7"'] },
			{ name: "CD", qty: "2", descriptions: ["Album"] },
			{ name: "All Media", qty: "1", descriptions: ["Insert"] },
		]);
		expect(r?.kg).toBe(1.63);            // 0,15 + 4×0,30 + 0,08 + 0,20
		expect(r?.discos).toBe(5);
		expect(describirPeso(r)).toBe('4×12" + 1×7" + box');
	});
	it("'Box Set' dentro de descriptions tambien cuenta", () => {
		expect(pesoDesdeDiscogs([{ name: "Vinyl", qty: "3", descriptions: ["LP", "Box Set"] }])?.kg).toBe(1.25);
	});
	it("sin vinilo (solo CD o cassette) o sin formats: null, no se toca", () => {
		expect(pesoDesdeDiscogs([{ name: "CD", qty: "1", descriptions: ["Album"] }])).toBeNull();
		expect(pesoDesdeDiscogs([{ name: "Cassette", qty: "1" }])).toBeNull();
		expect(pesoDesdeDiscogs(undefined)).toBeNull();
	});
	it("vinilo sin tamano: se cuenta como 12\" y queda marcado", () => {
		const r = pesoDesdeDiscogs([{ name: "Vinyl", qty: "1", descriptions: ["45 RPM"] }]);
		expect(r?.kg).toBe(0.45);
		expect(describirPeso(r)).toBe('1×12"?');
	});
});

describe("pesoDesdeTexto (importers)", () => {
	it('"2x 12\\"LP" -> 0,75', () => expect(pesoDesdeTexto('2x 12"LP').kg).toBe(0.75));
	it('"3LP" -> 1,05', () => expect(pesoDesdeTexto("3LP").kg).toBe(1.05));
	it('"LP" -> 0,45', () => expect(pesoDesdeTexto("LP").kg).toBe(0.45));
	it('"12\\"" -> 0,45', () => expect(pesoDesdeTexto('12"').kg).toBe(0.45));
	it("sin formato -> 0,45 por defecto", () => {
		const r = pesoDesdeTexto("", "Black Magic EP");
		expect(r.kg).toBe(0.45);
		expect(r.origen).toBe("defecto");
	});
	it("otras formas habituales", () => {
		expect(pesoDesdeTexto("2xLP").kg).toBe(0.75);
		expect(pesoDesdeTexto("2 x 12\"").kg).toBe(0.75);
		expect(pesoDesdeTexto("Double LP").kg).toBe(0.75);
		expect(pesoDesdeTexto("3x12 inch").kg).toBe(1.05);
		expect(pesoDesdeTexto("Triple Vinyl").kg).toBe(1.05);
		expect(pesoDesdeTexto('7"').kg).toBe(0.23);
		expect(pesoDesdeTexto("10 inch").kg).toBe(0.35);
		expect(pesoDesdeTexto("4LP Box Set").kg).toBe(1.55);
		expect(pesoDesdeTexto("12″ single").kg).toBe(0.45);   // comillas tipograficas
	});
	it("un numero de catalogo con cifras no se toma por discos", () => {
		expect(pesoDesdeTexto("", "Remixes Vol. 2").kg).toBe(0.45);
		expect(pesoDesdeTexto("", "FAT072").kg).toBe(0.45);
	});
	it("gramos para el CSV", () => {
		expect(gramosDesdeFormato('2x 12"LP')).toBe("750");
		expect(gramosDesdeFormato("", "")).toBe("450");
	});
});

describe("ningun peso cae en 0,90 exacto (borde de tramo)", () => {
	it("hasta 6 discos de cada tamano, con y sin box: nunca 0,90", () => {
		for (let a = 0; a <= 6; a++) for (let b = 0; b <= 6; b++) for (let c = 0; c <= 6; c++) for (const box of [false, true]) {
			if (!a && !b && !c) continue;
			const formats = [
				...(a ? [{ name: "Vinyl", qty: String(a), descriptions: ["LP"] }] : []),
				...(b ? [{ name: "Vinyl", qty: String(b), descriptions: ['10"'] }] : []),
				...(c ? [{ name: "Vinyl", qty: String(c), descriptions: ['7"'] }] : []),
				...(box ? [{ name: "Box Set", qty: "1" }] : []),
			];
			expect(pesoDesdeDiscogs(formats)?.kg).not.toBe(0.9);
		}
	});
});

describe("tramo", () => {
	it("cortes de los tramos de envio", () => {
		expect(tramo(0.45)).toBe("≤0,5");
		expect(tramo(0.5)).toBe("≤0,5");
		expect(tramo(0.75)).toBe("0,5–0,9");
		expect(tramo(0.9)).toBe("0,5–0,9");
		expect(tramo(1.05)).toBe("0,9–2");
	});
});
