#!/usr/bin/env node
/**
 * forthcoming-prosa-de-correo.mjs — pone la prosa del correo de anuncio como
 * descripcion de los discos que se subieron sin ninguna.
 *
 * Por que hacia falta: hasta septiembre de 2026 el importer de Pre-order sacaba
 * la prosa del correo (`_desc`) y la tiraba al guardar el manifest. Los discos
 * entraban con la descripcion generada —titulo, tracklist y coletilla—, que es
 * justo lo que el limpiador de lectura quita, asi que en la tienda se quedaban
 * con la ficha vacia. Medido el 2026-09-17: 71 productos con tag `forthcoming`
 * sin una linea de texto.
 *
 * El arreglo hacia adelante ya esta en src/App.jsx. Esto es lo de atras.
 *
 * Que hace:
 *   1. Lee un JSON `[{ sku, texto }]` con la ventana de texto del correo.
 *   2. La pasa por `prosaDeCorreo()`: fuera la cabecera del mensaje reenviado
 *      —con las direcciones—, el saludo, el anuncio del distribuidor y el
 *      tracklist. Lo que no deja prosa de verdad se descarta aqui.
 *   3. Comprueba contra Shopify que ese producto NO tiene ya descripcion. Si la
 *      tiene, lo salta: alguien la escribio y no se pisa.
 *   4. Escribe `prosa + lo que hubiera en el cuerpo sin los bloques generados`.
 *      El `<script id="tracks">` del reproductor se conserva intacto.
 *
 * Lo que NO hace: tocar imagen, audio, tags, precio o inventario.
 *
 * Uso:
 *   node forthcoming-prosa-de-correo.mjs --entrada prosa.json            # dry-run
 *   node forthcoming-prosa-de-correo.mjs --entrada prosa.json --apply    # escribe
 *
 * Credenciales: SHOPIFY_ADMIN_CLIENT_ID / _SECRET en ~/.houseonly-secrets.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prosaDeCorreo, cuerpoSinGenerado, parrafoHtml, descripcionDeProducto }
  from '../src/lib/html-text.mjs';

(() => {
  const f = join(homedir(), '.houseonly-secrets');
  if (!existsSync(f)) return;
  for (const linea of readFileSync(f, 'utf8').split('\n')) {
    const m = linea.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
})();

const SHOP = 'house-only-2.myshopify.com';
const API = '2026-04';
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ENTRADA = argv[argv.indexOf('--entrada') + 1];
if (!ENTRADA || !existsSync(ENTRADA)) {
  console.error('falta --entrada <fichero.json> con [{ sku, texto }]');
  process.exit(1);
}

async function tokenAdmin() {
  const id = process.env.SHOPIFY_ADMIN_CLIENT_ID, secret = process.env.SHOPIFY_ADMIN_CLIENT_SECRET;
  if (!id || !secret) throw new Error('faltan SHOPIFY_ADMIN_CLIENT_ID y SHOPIFY_ADMIN_CLIENT_SECRET en ~/.houseonly-secrets');
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
  if (!r.ok) throw new Error(`token admin ${r.status}`);
  return (await r.json()).access_token;
}

const gql = (token) => async (query, variables) => {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }) });
  const d = await r.json();
  if (d.errors) throw new Error(JSON.stringify(d.errors).slice(0, 300));
  return d.data;
};

const BUSCAR = `query($q:String!){ products(first:5, query:$q){
  edges{ node{ id title descriptionHtml variants(first:5){ edges{ node{ sku } } } } } } }`;

const ESCRIBIR = `mutation($input:ProductInput!){ productUpdate(input:$input){
  product{ id } userErrors{ field message } } }`;

const filas = JSON.parse(readFileSync(ENTRADA, 'utf8'));
const api = gql(await tokenAdmin());
let escritos = 0, saltados = 0, sinProsa = 0, noEncontrados = 0;

console.log(`${APPLY ? 'ESCRIBIENDO' : 'DRY-RUN'} · ${filas.length} candidatos\n`);

for (const fila of filas) {
  const sku = String(fila.sku || '').trim();
  const prosa = prosaDeCorreo(fila.texto || fila.limpio || '');
  if (!prosa) { sinProsa++; console.log(`  —  ${sku.padEnd(16)} sin prosa publicable, se descarta`); continue; }

  const d = await api(BUSCAR, { q: `sku:${JSON.stringify(sku)}` });
  const nodo = (d.products.edges || [])
    .map(e => e.node)
    .find(n => n.variants.edges.some(v => v.node.sku === sku));
  if (!nodo) { noEncontrados++; console.log(`  ?  ${sku.padEnd(16)} no esta en la tienda`); continue; }

  const cuerpo = nodo.descriptionHtml || '';
  const yaTiene = descripcionDeProducto(cuerpo).texto.trim();
  if (yaTiene) { saltados++; console.log(`  =  ${sku.padEnd(16)} ya tiene descripcion (${yaTiene.length} car.), no se toca`); continue; }

  const nuevo = parrafoHtml(prosa) + cuerpoSinGenerado(cuerpo);
  console.log(`  ${APPLY ? '+' : '·'}  ${sku.padEnd(16)} ${prosa.length} car. · ${nodo.title}`);
  if (!APPLY) continue;

  const w = await api(ESCRIBIR, { input: { id: nodo.id, descriptionHtml: nuevo } });
  const err = w.productUpdate?.userErrors || [];
  if (err.length) console.log(`     ERROR: ${err.map(e => e.message).join('; ')}`);
  else escritos++;
}

console.log(`\n${APPLY ? `escritos ${escritos}` : `se escribirian ${filas.length - sinProsa - saltados - noEncontrados}`}`
  + ` · ya tenian texto ${saltados} · sin prosa ${sinProsa} · no encontrados ${noEncontrados}`);
if (!APPLY) console.log('Nada escrito. Repite con --apply.');
