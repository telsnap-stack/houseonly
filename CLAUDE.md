# CLAUDE.md — HOUSE ONLY

Memoria de proyecto para Claude Code. Se lee automáticamente al inicio de cada
sesión. Mantener **conciso y estable**; el detalle del día a día va en
`docs/sessions/`.

## Qué es esto

Tienda **HOUSE ONLY** (vinilos / música). Dos partes en el repo:

- **Frontend** (raíz): app React + Vite. Build con `npm run build`.
- **Worker** (`houseonly-worker/houseonly-worker/`): Cloudflare Worker que
  conecta Shopify ↔ Discogs y sirve la API de la tienda.
  - Prod: `https://houseonly-worker.emontagut.workers.dev`
  - Tienda Shopify: `house-only-2.myshopify.com` · Admin API `2026-04`

## Conceptos clave del Worker

- **Tags de origen (`source:*`)** marcan de qué importador viene cada producto:
  `source:dbh` (DBH), `source:tv` (Triple Vision), etc. Reemplazan a los tags
  legacy sin prefijo.
- **Sync Discogs (Fase 3.5)**: al crear un producto en Shopify, el webhook
  `webhook-shopify-product` corre el matcher de Discogs. Matches altos/por
  barcode se listan como Draft (en modo live); el resto va a la **cola de
  revisión** (pending-review).
- **Modos** (Bearer `BOOTSTRAP_AUTH_SECRET`): `sync35-mode` controla dry/live.

### Endpoints relevantes (`?action=...`)

| Action | Método | Notas |
|---|---|---|
| `webhook-shopify-product` | POST | Webhook `products/create`. Firmado HMAC. `&sync=1` fuerza proceso síncrono. |
| `pending-review-list` | GET | Cola de revisión Discogs. Bearer `BOOTSTRAP_AUTH_SECRET`. |
| `pending-review-approve` | POST | `{sku, release_id}` → crea listing. |
| `pending-review-reject` | POST | `{sku}` → descarta. |
| `sync35-mode` | GET/POST | dry/live del auto-list. |

## Scripts de operación (`houseonly-worker/houseonly-worker/scripts/`)

Scripts Node de un solo uso (backfills, migraciones, diagnóstico). Convención:
ejecutar **dry-run por defecto**, flag explícito para aplicar.

| Script | Qué hace | Aplicar con |
|---|---|---|
| `backfill-tv-auto.mjs` | Reenvía productos `source:tv` al webhook para meterlos en la cola de revisión Discogs. Reintenta en varias pasadas hasta que todos los SKU estén en cola. | `--send` |
| `backfill-dj-auto.mjs` | Ídem para `source:dj` (pedido Deep Jungle 2026-07). Ejecutar tras desplegar el worker con `source:dj` en `ACCEPTED_SOURCE_TAGS`. | `--send` |
| `backfill-dbh-tag.mjs` | Renombra el tag legacy `dbh` → `source:dbh`. | `--commit` |
| `migrate-*.mjs`, `register-products-create-webhook.mjs`, `diagnose-webhooks.mjs`, `test-product-webhook-signed.mjs` | Migración/registro/diagnóstico de webhooks. | ver cabecera |

### Variables de entorno (nunca commitear sus valores)

- `SHOPIFY_ADMIN_CLIENT_ID` / `SHOPIFY_ADMIN_CLIENT_SECRET` — Custom App
  `houseonly-backorder` (client credentials). El secret también firma el HMAC
  de los webhooks.
- `PROD_BS` — `BOOTSTRAP_AUTH_SECRET` de prod (Bearer para endpoints admin).

## Convenciones

- Rama de trabajo por tarea (p. ej. `claude/...`); PR a `main`.
- Antes de tocar Cloudflare/Workers, ver `houseonly-worker/houseonly-worker/AGENTS.md`.
- Cada jornada de trabajo se documenta en `docs/sessions/AAAA-MM-DD-*.md`.

## Bitácora (jornadas)

Ver `docs/sessions/`. Última: `docs/sessions/2026-07-23-deep-jungle-import.md`.
