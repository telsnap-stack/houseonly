# eBay — tercer canal de venta

Código: `houseonly-worker/houseonly-worker/src/lib/ebay.ts` (orquestación),
`ebay-api.ts` (cliente REST), `ebay-listing.ts` (contenido del anuncio).
Tests: `test/ebay.spec.ts` (respuestas de eBay simuladas). Admin: pestaña
**🛒 eBay**.

Estado a 2026-10-26: **código listo, claves pendientes de aprobación por eBay.**
Sin claves todo responde "not configured" y no se llama a eBay.

## Cómo funciona

| Pieza | Qué hace | Interruptor (KV `SYNC_STATE`) |
|---|---|---|
| Selección | Disco a disco desde el admin (`ebay-select`). Cola en `ebay:item:{SKU}`. | — |
| Auto-list | Cron propio `3,18,33,48 * * * *` (EBAY_CRON). Tandas de 10: `createOrReplaceInventoryItem → createOffer → publishOffer`. | `meta:ebay_autolist_mode` dry/live (dry por defecto) |
| Venta en Shopify o Discogs | El webhook `orders/create` retira la oferta de eBay (`withdrawOffer`). Las ventas de Discogs llegan por ahí porque el poll las convierte en pedidos de Shopify. | ninguno (solo actúa sobre lo que está publicado) |
| Venta en eBay | Cron (`getOrders`, ventana de 10 días) **y** notificación `ORDER_CONFIRMATION` → pedido pagado en Shopify (factura, mismo camino que Discogs: `createDiscogsOrder` con canal eBay, tag `source:ebay`, atributo `ebay_order_id`). Ese pedido dispara el webhook, que retira el de Discogs. | `meta:ebay_sync_mode` dry/live (dry por defecto) |

**Nada de esto lee ni escribe `meta:sync_35_mode`.** El auto-add de Discogs
sigue en `dry` (verificado 2026-10-26 en prod y staging) y eBay puede ir en
live sin él. Tampoco hay un "publicar en los dos".

Hallazgo al verificar: el auto-add de Discogs **no es un cron**. Lo dispara el
webhook `products/create` y tampoco tenía interruptor en el admin (solo
`?action=sync35-mode` por curl). eBay sí va por cron, con selección manual
disco a disco.

### Contenido del anuncio

Todo sale del producto de Shopify: título (`Artista - Título CATNO Vinilo`,
máx. 80), artista (vendor), sello (`label:`), nº de catálogo (SKU), género
(`genre:`), descripción, precio EUR tal cual, nuestras fotos, 1 unidad.

- **Grados**: los del listing de Discogs si el SKU está enlazado (`sku:{SKU}`);
  si no, Mint. El estado (NEW/USED) sale de los tags de Shopify. Hoy no hay
  ningún tag de estado (1.524 productos, todo nuevo), así que todo va como NEW.
  Un usado sin grado de Discogs no se publica (`usado_sin_grado`).
- **Catálogo (ePID)**: se manda el EAN si es válido; eBay intenta casarlo solo.
  `includeCatalogProductDetails: false`, para que un match no pise nuestro
  título ni nuestras fotos con otra edición. Si eBay rechaza, se reintenta una
  vez sin EAN (anuncio suelto).
- No se añade texto de envío ni de Canarias. En las descripciones actuales no
  hay ninguno: los 45 "exclu…" son "exclusive track".
- No se publica: pre-order (`forthcoming`), sin stock, sin foto, sin precio,
  no activo.

### Límites de venta

`publishOffer` con error **25026** ("Selling limit exceeded") para la tanda.
El disco sigue en cola y el cron se pausa 24 h (`meta:ebay_limit_hit`). "Pasada
ahora" con `force` quita la pausa.

### Una sola instancia

Prod y staging tienen `SYNC_STATE` distinto: sus candados de pedido no se ven.
**eBay en live solo en un entorno.** El cron de eBay solo está en la config de
producción. Staging se prueba a mano con `?action=ebay-run`.

## Endpoints (`?action=…`)

| Action | Método | Auth |
|---|---|---|
| `ebay-notify` | GET (challenge) / POST (notificaciones) | firma de eBay (`X-EBAY-SIGNATURE`, 412 si no valida) |
| `ebay-mode` | GET / POST `{autolist?, sync?}` | GET público · POST Bearer |
| `ebay-items` | GET | Bearer |
| `ebay-select` · `ebay-unselect` | POST `{skus}` | Bearer |
| `ebay-run` | POST `{what: autolist\|orders\|both, force?}` | Bearer |

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
7. **Prueba en dry**: en la pestaña eBay, seleccionar 2–3 SKUs y pulsar
   "Pasada ahora" para ver el anuncio preparado (título, precio, grados).
8. **Primer live**: Auto-list → live y luego "Pasada ahora". Revisar el anuncio
   en ebay.es antes de seleccionar más. Sync de ventas → live solo cuando el
   primer anuncio esté bien.

Riesgos a vigilar en la primera publicación:
- **GPSR / datos de seguridad de producto** en la UE. eBay puede pedir
  fabricante o persona responsable (`regulatory`). Si sale el error, se añade
  al offer.
- Que los nombres de aspectos en español no sean los de eBay.es. No impide
  publicar (eBay los acepta como específicos propios), pero resta en búsqueda.
