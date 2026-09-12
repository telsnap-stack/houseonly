# El vigía de tiendas

Cada lunes mira doce tiendas de discos, compara su **interfaz** con la de la
semana pasada y manda por correo lo que cambió, con prompts listos para pegarle
a Claude sobre lo que merezca la pena.

```
node scripts/scout/scout.mjs      # visita y compara → docs/scout/diff-FECHA.json
node scripts/scout/report.mjs     # lo pasa a limpio  → docs/scout/FECHA.md
SCOUT_TO=… SCOUT_BEARER=… node scripts/scout/send.mjs   # lo manda por correo
```

`scripts/scout/scout.mjs --only=hhv` mira una sola tienda y **no** pisa el diff
de la semana.

## Qué mira, y por qué eso

El catálogo cambia cada semana y no dice nada: discos nuevos, precios, stock. Lo
que dice algo es que aparezca un botón, un filtro o un servicio de terceros,
porque eso es una función que alguien ha construido. La huella de cada página
son cuatro cosas:

| | Qué es | Por qué |
|---|---|---|
| `controls` | textos de botones, etiquetas, filtros y selects | el vocabulario de la interfaz |
| `forms` | acción y campos de cada formulario | `/wishlist/add` dice más que cualquier texto, y no depende del idioma |
| `scriptHosts` | dominios de los `<script>` de terceros | **el mejor chivato**: un `klaviyo` es avisos de stock, un `judge.me` son reseñas |
| `signals` | reproductor, pre-order, back-order, reseñas, chat… | presencia, sin depender del marcado |

Un botón de reproducir que pone *"cantiga de longe play"* se recorta a `play`:
si no, la huella se llenaría de nombres de discos y cada semana parecería que
media tienda ha cambiado.

## Las reglas

- **Solo páginas públicas**: portada, un listado y **una** ficha. No se recorre
  el catálogo de nadie.
- Una tienda cada vez, con pausas de 2,5 s. Esto no es un crawler.
- **Se respeta `robots.txt`.**
- Del muro de cookies se pulsa **rechazar**, nunca aceptar. Si la única salida es
  aceptar, se deja puesto y se anota: esa página vale menos esa semana.
- De aquí salen **ideas**. Nunca CSS, imágenes ni textos de otra tienda.

## Lo que no ve, y conviene recordar

- **Checkout, cuenta y correos**: lo más interesante de una tienda casi nunca es
  público. El vigía ve el escaparate.
- **Apps de Shopify**: mucho de lo que aparezca no es código portable, es un
  servicio contratado. `scriptHosts` ayuda a distinguirlo, pero no siempre.
- **Bleep, Boomkat y Juno** devuelven una página vacía al navegador
  automatizado: verificación de bot. Se intentan igual y salen en el informe
  como no accesibles. Si alguna semana cambia, mejor; si no, se quitan.

## Mantenimiento

`scripts/scout/sites.json` es la lista. Cada tienda lleva `home` y `listing`, y
opcionalmente `product` —una ficha fija, que solo se usa si no se encuentra
ninguna en el listado— y `nota`. Si una tienda sale varias semanas seguidas en
**"no se dejaron ver"**, o se arregla su URL ahí o se quita de la lista: un
informe con ruido fijo se deja de leer.

Las huellas viven en `docs/scout/snapshots/` y **se versionan a propósito**: son
la memoria del vigía y el historial de cómo ha ido cambiando cada tienda.
