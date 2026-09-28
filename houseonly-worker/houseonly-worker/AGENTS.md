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

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`
