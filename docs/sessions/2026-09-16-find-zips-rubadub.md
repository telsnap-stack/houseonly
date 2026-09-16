# 2026-09-16 — Archivo de emails parado y "Find ZIPs" en Rubadub

## El archivo del worker llevaba 19 días parado

Medido contra Gmail (`from:distribution@rubadub.co.uk in:anywhere`) y la carpeta
de Drive:

| Periodo | Gmail | Drive `RD__` | Worker |
|---|---|---|---|
| 19-08 → 28-08 | ~59 hilos | 61 | 69 |
| 29-08 → 15-09 | ~112 hilos | 110 | **0** |

Gmail → Drive funcionaba. **Drive → worker no tenía activador** (y no solo para
Rubadub: todos los distribuidores paraban el 26–28-08). Eduardo creó el activador
y lanzó el push a mano: índice 438 = 438 cuerpos en KV, sin pérdidas.

- `pushDistributorEmails.gs` subía 40 ficheros por ejecución, menos de lo que
  entra en un día. Ahora sube lo que quepa en 5 min. Copia versionada en
  `scripts/apps-script/` — **hay que pegarla en Apps Script**, no se despliega sola.
- En Pre-order, junto al host del worker, la fecha del último email archivado por
  distribuidor; ámbar si pasa de 3 días.

## Parser: enlaces por bloque

Antes cada disco recibía TODOS los trackers del email y se quedaba con el primer
Dropbox. Eso dio a LOG86 el ZIP de LOG88 y, sin que nadie lo viera, habría dado a
UNI10-001 y -003 el de UNI10-002 (ellos no tienen). Ahora `_zipLinks` = enlaces
con etiqueta "Download Zip" / "Download promopack" en la ventana del bloque.

Medido sobre los 323 emails RD+TV del archivo: 3.005 bloques con un enlace, 0 con
dos. Los 376 sin enlace no lo tienen (clips, YouTube).

Dos fallos más que salieron midiendo:

- **Los digests en texto plano parseaban a cero.** El Apps Script los archiva con
  CRLF y `rdHtmlToText` devolvía el texto tal cual: el `\r` rompía la línea
  `Cat:`. 17 emails, ~3.000 bloques. En Pre-order un digest ahora solo completa
  filas que ya existen, para no inundar la vista de catálogo no pedido.
- **Mismo tracker en dos discos distintos** (BLNK029 / UTTU200 en los digests de
  texto plano). Se descarta en los dos y se avisa; el mismo disco listado dos
  veces (TOMTOM002) no cuenta.

## Funciones comunes (fuera de Pre-order)

`useMailSecret` (secreto compartido entre tabs, sin persistir), `mailFetchIndex`,
`mailFetchBody` (con caché), `resolveZipLinks`, `fetchZipViaProxy` (separa
caducado / no-zip / error), `matchKeysWithSuffix`, `mailFreshness`.

## Rubadub: cover-less real y "Find ZIPs"

- El aviso de ZIP ausente usa el mismo emparejador que `process()` y lista los
  catnos. Antes era `facturas − ZIPs soltados`.
- "Find ZIPs": por cada catno sin ZIP y no vivo busca su anuncio individual, toma
  el enlace de SU bloque, lo resuelve y baja por `zip-proxy` como `{CLAVE}.zip`
  directo al importer. Estados: encontrado / sin correo / solo en un digest /
  correo sin enlace / enlace caducado / no era un ZIP (+ fallo con detalle).

Prueba con los 20 SKUs del presupuesto 384148 (14-09): 5 con anuncio propio (los
5 resuelven a Dropbox con firma `PK`), 12 **solo en digests** (imports: WAX,
M052, MG.ART904…), 3 sin correo (`AD002dub` — sufijo DUB no reconocido —,
`MEOW01`, `UR-020`).

## Segunda vuelta (mismo día)

- **Digests activados** en Find ZIPs como segunda fuente (anuncio propio con
  enlace > digest con enlace > sin enlace). `AD002dub` se queda sin emparejar a
  propósito: un dub es otro disco, no un sufijo de formato.
- **El presupuesto no se leía.** `parseRubadubInvoicePdf` tomaba "EP" como SKU:
  el presupuesto ordena las columnas Qty · SKU · Item name. Ahora se reconoce por
  la cabecera y se lee por columnas (aguanta `WPA-4/ UR-079`). Líneas repetidas
  del mismo SKU se suman: 20 SKUs, 42 unidades = "Total No of Items: 42". La
  factura SI-283012 sigue dando 41.
- **Trackers encadenados.** FE005: tracker → tracker → Dropbox `/sh/` → `/scl/fo/`.
  El worker sigue un salto y solo reconoce `/scl/fo/`; el cliente repite hasta 3
  saltos y acepta `/sh/` (con `dl=1` da ZIP, firma `PK`).

Resultado esperado sobre el presupuesto 384148, comprobado siguiendo cada enlace
hasta la firma del ZIP:

| Estado | Catnos |
|---|---|
| encontrado (propio) | DR-EP-2073, DR2085, FTC12, UR-029r, WO-KJHBCS |
| encontrado (digest) | AD009, FE005, FE008, HT001, M052, WAX11110, WPA-4/ UR-079 |
| correo sin enlace | MG.ART904, WAX30003, WAX70007, WAX80008, WAX90009 |
| sin correo | AD002dub, MEOW01, UR-020 |

Staging: cherry-pick de los dos commits sobre `origin/staging` (fast-forward
79d7105 → 26ecaa7). El worker de staging ya tenía `resolve-links`, `zip-proxy`
y `emails-*`, y comparte el KV del archivo con prod.

## Pendiente

1. Pegar el `.gs` nuevo en Apps Script.
2. Probar "Find ZIPs" con el secreto de verdad (aquí solo se probó el camino de
   error: sin `PROD_BS` en el entorno).
3. Los ZIP bajados viven en memoria de la pestaña; no se guardan en `Assets/`.
