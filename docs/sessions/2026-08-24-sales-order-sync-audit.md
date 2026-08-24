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

- Desplegar el worker y ejecutar el runbook: **la venta sigue parada** hasta
  entonces (lock puesto → el cron no la recupera solo).
- Revisar con `parked=1` si la parada de vacaciones dejó más ventas atascadas.
