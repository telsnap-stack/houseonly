# 2026-11-08 — SEO de las fichas de producto

Search Console (28 días hasta el 6-11): 24 clics, 459 impresiones, posición
media 9,3. 92 páginas indexadas y 616 sin indexar, de ellas 434 fichas en
"Rastreada, actualmente sin indexar" y 178 en "Página con redirección". Los
títulos eran "Forward Motions EP — Shawn Ward | House Only": sin sello y sin
"vinyl", y las búsquedas reales son artista + título ("anish kumar vinyl").

## Diagnóstico (fase 1, solo lectura)

- **Todo el SEO de ficha sale de `scripts/prerender.mjs`** (title, description,
  og/twitter, canonical, JSON-LD `Product` + `Offer`). `App.jsx` no tocaba el
  `<head>` de las fichas; el worker no genera estas etiquetas.
- **Contenido pobre y escondido.** El HTML servido pesaba 4,6 KB y su único
  contenido propio era un `<div>` a `left:-9999px`, fuera de `#root`, sin
  tracklist. Con JS, la ficha es un modal sobre la rejilla de la portada, igual
  en las 1.692 fichas. Hipótesis principal de las 434 sin indexar: contenido
  escaso, casi duplicado y texto oculto.
- **Slug en tres copias** (`App.jsx`, `prerender.mjs`, `lib/slug.ts`) con una
  divergencia: con vendor "House Only", App.jsx sacaba el artista de la
  descripción y el prerender usaba "House Only" (solo DJ Series Vol 4.).
- **Sitemap:** todas las fichas, con barra final, pero 8 slugs compartidos por
  18 discos: 10 fichas sin página propia y líneas repetidas.
- **Redirecciones:** http→https, www→ápex, sin barra→con barra (301 en
  `/products/` por `_redirects`, 308 en el resto) y `/index.html`→`/`. Única
  fuente interna: el pie de políticas enlazaba `/shipping` etc. sin barra en
  todas las páginas.
- **Enlaces rastreables:** en el HTML estático, ninguno a fichas; con JS solo
  los 24 primeros de la portada ("Load more" es un botón) y las páginas de
  artista y sello.
- **Soft 404:** `/products/<lo-que-sea>/` devuelve 200 con la portada.

## Qué cambió (PR #222, merge `f81ecdc`)

- **`houseonly-worker/src/lib/ficha-seo.mjs`: una sola copia** de slug, título,
  H1, texto y enlaces. La importan `App.jsx`, `prerender.mjs` y el worker
  (`lib/slug.ts` la reexporta para newsletter, feed de Google y portal). El
  vendor "House Only" no es artista en ningún sitio.
- **Título:** `Artista – Título Vinyl (Sello) | House Only`, sin catálogo. Si
  pasa de 90 caracteres se quita el sello; "| House Only" no se quita nunca.
  Mismo título en og:title, twitter:title y `document.title` con el modal
  abierto. Con el catálogo actual (1.682 fichas, 1.506 con sello): 230 pierden
  el sello y 57 siguen por encima de 90. 20 títulos de Shopify repiten el
  artista al final ("Penny Ballads - Royce Wood Junior").
- **H1:** `Artista – Título (Catálogo)`. `name` del JSON-LD: `Artista – Título`.
- **Ficha visible dentro de `#root`** en el HTML servido: portada, H1, precio y
  el bloque de `bloqueFichaHtml`:
  - una frase solo con datos de Shopify (artista, sello, catálogo, año o
    "release date" en pre-order, género y tracklist limpio con
    `nombreDePista`), sin la descripción del distribuidor;
  - "More from …": hasta 8 `<a href>` del mismo artista y después del mismo
    sello, de la más reciente a la más antigua; "Various Artists" no cuenta.
- **El modal pinta el mismo bloque** con la misma función, al final de la
  ficha y con los tokens de `S`. Los candidatos salen de dos consultas
  Storefront (`vendor:` y `tag:"label:…"`, 50 cada una) y `relacionadas()` hace
  el filtro exacto. El clic abre la ficha sin recargar.
- **JSON-LD:** `offers.itemCondition: NewCondition` y `gtin8/12/13/14` solo si
  el barcode es un GTIN con dígito de control válido (240 de 266). Según la
  documentación de Google, `gtin` va en `Product` e `itemCondition` en `Offer`.
- **Sitemap:** una URL por slug. **Pie de políticas** con barra final.
- **`public/_redirects`:** 301 de `/products/house-only-dj-series-vol-4[/]` a
  `/products/dj-series-vol-4/`, por encima de la regla genérica (en Pages, para
  el mismo origen manda la regla de más arriba).

Cobertura con el catálogo real: 17 fichas con la frase de una sola oración
(sin género ni tracklist); 478 (28 %) sin ningún enlace "More from" (115 sin
sello, 35 "Various Artists" o sin artista, el resto artista y sello con un solo
disco); 600 con los 8 enlaces.

## Despliegue

- Staging primero: #220, #221, #223 y #224 a `staging`, worker de staging
  redesplegado con los frenos en cada cambio que tocaba `ficha-seo.mjs`.
- Antes/después de tres fichas (con tracklist, sin sello, pre-order), HTML,
  título, JSON-LD y capturas de escritorio y móvil en el #222. Las capturas
  viven en la rama `capturas/seo-fichas` (v1, `v2/`, `v3/`), que no se mergea.
- "Aprobado deploy #222": merge en `main` como `f81ecdc`; `npm run deploy` con
  los frenos en verde (contiene origin/main, 112 rutas, `src/` limpio, tests
  639/639). Worker **`30a64ac3`**, crons sin cambios. Frontend: Pages desde
  `main`.
- Comprobado en houseonly.store: títulos nuevos, `itemCondition`, bloque
  visible sin texto oculto, los dos 301 de DJ Series, sitemap sin duplicados,
  `/shipping/` sin redirección. Feed de Google sin regenerar (DJ Series no está
  en él). `verify-deploy.sh` en el Terminal de Eduardo: TODO BIEN (21/21 rutas
  de la muestra, mt-enrich y mirror-audio).
- Tests: frontend 38/38 (`src/ficha-seo.test.mjs`), worker 639/639.

## Stories (consulta, sin cambios)

El picker de Stories no guarda historial de uso. Lo más parecido es `ig:feed`
en `SYNC_STATE` (`lib/ig-feed.ts`: `{handle, sku, title, artist, addedAt}`,
máximo 200), pero deduplica por handle (solo queda la última vez), solo se
escribe con el cierre "Link in bio" o el botón, y alimenta `/ig`. Propuesta no
implementada: desde `onExported` del exportador, un POST sin esperar a una ruta
`story-log` que escriba una clave por exportación,
`story:log:<ISO>:<handle>`, con el sku en la metadata.

## Pendiente

- **PR semanal:** el limpiador de pistas se come un número inicial que es
  parte del título ("4 Seasons In A Day" → "Seasons In A Day"); solo debe
  quitar numeración seguida de punto, guion o paréntesis. Con test. Desde el
  #222 también afecta a la frase visible de las fichas.
- Para más adelante (decisión de Eduardo): 404 de fichas inexistentes,
  `shippingDetails` y `hasMerchantReturnPolicy`, enlace a la página de género
  en "More from", normalizar mayúsculas del artista en Shopify (Omar S / omar
  s) y los 18 discos con slug repetido (tabla en el #222).
- Seguir en Search Console la evolución de "Rastreada, actualmente sin
  indexar" tras el reprocesado.
