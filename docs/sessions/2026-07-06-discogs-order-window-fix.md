# 2026-07-06 — Fase 3H: Discogs poll window fix (order 147628-C-2 no-show)

## Síntoma

Pedido Discogs pagado **147628-C-2** (status *Payment Received*, creado 6 jul
2026 14:41 CEST) no apareció en Shopify. Worker prod en `live`, Fase 3G
desplegada (commit `772a97a`), cron cada 15 min sano.

## Diagnóstico

- `meta:last_polled_ts` (vía `?action=sync-status`, público) =
  `2026-07-06T05:41:58-07:00` → **12:41:58 UTC = 14:41:58 CEST**, es decir
  **exactamente la hora de creación del propio pedido**. El cursor no estaba
  *antes* del pedido: ya había avanzado *hasta* él.
- Discogs devuelve los timestamps de pedido en la zona de la cuenta (Pacífico,
  −07:00). `created_after` es **exclusivo** (el poll de las 13:30 UTC examinó 0
  pedidos con el cursor justo en la hora de un pedido existente → no lo
  reincluye).
- Shopify: **0** pedidos con tag `source:discogs` (nunca), **0** draft orders
  → `createDiscogsOrder` no llegó a ejecutarse para este pedido.
- `src/lib/sync.ts` trata el id de pedido como string opaco en todas partes
  (`String(order.id)`, claves KV, `getOrder`, tag/nota). El segmento con letra
  ("C") **no** rompe nada → la teoría del formato de id queda descartada.

### Causa raíz

El cursor se basaba en `created`, pero el evento accionable es una
**transición de estado** (→ *Payment Received*) que ocurre *después* de la
creación. El cursor high-water avanzaba más allá del pedido la primera vez que
se veía (cuando aún era *New Order* / *Payment Pending*); `created_after`
(exclusivo) lo excluía para siempre, así que al pagarse nunca se convertía en
pedido de Shopify.

## Arreglo (Fase 3H, `sync.ts`)

- **Ventana móvil** en lugar de cursor high-water: en cada run se re-escanean
  los pedidos creados en los últimos `POLL_LOOKBACK_DAYS` (10). Un pedido visto
  pre-firm se vuelve a examinar y se procesa cuando pasa a firme.
- **Paginación** de la ventana (orden `desc`, hasta `MAX_POLL_PAGES`=20) para
  que una ventana con >50 pedidos no oculte pedidos recientes.
- **`lock:order:{id}` TTL 60d** (`ORDER_LOCK_TTL_SECONDS`), que **debe** superar
  la ventana: es la única garantía contra crear un segundo pedido pagado
  (factura duplicada) mientras el pedido sigue dentro de la ventana.
- `meta:last_polled_ts` se sigue escribiendo (más reciente visto) pero solo como
  observabilidad; **ya no** controla el fetch.

Tests nuevos en `test/index.spec.ts` (`pollDiscogsForSales — pending→firm`):
pre-firm se salta sin lock/audit; el mismo pedido se procesa al pasar a firme en
un poll posterior; idempotencia evita duplicados. (Los 4 tests scaffold
`Hello World`/`/random` ya fallaban antes de este cambio — rutas obsoletas.)

## Despliegue / recuperación

- Migración segura: los locks del código viejo eran de 24h y ya expiraron, pero
  como **no existe ningún pedido `source:discogs` en Shopify**, re-escanear la
  ventana no puede duplicar nada al desplegar.
- Tras `wrangler deploy`, el próximo cron recuperará **147628-C-2**
  automáticamente **si** se saltó estando pendiente (sin `lock:order`). Si
  existe `lock:order:147628-C-2` / `sales-detected:147628-C-2` (se intentó y
  falló, p. ej. item sin mapear), hay que borrar el lock y arreglar el mapeo
  antes de que se reprocese. (No se pudo leer esas claves KV: sin
  `CLOUDFLARE_API_TOKEN` en el entorno; `wrangler kv key get --remote` requiere
  auth.)
