/**
 * Ligaduras tipograficas: las que vienen de parsear PDFs de distribuidor.
 *
 * Vive en el worker y lo importa tambien src/App.jsx —Vite resuelve el .ts— para
 * que la regla sea UNA. Los importers son quienes lo usan hoy; el dia que el
 * worker limpie descripciones tendra la misma.
 */

/**
 * Deshace las ligaduras que el PDF trae como UN caracter (U+FB00–U+FB06).
 *
 * Esto no adivina: son equivalencias exactas. Importa hacerlo en el importer y
 * no despues, porque si el caracter viaja hasta Shopify, cualquier paso que no
 * sea UTF-8 limpio lo convierte en "?" y entonces ya no hay vuelta atras: asi
 * aparecio "Ancient In?nity" en el catalogo.
 */
export function normalizeLigatures(text: string): string {
  return String(text || '')
    .replace(/ﬀ/g, 'ff')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi')
    .replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st')
    .replace(/ﬆ/g, 'st');
}

/**
 * Ligadura que ya llego rota, como "In?nity". NO se repara: la informacion se
 * perdio y adivinar estropea texto legitimo — en el catalogo hay "sonic
 * spaceflight?Eternal sunrise", donde el "?" es un signo de interrogacion de
 * verdad al que le falta el espacio detras.
 *
 * Se limita a señalar las palabras sospechosas para que las mire una persona.
 * El patron pide minuscula a los dos lados: "spaceflight?Eternal" lleva
 * mayuscula y queda fuera, que es justo lo que se quiere.
 */
export function suspectLigatureDamage(text: string): string[] {
  const m = String(text || '').match(/[\wÀ-ÿ]*[a-zà-ÿ]\?[a-zà-ÿ][\wÀ-ÿ]*/g) || [];
  return [...new Set(m)];
}
