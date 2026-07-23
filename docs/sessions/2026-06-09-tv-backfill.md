# Jornada 2026-06-09 — Backfill `source:tv` → cola de revisión Discogs

## Objetivo

Meter todos los productos de **Triple Vision** (`source:tv`) en la cola de
revisión de Discogs (pending-review), reenviándolos por el webhook de producto
del Worker de producción.

## Qué se hizo

1. Se creó el script
   `houseonly-worker/houseonly-worker/scripts/backfill-tv-auto.mjs`.
2. Se ejecutó en modo `--send` hasta completar todas las pasadas de reintento.

### El script, en breve

- Pide un token Admin de Shopify (client credentials) y pagina **todos** los
  productos con tag `source:tv`.
- Por cada producto con SKU, envía un webhook `products/create` **firmado con
  HMAC** a `?action=webhook-shopify-product&sync=1`, con reintentos y backoff
  ante 429/5xx.
- Tras cada pasada relee `?action=pending-review-list` y reenvía solo los SKU
  que aún no estén en cola, hasta `MAX_PASSES` (8) o hasta que no quede nada.
- Trata como "terminales" (no reintenta) las razones del server tipo
  `sku already mapped`, `no sku`, pre-orders no listados en Discogs, etc.
- Sin `--send` hace **dry-run** (solo cuenta lo que enviaría).

### Cómo ejecutarlo

```bash
cd houseonly-worker/houseonly-worker/scripts
SHOPIFY_ADMIN_CLIENT_ID=...  \
SHOPIFY_ADMIN_CLIENT_SECRET=...  \
PROD_BS=...  \
node backfill-tv-auto.mjs --send       # quitar --send para dry-run
```

(Los valores reales de las variables están en el gestor de secretos / la
configuración del entorno; no se guardan en el repo.)

## Resultado

```
TRIPLE VISION BACKFILL COMPLETE
source:tv products with a SKU : 122
In Discogs review queue       : 122
By status                     : {"pending":122}
```

- **122 productos** `source:tv` con SKU → **122 en la cola de revisión**,
  estado `pending`. 0 fallos, 0 saltos terminales.
- Pasada 1: 53 ya estaban en cola, se enviaron los 69 restantes.
- Pasada 2: 122/122 confirmados → terminado.

## Git

- Rama `claude/focused-dijkstra-rfwbt4` → **PR #1**, mergeado a `main`
  (commit verificado `6f12fe7`, merge `81d6a18`).

## Notas / aprendizajes

- El push falló al principio con `403` porque la GitHub App **Claude** estaba
  *autorizada* (OAuth) pero **no instalada** en el repo con permiso de escritura.
  Se solucionó instalando la app en la cuenta `telsnap-stack` con acceso
  *Read and write* a *code*. (El repo es público → la lectura/clonado siempre
  funcionó; solo faltaba escritura.)
- "Acceso a la red: Completo" en el entorno de Claude Code es la **política de
  red** (salida a internet), no el permiso de escritura de GitHub.

## Pendiente / siguientes pasos

- Revisar/aprobar los 122 registros en la cola (`pending-review-approve` /
  dashboard) cuando toque.
- (Opcional) borrar la rama `claude/focused-dijkstra-rfwbt4` ya mergeada.
