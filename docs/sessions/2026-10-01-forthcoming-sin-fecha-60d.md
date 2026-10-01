# 2026-09-30/10-01 — Forthcoming sin fecha caduca a los 60 días

Todo lo de abajo está en producción: main = staging = `68f556c`. Solo frontend
(`src/App.jsx`); worker y wrangler sin tocar.

## Regla

Solo aplica a pre-orders con `stock === 0`. Con stock queda fuera de alcance:
el disco gradúa a la rejilla por el flujo de llegada, como siempre.

- **Con `release:`** → sin cambios (`pre` / `released` +30 d / `expired`).
- **Sin `release:` o con fecha ilegible** → `pre` (CTA Pre-order) hasta el día
  **+60** desde `createdAt`; el **+61** pasa a `expired` y sale de la rejilla y
  del buscador, igual que los que vencen con fecha. Producto intacto en Shopify.
- `createdAt` ausente o ilegible → sigue visible. Nunca se oculta por datos
  malos.

Comparación por día de calendario (mediodía local), como el resto de
`forthcomingPhase()`.

## Cambios

- `createdAt` añadido a las tres consultas Storefront que pasan por
  `parseProduct` (rejilla, buscador, producto por handle) y expuesto en el
  registro. Verificado que el campo existe en la versión que usa la app
  (`2024-01`) y en `2026-04`.
- `FORTHCOMING_UNDATED_DAYS = 60` y la rama sin fecha dentro de
  `forthcomingPhase()`. `esVisibleEnTienda()` y `esPeticionDeForthcoming()` no
  cambian: heredan la fase.
- Bordes probados contra el código real: alta de hoy, +59, +60 y +60 dado de
  alta a las 23:59 → visibles; +61 y +61 dado de alta a las 00:01 → ocultos;
  `createdAt` vacío o basura → visible.
- Lint: 95 problemas antes y después (ninguno nuevo). Build OK.

## Dry-run antes del push (catálogo vivo, 01-10)

120 productos con `forthcoming`. Sin fecha válida: 74, de los cuales 2 tienen
stock (fuera de alcance) → **72** afectados por la regla.

Al desplegar solo cae uno: **RS-07 · Rhythm & Sound — Aground · 138 días**.

Los 71 restantes por antigüedad: 37 d (20), 35–36 d (9), 14 d (32), 1 d (10).

## Despliegue y verificación

- Staging: push de `68f556c`, bundle `index-BIzno08P.js`. "Aground" sin
  resultados en Forthcoming de staging, sí en producción vieja; "Building
  Bridges" (Move D, sin fecha, 37 d) visible.
- Producción: `git log main..staging` = solo `68f556c`; merge fast-forward.
  Bundle `index-BKUMt58X.js` en houseonly.store. Mismas comprobaciones OK.
  Rejilla y buscador sin REQUEST ni Sold Out.
- Visibles fuera de Forthcoming (catálogo vivo): 805 house + 244 D&B con stock
  = **1049**.

## Pendiente

- **25-10-2026**: el lote de 20 sin fecha dado de alta el 25-08 desaparece de
  Forthcoming de golpe. Si alguno debe seguir, ponerle `release:` o stock antes.
- Un enlace directo a `/products/<slug>/` sigue abriendo un pre-order caducado
  (con o sin fecha). Comportamiento previo, no se ha cambiado; si "oculto en
  todas partes" debe incluir el enlace directo, es un cambio aparte.
