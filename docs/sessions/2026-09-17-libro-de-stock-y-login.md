# 2026-09-16/17 — Login del admin, libro de stock y los siete importers

Sigue a `2026-09-16-find-zips-rubadub.md` (primera mitad del 16). Todo lo de
abajo está en producción: main = `888ad13`.

## Géneros por disco y Bass Music (#51, #56)

- Rubadub: columna **Género** por disco. Por defecto vacío; lo que no resuelve
  va a la cola. El SALESPAPER preselecciona. No hay "aplicar a todos".
- `genres.mjs` separa **resolver** de **ser píldora**: `Bass Music` es canónico
  (resuelve) pero lleva `pildora: 'con-discos'` y no sale como píldora hasta
  tener discos. Regla: ninguna píldora puede dar cero.

## Admin: Bearer y login fuera del bundle (#52–#55, #59–#61)

Orden seguido: frontend mandando la cabecera, luego worker exigiéndola; staging
antes que prod.

- `upload`, `mirror`, `story-context` y `dbh-zip` exigen el Bearer de admin
  (`bearerAdminValido`, comparación en tiempo constante).
- `?action=admin-check`: el login valida el secreto contra el worker. La
  contraseña ya no va en el bundle; el secreto vive solo en memoria.
- `LoginScreen` es un `<form>` con usuario fijo `admin` y
  `autocomplete="current-password"`: el llavero de Safari/Chrome lo guarda.

### Rotación de `BOOTSTRAP_AUTH_SECRET`

Consumidores: worker (prod y staging) y el Apps Script de push del archivo de
emails. Rotación hecha por Eduardo en su terminal: prod el 16-09, staging el
17-09 (versión `78d790ad`). Verificado después: el push de Apps Script sigue
funcionando y los tokens viejos ya no valen. Se quitaron de
`.claude/settings.local.json` 10 entradas con tokens literales.

Lección: `wrangler secret put` hay que lanzarlo desde
`houseonly-worker/houseonly-worker/` (desde la raíz no hay config), y pegar con
`pbpaste | tr -d ' \n\r\t' | npx wrangler secret put … --env staging` para no
arrastrar saltos de línea.

## Portada y prosa del email correcto (#57, #58)

- Parser por bloques: la portada es la última imagen de portada dentro de la
  ventana del disco; la prosa se corta en la siguiente portada. La prosa de
  delante solo cuenta si el email tiene un único bloque.
- Rubadub usa portada y prosa del correo cuando el ZIP no las trae (FE005, FE008,
  UR-029r y WPA-4/ UR-079 venían solo con MP3).
- Apps Script (`saveDistributorEmails.gs`): si `getBody()` devuelve texto plano,
  saca el HTML del MIME en bruto (`htmlDelMensaje_`). `repararTextoPlano` rehízo
  17 emails. Backfill por semanas desde el 01-01 (#63): el de 300 conversaciones
  no pasaba del 17-08. Archivo tras el backfill: 517 emails, RD desde el 27-03.
- Sufijo `DUB` reconocido como formato (154854-AD002.zip = AD002dub).

## Add stock y libro de stock (#62, #71, #73)

Llegada de una factura a discos que **ya son productos**: no van en el CSV (que
fija la cantidad y borra el saldo pre-vendido), se **suman**.

- Worker `?action=stock-add` (Bearer). Dry-run por defecto. Comprueba
  `write_inventory` sin crear credenciales, una sola ubicación activa, SKU exacto
  y único, inventario con seguimiento. `inventoryAdjustQuantities` con
  `changeFromQuantity` (CAS) y clave idempotente.
- KV `STOCK_LEDGER` (compartido prod/staging, misma tienda):
  `stock:{DOCUMENTO}:{SKU}` → `aplicado` / `en-curso`. La misma factura no suma
  dos veces; lo dice.
- `?action=stock-csv`: al descargar el CSV de una factura se anotan sus SKUs como
  `aplicado` con `origen: 'csv'`, así un Add stock posterior con el mismo
  documento sale "ya aplicado".

Incidente **MEOW01**: el CSV lo dio de alta con cantidad 2 y después Add stock
sumó otros 2. Eduardo lo corrigió en Shopify; la anotación del CSV evita que se
repita.

## Completar media (#64–#67)

- Worker `?action=product-media` (Bearer, dry por defecto): a un producto que ya
  existe le añade solo lo que falta (portada, `<script id="tracks">`, texto si no
  tiene). Uno completo no se toca salvo `forzar`, que pone la portada nueva antes
  de desvincular la vieja (`fileUpdate`). API 2026-04: `productUpdate(product,
  media)`.
- Find ZIPs busca también los discos en tienda a los que Shopify les falta media.
- ZIPs que no casan: dicen cuál y por qué, y se asignan a mano con un desplegable.
- Con todos los discos en tienda, el importer dice "Sin CSV" en vez de no hacer
  nada.

## Los otros seis importers (#75)

W&S, Triple Vision, Kudos, DBH, Mother Tongue y Rush Hour hacen lo mismo que
Rubadub: marcan "en tienda", los sacan del CSV, Add stock + Completar media, y el
CSV anota su documento. Bloque común `EnTiendaBloque` / `BotonCsvImporter`.

| Importer | Número de documento | Clave |
|---|---|---|
| W&S | nombre del Excel (`264564.xlsx`; `InvRef` va vacío) | `WS-264564` |
| Triple Vision | "Invoice number:" del PDF | `TV-202632312` |
| Kudos | nombre del picking (`K235566 Picking Summary.csv`) | `KUDOS-K235566` |
| DBH | nombre del CSV (`…Order_89005…`) | `DBH-89005` |
| Mother Tongue | "FACTURA n°. 962/2026"; "ORDEN n°" = presupuesto, no suma | `MT-962-2026` |
| Rush Hour | `orderNumber` del JSON | `RH-1778948` |

Decisiones de Eduardo:

- **W&S**: los pre-orders ya no viajan en el CSV con Overwrite para graduar
  (fijaba la cantidad). Se suman con Add stock; el tag `forthcoming` lo quita la
  graduación del worker por fecha (`meta:graduation_mode` = `live` en prod).
  Las reposiciones sin ZIP entran para Add stock; se puede procesar el Excel sin
  ZIPs. Fuera `fetchForthcomingKeys`.
- **DBH**: la cantidad es `QTY Shipped`, no `QTY Ordered`.
- **Kudos**: la exportación pasa a filas comunes. El género se resuelve solo al
  exportar (resolverlo en cada render llenaría la cola).

Probado con los ficheros reales de cada distribuidor contra el catálogo real y
el worker interceptado: DBH 25 en tienda, RH 16, TV 23, W&S 41, Kudos 20; Mother
Tongue 962: 0 en tienda y 16 al CSV (confirmado por Admin API que no existen).

**Sin probar con una factura nueva real.** Y ojo: esos cinco documentos (DBH-89005,
RH-1778948, TV-202632312, WS-264564, KUDOS-K235566) se importaron por CSV antes
del cambio y **no están en el libro**: Add stock con ellos sumaría dos veces.

## Portadas de TV

El logo de cabecera de los mails de Triple Vision (mcusercontent, 1598×339) no
está como portada en ningún producto: revisados 1353 publicados, 98 sin publicar
y 2 borradores.

## Promociones

Protocolo: despliegue de vuelta atrás anotado, worker antes que frontend,
fast-forward o cherry-pick, sitemap comparado tras el build, bundle servido
verificado. Última: main `c0c9f90 → 888ad13` (FF), vuelta atrás Pages
`6cc59d3a`; sitemap 1528. Durante una promoción anterior #68 se coló en main al
moverse staging; se verificó el mismo bundle y se dejó.

## Pendiente

1. Primera factura real de cada uno de los seis importers (Add stock en dry-run
   primero).
2. Presupuesto → factura: el CSV de un presupuesto no anota nada; si luego llega
   la factura, Add stock sumaría.
3. La detección "en tienda" usa la Storefront API: borradores y productos sin
   publicar no se ven y acabarían en el CSV.
4. 71 pre-orders sin texto: Completar solo existe para discos de factura.
5. `scout-report` compara el Bearer con `!==`.
6. `DiscogsReviewPanel` apunta fijo al worker de prod.
7. Datos: productos de Rush Hour con `source:mt` (RH-RSS-39, RHM-051…); posible
   duplicado `fresh-and-low-burnin-love` / `burning-love`; pistas de MEOW01
   llamadas `MEOW001-01`; 22 portadas no cuadradas.
