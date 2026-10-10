# 2026-10-09 — Páginas de políticas propias

Rama `claude/policy-pages` desde `main` (`075efd7`). El scope
`read_legal_policies` ya está en la app (versión `houseonly-backorder-6`, 10-10)
y las seis páginas están verificadas en staging con el texto real. El worker ya
está en prod. **En producción desde el 10-10: PR #95 mezclado en `54ca883`.**

## Qué hay

- Rutas públicas **/shipping, /returns, /contact, /privacy, /terms y /legal**.
  La lista vive en `src/policies.mjs` (ruta, `ShopPolicyType`, etiqueta del
  pie, `<title>` y meta description), compartida por la app y el prerender.
- **Texto: solo el de Shopify.** El worker expone `GET ?action=shop-policies`
  (`src/lib/shop-policies.ts`): Admin API `shop { shopPolicies { type title
  body url updatedAt } }`, HTML limpio, público, 1 h de cache (KV
  `shop:policies` + `Cache-Control`).
  - Por qué el worker: el prerender solo tiene el token público de la
    Storefront, y la Storefront devuelve **vacíos** Privacy y Terms
    (comprobado) y no expone Contact ni Legal notice.
  - Limpieza: solo p, strong, a (`href` http/https/mailto/tel o ruta local),
    ul, li y h2. Fuera clases, estilos, spans y `<meta>`; `<br><br>` separa
    párrafos; `em`/`i` pasan a `strong`. Los títulos de bloque en negrita
    («Damages and issues», también en línea: «Processing time All orders…») o
    en MAYÚSCULAS pasan a h2. «Note: …» no, por los dos puntos. Se quita un
    primer h2 igual al título de la política.
  - Si Shopify contesta "Access denied", se pide un token nuevo una vez y se
    reintenta: el token de client credentials dura 24 h y guarda los scopes
    de cuando se pidió. Un fallo se recuerda 5 min (`shop:policies:error`)
    para no pedir un token por visita.
- **Prerender**: escribe cada página con `<title>`, description, canonical y
  og propios. El texto va dentro de `#root` con `data-policy-type`, más el pie.
  Las añade al sitemap. Si el worker falla, avisa y sigue: el build no se rompe.
- **App** (`PolicyPage`): layout de /ig (logo, título grande, texto a 65ch,
  botón a la tienda). Fondo #080808, texto #efefef, títulos de sección y
  enlaces en #c8ff00, Inter. En carga directa lee el texto prerenderizado
  (0 peticiones); navegando desde el pie lo pide al worker.
- **/contact**: además del texto, `info@houseonly.store` en grande (mailto) y
  debajo Instagram `@onlyhouseonly` y la tienda de Discogs
  (`discogs.com/seller/houseonly/profile`; el usuario `houseonly` está
  comprobado en la API de Discogs: 808 a la venta, España).
- **Pie**: los seis enlaces a las rutas locales, misma pestaña. El cajón de
  «Legal Notice» desaparece y es un enlace más, a /legal. Se han quitado
  `PolicyDrawer`, `POLICY_SLUGS`, `HARDCODED_POLICIES` y `fetchPolicy`.

## El bloqueo: scope `read_legal_policies`

Staging (worker `575e2ec3-9e69-463f-80b1-6e1d08a8d83d`) responde:
`Access denied for shopPolicies field. Required access: read_legal_policies`,
también tras pedir un token nuevo. Según la doc de Shopify (client
credentials), hay que:

1. En el Dev Dashboard de Shopify, app **houseonly-backorder**: crear una
   versión nueva con el scope `read_legal_policies` y publicarla (release).
2. En el admin de la tienda, aprobar el cambio de permisos de la app.
3. Nada más: el worker pide token nuevo solo al ver "Access denied". El error
   puede seguir en caché hasta 5 min.

Después: `curl -s "https://houseonly-worker-staging.emontagut.workers.dev/?action=shop-policies"`
tiene que devolver las seis políticas.

## Verificación hecha (sin el scope)

- Tests del worker: 364/364 (10 nuevos de `shop-policies`: limpieza con
  trozos reales de Refund y Shipping, enlaces seguros, mayúsculas, caché,
  reintento con token nuevo, fallo recordado 5 min). Lint 93 → 92 (uno menos
  al quitar el cajón), build OK.
- Local, con Shipping y Refund **reales** (sacados de la Storefront, limpiados
  con el mismo `cleanPolicyHtml`) en el KV local y el build apuntando a
  `wrangler dev`, en Chrome headless a 390 px:
  - el prerender escribió /shipping y /returns, y avisó y se saltó las otras
    cuatro. El sitemap lleva las dos.
  - /shipping/ y /returns/: texto real (6 y 5 secciones), 0 peticiones al
    worker (lo leen del HTML), sin scroll horizontal, 0 errores. Títulos
    «Shipping Policy — House Only», «Returns & Refunds — House Only».
  - /contact, /privacy, /terms y /legal sin datos: mensaje de error y botón a
    la tienda. /contact enseña igualmente el correo, Instagram y Discogs.
  - Pie de la home: seis enlaces locales, misma pestaña; clic en Returns →
    /returns sin recargar.
- Build contra el worker de prod (sin el endpoint): «Wrote 0 policy pages» y
  el build termina bien.
- Detalle viejo, no de esto: el HTML estático sin JavaScript de /ig y de las
  fichas ya mide 393 px a 390 px de ancho (las de políticas, 397). Con la app
  montada, 390.

## Staging (sin el scope)

Pages de staging sirve el bundle `index-CLBLd7Tl.js`. Chrome headless a 390 px:
- las seis rutas cargan con su `<title>` propio, sin scroll horizontal, con el
  mensaje de error y el botón a la tienda. El único error de consola de cada
  una es el 502 del worker: falta el scope.
- /contact enseña el correo, Instagram y Discogs.
- Pie con los seis enlaces locales, misma pestaña, en la portada, /ig y una
  ficha, con 0 errores.

## Textos que estaban escritos a mano en la app (para Shopify)

El cajón de Legal Notice y el de Contact NO leían Shopify: tenían el texto
dentro de `src/App.jsx`. Ese código se ha quitado. Si en Shopify no hay
«Legal notice» o «Contact information», /legal y /contact saldrán sin texto.
Así que, si hace falta, pegar esto en Settings → Policies:

**Legal notice** (tal cual estaba):

> **HOUSEONLY** is operated by:
> **Telsnap S.L.** · NIF: B75303990 · Registered in Spain
> **Contact:** info@houseonly.store
> The European Commission provides a platform for online dispute resolution
> (ODR) accessible at ec.europa.eu/consumers/odr.
> All content on this website is the property of Telsnap S.L. or its content
> suppliers and is protected by applicable intellectual property laws.

**Contact information** (tal cual estaba):

> For any questions about your order, shipping, or general enquiries:
> **General:** info@houseonly.store · **Orders:** orders@houseonly.store
> We aim to respond within 24–48 hours on business days.

## Orden para sacarlo a producción (cuando esté el scope)

1. Comprobar en staging que `shop-policies` devuelve las seis y que las páginas
   salen con texto (rehacer el build de staging si hace falta).
2. Worker a prod:
   `cd houseonly-worker/houseonly-worker && NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection" npm run deploy`
3. Comprobar `GET ?action=shop-policies` en prod.
4. Solo entonces, merge del PR a `main`: el build de Pages de main lee el worker
   de prod. Si el worker de prod no tuviera aún el endpoint, el pie apuntaría a
   seis páginas con «We couldn't load this page».

## 10-10 · Scope activo, token renovado y texto pulido

### Por qué seguía el "Access denied" con el scope ya activo

El token del Admin API se guarda en WISHLIST KV (`shopify_admin_token`, 23 h;
**el mismo namespace en prod y staging**). Un token de client credentials
lleva los scopes del momento en que se emite, y `shopifyAdminGraphQL` solo lo
renovaba con HTTP 401. Un scope que falta llega como HTTP 200 con "Access
denied … access scope" en `errors`, así que el token viejo seguía en uso.

Además, el reintento que tenía `shop-policies` releía el token de KV justo
después de escribirlo, y KV no garantiza leer lo recién escrito. El fallo
quedaba en caché 5 min.

**Arreglo, en `shopifyAdminGraphQL`, para todas las consultas:** ante "Access
denied … access scope" pide un token nuevo y reintenta **con ese token**, sin
releer KV. Como mucho una vez cada 5 min (marca
`shopify_admin_token_scope_retry` en WISHLIST), para que un scope que falte de
verdad no cueste un token por llamada. `shop-policies` ya no tiene su propia
renovación. Tests: `test/shopify-admin-token.spec.ts` (5).

Cuando se activó el scope, staging ya devolvía las seis políticas (había
caducado el error en caché). Aun así se borró `shopify_admin_token` de
WISHLIST, que afecta a prod y staging: los dos pidieron uno nuevo sin problema.
También se borraron `shop:policies` y `shop:policies:error` de staging, para
que saliera el formato nuevo.

### Limpieza y reglas

- Común: fuera atributos (`dir`, `class`…), `<p>&nbsp;</p>` y el h1/h2 inicial
  que repite el título aunque lo diga con otras palabras («Contact
  information» bajo «Contact», «Shipping policy», «Terms of Service — House
  Only»): se quita si **empieza** por el título.
- Terms: Shopify guarda cada título numerado como `<ol start="N"><li>Título</li></ol>`
  y pasa a `<h2>N. Título</h2>`. Solo si la lista tiene un único punto corto
  sin punto final: una lista de verdad no se toca. «Last updated» sale a un
  campo `lastUpdated` y se pinta pequeño y en gris bajo el título (también
  en Privacy).
- /returns, regla solo de `REFUND_POLICY`: «Damaged, defective or wrong
  records» antes de «If a record arrives damaged…» y «EU customers» antes de
  «If you're in the EU…».
- /contact, regla solo de `CONTACT_INFORMATION`: fuera la línea de Instagram
  del texto y el mailto queda como texto. El correo en grande (mailto) y
  debajo Instagram y Discogs salen **una vez** cada uno.
- Diseño: sin logo grande (ya está en la cabecera) y sin el bloque «Join the
  list». Orden: cabecera, título, «Last updated», texto, pie.
- Tests del worker: 373/373. Lint 92 (ninguno nuevo). Build OK.

### Verificación en staging (worker `f8106319-d893-4296-8894-3926fc151dc3`)

`shop-policies` con los textos nuevos: Shipping con «15–30 business days»;
Returns empieza por «You can return a record within 14 days» y lleva sus dos
h2; Terms con **13** h2 («1. The shop» … «13. Contact») y «Last updated: 10
October 2026»; Contact sin enlaces en el texto; Legal con «Telsnap S.L.» y
«ESB75303990»; Privacy con 13 h2.

Pages de staging prerenderiza las seis (title propio, `data-policy-type`, en el
sitemap). Chrome headless a **390 px y a 1280 px**, en las seis: texto real,
h2 en lima `rgb(200,255,0)`, 0 errores de consola, sin scroll horizontal,
0 peticiones al worker (leen el prerender), solo el logo de la cabecera, sin
newsletter y pie con los seis enlaces locales. En /contact: mailto 1,
Instagram 1, Discogs 1.

### Producción

- Worker en prod **`9e25fcdc-9b42-4550-a379-03e3b22f4739`** desde
  `claude/policy-pages` (`bac297c`); rollback: `55854aa6…`. `GET
  shop-policies` en prod: las seis, con los textos nuevos, `Cache-Control:
  public, max-age=3600`. `sync-status`, `google-feed` e `ig-feed` siguen en 200.
- **Sin merge**: PR #95 fuera de draft, esperando el OK. Al mezclar, el build de
  Pages de main ya encontrará el endpoint en el worker de prod.

## Producción (10-10)

- **main**: PR #95 mezclado con merge commit, **`54ca883`**. El árbol es
  idéntico al de la rama verificada en staging. Rama remota
  `claude/policy-pages` borrada (el repo no las borra solo).
- **Worker en prod `9e25fcdc-9b42-4550-a379-03e3b22f4739`** (desplegado antes
  del merge, para que el build de main encontrara `shop-policies`).
- **Pages** sirve el bundle `index-aoa4UoNO.js`. Las seis páginas están
  prerenderizadas con su `<title>` y `data-policy-type`, y van en el sitemap.
- Chrome headless a 390 px en houseonly.store, en las seis: texto real de
  Shopify, 0 errores de consola, sin scroll horizontal, 0 peticiones al worker
  (leen el prerender), sin logo grande ni newsletter.
  - /shipping con «15–30 business days»; /returns empieza por «You can return
    a record within 14 days» y lleva sus dos h2 en lima.
  - /contact: correo grande, Instagram y Discogs, una vez cada uno.
  - /privacy: 13 secciones y «Last updated: July 31, 2026». /terms: 13
    secciones numeradas y «Last updated: 10 October 2026».
  - /legal con «Telsnap S.L.» y «ESB75303990».
- Pie en la portada, /ig y una ficha: los seis enlaces locales (Shipping,
  Returns, Contact, Privacy, Terms, Legal Notice), misma pestaña, 0 errores.
