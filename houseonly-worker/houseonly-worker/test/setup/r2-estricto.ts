// R2 de los tests tan estricto como el real con las subidas multipart.
//
// El R2 de miniflare acepta partes de cualquier tamaño, y el real no: menos la
// ultima, todas de al menos 5 MiB y exactamente del mismo tamaño
// (developers.cloudflare.com/r2/objects/multipart-objects). Asi paso la suite
// el fallo de zip-r2 del 2026-11-10 (HG001, GP01... en error 10048 en staging).
// Se envuelven los buckets del env de los tests; el worker que se prueba por
// SELF.fetch tiene su propio env y no pasa por aqui. "cloudflare:test" se
// importa en el beforeAll, no arriba: importarlo en el setup carga los modulos
// del worker antes de los vi.mock de cada spec, y esos mocks dejan de valer.
import { beforeAll } from "vitest";

export const PARTE_MIN_R2 = 5 * 1024 * 1024;

const tamano = (d: any): number | undefined =>
	typeof d === "string" ? new TextEncoder().encode(d).byteLength : d?.byteLength ?? d?.size;

function estricta(u: R2MultipartUpload): R2MultipartUpload {
	const tamanos = new Map<number, number | undefined>();
	return new Proxy(u, {
		get(t, p) {
			if (p === "uploadPart") return (n: number, d: any, o?: any) => { tamanos.set(n, tamano(d)); return t.uploadPart(n, d, o); };
			if (p === "complete") return (partes: R2UploadedPart[]) => {
				const ts = [...partes].sort((a, b) => a.partNumber - b.partNumber).map(x => tamanos.get(x.partNumber));
				const resto = ts.slice(0, -1);
				if (resto.some(x => x !== undefined && x < PARTE_MIN_R2))
					return Promise.reject(new Error("completeMultipartUpload: Your proposed upload is smaller than the minimum allowed object size. (10011)"));
				if (resto.some(x => x !== resto[0]))
					return Promise.reject(new Error("completeMultipartUpload: All non-trailing parts must have the same length. (10048)"));
				return t.complete(partes);
			};
			const v = Reflect.get(t, p);
			return typeof v === "function" ? v.bind(t) : v;
		},
	});
}

beforeAll(async () => {
	const { env } = await import("cloudflare:test");
	for (const nombre of ["R2", "LISTEN_R2"]) {
		const b = (env as any)[nombre] as R2Bucket | undefined;
		if (!b || (b as any).__estricto) continue;
		(env as any)[nombre] = new Proxy(b, {
			get(t, p) {
				if (p === "__estricto") return true;
				if (p === "createMultipartUpload") return async (k: string, o?: any) => estricta(await t.createMultipartUpload(k, o));
				const v = Reflect.get(t, p);
				return typeof v === "function" ? v.bind(t) : v;
			},
		});
	}
});
