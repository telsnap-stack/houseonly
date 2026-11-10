import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { zipSync } from "fflate";
import { bajaZipAR2, indiceZipR2, ficheroZipR2, ZipDemasiado, PARTE_R2_BYTES } from "../src/lib/zip-r2";

const E = env as any;
const flujo = (data: Uint8Array, trozo = 1024 * 1024) => new ReadableStream<Uint8Array>({
	start(c) { for (let o = 0; o < data.length; o += trozo) c.enqueue(data.subarray(o, o + trozo)); c.close(); },
});

describe("zip-r2: ZIP grandes por partes y por rangos", () => {
	it("baja a R2 en varias partes y lee el indice y cada fichero (guardado y deflate)", async () => {
		const grande = new Uint8Array(PARTE_R2_BYTES + 512 * 1024).map((_, i) => i % 251);
		const zip = zipSync({
			"pack/A1 Uno.mp3": [grande, { level: 0 }],          // guardado, mas de una parte
			"pack/B1 Dos.mp3": new Uint8Array(3000).fill(9),     // deflate
			"pack/": new Uint8Array(0),
			"pack/front.jpg": new Uint8Array(100).fill(3),
		});
		const reader = flujo(zip).getReader();
		const primero = await reader.read();
		// Lo ya leido (en memoria) va primero y el resto sigue del lector.
		const bytes = await bajaZipAR2(reader, E.LISTEN_R2, "listen/T/tmp.zip", 50 * 1024 * 1024, [primero.value!]);
		expect(bytes).toBe(zip.length);
		expect((await E.LISTEN_R2.head("listen/T/tmp.zip")).size).toBe(zip.length);

		const idx = await indiceZipR2(E.LISTEN_R2, "listen/T/tmp.zip");
		expect(idx.map(e => [e.name, e.size])).toEqual([["pack/A1 Uno.mp3", grande.length], ["pack/B1 Dos.mp3", 3000], ["pack/front.jpg", 100]]);
		const uno = await ficheroZipR2(E.LISTEN_R2, "listen/T/tmp.zip", idx[0]);
		expect(uno.length).toBe(grande.length);
		expect(uno[12345]).toBe(grande[12345]);
		expect(Array.from(await ficheroZipR2(E.LISTEN_R2, "listen/T/tmp.zip", idx[1]))).toEqual(Array(3000).fill(9));
	});

	it("corta en el tope y no deja nada en R2", async () => {
		const zip = zipSync({ "a.mp3": [new Uint8Array(3 * 1024 * 1024).fill(1), { level: 0 }] });
		await expect(bajaZipAR2(flujo(zip).getReader(), E.LISTEN_R2, "listen/T/x.zip", 1024 * 1024)).rejects.toBeInstanceOf(ZipDemasiado);
		expect(await E.LISTEN_R2.head("listen/T/x.zip")).toBeNull();
	});
});
