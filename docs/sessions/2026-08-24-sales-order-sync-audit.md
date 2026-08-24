# 2026-08-24 — Venta Discogs 147628-33 no llega a Shopify (auditoría Fase 3I)

## Síntoma

Pedido Discogs **147628-33** pagado el 24 ago 2026 08:56 UTC (€390,81, comprador
Rodolfo Castelo, Almeirim / Portugal — confirmado por la notificación de PayPal,
`Id. de factura 147628-33`). No existe pedido en Shopify → sin decremento de
stock y sin factura para Shoptopus.

## Qué se pudo verificar (y con qué)

| Comprobación | Resultado |
|---|---|
| `?action=sync-status` (público) | `sync_3e_mode: "live"` → **no** hay regresión a dry |
| Último poll del cron (10:00:51 UTC) | `ok:true`, `orders_examined:5`, `firm_sales_found:2`, `skipped_duplicate:2`, 0 fallos → el cron **sí** está poleando |
| Shopify, pedidos desde el 18 ago (`created_at:>=2026-08-18`) | **0 pedidos** → no existe pedido ni duplicado para 147628-33 |
| Último `source:discogs` en Shopify | `#1033` = Discogs `147628-C-20`, 17 ago |

Las **2 ventas firmes** de la ventana (10 días) son `147628-C-20` (creada OK el
17 ago) y `147628-33`. Que las dos salgan como `skipped_duplicate` significa que
147628-33 **ya tiene `lock:order`**: un poll anterior (entre 09:00 y 09:45 UTC)
lo procesó, falló, y dejó el lock puesto.

→ **El lock bloquea el reintento.** Es intencionado (es lo único que evita una
factura duplicada al re-escanear la ventana), pero implica que el cron **nunca**
recuperará esta venta por su cuenta. Hay que intervenir.

### Detalle operativo aprendido

La búsqueda de pedidos de Shopify **no indexa el campo `note`**: buscar
`147628-C-20` devuelve 0 resultados aunque `#1033` lleva `Discogs order
147628-C-20` en la nota. Para comprobar si una venta de Discogs ya tiene pedido
hay que **escanear por fecha** (`created_at:>=…`) y comparar en local contra
`note` / `customAttributes.discogs_order_id`. Es lo que hace
`findOrderByDiscogsOrderId()`.

## Causa raíz (confirmada contra la API de Discogs)

El PDF del pedido (19 ítems, €390,81) y `GET /marketplace/listings/{id}` dan el
diagnóstico:

- Los 5 listings más nuevos (`43303…`) tienen **`external_id` vacío**, así que
  el self-heal cae al `catalog_number` de Discogs, que viene **con espacio**:
  `"DAT 114"`, `"DAT 125"`, `"DAT 126"`… Los SKU de Shopify **no** llevan
  espacio (`DAT114`). Resultado: `findVariantBySku("DAT 114")` → nada, y el
  mapeo erróneo queda **cacheado en KV**, así que el fallo es permanente.
- De esos 5, tres **sí** existen en Shopify (`DAT114`, `DAT124`, `DAT120`) y
  fallaron solo por el espacio. Los otros dos (`DAT125`, `DAT126`) **no están
  en Shopify a propósito**: se excluyeron del import de Deep Jungle por no
  tener artwork (ver `2026-07-23-deep-jungle-import.md`).
- Los 14 listings antiguos sí traen `external_id` (`DAT110`, `FR013`, …) y
  resolvían bien.

**Sigue abierto**: con el código anterior, 14 líneas resueltas deberían haber
generado un pedido parcial de 14 ítems, y no se creó **ninguno** (tampoco un
draft huérfano: el último draft previo es `#D31`, del 17 ago). Falta leer
`sales-detected:147628-33` y los logs del Worker para saber si la invocación
murió entera (¿límite de subrequests/CPU en un pedido de 19 ítems?) o si falló
`getOrder`. Requiere `CLOUDFLARE_API_TOKEN`.

## Recuperación aplicada (24 ago 2026)

Pedido Shopify **#1035** (bueno) creado a mano con el **mismo formato que
`createDiscogsOrder`**: `draftOrderCreate` → `draftOrderComplete(paymentPending:
false)`, `taxExempt: true`, tag `source:discogs`, nota `Discogs order
147628-33`, atributo `discogs_order_id`, envío a Almeirim (PT). Stock
decrementado una sola vez y factura disponible para Shoptopus.

- 17 líneas por `variantId` con **`priceOverride` al precio de Discogs**
  (15×€19,99, FR013 €21,99, DAT114 €22,99).
- 2 líneas **custom** (`DAT125`, `DAT126`, €22,99): no existen como producto en
  Shopify (excluidas del import por falta de artwork) y no se inventan; así la
  factura cubre los 19 ítems vendidos.
- Total **€390,81 = exactamente lo cobrado**.

**#1034 queda por cancelar a mano** (Shopify admin → #1034 → Cancel order,
*restock* sí, *refund* no: el cobro fue por PayPal/Discogs, no por Shopify). Fue
el primer intento, construido a precio de catálogo Shopify (€402,81 ≠ €390,81);
`orderCancel` está bloqueado por la política del MCP de Shopify. Si Shoptopus ya
emitió factura de #1034, hace falta rectificativa.

## Arreglo de código para las próximas ventas

1. **`skuCandidates()`**: cada origen de SKU aporta su forma tal cual **y** sin
   espacios, y se prueban en orden contra Shopify. Se cachea en KV **el
   candidato que Shopify reconoce**, nunca el primero que se nos ocurrió — así
   los mapeos ya envenenados (`listing:4330318059` → `"DAT 114"`) se corrigen
   solos en la siguiente resolución, sin tocar KV a mano.
2. **La factura se emite al precio de Discogs**: cada línea lleva
   `priceOverride` con `item.price` del pedido de Discogs, y el gasto de envío
   de Discogs se refleja como `shippingLine`. Antes se facturaba al precio de
   catálogo de Shopify, que es otro número — de ahí el descuadre de €12,00 en
   este pedido (y, previsiblemente, en los ~20 anteriores).
3. **El veto de factura parcial ahora cubre `variant_not_found`**, no solo
   `unmapped_listing`: si *cualquier* línea no resuelve, no se crea el pedido y
   la venta queda parada con `needs_manual` y la lista de líneas irresolubles
   en la auditoría. Facturar 14 de 19 no es un arreglo parcial, es un documento
   equivocado.

## Lo que quedó sin verificar

`sales-detected:147628-33` (qué falló exactamente: `unmapped_listing`,
`variant_not_found` o error de lookup) **no se pudo leer**: sin
`CLOUDFLARE_API_TOKEN` en el entorno y sin `wrangler login`, KV de prod es
inaccesible. Mismo muro que el 6 jul (ver
`2026-07-06-discogs-order-window-fix.md`). Por eso esta sesión, en vez de
adivinar, deja el diagnóstico **detrás del `BOOTSTRAP_AUTH_SECRET`**, que sí
está a mano.

## Arreglo estructural (Fase 3I)

`processDiscogsOrder()` se extrae del bucle del cron (comportamiento idéntico;
la suite sigue en 10 tests verdes previos + 11 nuevos) para que el reintento
manual pase por **exactamente** el mismo camino: un solo lock, el mismo veto por
ítem sin mapear, la misma auditoría. Tres endpoints nuevos, todos
`Authorization: Bearer $PROD_BS`:

| Action | Método | Qué hace |
|---|---|---|
| `sales-audit&order_id=…` | GET | Auditoría completa + estado del lock (`blocks_cron_retry`) + las claves `listing:`/`sku:` de cada ítem con su valor actual |
| `sales-audit[&parked=1]` | GET | Todas las ventas auditadas (30 d), `parked=1` = solo las que no generaron pedido |
| `sales-map` | POST | `{listing_id, sku}` → escribe las dos direcciones del mapeo |
| `sales-retry` | POST | `{order_id}` → borra el lock y reprocesa la venta una vez |

`sales-retry` **falla cerrado** ante cualquier duda de duplicidad: rechaza
(409) si la auditoría ya registra un pedido creado, si Shopify ya tiene un
pedido con ese id de Discogs, o si el pedido no está en estado firme; y devuelve
502 —sin crear nada— si no puede consultar Shopify. `{"force": true}` salta esos
guardas: usar solo tras comprobar Shopify a mano.

## Runbook para 147628-33 (tras `wrangler deploy`)

```sh
W=https://houseonly-worker.emontagut.workers.dev

# 1. Por qué falló, y qué mapeo falta
curl -s -H "Authorization: Bearer $PROD_BS" "$W/?action=sales-audit&order_id=147628-33" | jq

# 2a. Si algún ítem sale como unmapped_listing → escribir el mapeo que falta
curl -s -X POST -H "Authorization: Bearer $PROD_BS" -H 'content-type: application/json' \
  -d '{"listing_id": <ID>, "sku": "<SKU>"}' "$W/?action=sales-map" | jq

# 2b. Si sale variant_not_found → el SKU de la variante en Shopify no coincide
#     con el external_id/catno del listing: corregir en Shopify (o remapear).

# 3. Reprocesar (crea el pedido pagado, decrementa stock, factura a Shoptopus)
curl -s -X POST -H "Authorization: Bearer $PROD_BS" -H 'content-type: application/json' \
  -d '{"order_id": "147628-33"}' "$W/?action=sales-retry" | jq

# Ventas paradas que nadie ha revisado (hacerlo también tras vacaciones)
curl -s -H "Authorization: Bearer $PROD_BS" "$W/?action=sales-audit&parked=1" | jq
```

## Pendiente

- **Desplegar** el worker (arreglo del espacio + veto + endpoints). Hasta
  entonces las próximas ventas de listings sin `external_id` seguirán fallando.
- Leer `sales-detected:147628-33` y los logs para cerrar el "por qué no se creó
  ni un pedido parcial" (necesita `CLOUDFLARE_API_TOKEN`).
- `DAT125` / `DAT126`: decidir si entran en Shopify o se dejan fuera del
  catálogo a sabiendas (hoy se venden en Discogs pero no existen en la tienda).
- Revisar con `parked=1` si la parada de vacaciones dejó más ventas atascadas.
- El pedido **#1034** no necesita nada más: el `lock:order:147628-33` sigue
  puesto, así que el cron no puede duplicarlo.
