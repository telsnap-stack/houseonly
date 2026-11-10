# 2026-11-08 — Feed de Google: `g:shipping_weight`

Merchant Center tenía los 1.265 productos en "Not approved" por "Missing
shipping weight" y "Missing shipping info in some countries": el envío se
calcula por peso y el feed no mandaba ninguno. El feed ahora lleva el peso de
la variante en Shopify y la fuente de Merchant Center se limitó a los países
con política de envío.

## Qué cambió

- **PR #219** (`claude/google-feed-shipping-weight`), squash a `main` como
  `87844ce`. `src/lib/google-feed.ts`:
  - La query de productos pide `inventoryItem { measurement { weight { value unit } } }`
    de cada variante. Comprobado antes del merge contra la tienda: FAT072 y
    BARN129 devuelven `0.45 KILOGRAMS`.
  - `pesoParaGoogle()` pasa `GRAMS`/`KILOGRAMS`/`OUNCES`/`POUNDS` a gramos
    enteros ("450 g"). Sin peso, peso 0 o unidad desconocida: se omite la
    etiqueta.
  - El peso de Shopify ya incluye el embalaje (450 g un LP, 900 g un 2LP…; la
    regla compartida está en `vinyl-weight.mjs`).
- Tests de `google-feed.spec.ts` ampliados.

## Despliegue

- `npm run deploy` desde `main` (`87844ce`), con todos los frenos en verde:
  contiene origin/main, 112 rutas (no se pierde ninguna), 0 líneas borradas,
  `src/` limpio, tests **639/639** (31 ficheros).
- Versión del worker **`c53d6d6f-1afc-4803-af7b-f8d95e652f28`**. Crons sin
  cambios: `7,22,37,52 * * * *`, `0 6 * * *`, `3,18,33,48 * * * *`,
  `41 * * * *`.
- El feed va cacheado en KV (`SYNC_STATE`): antes del rebuild seguía con 1.250
  items y 0 `shipping_weight`.
- `POST ?action=google-feed-rebuild` lo lanzó Eduardo con el Bearer tecleado
  sin eco (`verify-deploy.sh` no cubre este endpoint):
  `{"ok":true,"builtAt":"2026-11-08T08:15:30.901Z","count":1250,"activos":1693,"saltados":{"sin_stock":279,"sin_imagen":25,"forthcoming":139}}`.

## Verificación del feed público

`curl https://houseonly-worker.emontagut.workers.dev/?action=google-feed` →
200, `x-feed-built-at: 2026-11-08T08:15:30.901Z`, `x-feed-items: 1250`.
**1.250 de 1.250 items llevan `<g:shipping_weight>`:**

| Peso | Items |
|---|---|
| 450 g | 867 |
| 500 g | 243 |
| 750 g | 73 |
| 1050 g | 20 |
| 900 g | 17 |
| 230 g | 9 |
| 350 g | 7 |
| 180 g | 6 |
| 1350 g | 4 |
| 800 g · 1000 g · 1300 g · 1500 g | 1 cada uno |

## Merchant Center (a mano, Eduardo)

Cuenta `5807974617`, fuente "PRODUCTS SOURCE 3".

- Países del feed: de 36 a **21**, solo los que tienen política de envío.
  - Se quedan: España, Austria, Bélgica, Canadá, Chequia, Dinamarca,
    Finlandia, Francia, Alemania, Hungría, Italia, México, Países Bajos,
    Noruega, Polonia, Portugal, Rumanía, Suecia, Suiza, Reino Unido y EE. UU.
  - Se quitan: Chile, Colombia, Costa Rica, Croacia, Chipre, Georgia, Grecia,
    Irlanda, Liechtenstein, Luxemburgo, Marruecos, Eslovaquia, Turquía,
    Ucrania y Uruguay.
- Update de la fuente: Google releyó el feed a las 9:15 CET. Resultado: 1.250
  productos y el fichero sin errores.
- "Missing shipping weight" y "Missing shipping info in some countries": de
  1.265 (100 %) a 1.186 (93,9 %) en minutos. El resto debería limpiarse solo a
  medida que Google reprocese.

## Pendiente

- **2026-11-09:** comprobar en Merchant Center que Approved pasa de 0 y que
  los dos avisos siguen bajando.
- Si un producto llega al feed sin peso en Shopify, sale sin
  `g:shipping_weight` y volverá a salir en "Not approved". Hoy no hay ninguno
  (1.250/1.250).
