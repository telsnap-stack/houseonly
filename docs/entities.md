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

## Lo que este diseño no hace

- **No adivina.** Ninguna entidad se crea sin que una persona la apruebe. Aquí ya
  han llegado matches equivocados a clientes por automatizar de más.
- **No toca el catálogo.** `Vendor` y los tags `label:` siguen exactamente igual;
  la capa de entidades vive al lado. Volver atrás es borrar un namespace.
- **No arregla los datos sucios de origen.** La corrupción de ligaduras
  (`Bano ff ee Pies`, `Forti fi ed Audio`, `O ff   House`, `Synaptic Cli ff s`)
  viene del parseo de PDF y se corrige en el importer, fase 4.
