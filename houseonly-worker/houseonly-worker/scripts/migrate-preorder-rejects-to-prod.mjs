#!/usr/bin/env node
/**
 * Lleva a prod los rechazos del tab Pre-order que se hicieron desde el admin de
 * staging (2026-11-02: los 401 del 20-10 y los 2 de la bandeja vivian solo en
 * el SYNC_STATE de staging; el de prod no tenia ninguno).
 *
 * Copia cada preorder:rejected:<CATNO> TAL CUAL, con su fecha original, para
 * que los temporales sigan caducando a los 90 dias del dia en que se
 * rechazaron. Nunca sobrescribe una clave que ya exista en prod. No toca los
 * elegidos de la bandeja (listen:rel:*): se vuelven a elegir en prod.
 *
 * Usa wrangler (la sesion de `wrangler login`), sin secretos propios.
 *
 * Uso (desde houseonly-worker/houseonly-worker):
 *   node scripts/migrate-preorder-rejects-to-prod.mjs            # DRY RUN: recuento y fichero, no escribe
 *   node scripts/migrate-preorder-rejects-to-prod.mjs --write    # escribe en prod lo que el dry run listo
 *
 * El dry run deja el lote en scripts/out/preorder-rejects-to-prod.json; --write
 * vuelve a leer prod justo antes de escribir y quita lo que ya exista.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STAGING = '5069be832df64efdb5e3d1a49f85b0ea';   // SYNC_STATE staging (wrangler.jsonc env.staging)
const PROD = '5c5c0ee16cc34f68bd2109b01894f09d';      // SYNC_STATE prod
const PREFIX = 'preorder:rejected:';
const WRITE = process.argv.includes('--write');
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out', 'preorder-rejects-to-prod.json');

// IPv6 roto en esta red hace fallar a wrangler con "fetch failed".
const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --dns-result-order=ipv4first --no-network-family-autoselection`.trim() };
const wrangler = (...args) => execFileSync('npx', ['wrangler', ...args], { env, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });

function listar(ns) {
  const out = wrangler('kv', 'key', 'list', '--remote', '--namespace-id', ns, '--prefix', PREFIX);
  return JSON.parse(out.slice(out.indexOf('[')));
}
const valor = (ns, key) => wrangler('kv', 'key', 'get', '--remote', '--namespace-id', ns, key);

const staging = listar(STAGING);
const enProd = new Set(listar(PROD).map(k => k.name));

const lote = [];
const yaEnProd = [];
const raros = [];
for (const k of staging) {
  if (enProd.has(k.name)) { yaEnProd.push(k.name); continue; }
  // El endpoint guarda el mismo objeto como valor y como metadata; sin
  // metadata (escrita a mano) se lee el valor.
  let rec = k.metadata;
  if (!rec) { try { rec = JSON.parse(valor(STAGING, k.name)); } catch { raros.push(k.name); continue; } }
  if (!rec?.catno || !['temporal', 'definitivo'].includes(rec.tipo) || !Number.isFinite(Date.parse(rec.fecha))) { raros.push(k.name); continue; }
  lote.push({ key: k.name, value: JSON.stringify(rec), metadata: rec });
}

const cuenta = {};
for (const { metadata: r } of lote) {
  const c = `${r.fecha.slice(0, 10)} ${r.tipo}`;
  cuenta[c] = (cuenta[c] || 0) + 1;
}
console.log(`staging: ${staging.length} rechazos · prod: ${enProd.size} rechazos`);
console.log(`a copiar: ${lote.length}`);
for (const c of Object.keys(cuenta).sort()) console.log(`  ${c}: ${cuenta[c]}`);
console.log(`ya en prod (no se tocan): ${yaEnProd.length}${yaEnProd.length ? ' — ' + yaEnProd.join(', ') : ''}`);
if (raros.length) console.log(`sin registro valido (no se copian): ${raros.length} — ${raros.join(', ')}`);
const hoy = lote.filter(x => x.metadata.fecha.startsWith('2026-11-02')).map(x => `${x.metadata.catno} (${x.metadata.tipo})`);
if (hoy.length) console.log(`de hoy: ${hoy.join(', ')}`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(lote, null, 1));
console.log(`lote: ${OUT}`);

if (!WRITE) {
  console.log('\nDRY RUN: no se ha escrito nada en prod. Para escribir: --write');
  process.exit(0);
}

// Justo antes de escribir: lo que haya aparecido en prod entretanto, fuera.
const ahora = new Set(listar(PROD).map(k => k.name));
const final = lote.filter(x => !ahora.has(x.key));
if (final.length !== lote.length) console.log(`aparecieron en prod mientras tanto, se quitan: ${lote.length - final.length}`);
writeFileSync(OUT, JSON.stringify(final, null, 1));
for (let i = 0; i < final.length; i += 5000) {
  const trozo = OUT.replace(/\.json$/, `.part${i / 5000}.json`);
  writeFileSync(trozo, JSON.stringify(final.slice(i, i + 5000)));
  console.log(wrangler('kv', 'bulk', 'put', trozo, '--remote', '--namespace-id', PROD).trim().split('\n').pop());
}
const despues = listar(PROD).length;
console.log(`escritos ${final.length}; prod tiene ahora ${despues} rechazos`);
