# 2026-08-25 — Promoción a producción y caza de fallos en el ciclo completo

Continuación de `2026-08-24`. La jornada fue casi toda depuración con Eduardo
usando la herramienta de verdad: él reportaba un síntoma, se medía la causa y se
arreglaba. Casi ningún fallo estaba donde parecía.

## Estado al cerrar

Todo en producción. `main` y `staging` con `src/App.jsx` idéntico.

- **22 commits promovidos** a `main` (`23bbc15 → 5c97b37`), más los arreglos del
  día. El worker ya estaba desplegado desde ayer.
- **Secretos rotados**: los dos `BOOTSTRAP_AUTH_SECRET` y el token de Cloudflare.
  Los viejos dan 401; el token, revocado.
- **`preorder-ritual.mjs` retirado**: su triage vive en `App.jsx`.

## Los fallos del día, y dónde estaba de verdad la causa

Vale la pena leerlos porque en todos el síntoma apuntaba a otro sitio.

### Dropbox: `dl=0` devuelve HTML con 200

**Síntoma**: «la mayoría de problemas vienen de Rubadub».

Dropbox distingue `dl=0` (página de vista previa, HTML, **HTTP 200**) de `dl=1`
(el fichero). Los enlaces que salen del email traen `dl=0`, y `zip-proxy` los
pasaba tal cual, así que pedía la página de preview en **todos** los promopacks
de Rubadub. `rd-download.sh` lo reescribía desde el principio; al generalizar el
proxy no me lo llevé conmigo.

Peor: el proxy ponía `Content-Type: application/zip` sin mirar lo que recibía, o
sea que guardaba 250 KB de HTML llamados `PACE009.zip` y el fallo no se veía
hasta abrir el fichero. Ahora se rechaza `text/html` y se comprueba la firma
`PK`, leyendo el primer trozo y volviéndolo a emitir para no bufferizar ficheros
de más de 100 MB. Un enlace muerto da **410 con explicación**.

### El tope de 60 URLs que dejaba sin ZIP a casi todo

**Síntoma**: «faltan ZIP, muchos de Triple Vision particularmente».

Primera sospecha: enlaces caducados. **Falsa** — medido: 59/59 vivos en Rubadub,
46/51 en TV. El problema era que ni se pedían.

El cliente hacía `urls.slice(0, 60)` sobre los trackers de **todas** las filas
por resolver. Como cada email aporta hasta 12, eso cubría unos cinco discos:

| | Con el tope | Por tandas |
|---|---|---|
| Releases con ZIP | 11/115 | **110/115** |
| **Triple Vision** | **3/55** | **51/55** |

Afectaba más a TV justamente porque tiene más emails, así que sus trackers caían
siempre fuera del corte. Además solo se resolvían las filas verdes; las rojas
marcadas a mano nunca recibían enlace, y en TV eso es la mayoría. Ahora se
resuelven bajo demanda al añadirlas al manifest.

### Los marcadores de cabecera solo llegaban al primer disco

**Síntoma**: Tapir Taming Technology (`LOG86`) entró como agotado, sin botón de
petición. La intuición era que la fecha había pasado; **no había fecha**.

Un email que anuncia dos discos pone `Please pre-order` y `Shipping late
September` **una sola vez, arriba**. El parser los buscaba en la ventana de prosa
de cada release, así que solo el primero los veía. Es el mismo fallo que ya
estaba arreglado para los digests, sin generalizar.

Y encadenado: sin fecha no hay etiqueta de año, y el escaparate corta con
`if (!y) return false; // no year tag = treat as truly sold out`. Añadida una red
de seguridad: **nunca se emite un producto sin año**. Lo que se importa viene de
un feed de distribuidor, así que es actual por definición.

Afecta a 8 emails del archivo que anuncian más de un disco.

### La búsqueda en Forthcoming no buscaba

Dos fallos encadenados. La bifurcación probaba `if (forthcoming)` **antes** que
`if (searchTerm)`, así que estando en Forthcoming se listaba la sección entera y
lo tecleado no llegaba a ninguna consulta. Y aunque hubiera llegado,
`fetchShopifyProductSearch` clavaba `-tag:'forthcoming'` sin parámetro para
invertirlo: habría devuelto lo contrario de lo buscado.

El tag separa dos mundos y hay que respetarlo **en ambos sentidos**.

### W&S no graduaba: los ZIP estaban en Descargas

**Síntoma**: «cosas que estaban en forthcoming no se actualizan, así estén en la
lista del invoice».

Dos causas, ninguna de código:

1. Shopify **ignora en silencio** las filas cuyo handle coincide si no marcas
   *Overwrite products with matching handles*.
2. Y más importante: el importer de W&S usa **los ZIP como espina dorsal**. Si no
   sueltas el promopack de un disco, no se genera su fila y en Shopify se queda
   como estaba, aunque esté en la factura. Los de Eduardo estaban en
   `~/Downloads`, no en `Assets/`, así que nunca entraron en el CSV.

Confirmado el diagnóstico: tras colocar los ZIP y reimportar con Overwrite,
`AWAYLMTD002` (Move D & Pete Namlook — Reissued 2) graduó — sin `forthcoming` y
con inventario 2.

Se añadieron al importer de W&S los dos avisos que ya tenían los otros: los ZIP
que faltan, y cuántas filas vienen de Forthcoming (con el recordatorio de marcar
Overwrite). Para el segundo hace falta `fetchForthcomingKeys`, distinto de
`fetchLiveHandles`: ése solo dice si un catno existe, y aquí importa **si además
es un pre-order**, porque una fila de factura que casa con un pre-order no es un
duplicado a evitar sino su llegada.

### `LOG86` etiquetado con contenido de `LOG88`

Error mío. El email de Logistic lleva **dos** enlaces de Dropbox, uno por disco;
mi script cogía el primero y yo le forzaba el nombre. El ZIP quedó en `Assets/`
como `LOG86.zip` conteniendo ficheros `LOG88_*`. Si se llega a importar, el
producto de Narcotic Syntax se lleva la portada y el audio de Tobias. Corregido:
cada uno con el suyo.

### Los promopacks de Rubadub no llevan el catno dentro

Medido sobre los 9 de `Assets/Rubadub`: **solo 2 lo llevan, y uno lo lleva mal**.
Los arma el sello, no el distribuidor, así que dentro hay `A1- OUTSIDE .mp3`,
`733019542_988549377418142_….jpg`, `yore_ltd_011_1400.jpg`.

Consecuencia práctica: **para Rubadub el catno solo lo sabe quien descarga**. Por
eso la descarga desde el tab nombra el fichero ella misma. Bajarlos a mano de
Dropbox y esperar acertar con el nombre no funciona.

Para Triple Vision sí sirve mirar dentro (`{CATNO}_front.jpeg`,
`{CATNO}_promotext.txt`), y de ahí sale `scripts/file-promopacks.mjs`, que coloca
lo bajado en `Assets/{distribuidor}/{CATNO}.zip`. Colocó 60 ficheros que estaban
sueltos en Descargas.

## Cifras de referencia (actualizadas)

```
emails en el worker            208
releases en la vista           187
  verdes (pedidos)              81   (W&S 50 · TV 25 · RD 5 · ambos 1)
  con precio                186/187
  con portada               115/187
  con ZIP tras resolver     110/115  (RD 59/60 · TV 51/55)
duplicados entre distribuidores  1   (MP10)
ZIP en Assets/                1146   (60 colocados hoy)
productos en Shopify          1239   (120 en forthcoming)
```

## Pendiente

1. **Reimportar los siete de W&S** que siguen en Forthcoming con stock 0:
   `DFTD723`, `CKNOWEP75`, `K7046XXXLP`, `auslp010`, `TRALT3`, `EM003`,
   `PULABM04`. Sus ZIP ya están en `Assets/wordandsound/`.
2. **Tabla de descriptores por distribuidor**, para dejar de parchear cada vez
   que aparece una variante. La red de seguridad son las cifras de arriba.
3. **Alta directa en Shopify por Admin API** en vez de CSV — mata el último paso
   manual y de paso el problema del Overwrite, que es una trampa cada vez.
4. **DBH sin parser de anuncios** (17 de sus 47 emails traen bloques, otro
   formato).
5. **Caso latente**: dos bloques de campos pegados sin nada entre medias salvo
   una línea en blanco se fusionan y se quedan con el último catno.
6. **`MIRROR_MAX_BYTES` en 10 MB** mientras alguna portada ronda los 4,4.

## Nota sobre el método

Mis vigilantes de despliegue fallaron **cuatro veces** en la sesión: marcadores
que el minificador transforma, cadenas que ya existían en el bundle anterior,
hashes capturados en mal momento. La comprobación que valió siempre fue la
directa — pedir el bundle y buscar un literal de interfaz que solo exista en el
código nuevo. Si se vuelven a usar, que sea con un marcador verificado como
ausente en la versión anterior.

Y `npm run build` sigue siendo un chequeo de sintaxis, no una prueba.
