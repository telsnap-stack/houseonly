import { describe, it, expect } from "vitest";
import { humanizaNombrePista, decodeEntities } from "../src/lib/mt-enrich";

// El nombre de pista bueno es el del array del reproductor de la ficha. Esto
// cubre el respaldo: cuando esa entrada viene sin titulo y hay que deducirlo
// del nombre del fichero.
describe("humanizaNombrePista", () => {
	// EL CASO REAL, pista 9 de MT19025. Trae el numero de pista dos veces, el
	// artista, el sello y la coletilla de recorte.
	it("saca el titulo del fichero real de MT19025", () => {
		expect(humanizaNombrePista(
			"09-9.-Sandra-St.-Victor-Womanizer-Mother-Tongue-records_snippet.mp3",
			"Sandra St. Victor",
			"Mother Tongue Records",
		)).toBe("Womanizer");
	});

	it("tambien si el sello viene sin el 'Records' final", () => {
		expect(humanizaNombrePista(
			"09-9.-Sandra-St.-Victor-Womanizer-Mother-Tongue-records_snippet.mp3",
			"Sandra St. Victor",
			"Mother Tongue",
		)).toBe("Womanizer");
	});

	it("no necesita artista ni sello para lo basico", () => {
		expect(humanizaNombrePista("03-Blue_Hour_snippet.mp3")).toBe("Blue Hour");
	});

	it("no se come un titulo que empieza por cifra", () => {
		// "2-Step-Dub" no lleva cero delante ni punto detras, asi que el 2 es
		// parte del titulo, no un numero de pista.
		expect(humanizaNombrePista("2-Step-Dub.mp3")).toBe("2 Step Dub");
	});

	it("quita el artista solo si va delante", () => {
		// Aqui el artista esta en medio: se queda, porque quitarlo dejaria una
		// frase coja.
		expect(humanizaNombrePista("01-Dub-For-Kaidi-Tatham.mp3", "Kaidi Tatham"))
			.toBe("Dub For Kaidi Tatham");
	});

	it("si de tanto limpiar no queda nada, devuelve el nombre crudo", () => {
		expect(humanizaNombrePista("Mother-Tongue-records.mp3", "", "Mother Tongue Records"))
			.toBe("Mother-Tongue-records");
	});

	it("deja en paz un titulo que ya viene limpio", () => {
		expect(humanizaNombrePista("Ergonomic Structures.mp3")).toBe("Ergonomic Structures");
	});
});

// HTMLRewriter entrega el texto sin decodificar, al reves que DOMParser. Sin
// esto el artista de TLM041 entraria en Shopify como "Jose Rico &#038; Ruben".
describe("decodeEntities", () => {
	it("decodifica numericas y nombradas", () => {
		expect(decodeEntities("Jose Rico &#038; Ruben Valero")).toBe("Jose Rico & Ruben Valero");
		expect(decodeEntities("Chicago&#8217;s finest")).toBe("Chicago’s finest");
		expect(decodeEntities("L&eacute;man Records")).toBe("Léman Records");
	});

	it("deja intacto lo que no es una entidad", () => {
		expect(decodeEntities("A & B")).toBe("A & B");
		expect(decodeEntities("sin entidades")).toBe("sin entidades");
	});
});
