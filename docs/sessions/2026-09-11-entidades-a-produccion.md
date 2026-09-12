# 2026-09-11 — La capa de entidades a producción, y los avisos en marcha

Los 65 commits que `staging` llevaba acumulados desde el 25 de agosto —artistas
y sellos canónicos, el portal del cliente, las fichas públicas y los avisos de
novedades— salieron a producción en una secuencia de ocho pasos con parada entre
cada uno. El diseño vive en `docs/entities.md`; aquí queda lo que pasó al
ejecutarlo y lo que se aprendió por el camino.

## Estado al cerrar

Todo en producción y funcionando.

- **1480 entidades** copiadas a la KV de prod (4269 claves `entity:`/`alias:`/
  `ignore:`/`children:`), cola de revisión a **cero**.
- **2391 metafields** `houseonly.artist_slugs` / `label_slugs` en los 1276
  productos activos.
- **1475 fichas de entidad** prerenderizadas, 1441 en el sitemap: las que tienen
  menos de tres discos activos llevan `noindex,follow` y quedan fuera.
- **Portal del cliente** en `/account`, fichas en `/artist/{slug}` y
  `/label/{slug}`, Follow desde la ficha de producto.
- **Avisos de novedades en `live`** desde hoy: cron diario a las 06:00 UTC, y
  solo manda si hay algo nuevo.

Worker de prod `e01733ed`; `main` y `staging` idénticos; Pages sirviendo
`aa995fd`.

## La promoción, paso a paso

| Paso | Qué | Cómo se verificó |
|---|---|---|
| 0 | Fotografía previa | Version ID de prod anotado como vuelta atrás |
| 1 | `noindex` en fichas flacas, fuera `ENTITIES_WORKER_URL` | El bundle del preview apuntando al worker de staging |
| 2 | Worker a prod | Diff de configuración efectiva: solo el binding `ENTITIES` y el cron de alertas |
| 3 | Copia de las 4269 claves | Conteo por prefijo en destino y 10 claves comparadas byte a byte |
| 4 | Barrido y cola | Cola a 0 en artistas y sellos |
| 5 | `main` ← `staging` | En un checkout limpio: build, prerender, 1475/1441, bundle con la URL de prod y ninguna de staging |
| 6 | Build de Pages | Home, ficha, `/artist/omar-s/` con su canonical, una ficha flaca con `noindex`, `/account` sin sesión |
| 7 | Cuenta real | De Eduardo |

Nada se desvió del plan. Lo que costó trabajo fue todo lo demás.

## Los fallos del día, y dónde estaba de verdad la causa

### Las cachés que verificar dejó sembradas

Comprobar los endpoints en el paso 2 —con la KV de prod todavía vacía— creó
`entityindex:v1` con `items: []` y un `feedindex:v2` construido sobre la nada.
Ambos tienen TTL de diez minutos, pero el prerender del paso 6 lee el índice de
entidades: de no haberlas borrado en el paso 3, el build habría generado **cero
fichas de entidad** sin fallar ni una sola vez.

Verificar escribe. Un endpoint que cachea no es de solo lectura.

### `--env production` habría creado un worker nuevo

El repo no tiene `env.production`: producción es la configuración de arriba y
staging es el único entorno con nombre. `wrangler deploy --env production` no
habría fallado — habría **creado** `houseonly-worker-production`, vacío, con
otro dominio, mientras el de verdad seguía intacto y sin actualizar. El deploy
correcto es `--env=""`.

### El correo repetía discos, y el asunto contaba de más

El primer envío de prueba con datos reales sacó *Boots On The Ground* bajo
Massive Attack y otra vez bajo Play It Again Sam, y los dos de Koze bajo DJ Koze
y bajo Pampa: agrupar por entidad sin más duplica todo lo que traen dos follows,
y el asunto prometía ocho discos donde había cinco.

Regla nueva: **un disco, un sitio**. Se lo queda el artista seguido —que es a
quien se sigue de verdad—, el sello recoge lo que no trae artista detrás, y una
línea *"also from X"* nombra al resto. El total del asunto cuenta discos, no
apariciones.

### 0 digests: no era el código, era el consentimiento

Tras desplegar la deduplicación, el reenvío en prod devolvió `digests: 0` con
cualquier ventana. Reproduje el caso en local con los datos reales de prod y
salía bien, así que el fallo no estaba donde miraba.

Estaba en el registro del cliente: `emailAlerts` había pasado a `false` a las
16:09, y mi primer envío —a las 16:14— había salido igual porque **la KV es
consistente a los ~60 s** y el worker leyó todavía un `true` cacheado. El job
diario puede actuar sobre un consentimiento de hasta un minuto de antigüedad;
para una tanda diaria es asumible, pero conviene saberlo.

La lección de método: cuando el código nuevo parece culpable, reproducirlo con
los datos reales antes de tocarlo. Si pasa, el fallo está en los datos.

### Un hook detrás de un `return` temprano

Al añadir la vista de renombrado puse el `useEffect` que carga las entidades
después del gate del secreto del panel. React habría contado un hook de más al
autenticarse y se habría caído la pestaña entera. Lo cacé leyendo el diff antes
de desplegar, no probándolo.

### Aliases colgando de mi propia cirugía manual

Dos aliases (`norma jean bell` y uno de `C.A.R.`) seguían apuntando a slugs
borrados a mano en una corrección anterior. Auditados los 2769: exactamente
esos dos, ambos míos. Reparados, y `lookupPublic` endurecido para probar exacto
y luego normalizado hasta dar con una entidad viva.

### Seguir a alguien borraba la preferencia de avisos

`saveFollows` reescribía el registro entero, así que cada follow nuevo se
llevaba por delante `emailAlerts`, `email` y `alertToken`. Arreglado con una
escritura que conserva lo anterior, y dos tests que lo fijan.

## Lo que se añadió después de la promoción

- **Deduplicación de los avisos** (#26) — arriba.
- **Renombrar el display desde el admin** (#27). El display sale del catálogo o
  de un Title Case automático, y el automático se equivoca con los acrónimos:
  `Dj Koze` por `DJ Koze`. Hasta ahora eso se arreglaba editando KV a mano.
  `entity-edit-display` cambia el nombre y **nunca el slug** —es la dirección de
  la ficha y de él cuelgan los metafields y las claves de `fanout:`—, deja el
  nombre viejo como alias y no roba un alias que ya apunte a otra entidad. En la
  pestaña Entities, una vista con las entidades aprobadas y un Rename por fila.
  Ojo: el display vive en KV y las fichas se generan en el build, así que un
  renombrado **no se ve en el HTML estático hasta el siguiente build de Pages**.
- **Recordatorio de avisos al seguir a alguien** (#28). Se preguntaba una sola
  vez en la vida; quien dijo "not now" en su primer follow y hoy sigue a ocho
  artistas no volvía a ver nada. Ahora lo decide el servidor: encendidos, nunca;
  apagados, al seguir a alguien y como mucho una vez cada 30 días. Cerrarlo sin
  contestar aparta el recordatorio sin tocar la preferencia.
- **Avisos en `live`**. Un solo destinatario real hoy.

## Deuda y pendientes

- **La baja necesita una pantalla de confirmación**. `follow-alerts-unsubscribe`
  da de baja en el **GET**, y los escáneres de correo corporativo prefetchean
  los enlaces: pueden dar de baja a quien no tocó nada. Escrito en
  `docs/entities.md` como v2.
- **7 colisiones de slug** de producto: 1269 directorios para 1276 productos.
- **`REVIEW_WORKER_URL`** sigue apuntando a prod a pelo (cola de Discogs).
- El filtro de metafields del Admin de Shopify casa el **valor entero**, así que
  153 productos multi-artista no se encuentran buscando un solo slug. El feed no
  se ve afectado porque parsea los valores él mismo.
- "Ya lo tienes" cuenta también pedidos cancelados o reembolsados, y solo mira
  los **50 últimos** pedidos.
- Los secretos pegados en el chat durante la sesión conviene rotarlos.
