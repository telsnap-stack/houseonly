# 2026-07-26 — Backfill de SKU en listings Discogs + deploy pendiente

Detonante: la venta Discogs **#147628-20** (Orca – Dancing With Dolphins
Vol. 2, listing 4269081744) no sincronizó. El pedido Shopify **#1024** se creó
a mano (pagado, taxExempt, source:discogs).

## Diagnóstico

- El lote Deep Jungle se listó en Discogs (sesión aparte) **sin
  `external_id`/`location`**, así que el worker no podía resolver
  listing → SKU → variante Shopify.
- La auditoría `sales-detected:147628-20` confirmó que el 3H self-heal SÍ
  corrió en prod: resolvió por catno de Discogs → `"DAT 114"` (con espacio) →
  `findVariantBySku` → **`variant_not_found`** (el SKU Shopify es `DAT114`).
  Conclusión: el fallback por catno es frágil; `external_id` es la vía fiable.
- El self-heal además cacheó mapeos envenenados (`sku:DAT 114`,
  `listing:4269081744`) → borrados.
- `lock:order:147628-20` estaba puesto (TTL hasta 2026-09-24) → **el pedido
  #1024 no se puede duplicar**. El lock se conservó; solo se borró la entrada
  forense `sales-detected:`.
- Ojo herramienta: `wrangler kv key list` devuelve `[]` silenciosamente detrás
  del proxy del entorno remoto — usar la API REST de Cloudflare para KV.

## Backfill (`scripts/backfill-discogs-sku.mjs`, nuevo)

Dry-run → 663 listings live, **257 sin `external_id` y/o `location`** (94 del
lote DJ + 163 del catálogo antiguo). Verificación de los 257 catnos contra el
dump completo de SKUs de Shopify (MCP):

- **168 match exacto → escritos** (`--send --map approved-map.json`, 0 fallos).
  Corrección manual clave: de los 2 listings de DAT082, el S/Edition amarillo →
  `DAT082-COL`; el negro → `DAT082`.
- **63 fuzzy** (61 con sugerencia única) pendientes de decisión: familias
  `SOUL:R064`→`SOULR064`, `FOKUZ109`→`FOKUZ109_`, sufijos repress
  (`SIG019`→`SIG019RP`…), sueltos (`CAT016`→`CAT-016`, `TEXT042`→`TEXT042LP`).
  **`DAT088`**: 1 listing Discogs vs 2 productos Shopify (A/B, C/D) — decidir.
- **26 sin producto Shopify** — sin tocar (stock solo-Discogs).

## Post-backfill

- **Deploy** del worker desde main (por fin con credenciales):
  versión `a0a3f5d7-74d3-4d95-afd5-3c9bf2393534`. Con Account API Token,
  wrangler necesita `CLOUDFLARE_ACCOUNT_ID` para saltarse `/memberships`.
- **336 mapeos KV** escritos por bulk REST (`sku:` + `listing:` de los 168) —
  sustituye al `sync-bootstrap` y, de paso, hace que el webhook salte los
  productos DJ como "sku already mapped": **NO ejecutar `backfill-dj-auto.mjs`**
  para los ya listados (crearía listings duplicados). DAT088 A/B y C/D no
  tienen mapeo → excluirlos si algún día se corre.

## Pendientes

- [ ] Decidir los 63 fuzzy (aplicar `fuzzy-map.json` en bloque, por familias, o
      revisión manual) y `DAT088`.
- [ ] Renovar el token de Cloudflare en 1Password (el guardado caducó
      2026-05-20; el nuevo es Account Token con Workers Scripts + KV Edit).
