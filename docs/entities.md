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

#### Lo que el filtro del admin sí y no encuentra

Medido en la tienda el 2026-09-11, después del backfill. **El filtro por metafield
de la Admin API compara el valor ENTERO, no sus trozos.** No hay búsqueda por
token, ni por prefijo, ni comodines:

| Consulta | Devuelve | Por qué |
|---|---|---|
| `label_slugs:deep-jungle` | 94 de 94 | Valor de un solo slug: exacto |
| `artist_slugs:omar-s` | 10 de 11 | Los 10 discos suyos; **no** el split de cuatro artistas |
| `artist_slugs:omar` | 0 | No hay prefijos |
| `artist_slugs:d-julz` | 0 | Existe, pero solo dentro de un valor de cuatro |
| `artist_slugs:*omar-s*` | 0 | No hay comodines |

O sea: **los 153 productos de varios artistas no salen al filtrar por uno solo**.
Los otros 1123 y los sellos —ninguno tiene más de un slug— filtran perfecto.

Se acepta a sabiendas. El filtro del admin es una comodidad; el feed de la fase 5
**no depende de él**, porque parte el valor por comas él mismo (`parseSlugs`) y
filtra en memoria. Si algún día filtrar splits en el admin se vuelve trabajo de
verdad, la salida es un segundo metafield de tipo `list.single_line_text_field`
escrito por API —los tipos `list.*` no se pueden importar por CSV, que es lo que
obligó a la coma— y se rellena con el mismo backfill, sin tocar lo que ya hay.

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

## Fase 6: avisos de novedades

Seguir a alguien sin que te avise es una lista de deseos con otro nombre. Esto es
lo que convierte el follow en algo que devuelve valor solo.

### Qué se guarda, y dónde

El interruptor vive **dentro del blob de follows**, no en una clave aparte: es un
ajuste del mismo objeto y así no hay dos sitios que puedan contradecirse.

```ts
follow:{customerId} → {
  entities: string[],
  updatedAt: number,
  emailAlerts?: boolean,     // sin definir = nunca se le ha preguntado
  emailAlertsAt?: number,    // cuándo lo decidió, para poder auditar un alta
  email?: string,            // su correo, capturado al decir que sí
}
```

**El correo hay que guardarlo, y no es por comodidad.** El envío lo hace un cron
sin sesión de nadie, y ahí el worker **no puede averiguar el correo de un
cliente**: la Customer Account API lo da solo con la sesión del propio cliente, y
la Admin API nos lo niega porque la Custom App no tiene el scope
`read_customers`. Así que se captura en el momento del sí —que es cuando hay
sesión— y se guarda junto a la decisión.

Si el cliente cambia su correo en Shopify, el guardado se queda viejo. Se
refresca en cada visita al portal, que es gratis: allí sí hay sesión.

### Cuándo se pregunta

**En el primer follow de un cliente, una sola vez.** No en cada follow: una
pregunta que se repite deja de leerse y se contesta que no por reflejo.

```
  Following Omar S.
  We'll tell you when they release something new.
  [ Yes, email me ]   [ Not now ]
  ☐ Also join the newsletter
```

- `emailAlerts` sin definir es lo que dispara el prompt la primera vez.
- **"Not now" no es "no nunca"**: se puede encender después desde la sección
  Following del portal, que es donde alguien va a buscarlo.

**Y se recuerda al seguir a alguien más, con un mes de descanso.** Alguien que
dijo "not now" en su primer follow y hoy sigue a ocho artistas ya no está en la
misma situación: seguir a alguien es justo el momento en que los avisos tienen
sentido, porque acaba de decir que ese artista le importa. Pero preguntarlo en
cada alta es un fastidio y acaba en un "no" por reflejo, así que:

- quien los tiene **encendidos** no ve nada, nunca;
- quien los tiene **apagados** vuelve a verlo al seguir a alguien, como mucho una
  vez cada **30 días** (`PROMPT_COOLDOWN_MS`), con el texto cambiado a
  recordatorio: *"Your email alerts are off. Turn them on and we'll tell you
  when they release something new."*;
- **cerrarlo sin contestar no es un "no"**: guarda `alertsPromptAt` y lo aparta
  el mismo mes, sin tocar `emailAlerts`. Sin eso reaparecía en el siguiente
  follow de la misma sesión, que es exactamente lo que se quiere evitar.

El descanso cuenta desde el último contacto sobre el tema —la respuesta
(`emailAlertsAt`) o el recordatorio apartado (`alertsPromptAt`), el más
reciente—, así que apagarlos desde el portal también compra un mes de silencio.
Quien decide es el servidor: `GET ?action=follow-alerts` devuelve `prompt`.
- La casilla del newsletter va **desmarcada y aparte**, y dispara el doble
  opt-in que ya existe. **Seguir a alguien no suscribe a nada**: son dos cosas
  distintas y mezclarlas es como se pierde la confianza de una lista.

### El envío

Un job diario en el cron del worker:

1. Recorre `follow:*` y se queda con los que tienen `emailAlerts: true` y correo.
2. Calcula, del índice del catálogo, los productos **creados en las últimas 24 h**.
   Los pre-orders cuentan: son justo la novedad que alguien quiere saber antes.
3. Para cada producto nuevo, sus entidades; para cada entidad, sus seguidores por
   `fanout:{slug}:*`. El índice inverso existe para esto.
4. Un solo correo por cliente, **agrupado por entidad**, con portada, título,
   precio y enlace. Si un cliente no tiene novedades, **no recibe nada**: un
   correo que dice "no hay nada" es el que hace que se den de baja.

**Un disco, un sitio.** Un mismo disco lo traen a menudo dos entidades seguidas
—el artista y su sello, o dos artistas de la misma ficha—. Agrupado por entidad
sin más, el correo lo repetía bajo cada una: "Boots On The Ground" salía bajo
Massive Attack y otra vez bajo Play It Again Sam, y el asunto prometía cinco
discos cuando había tres. Regla: **cada producto aparece una sola vez**, se lo
queda el **artista seguido** —a quien de verdad se sigue— y el sello recoge lo
que no trae ningún artista seguido detrás. A igualdad manda el orden de la
propia ficha, así que el primer artista va antes que el segundo. Debajo del
disco, una línea **"also from X"** nombra a las demás entidades seguidas que lo
traen: la información no se pierde, solo deja de duplicarse. El total del asunto
y el "And N more" cuentan **discos únicos**, no apariciones.

```
alertsent:{customerId}:{YYYY-MM-DD} → "1"   (TTL 60 días)
```

Se escribe **antes** de enviar, no después. Si el envío falla, ese cliente se
queda sin aviso ese día; si se escribiera después, un fallo a mitad de tanda
podría mandarle el mismo correo dos veces al reintentar. De los dos errores
posibles, no avisar es el barato.

### La baja

Cada correo lleva **su propio enlace de baja**, que apaga `emailAlerts` y nada
más. **No toca el newsletter**, y el enlace de baja del newsletter no toca esto.
Son dos consentimientos distintos y se revocan por separado.

```
alerttoken:{token} → customerId     (token opaco, creado al decir que sí)
```

Un token opaco y no el `customerId` firmado: si algún día se filtra un enlace,
lo que revela es un token que solo sirve para darse de baja.

### Pendiente para v2: la baja necesita una pantalla de confirmación

Hoy `?action=follow-alerts-unsubscribe&t=…` da de baja **en el GET**. Es lo que
pide One-Click para el `List-Unsubscribe` —y ahí está bien, porque eso llega por
POST—, pero el enlace "Stop these alerts" del pie es un GET normal, y los
escáneres de seguridad del correo corporativo **prefetchean los enlaces** de los
mensajes que analizan. Un escáner puede dar de baja a un cliente que nunca tocó
nada, y el cliente no se entera: deja de recibir avisos sin explicación.

Arreglo en v2: que el GET sirva una página con un botón —"Yes, stop these
alerts"— que haga el POST, y que solo el POST apague `emailAlerts`. El
`List-Unsubscribe-Post` sigue funcionando igual, porque ya viaja por POST.

### El cron

El worker de producción ya corre cada 15 minutos (Discogs + graduación) y el de
staging **no corre nada a propósito** —se le quitó para no competir por el cupo
de Discogs—. Así que:

- Se añade una segunda expresión, diaria, y `scheduled()` **bifurca por
  `event.cron`**: la de 15 minutos sigue haciendo lo de siempre y la diaria hace
  solo los avisos. Sin bifurcar, activar el cron en staging devolvería el poll de
  Discogs que se quitó.
- En staging se activa **solo la diaria**.

### Modo de prueba

`meta:follow_alerts_mode` en KV: `off` (por defecto) · `test` · `live`.

En `test` el job hace todo el cálculo de verdad —a quién le tocaría, qué discos,
cómo queda el correo— pero **manda todo a una sola dirección** y no escribe el
registro de envíos, así que se puede repetir. Es la única forma de ver el correo
real sin usar a los clientes de cobaya.

Y un `?action=follow-alerts-run` con Bearer para dispararlo a mano, porque
esperar a un cron diario para probar un cambio no es forma de trabajar.

### Decisiones abiertas

1. **A qué hora.** Propongo **08:00 Europe/Madrid** (06:00 UTC en verano, 07:00
   en invierno; el cron es UTC, así que hay que elegir una y aceptar que se
   mueva una hora con el cambio horario). Alternativa: mandar a media tarde,
   cuando la tienda ve más tráfico.
2. **Diario o semanal.** El diseño es diario. Con el ritmo actual —de 0 a 20
   discos nuevos al día— un cliente que siga a un sello grande como Deep Jungle
   podría recibir correo casi a diario. Un resumen semanal se lee más y molesta
   menos; un aviso diario llega antes a un pre-order que vuela. **Se puede tener
   las dos** con un campo más en el blob, pero eso es otra pregunta que hacerle
   al cliente.
3. **Tope por correo.** Si alguien sigue a 30 entidades y hay 40 discos nuevos,
   ¿se manda todo? Propongo **20 discos y un "y N más" al final**, con enlace al
   portal.
4. **De qué dirección sale.** Reusar `newsletter@houseonly.store` es lo simple,
   pero mezcla reputación de envío: si alguien marca un aviso como spam, arrastra
   al newsletter. Lo limpio es `alerts@houseonly.store`, que hay que dar de alta
   en Resend.
5. **Qué cuenta como "nuevo".** Ahora mismo, `createdAt` del producto en las
   últimas 24 h. Un producto que se crea como borrador y se publica una semana
   después no avisaría a nadie. La alternativa —marcar la primera vez que el
   índice lo ve publicado— es más fiel pero necesita guardar ese momento.

### Eventos de artista y sello: v2, no ahora

Un follow sabe *que* sacas discos, no *cuando* tocas. Lo natural cuando el
portal esté en pie es que seguir a una entidad traiga también sus fechas —
"Omar S toca en Madrid el 14"— y que eso aparezca en su ficha y en las
estanterías de quien le sigue.

Queda fuera de la fase 5 **a propósito**, porque no es más pantalla: es una
fuente de datos nueva que la tienda no tiene. Un evento necesita fecha, ciudad,
sala, enlace de entradas y alguien que lo mantenga al día; ni Shopify ni Discogs
lo dan, y un listado de conciertos desactualizado hace más daño que no tenerlo.

Cuando se retome, lo que ya está hecho encaja sin tocarlo: `entity:{slug}` es el
sitio donde colgar los eventos, `fanout:{slug}:*` dice a quién avisar, y la ficha
de entidad es donde se pintan. Lo que falta decidir es de dónde salen los datos
— a mano en el admin, de Bandsintown o del propio artista — y eso es una
decisión de producto, no de esquema.

## Promoción a producción: la secuencia

La v1 está cerrada en staging: entidades, portal, fichas públicas, prerender y
avisos. Esto es **cómo se sube**, paso a paso, con qué se comprueba cada uno y
cómo se deshace. Se ejecuta **con parada entre pasos**: nadie encadena dos sin
mirar el anterior.

Medido el 2026-09-11, no estimado:

| | |
|---|---|
| Worker de prod | No tiene ningún endpoint de entidades (`entity-public`, `follows`, `feed`, `account-home` caen en el fallback) |
| Secretos en prod | Ya están los cinco que hacen falta: `BOOTSTRAP_AUTH_SECRET`, `RESEND_API_KEY`, `STOREFRONT_TOKEN`, `SHOPIFY_ADMIN_CLIENT_ID/SECRET` |
| `ENTITIES` de prod | **0 claves** |
| A copiar desde staging | **4269**: 1480 `entity:`, 2769 `alias:`, 20 `ignore:`, 0 `children:` |
| `src/App.jsx` | **+1365 / −30** respecto a `main` |
| Worker | 43 commits que `main` no tiene |

### Tres cambios antes de empezar

**1. `noindex` en las fichas flacas.** De las 1475 fichas de entidad, **1311
tienen menos de 3 discos** (el 89 %) y solo **164** llegan a tres. Mil trescientas
páginas casi vacías es justo lo que Google castiga como contenido de relleno, y
arrastra al resto del dominio.

- El prerender pone `<meta name="robots" content="noindex,follow">` en las fichas
  con menos de 3 discos activos. `follow` y no `nofollow`: que siga los enlaces a
  los productos, que esos sí valen.
- Esas URLs **no entran en el sitemap**. El sitemap pasa de 2752 a ~1440 entradas.
- La página se genera igual: sirve para navegar y para compartir, solo que no
  pide ser indexada.

**2. Fuera `ENTITIES_WORKER_URL`.** Hoy el portal, la pestaña Entidades y el
recompute de los importers apuntan a mano al worker de staging (7 usos más el
alias `PORTAL_WORKER_URL`). Al promocionar, todo pasa a `WORKER_URL`.

> **Cuidado, y esto hay que decidirlo antes**: `VITE_WORKER_URL` **no está puesto
> en el proyecto de Pages**, así que `WORKER_URL` es el worker de producción en
> los dos entornos. En cuanto se quite la constante, **el preview de staging
> escribirá en las entidades de producción**. Si se quiere seguir probando en
> staging sin tocar prod, hay que añadir `VITE_WORKER_URL` =
> `https://houseonly-worker-staging.emontagut.workers.dev` como variable de
> entorno del *preview* en el proyecto de Pages. **Decidido el 2026-09-11: se
> añade**, y va en el paso 1 antes de quitar la constante.

**3. Cron de avisos en prod, apagado.** `wrangler.jsonc` ya declara las dos
expresiones (`*/15` para Discogs y graduación, `0 6` para los avisos) y
`scheduled()` bifurca por `event.cron`. El modo vive en KV y, al estar el
namespace de prod vacío, `getMode()` devuelve `off`: **el cron se activará pero
no mandará nada** hasta que alguien lo ponga en `live` a mano.

---

### Paso 0 — Fotografía previa — HECHO el 2026-09-11

**Los dos botones de emergencia, anotados antes de tocar nada:**

| Qué | Identificador | Corresponde a |
|---|---|---|
| Worker de prod | Version `f84297a2-dad1-44a7-9002-25f99d36cac9` | desplegado el 2026-09-09 |
| Pages producción | Deployment `1184db4c-ddfa-4f80-8104-ee6bea58a2c8` | commit `c12a3b7` de `main` |

Estado verificado: el worker de prod **no tiene** ninguno de los ocho endpoints
nuevos —todos caen en el fallback— y sí conserva los de siempre (`emails-list`,
`graduation-status`, `zip-proxy`, `sync-status`, `wishlist`). El `ENTITIES` de
prod está **vacío**. En staging hay **4269** claves que copiar (1480 `entity:`,
2769 `alias:`, 20 `ignore:`, 0 `children:`) y **13 que no se copian**
—`follow:`, `fanout:`, `alerttoken:`, `feedindex:`, `entityindex:`—, que son
clientes de prueba y cachés.

### Paso 0 — Cómo se tomó (no cambia nada)

```bash
# Version desplegada hoy en prod, que es a donde se vuelve si algo sale mal
cd houseonly-worker/houseonly-worker && npx wrangler deployments list | tail -20
# Confirmar que prod NO tiene entidades y que el namespace esta vacio
curl -s "https://houseonly-worker.emontagut.workers.dev/?action=entity-public&slug=omar-s"   # → {"imageUrl":""}
npx wrangler kv key list --namespace-id=e1148360f4af4c72ad608e60c03e9813 --remote | head
```

**Verificación**: el `entity-public` devuelve el fallback y el namespace está
vacío. **Anotar el Version ID actual de prod**: es el botón de emergencia de
todos los pasos siguientes.

---

### Paso 1 — Los tres cambios de código, en staging

Rama, PR a `staging`, y se prueba allí antes de tocar prod.

**Verificación**: `vitest run` en verde; `npm run build` genera las fichas con
`noindex` donde toca (`grep -c noindex dist/artist/*/index.html` ≈ 1311) y el
sitemap ya sin ellas; preview de Pages sigue funcionando con `VITE_WORKER_URL`
puesto en el dashboard.

**Vuelta atrás**: revertir el merge en `staging`. No hay nada en prod todavía.

---

### Paso 2 — El worker a producción

```bash
cd houseonly-worker/houseonly-worker
git checkout staging          # el worker NO va por git: se despliega desde el checkout
npx wrangler deploy           # sin --env: el entorno por defecto ES produccion
```

**Verificación**:

```bash
W=https://houseonly-worker.emontagut.workers.dev
curl -s -o /dev/null -w "%{http_code}\n" "$W/?action=entity-review-list&kind=artist"   # 401 = existe
curl -s "$W/?action=follow-alerts-mode" -H "Authorization: Bearer $PROD_BS"            # {"mode":"off"}
curl -s "$W/?action=sync-status" -H "Authorization: Bearer $PROD_BS" | head -c 200     # el Discogs de siempre, intacto
curl -s -o /dev/null -w "%{http_code}\n" "$W/?action=emails-list"                      # 401, como antes
```

Lo que **no** debe cambiar: las ventas de Discogs, la graduación, la wishlist y
el newsletter. Son aditivos los seis endpoints nuevos.

**Vuelta atrás**: `npx wrangler rollback [version-id-del-paso-0]`. Un minuto.

---

### Paso 3 — Copiar las entidades a producción

Las 1480 decisiones fueron humanas: se copian, no se repiten.

```bash
NS_STG=bf137c15dc6d4c4f8f21a9987108f2f2
NS_PRD=e1148360f4af4c72ad608e60c03e9813
# Solo estos cuatro prefijos. NO se copian follow:, fanout:, alerttoken:,
# alertsent:, feedindex: ni entityindex:  →  son de clientes de prueba y caches.
```

Un script de operación (`scripts/entities-copy-namespace.mjs`, dry-run por
defecto) que lista las claves de los cuatro prefijos, las lee con `kv bulk get`
en lotes de 100 y las escribe con `kv bulk put`.

**Verificación**:

```bash
npx wrangler kv key list --namespace-id=$NS_PRD --remote | grep -c '"name"'   # 4269
curl -s "$W/?action=entity-public&slug=omar-s" | head -c 120                  # Omar S, 11 discos
curl -s "$W/?action=entity-lookup&kind=label&raw=Deep%20Jungle"               # deep-jungle
```

**Vuelta atrás**: el namespace estaba **vacío**, así que deshacer es borrar esos
cuatro prefijos en prod. Sin riesgo de pisar nada.

---

### Paso 4 — Barrido en producción y cola

```bash
STAGING_BS=… PROD_BS=… node scripts/entities-sweep.mjs --send --prod
node scripts/entities-sweep.mjs --summary --prod
```

**Verificación**: la cola debe salir **cerca de 0**. Si la copia del paso 3 fue
completa, lo único que puede aparecer son productos entrados después del último
barrido de staging. Si salieran cientos de filas, **la copia no fue bien**: parar
y volver al paso 3.

**Vuelta atrás**: las filas de la cola son inertes —no afectan a la tienda— y se
borran con `entity-review-reject` o desde la pestaña.

---

### Paso 5 — El file-drop de `src/App.jsx`

```bash
git checkout main && git pull
git diff main origin/staging --stat -- src/App.jsx     # esperado: +1365 / −30
git diff main origin/staging -- src/App.jsx | less     # leerlo entero, no por encima
git checkout origin/staging -- src/App.jsx
npm run build                                          # vite + prerender
```

**Verificación antes de commitear**: el build pasa; el lint de `App.jsx` da los
mismos problemas que antes (86/80, ninguno nuevo); `git diff --cached --stat`
enseña **un solo fichero**.

**Vuelta atrás**: `git revert` del commit en `main` y push. Pages reconstruye
sola.

---

### Paso 6 — Pages y el prerender

El push a `main` del paso 5 dispara el build de producción.

**Verificación**:

```bash
S=https://houseonly.store
curl -s -o /dev/null -w "%{http_code}\n" $S/artist/omar-s/          # 200
curl -s $S/artist/omar-s/ | grep -E "<title>|canonical|robots"      # sin noindex: tiene 11 discos
curl -s $S/artist/<una-de-un-disco>/ | grep robots                  # noindex,follow
curl -s $S/sitemap.xml | grep -c "<url>"                            # ~1440, no 2752
curl -s -o /dev/null -w "%{http_code}\n" $S/products/<cualquiera>/  # la tienda de siempre, intacta
```

**Vuelta atrás**: revertir en `main`; o, si urge, volver al deployment anterior
desde el dashboard de Pages, que es instantáneo.

---

### Paso 7 — Smoke test con una cuenta real

Con la cuenta de Eduardo, en `houseonly.store`:

1. Icono de cuenta → `/account`. Estado vacío con sugerencias de su wishlist.
2. Seguir a un artista desde una ficha de producto → aparece el prompt de avisos
   **una sola vez**. Decir "Not now".
3. La estantería aparece; "All N →" lleva a la ficha de la entidad.
4. Encender los avisos desde Following y comprobar en KV que `follow:{cid}`
   tiene `emailAlerts: true` **y correo**.
5. `follow-alerts-run` en modo `test` a la dirección de Eduardo: un correo, con
   su logo, sus botones y su baja.
6. Dejar el modo global en **`off`**.

**Vuelta atrás**: apagar los avisos del cliente y, si hiciera falta, `wrangler
rollback` del worker. El catálogo no se toca en ningún paso de esta secuencia.

---

### Lo que esta secuencia NO hace

- **No enciende los avisos.** El cron queda activo y en `off`. Encenderlos es una
  decisión aparte, con su propia prueba en vivo.
- **No toca el catálogo.** Ni `Vendor`, ni tags, ni precios. Los metafields ya se
  escribieron en la fase 4 y están en producción desde entonces.
- **No borra el namespace de staging.** Pero a partir de la copia **la fuente de
  verdad es producción**, decidido el 2026-09-11: las aprobaciones de la cola, los
  follows y los avisos que cuentan son los de prod. `staging-ENTITIES` se queda
  como **datos de prueba**, y cuando haga falta se resincroniza *desde* prod, no
  al revés. Nadie vuelve a aprobar entidades en staging esperando que suban
  solas.

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
