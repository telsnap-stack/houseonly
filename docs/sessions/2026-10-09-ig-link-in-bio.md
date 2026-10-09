# 2026-10-09 — /ig: link in bio de Instagram

Página pública `houseonly.store/ig`, destino fijo del link de la bio de
@onlyhouseonly: los discos que han salido en Reels, el más reciente primero. La
alimenta solo el generador de Stories del admin.

Rama `claude/ig-link-in-bio`, sacada de `claude/cierre-reels` (PR #88, aún sin
mergear): necesita su selector de cierre. Si #88 entra antes, el PR de esta
rama se queda solo con lo suyo.

## Worker

- `src/lib/ig-feed.ts`. Clave `ig:feed` en **SYNC_STATE** (id distinto en prod
  y staging; no se ha creado ningún namespace). Valor
  `[{handle, sku, title, artist, addedAt}]`, máx. 40, sin duplicados por handle:
  repetir uno lo sube al principio con `addedAt` nuevo.
- `GET ?action=ig-feed` → público, `{items}`, `Cache-Control: public, max-age=60`.
- `POST ?action=ig-feed-add {handle, sku, title, artist}` y
  `POST ?action=ig-feed-remove {handle}` → `bearerAdminValido`. Handle validado
  (minúsculas, dígitos, guiones); remove de algo que no está → 404.
- KV no tiene escritura atómica: dos escrituras a la vez podrían pisarse. Con
  una sola persona escribiendo desde el admin basta leer-modificar-escribir.
- `test/ig-feed.spec.ts`: 11 tests (insertar al principio, repetido no duplica,
  remove, tope de 40, y por la ruta real: GET público con cache, 401 sin Bearer
  o con uno malo, add/remove con Bearer). Suite entera: 337/337.
- `scripts/verify-ig-feed.sh [staging|produccion]`: comprueba un worker
  desplegado. Pide el Bearer sin eco; prueba con un handle falso y lo borra.

## Frontend

- **`handle` no es filtro de la Storefront API.** `products(query:"handle:a OR
  handle:b")` no da error: la tienda lo ignora y devuelve 10 discos cualquiera
  (comprobado hoy; la doc de `2024-01` no lo lista). `/ig` usa un alias de
  `product(handle:)` por disco, en lotes de 20, mismos campos y `parseProduct`.
  Mantiene el orden del feed y se salta los handles que ya no existen.
- `parseProduct` expone `handle`, y las tres consultas que lo alimentan lo
  piden. Hacía falta para que el admin sepa el handle del disco elegido.
- Ruta `/ig` en `portalRoute` → `IgFeedPage`: logo, "Seen on Instagram",
  buscador en cliente (título, artista, sello, catálogo), la misma `RecordCard`
  del grid y la marca "Sold out" encima si el stock es 0 (no en pre-orders, que
  tienen 0 por definición). Feed vacío o caído: mensaje y botón a la tienda.
- Al cerrar un disco abierto desde `/ig` se vuelve a `/ig`, no a la portada.
  El resto de rutas siguen como siempre (comprobado: la portada cierra a `/`).
- `document.title` propio mientras está montada; `scripts/prerender.mjs`
  escribe `dist/ig/index.html` con título, descripción, canonical y og propios.
  No va al sitemap.
- Admin (Stories): sección "Link in bio" bajo "Cierre del vídeo": feed actual
  (título · artista · catálogo, fecha) con "Quitar", y "Añadir al link in bio"
  para el disco elegido (`fetchAdmin`). Al exportar con el cierre «Link in bio»
  (`ctaMode === 'bio'`, el valor que ya se guarda; no `'linkinbio'`), el disco
  se añade solo y sale "Añadido al link in bio". Con Seguir o Ninguno no se
  añade nada.

## Verificación

- `npm run build` OK (el prerender falló una vez por un timeout de red y pasó
  al repetir). Lint: 93 problemas antes y después, ninguno nuevo.
- Local, `wrangler dev` + KV local sembrado con 5 handles (uno agotado, uno
  inexistente), Vite apuntando a él, Chrome headless a 390 px:
  orden del feed respetado (no el de Shopify), el inexistente no sale, "Sold
  out" solo en el agotado, buscar `barn1` deja solo BARN129, sin scroll
  horizontal, cerrar vuelve a `/ig`, y los estados de error (petición cortada)
  y de feed vacío enseñan su mensaje con el botón.
- Comprobado que la siembra fue local: `ig:feed` no existe en el KV de prod.

## Despliegue a producción (09-10)

- **Worker** desde `claude/ig-link-in-bio` (`b9cb56f`), con
  `NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"
  npm run deploy`. Frenos OK (85 rutas de main, 3 nuevas, 0 líneas borradas).
  Versión en prod **`7678bafd-225b-4780-bc98-3bf7cf6cb447`** (08:48:16 UTC).
  Anterior, para un rollback: `c21d180a-4467-480a-9fea-7b2e5747bae1`.
  - `GET ig-feed` sin auth → 200, `{"items":[]}`, `cache-control: public,
    max-age=60`. `POST ig-feed-add` / `ig-feed-remove` sin Bearer → 401.
  - `sync-status` y `entity-index` → 200; `admin-check` y `events-get` sin
    Bearer → 401, como antes. Crons `*/15` y `0 6` registrados. Primer poll con
    la versión nueva: 09:00:50 UTC, `ok: true`, modo live.
- **main**: #88 → `a00d291`, #89 → `a1ede5c` (merge commits, sin conflicto).
  Árbol de `a1ede5c` idéntico al de la rama probada.
- **Pages** (verificado por contenido, no por estado): bundle
  `index-CujXQF_g.js` con «Seen on Instagram», «Cierre del vídeo» y «Añadir al
  link in bio», sin la URL del worker de staging. Chrome headless:
  - `/ig` → 308 → `/ig/`, título y canonical prerenderizados, «Nothing here
    yet» con el botón a la tienda, 390 px sin scroll horizontal, 0 errores de
    consola.
  - Portada (18 fichas) y una ficha de producto, 0 errores de consola.
  - `/#admin` llega a la pantalla de login de producción; de ahí no se pasa sin
    secreto.
- Ramas `claude/cierre-reels` y `claude/ig-link-in-bio` no se han borrado: el
  repo no borra ramas al mergear.

## Pendiente a mano

- `./scripts/verify-ig-feed.sh produccion` (add/remove con Bearer).
- Admin de producción: ver «Cierre del vídeo» y «Link in bio»; Añadir/Quitar;
  exportar con Link in bio (añade) y con Seguir (no añade).
- Con el primer disco añadido: `/ig` lo enseña, y poner
  `houseonly.store/ig` en la bio de @onlyhouseonly.
