# 2026-11-05 — Subwax Player (`/subwax/`)

Player de la stocklist de Subwax Distribution para escuchar los discos y armar
el Order Form / Pre-order Form, servido por Pages y con los datos en el worker.
Sustituye al `Subwax_Player.html` local de la semana pasada.

## Qué hay

- **Worker** `src/lib/subwax.ts`
  - `subwax-refresh` (POST, Bearer; también dentro de `DAILY_CRON`): baja la
    Google Sheet pública de Subwax como **xlsx** (`export?format=xlsx`, único
    formato que conserva los `HYPERLINK` de la columna LISTEN; CSV y gviz
    devuelven solo el rótulo), la parsea con `fflate` + regex, y guarda en
    `SYNC_STATE` `subwax:stock` `{updated_at, rows, gone}`. Guarda `first_seen`
    por catno (marca «nuevo» en el player) y los que desaparecen pasan a
    `gone` 90 días (pestaña Agotados). Si la hoja deja de ser pública o viene
    con menos de 20 filas, **no pisa** la anterior.
  - SoundCloud: los enlaces de Subwax son privados (`…/s-TOKEN`) y el widget
    no los acepta por URL; se resuelven con `soundcloud.com/oembed` a
    `api.soundcloud.com/tracks/ID?secret_token=…`, **30 por pasada**
    (`&resolve=N`, tope 60) para no agotar subpeticiones. `&only=resolve`
    hace solo una pasada de audio sobre lo guardado (sin bajar la hoja ni
    tocar Shopify); el player encadena esas llamadas, de 40 en 40, hasta que
    no queden pendientes (~11 llamadas la primera vez en cada entorno). 3 enlaces de la hoja dan 404 en
    SoundCloud (BLDRMX02, KETIOV007, PSI003): salen como «solo en SoundCloud».
  - Tienda: `searchVariantsBySkus` con todos los catnos (lotes de 40), match
    exacto o sin separadores → `row.shop {sku, qty, status}`.
  - `subwax-order` (POST): libro de pedidos en `subwax:orders`
    (`op: add | status | delete`; estados draft/sent/received/cancelled). Un
    `add` de `kind: preorder` deja esos catnos como **elegidos** en la bandeja
    del tab Pre-order (`marcaElegidosPorCatno`, en `listen.ts`; levanta el
    rechazo si lo había; no toca los cargados).
  - `subwax-stock` (GET): stock + última pasada + pedidos + `bandeja`
    (decisión por catno de los discos SUBWAX de la bandeja, solo metadata).
- **Frontend** `public/subwax/index.html` (página estática, fuera del bundle):
  mismo login que `/admin` (`admin-check`, secreto en memoria, llavero del
  navegador), ExcelJS desde cdnjs, plantilla `public/subwax/Order_Form.xlsx`.
  Pestañas Novedades / Catálogo / Pre-orders / Agotados; carrito de pedido y
  carrito de pre-order separados (localStorage); al descargar el .xlsx se
  anota el pedido en el worker. Marcas por disco: nuevo · en tienda · pedido
  N× · bandeja: elegido/pendiente/rechazado. «Traer elegidos de la bandeja»
  mete 2 copias de cada elegido de Subwax aún no pedido. Worker según host
  (`houseonly.store` / `houseonly.pages.dev` → prod; el resto → staging;
  `?worker=` para forzar).
- **Admin**: pestaña `🎧 Subwax` (`SubwaxPanel`) con el enlace a `/subwax/` y
  el resumen (discos, en tienda, con audio, pedidos, elegidos en bandeja).

## Decisiones

- La fuente del inventario es la Google Sheet, no los correos: el correo
  semanal solo trae las novedades de pre-order y enlaza a la misma hoja.
- La bandeja manda en los pre-orders (es la que sube a la tienda con audio y
  portada); el player decide *qué pedir* y exporta el formulario. Para evitar
  decidir dos veces, exportar un Pre-order Form = marcar elegidos.
- El Order Form normal no pasa por la bandeja (la bandeja solo recibe
  pre-orders); la llegada se suma con «Add stock» de la factura, como hasta ahora.
- Pre-order Form: misma plantilla del Order Form con título «PRE-ORDER FORM»
  hasta que Subwax mande la suya.

## Despliegue

Worker: `npm run deploy:staging`, probar `staging.houseonly.pages.dev/subwax/`
(rama `staging`), luego `npm run deploy` + merge a `main`. La primera carga en
cada entorno tarda: ~14 pasadas de 30 enlaces de SoundCloud (el player las
encadena solo; mientras, los discos salen como «resolviendo audio…»).
