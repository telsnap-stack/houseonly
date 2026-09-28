# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npm run deploy` | Deploy to production (**con frenos**, ver abajo) |
| `npm run deploy:staging` | Deploy to staging (**con frenos**) |
| `npx wrangler types` | Generate TypeScript types |

## Desplegar: usar SIEMPRE `npm run deploy`

`npx wrangler deploy` a pelo **no**. Sube lo que haya en disco y no sabe nada de
git: no mira si la rama esta al dia, ni si el codigo que sube borra rutas que
hoy estan vivas en produccion.

El 2026-09-28 se desplego a produccion desde `claude/genero-garage`, 43 commits
por detras de main. El worker subido no tenia `external.ts`, `sets.ts`,
`events.ts`, `mixcloud.ts` ni `sync-alerts.ts`: **19 rutas desaparecieron de
produccion** hasta que se revirtio con `wrangler rollback`.

`scripts/deploy.sh` aborta antes de subir nada si:

1. **La rama no contiene `origin/main`** (`git merge-base --is-ancestor`). Es el
   freno que habria evitado lo del 28-09.
2. **El despliegue borraria alguna ruta que main si tiene.** Compara los
   `action === '...'` del `index.ts` en disco contra los de main.
3. **Borra mas de 300 lineas de `src/`** respecto a main — sintoma de baseline
   vieja.
4. **Hay cambios sin commitear en `src/`**, porque wrangler sube el disco y se
   desplegaria algo que no esta en ningun commit.

Escotilla de emergencia, a sabiendas: `DEPLOY_SIN_FRENOS=1 npm run deploy`.

### Si hay que revertir

`npx wrangler deployments list` (o `--env staging`) y
`npx wrangler rollback <version-id>`. El rollback NO revierte KV, R2 ni D1.

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Pages: "Active" no significa que ya sirva el bundle nuevo

El frontend se construye en Cloudflare Pages desde `main` y `staging`, y el
build corre `vite build` **y `scripts/prerender.mjs`**, que escribe ~1.400
paginas de producto y ~1.500 de entidad. Eso tarda, y mientras tanto:

- `wrangler pages deployment list` ya muestra el deployment con el commit nuevo,
- el alias (`staging.houseonly.pages.dev`) **sigue sirviendo el build anterior**.

El 2026-09-28 eso casi se reporta como desplegado: el estado decia "Active" y el
bundle servido era el de antes, sin los cambios.

Verificar por CONTENIDO, nunca por estado:

```bash
U=https://staging.houseonly.pages.dev
JS=$(curl -s "$U/?cb=$RANDOM" | grep -o '/assets/[^"]*\.js' | head -1)
curl -s "$U$JS" | grep -c "una-cadena-de-tu-cambio"
```

Y que sea una cadena que sobreviva a la minificacion: un rotulo de la interfaz o
el nombre de una accion (`mt-enrich`), **no** el nombre de una variable, que se
renombra. Tampoco sirve comparar el hash del fichero con el de tu build local:
el hash depende del entorno de build y no coincide aunque el contenido sea
equivalente.

## Secretos: no se pegan en chats de agentes

`BOOTSTRAP_AUTH_SECRET` y compania protegen endpoints que escriben en R2 y en
Shopify. No se pegan en la conversacion con un agente, ni como variable, ni
"solo para esta prueba": lo que entra en un chat queda en su transcripcion.

Para verificar un despliegue esta `scripts/verify-deploy.sh`, que pide el Bearer
por teclado sin eco — no queda ni en el historial del shell.

Si aun asi un secreto aparece en la conversacion, el agente debe:

1. **Señalarlo** en cuanto lo vea, sin dar por hecho que da igual.
2. **No reutilizarlo** sin que la persona lo autorice explicitamente.
3. **Proponer rotarlo**: `npx wrangler secret put BOOTSTRAP_AUTH_SECRET` (o con
   `--env staging`), y recordar que el valor nuevo hay que meterlo tambien en la
   pestaña Entities del admin, que es de donde el frontend saca el Bearer.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`
