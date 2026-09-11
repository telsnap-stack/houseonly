# Entidades: artistas y sellos

Diseño de la capa de entidades canónicas que hace posible **seguir artistas y
sellos** desde el portal de clientes.

Decisiones tomadas por Eduardo el 2026-09-10; este documento las desarrolla.
La auditoría previa (conteos, evidencia) está en el historial de la sesión del
mismo día.

## Por qué existe esto

Hoy el artista vive en `Vendor` y el sello en un tag `label:`, ambos **texto
libre copiado del distribuidor**. Sobre 1266 productos:

| | |
|---|---|
| Vendors distintos | **910** (0,72 por producto) |
| Colapso con case-folding + puntuación | 910 → 877 — **solo 33 filas, 3,6 %** |
| Valores de sello distintos | **493** (de 495 tags) |
| Colapso con case-folding + puntuación | 493 → 489 — **6 filas, 1,2 %** |

El titular: **normalizar resuelve el 4 %**. El resto es estructural —215 vendors
(23,6 %) meten varios artistas en un campo, 17 grafías distintas de "varios
artistas", sub-sellos, alias— y necesita criterio humano. Cualquier diseño que
dé por hecho que "normalizando se arregla" falla.

`WishlistItem` ya guarda `artist` y `label` como texto copiado del producto. Es
el error que no se repite aquí: **un follow guarda un slug, nunca un nombre.**

## Esquema KV

Namespace **`ENTITIES`**, nuevo y separado. `WISHLIST` ya es un cajón de sastre
(`wl:`, `sess:`, `authstate:`, discovery, token de Shopify) y aquí se hace
`list({prefix})` a menudo, que recorre el namespace entero.

| id | entorno |
|---|---|
| `e1148360f4af4c72ad608e60c03e9813` | producción |
| `bf137c15dc6d4c4f8f21a9987108f2f2` | staging |

Separados a propósito: la cola de staging es un banco de pruebas y no debe
ensuciar las entidades reales.

### Claves

```
entity:{slug}                    → EntityRecord
alias:a:{norm}                   → "{slug}"     resolución como ARTISTA
alias:l:{norm}                   → "{slug}"     resolución como SELLO
ignore:a:{norm}                  → "1"          V.A., Unknown, House Only…
ignore:l:{norm}                  → "1"
children:{parentSlug}:{childSlug}→ "1"          índice descendente
review:{kind}:{norm}             → ReviewRecord
follow:{customerId}              → FollowRecord
fanout:{slug}:{customerId}       → "1"          índice inverso
```

### `EntityRecord`

```ts
{
  slug: string,              // inmutable, p. ej. "dj-koze", "freerange-records"
  display: string,           // editable: "DJ Koze"
  roles: ('artist'|'label')[],
  parent?: string,           // slug del sello padre (solo sub-sellos reales)
  aliases: string[],         // grafías crudas que resuelven aquí
  sources: string[],         // 'ws','tv','dbh',… de dónde ha aparecido
  status: 'active'|'merged',
  mergedInto?: string,       // si status='merged', a dónde apunta
  createdAt: number,
  updatedAt: number,
}
```

**Una entidad, varios roles.** `2000Black`, `Neroli`, `Rhythm & Sound`,
`Apparel Wax`, `Los Hermanos`, `Ten Lovers Music`, `WIP Music`,
`Suburban Architecture`, `Midnight in a Toyshop`, `Giorgia-May`, `LORNA`,
`shimmy sham sham` y `Time To Play Rec.` son a la vez vendor y sello. Son la
misma cosa en el mundo real y se siguen una sola vez; `roles` dice desde dónde
se le ha visto. Los índices `alias:a:` y `alias:l:` siguen separados porque la
resolución **sí** depende del contexto: `Signature` como sello no es lo mismo
que `Signature` como artista.

**Sub-sellos.** Variantes de nombre (`FXHE` / `fxhe records`, `Freerange` /
`Freerange Records`) son **alias** de una sola entidad. Sub-sellos de verdad
(`chiwax` → `chiwax classic edition`, `rawax` → `RAWAX MOTOR CITY EDITION`) son
**entidades propias con `parent`**. Seguir al padre incluye a los hijos.

La expansión se hace **al leer, hacia arriba**: dado un producto de la entidad
X, sus seguidores son `fanout:X:*` ∪ `fanout:parent(X):*`. Por eso no hace falta
recorrer `children:` para notificar; ese índice existe solo para que el admin
pueda pintar los hijos de un padre.

Cuidado con los falsos positivos de prefijo: `AXIS`/`Axis Of People`,
`Base`/`Based Faith` y `NOTON`/`Not On Label` **son sellos distintos**. Por eso
`parent` solo lo pone una persona, nunca el resolver.

### `FollowRecord` y fanout

```ts
follow:{customerId} → { entities: string[], updatedAt: number }
```

Calco de `wl:{customerId}`: mismo id numérico de Shopify, mismo blob JSON, sin
TTL, misma `resolveCustomerId()` y por tanto el mismo merge invitado→logueado.
La UI agrupa artistas y sellos leyendo `roles` de cada entidad, así que no hace
falta duplicar la lista.

**El índice inverso va como una clave por seguidor, no como una lista.** KV no
tiene transacciones: un blob `fanout:{slug}` con miles de seguidores pierde
altas en cuanto dos personas siguen a la vez (read-modify-write). Una clave por
par y `list({prefix: 'fanout:{slug}:'})` para leerlos.

El blob `follow:{customerId}` sí tiene esa carrera, pero es la misma que ya
tiene `wl:` hoy y es por usuario: dos pestañas del mismo cliente. Se acepta.

### `ReviewRecord`

```ts
{
  kind: 'artist'|'label',
  norm: string,              // clave de agrupación
  raw: string,               // primera grafía vista
  variants: string[],        // todas las grafías crudas agrupadas aquí
  proposal: {
    action: 'create'|'split',
    parts: [{
      raw: string,           // trozo tal cual
      display: string,       // display limpio propuesto
      norm: string,
      existingSlug?: string, // si ya existe una entidad que casa
    }],
    separator?: string,      // qué separador se ha usado para partir
  },
  candidates: [{ slug, display, why: 'normalized'|'prefix' }],
  sources: string[],
  samples: string[],         // handles de producto donde aparece
  count: number,             // cuántos productos lo usan — orden de la cola
  firstSeen: number,
  lastSeen: number,
}
```

`count` es lo que ordena la cola: primero lo que más catálogo desbloquea.

## Endpoints del worker

Todos con `Authorization: Bearer BOOTSTRAP_AUTH_SECRET`, como
`pending-review-*`.

### `POST ?action=entity-resolve`

En lote, una llamada por importación, no una por fila.

```jsonc
// petición
{ "kind": "artist", "source": "ws",
  "items": [{ "raw": "DJ Koze", "context": { "handle": "pampa045" } }] }

// respuesta
{ "results": [{
    "raw": "DJ Koze",
    "status": "resolved",           // resolved | review | ignored
    "slugs": ["dj-koze"],           // N slugs: multi-artista devuelve varios
    "display": ["DJ Koze"],
    "matchedBy": "alias"            // exact | alias | normalized | null
}] }
```

Orden de resolución, y **solo** este:

1. `alias:{k}:{raw}` — exacto
2. `alias:{k}:{norm(raw)}` — normalizado: casefold + quitar no alfanuméricos.
   La misma regla que ya usan `rdKey()` en el importer de Rubadub y el fallback
   de SKU de `findVariantBySkuLoose()`
3. `ignore:{k}:{norm}` → `ignored`
4. nada de lo anterior → escribe/actualiza `review:{k}:{norm}` con una
   **propuesta** y devuelve `review` con `slugs: []`

**No hay paso 5.** Ni distancia de edición, ni partir multi-artista y dar el
resultado por bueno. El resolver *propone* el corte; **nadie crea entidades
salvo una persona en la cola.**

La propuesta de corte usa los separadores vistos en el catálogo —
`&` `/` `,` `x` `|` `vs` `feat` `ft` `pres` `presents` `featuring` `aka` `and` —
y por cada trozo busca si ya existe una entidad. `Delano Smith & Brian Kage` sale
como `split` en dos partes, la primera ya con `existingSlug: "delano-smith"`.

Si un producto tiene entidades en `review` **no se bloquea la importación**:
entra igual y se resuelve luego, como hace `pending-review` con Discogs.

### `GET ?action=entity-review-list`

`?kind=artist|label` · `?limit=` · `?cursor=`. Devuelve los `ReviewRecord`
ordenados por `count` descendente, con sus propuestas y candidatos ya resueltos
a display.

### `POST ?action=entity-review-approve`

Una sola llamada cubre los cuatro casos, para que la UI pueda mandar lotes:

```jsonc
{ "kind": "artist", "norm": "delanosmithbriankage",
  "action": "create",              // create | merge | split | child
  "parts": [                        // create/split: qué entidades resultan
    { "display": "Delano Smith", "slug": "delano-smith" },
    { "display": "Brian Kage",   "slug": "brian-kage" }
  ],
  "targetSlug": "freerange-records",  // merge: a dónde va el alias
  "parentSlug": "chiwax"              // child: quién es el padre
}
```

Efectos, en este orden: crear/actualizar `entity:{slug}` → apuntar
`alias:{k}:{norm}` a los slugs → `children:` si hay `parentSlug` → borrar
`review:{k}:{norm}`.

### `POST ?action=entity-review-reject`

`{ kind, norm }` → escribe `ignore:{k}:{norm}` y borra el registro de la cola.
Es lo que se lleva V.A., Unknown y House Only.

### `GET ?action=entity-get&slug=`

Lectura suelta para depurar y para que la UI pinte candidatos.

## UI de la cola en el admin

Pestaña nueva, calcada de la de revisión de Discogs (`RubadubImporter` ya tiene
el patrón `loadQueue`/`approve`/`reject` con `authHeaders` y
`REVIEW_WORKER_URL`). Se optimiza para **aprobar en lote**, porque el barrido
inicial mete del orden de 900 artistas y 490 sellos.

**La acción por defecto es crear entidad nueva con el display limpio.** Es lo
correcto en la gran mayoría de filas: un nombre que aún no existe, bien escrito.
La fila llega ya marcada con esa acción y con el display propuesto rellenado.

```
┌──────────────────────────────────────────────────────────────┐
│ [x] Seleccionar todo    ( 847 pendientes · artistas )        │
│                          [ Aprobar seleccionados (312) ]     │
├──────────────────────────────────────────────────────────────┤
│ [x] DJ Koze                                     12 productos │
│     → crear  [DJ Koze          ]                             │
│     variantes: "DJ Koze", "Dj Koze"                          │
│     · merge en…   · partir   · hijo de…                      │
├──────────────────────────────────────────────────────────────┤
│ [x] Delano Smith & Brian Kage                    1 producto  │
│     → partir  [Delano Smith ✓ existe] [Brian Kage        ]   │
│     · crear como una sola   · merge en…                      │
├──────────────────────────────────────────────────────────────┤
│ [ ] Freerange Records                            8 productos │
│     → crear  [Freerange Records]                             │
│     ⚠ candidato: Freerange (5 productos)                     │
│     · merge en Freerange   · hijo de Freerange               │
└──────────────────────────────────────────────────────────────┘
```

Reglas de la pantalla:

- Todo lo que llega con `action: 'create'` y **sin candidatos** viene marcado.
  Eso es la mayoría: se revisa de un vistazo y se aprueba en bloque.
- Todo lo que trae **candidatos o propuesta de split viene desmarcado**. Requiere
  mirarlo. Es justo donde están los falsos positivos (`AXIS`/`Axis Of People`).
- `display` es editable en la propia fila; el `slug` se deriva y se enseña, pero
  no se toca.
- Merge, split y "hijo de" son secundarias, detrás de los candidatos ya
  resueltos a nombre, para que sea un clic y no escribir un slug a mano.
- Orden por `count` descendente: primero lo que más catálogo desbloquea.

## Barrido inicial

Objetivo: llenar la cola con **todo** el catálogo, no solo lo nuevo. Sin esto,
el 96 % de la suciedad sigue ahí y "seguir a Koze" se pierde la mitad de su
fondo.

Un script de operación (`scripts/entities-sweep.mjs`, convención de la casa:
dry-run por defecto, `--send` para aplicar) que:

1. Pagina los 1266 productos por Admin API pidiendo `vendor` y `tags`.
2. Por cada producto extrae el vendor y el valor de `label:` (aceptando las tres
   grafías de prefijo: `label:`, `Label: `, `label: `).
3. Llama a `entity-resolve` en lotes, con `context.handle` para poblar `samples`.
4. No escribe nada en Shopify. Solo llena la cola.

Se ejecuta **contra staging primero**, se revisa el aspecto de la cola, y solo
después contra producción. Es idempotente: `review:{k}:{norm}` se agrupa por
`norm`, así que repetirlo suma `count` y variantes, no duplica filas.

Después del barrido, una segunda pasada opcional escribe el slug resuelto en un
metafield del producto para que la tienda pueda pintar y filtrar sin volver a
resolver. Eso ya es fase 4.

## Operación de la cola

La cola no es un trámite de una vez: **cada importación mete filas nuevas** y se
revisan con esta misma pantalla. Esto es el procedimiento, tal como se aplicó el
2026-09-10 para vaciar las 1353 filas del barrido inicial.

### El orden: Bulk → auto → Merge → Split → Other

No es una preferencia, es que **cada paso encoge el siguiente**. Aprobar Bulk
crea entidades; el `Recompute candidates` posterior hace que filas que estaban en
Merge resuelvan solas contra esas entidades recién creadas. Empezar por Merge es
trabajar con la foto vieja: en la pasada real, Merge bajó de 147 a 112 filas solo
por aprobar los artistas primero.

| Vista | Qué es | Cómo se despacha |
|---|---|---|
| **Bulk** | Un nombre suelto: sin candidatos, sin separadores, sin paréntesis, sin pinta de truncado | `Select all verbatim` → aprobar. Es ~76 % de la cola |
| **auto** | Bulk cuyo display se lo ha inventado el Title Case (`displayAuto`) porque no había ninguna grafía decente | Se mira la lista antes de aprobar. Llega **desmarcado a propósito** |
| **Merge** | Hay otra fila o entidad que se le parece | Una a una. Es donde están los falsos positivos |
| **Split** | Un campo con varios artistas dentro | Una a una. Los sellos **nunca** se trocean: Split/Labels siempre sale a cero |
| **Other** | V.A., truncados y paréntesis | Una a una, casi siempre `Reject` |

### Reglas de decisión

**Bulk.** Se aprueba verbatim, sin leer fila a fila: por construcción no hay nada
que decidir. Se manda en lotes de 50 con barra de progreso, y un lote que falle
no aborta los demás. En un reintento aparecen filas como `already done`: es la
idempotencia del endpoint, **no es un fallo** — son las que la pasada anterior
llegó a escribir.

**auto.** Aquí sí se lee. El Title Case es una propuesta, no un dato: los
acrónimos ya vienen respetados (`CV313`, `DRS`, `2lanes`, `123.ro` se conservan),
pero un nombre estilizado que solo aparece en mayúsculas se corrige a mano en la
propia fila antes de aprobar.

**Merge.** La pregunta es una sola: *¿es la misma cosa del mundo real?*

- Misma cosa escrita de dos maneras → `Merge rows` si ninguna es aún entidad
  (`Freerange` / `Freerange Records`), `Merge into entity` si ya existe una.
- Parecido de prefijo que **no** es la misma cosa → `Create separately`.
  Los casos reales del catálogo: `AXIS` / `Axis Of People`, `Base` / `Based
  Faith`, `NOTON` / `Not On Label`. Ante la duda, separar: deshacer un merge es
  más caro que hacerlo luego.
- Sub-sello de verdad → `hijo de` (`chiwax` → `chiwax classic edition`). Solo
  cuando el padre es un sello distinto y existente; **nunca** se pone a un nombre
  como hijo de sí mismo.

**Split.** Solo se parte **con evidencia**: que alguna de las partes exista sola
en el catálogo. La propuesta ya viene con esa recomendación calculada. Si ninguna
parte aparece por su cuenta es un nombre solo y se aprueba entero, tenga 2
productos o 50 — `Bread & Souls`, `Fresh & Low` y `Rhythm & Sound` son bandas, no
pares de artistas. Los `feat.`, `ft.`, `pres.` y `&` de un remix (`Atjazz & MdCL
/ Mist Works (Aybee Rmx)`) se aprueban como alias del artista principal.

**Other.** `V/A`, `Various`, `Unknown` y `House Only` → `Reject`, que escribe
`ignore:` y no vuelve a preguntar. Los truncados (49–50 caracteres exactos, o
terminados en coma o punto) y los paréntesis piden abrir el producto: el nombre
bueno está en el título del disco.

### Después de cada importación

1. El importer deja filas nuevas en la cola (fase 4; hasta entonces, las mete
   `entities-sweep.mjs`, que es idempotente y se puede repetir sin miedo).
2. `Recompute candidates` antes de tocar nada: con el fondo ya poblado, mucho de
   lo nuevo cae solo en Merge contra una entidad existente.
3. Mismo orden que arriba. Con la cola de régimen —decenas de filas, no miles—
   son minutos.

### Estado al cerrar la fase 2 (2026-09-10)

Cola a **0 filas**. En `ENTITIES` de staging:

| | |
|---|---|
| Entidades | **1445** — 970 solo artista, 462 solo sello, **13 con los dos roles** |
| Alias | 2703 claves (`alias:a:` 1736 · `alias:l:` 967) |
| `ignore:` | 19 (18 artistas, 1 sello) |
| Sub-sellos (`parent`) | 1 |

Los 13 de doble rol son los previstos en el diseño: `2000Black`, `Neroli`,
`Rhythm & Sound` y compañía, que son vendor y sello a la vez.

Ese mismo día, un segundo barrido metió **34 filas nuevas** (12 artistas, 22
sellos) de los 22 productos que habían entrado en el catálogo entre el 25-08 y
el 10-09 —16 de ellos de la importación W&S— y que por tanto no existían cuando
se hizo el barrido inicial. Es la cola de régimen, y es la prueba de lo que dice
el apartado anterior: mientras los importers no resuelvan (fase 4), cada
importación deja su rastro aquí.

Despachadas el mismo día, y tres de ellas corregidas después de mirarlas con
calma, porque el slug se congela al aprobar y salía más barato hacerlo con un
producto por entidad que dentro de un año:

- `C.A.R. (Javonntte, Ben Green, Dez Andres)` → **`C.A.R.`** (`c-a-r`). El
  paréntesis eran los músicos del disco, no parte del nombre; la cadena entera
  se queda como alias.
- `Norma Jean Bell (AKA Moodymann)` → **`Norma Jean Bell`** (`norma-jean-bell`).
  Son dos personas distintas —ella grabó y publicó con él, de ahí el crédito—, y
  el display conflaciaba a las dos. La cadena queda como alias, sin ninguna
  relación con Moodymann.
- `White` → **`ignore:l:white`**. Un *white label* no es un sello: seguirlo
  habría agrupado discos sin ninguna relación entre sí.

El estado con el que se cierra la jornada: **1480 entidades** (984 artista, 483
sello, 13 con los dos roles), 2769 alias, 20 `ignore:`, 0 filas en cola, y
**cobertura completa**: no queda ni un `vendor` ni un tag `label:` del catálogo
publicado sin resolver contra una entidad o un `ignore:`.

## Fases

| Fase | Qué | Dónde | Despliegue |
|---|---|---|---|
| **1** | Namespace, esquema, `entity-resolve`, `entity-review-*` | worker | `wrangler deploy --env staging` |
| **2** | Pestaña de la cola en el admin | `src/App.jsx` | push a `staging` → preview de Pages |
| **3** | `entities-sweep.mjs`, barrido contra staging y revisión de la cola | script | local |
| **4** | Los 8 importers llaman a `entity-resolve`; ligaduras `ff`/`fi` corregidas | `src/App.jsx` | push a `staging` |
| **5** | `follow:` + `fanout:` + portal de cliente | worker + `src/App.jsx` | ambos |
| **6** | Avisos de "nuevo lanzamiento de X" | worker | prod |

**Worker y frontend se despliegan por caminos distintos y conviene no
confundirlos:**

- El **worker** no va por git. Sale con `wrangler deploy --env staging`
  (staging) y `wrangler deploy` (producción). El código puede estar en la rama
  `staging` sin estar en producción, y al revés.
- El **frontend** sí va por git, vía el proyecto de Pages: push a `staging` →
  preview en `staging.houseonly.pages.dev`; merge a `main` → producción.

Regla práctica: **el worker sube a producción cuando la fase está validada en
staging, y el frontend cuando está en `main`.** Fase 1 solo toca worker, así que
no toca `main` en absoluto.

Los endpoints de fase 1 son aditivos y están detrás de Bearer: desplegar el
worker de producción con ellos no cambia nada de lo que hay hoy. Aun así no se
sube a producción hasta que la fase 2 pueda usarlos.

## Fase 4 y 5: diseño detallado

Escrito antes de implementar nada. Tres piezas: el slug llega al producto (4),
el cliente sigue entidades (5a) y el cliente ve lo suyo (5b).

**Decisiones de Eduardo, 2026-09-10:**

| Decisión | Elegido | Descartado |
|---|---|---|
| Alcance del feed | **Ventana de 90 días**, filtrada en memoria | Índice `byslug:{slug}:…` en KV |
| Definiciones de metafield | **Script versionado** con `metafieldDefinitionCreate` | Crearlas a mano en el admin |
| Promoción del frontend | **File-drop preparado**, no ejecutado | Ejecutarlo ya |

### (a) Los importers resuelven al generar el CSV

Hoy los 8 importers escriben `Vendor` y un tag `label:` con el texto del
distribuidor y ahí acaba la historia: el slug canónico no llega nunca al
producto, así que cualquier pantalla que pinte o filtre por entidad tiene que
resolver otra vez en cada carga.

**Dónde engancha.** Los ocho ya tienen el punto exacto: la línea
`autoRecomputeEntities('W&S')` y sus siete hermanas, que hoy corren al terminar
una importación. La resolución va justo antes de construir el CSV.

**Dos llamadas por importación, no una por fila.** Se juntan todos los vendors y
todos los valores de `label:` de la tanda y se hacen dos
`POST ?action=entity-resolve` (`kind: 'artist'` y `kind: 'label'`), con
`context.handle` y `context.title` para que la cola tenga muestras.
`resolveBatch` ya está escrito para esto y el barrido lo usa en lotes de 100.

**Columnas nuevas en el CSV.** Shopify importa metafields con la cabecera
`Nombre (product.metafields.{namespace}.{key})` y **no admite tipos `list.*` de
texto por CSV** (comprobado en su documentación):

```
Artist entities (product.metafields.houseonly.artist_slugs)   → "delano-smith,brian-kage"
Label entity (product.metafields.houseonly.label_slug)        → "freerange-records"
```

`single_line_text_field` con los slugs **separados por coma**, que es exactamente
como `alias:{k}:{norm}` guarda ya varios slugs: una convención, un solo parser.

**Las definiciones, por script versionado.** `scripts/entities-metafield-defs.mjs`,
convención de la casa: dry-run por defecto, `--create` para aplicar. Una
definición por metafield, con el input ya verificado contra el esquema de la
Admin API:

```jsonc
// mutation metafieldDefinitionCreate($definition: MetafieldDefinitionInput!)
{
  "name": "Artist entities",
  "namespace": "houseonly",          // 3-255 chars, alfanumérico/guion/subrayado
  "key": "artist_slugs",             // 2-64 chars
  "type": "single_line_text_field",
  "ownerType": "PRODUCT",
  "description": "Slugs canónicos de artista, separados por coma. docs/entities.md",
  "pin": true,
  "access": { "admin": "MERCHANT_READ_WRITE", "storefront": "PUBLIC_READ" },
  "capabilities": { "adminFilterable": { "enabled": true } }
}
```

Dos cosas que no son adorno: **`storefront: PUBLIC_READ`**, sin lo cual la tienda
no puede leer el metafield por Storefront API y el feed se queda ciego; y
**`adminFilterable`**, que es lo que permite filtrar por entidad en el admin de
Shopify sin escribir código. El script es idempotente: si la definición ya
existe, `userErrors` trae el código de "tomada" y se ignora en vez de fallar.

**Lo que va a review no bloquea nada.** Si un valor vuelve con
`status: 'review'`, la celda va **vacía** y el producto se sube igual. Misma
regla que ya rige con Discogs: el catálogo no espera a la cola. El hueco se
rellena después por dos caminos distintos que conviene no confundir:

- **Productos nuevos** — el webhook `products/create`, que ya corre el matcher de
  Discogs, llama a `entity-resolve` y escribe el metafield con `metafieldsSet` si
  resuelve. Así el slug llega aunque el producto no venga de un importer.
- **Lo ya subido con la celda vacía** — `entities-backfill-metafields.mjs`,
  dry-run por defecto, que repasa el catálogo y escribe solo donde falte. Mismo
  patrón que los `backfill-*.mjs`.

**Sin Bearer, el importer no se para.** El secreto vive en memoria desde que
alguien conecta la pestaña Entidades. Si no está, se genera el CSV sin las dos
columnas y se avisa en pantalla. Un importador que deja de funcionar porque falta
el token de una función accesoria es peor que un CSV sin metafield.

> **Pendiente (2026-09-11).** Ese aviso llega **después** de generar el fichero, y
> eso es poco: el CSV sin columnas se sube igual de bien a Shopify y el error no
> se ve hasta semanas más tarde, cuando alguien busca por entidad y faltan discos.
> El importer debe **pedir confirmación explícita antes de generar** —"vas a
> generar el CSV sin las columnas de entidad porque no hay Bearer, ¿sigo?"— y
> dejar seguir solo si se dice que sí. Generar a ciegas y avisar después invierte
> el orden: la decisión es de quien importa, no del programa.

### (b) Follows: esquema y endpoints (fase 5a)

Calco literal de `wl:`, porque ya resolvió estos problemas.

```
follow:{customerId}        → { entities: string[], updatedAt: number }
fanout:{slug}:{customerId} → "1"
```

`entities` guarda **slugs, nunca nombres**. `WishlistItem` copió `artist` y
`label` como texto y por eso hoy no se puede seguir a nadie desde la wishlist;
ese error no se repite.

| Endpoint | Método | Cuerpo | Qué |
|---|---|---|---|
| `?action=follows` | GET | — (`?session=`/`?token=`) | Lista hidratada: `slug`, `display`, `roles`, `parent` |
| `?action=follows` | POST | `{ slug, session? , token? }` | Alta |
| `?action=follows` | DELETE | `{ slug, … }` | Baja |
| `?action=follows-merge` | POST | `{ entities: string[], … }` | Funde la lista de invitado al entrar |

Autenticación **idéntica** a wishlist: `resolveCustomerId(env, { session, token })`
—sesión CAAPI primero, token legacy como degradación— y `401 {"error":"auth"}`
si no hay cliente. El invitado guarda su lista en `localStorage` y
`follows-merge` la funde al entrar, igual que `wishlist-merge`.

Detalles que no son caprichos:

- **Alta: el blob primero, el fanout después.** Si falla lo segundo, el cliente ve
  su follow —que es lo que él nota— y el fanout se puede reconstruir desde los
  blobs. Al revés se notificaría a alguien que no ve el follow en su lista.
- **Baja: el fanout primero.** Lo grave al darse de baja es seguir recibiendo
  avisos.
- **Tope de 500** entidades por cliente, como los 500 items de la wishlist.
- **El blob tiene carrera** (dos pestañas del mismo cliente): es la misma que ya
  tiene `wl:` y se acepta. El fanout **no**, y por eso es una clave por par.
- **Slug inexistente → 400.** Un follow a un slug que no resuelve es un follow
  muerto que nadie volverá a mirar.
- **Entidad `merged`**: al leer se sigue `mergedInto`, se devuelve la viva y el
  blob se reescribe con el slug bueno la primera vez que se lee.

### (c) Feed: ventana de 90 días (fase 5b)

```
GET ?action=feed&session=…&limit=24&cursor=…
→ { items: [{ handle, title, artist, label, imageUrl, price, currency,
              createdAt, forthcoming, releaseDate, stock, via }],
    cursor, window: { days: 90, from: "2026-06-12" } }
```

`via` dice **por qué** aparece cada disco (`"dj-koze"`, `"freerange-records"`):
sin eso, una lista de novedades es indistinguible de la portada.

**De dónde salen los productos.** El worker ya tiene la pieza:
`nlFetchRecentProducts(env, days)` pagina por Storefront con `sortKey
CREATED_AT` y hace dos pasadas, `forthcoming` y no-`forthcoming`, que es justo el
corte que pide el feed. El feed la llama con **90 días**, cachea el resultado en
KV (`feed:window:v1`, TTL de minutos) y lo filtra en memoria contra los slugs del
cliente. Todos los seguidores miran la misma ventana: **una construcción, no una
por cliente**.

**Cómo se empareja cada producto con sus slugs.** Al construir la ventana, y solo
entonces, cada producto se anota con sus slugs: primero el metafield de la fase 4
si está, y si no, resolviendo `vendor` y `label:` contra `alias:{k}:{norm}`. Así
el feed funciona **desde el primer día**, sin esperar a que la fase 4 haya pasado
por todo el catálogo, y se vuelve más barato según se llenan los metafields.

- Orden `createdAt` descendente, con los `forthcoming` marcados pero **en la misma
  lista**: un pre-order de un sello que sigues es la noticia, no una sección
  aparte.
- `cursor` opaco, `createdAt|handle` del último devuelto: estable aunque entren
  productos nuevos mientras se pagina.
- **Expansión hacia abajo**: seguir a `chiwax` incluye `chiwax classic edition`.
  Se leen `children:{slug}:*` al montar el conjunto de slugs del cliente. Es el
  espejo de la expansión hacia arriba que usarán las notificaciones, y el motivo
  de que el índice `children:` exista.
- Sin entidades seguidas → `items: []` y un cuerpo vacío honesto, no la portada
  disfrazada de feed.

**El límite, dicho en voz alta: un disco de hace cuatro meses no sale en el
feed.** Es una decisión, no un descuido. "Todo lo de DJ Koze" necesitaría un
índice `byslug:{slug}:{createdAt}:{handle}` escrito por el mismo sitio que
escribe el metafield, y hoy se descarta: dobla el coste de escritura de la fase 4
para una pantalla que aún no existe. Si el portal acaba pidiendo historia, el
camino está apuntado aquí y el índice se puede construir en cualquier momento a
partir de los metafields.

## Promoción a producción: aplazada hasta la fase 4/5

**Decisión del 2026-09-10: no se promociona nada todavía.** El motivo no es que
falte trabajo, es que promocionar ahora no compra nada y cuesta algo:

- **Nada en producción consume entidades.** El worker de prod no tiene los
  endpoints, la tienda no lee slugs y no hay portal de follows. Subir la capa
  sería dejarla mirando a la pared.
- **Una sola verdad mientras tanto.** En cuanto existan dos namespaces con
  entidades, cada aprobación hay que hacerla o copiarla dos veces, y la primera
  divergencia silenciosa aparece el día que alguien apruebe en el sitio
  equivocado. Hasta que el portal las use, las entidades viven **solo en
  staging** y esa es la copia buena.

Lo que está verificado y no hay que volver a mirar cuando toque:

| | |
|---|---|
| Worker de prod | Corre el código de la rama `staging` a fecha 2026-09-09 (`emails-list`, que solo existe en `staging`, responde 401 en prod) |
| Delta worker prod ↔ `staging` HEAD | **Solo los 9 commits de Entidades**. `wrangler deploy` no arrastraría nada más |
| `?action=entity-review-list` en prod | No existe: cae en el fallback |
| Namespace `ENTITIES` de prod (`e1148360…`) | Existe, ya está en `wrangler.jsonc`, **0 claves** |

El orden, cuando se retome: (1) `wrangler deploy` desde un checkout de `staging`
—el worker no va por git—; (2) copiar `entity:`, `alias:`, `ignore:` y
`children:` de staging a prod con `kv bulk get`/`kv bulk put` (las decisiones
fueron humanas: se copian, no se repiten); (3) `entities-sweep.mjs --send --prod`
como verificación —si la copia está bien, la cola de prod sale casi vacía—; y
(4) el frontend, que es lo que manda el calendario.

### El file-drop de `src/App.jsx`: preparado, no ejecutado

Medido, no estimado. `git diff main origin/staging -- src/App.jsx`:

```
1 file changed, 511 insertions(+)
main 10813 líneas → staging 11324
```

**511 líneas añadidas y ni una sola borrada o modificada.** Los 11 hunks son:

| Hunk | Qué |
|---|---|
| 8 × 1 línea | `autoRecomputeEntities('W&S' \| 'Triple Vision' \| 'Rubadub' \| 'Kudos' \| 'DBH' \| 'Mother Tongue' \| 'Rush Hour' \| 'Pre-order')` al final de cada importer |
| 507 líneas | `EntitiesPanel` y sus ayudas, en bloque |
| 2 × 1 línea | El botón `🏷️ Entities` y su `{tab==='entities' && <EntitiesPanel />}` |

O sea: **el file-drop es la pestaña de entidades y nada más**. Los "66 commits de
divergencia" eran ruido de recuento —el resto ya está en `main` por otras vías—;
el contenido del fichero ya coincide en todo lo demás.

**Impacto en producción si se aplicara hoy: ninguno visible.** No se toca una
línea de lo que ya corre. Las ocho llamadas nuevas salen por la primera línea
(`if (!entitiesSecret) return;`) mientras nadie conecte la pestaña y escriba el
secreto, y el secreto no se persiste entre recargas. La tienda de cara al cliente
no cambia en absoluto: todo lo añadido vive dentro del admin.

**Lo que falta antes de ejecutarlo**, y es lo que lo mantiene aplazado:

1. El worker de **producción** no tiene los endpoints `entity-*` (promoción
   aplazada, ver abajo). Sin eso la pestaña se conecta a un worker que no
   responde.
2. `ENTITIES_WORKER_URL` está clavado al worker de staging. Al ejecutar el
   file-drop hay que cambiarlo por `REVIEW_WORKER_URL`, como dice el comentario
   que lo acompaña.

**Plan de verificación, en este orden:**

1. `wrangler deploy` del worker de prod y copia del namespace (ver abajo).
   Comprobar `?action=entity-review-list` en prod: 401, no el fallback.
2. Aplicar el diff sobre `main` y cambiar la constante. `npm run build` —que
   incluye el prerender— tiene que pasar sin tocar nada más.
3. En el preview de Pages: abrir el admin, comprobar que **los 8 importers siguen
   generando su CSV** con la pestaña Entidades sin conectar (el caso de verdad
   frecuente), y que la consola no escupe nada nuevo.
4. Conectar la pestaña con el Bearer de prod, ver la cola vacía —será vacía si la
   copia del namespace fue bien— y aprobar una fila de prueba.
5. Solo entonces, merge a `main`.

## Lo que este diseño no hace

- **No adivina.** Ninguna entidad se crea sin que una persona la apruebe. Aquí ya
  han llegado matches equivocados a clientes por automatizar de más.
- **No toca el catálogo.** `Vendor` y los tags `label:` siguen exactamente igual;
  la capa de entidades vive al lado. Volver atrás es borrar un namespace.
- **No arregla los datos sucios de origen.** La corrupción de ligaduras
  (`Bano ff ee Pies`, `Forti fi ed Audio`, `O ff   House`, `Synaptic Cli ff s`)
  viene del parseo de PDF y se corrige en el importer, fase 4.
