// Credenciales de los scripts de operacion desde .dev.vars (el archivo de
// secretos locales de wrangler, en houseonly-worker/houseonly-worker/, fuera de
// git por .gitignore).
//
// Se importa el PRIMERO en cada script (`import './lib/dev-vars.mjs';`): los
// import se evaluan antes que el cuerpo del modulo, asi que cuando el script lee
// process.env ya estan cargadas.
//
// Solo carga estas claves, nada mas del archivo. Una variable de entorno ya
// definida (no vacia) MANDA sobre .dev.vars: `BS=… node script.mjs` sigue
// funcionando igual. Nunca imprime valores.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLAVES = ['SHOPIFY_ADMIN_CLIENT_ID', 'SHOPIFY_ADMIN_CLIENT_SECRET', 'DISCOGS_TOKEN'];
export const DEV_VARS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.dev.vars');

/** KEY=VALUE por linea (sintaxis dotenv): comentarios #, `export`, comillas. */
export function parseDevVars(texto) {
  const out = {};
  for (const linea of String(texto || '').split(/\r?\n/)) {
    const m = linea.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^"(.*)"$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    else if (/^'(.*)'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

/** Carga las CLAVES que falten en process.env. Devuelve de donde salio cada una. */
export function cargarDevVars(path = DEV_VARS_PATH, claves = CLAVES) {
  const origen = {};
  const archivo = existsSync(path) ? parseDevVars(readFileSync(path, 'utf8')) : {};
  for (const k of claves) {
    if (process.env[k]) origen[k] = 'entorno';
    else if (archivo[k]) { process.env[k] = archivo[k]; origen[k] = '.dev.vars'; }
    else origen[k] = null;
  }
  return origen;
}

/** Nombres (nunca valores) de las claves pedidas que siguen sin valor. */
export function faltan(...claves) {
  return claves.filter((k) => !process.env[k]);
}

export const ORIGEN = cargarDevVars();
