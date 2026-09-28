# MT (Mother Tongue) import flow

Actualizado el 2026-09-28. Referencias con `fichero:línea` sobre la rama
`claude/genero-garage`.

## La cadena, hoy: un solo eslabón

```
factura PDF  →  tab MT del admin  →  CSV de Shopify
                      ↓
              Worker ?action=mt-enrich   (fichas de mothertonguerecords.com)
              Worker ?action=mirror       (portadas → R2)
              Worker ?action=mirror-audio (snippets → R2)
```

No hace falta nada más. Se suelta la factura, se pulsa procesar y sale el CSV
con artista, título, sello, formato, géneros, portada y audio.

Hasta el 2026-09-28 la cadena tenía cuatro eslabones y tres de ellos eran a
mano: pegar un scraper en la consola de Chrome, montar un «listener» HTML
cruzando su JSON con la factura, y volcar ese listener en el tab. Queda escrito
abajo porque explica por qué el código tiene la forma que tiene, y porque el
listener sigue aceptándose.

### Entradas opcionales

Las dos siguen funcionando y las dos **sobreescriben**:

- **Listener HTML.** Pisa campo a campo lo que trajo la ficha web, pero solo
  con lo que traiga con valor (`conValor`, `src/App.jsx`): un listener al que le
  falte el sello no puede borrar el que ya vino de la web.
- **Carpeta del distribuidor.** Si trae audio para un catno, manda sobre los
  snippets de la web: entonces son los ficheros que mandó el sello. MT no manda
  promopacks, así que en la práctica casi nunca se usa.

## Los dos endpoints del Worker

### `?action=mt-enrich&catnos=A,B,C`

GET, Bearer de admin (`BOOTSTRAP_AUTH_SECRET`, el mismo de `mirror` y `upload`
— no hay token nuevo). Máximo **10 catnos por llamada**; el front trocea de 8 en
8 con pausa. Implementación en
`houseonly-worker/houseonly-worker/src/lib/mt-enrich.ts`.

Existe porque el navegador **no puede** leer mothertonguerecords.com: esa web no
manda CORS ni en las páginas ni en su Store API. El Worker sí, porque `fetch()`
en el edge no pasa por CORS — el mismo motivo por el que ya existía `mirror`.

Resolución del catno, sin adivinar nunca:

1. Store API de WooCommerce, `?search=CATNO`. El `sku` de esa tienda **es** el
   catalog number, así que se empareja por SKU y no por ranking de texto.
   Preferencia: idéntico → normalizado → prefijo único. Si quedan varios
   candidatos se reporta como ambiguo y no se elige.
2. Si la búsqueda no da con él, se barre el catálogo entero (~700 referencias,
   7 peticiones) una sola vez por invocación y se empareja el SKU en local.

Extractores, todos sobre marcado estructurado:

| Campo | De dónde |
|---|---|
| `artist` | `h1.product_title` — en esta tienda el `h1` es el **artista** |
| `title` | `p.mt-product-subheading` |
| `label` | `p.mt-product-label` |
| `format_hint` | fila «Format» de `div.mt-product-meta` |
| `released` | fila «Released» de `div.mt-product-meta` |
| `catno_web` | fila «Catalog No.», para cotejar con la factura |
| `genres` | `a[rel="tag"]` que apunten a `/product-category/` |
| `cover` / `description` | `og:image` / `og:description` |
| `tracks` | el array `new Player([{title, file}, …])` que imprime la página |

**Aquí no hay `DOMParser`.** Los Workers traen HTMLRewriter, que es un parser en
streaming: no da `textContent` ni deja mirar hacia atrás. Cada campo se acumula
por eventos y el orden del documento hace de estado. Dos consecuencias que
costaron encontrar:

- HTMLRewriter puede partir un mismo nodo de texto en varios trozos según llegan
  por el cable, así que se concatena y se cierra al final, nunca en el primero.
- HTMLRewriter **no decodifica entidades** y `DOMParser` sí. Sin `decodeEntities`
  el artista de TLM041 entraría en Shopify como `Jose Rico &#038; Ruben Valero`.

### `?action=mirror-audio`

POST, Bearer de admin. Es `mirror` con `audio/*` y tope de 20 MB en vez de 10:
los snippets de algunos sellos son la pista entera y pasan de 6 MB. Comparten
implementación (`handleMirrorGeneric`) para que el allowlist de hosts, el
saneado de clave y el timeout no puedan divergir entre portadas y audio.

Los bytes del audio **nunca pasan por el navegador**: van de
mothertonguerecords.com a R2 por el edge.

## Validación (2026-09-28, factura 962 completa)

Con el worker corriendo en local (`wrangler dev`) para no escribir 88 objetos en
el bucket real, que staging comparte con producción:

- **16/16** referencias resueltas, todas por `api:sku-exacto`, 0 fallos.
- **88/88** pistas espejadas, **0 sin nombre**.
- **16/16** con portada; 15/16 con género.
- Los tres dobles (`FUTLP011`, `MBH001/002`, `SR004`) a **900 g**; el resto a 500.
- `MBH001/002` entra bien: su clave en R2 se sanea a `audio/MBH001-002/…` y el
  nombre de pista ya no pasa por la regex que se rompía con la barra.

`MAKINEP022` sale **sin género** y es correcto: su única categoría en la web es
«What's New», que D4 filtra por operativa. Es un hueco de origen, no del
importer.

Antes, contra el HTML guardado de tres productos reales, se comprobó que el
puerto a HTMLRewriter da el **mismo resultado** que el `DOMParser` de v4: mismas
88 URLs de audio y descripciones idénticas salvo espacios repetidos, que aquí se
colapsan.

## `scripts/mt_scraper_v4.js` — herramienta de diagnóstico

Ya **no hace falta para importar**. Se queda porque sigue siendo la forma más
rápida de ver qué está publicando MT sin tocar el admin ni el Worker: se pega en
la consola de Chrome estando en mothertonguerecords.com, se le edita el array
`CATNOS` de la cabecera y descarga `mt_enrichment_v4_AAAA-MM-DD.json`.

Sirve sobre todo para dos cosas:

- **Comparar** lo que devuelve `mt-enrich` con lo que ve un navegador de verdad,
  si algún día sospechamos que HTMLRewriter se está dejando algo.
- **Ver un catno que falla** sin pasar por el importer entero.

Su cascada de resolución y sus extractores son los mismos que se portaron al
Worker, así que una discrepancia entre los dos es señal de que el tema de la web
ha cambiado. Los scrapers viejos (`scripts/mt/mt_scraper_v2_with_genres.js` y
`mt_scraper_v3_1_patch.js`) siguen ahí como referencia histórica; no usarlos.

## El listener HTML: qué es y qué contrato cumple (entrada opcional)

`parseListenerHTML` (`src/App.jsx:5717`) hace exactamente esto:

1. Lee el fichero como texto.
2. Extrae con regex `const RELEASES = ([...]);` — literalmente
   `/const\s+RELEASES\s*=\s*(\[[\s\S]*?\]);/`.
3. `JSON.parse` de ese array. Si no aparece el array → «Could not find RELEASES
   array in HTML file»; si no parsea → «RELEASES JSON parse failed».
4. Indexa por **catno normalizado** (`normCatno`, `src/App.jsx:5561`: mayúsculas
   + solo `A-Z0-9`, así `MT-NERO-002` → `MTNERO002`).
5. Ante catnos duplicados gana el registro con más datos, por un `score`:
   `cover` vale 4, `tracks.length` 2, `description` 1, `genres.length` 1.

De ahí salen los campos que el importer lee después. Ojo: solo tres de ellos
(`description`, `genres`, `cover`) los produce el scraper tal cual; el resto se
añade en el montaje del listener, cruzando con la factura.

| Campo | Uso en el importer |
|---|---|
| `cat` | clave de indexado (normalizada) |
| `artist` | `Vendor` |
| `title` | `Title` |
| `label` | tag `label:…` y sustituto de artista en V.A. |
| `fmt_norm` / `format` | deriva `Variant Grams` |
| `description` | cuerpo de la ficha |
| `genres[]` | tags de género (D4) |
| `cover` | URL de portada de respaldo en mothertonguerecords.com |
| `tracks[]` | solo cuenta para el `score` de desempate |

Como el parser no exige un HTML válido —solo que exista esa asignación en el
texto— el fichero del listener es en la práctica **un reproductor HTML con el
catálogo embebido como JSON**, y el importer lo trata como si fuera un `.json`.

El origen de los datos sí se deja ver: las categorías son de **WooCommerce**
(`src/App.jsx:5979`, D4 filtra «What's New», «Distribution (Wholesale)», «We
Dig», «International»…) y las portadas siguen patrones de slug de **WordPress**
(`-sideA-`, `sideA-scaled`, `src/App.jsx:5852`) — coherente con lo que hace el
scraper, que recorre la tienda WooCommerce de mothertonguerecords.com producto
a producto.

## El flujo completo, paso a paso

Todo ocurre en el navegador, en el panel admin, pestaña `mt`
(`src/App.jsx:12311` → `<MotherTongueImporter />`, definido en
`src/App.jsx:5543`). Tres entradas, un CSV de salida.

### 1. Entradas (arrastrar o botón)

La zona de drop clasifica por extensión: `.pdf` → factura, `.html`/`.htm` →
listener, y `zip|jpe?g|png|webp|mp3|wav|flac|aac|ogg|m4a` → carpeta de assets.
El botón de carpeta usa `webkitdirectory`. **Solo el PDF es obligatorio**; los
otros dos botones dicen «(opcional)».

### 2. Factura PDF → `[{catno, qty, dealerPrice}]`

`parseInvoicePDF` (`src/App.jsx:5587`), con pdf.js cargado en caliente
(`loadPDFJS`, `src/App.jsx:3112`):

- Reconstruye líneas agrupando los items de texto por Y redondeada a múltiplos
  de 4 px, ordenando por X e insertando espacio cuando el hueco supera 1.0.
- Descarta cabeceras/pies con `SKIP_PATTERNS` (`src/App.jsx:5620`): datos de
  Mother Tongue srl, IBAN, IVA, «Decreto legge…», etc.
- Por cada línea candidata saca el catno con `/^([A-Za-z0-9][A-Za-z0-9._\-]{2,29})/`
  y exige que el último número de la línea sea `0` (el marcador de % IVA) —
  esto es lo que evita que el texto legal cuele como artículo.
- Dos caminos:
  - **Sin descuento**: `qty` es el último entero 1–99 *antes* del primer precio
    con `€`; `dealerPrice` es ese primer precio. (Se busca antes del `€` a
    propósito, para no comerse números del título como «(2024 Reissue)».)
  - **Con descuento** (`\d{1,2}%` en la línea): `qty` es el entero justo antes
    del porcentaje, y el precio unitario rebajado se busca en una línea
    *hermana* a ±20 px de Y, identificándolo por tener 3 decimales (`7.911`).
- Se queda solo con filas donde `qty` y `dealerPrice` son > 0 y `qty < 100`.

### 3. Fichas web → `fichasMT` (y listener opcional → `releaseMeta`)

Lo normal: `process()` llama a `pedirFichasMT` (`src/App.jsx:5477`), que pide
`?action=mt-enrich` en tandas de 8 con 400 ms de pausa y guarda el mapa
`catnoNorm → ficha`. Se piden **antes** del bucle: mezclarlas dentro convertiría
una petición por tanda en una por disco. Al cargar otra factura se limpian, o
los discos nuevos saldrían con los metadatos de la anterior y sin avisar.

Si además se suelta un listener, `onHtml` (`src/App.jsx:6022`) llama a
`parseListenerHTML` y ese mapa **pisa** la ficha web campo a campo — solo en los
campos que traiga con valor (`conValor`, `src/App.jsx:5504`).

### 4. Carpeta del distribuidor → índice de assets

`onFolder` (`src/App.jsx:6035`):

- Si hay `.zip`, `expandZips` (`src/App.jsx:3068`) los abre con JSZip y saca
  solo imágenes y audio. Cada fichero extraído lleva `_relpath` con el nombre
  del zip por delante y `_zipBase` para agruparlo con sus hermanos. Se ignoran
  `__MACOSX/`, `._*` y `.DS_Store`.
- `buildFolderIndex` (`src/App.jsx:5748`), en un `useEffect` que depende de
  `folderFiles` e `invoiceItems` (`src/App.jsx:6061`), asigna cada fichero a un
  catno **por subcadena**, probando los catnos conocidos de más largo a más
  corto. Así `TLM041_promopack.zip` o `01 - CAT-016 - The Soul Pops.mp3`
  resuelven sin renombrar nada.
- Los ficheros salidos de un zip se resuelven **en grupo**: se juntan como
  evidencia el nombre del zip y el de todas sus entradas, y un único nombre con
  catno (normalmente la portada) fija el catno de todas las pistas del zip
  aunque el zip se llame con un hash. Si no resuelve, avisa por `console.warn`.

**MT no envía promopacks; la carpeta de assets se construye descargando
`tracks[].url` del JSON del scraper.** A diferencia de Triple Vision o Rubadub,
Mother Tongue no manda un zip por release: los snippets viven en su web y el
scraper ya los recoge. Hoy la carpeta se arma a mano bajando esas URLs. Es un
candidato claro a botón del propio tab `mt`, como el de Rubadub.

#### Cómo nombrar los ficheros al bajarlos

Una subcarpeta por catno y el número de orden con **dos dígitos** delante:

```
mt-962/
  SR003/01 - Been Robbed.mp3
  FUTLP011/01 - Running (Marc Rapson Remix).mp3
  …
  FUTLP011/20 - I Warned You (Electric Conversation Remix).mp3
```

No es capricho: probado el 2026-09-28 contra `orderAudio` y
`trackNameFromFilename` con las 88 pistas de la factura 962, los esquemas
planos fallan y este no.

| Esquema | Orden | Nombre visible |
|---|---|---|
| `{catno} - {n} - {título}.mp3` | 14/16 releases | 82/88 pistas |
| `{catno} - {nn} - {título}.mp3` | 16/16 | 82/88 |
| `{catno}/{nn} - {título}.mp3` | **16/16** | **88/88** |

Los dos fallos que corrige:

- **Sin cero a la izquierda el orden se rompe a partir de 10 pistas.** Ningún
  patrón de `orderAudio` casa con un nombre que empieza por el catno, así que
  cae al desempate alfabético y `10` va antes que `2`. Con la factura 962 eso
  descolocaba `FUTLP011` (20 pistas) y `SR004` (13).
- **Un catno con barra rompe el nombre visible.** `trackNameFromFilename`
  construye su regex con el catno de la factura (`MBH001/002`), pero el fichero
  no puede llevar `/` y en disco es `MBH001-002`: el prefijo no casa y se queda
  dentro del nombre de pista («MBH001-002 - 01 - Antheme»). Con el catno en la
  carpeta y no en el fichero, el problema desaparece.

Con subcarpeta, `orderAudio` sí engancha (`/^(\d+)[.\s_-]/` → ordena por
número, no alfabéticamente) y `buildFolderIndex` saca el catno del segmento de
ruta: comprobado, **88/88 ficheros indexados y 16/16 releases** sin mezclar
pistas entre catnos.

Esta carpeta lleva solo audio. Las portadas no hacen falta: el importer las
coge del `cover` del listener por el endpoint `mirror` (pasada 2 de D5).

### 5. `process()` — bucle por artículo de la factura (`src/App.jsx:6066`)

Primero se piden las fichas web de toda la factura (paso 3). Después, para cada
`{catno, qty, dealerPrice}`, con `meta = {…ficha, fmt_norm: ficha.format_hint,
…conValor(listener)}` y `assets = folderIndex[key]`:

1. **Artista**: `V.A.`/`Various…` → nombre del sello, y si pasa de 50 caracteres
   se corta al primer artista antes de `/`, `feat`, `ft.`, `,`.
2. **Título**: limpia `....`, y si queda vacío o es `/` cae al catno.
3. **Descripción**: si pasa de 100 caracteres y no acaba en puntuación, añade
   `…` — `og:description` viene cortado a ~500 sin mirar dónde acaba la frase.
4. **D2**: sin `artist` ni `title` (ni de la ficha web ni del listener) →
   `Status=draft`, `Published=FALSE`.
5. **Precio**: `dealerPrice × (1 + margen/100)`, techo, menos 0.01. Margen por
   defecto 60 %, editable en pantalla.
6. **Gramos**: de `fmt_norm` (`gramsFromFmt`, `src/App.jsx:5996`): triple 1300,
   doble 900, 7" 180, resto 500. (Ver memoria: los pesos son estimados.)
7. **Portada — cascada D5** (`src/App.jsx:6150`), cuatro pasadas:
   1. funda real de la carpeta → `uploadToR2` a `covers/{catno}.{ext}`;
   2. URL «real» del listener → `?action=mirror` del Worker;
   3. cualquier imagen de la carpeta, aunque sea etiqueta/promo (D3);
   4. URL del listener aunque sea etiqueta.
   La clasificación real/etiqueta/trasera está en `isBack`/`isLabel`/
   `isRealSleeve` (`src/App.jsx:5831-5801`); `selectCover` (`src/App.jsx:5869`)
   elige, a igualdad de categoría, la imagen más grande. Las traseras nunca se
   usan.
   El espejo va por el Worker porque mothertonguerecords.com no manda CORS;
   `handleMirror` (`houseonly-worker/houseonly-worker/src/index.ts:1095`) valida
   host contra `MIRROR_ALLOWED_HOSTS` (`:1079`), tope 10 MB, 15 s, y exige
   `Content-Type: image/*`.
8. **Audio**, con la carpeta mandando si trae algo para ese catno:
   - **Con carpeta**: `orderAudio` (`src/App.jsx:5897`) deduplica por nombre
     base prefiriendo mp3 > m4a > wav y ordena por cara/número (`A1`,
     `Side B.2`, `01.`, o carpetas `THIS/`/`THAT/`). Cada pista sube a
     `audio/{catno}/{fichero}` y el nombre visible sale de
     `trackNameFromFilename` (`src/App.jsx:5942`).
   - **Sin carpeta** (lo normal en MT): las pistas de la ficha web se espejan
     una a una por `?action=mirror-audio` a
     `audio/{catno}/{nn}-{fichero}.mp3`. El nombre visible es el del array del
     reproductor, ya editado a mano por el sello, y **no** pasa por
     `trackNameFromFilename`: esa función deduce el nombre de un fichero, y por
     esta vía no hay fichero. De paso desaparece el problema de `MBH001/002`,
     cuya barra rompía esa regex.
9. **Tags**: `vinyl`, `source:mt`, `label:{sello limpio}`, los géneros pasados
   por `normalizeGenres` (D4) y luego por `tagsDeGenero`
   (`src/App.jsx:11150`), y el año actual. **D1: no se emite ningún tag
   operativo `mothertongue`.**
10. **Fila CSV**: `Body (HTML)` = `buildDescriptionHtml(...)` más, si hay
    pistas, un `<script type="application/json" id="tracks">` con el JSON de
    `[{name, url}]` — que es de donde el front saca el reproductor.
    `Variant SKU` = catno, `Cost per item` = precio de dealer,
    `Variant Inventory Policy` = `continue`.

Al acabar: `autoRecomputeEntities('Mother Tongue')` y `status='review'`, que
pinta la rejilla de tarjetas con portada, nº de pistas y errores por artículo.

### 6. Descarga del CSV (`src/App.jsx:6320`)

1. `exigirColaAutenticada()` (`src/App.jsx:11238`) — **sin la pestaña Entities
   autenticada no hay CSV**, porque los géneros no resueltos se perderían sin
   avisar.
2. `withEntityColumns` (`src/App.jsx:11591`) resuelve artista y sello a sus
   slugs canónicos y añade las dos columnas de metafield. Si falla, el CSV sale
   igualmente pero con un `alert` diciendo por qué.
3. `descargarCsvDeImporter(..., 'mothertongue_shopify_import.csv', 'mt')`
   (`src/App.jsx:11475`) vuelca **primero** la cola de géneros al servidor y
   solo descarga el fichero si la cola confirma; si no, lanza y no hay CSV.
   Las columnas son las claves de la fila menos las que empiezan por `_`
   (campos internos de la vista previa).

### 7. Después del CSV (fuera del importer)

El CSV se sube a mano en Shopify. Al crearse cada producto, el webhook
`products/create` → `webhook-shopify-product` corre el matcher de Discogs;
`source:mt` está en `ACCEPTED_SOURCE_TAGS`
(`houseonly-worker/houseonly-worker/src/lib/sync.ts:65`), así que estos
productos entran en el flujo de la cola de revisión. La aprobación de matches
sigue siendo manual.

## Resumen en una línea

La factura PDF dice qué discos entran, cuántos y a cuánto; el Worker va a
buscar a mothertonguerecords.com qué son y cómo suenan; y el tab MT escupe una
fila de CSV de Shopify por línea de factura, con portadas y audio ya en R2.
