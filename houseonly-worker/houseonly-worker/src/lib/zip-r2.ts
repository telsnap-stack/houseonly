// ZIP grandes sin tenerlos en memoria (bandeja de escucha, 2026-11-10).
//
// Un isolate tiene 128 MB: un promopack de 100 MB no cabe leido entero y
// descomprimido a la vez (HG001, 103 MB; GP01, 100 MB). Aqui el ZIP se escribe
// en R2 por partes mientras baja (multipart), y despues se lee por rangos: el
// directorio central del final del fichero y, de uno en uno, cada fichero que
// interese. Lo maximo en memoria es una parte (8 MB) o un fichero.

import { inflateSync } from 'fflate';

// R2 pide partes de al menos 5 MiB (menos la ultima).
export const PARTE_R2_BYTES = 8 * 1024 * 1024;

export class ZipDemasiado extends Error {}

export interface EntradaZip { name: string; size: number; comprimido: number; metodo: number; offset: number }

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

/**
 * Lo que queda de `reader` a R2 en `key`, por partes, precedido de `inicio` (lo
 * ya leido), cortando si el total pasa de `tope`. Devuelve los bytes escritos.
 * Si falla, la subida a medias se aborta.
 */
export async function bajaZipAR2(reader: ReadableStreamDefaultReader<Uint8Array>, bucket: R2Bucket, key: string, tope: number, inicio: Uint8Array[] = []): Promise<number> {
  const subida = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: 'application/zip' } });
  const partes: R2UploadedPart[] = [];
  let pendiente: Uint8Array[] = [], enPendiente = 0, total = 0;
  const vuelca = async () => {
    const parte = new Uint8Array(enPendiente);
    let o = 0;
    for (const t of pendiente) { parte.set(t, o); o += t.byteLength; }
    partes.push(await subida.uploadPart(partes.length + 1, parte));
    pendiente = []; enPendiente = 0;
  };
  const anade = async (t: Uint8Array) => {
    total += t.byteLength;
    if (total > tope) throw new ZipDemasiado(`más de ${Math.round(tope / 1048576)} MB`);
    pendiente.push(t); enPendiente += t.byteLength;
    if (enPendiente >= PARTE_R2_BYTES) await vuelca();
  };
  try {
    for (const t of inicio) await anade(t);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await anade(value);
      }
    } catch (e) { await reader.cancel().catch(() => {}); throw e; }
    if (enPendiente || !partes.length) await vuelca();
    await subida.complete(partes);
    return total;
  } catch (e) {
    await subida.abort().catch(() => {});
    throw e;
  }
}

async function rango(bucket: R2Bucket, key: string, offset: number, length: number): Promise<Uint8Array> {
  const obj = await bucket.get(key, { range: { offset, length } });
  if (!obj) throw new Error(`ZIP: no está ${key}`);
  return new Uint8Array(await obj.arrayBuffer());
}

/** El directorio central del ZIP guardado en R2 (ZIP64 incluido). */
export async function indiceZipR2(bucket: R2Bucket, key: string): Promise<EntradaZip[]> {
  const head = await bucket.head(key);
  if (!head) throw new Error(`ZIP: no está ${key}`);
  const size = head.size;
  // Fin del directorio central: 22 bytes + comentario de hasta 64 KB.
  const cola = Math.min(size, 22 + 65535 + 20);
  const fin = await rango(bucket, key, size - cola, cola);
  let eocd = -1;
  for (let i = fin.length - 22; i >= 0; i--) if (u32(fin, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('no es un ZIP valido (sin directorio central)');
  let entradas = u16(fin, eocd + 10), tamCd = u32(fin, eocd + 12), offCd = u32(fin, eocd + 16);
  if (entradas === 0xffff || tamCd === 0xffffffff || offCd === 0xffffffff) {
    // ZIP64: el localizador va justo antes del fin de directorio.
    const loc = eocd - 20;
    if (loc < 0 || u32(fin, loc) !== 0x07064b50) throw new Error('ZIP64 sin localizador');
    const off64 = u64(fin, loc + 8);
    const z64 = await rango(bucket, key, off64, 56);
    if (u32(z64, 0) !== 0x06064b50) throw new Error('ZIP64 roto');
    entradas = u64(z64, 32); tamCd = u64(z64, 40); offCd = u64(z64, 48);
  }
  const cd = await rango(bucket, key, offCd, tamCd);
  const td = new TextDecoder();
  const out: EntradaZip[] = [];
  let p = 0;
  for (let n = 0; n < entradas && p + 46 <= cd.length; n++) {
    if (u32(cd, p) !== 0x02014b50) throw new Error('directorio central roto');
    const metodo = u16(cd, p + 10);
    let comprimido = u32(cd, p + 20), tam = u32(cd, p + 24);
    const lNom = u16(cd, p + 28), lExtra = u16(cd, p + 30), lCom = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const name = td.decode(cd.subarray(p + 46, p + 46 + lNom));
    // ZIP64 extra (0x0001): solo trae los campos que valen 0xFFFFFFFF, en este orden.
    let e = p + 46 + lNom;
    const finExtra = e + lExtra;
    while (e + 4 <= finExtra) {
      const id = u16(cd, e), len = u16(cd, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (tam === 0xffffffff) { tam = u64(cd, q); q += 8; }
        if (comprimido === 0xffffffff) { comprimido = u64(cd, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(cd, q); }
      }
      e += 4 + len;
    }
    if (!name.endsWith('/')) out.push({ name, size: tam, comprimido, metodo, offset });
    p += 46 + lNom + lExtra + lCom;
  }
  return out;
}

/** Un fichero del ZIP guardado en R2: su cabecera local y sus datos, por rangos. */
export async function ficheroZipR2(bucket: R2Bucket, key: string, e: EntradaZip): Promise<Uint8Array> {
  const cab = await rango(bucket, key, e.offset, 30);
  if (u32(cab, 0) !== 0x04034b50) throw new Error(`${e.name}: cabecera local rota`);
  const desde = e.offset + 30 + u16(cab, 26) + u16(cab, 28);
  const datos = e.comprimido ? await rango(bucket, key, desde, e.comprimido) : new Uint8Array(0);
  if (e.metodo === 0) return datos;
  if (e.metodo === 8) return inflateSync(datos);
  throw new Error(`${e.name}: compresión ${e.metodo} no soportada`);
}
