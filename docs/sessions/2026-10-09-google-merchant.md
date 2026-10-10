# 2026-10-09 — Google Merchant Center: feed propio y políticas en el pie

Rama `claude/google-merchant` desde `main` (`442795e`). Worker solo en staging.

## Pie con políticas

- Los cinco enlaces (Shipping, Returns, Contact, Privacy, Terms) a las páginas
  de políticas de Shopify, en una sola lista: `src/policies.mjs`, que importan
  `src/App.jsx` y `scripts/prerender.mjs`.
- En la app son `<a target="_blank" rel="noopener noreferrer">` de verdad,
  dentro de `<footer><nav aria-label="Store policies">`. Antes eran botones que
  abrían un cajón, y Merchant Center no puede seguir eso. «Legal Notice» no
  estaba en la lista y sigue en su cajón.
- En el HTML prerenderizado (portada/fallback, `/ig`, fichas de producto y de
  entidad), el pie va **dentro de `#root`**: lo ve quien no ejecuta JavaScript,
  y al montar, `createRoot` lo sustituye por el de la app. Se aplica lo último.

## Feed de Google (`src/lib/google-feed.ts`)

- `GET ?action=google-feed`: RSS 2.0 con `xmlns:g`, público,
  `application/xml; charset=utf-8`, cabeceras `X-Feed-Built-At` y
  `X-Feed-Items`. Se sirve de `SYNC_STATE` (`google:feed`, fecha y recuento en
  los metadatos); si no hay nada, se genera en el momento y se guarda.
- `POST ?action=google-feed-rebuild` (`bearerAdminValido`) lo fuerza y
  devuelve el resumen (cuántos entran y por qué se salta cada uno).
- El cron diario `0 6 * * *` lo regenera; el resultado queda en
  `meta:google_feed_last_run`. Si falla, se queda el de ayer.
- Entra: producto ACTIVE (Admin API, `status:active`, 50 por página), alguna
  variante con `inventoryQuantity > 0` y sin el tag `forthcoming`. Es la regla
  de la rejilla: los request/backorder tienen stock 0. Los de D&B entran, porque
  se venden en su sección.
- **`g:link` con el slug del sitio, no con el handle.** `/products/<handle>/`
  sirve la portada (`<title>houseonly</title>`; comprobado en prod con
  `fat072`), así que Google vería otra página. Se usa `makeReleaseSlug(vendor,
  title, SKU de la primera variante)`, lo mismo que `scripts/prerender.mjs`.
- `g:google_product_category` **543523** = "Media > Music & Sound Recordings >
  Records & LPs", de la taxonomía oficial
  (`taxonomy-with-ids.en-US.txt`, versión 2021-09-21). No hay hoja "Vinyl".
- `g:gtin` solo con 8, 12, 13 o 14 dígitos y dígito de control GS1 correcto;
  sin él, `g:identifier_exists = no`. `g:brand` = tag `label:`; `g:mpn` = SKU.
  `g:title` "Artista – Título" (el vendor "House Only" no cuenta como artista),
  a 150 como mucho. `g:description` con `descripcionDeProducto`, a 5000 (si
  queda vacía, el título). Sin `g:shipping_weight`.
- Campos de la Admin API `2026-04` comprobados en la doc: imagen por
  `featuredMedia { preview { image { url } } }` (`featuredImage` está
  deprecado); `price`, `barcode`, `sku` e `inventoryQuantity` vigentes.
- Se saltan también los que no tienen imagen: `image_link` es obligatorio.
- Tests `test/google-feed.spec.ts` (14): sin barcode → `identifier_exists=no`;
  EAN-13 válido → `g:gtin`; checksum malo → como sin barcode; forthcoming y
  stock 0 no entran; XML bien formado con caracteres escapados; GET genera,
  guarda y la segunda vez sirve de KV; rebuild 401 sin Bearer. Suite: 352/352.

## Verificación en staging

- Worker staging `8238b620-1497-458a-a13f-1dd0488a3493`. Primera llamada:
  genera en vivo en 8,4 s, 1,15 MB, **1019 items**. Rebuild sin Bearer → 401.
- `xml.etree` lo parsea sin error. 0 ids repetidos, 202 con `g:gtin` y 817 con
  `identifier_exists=no`, 29 sin sello (sin `g:brand`). Ningún título pasa de
  150 ni descripción de 5000, todos los precios son "NN.NN EUR" y ninguno
  lleva `shipping_weight`.
- **Los 1019 `g:link` tienen su página prerenderizada** en el build.
- Cuadre con la Storefront API: 1400 publicados, 114 forthcoming, **1044**
  vendibles (stock > 0 y sin forthcoming). Los 25 que faltan no tienen imagen
  en Shopify (TOYT128, WGVINYL81, VA003, varios FOKUZ…). 1044 − 25 = 1019. No
  hay nada en el feed que no esté en la tienda.
- Pie en staging, Chrome headless a 390 px: portada, `/ig` y una ficha. Los
  cinco enlaces con su URL y `target=_blank`, sin scroll horizontal, 0 errores
  de consola. También en el HTML servido de las tres páginas (5 de 5). En la
  ficha el pie queda detrás del modal, como el resto de la página.
- Build OK, lint 93 → 93 (ninguno nuevo).

## Datos de Shopify que Merchant Center puede señalar

- `identifier_exists=no` junto a `g:brand` + `g:mpn`: la ayuda de Google dice
  que con marca y MPN lo correcto es omitirlo o ponerlo a `yes`, y avisa
  (warning, no rechazo). Se ha dejado como pedía la especificación; cambiarlo
  es una línea en `itemXml`.
- 387 discos sin descripción en Shopify llevan el título como `g:description`.
- 56 descripciones empiezan a mitad de frase porque el texto de Shopify ya
  viene cortado (p. ej. BARN129, «fl ute of the region…»). La ficha enseña lo
  mismo.
- 25 discos con stock no tienen imagen y no entran en el feed.

## Pendiente

- Desplegar el worker a prod tras el merge:
  `cd houseonly-worker/houseonly-worker && NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection" npm run deploy`
- Dar de alta el feed en Merchant Center:
  `https://houseonly-worker.emontagut.workers.dev/?action=google-feed` (o
  forzarlo antes con `google-feed-rebuild`).
