#!/usr/bin/env node
/**
 * entities-copiar-a-staging.mjs — lleva a staging lo que se decidio en prod.
 *
 * Desde el cutover del 2026-09-11 la fuente de verdad de las entidades es
 * PRODUCCION: la cola se despacha alli y alli viven los enlaces aprobados. Pero
 * el preview de Pages habla con el worker de STAGING, asi que una ficha en el
 * preview sale sin bloque Listen aunque en prod este todo. Esto arregla eso, y
 * solo eso.
 *
 * Copia, siempre en el sentido prod → staging:
 *   external:{slug}   enlaces aprobados (y descartados)
 *   sets:{slug}       sets destacados, en su orden
 *   mixstat:{slug}    la foto de Mixcloud que refresca el cron
 *
 * NO copia —y no es olvido—:
 *   follow:, fanout:, alerttoken:, alertsent:   clientes de verdad
 *   feedindex:, entityindex:, meta:             caches, se reconstruyen solas
 *   extreview:, setreview:                      colas de trabajo, son de prod
 *
 * Uso:
 *   node entities-copiar-a-staging.mjs           # dry-run: dice que copiaria
 *   node entities-copiar-a-staging.mjs --send
 *   node entities-copiar-a-staging.mjs --send --limpiar-indice   # ademas, tira
 *                                                 entityindex: de staging para
 *                                                 que se reconstruya
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NS_PROD = 'e1148360f4af4c72ad608e60c03e9813';
const NS_STG = 'bf137c15dc6d4c4f8f21a9987108f2f2';
const PREFIJOS = ['external:', 'sets:', 'mixstat:'];
const LOTE = 100;

const args = new Set(process.argv.slice(2));
const SEND = args.has('--send');
const LIMPIAR = args.has('--limpiar-indice');
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(join(tmpdir(), 'ho-copy-'));

function wrangler(argv) {
  return execFileSync('npx', ['wrangler', ...argv], {
    cwd: WORKER_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024,
  });
}

/** wrangler intercala avisos: se recorta al JSON, que es lo que interesa. */
function recorta(salida, abre, cierra) {
  const i = salida.indexOf(abre), j = salida.lastIndexOf(cierra);
  if (i < 0 || j < 0) throw new Error(`salida inesperada de wrangler: ${salida.slice(0, 200)}`);
  return JSON.parse(salida.slice(i, j + 1));
}

const listar = (ns, prefijo) =>
  recorta(wrangler(['kv', 'key', 'list', `--namespace-id=${ns}`, '--remote', `--prefix=${prefijo}`]), '[', ']')
    .map(k => k.name);

function leer(ns, claves) {
  const out = {};
  for (let i = 0; i < claves.length; i += LOTE) {
    const f = join(TMP, `get-${i}.json`);
    writeFileSync(f, JSON.stringify(claves.slice(i, i + LOTE)));
    Object.assign(out, recorta(wrangler(['kv', 'bulk', 'get', f, `--namespace-id=${ns}`, '--remote']), '{', '}'));
  }
  return out;
}

function escribir(ns, pares) {
  for (let i = 0; i < pares.length; i += LOTE) {
    const f = join(TMP, `put-${i}.json`);
    writeFileSync(f, JSON.stringify(pares.slice(i, i + LOTE)));
    wrangler(['kv', 'bulk', 'put', f, `--namespace-id=${ns}`, '--remote']);
    process.stdout.write(`\r  escritas ${Math.min(i + LOTE, pares.length)}/${pares.length}…`);
  }
  if (pares.length) process.stdout.write('\n');
}

console.log(`\n▶ copiar prod → staging · ${SEND ? 'ESCRIBE' : 'dry-run'}\n`);

const pares = [];
for (const prefijo of PREFIJOS) {
  const claves = listar(NS_PROD, prefijo);
  const enStaging = listar(NS_STG, prefijo).length;
  console.log(`  ${prefijo.padEnd(12)} prod ${String(claves.length).padStart(4)} · staging ${enStaging}`);
  if (!claves.length) continue;
  const valores = leer(NS_PROD, claves);
  for (const [key, value] of Object.entries(valores)) pares.push({ key, value });
}

console.log(`\n  total a copiar: ${pares.length} claves`);
if (!SEND) {
  console.log('\n  dry-run: no se ha escrito nada. --send para hacerlo.\n');
  process.exit(0);
}

escribir(NS_STG, pares);

if (LIMPIAR) {
  // El indice de entidades de staging es una cache con su propia fecha; se
  // borra para que el worker lo reconstruya con lo recien copiado.
  const f = join(TMP, 'del.json');
  writeFileSync(f, JSON.stringify(['entityindex:v1', 'feedindex:v2', 'meta:mixcloud_index']));
  try { wrangler(['kv', 'bulk', 'delete', f, `--namespace-id=${NS_STG}`, '--remote', '--force']); } catch { /* si no existian, mejor */ }
  console.log('  caches de staging borradas: entityindex, feedindex, meta:mixcloud_index');
}

const comprobar = PREFIJOS.map(p => `${p}${listar(NS_STG, p).length}`).join(' · ');
console.log(`\n  staging ahora: ${comprobar}\n`);
