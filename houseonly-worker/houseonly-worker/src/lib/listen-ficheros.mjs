// Que se guarda de un promopack: compartido por la ingesta y listen-upload
// (worker, listen.ts) y por la "descarga manual" del admin (src/App.jsx), que
// abre el ZIP en el navegador y sube los ficheros elegidos de uno en uno. Asi
// los dos lados eligen lo mismo.

export const TEXTO_MAX_BYTES = 256 * 1024;
export const PDF_MAX_BYTES = 2 * 1024 * 1024;
// Tope por fichero en la subida por partes. Cloudflare corta cualquier peticion
// de mas de 100 MB (sin cabeceras CORS: el navegador solo ve un fallo de red);
// 45 MB deja margen y cabe de sobra en la memoria del worker.
export const PARTE_MAX_BYTES = 45 * 1024 * 1024;

export const base = n => n.split('/').pop() || n;
export const esBasura = n => /(^|\/)__MACOSX\//.test(n) || base(n).startsWith('._');
export const esMp3 = n => /\.mp3$/i.test(n) && !esBasura(n);
// Solo JPG: los PNG de los promopacks son las galletas (LN-017), no la funda.
export const esJpg = n => /\.jpe?g$/i.test(n) && !esBasura(n);

export const orden = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Lo que se guarda de un promopack: MP3 en orden natural y la portada mejor candidata. */
export function eligeFicheros(lista) {
  const mp3 = lista.filter(f => esMp3(f.name)).map(f => f.name).sort(orden.compare);
  const jpgs = lista.filter(f => esJpg(f.name));
  // La trasera nunca es la portada (DBH trae {CATNO}_cover.jpg y {CATNO}_cover_back.jpg).
  const trasera = f => /back/i.test(base(f.name));
  // Subwax: {CATNO}_A / _B y {CATNO}_1_Front / _2_Back; la A (o la 1) es la frontal.
  const frontal = f => /front|cover|sleeve/i.test(base(f.name)) || /[_\s-](A|1)(?=[_\s.-])/.test(base(f.name));
  const preferida = jpgs.find(f => frontal(f) && !trasera(f));
  const portada = preferida?.name || jpgs.sort((a, b) => Number(trasera(a)) - Number(trasera(b)) || b.size - a.size)[0]?.name || null;
  // Los mismos que lee el Process del tab: TV {CATNO}_promotext.txt, DBH {CATNO}_info.txt (o un .txt),
  // W&S/Rubadub SALESPAPER.pdf (o un .pdf). Si pesan demasiado, no.
  const txts = lista.filter(f => /\.txt$/i.test(f.name) && !esBasura(f.name) && f.size <= TEXTO_MAX_BYTES);
  const pdfs = lista.filter(f => /\.pdf$/i.test(f.name) && !esBasura(f.name) && f.size <= PDF_MAX_BYTES);
  // Subwax: "{CATNO} info.txt", con espacio.
  const promotext = (txts.find(f => /[_\s](promotext|info)\.txt$/i.test(f.name)) || txts[0])?.name || null;
  const salespaper = (pdfs.find(f => /SALESPAPER\.pdf$/i.test(f.name)) || pdfs[0])?.name || null;
  return { mp3, portada, promotext, salespaper };
}
