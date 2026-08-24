# 2026-08-24 — Archivo de emails, vista única de pre-orders y automatización

Jornada larga. Empezó como "importer de Rubadub por email pegado" (brief
`BRIEF-claude-code-rubadub.md`) y terminó en una vista de reconciliación de tres
distribuidores alimentada desde el worker. Buena parte del trabajo fue
**descubrir** cómo son los datos reales, no escribir código: casi todo lo que la
brief daba por sabido estaba mal o desfasado.

## Estado al cerrar

| | Dónde |
|---|---|
| Importer de Rubadub por email pegado | **producción** (`dd74bdd` y anteriores) |
| Cotejo contra catálogo en los dos importers | **producción** |
| Reintentos en `prerender.mjs` | **producción** |
| Worker: `emails-*`, `inventory-adjust`, `resolve-links`, `mirror` ampliado | **producción** (desplegado, `37ca73ba`/`7ecd26d7`) |
| Parser de TV, descripciones, 3 señales de pedido, vista única, carpeta de ZIPs | **staging, SIN VALIDAR** |

`staging` va ~10 commits por delante de `main`. `main` no se toca con merge:
cherry-pick por hash, como siempre.

## Lo primero de mañana

**Una pasada entera con `PACE009`** en `staging.houseonly.pages.dev`: parsear →
marcar → añadir al manifest → conectar carpeta → procesar → CSV. Tiene pedido,
ZIP en Drive, portada y descripción, así que ejercita todo.

**El riesgo concreto**: que Chrome se niegue a abrir el selector de carpetas
sobre un directorio de Google Drive (`~/Library/CloudStorage/...`). Si eso falla,
la lectura de ZIP desde Drive hay que replantearla — no hay plan B en servidor,
el worker no ve el disco.

Nada del circuito completo dentro del navegador lo ha recorrido nadie todavía.
Los tres bugs que aparecieron hoy (error invisible, secreto equivocado, añadir
sin señal) salieron todos de que Eduardo lo usara, no de las pruebas.

## Hallazgos que contradicen la brief o el saber previo

Esto es lo que más vale de la sesión. Si mañana algo no cuadra, empezar por aquí.

- **El 403 de Triple Vision no era ACL, ni caducidad, ni huella de cliente.**
  `xcdn.triplevision.nl` sigue vivo y devuelve ZIPs. TV migró a un bucket de
  DigitalOcean cuya clave lleva un sufijo `-UTIMESTAMP=<ms>` que es la VERSIÓN
  del objeto: cuando TV resube, la clave anterior deja de existir. El bucket no
  da `ListBucket` al anónimo, así que responde **403 en vez de 404**. O sea:
  403 = "URL rancia, re-resuelve", no "bloqueado". Además el harvester recorta
  el sufijo, así que sus URLs no han apuntado nunca a un objeto real.
  Ver `scripts/tv-resolve-promopacks.py`.

- **Un email posterior solo sustituye la URL si apunta al MISMO `order-item`
  UUID.** Los digests semanales mencionan muchos catnos pero sus enlaces van a
  otros order-items: coger "el .html de fecha más alta" a ciegas se lleva el ZIP
  equivocado.

- **Mailchimp usa DOS formas de tracker**, no una:
  `rubadub.us1.list-manage.com/track/click?...` y la corta
  `us.list-manage.com/XXXX`. Por buscar solo la primera di por hecho que `FTC12`
  y `WO-KJHBCS` no tenían promopack y lo justifiqué con una teoría convincente
  ("es lo normal en repress y restock"). Sí lo tenían.

- **El `.html` archivado NO trae el Dropbox limpio**: va tras el tracker. Copiar
  de ese fichero deja el release sin ZIP — justo lo que la brief daba por
  resuelto con "abre el .html de Drive y pega". La página de archivo de
  `mailchi.mp` sí lo sirve limpio.

- **El Apps Script no archivaba Rubadub** pese a lo que decía la brief (0
  ficheros `RD__` al empezar). Se hizo backfill durante la sesión: ahora hay 57.

- **El round-up semanal de pre-sales no tiene bloques de campos**, solo un enlace
  por release. Parsea a cero filas; asumí lo contrario y metí una rama de UI
  muerta que hubo que quitar.

- **Word & Sound está tras Cloudflare para cualquier servidor** (`403 Just a
  moment...` en `/release/.../assets`). No es cuestión de cookies. Pero sus
  **portadas sí son públicas** (`wordandsound.net/covers/...`, 200 sin UA
  especial) y están en los newsletters archivados: 26 de 51 catnos pedidos.

- **Shopify empareja el import CSV SOLO por Handle** y no deduplica por SKU.
  Los dos importers generaban handles distintos del mismo catno (`yore-011ltd`
  vs `yore011ltd`), así que un disco creado al pedirlo y facturado después
  acababa duplicado o sobrescrito. El cotejo normalizado (`rdKey` en los dos
  lados) lo resuelve sin unificar handles — unificarlos no compraba dedup y
  añadía una tercera convención.

- **Las URLs del storefront NO salen del handle**: se recalculan con
  `makeSlug(artist, title, catalog)` en `parseProduct()`, duplicado literalmente
  en `scripts/prerender.mjs`. Tocar `makeSlug` es un barrido en dos sitios.

## Formato de los datos, por distribuidor

Lo que varía es finito y son datos, no lógica. Está pendiente convertirlo en una
tabla de descriptores (ver "Pendiente").

| Eje | Rubadub | Triple Vision | Word & Sound |
|---|---|---|---|
| Campo del catálogo | `Cat:` | `Catalog:` | *(sin email de anuncio)* |
| Moneda | GBP × FX (1.17) | EUR directo | EUR directo |
| Fecha | prosa inglesa + rollover | `Release date: dd-mm-yyyy` | — |
| ¿Pre-order? | dice `Please Pre-Order` | fecha futura | fecha futura |
| Portada | `mcusercontent` — `_compresseds/` (14 de 51) **o** `images/` (37) | bucket DO, `_front` | `wordandsound.net/covers/` vía newsletter, o dentro del ZIP |
| Enlace del ZIP | tracker → Dropbox | tracker → bucket DO | URL del release + `/assets` |
| Descripción | prosa del email (6 de 7 ZIP no traen nada) | `{CATNO}_promotext.txt` en el ZIP | `SALESPAPER.pdf` en el ZIP |
| Señal de pedido | texto del `Fwd`/`Re` | shelf list semanal (`TVORD__`) | confirmación (`WSORD__`) |

**La señal de pedido de Rubadub va por email, pero un email puede anunciar
varios discos.** El de Logistic lleva `LOG88` y `LOG86` y el mensaje pide solo el
Narcotic Syntax: marcar el email entero metía en el pedido un disco que nadie
pidió. Hay que leer *qué* dice ("2 of this" → todo el email; "2 of the narcotic
syntax" → nombra cuál; sin texto → reenvío a secas).

## Cifras de referencia (para detectar regresiones)

Medidas contra el archivo real con `/tmp/viewtest.cjs`. Si tras un cambio no
salen éstas, algo se rompió:

```
emails en el worker            208   (TV 75 · RD 57 · DBH 47 · WS 17 · WSORD 7 · RDORD 4 · TVORD 1)
releases en la vista           187
  verdes (pedidos)              81   (W&S 50 · TV 25 · RD 5 · ambos 1)
  con precio                186/187
  con portada               115/187
  con ZIP tras resolver      59/81
duplicados entre distribuidores  1   (MP10 — Rubadub 20/08 y W&S 21/08)
ZIP en Assets/                1108   claves únicas 1086, ninguna sin clave
```

## Infraestructura nueva

- KV `DISTRIBUTOR_EMAILS` (`e4966f4a96e84c578bfd96b1d12bdf63`), compartido entre
  prod y staging como `WISHLIST`. Índice en `idx`, cuerpos en `msg:{filename}`.
- Apps Script: `pushDistributorEmails.gs` (empuja al worker, tandas de 40) y
  `saveShelfList.gs` (archiva el shelf list como `TVORD__`). Ambos en
  `~/Downloads`, pegados ya por Eduardo.
- **El shelf list llega a `houseonly.store`, no a `telsnap.com`.** Hay que
  configurar el reenvío automático en Gmail o dependerá de acordarse de
  reenviarlo a mano.

## Pendiente

1. **Validar el circuito completo** (arriba).
2. **Tabla de descriptores por distribuidor**, para que añadir DBH sea una
   entrada y no editar cinco funciones. La red de seguridad son las cifras de
   arriba: si tras refactorizar no salen idénticas, se rompió algo.
3. **Alta directa en Shopify por Admin API** en vez de CSV — mata el último paso
   manual. El worker ya tiene credenciales.
4. **Retirar `scripts/preorder-ritual.mjs`** cuando la vista esté validada: sigue
   vivo a propósito como respaldo, pero duplica el triage que ahora vive en
   `App.jsx`.
5. **DBH no tiene parser de anuncios** (17 de sus 47 emails traen bloques, con
   otro formato).
6. **Caso latente**: dos bloques de campos pegados sin nada entre medias salvo
   una línea en blanco se fusionan y se quedan con el último catno. No afecta
   hoy — los digests reales llevan prosa entre releases.
7. **`MIRROR_MAX_BYTES` está en 10 MB** y alguna portada bajo `_compresseds/`
   ronda los 4,4. Cabe, pero no sobra tanto.
8. **Rotar los tres secretos**: los dos `BOOTSTRAP_AUTH_SECRET` y el token de
   Cloudflare, que quedaron escritos en la conversación.
9. Borrar los dos objetos `covers/_TEST_*` que quedaron en R2 de las pruebas.

## Sobre las pruebas

El repo **no tiene runner de tests en el frontend** (el worker sí, `vitest`). Las
pruebas de hoy viven en `/tmp` y merecen sitio propio cuando lo haya:

- `ziptest.cjs` — carga los promopacks reales con JSZip y evalúa las líneas
  **extraídas de `App.jsx`**, no una copia, así que si alguien las cambia el test
  se entera.
- `viewtest.cjs` — simula la vista entera contra el archivo que sirve el worker.
- `rdedge.cjs` — 16 casos límite del parser (trampa del `Artist:`, rollover de
  año, digest, fechas vagas, varios emails en un pegado).

`npm run build` es un chequeo de sintaxis, no una prueba. Conviene no
confundirlo, que yo lo hice durante media sesión.
