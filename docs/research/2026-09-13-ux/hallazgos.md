# Experiencia de compra — siete tiendas, 13 de septiembre de 2026

Observación con capturas. Sin valoraciones y sin propuestas: solo lo que se ve.

## Método

- Chrome con ventana (no headless), escritorio **1440×1000** y móvil **390×844**.
- **Sin sesión en ninguna tienda**, houseonly.store incluida.
- Muros de cookies: se pulsa **rechazar**; nunca aceptar.
- **Retos de verificación: no se pasan.** Donde aparece, se anota y se sigue.
- Recorrido a clics desde la portada. Cuando el clic no navegó, se anota y se
  abrió la ficha por URL directa.
- **La IP de salida es alemana**: Juno sirve modal y precios de Alemania (EUR),
  y ninguna tienda mostró tarifas de envío a España sin introducir dirección.
  No se introdujo ninguna.

Capturas en `capturas/<tienda>/`: `1-home`, `2-listing`, `3-product` (en `-1440`
y `-390`), `6-agotados`, `7-trasañadir`, `7-carro`, `sonda-*`. Datos crudos en
`datos/`.

## 1 · Camino hasta un disco

| | Hard Wax | Boomkat | Juno | Clone | Bleep | Phonica | **House Only** |
|---|---|---|---|---|---|---|---|
| Clics portada→ficha | 2 | 2 | 2 | **1** (no hay ficha) | 2 | 2 | 2 |
| Entrada pulsada | "This Week" | "New Releases" | "New releases" | "New" | "Music" | "NEW RELEASES" | "ALL" |
| Decisiones pedidas | ninguna | ninguna | ninguna (modal de país antes) | ninguna | ninguna | ninguna | ninguna |
| La ficha es… | página propia | página propia | página propia | **no existe: el listado lo muestra todo** | página propia | página propia | **modal sobre la rejilla** |
| URL de la ficha | `/88761/antonio-fevola/…` | `/products/<uuid>` | `/products/<slug>/<id>-01/` | — | `/release/590960-…` | `/product/<slug>/213216` | `/products/<slug>/` |
| Enlaces `<a>` en portada | 1005 | 258 | 3577 | 700 | 226 | 729 | **0** |
| `<img>` en portada | 84 | 44 | 413 | 71 | 28 | 188 | **0** (portadas por CSS) |

House Only: la tarjeta no es un enlace; responde a un clic de JS. La ficha se
abre como capa encima del listado, sin salir de la página.

## 2 · Navegación

| | Hard Wax | Boomkat | Juno | Clone | Bleep | Phonica | **House Only** |
|---|---|---|---|---|---|---|---|
| Entradas del menú (literal, primeras) | New · This Week · Last Week · Back In Stock · Downloads · Store Sections · Label Catalog · Disco · Electronic · Outernational · Wave · Reggae-Dub · Merchandise · CDs | New Releases · All · Vinyl · CD · Cassettes · Downloads · Recommended · Pre-Orders · Merchandise · Bestsellers · Features · Weekly Roundup · Classics · Charts · 14 Track Samplers | Music · New This Week · New Today · Preorders · Last 8 Weeks · Bestsellers · Back Catalogue · Back In Stock · Coming Soon · DJ Charts · Juno Recommends · Vinyl Boxsets · Low price vinyl · Sale | Home · Labels · Artists · Genres · Charts + barra: New · Back in stock · Upcoming · Pre-order · Browse all · Recommended · Merchandise · Vintage · Discogs · Sale | Music · Bleep Exclusives · Limited Editions · Essential Bundles · New Warehouse Arrivals · Pre-Orders · Compilations & Reissues · Downloads · Merchandise · Clothing · Books & Magazines | New Releases · Back In Stock · Pre-Orders · Used Records · Genre · Sale · Merchandise · Bestsellers · Charts | **sin menú**: 2 botones (FORTHCOMING, DRUM & BASS) + buscador + 3 iconos (cuenta, wishlist, carrito) |
| Bloques de filtro en el listado | 0 | 0 | 0 | 0 | 0 | 16 | 0 |
| Desplegables | 0 | 0 | 0 | 0 | 0 | 0 | **3** (All Genres · All Labels · New Arrivals) |
| Otros controles de listado | secciones y tags en columna | — | — | pestañas New/Back/Upcoming | — | facetas laterales | fila de **años** (2026…2010, ALL) |
| Orden | no se ofrece en la página | no se ofrece en la página | no se ofrece en la página | no se ofrece en la página | no se ofrece en la página | no se ofrece en la página | 1 desplegable ("New Arrivals") |

## 3 · Ficha de producto: inventario de campos, en orden

| Hard Wax | Boomkat | Juno | Bleep | Phonica | **House Only** |
|---|---|---|---|---|---|
| 1 formato (12") · 2 precio (€14.5) · 3 catno+sello (Analogue Network 001) · 4 "Label Catalog" · 5 artista · 6 título · 7 descripción (1 línea) · 8 **tracklist A1/A2/B1/B2 con play** | 1 artista · 2 título · 3 **Cat No** · 4 **Release date** · 5 **Label** · 6 **Genre** · 7 formatos (MP3/FLAC/WAV/TAPE) · 8 precio · 9 ADD TO CRATE · 10 **stock ("In Stock — Ready To Ship")** · 11 nota de edición · 12 "Play All" · 13 **Boomkat Product Review** · 14 texto largo | 1 migas (género›sello›artista›título) · 2 "SAME DAY SHIPPING!" · 3 Wishlist · 4 Add to Chart · 5 **Email me if this price drops** · 6 precio · 7 **stock ("More than 10 in stock")** · 8 formato/variante · 9 artista · 10 título · 11 sello · 12 **Format:** · 13 **Cat:** · 14 **Released:** · 15 **Genre** · 16 **puesto en ventas** · 17 Play · 18 playlist · 19 compartir · 20 Review | 1 artista · 2 título · 3 **sello** · 4 **fecha (May 29, 2026)** · 5 formato y variante · 6 precio (USD) · 7 Add to Cart · 8 descripción de la edición · 9 lista de acabados · 10 **más formatos con su precio** (2×LP, CD, Download con MP3/WAV/FLAC) · 11 Play · 12 Gift · 13 Share · 14 texto largo | 1 género (miga) · 2 artista · 3 título · 4 **sello** · 5 precio (£) · 6 Add To Cart · 7 formato (12") · 8 texto largo · 9 tracklist con play | 1 **sello** · 2 **catno (PR31)** · 3 título · 4 artista · 5 **+ FOLLOW** · 6 dos etiquetas (género, año) · 7 descripción (1 frase) · 8 precio · 9 wishlist · 10 ADD TO CART |
| **8 campos** | **14** | **20** | **14** | **9** | **10** |

Ausencias observadas por tienda: Hard Wax no muestra año ni fecha; Phonica no
muestra catno ni fecha; House Only no muestra formato, fecha, tracklist ni
stock en la ficha (el stock sí aparece en la tarjeta del listado: "ONLY 2 LEFT").
En la ficha de House Only la portada no cargó (recuadro azul) y la descripción
imprime `&amp;` literal.

## 4 · Escucha

| | Hard Wax | Boomkat | Juno | Clone | Bleep | Phonica | **House Only** |
|---|---|---|---|---|---|---|---|
| Reproductor | sí | sí | sí | sí | sí | sí | sí |
| Desde el listado | sí | sí (58 controles) | sí (334) | **sí, corte a corte** (261) | sí (137) | sí (1 563) | sí (17) |
| En la ficha | sí, **por corte** (A1/A2/B1/B2) | "Play All" + 16 cortes | Play + añadir a playlist | — (no hay ficha) | Play | por corte | botón play en tarjeta |
| Saca de la página | no | no | no | no | no | no | no |
| `<audio>` en la página | 1 | 0 | 0 | 0 | 1 | 1 | 1 |

Phonica lleva la barra de reproducción fija con contador `00:00` en toda la web.

## 5 · Texto editorial

| | Hard Wax | Boomkat | Juno | Clone | Bleep | Phonica | **House Only** |
|---|---|---|---|---|---|---|---|
| ¿Hay texto? | sí, 1 línea | sí, 2 bloques | sí | no | sí, 2 bloques | sí | sí, 1 frase |
| Palabras (ficha vista) | **6** ("Effective driving Techno tools") | **~150** (reseña propia) + ~120 (nota del sello) | **~120** | 0 | **~70** (nota de edición) + ~150 | **~210** | **28** |
| Firmada | no | **sí: "Boomkat Product Review"** | "Review" | — | no | no | no |
| Origen aparente | propio (tono de tienda) | **propio** | propio/promo | — | propio + nota de fábrica | promo del sello (biografía y apoyos) | **generado**: "X by Y released on Z (año). <tags>. 12" vinyl. Worldwide shipping from House Only." |

## 6 · Agotados

| | Hard Wax | Boomkat | Juno | Clone | Bleep | Phonica | **House Only** |
|---|---|---|---|---|---|---|---|
| Marcas halladas en el listado | "Back In Stock" (sección) | — | "out of stock" ×1 | **"out of stock" ×3**, "back in stock", "pre-order" | — | — | **"only 1 left" ×3, "only 2 left" ×20, "pre-order" ×2** |
| Qué se ve en el agotado | sección propia de reposiciones | no observado | etiqueta en la ficha | etiqueta en la línea del disco; también "store only" | no observado en el listado mirado | no observado en el listado mirado | no se halló ninguno agotado en la portada |
| Aviso de reposición | no observado | no observado | **sí, de precio**: "Email me if this price drops" | no observado | no observado | no observado | no observado sin sesión |

House Only es la única que muestra **unidades restantes** en el listado.

## 7 · Del disco al pago

| | Hard Wax | Boomkat | Juno | Clone | Bleep | Phonica | **House Only** |
|---|---|---|---|---|---|---|---|
| Añadir desde la ficha | botón sin texto reconocible (no se pulsó) | "ADD TO CRATE" | "Add to Cart" | **desde el listado** | "Add to Cart" | "Add To Cart" | "ADD TO CART" |
| Pasos ficha→carrito | 2 | no verificado | no verificado | 1 | 2 | 2 | 1 (no hay página de carrito aparte) |
| ¿Aparece el envío en el carrito? | **no lo menciona** | no verificado | no verificado | no verificado | **sí**, "Worldwide Shipping" / "Shipping" | **no lo menciona** | menciona "WORLDWIDE SHIPPING" y "SHIPPING POLICY" en cabecera y pie |
| Coste a **España** | no aparece sin dirección | — | — | — | no aparece sin dirección | no aparece sin dirección | no aparece sin dirección |

En ninguna de las siete apareció un importe de envío a España sin introducir una
dirección. No se introdujo ninguna.

## Las tres sondas

Artista **"DJ Koze"** · Sello **"Pampa"** · Catálogo **"PAMPA024"** (SKU real de
House Only: DJ Koze — xtc, Pampa).

| | Hard Wax | Boomkat | Juno | Clone | Bleep | Phonica | **House Only** |
|---|---|---|---|---|---|---|---|
| DJ Koze | resultados; 1.º = Philpot PHP024 "DJ Koze: All The Time" | **no medible** (reto) | **499 releases** | **no medible** (reto) | **7 Records** + bloque "Artists" con variantes (DJ Koze, Dj Koze/Naum, DJ Koze feat. Ada) | 4 páginas de resultados | **7 discos**; el 7.º es "Koeru" (Mother Tongue), sin DJ Koze visible en la tarjeta |
| Pampa | resultados, pero el 1.º es "Self Reflektion REFLEKT020" | no medible | **68 items** | no medible | bloque "Labels: Pampa Records" + productos | 5 páginas | 6 discos, todos de Pampa/Maeve |
| PAMPA024 | sin resultados (solo navegación) | no medible | **98 items** | no medible | **"No Results"** | **"Unfortunately, we could not find…"** | **1 disco exacto** (xtc 2026 Repress) |

Resultados donde no debería haberlos: **Juno** devuelve 98 ítems para un número
de catálogo concreto y 68 para "Pampa"; **Hard Wax** encabeza "Pampa" con un
disco de otro sello. Falta donde debería haber: **Phonica** y **Bleep** no
encuentran nada por número de catálogo; **Hard Wax** tampoco.

## Lo que no se pudo ver

| Qué | Por qué |
|---|---|
| Clone: las tres sondas | Reto de verificación de Cloudflare en la página de resultados. No se pasa. |
| Boomkat: las tres sondas | Reto en la portada al volver a entrar, y sin caja de búsqueda accesible antes. |
| Boomkat y Juno: listado y ficha en el mismo recorrido | Su reto salta en la segunda página de una sesión. La ficha se vio abriéndola como primera página de una sesión nueva. |
| Juno: el listado "New releases" | Un modal de país ("Wir liefern nach Deutschland!") tapaba la página; la captura `2-listing` es la portada con ese modal. |
| Hard Wax: añadir al carrito | Su botón no lleva texto reconocible; no se pulsó a ciegas. |
| Boomkat, Juno, Clone: pasos hasta el pago | Depende de añadir al carrito, y el reto lo impidió. |
| Coste de envío a España en las siete | Ninguna lo muestra sin introducir una dirección, y no se introdujo ninguna. |
| Precios y modales de Juno tal como los ve un cliente español | La IP de salida es alemana: Juno sirvió EUR y mensajería de Alemania. |
| Agotados de Boomkat, Bleep y Phonica | En los listados mirados no había ninguno; no se buscó más lejos. |
| Cualquier cosa tras iniciar sesión, en las siete | No se usó ninguna cuenta. |
