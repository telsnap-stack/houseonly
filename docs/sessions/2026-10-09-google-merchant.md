# 2026-10-09 — Google Merchant Center: feed propio y políticas en el pie

Rama `claude/google-merchant` desde `main` (`442795e`). Worker solo en staging.

## Pie con políticas

- Los cinco enlaces (Shipping, Returns, Contact, Privacy, Terms) a las páginas
  de políticas de Shopify, en una sola lista: `src/policies.mjs`, que importan
  `src/App.jsx` y `scripts/prerender.mjs`.
- En la app son `<a target="_blank" rel="noopener noreferrer">` de verdad,
  dentro de `<footer><nav aria-label="Store policies">`. Antes eran botones que
  abrían un cajón, y Merchant Center no puede seguir eso. «Legal Notice» no
  estaba en la lista y sigue en su cajón.
- En el HTML prerenderizado (portada/fallback, `/ig`, fichas de producto y de
  entidad), el pie va **dentro de `#root`**: lo ve quien no ejecuta JavaScript,
  y al montar, `createRoot` lo sustituye por el de la app. Se aplica lo último.

## Feed de Google (`src/lib/google-feed.ts`)

- `GET ?action=google-feed`: RSS 2.0 con `xmlns:g`, público,
  `application/xml; charset=utf-8`, cabeceras `X-Feed-Built-At` y
  `X-Feed-Items`. Se sirve de `SYNC_STATE` (`google:feed`, fecha y recuento en
  los metadatos); si no hay nada, se genera en el momento y se guarda.
- `POST ?action=google-feed-rebuild` (`bearerAdminValido`) lo fuerza y
  devuelve el resumen (cuántos entran y por qué se salta cada uno).
- El cron diario `0 6 * * *` lo regenera; el resultado queda en
  `meta:google_feed_last_run`. Si falla, se queda el de ayer.
- Entra: producto ACTIVE (Admin API, `status:active`, 50 por página), alguna
  variante con `inventoryQuantity > 0` y sin el tag `forthcoming`. Es la regla
  de la rejilla: los request/backorder tienen stock 0. Los de D&B entran, porque
  se venden en su sección.
- **`g:link` con el slug del sitio, no con el handle.** `/products/<handle>/`
  sirve la portada (`<title>houseonly</title>`; comprobado en prod con
  `fat072`), así que Google vería otra página. Se usa `makeReleaseSlug(vendor,
  title, SKU de la primera variante)`, lo mismo que `scripts/prerender.mjs`.
- `g:google_product_category` **543523** = "Media > Music & Sound Recordings >
  Records & LPs", de la taxonomía oficial
  (`taxonomy-with-ids.en-US.txt`, versión 2021-09-21). No hay hoja "Vinyl".
- `g:gtin` solo con 8, 12, 13 o 14 dígitos y dígito de control GS1 correcto;
  sin él, `g:identifier_exists = no`. `g:brand` = tag `label:`; `g:mpn` = SKU.
  `g:title` "Artista – Título" (el vendor "House Only" no cuenta como artista),
  a 150 como mucho. `g:description` con `descripcionDeProducto`, a 5000 (si
  queda vacía, el título). Sin `g:shipping_weight`.
- Campos de la Admin API `2026-04` comprobados en la doc: imagen por
  `featuredMedia { preview { image { url } } }` (`featuredImage` está
  deprecado); `price`, `barcode`, `sku` e `inventoryQuantity` vigentes.
- Se saltan también los que no tienen imagen: `image_link` es obligatorio.
- Tests `test/google-feed.spec.ts` (14): sin barcode → `identifier_exists=no`;
  EAN-13 válido → `g:gtin`; checksum malo → como sin barcode; forthcoming y
  stock 0 no entran; XML bien formado con caracteres escapados; GET genera,
  guarda y la segunda vez sirve de KV; rebuild 401 sin Bearer. Suite: 352/352.

## Verificación en staging

- Worker staging `8238b620-1497-458a-a13f-1dd0488a3493`. Primera llamada:
  genera en vivo en 8,4 s, 1,15 MB, **1019 items**. Rebuild sin Bearer → 401.
- `xml.etree` lo parsea sin error. 0 ids repetidos, 202 con `g:gtin` y 817 con
  `identifier_exists=no`, 29 sin sello (sin `g:brand`). Ningún título pasa de
  150 ni descripción de 5000, todos los precios son "NN.NN EUR" y ninguno
  lleva `shipping_weight`.
- **Los 1019 `g:link` tienen su página prerenderizada** en el build.
- Cuadre con la Storefront API: 1400 publicados, 114 forthcoming, **1044**
  vendibles (stock > 0 y sin forthcoming). Los 25 que faltan no tienen imagen
  en Shopify (TOYT128, WGVINYL81, VA003, varios FOKUZ…). 1044 − 25 = 1019. No
  hay nada en el feed que no esté en la tienda.
- Pie en staging, Chrome headless a 390 px: portada, `/ig` y una ficha. Los
  cinco enlaces con su URL y `target=_blank`, sin scroll horizontal, 0 errores
  de consola. También en el HTML servido de las tres páginas (5 de 5). En la
  ficha el pie queda detrás del modal, como el resto de la página.
- Build OK, lint 93 → 93 (ninguno nuevo).

## Datos de Shopify que Merchant Center puede señalar

- `identifier_exists=no` junto a `g:brand` + `g:mpn`: la ayuda de Google dice
  que con marca y MPN lo correcto es omitirlo o ponerlo a `yes`, y avisa
  (warning, no rechazo). Se ha dejado como pedía la especificación; cambiarlo
  es una línea en `itemXml`.
- 387 discos sin descripción en Shopify llevan el título como `g:description`.
- 56 descripciones empiezan a mitad de frase porque el texto de Shopify ya
  viene cortado (p. ej. BARN129, «fl ute of the region…»). La ficha enseña lo
  mismo.
- 25 discos con stock no tienen imagen y no entran en el feed.

## Cierre (10-10)

- **`identifier_exists`**: se omite cuando el item lleva `g:brand` y `g:mpn`, y
  solo va a `no` si no hay GTIN ni sello. En prod: de 817 a **25**. Test
  ajustado (sin sello → `no`; con sello y MPN → omitido; con GTIN → omitido).
  Suite: 354/354.
- **Worker en prod `55854aa6-fa5b-434d-819a-c8bbccf3e368`** (rollback:
  `3f833105…`), desplegado desde `claude/google-merchant` (`1289ae2`). Staging
  `29f85fcd-69e0-4664-af71-40a9fa481b88`; su copia vieja en KV se borró con
  wrangler para que se regenere con la regla nueva.
- **KV caliente sin Bearer**: la primera `GET google-feed` en prod la generó y
  la guardó (8,1 s, 1019 items, built-at `2026-10-10T01:59:32Z`). Las tres
  siguientes salen de KV (mismo built-at): primer byte en 0,41-0,58 s; bajar
  los 1,1 MB entero tarda 1,1-1,4 s en esta conexión. `application/xml;
  charset=utf-8`, parsea, 0 ids repetidos, 202 con GTIN. `google-feed-rebuild`
  sin Bearer → 401. No se ha lanzado con Bearer: no hacía falta.
- 3 `g:link` al azar (DAT071, DAT073, P98-014) → 200 con el título de su ficha
  ("Nosebleed EP — Pascal | House Only", etc.), no "houseonly".
- **main**: #93 → `1401d61`. Pages sirve `index-lj_xkynv.js`. El pie, en
  portada, `/ig` y una ficha de prod a 390 px: 5 enlaces con
  `target=_blank`, sin scroll horizontal, 0 errores de consola; también en el
  HTML servido de las tres.

## Para arreglar otro día

### 25 discos con stock y sin imagen (fuera del feed)

| SKU | Stock | Handle |
|---|---|---|
| `TOYT128` | 1 | `toyt128` |
| `WGVINYL81` | 1 | `wgvinyl81` |
| `VA003` | 1 | `va003` |
| `AUS1136` | 1 | `aus1136` |
| `FM12004` | 1 | `fm12004` |
| `DES121-LTD` | 2 | `des121-ltd` |
| `FOKUZ016.2` | 2 | `fokuz016-2` |
| `FOKUZ017` | 2 | `fokuz017` |
| `FOKUZ022` | 1 | `fokuz022` |
| `FOKUZ071_` | 2 | `fokuz071` |
| `FOKUZ114RP2_` | 2 | `fokuz114rp2` |
| `FOKUZ115RP1_` | 2 | `fokuz115rp1` |
| `FOKUZLP003` | 1 | `fokuzlp003` |
| `SOULR056` | 2 | `soulr056` |
| `SOULR062RP` | 2 | `soulr062rp` |
| `CRN001` | 2 | `crn001` |
| `DESLP18` | 2 | `deslp18` |
| `DES133` | 1 | `des133` |
| `164422902` | 2 | `164422902` |
| `AOS-2023` | 2 | `aos2023` |
| `AOS-432-J` | 1 | `aos432j` |
| `AOS-444` | 2 | `aos444` |
| `AYHR0060` | 2 | `ayhr0060` |
| `BIGFXHE` | 2 | `bigfxhe` |
| `PR31` | 2 | `pr31` |

### 56 descripciones que empiezan en minúscula (no todas están cortadas)

El criterio fue "empieza en minúscula", y se pasa de largo. Repasadas:
- **21 cortadas de verdad tras una ligadura rota** ("fi rst", "fl oor"…), más
  unas pocas claramente a mitad de frase: AUS1354 ("rhythms. What follows…"),
  CADENZA104 ("that's designed to…") y RS079LP ("the back of an epic…").
- **19 son solo "artista – título" en minúsculas**, probablemente completas:
  AUS175, RISQUEE28, ACGC2, CGTX003, HOUSEWAX008, HOUSEWAX009, HOUSEWAX012,
  HOUSEWAXLTD007, M&F016, AMB3922LP, YRE012, INT005, MACROM09, VALT2,
  MIRAU013, RC040, CKNOWEP75, CADENZA111, 868209.
- El resto son textos enteros que empiezan en minúscula ("housewax is proud
  to welcome…", "super limited…", "black vinyl Tracklist…"): mirar uno a uno.


El texto ya viene cortado en Shopify (la ficha enseña lo mismo). Muchos cortes
caen justo después de una ligadura rota ("fi rst", "fl oor"), así que parece
que el importador perdió el principio al encontrarse una ligadura `ﬁ`/`ﬂ`.
Revisar con `src/lib/ligatures.ts` antes de reescribir nada a mano.

| SKU | Empieza por |
|---|---|
| `BARN129` | fl ute of the region, ARN4L2’s instinct for propul… |
| `HEIST099` | fi rst cover feature on Spotify, multiple radio 1… |
| `TOYT193` | fi rst shows abroad in countries like France, the… |
| `DIRT156` | fl oor material at it’s best! Followed by the deep… |
| `TOYT178` | fi rst EP by Josh Ludlow for Toy Tonics. Mastermin… |
| `YRE-054` | fi rmly in the Detroit sound with a nod to the sou… |
| `TOYT177` | fi ts with the current wave of funky house and gro… |
| `TOYT159` | fi rst EP also this one was recorded in Barcelona… |
| `TOYT161` | fi rst place he rarely releases music. Why? Becaus… |
| `AUS175` | rRoxymore – I Wanted More… |
| `YRE-040` | fl ip, “Midnight Sky” grooves as boldly, this time… |
| `FP070` | fl oor. Norwegian techno's grand old man Per Marti… |
| `RISQUEE29` | fl acid-to-hard, and identifiable-to-WTF? moments,… |
| `WGVINYL38` | fl ying solo to create a stunning journey that lan… |
| `RISQUEE28` | jichael mackson – catch 22… |
| `ACGC2` | a guy called gerald – tronic jazz the berlin sessi… |
| `CGTX003` | gemini sounds – r u afraid ep… |
| `HOUSEWAX001LPS` | daniela will release her 2nd album on housewax - w… |
| `HOUSEWAX006` | housewax is proud to welcome neville watson & nick… |
| `HOUSEWAX008` | mome – tikka ep… |
| `HOUSEWAX009` | red 7 (neville watson & nick woolfson) – the space… |
| `HOUSEWAX012` | massiande – heart rushed love ep… |
| `HOUSEWAXLTD007` | rick wade – The Vault… |
| `HW011` | houseworx proudly welcomes legendary jordan fields… |
| `HW020` | supported by YouAndMe Steve Lawler Matt Star Meat… |
| `M&F016` | m&f016 Various Artists - 10 Years Of Muzik & Frien… |
| `VISIO054` | a fresh take on the 2020 gem from Alex Attias, bri… |
| `BARN127` | fl ip sees the formula in its straightest, driest… |
| `SAT072` | fi rst time. Opening the A-side is a brand new and… |
| `PLD047` | lim. 2026 Reissue! Ian Pooley brings back his time… |
| `MAEVE035` | fi rst in a new run of releases scheduled througho… |
| `FM12080` | fi rst time. Tom drops the vocal house bomb “Watch… |
| `AMB3922LP` | aphex twin – selected ambient works 85 - 92… |
| `YRE012` | andy vaz – different times ep… |
| `INT005` | frankie flowerz – break the barriers, john daly re… |
| `MACROM09` | raudive – cone ep… |
| `VALT2` | tolga fidan – so long paris… |
| `MIRAU013` | aeromaschine – ascultam vorbe ep… |
| `QUINTESSE32` | paskal & urban absolutes henry l.& i. s. – b.d.d.k… |
| `AUS1354` | rhythms. What follows, 'I'll Take You New Release… |
| `CCS083` | fi rst fullyfledged vinyl offering from Scott and… |
| `RC040` | the analog roland orchestra – patterns 3 / 4… |
| `CADENZA94` | fl ip, "There Is No Answer" is another playful sli… |
| `RB139` | phil weeks ft. ladybird – searching in love… |
| `AST042` | super limited. London producer SusTrapperazzi has… |
| `AWAYLMTD002` | black vinyl Tracklist A Silk Route part 1 B Sleepl… |
| `CKNOWEP75` | djfix – The Dial EP… |
| `CADENZA116` | fl uffy percussions and metallic bonks, with a tri… |
| `CADENZA111` | luciano – the great amael, audion rmx… |
| `CADALMA001` | luciano, felipe venegas, diego errázuriz – alma so… |
| `CADENZA104` | that's designed to circulate around the brain. Spl… |
| `RS079LP` | the back of an epic 3 part triple album “Sidequest… |
| `IF1104STD` | territories : ww -fr -uk -benelux Genre • Electron… |
| `CHCH05` | fl oating pitch and colourful pads carrying you ba… |
| `868209` | crystal waters – gypsy woman… |
| `F047` | re-pressing of this in-demand Moodyman produced cl… |

