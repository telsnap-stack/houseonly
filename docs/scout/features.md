# Funciones de House Only (houseonly.store) para el cliente

> Inventario mantenido a mano por Eduardo + Claude. Generado el 2026-10-19 a partir de `src/App.jsx`, el worker y la web en vivo.
> Lo lee el juez del scout (`claude -p`) para decidir si una función vista en un competidor ya la tenemos. Si cambia la tienda, actualizar aquí.
> Formato: `- **nombre** — qué hace. Huella: marcador observable · Fuente: file:line`. Interfaz solo en inglés; precios solo en EUR.

## Catálogo y búsqueda
- **Rejilla de novedades** — catálogo paginado de 24 discos con "Load More"; solo enseña lo comprable (con stock o pre-order vigente). Huella: botón "Load More" · Fuente: src/App.jsx:15038, src/App.jsx:1001
- **Búsqueda de texto** — buscador en la cabecera, del lado del servidor (Shopify search, coincidencia por prefijo y con debounce). Huella: input "Search…" · Fuente: src/App.jsx:14963, src/App.jsx:14834
- **Filtro por género** — desplegable de géneros canónicos (tags `genre:*`) que solo ofrece los géneros con discos en la sección actual. Huella: `<select>` de género · Fuente: src/App.jsx:2825, houseonly-worker/houseonly-worker/src/lib/genres.mjs:42
- **Ordenación** — New Arrivals, precio de menor a mayor y al revés, y "Soonest Release" (solo en Forthcoming). Huella: `<option value="price-asc">` · Fuente: src/App.jsx:2857
- **Sección Drum & Bass** — sección aparte de solo DnB, con un botón en la cabecera. Huella: botón "Drum & Bass" · Fuente: src/App.jsx:14962
- **Sección Forthcoming (pre-orders)** — lista de próximos lanzamientos con vista de lista o rejilla y fecha estimada. Huella: botón "Forthcoming", "Forthcoming · Pre-order Now" · Fuente: src/App.jsx:14961, src/App.jsx:1977
- **Páginas de artista y de sello** — ficha por entidad con sus discos, sets, enlaces y fechas. Huella: rutas `/artist/<slug>/` y `/label/<slug>/` · Fuente: src/App.jsx:14357, src/App.jsx:14756
- **/ig, "Seen on Instagram"** — los discos que han salido en Reels; destino del link in bio, con buscador y los agotados marcados "Sold out". Huella: ruta `/ig/`, `?action=ig-feed` · Fuente: src/App.jsx:14262, houseonly-worker/houseonly-worker/src/index.ts:1457
- **URLs de producto prerenderizadas + SEO** — HTML estático por disco con JSON-LD Product, Open Graph/Twitter, sitemap.xml y robots.txt. Huella: `/products/<handle>/`, `<script type="application/ld+json">`, `/sitemap.xml` · Fuente: scripts/prerender.mjs:245, scripts/prerender.mjs:10
- **Google Shopping** — feed de Merchant Center (RSS `g:`) con todo lo que está en stock, regenerado cada día a las 06:00. Huella: `?action=google-feed` · Fuente: houseonly-worker/houseonly-worker/src/lib/google-feed.ts:1

## Ficha de producto
- **Modal o página de producto** — portada, artista, título, sello y número de catálogo, descripción, tracklist y precio; se puede compartir por URL. Huella: `/products/<handle>/` · Fuente: src/App.jsx:2248
- **Variantes de color** — elegir entre Black y Coloured antes de añadir; desde la tarjeta, el botón "Options" abre la ficha. Huella: botón "Options" · Fuente: src/App.jsx:1857, src/App.jsx:2249
- **Enlaces a artista y sello** — el artista y el sello de la ficha llevan a su página, cada uno con su botón Follow. Huella: `/artist/…`, `/label/…` · Fuente: src/App.jsx:2291, src/App.jsx:14424
- **Fecha estimada del pre-order** — "Expected 4 September 2026" (fecha de calle + 14 días). Si no tiene fecha, se oculta a los 60 días. Huella: texto "Expected …" · Fuente: src/App.jsx:942
- **Estado Sold Out** — los agotados antiguos salen como "Sold Out" sin compra; fuera de /ig y de los enlaces directos no aparecen en la rejilla. Huella: botón deshabilitado "Sold Out" · Fuente: src/App.jsx:1951

## Escucha
- **Reproductor global persistente** — barra fija abajo con prev, play y next, barra de avance, volumen y mute; sigue sonando mientras navegas. Huella: barra inferior, `sessionStorage houseonly_player_state` · Fuente: src/App.jsx:1137, src/App.jsx:1662
- **Cola de reproducción** — "Add to queue" desde la tarjeta y un panel de cola para reordenar o saltar; se mantiene al recargar la página y se pierde al cerrar la pestaña. Huella: botón "Add to queue", QueuePanel · Fuente: src/App.jsx:1785, src/App.jsx:1922
- **Escucha por pista** — en la ficha, cada pista del tracklist se reproduce por separado (snippets mp3). Huella: lista de pistas con play · Fuente: src/App.jsx:2194
- **Preview del pre-order con cuenta** — para escuchar los pre-orders hace falta una cuenta gratuita; el resto del catálogo suena sin cuenta. Huella: modal "Pre-order previews" · Fuente: src/App.jsx:14497, src/App.jsx:15072
- **Sets de artista o sello** — sets embebidos de YouTube (nocookie), SoundCloud y Mixcloud que solo se cargan al pulsar play. Huella: iframes `w.soundcloud.com`, `player-widget.mixcloud.com`, `youtube-nocookie.com` · Fuente: src/App.jsx:13773, src/App.jsx:13787
- Sin teclas multimedia ni lock screen: `navigator.mediaSession` no está implementado (grep: 0).

## Carrito y checkout
- **Carrito lateral** — cajón con líneas, total en € y botón "Checkout via Shopify". Solo vive en memoria: se pierde al recargar. Huella: botón "Cart (n)" · Fuente: src/App.jsx:2431, src/App.jsx:14460
- **Checkout de Shopify** — se abre en una pestaña nueva. Con sesión iniciada, el carrito lleva la identidad del cliente (datos y tarjetas guardadas); si no, va como invitado. Huella: `?action=create-checkout`, `checkoutUrl` de Shopify · Fuente: src/App.jsx:427, houseonly-worker/houseonly-worker/src/index.ts:2740
- **Pre-order pagado** — "+ Pre-order" cobra ahora (con oversell) y envía cuando llega el disco. Huella: botón "+ Pre-order" · Fuente: src/App.jsx:1941
- **Request / backorder (agotado reciente)** — si un disco de este año o del anterior está agotado, el cliente pide copia con email, nombre, dirección y nota. Se crea un draft order sin cobro y se factura cuando se confirma la reposición. Huella: botón "Request", `?action=backorder-request` · Fuente: src/App.jsx:2058, src/App.jsx:887, houseonly-worker/houseonly-worker/src/index.ts:1360
- **Códigos de descuento** — lo tenemos: activos en el checkout de Shopify (DIRECT10 en uso); no hay campo en el carrito propio, el código se mete en el checkout. Verificado en Shopify el 2026-10-19.
- **Tarjeta regalo** — lo tenemos, en curso: producto "House Only Gift Card" (25/50/100 €) creado en borrador; falta publicarlo y enlazarlo en la web.

## Pagos y envío
- **Métodos de pago anunciados** — "CARD · PAYPAL · CRYPTO" bajo el botón del carrito; en el checkout de Shopify, además, Apple Pay, Google Pay y Shop Pay. Huella: texto "CARD · PAYPAL · CRYPTO" · Fuente: src/App.jsx:2472
- **Apple Pay / Google Pay / Shop Pay** — lo tenemos: activos en el checkout de Shopify. Verificado en Shopify el 2026-10-19.
- **Envío mundial desde Madrid con Correos** — con seguimiento y número por email; se prepara en 1–3 días laborables. España desde 7 € (3–7 días), Europa desde 16 €, Norteamérica desde 22 €; el precio va por peso. Huella: `/shipping/` · Fuente: src/policies.mjs:9 (texto de Shopify, `?action=shop-policies`)
- **Aduanas fuera de la UE** — aranceles e impuestos a cargo del comprador al recibir (no hay DDP). Huella: `/shipping/` · Fuente: src/policies.mjs:9
- **Devoluciones** — 14 días si el disco sigue precintado, con el envío de vuelta a cargo del cliente; los dañados o equivocados se reponen o se reembolsan. Huella: `/returns/` · Fuente: src/policies.mjs:10
- **Páginas legales** — Shipping, Returns, Contact, Privacy, Terms y Legal Notice, con el texto que viene de Shopify. Huella: enlaces del pie · Fuente: src/policies.mjs:8, src/App.jsx:13498

## Avisos y cuenta
- **Cuenta de cliente sin contraseña** — login con Shopify New Customer Accounts (OAuth, código por email). Huella: `/auth/login`, `/auth/callback` · Fuente: houseonly-worker/houseonly-worker/src/index.ts:1258
- **Portal /account** — pestañas shelves, artists, labels y orders, más el interruptor de avisos. Huella: ruta `/account/`, `?action=account-home` · Fuente: src/App.jsx:14095, houseonly-worker/houseonly-worker/src/index.ts:2914
- **Historial de pedidos** — pedidos con estado de pago y de envío. Huella: `?action=account-orders` · Fuente: src/App.jsx:2564, houseonly-worker/houseonly-worker/src/index.ts:2488
- **Wishlist** — corazón en tarjeta, ficha y reproductor. Funciona sin cuenta (localStorage) y se sincroniza con la cuenta al iniciar sesión. Permite "add to cart" uno a uno o "add all"; los agotados se quedan en la lista. Huella: botón "Wishlist", `?action=wishlist`, `wishlist-merge` · Fuente: src/App.jsx:2649, src/App.jsx:14623, houseonly-worker/houseonly-worker/src/index.ts:2812
- **"You have it"** — en las estanterías del portal se marcan los discos que el cliente ya compró ("you have 3 of 10"). Huella: badge "You have it" · Fuente: src/App.jsx:13688, src/App.jsx:13940
- **Aviso de vuelta a stock de un disco concreto** — NO existe. Lo más parecido es el Request/backorder (solo agotados recientes) o seguir al artista o al sello.

## Seguimiento (artistas/sellos)
- **Follow de artista o sello** — botón Follow/Following en la ficha de producto, en la de entidad, en las sugerencias y en el portal; si se pulsa sin sesión, se aplica al volver del login. Huella: botón "Follow", `?action=follows` · Fuente: src/App.jsx:13651, houseonly-worker/houseonly-worker/src/index.ts:2872
- **Estanterías de seguidos** — feed con los discos de los últimos 90 días de cada artista o sello seguido. Huella: `?action=feed` · Fuente: src/App.jsx:13930, docs/entities.md:587
- **Sugerencias para seguir** — salen de la wishlist, cada una con la portada del disco que la justifica. Huella: "Your shelves are empty" · Fuente: src/App.jsx:13956
- **Avisos de novedades por email** — un digest diario (06:00 UTC, Resend) con los lanzamientos nuevos y los pre-orders de lo que sigues, con baja en un clic. Se pregunta una vez, en el primer follow, y vuelve a ofrecerse pasado un mes. En `live` desde el 2026-09-11. Huella: modal de avisos, `?action=follow-alerts`, `follow-alerts-unsubscribe` · Fuente: src/App.jsx:14022, houseonly-worker/houseonly-worker/src/lib/alerts.ts:460
- **Fechas de concierto** — lista propia de "Tour dates" en la ficha de la entidad (datos de Bandsintown cargados a mano, sin widget). Huella: bloque "Tour dates", `?action=events-get` · Fuente: src/App.jsx:13902, houseonly-worker/houseonly-worker/src/lib/events.ts:1
- **Enlaces externos de la entidad** — perfiles revisados a mano de YouTube, SoundCloud, Mixcloud, NTS, RA y Songkick. Huella: `?action=external-get`, iconos ▶ ~ ◴ ◉ ◆ ◇ · Fuente: src/App.jsx:13785, houseonly-worker/houseonly-worker/src/lib/external.ts:1

## Contenido editorial
- **Descripciones propias por disco** — texto con el mismo formato en todo el catálogo, generado por los importers (las notas del distribuidor se filtran por calidad). Huella: descripción en la ficha · Fuente: src/App.jsx:2897
- **Sets destacados** — sets escogidos por la tienda en las fichas de artista y de sello. Huella: bloque "Listen", `?action=sets-list` · Fuente: houseonly-worker/houseonly-worker/src/lib/sets.ts:1, houseonly-worker/houseonly-worker/src/index.ts:1487
- No hay blog, charts o staff picks como sección, ni reseñas escritas aparte de la descripción (grep: sin rutas de ese tipo).

## Newsletter
- **Alta en la newsletter con doble opt-in** — formulario en el pie, tarjeta a mitad de la rejilla y landing /join; el email de confirmación sale de Resend. Huella: `?action=newsletter-subscribe`, `newsletter-confirm`, ruta `/join/` · Fuente: src/App.jsx:1456, src/App.jsx:1632, houseonly-worker/houseonly-worker/src/index.ts:2548
- **Envíos (broadcasts)** — los monta el admin y salen por Resend Broadcasts; Mailchimp solo aparece como origen de datos de proveedores. Huella: — · Fuente: src/App.jsx:8900

## Integraciones/terceros
- **Shopify** — Storefront API para el catálogo y el carrito, checkout alojado en Shopify, Customer Accounts. Huella: `*.myshopify.com` / checkout de Shopify · Fuente: src/App.jsx:427
- **Contacto** — info@houseonly.store, Instagram @onlyhouseonly y la tienda de Discogs (houseonly). Huella: `/contact/` · Fuente: src/policies.mjs:21
- **Scripts de terceros en la portada** — solo Google Fonts (Inter). No hay analytics, píxeles, chat ni banner de cookies. Huella: `fonts.googleapis.com` · Fuente: index.html:15 (comprobado con curl de houseonly.store el 2026-10-19)

## No tenemos (verificado por grep en src/App.jsx e index.html)
- Reseñas o valoraciones de clientes (Trustpilot, Judge.me, estrellas): 0 coincidencias.
- Pago aplazado (Klarna, Afterpay, Scalapay): 0 en el código; el checkout de Shopify, sin verificar.
- Chat en vivo o widget de soporte (Intercom, Crisp, Tawk, Zendesk): 0.
- Aviso "notify me when back in stock" de un producto: no existe (ver Request/backorder y Follow).
- Selector de idioma o moneda: solo inglés y EUR (`hreflang`, `i18n`, `currency switcher`: 0).
- "Recently viewed" y "related products" en la ficha: 0.
- Botones de compartir en redes / `navigator.share`: 0.
- Gift wrap, programa de fidelidad o puntos, suscripción o club de discos: 0.
- Segunda mano con grading (Media/Sleeve Condition): no hay en la tienda (solo en Discogs).
- Recogida en tienda (click & collect): no aparece en las políticas ni en el código.
- Carrito persistente entre recargas: no (el carrito no se guarda en storage).
- Nota de pedido en el carrito: no lo tenemos, baja prioridad.

## Descartar siempre (decidido por Eduardo)
- País de envío / calculadora de envío en el carrito: el checkout de Shopify ya lo exige.
- Analytics o píxeles de marketing (GA, Meta Pixel): 0 en el código y en el HTML en vivo.
