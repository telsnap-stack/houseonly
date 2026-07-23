# 2026-07-23 — Importación pedido Deep Jungle (96 refs, source:dj)

Pedido proforma Deep Jungle 2026-07-08: 96 referencias jungle/D&B sin promos
ni artwork (DAT125/126 excluidas → 94 a importar). Manifest:
`deep_jungle_manifest.json` (proporcionado como upload; precios retail EUR ya
calculados con la regla `dealer_gbp × discos × 1.15 × 2 → ceil − 0.01`).

## Worker

- `source:dj` añadido a `ACCEPTED_SOURCE_TAGS` en
  `houseonly-worker/houseonly-worker/src/lib/sync.ts` (el manifest decía
  `index.ts`, pero la constante vive en `lib/sync.ts` tras el refactor).
  Commit directo en `main` (80974a5), solo ese archivo.
- **PENDIENTE: deploy.** El entorno remoto no tiene credenciales de Cloudflare
  (`wrangler whoami` → not authenticated). Hasta que se haga
  `npx wrangler deploy --env=""` desde main, el webhook `products/create`
  responderá "no recognized source tag" para los productos source:dj.
  Recuperable después con el patrón backfill (cf. `backfill-tv-auto.mjs`):
  reenviar los productos al webhook una vez desplegado.

## Assets (Bandcamp → R2)

- Descubrimiento con Chromium/Playwright (deepjungle.bandcamp.com está detrás
  de un "Client Challenge" JS de Fastly; curl solo no pasa). Trucos de entorno:
  CA del proxy importada al NSS store + `--ssl-version-max=tls1.2` (el proxy
  de egreso resetea el ClientHello TLS 1.3 de Chrome).
- Matching manifest ↔ Bandcamp por catno en el título del álbum:
  94/94 localizados sin ambigüedad (algunos en subdominios de artista, p. ej.
  harmonydeepjungle.bandcamp.com).
  - **DAT088**: en Bandcamp es UNA release con los 4 temas → repartidos
    1-2 a `DAT088 A/B` y 3-4 a `DAT088 C/D`, portada compartida.
  - **FR013**: localizado en futureretrolondon.bandcamp.com/album/fr013.
  - **APORN100**: localizado vía búsqueda Bandcamp en
    audiopornrecords.bandcamp.com (DJ Dextrous ft Erin - Lovable Remixes).
- Audio: metadatos + streams mp3-128 vía yt-dlp (cookies del navegador);
  snippets de 2:00 @ 128 kbps CBR 44.1 kHz estéreo (misma especificación que
  los snippets W&S del catálogo, verificado contra R2), corte con ffmpeg.
- Naming idéntico al pipeline W&S: `audio/<KEY>/1_<n>_<Artista>---<Tema>.mp3`,
  portada `covers/<KEY>.jpg` (max 2000px JPEG). KEY = catno saneado
  (`DAT088 A/B` → `DAT088-A-B`). Subida vía `?action=upload` del worker prod.
- Prefijos de cara A1/A2/B1... por mitades (convención W&S) en 12"/10";
  los 3x12 LP van sin prefijo de cara (no hay info fiable de caras).

## Shopify

- Creación por `productSet` (Admin GraphQL vía MCP): title/handle/vendor/tags
  del manifest, descriptionHtml estilo `buildDescriptionHtml` + bloque
  `<script id="tracks">` con los snippets, imagen desde R2, taxable,
  inventario tracked con qty en `gid://shopify/Location/115150881152`,
  inventoryPolicy CONTINUE (convención del catálogo), peso `weight_g`.
- Variantes de color: refs con stock negro Y de color → UN producto con
  opción `Colour` (Black `<catno>` / Coloured `<catno>-COL`); refs solo-color
  → producto de una variante "Coloured" con sku `<catno>` (una variante Black
  sin precio no es representable). El "8 refs" del encargo se materializa como
  4 dobles (DAT001LP, DAT102, DAT101, DAT082) + 5 solo-color
  (DAT073, DAT062, DAT105, JIG001, APORN100).

## Frontend (App.jsx)

- Baseline verificado en staging antes de tocar nada: con `variants(first:1)`
  el producto de 2 variantes mostraba solo Black €60.99 y la variante Coloured
  era invisible/incomprable.
- Cambio mínimo: `parseProduct` expone `variants[]` (queries a `first:5` con
  `title`), y el Modal pinta selector Black/Coloured con precio/stock por
  variante; el add-to-cart lleva el variant id elegido (línea de carrito
  separada por variante). Todo lo single-variant renderiza igual que antes.
- Validado en staging.houseonly.pages.dev (Pages reconstruye al push de la
  rama `staging`): DAT124 (simple), DAT088 A/B (split), DAT001LP
  (Black €60.99 / Coloured €75.99, cambio de precio y carrito OK; snippets
  reproducibles desde el origen del site).

## Estado / pendientes

- [ ] `npx wrangler deploy --env=""` del worker desde main (sin credenciales CF
      en este entorno).
- [ ] Tras el deploy: backfill de los productos source:dj al webhook para
      meterlos en la cola de revisión Discogs.
- [ ] Merge de `claude/deep-jungle-manifest-setup-kheve9` a `main` (PR) para
      que el soporte de variantes llegue al Pages de producción.
