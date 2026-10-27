# eBay — tercer canal de venta

Código: `houseonly-worker/houseonly-worker/src/lib/ebay.ts` (orquestación),
`ebay-api.ts` (cliente REST), `ebay-listing.ts` (contenido del anuncio).
Tests: `test/ebay.spec.ts` (respuestas de eBay, Shopify y Discogs simuladas). Admin: pestaña
**🛒 eBay**.

Estado a 2026-10-26: **código listo, claves pendientes de aprobación por eBay.**
Sin claves todo responde "not configured" y no se llama a eBay.

## Cómo funciona

| Pieza | Qué hace | Interruptor (KV `SYNC_STATE`) |
|---|---|---|
| Entrada automática | Cada producto nuevo (webhook `products/create`, el mismo del auto-add de Discogs) entra en la cola `ebay:item:{SKU}`. Entra antes de los filtros de Discogs, así que un producto que Discogs ignora también es candidato. No entra con `?sync=1`, que son los reenvíos de los scripts de backfill de Discogs. | `meta:ebay_autolist_mode` = live |
| Backfill | `ebay-backfill` (botón del admin) mete el catálogo existente por tandas. La primera es de **5**, para revisar a ojo; las siguientes, de 25 (o `count`, máx. 100). Solo entra lo activo, con stock y que no es pre-order, del más antiguo al más nuevo. Si se interrumpe, continúa donde lo dejó (`meta:ebay_backfill`). | — |
| Backfill continuo | Desde 2026-10-27, en el cron, después de la pasada: si no queda ningún disco `queued` ni `would_list` (los retenidos no cuentan), mete la siguiente tanda de 25, hasta acabar el catálogo. Solo con el auto-list en live y si la pasada no se paró; respeta la pausa por 25026 y el límite de venta (75.000/mes: el cuello de botella es Discogs, 60 lecturas/min por IP). | `meta:ebay_autobackfill_mode` = `off` para pararlo |
| Pestaña eBay | Muestra la cola y permite **excluir** un disco o **volver a meterlo**. No es la vía de entrada. Un excluido no vuelve a entrar ni por el webhook ni por el backfill. | — |
| Auto-list | Cron propio `3,18,33,48 * * * *` (EBAY_CRON). Cada pasada revisa hasta 40 discos de la cola (primero los no revisados, luego los de revisión más antigua) y publica hasta 10: `createOrReplaceInventoryItem → createOffer → publishOffer`. | `meta:ebay_autolist_mode` dry/live (dry por defecto) |
| Conciliación SKU↔Discogs | **Nuevo en el cron** (`runRelinkCron`, en el hueco de las :03). Recorre una página del inventario de Discogs por pasada (For Sale, luego Draft, y vuelta a empezar) con las mismas reglas que `sync-relink&commit=1`. Va **después** de la pasada de eBay y del backfill, en serie. Si la pasada acaba de recibir un 429 de Discogs, se salta (misma página en la siguiente pasada) y la pasada deja de leer Discogs ese turno. | `meta:relink_cron_mode` = `off` para pararla |
| Venta en Shopify o Discogs | El webhook `orders/create` retira la oferta de eBay (`withdrawOffer`). | ninguno |
| Venta en eBay | Cron (`getOrders`) **y** notificación `ORDER_CONFIRMATION` → pedido pagado en Shopify (`createDiscogsOrder` con canal eBay). Ese pedido dispara el webhook, que retira el listing de Discogs. | `meta:ebay_sync_mode` dry/live (dry por defecto) |

**Guarda de Tienda eBay (2026-10-27).** Un vendedor profesional sin
suscripción de Tienda no tiene anuncios gratis: cada anuncio paga tarifa de
inserción (0,35 € al mes). Antes de publicar, cada pasada con trabajo llama a
`GET /sell/account/v1/subscription`. Si no hay una suscripción con
`subscriptionType` = `STORE_PLAN` en `EBAY_ES`, o si la llamada falla, la pasada
corre en **dry** aunque el interruptor diga live (`store_guard` en el resumen) y
el backfill continuo no mete nada. La pestaña muestra un aviso naranja con lo
que devolvió eBay (`meta:ebay_store_check`). Respuesta real con la Tienda
Avanzada activa (2026-10-27): `{"subscriptionType":"STORE_PLAN",
"subscriptionLevel":"Featured","marketplaceId":"EBAY_ES","term":{"value":1,"unit":"MONTH"}}`.
Antes de activarla, eBay devolvía `{"total":0}`.

**Nada de esto lee ni escribe `meta:sync_35_mode`.** El auto-add de Discogs
sigue en `dry` (verificado 2026-10-26) y eBay funciona sin él.

### Precio: nunca el de Shopify, nunca adivinado

1. **Listing de Discogs del disco** (`sku:{SKU}` → `GET /marketplace/listings/{id}`):
   su precio **actual**, en EUR, **redondeado hacia arriba a ,99** (12,97 → 12,99;
   21,23 → 21,99; 12,99 se queda). La pestaña muestra los dos precios. Se lee al publicar, máximo 10 lecturas de
   Discogs por pasada. Sin listing enlazado, el disco se queda **retenido**
   (`esperando_discogs`) y el cron lo vuelve a mirar en cada pasada hasta que
   exista. Si el listing está vendido o no está en EUR, también queda retenido.
2. **Discos marcados como "no van a Discogs"** con el tag de Shopify
   **`discogs:no`**: coste unitario de Shopify (`inventoryItem.unitCost`) × el
   multiplicador de `meta:ebay_cost_multiplier` (2 por defecto), **redondeado
   hacia arriba a ,99** (3,45 × 2 = 6,90 → 6,99). Sin coste, se
   quedan retenidos como **`sin_fuente_de_precio`**. La pestaña los marca en
   naranja y no se publican.

#### De dónde sale el listing de Discogs: el snapshot (desde 2026-10-27)

Leer un listing por disco no funcionaba. Discogs cuenta su cupo de 60/min por
IP, y la IP de salida de Cloudflare es compartida, así que casi todas las
pasadas se quedaban en 429 y retenían todo. Ahora el precio, el estado y los
grados salen de un **snapshot de nuestro inventario** en KV (`discogs:snapshot`).

- **Semilla**: el CSV que exporta Discogs del inventario (export de hoy cargado
  a mano en prod). En el CSV no hay moneda, así que se asume EUR. Los grados
  `MINT`/`NEAR_MINT`/`GENERIC`… se convierten a los textos de Discogs
  ("Mint (M)", …). La hora del snapshot es la del nombre del fichero (UTC).
- **Renovación (cron :03, antes de la pasada)**:
  - Lee `GET /users/houseonly/inventory` en páginas de 100, ordenado por fecha
    de alta ascendente (~10 llamadas).
  - **Sin reintentos de 429**: al primer 429 guarda por dónde iba
    (`discogs:snapshot:building`) y sigue en la pasada siguiente.
  - Al terminar, sustituye al snapshot. Su hora es la de **inicio** de la lectura.
  - Con un snapshot de menos de 1 h no lee nada; una lectura a medias de más de 12 h vuelve a empezar.
  - Resultado en `meta:discogs_snapshot_last_refresh`. Si se lleva un 429, la
    conciliación de esa pasada se salta.
- **Caducidad: 48 h**. Pasado ese tiempo, o si no hay snapshot, los discos
  esperan (`discogs_snapshot_caducado`), no se llama a Discogs y el admin
  muestra un aviso naranja.
- Si el snapshot vigente no tiene un listing, se pide ese listing a la API
  (dentro del tope de 10 lecturas por pasada).
- **Plan B**: en el admin, "subir CSV de Discogs" (`?action=discogs-snapshot`,
  POST con el CSV y `&name=` el nombre del fichero). Rechaza un export más viejo que el snapshot en uso.
- Un disco vendido en Discogs después del snapshot no se publica igualmente:
  la venta baja el stock en Shopify y la pasada retiene lo que no tiene stock.

**Precio mínimo** (`meta:ebay_price_floor`, por defecto **12,99 €**, desde
2026-10-27): se aplica a todo precio de eBay, venga de Discogs o del coste.
Lo que quede por debajo sube a ese valor, y el origen del precio lo anota
(`…; floor 12.99`). `"0"` lo desactiva. Los anuncios ya publicados no se
recalculan.

El tag `discogs:no` es nuevo: hasta ahora no había forma de marcar un disco
como "no va a Discogs" (el rechazo de pending-review caduca a los 7 días y
significa "match equivocado", no "no va a Discogs"). Se pone a mano en Shopify.

Coste unitario a 2026-10-26: **961 de 1.524** productos lo tienen (957 de los
1.514 activos; 602 de los 1.119 con stock). Por origen: DBH 208/208, TV
165/167, RD 129/130, MT 39/39, Kudos 14/14, W&S 219/562, **DJ 0/96**, sin tag
`source:` 187/308.

### Por qué la conciliación tenía que ir al cron

Antes, `sku:{SKU}` solo se creaba:
- en el bootstrap, y solo para listings con `external_id`;
- en el auto-add, que está en dry;
- en `sync-relink`, a mano;
- o en el poll, cuando el disco ya se había **vendido** en Discogs.

Un listing hecho a mano en Discogs se quedaba sin enlace hasta venderse. Eso
deja a eBay sin precio y deja sin efecto el delist de Discogs cuando el disco
se vende en la web (el caso 147628-C-31).

Ahora hay una página por pasada: 878 For Sale + 14 Draft ≈ 10 pasadas,
~2,5 h por vuelta completa. Escribe solo los matches inequívocos (un único SKU
exacto). Ambiguos, conflictos y vendidos se quedan para `sync-relink` a mano.
A 2026-10-26 prod tenía 819 claves `sku:`.

### Contenido del anuncio

Sale del producto de Shopify: título (`Artista - Título CATNO Vinilo`, máx. 80),
descripción, nuestras fotos y 1 unidad.

- **Item specifics** (nombres de eBay para 176985 en EBAY_ES, comprobados el
  2026-10-27): `Artista` (vendor), `Género` y `Subgénero` (nuestro `genre:`
  traducido a los valores de eBay; p. ej. Deep House → DJ, dance, house /
  House; tabla `EBAY_GENRE` en `ebay-listing.ts`). eBay no tiene aspecto para
  sello ni nº de catálogo: van como específicos propios (`Discográfica`,
  `Número de catálogo`) porque se busca por ellos.
- **Grados**: solo en **usados** (aspectos, tabla y `conditionDescription`), y
  los del listing de Discogs. En un NEW no se ponen: "Near Mint" en un nuevo
  parece de segunda mano. Un usado sin grado se queda retenido
  (`usado_sin_grado`).
- **Envío**: se quitan de la descripción las frases de envío que trae Shopify
  ("Worldwide shipping from House Only.", "envío…", Canarias). El envío lo dice
  la política de eBay.
- **Catálogo (ePID)**: se manda el EAN y se usa
  `includeCatalogProductDetails: false`. Si eBay rechaza el anuncio, se
  reintenta una vez sin el EAN real.
- **Sin código de barras** (o con uno no válido): `product.ean = ["No aplicable"]`,
  el texto de "no aplica" de eBay España (nota de `Product.ean` en la Inventory
  API → página "Product Identifier Text"). EBAY_ES exige EAN en 176985: sin él,
  `publishOffer` falla con **25002 "El campo EAN está vacío"**. Los discos que
  fallaron así antes del arreglo (2026-10-27) vuelven solos a la cola en la
  siguiente pasada (`requeueEanFailures`).
- No se añade texto de envío ni de Canarias.
- **Categoría de la tienda** (`storeCategoryNames`, ruta completa: `["/House"]`).
  Mapa editable en KV `meta:ebay_store_category_map`:
  `{"by_tag": {"minimal": "Minimal", …}, "by_genre": {"house": "House", …}}`.
  Primero `by_tag` (tag crudo, sin mayúsculas: recoge lo que la taxonomía deja
  como sub-tag, p. ej. "Minimal", cuyo canónico es techno), luego `by_genre`
  (id de `genres.mjs`; techno → "Techno" desde 2026-10-27). Sin mapa en KV, valen los de `EBAY_STORE_CATEGORY_DEFAULTS`.
  Solo se manda un nombre que la tienda tenga: la lista se lee con Trading
  **GetStore** (la Stores API REST pide el scope `sell.stores`, que nuestro
  consentimiento no tiene) y se cachea 6 h en `meta:ebay_store_categories`.
  Sin coincidencia, o si GetStore falla sin caché, el anuncio sale igual, sin
  categoría (eBay lo pone en "Other"). Modificar un anuncio es gratis en eBay
  (salvo mejoras o subir el precio).
- **Retenidos**, se revisan en cada pasada: pre-order (hasta que gradúe), sin
  stock, sin foto, no activo, no está en Shopify.

### Límites de venta

- `publishOffer` con error **25026**: se para la tanda, el disco sigue
  pendiente y el cron se pausa 24 h (`meta:ebay_limit_hit`).
- El backfill se niega a meter más durante esa pausa y limita cada tanda para
  que publicados + pendientes no superen `sellingLimit.quantity`
  (`GET /sell/account/v1/privilege`). Si la cuenta no tiene ese límite, no se
  aplica tope.

### Una sola instancia

Prod y staging tienen `SYNC_STATE` distinto: sus candados de pedido no se ven.
**eBay en live solo en un entorno.** El cron de eBay y la conciliación solo
están en la config de producción. Staging se prueba a mano con
`?action=ebay-run` y `?action=sync-relink`.

## Endpoints (`?action=…`)

| Action | Método | Auth |
|---|---|---|
| `ebay-notify` | GET (challenge) / POST (notificaciones) | firma de eBay (`X-EBAY-SIGNATURE`, 412 si no valida) |
| `ebay-mode` | GET / POST `{autolist?, sync?}` | GET público · POST Bearer |
| `ebay-items` | GET (cola desde metadatos; `&sku=` devuelve uno entero) | Bearer |
| `ebay-exclude` · `ebay-include` | POST `{skus}` | Bearer |
| `ebay-backfill` | POST `{count?, reset?}` (409 si el límite de venta lo impide) | Bearer |
| `ebay-run` | POST `{what: autolist\|orders\|both, force?}` | Bearer |
| `discogs-snapshot` | GET (edad, tamaño, progreso de la renovación) · POST CSV del export (`&name=` fichero) | Bearer |
| `ebay-store-categories` | GET (mapa, categorías de la tienda, nombres que faltan) · POST `{apply?}` (pone la categoría en los anuncios ya publicados; sin `apply` solo informa) | Bearer |

## Puesta en marcha (cuando eBay apruebe las claves)

Todo en **staging** primero. Los secretos se meten con `wrangler secret put`,
nunca en un chat.

1. **Keyset y RuName** (portal de desarrollador de eBay). Copiar App ID,
   Cert ID y el RuName del keyset de *producción*. En `.dev.vars`
   (fuera de git): `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME`,
   `EBAY_VERIFICATION_TOKEN` (32–80 caracteres `[A-Za-z0-9_-]`, inventado).
2. **Secretos del worker**:
   `npx wrangler secret put EBAY_CLIENT_ID --env staging` (ídem
   `EBAY_CLIENT_SECRET` y `EBAY_VERIFICATION_TOKEN`).
3. **Marketplace Account Deletion** (obligatorio para que eBay no corte las
   claves). En el portal: endpoint
   `https://houseonly-worker-staging.emontagut.workers.dev/?action=ebay-notify`
   y el mismo verification token. eBay hace el GET de challenge y el worker
   responde solo. No guardamos datos de usuarios de eBay fuera de las facturas
   de Shopify, así que el aviso solo se acusa (204).
4. **Consentimiento OAuth** (una vez, ~18 meses de validez):
   `node scripts/ebay-oauth.mjs consent`. Se abre la URL con la cuenta
   vendedora y se acepta. Luego
   `node scripts/ebay-oauth.mjs exchange '<URL de vuelta>' --env staging`.
   El refresh token va directo a `wrangler secret put`, sin imprimirse.
5. **Comprobar** (solo lectura): `node scripts/ebay-oauth.mjs check`.
   Confirma:
   - que **176985** existe en el árbol de EBAY_ES; si no, poner el bueno en KV
     `meta:ebay_category_id`;
   - los nombres de item specifics frente a `ASPECTS` en `ebay-listing.ts`, y
     cuáles son obligatorios;
   - las tres políticas por nombre;
   - que hay una ubicación de inventario. Si no la hay, crearla en Seller Hub;
     el worker no inventa direcciones. Para fijar una: `meta:ebay_location_key`.

   Para las políticas y la ubicación hace falta `EBAY_REFRESH_TOKEN` en
   `.dev.vars`.
6. **Notificación de ventas**:
   `node scripts/ebay-oauth.mjs subscribe https://houseonly-worker-staging.emontagut.workers.dev`
   crea el destino y la suscripción `ORDER_CONFIRMATION`.
7. **Prueba en dry**: pulsar "Backfill: primera tanda (5)" y luego "Pasada
   ahora". Se ven los 5 anuncios preparados (título, precio y de dónde sale,
   grados) o por qué están retenidos.
8. **Primer live**: Auto-list → live y "Pasada ahora". Revisar los 5 anuncios
   en ebay.es. Desde ese momento los productos nuevos entran solos; el resto
   del catálogo, con "Backfill: siguiente tanda". Sync de ventas → live solo
   cuando los primeros anuncios estén bien.

Riesgos a vigilar en la primera publicación:
- **GPSR / datos de seguridad de producto** en la UE. eBay puede pedir
  fabricante o persona responsable (`regulatory`). Si sale el error, se añade
  al offer.
- Que los nombres de aspectos en español no sean los de eBay.es. No impide
  publicar (eBay los acepta como específicos propios), pero resta en búsqueda.
