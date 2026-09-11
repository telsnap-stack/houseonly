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

## Fase 4 y 5: diseño

Escrito antes de implementar nada. Tres piezas: el slug llega al producto (4),
el cliente sigue entidades (5a) y el cliente ve lo suyo (5b).

### (a) Los importers resuelven al generar el CSV

Hoy los 8 importers escriben `Vendor` y un tag `label:` con el texto del
distribuidor, y ahí se acaba la historia: el slug canónico no llega nunca al
producto. Sin eso, cualquier pantalla que pinte o filtre por entidad tiene que
resolver de nuevo en cada carga.

**Dos llamadas por importación, no una por fila.** Al pulsar "generar CSV", el
importer junta todos los vendors y todos los valores de `label:` de la tanda y
hace dos `POST ?action=entity-resolve` (`kind: 'artist'` y `kind: 'label'`) con
`context.handle` para que la cola tenga muestras. `resolveBatch` ya está hecho
para esto.

**Columna nueva en el CSV.** Shopify importa metafields con la cabecera
`Nombre (product.metafields.{namespace}.{key})`, y **no admite tipos `list.*`
de texto por CSV** (comprobado en la doc de Shopify, no supuesto). Así que:

```
Artist entities (product.metafields.houseonly.artist_slugs)   → "delano-smith,brian-kage"
Label entity   (product.metafields.houseonly.label_slug)      → "freerange-records"
```

`single_line_text_field` con los slugs **separados por coma**, que es exactamente
como `alias:{k}:{norm}` guarda ya varios slugs. Misma convención en los dos
sitios, un solo parser. Las definiciones de metafield (namespace `houseonly`) se
crean una vez a mano en el admin de Shopify; sin definición, la columna se
importa igual pero no se puede filtrar por ella.

**Lo que va en review no bloquea nada.** Si un valor vuelve con
`status: 'review'`, la celda va **vacía** y el producto se sube igual. Es la
misma regla que ya rige con Discogs: el catálogo no espera a la cola. El hueco se
rellena después, y hay dos caminos que conviene no confundir:

- **Productos nuevos**: el webhook `products/create` —que ya corre el matcher de
  Discogs— llama a `entity-resolve` y, si resuelve, escribe el metafield por
  Admin API (`metafieldsSet`). Así el slug llega aunque el producto no venga de
  un importer.
- **Lo ya subido con la celda vacía**: un script de operación
  (`entities-backfill-metafields.mjs`, dry-run por defecto) que repasa el
  catálogo, resuelve y escribe solo donde falte. Es el mismo patrón que
  `backfill-*.mjs`.

El Bearer: la pestaña Entidades ya guarda el secreto en memoria al conectarse.
Si no está, **el importer no se para**: genera el CSV sin la columna y lo dice.
Un importador que deja de funcionar porque falta un token de una función
accesoria es peor que un CSV sin metafield.

### (b) Follows: esquema y endpoints

Calco literal de `wl:`, porque ya resolvió estos problemas.

```
follow:{customerId}        → { entities: string[], updatedAt: number }
fanout:{slug}:{customerId} → "1"
```

`entities` guarda **slugs, nunca nombres**. `WishlistItem` copió `artist` y
`label` como texto y por eso hoy no se puede seguir a nadie desde la wishlist;
ese error no se repite.

| Endpoint | Método | Qué |
|---|---|---|
| `?action=follows` | GET | Lista del cliente, ya hidratada: `slug`, `display`, `roles`, y `parent` si lo tiene |
| `?action=follows` | POST | `{ slug }` → alta. Escribe el blob **y** `fanout:{slug}:{cid}` |
| `?action=follows` | DELETE | `{ slug }` → baja. Borra las dos cosas |
| `?action=follows-merge` | POST | `{ entities: string[] }` → funde la lista de invitado al entrar en la cuenta |

Autenticación **idéntica** a wishlist: `resolveCustomerId(env, { session, token })`
—sesión CAAPI primero, token legacy como degradación— y `401 {"error":"auth"}` si
no hay cliente. El invitado guarda su lista en `localStorage` y `follows-merge`
la funde al entrar, igual que `wishlist-merge`.

Detalles que no son caprichos:

- **Alta: el blob primero, el fanout después.** Si falla lo segundo, el cliente ve
  el follow (que es lo que él nota) y el fanout se reconstruye desde los blobs.
  Al revés, se notificaría a alguien que no ve el follow en su lista.
- **Baja: el fanout primero.** Lo grave al darse de baja es seguir recibiendo
  avisos.
- **Tope de 500** entidades por cliente, como los 500 items de la wishlist.
- **El blob tiene carrera** (dos pestañas del mismo cliente). Es la que ya tiene
  `wl:` y se acepta. El fanout **no**, por eso es una clave por par.
- **Entidad `merged`**: al leer se sigue `mergedInto` y se devuelve la viva; el
  blob se reescribe con el slug bueno la primera vez que se lee.

### (c) Feed: lo nuevo de lo que sigo

```
GET ?action=feed&session=…&limit=24&cursor=…
→ { items: [{ handle, title, artist, label, slugs, imageUrl, price, currency,
              createdAt, forthcoming, releaseDate, stock, via }], cursor }
```

`via` dice **por qué** aparece cada disco (`"dj-koze"`, `"freerange-records"`):
sin eso, una lista de novedades es indistinguible de la portada.

**De dónde salen los productos.** El worker ya tiene la pieza:
`nlFetchRecentProducts(env, days)` pagina por Storefront con `sortKey
CREATED_AT` y hace dos pasadas, `forthcoming` y no-`forthcoming`, que es
justo el corte que pide el feed. El feed **reutiliza esa función**, cachea la
ventana en KV unos minutos —todos los seguidores miran la misma— y la filtra en
memoria contra los slugs del cliente.

**Ventana, no historia.** Filtrar en memoria significa que el feed responde
"qué ha salido de lo tuyo", no "todo lo de DJ Koze". Para lo segundo haría falta
o un índice propio (`byslug:{slug}:{createdAt}:{handle}` en KV, escrito por el
mismo sitio que escribe el metafield) o consultas por metafield en Admin API. **Es
la decisión abierta de esta fase** y conviene tomarla antes de escribir el
endpoint, porque cambia si hace falta índice o no.

- Orden `createdAt` descendente, con los `forthcoming` marcados pero **en la
  misma lista**: un pre-order de un sello que sigues es la noticia, no una
  sección aparte.
- `cursor` opaco: `createdAt|handle` del último devuelto, que es estable aunque
  entren productos nuevos mientras se pagina.
- **Expansión hacia abajo**: seguir a `chiwax` incluye `chiwax classic edition`.
  Se lee `children:{slug}:*` al montar el conjunto de slugs del cliente. Es el
  espejo de la expansión hacia arriba que usan las notificaciones, y el motivo de
  que el índice `children:` exista.
- Sin entidades seguidas → `items: []` y un cuerpo vacío honesto, no la portada
  disfrazada de feed.

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

### Deuda: `src/App.jsx` diverge entre `staging` y `main`

**66 commits de `App.jsx` en `staging` que no están en `main`**, de los que solo
6 son de entidades. La pestaña Entidades además tiene `ENTITIES_WORKER_URL`
clavado al worker de staging.

Un `git merge staging` a ciegas metería en producción mucho más que la capa de
entidades, y el cherry-pick uno a uno no vale: los commits vienen entrelazados
con cambios del worker. **Se resuelve por file-drop** —tomar el `App.jsx` de
`staging` entero, revisarlo contra el de producción y subirlo como un solo
cambio consciente— **antes de que salga el portal de cliente**, no el día del
portal. Mientras no se haga, cada arreglo que toque `App.jsx` en las dos ramas
se paga dos veces.

## Lo que este diseño no hace

- **No adivina.** Ninguna entidad se crea sin que una persona la apruebe. Aquí ya
  han llegado matches equivocados a clientes por automatizar de más.
- **No toca el catálogo.** `Vendor` y los tags `label:` siguen exactamente igual;
  la capa de entidades vive al lado. Volver atrás es borrar un namespace.
- **No arregla los datos sucios de origen.** La corrupción de ligaduras
  (`Bano ff ee Pies`, `Forti fi ed Audio`, `O ff   House`, `Synaptic Cli ff s`)
  viene del parseo de PDF y se corrige en el importer, fase 4.
