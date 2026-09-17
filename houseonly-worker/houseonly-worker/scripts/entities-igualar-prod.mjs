#!/usr/bin/env node
/**
 * entities-igualar-prod.mjs — lleva a produccion lo que se quedo en el KV de
 * entidades de staging.
 *
 * Por que hace falta: hasta el 2026-09-17 los importers resolvian artistas y
 * sellos contra el worker del entorno desde el que se abria el admin. Como los
 * CSV se generan casi siempre desde staging pero se suben a la UNICA tienda de
 * Shopify que hay, todo lo que se aprobo o se encolo en esos importers vive en
 * el KV de staging y produccion no lo ha visto nunca:
 *
 *   - entidades aprobadas alli  → en la tienda el artista sale sin enlace y sin
 *     boton de Follow, y ademas el metafield del producto apunta a un slug que
 *     en produccion no existe.
 *   - filas de la cola de revision → nadie las ve, porque la pestaña Entities
 *     de produccion lee otra cola.
 *
 * El arreglo de raiz esta en src/App.jsx (ENTITIES_WORKER_URL: la capa de
 * entidades es SIEMPRE la de produccion). Este script limpia lo ya ocurrido.
 *
 * Que hace y que no:
 *   - Copia SOLO las claves que faltan en produccion. Nunca pisa un valor que
 *     ya este ahi: si las dos colas tocaron el mismo nombre, manda produccion.
 *   - Solo cuatro prefijos: entity:, alias:, review:artist:, review:label:.
 *     Ni ignore:, ni children:, ni el indice cacheado.
 *   - No borra nada en ninguno de los dos lados.
 *
 * Uso:
 *   node entities-igualar-prod.mjs            # dry-run: dice que copiaria
 *   node entities-igualar-prod.mjs --apply    # copia
 *
 * Necesita `wrangler` con la cuenta de HOUSE ONLY (la misma que despliega).
 */

import { execFileSync } from 'node:child_process';

const STAGING = 'bf137c15dc6d4c4f8f21a9987108f2f2';
const PROD    = 'e1148360f4af4c72ad608e60c03e9813';
const PREFIJOS = ['entity:', 'alias:', 'review:artist:', 'review:label:'];
const APPLY = process.argv.includes('--apply');

const wrangler = (args) => execFileSync('npx', ['wrangler', ...args], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
});

const listar = (ns, prefijo) =>
  JSON.parse(wrangler(['kv', 'key', 'list', `--namespace-id=${ns}`, '--remote', '--prefix', prefijo]))
    .map(x => x.name);

const leer = (ns, clave) =>
  wrangler(['kv', 'key', 'get', `--namespace-id=${ns}`, '--remote', clave]);

const escribir = (ns, clave, valor) =>
  wrangler(['kv', 'key', 'put', `--namespace-id=${ns}`, '--remote', clave, valor]);

let total = 0;
for (const prefijo of PREFIJOS) {
  const enStaging = listar(STAGING, prefijo);
  const enProd = new Set(listar(PROD, prefijo));
  const faltan = enStaging.filter(k => !enProd.has(k));
  console.log(`\n${prefijo}  staging ${enStaging.length} · produccion ${enProd.size} · faltan ${faltan.length}`);
  for (const clave of faltan) {
    const valor = leer(STAGING, clave);
    const resumen = valor.length > 90 ? `${valor.slice(0, 90)}…` : valor;
    console.log(`  ${APPLY ? 'copio ' : 'copiaria'} ${clave}  ${resumen}`);
    if (APPLY) escribir(PROD, clave, valor);
    total++;
  }
}
console.log(`\n${APPLY ? 'copiadas' : 'se copiarian'} ${total} claves.`);
if (!APPLY) console.log('Nada escrito. Repite con --apply.');
else console.log('El indice cacheado (entityindex:v1) caduca solo; la tienda tarda hasta un minuto en verlo.');
