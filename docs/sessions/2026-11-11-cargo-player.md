# 2026-11-11 — Cargo Player (`/cargo/`)

Player del stock report de Cargo Distribution (UK) para escuchar y armar el
pedido de Telsnap S.L. Sustituye al `Cargo_Player.html` local, que buscaba el
audio desde el navegador (Deezer/Apple por JSONP) y encontraba poco: el report
no trae sello, ni género, ni enlaces de audio, y los códigos de barras de vinilo
casi nunca coinciden con los del digital.

## Qué hay

- **Worker** `src/lib/cargo.ts`
  - `cargo-upload` (POST, Bearer): filas ya parseadas por la página. Solo vinilo
    (`Format = VL`), stock > 0 y estado < 90 (91/92 = borrados). No pisa el
    stock anterior con menos de 20 filas. Guarda `seen` por EAN (marca «nuevo»).
  - `cargo-audio` (GET, Bearer, `&ean=`, `&force=1`): si el disco no está
    resuelto, lo resuelve en el acto (unos segundos) y lo guarda.
  - Resolución por disco:
    1. **Discogs** (`discogsFetch`, mismo proxy y cupo que el sync): barcode →
       catno con título/artista. Da sello completo, géneros/estilos, año,
       portada y los vídeos de YouTube de la release (o del master).
    2. **Deezer** (upc → búsqueda) y **Apple** (upc → búsqueda): previews de
       30 s, copiados enteros a R2 (los de Deezer van firmados y caducan).
    3. **Bandcamp**: búsqueda → página de álbum → `data-tralbum` → stream
       `mp3-128`. Se guarda solo un tramo de cada pista (`Range`, ~1:00–2:30 a
       128 kbps; si la pista es corta, desde el principio). Si Bandcamp sirve el
       «Client Challenge» al worker, queda `tried.bandcamp = "challenge"` y se
       sigue.
    4. Si nada tiene audio: los vídeos de YouTube de Discogs (la página los
       embebe; desde https funcionan, desde file:// daban error 153).
  - R2: `houseonly-audio`, prefijo `cargo/<ean>/<fuente>-<n>.mp3|m4a`, servido
    por r2.dev. Staging y prod comparten bucket y prefijo a propósito.
  - Segundo plano: el cron `41 * * * *` (`LISTEN_CRON`) hace `PASADA_CRON` = 6
    discos por hora: primero los electrónicos sin audio; luego solo metadatos
    de Discogs del resto, y si Discogs dice Electronic se le busca audio en la
    pasada siguiente. «Preparar audio» en la página encadena `cargo-refresh`
    (8 por llamada) hasta acabar o parar.
  - KV `SYNC_STATE`: `cargo:stock`, `cargo:a:<ean>`, `cargo:idx`
    (`ean → [sello, géneros, flag a/y/n/m, electrónico según Discogs]`),
    `cargo:last`.
- **Frontend** `public/cargo/index.html` (estática, fuera del bundle, como
  `/subwax/`): login con el secreto de admin, ExcelJS de cdnjs para leer el
  report, pestañas Electrónica / Novedades / Todo el vinilo, desplegable de
  sellos (de Discogs), búsqueda también por sello y género, «Solo con audio»,
  y pedido en .xlsx con columna Label. Mientras suena un disco resuelve los dos
  siguientes.

## Decisiones

- Electrónica: la criba inicial es la de la versión local (prefijo de catno +
  artistas), pero en cuanto Discogs responde por un disco manda Discogs.
- Precios en GBP tal como vienen (columna «Export dealer price»); sin precio
  se muestran y no suman.
- Coste R2 (tarifa oficial, nov 2026): 0,015 $/GB-mes por encima de 10 GB
  gratis; escrituras 4,50 $/millón con 1 M gratis; salida gratis. ~1.000
  electrónicos × ~5 MB ≈ 5 GB → del orden de céntimos al mes en el peor caso.

## Pendiente de verificar en staging

- Que Bandcamp deje pasar al worker (si da `challenge` en todos, queda
  Deezer/Apple/YouTube).
- Hit rate real con el report del 11-11 tras una tanda de «Preparar audio».
