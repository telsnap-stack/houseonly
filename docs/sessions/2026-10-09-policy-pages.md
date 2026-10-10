# 2026-10-09 — Páginas de políticas propias

Rama `claude/policy-pages` desde `main` (`075efd7`). **Bloqueada: a la app de
Shopify le falta el scope `read_legal_policies`** (ver abajo). No se debe
mezclar a `main` hasta resolverlo.

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
