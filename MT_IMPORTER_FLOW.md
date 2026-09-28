# MT (Mother Tongue) import flow

Escrito el 2026-09-28 leyendo el código, no de memoria. Referencias con
`fichero:línea` sobre el árbol en `claude/genero-garage`.

## De dónde sale el HTML del listener (corregido 2026-09-28)

Los scrapers estaban en `~/Downloads`, no en el repo. Ya están copiados a
`scripts/mt/`. Lo que encontré **corrige** lo que suponía la primera versión de
este documento:

- **No existe ningún `mt_scraper_v3.js` completo** en esta máquina. Hay
  `mt_scraper_v2_with_genres.js` (7 de mayo de 2026) y
  `mt_scraper_v3_1_patch.js` (5 de julio de 2026), que es un parche puntual
  para la factura 756, no el scraper entero. La v3 propiamente dicha no
  aparece ni en `~/Downloads`, ni en Spotlight, ni en el repo.
- **El scraper NO genera el HTML del listener.** Descarga un **JSON**
  (`mt_enrichment_AAAA-MM-DD.json`) y su último log dice literalmente «📥 JSON
  descargado. Súbelo a Claude». El listener HTML se monta después, en una
  conversación con Claude, cruzando ese JSON con la factura.

La prueba está en los campos. La v2 emitía `page_title`, `headings`, `cover`,
`description`, `genres`, `tracks`. El `RELEASES` del listener lleva además
`cat`, `price`, `price_num`, `fmt_norm`, `is_preorder`, `status` y un
`title`/`artist` ya separados. La v4 cierra parte de ese hueco —ya saca `catno`,
`artist`, `title`, `label`, `format_hint` y `released` de la propia ficha—, pero
el precio, la cantidad y la preventa **solo** están en la factura, así que el
eslabón de montaje sigue haciendo falta. Ejemplo real de
`~/Downloads/mt_listener_v3.html`:

```json
{"label": "2000Black - (Worldwide except UK)", "cat": "2053BLACK",
 "artist": "Kaidi Tatham", "title": "Galaxy", "price": "€ 8,24",
 "price_num": 8.24, "format": "Vinyl 12\"", "fmt_norm": "12\"",
 "url": "https://www.mothertonguerecords.com/product/kaidi-tatham-galaxy/",
 "status": "", "is_preorder": false, "tracks": [...]}
```

O sea, la cadena real tiene **cuatro** eslabones, no tres:

```
1.  scripts/mt_scraper_v4.js   (consola de Chrome, en mothertonguerecords.com)
          catnos de la factura  →  mt_enrichment_v4_AAAA-MM-DD.json
                    ↓
2.  montaje del listener        (fuera del repo, cruzando con la factura:
          JSON + factura PDF     precio, cantidad, preventa)
                    ↓
3.  listener HTML con const RELEASES = [...]
                    ↓
4.  MotherTongueImporter (src/App.jsx)  →  CSV de Shopify
```

El eslabón 2 es el único sin código en el repo: hoy se hace a mano. El
scraper **no** genera el listener y no debe intentarlo — sin la factura no
sabe ni el precio ni cuántas copias entran.

### Cómo se ejecuta `scripts/mt_scraper_v4.js` (el vigente)

IIFE para pegar en la **consola de Chrome**, no un script de Node: usa `fetch`
same-origin, `DOMParser` y `URL.createObjectURL`.

1. Abrir cualquier página de `https://www.mothertonguerecords.com`.
2. Editar el array `CATNOS` de la cabecera con los catnos de la factura.
3. DevTools → Console, pegar el fichero entero.
4. Descarga `mt_enrichment_v4_AAAA-MM-DD.json`; también queda en
   `window._mtScrapeV4`.

Mantiene de la v2 el ritmo de 4 en 4 con 200 ms entre tandas y los campos
`page_title` / `headings` / `cover` / `description` / `genres` / `tracks` /
`track_count`, y añade `catno`, `artist`, `title`, `label`, `format_hint`,
`released`, `resolved_via` y `tracks_via`.

**Resolución del catno → producto**, en cascada, sin adivinar nunca:

1. Store API de WooCommerce, `/wp-json/wc/store/v1/products?search=CATNO`. Es
   pública y devuelve el `sku`, que en esta tienda **es** el catalog number, así
   que el emparejamiento es exacto y no por ranking de texto. Se prefiere SKU
   idéntico → normalizado → prefijo único; si quedan varios candidatos, el
   catno se reporta como ambiguo y no se elige.
2. Si la búsqueda no da con él, se barre el catálogo entero
   (`?per_page=100&page=N`, 7 peticiones para ~700 referencias) y se empareja el
   SKU en local. Se barre una sola vez por ejecución y se cachea.
3. Buscador HTML de WordPress, como último recurso.

**El paso 3 hoy no funciona y conviene saberlo.** Comprobado el 2026-09-28
contra la tienda en vivo: `/?s=CAT-016&post_type=product` responde 200 con
«No products were found matching your selection», y da lo mismo buscar por
catno o por título («Kaidi Tatham Galaxy» → 0 productos). La búsqueda nativa de
WooCommerce no indexa SKUs, y el buscador que se ve en la web es el plugin
Advanced Woo Search, cuyo endpoint AJAX devuelve 0 resultados sin nonce. El
código se queda por si se reactiva, pero en la práctica lo que resuelve es la
API; si la API cayera, el script deja los catnos en la lista de fallos para
resolverlos a mano en vez de inventarse un producto.

**Extractores** (todos leen marcado estructurado, no heurísticas):

| Campo | De dónde |
|---|---|
| `artist` | `h1.product_title` — en esta tienda el `h1` es el **artista** |
| `title` | `p.mt-product-subheading` |
| `label` | `p.mt-product-label` |
| `format_hint` | `div.mt-product-meta` → fila «Format» |
| `released` | `div.mt-product-meta` → fila «Released» |
| `catno_web` | `div.mt-product-meta` → fila «Catalog No.», para cotejar |
| `genres` | `a[rel="tag"]` que apunten a `/product-category/` |
| `cover` / `description` | `og:image` / `og:description` |
| `tracks` | el array `new Player([{title, file}, …])` que imprime la página |

Las filas de `mt-product-meta` se leen **por etiqueta**, no por posición: si
añaden un campo, no se rompe.

### Validación (2026-09-28)

Ejecutado de principio a fin contra la tienda en vivo con cinco catnos
(`TLM041`, `VP014`, `CAT-016`, `GT01`, `MT19024`): **5/5 resueltos, 17 pistas,
sello 5/5, géneros 5/5, fecha 5/5, 0 fallos**, todos por `api:sku-exacto` y con
las pistas vía `player-array`. Muestra:

```
TLM041   V.A. (Mike Perras, Takahiro Fuchigami, …) — Frisson EP Part B
         sello=Ten Lovers Music · formato=Vinyl 12" · salida=26 June 2026
         generos=[Broken Beat, House / Electronic, What's New] · pistas=4
CAT-016  The Soul Pops — The Mask EP
         sello=Cataleya Music · formato=vinyl 12" · salida=22 May 2026
```

Los extractores se probaron además uno a uno contra el HTML guardado de tres
productos reales (`kaidi-tatham-galaxy`, TLM041, CAT-016), y los tres caminos de
resolución contra la API en vivo, incluido el caso ambiguo: buscar
`SACREDMEDICINE005` devuelve también `SACREDMEDICINE005B`, y la preferencia por
SKU idéntico escoge el correcto.

### Qué hacía falta arreglar de la v2 y la v3.1

Los dos scrapers anteriores siguen en `scripts/mt/` como referencia. Lo que la
v4 corrige, comprobado contra el HTML de hoy:

- **La lista de 276 URLs incrustada** (v2) obligaba a editarla a mano por
  factura. Sustituida por catnos + resolución por SKU.
- **`extractLabel` de la v3.1 estaba mal**: `a[href*="/record-label/"]` coge el
  *primer* enlace de la página, que hoy es el menú lateral de sellos. En
  `/product/kaidi-tatham-galaxy/` devolvía «Salsoul Records» en vez de
  «2000Black». La v4 usa `p.mt-product-label`.
- **Los nombres de pista de la v2 salían del nombre del fichero.** Su heurística
  (último `<strong>` en los 800 caracteres anteriores al mp3) no llegaba, porque
  las URLs viven en un `<script>` lejos del listado. Por eso los listeners
  viejos dicen «A1. Galaxy feat Lola» donde la web dice «Galaxy».
- **`.posted_in` y `.tagged_as` ya no existen** en el tema actual; los géneros se
  salvaban sólo por la tercera pasada de la v2 (`a[rel="tag"]`).
- **El `h1` es el artista, no el título.** La v2 lo guardaba como `page_title` y
  el nombre del disco se perdía; ahora salen los dos separados.

### Lo que no copié al repo

En `~/Downloads` hay siete listeners HTML ya generados (`mt_listener_v2`,
`mt_listener_v3` y duplicados, `mt_invoice_481_listener`,
`mt_invoice_756_listener_with_genres`, `Mother Tongue · Listening Session`),
entre 46 KB y 616 KB, unos 2 MB en total. Son **salidas** por factura, no
herramientas: no los he commiteado. Si quieres conservarlos, el sitio sensato
es Drive junto al resto de los assets de Mother Tongue, no el repo.

## El HTML del listener: qué es y qué contrato cumple

`parseListenerHTML` (`src/App.jsx:5664`) hace exactamente esto:

1. Lee el fichero como texto.
2. Extrae con regex `const RELEASES = ([...]);` — literalmente
   `/const\s+RELEASES\s*=\s*(\[[\s\S]*?\]);/`.
3. `JSON.parse` de ese array. Si no aparece el array → «Could not find RELEASES
   array in HTML file»; si no parsea → «RELEASES JSON parse failed».
4. Indexa por **catno normalizado** (`normCatno`, `src/App.jsx:5510`: mayúsculas
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
(`src/App.jsx:5926`, D4 filtra «What's New», «Distribution (Wholesale)», «We
Dig», «International»…) y las portadas siguen patrones de slug de **WordPress**
(`-sideA-`, `sideA-scaled`, `src/App.jsx:5799`) — coherente con lo que hace el
scraper, que recorre la tienda WooCommerce de mothertonguerecords.com producto
a producto.

## El flujo completo, paso a paso

Todo ocurre en el navegador, en el panel admin, pestaña `mt`
(`src/App.jsx:12258` → `<MotherTongueImporter />`, definido en
`src/App.jsx:5492`). Tres entradas, un CSV de salida.

### 1. Entradas (arrastrar o botón)

La zona de drop (`src/App.jsx:6247`) clasifica por extensión: `.pdf` → factura,
`.html`/`.htm` → listener, y `zip|jpe?g|png|webp|mp3|wav|flac|aac|ogg|m4a` →
carpeta de assets. El botón de carpeta usa `webkitdirectory`.

### 2. Factura PDF → `[{catno, qty, dealerPrice}]`

`parseInvoicePDF` (`src/App.jsx:5534`), con pdf.js cargado en caliente
(`loadPDFJS`, `src/App.jsx:3112`):

- Reconstruye líneas agrupando los items de texto por Y redondeada a múltiplos
  de 4 px, ordenando por X e insertando espacio cuando el hueco supera 1.0.
- Descarta cabeceras/pies con `SKIP_PATTERNS` (`src/App.jsx:5566`): datos de
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

### 3. Listener HTML → `releaseMeta`

Paso 2 de esta lista, arriba: `onHtml` (`src/App.jsx:5965`) llama a
`parseListenerHTML` y guarda el mapa `catnoNorm → meta`. El fichero viene del
montaje descrito al principio (scraper → JSON → listener), no del scraper
directamente.

### 4. Carpeta del distribuidor → índice de assets

`onFolder` (`src/App.jsx:5978`):

- Si hay `.zip`, `expandZips` (`src/App.jsx:3068`) los abre con JSZip y saca
  solo imágenes y audio. Cada fichero extraído lleva `_relpath` con el nombre
  del zip por delante y `_zipBase` para agruparlo con sus hermanos. Se ignoran
  `__MACOSX/`, `._*` y `.DS_Store`.
- `buildFolderIndex` (`src/App.jsx:5695`), en un `useEffect` que depende de
  `folderFiles` e `invoiceItems` (`src/App.jsx:6004`), asigna cada fichero a un
  catno **por subcadena**, probando los catnos conocidos de más largo a más
  corto. Así `TLM041_promopack.zip` o `01 - CAT-016 - The Soul Pops.mp3`
  resuelven sin renombrar nada.
- Los ficheros salidos de un zip se resuelven **en grupo**: se juntan como
  evidencia el nombre del zip y el de todas sus entradas, y un único nombre con
  catno (normalmente la portada) fija el catno de todas las pistas del zip
  aunque el zip se llame con un hash. Si no resuelve, avisa por `console.warn`.

### 5. `process()` — bucle por artículo de la factura (`src/App.jsx:6009`)

Para cada `{catno, qty, dealerPrice}`, con `meta = releaseMeta[key]` y
`assets = folderIndex[key]`:

1. **Artista**: `V.A.`/`Various…` → nombre del sello, y si pasa de 50 caracteres
   se corta al primer artista antes de `/`, `feat`, `ft.`, `,`.
2. **Título**: limpia `....`, y si queda vacío o es `/` cae al catno.
3. **Descripción**: si pasa de 100 caracteres y no acaba en puntuación, añade
   `…` (el truncado a ~500 del scraper).
4. **D2**: sin `artist` ni `title` del listener → `Status=draft`,
   `Published=FALSE`.
5. **Precio**: `dealerPrice × (1 + margen/100)`, techo, menos 0.01. Margen por
   defecto 60 %, editable en pantalla.
6. **Gramos**: de `fmt_norm` (`gramsFromFmt`, `src/App.jsx:5943`): triple 1300,
   doble 900, 7" 180, resto 500. (Ver memoria: los pesos son estimados.)
7. **Portada — cascada D5** (`src/App.jsx:6064`), cuatro pasadas:
   1. funda real de la carpeta → `uploadToR2` a `covers/{catno}.{ext}`;
   2. URL «real» del listener → `?action=mirror` del Worker;
   3. cualquier imagen de la carpeta, aunque sea etiqueta/promo (D3);
   4. URL del listener aunque sea etiqueta.
   La clasificación real/etiqueta/trasera está en `isBack`/`isLabel`/
   `isRealSleeve` (`src/App.jsx:5778-5801`); `selectCover` (`src/App.jsx:5816`)
   elige, a igualdad de categoría, la imagen más grande. Las traseras nunca se
   usan.
   El espejo va por el Worker porque mothertonguerecords.com no manda CORS;
   `handleMirror` (`houseonly-worker/houseonly-worker/src/index.ts:1095`) valida
   host contra `MIRROR_ALLOWED_HOSTS` (`:1079`), tope 10 MB, 15 s, y exige
   `Content-Type: image/*`.
8. **Audio**: `orderAudio` (`src/App.jsx:5844`) deduplica por nombre base
   prefiriendo mp3 > m4a > wav, y ordena por cara/número (`A1`, `Side B.2`,
   `01.`, o carpetas `THIS/`/`THAT/`). Cada pista sube a
   `audio/{catno}/{fichero}`; el nombre visible sale de
   `trackNameFromFilename` (`src/App.jsx:5889`), que quita prefijos (SKU, `A1`,
   `Side A.1`, `01.`) y sufijos (`Snippet`, `Clip`, `(60 sec taster)`,
   `- 2000BLACK`).
9. **Tags**: `vinyl`, `source:mt`, `label:{sello limpio}`, los géneros pasados
   por `normalizeGenres` (D4) y luego por `tagsDeGenero`
   (`src/App.jsx:11097`), y el año actual. **D1: no se emite ningún tag
   operativo `mothertongue`.**
10. **Fila CSV**: `Body (HTML)` = `buildDescriptionHtml(...)` más, si hay
    pistas, un `<script type="application/json" id="tracks">` con el JSON de
    `[{name, url}]` — que es de donde el front saca el reproductor.
    `Variant SKU` = catno, `Cost per item` = precio de dealer,
    `Variant Inventory Policy` = `continue`.

Al acabar: `autoRecomputeEntities('Mother Tongue')` y `status='review'`, que
pinta la rejilla de tarjetas con portada, nº de pistas y errores por artículo.

### 6. Descarga del CSV (`src/App.jsx:6202`)

1. `exigirColaAutenticada()` (`src/App.jsx:11185`) — **sin la pestaña Entities
   autenticada no hay CSV**, porque los géneros no resueltos se perderían sin
   avisar.
2. `withEntityColumns` (`src/App.jsx:11538`) resuelve artista y sello a sus
   slugs canónicos y añade las dos columnas de metafield. Si falla, el CSV sale
   igualmente pero con un `alert` diciendo por qué.
3. `descargarCsvDeImporter(..., 'mothertongue_shopify_import.csv', 'mt')`
   (`src/App.jsx:11422`) vuelca **primero** la cola de géneros al servidor y
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

Factura PDF (qué y a cuánto) × listener HTML (qué es; montado a partir del
JSON que descarga `scripts/mt_scraper_v4.js`) × carpeta del distribuidor (cómo suena y cómo se ve)
→ una fila de CSV de Shopify por artículo de la factura, con portadas y audio
ya subidos a R2.
