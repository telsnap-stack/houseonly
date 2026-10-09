#!/usr/bin/env node
// Siembra el feed de Instagram (/ig) con los Reels ya publicados.
//
// Lee ig-seed.json —[{handle, sku, reel_date, title_ocr}], del mas antiguo al
// mas reciente— y anade cada disco con ?action=ig-feed-add. Cada add lo pone el
// primero, asi que al terminar el Reel mas reciente queda arriba.
//
// Titulo y artista salen de Shopify (Storefront API, la misma consulta que usa
// /ig: un alias de product(handle:) por disco), NUNCA de title_ocr, que es una
// lectura de la portada y solo sirve de orientacion. Un handle que no existe en
// Shopify se salta y se lista al final.
//
// USO — en un terminal normal, NO dentro de un agente (pide el Bearer):
//   node scripts/seed-ig-feed.mjs [ruta/ig-seed.json]            → dry-run
//   node scripts/seed-ig-feed.mjs [ruta] --commit                → produccion
//   node scripts/seed-ig-feed.mjs [ruta] --commit --staging      → staging
// Ruta por defecto: ig-seed.json en la raiz del repo. El dry-run no pide Bearer
// ni escribe nada. El Bearer se pide por teclado sin eco (o BS=... en el
// entorno, como verify-ig-feed.sh).

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';

// En esta red el IPv6 puede estar roto y el fetch de Node se queda colgado en
// vez de caer a IPv4 (2026-10-09). Forzar IPv4 no cambia nada mas.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const STAGING = args.includes('--staging');
const here = path.dirname(fileURLToPath(import.meta.url));
const seedPath = args.find(a => !a.startsWith('--')) || path.resolve(here, '../../../ig-seed.json');

const WORKER = STAGING
  ? 'https://houseonly-worker-staging.emontagut.workers.dev'
  : 'https://houseonly-worker.emontagut.workers.dev';
// Token publico de la Storefront API: el mismo que va en el bundle de la tienda.
const SHOPIFY = { domain: 'house-only-2.myshopify.com', api: '2024-01', token: '3edf470af24f9bd4b81bca274121eec4' };
const PAUSA_MS = 150;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function shopifyQuery(query, variables) {
  const r = await fetch(`https://${SHOPIFY.domain}/api/${SHOPIFY.api}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': SHOPIFY.token },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json();
  if (d.errors) throw new Error(d.errors[0].message);
  return d.data;
}

// Lo mismo que fetchShopifyProductsByHandles de src/App.jsx, con solo los
// campos que hacen falta aqui. Devuelve Map handle -> {title, artist, sku}.
async function resolverHandles(handles) {
  const out = new Map();
  for (let i = 0; i < handles.length; i += 20) {
    const lote = handles.slice(i, i + 20);
    const vars = lote.map((_, j) => `$h${j}: String!`).join(', ');
    const campos = lote.map((_, j) => `p${j}: product(handle: $h${j}) { handle title vendor variants(first:1) { edges { node { sku } } } }`).join('\n');
    const data = await shopifyQuery(`query(${vars}) { ${campos} }`, Object.fromEntries(lote.map((h, j) => [`h${j}`, h])));
    lote.forEach((h, j) => {
      const p = data[`p${j}`];
      if (!p) return;
      // Como parseProduct: el vendor por defecto de Shopify ("House Only") no es
      // un artista.
      const vendor = (p.vendor || '').trim();
      out.set(h, { title: p.title || '', artist: vendor === 'House Only' ? '' : vendor, sku: p.variants.edges[0]?.node?.sku || '' });
    });
  }
  return out;
}

function pedirBearer() {
  if (process.env.BS) return Promise.resolve(process.env.BS.trim());
  return new Promise((resolve) => {
    process.stdout.write(`Bearer de ${STAGING ? 'staging' : 'produccion'} (no se vera al escribir): `);
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let v = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
        process.stdout.write('\n'); resolve(v.trim());
      } else if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
      else if (ch === '\u007f') v = v.slice(0, -1);
      else v += ch;
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  if (!Array.isArray(seed) || !seed.length) throw new Error(`${seedPath}: no es una lista`);
  console.log(`${seed.length} entradas en ${seedPath} · worker ${WORKER} · ${COMMIT ? 'COMMIT' : 'dry-run'}`);

  const info = await resolverHandles(seed.map(e => e.handle));
  const resueltos = [], faltan = [], skuDistinto = [];
  seed.forEach((e, i) => {
    const p = info.get(e.handle);
    if (!p) { faltan.push(e); return; }
    if (p.sku && e.sku && p.sku.toUpperCase() !== String(e.sku).toUpperCase()) skuDistinto.push({ ...e, skuShopify: p.sku });
    resueltos.push({ n: i + 1, handle: e.handle, sku: e.sku || p.sku, title: p.title, artist: p.artist, reel: e.reel_date || '' });
  });

  for (const r of resueltos) {
    console.log(`${String(r.n).padStart(3)}  ${r.reel.slice(0, 10)}  ${r.handle.padEnd(18)} ${String(r.sku).padEnd(16)} ${r.title} — ${r.artist || '(sin artista)'}`);
  }
  console.log(`\nResueltos: ${resueltos.length} · no existen en Shopify: ${faltan.length} · SKU distinto: ${skuDistinto.length} · sin artista: ${resueltos.filter(r => !r.artist).length}`);
  if (resueltos.length) console.log(`Quedara arriba: ${resueltos.at(-1).handle} · abajo: ${resueltos[0].handle}`);
  if (faltan.length) { console.log('\nSaltados (no existen en Shopify):'); faltan.forEach(e => console.log(`  ${e.handle}  (${e.sku}, OCR: ${e.title_ocr || ''})`)); }
  if (skuDistinto.length) { console.log('\nSKU del JSON distinto al de Shopify (se manda el del JSON):'); skuDistinto.forEach(e => console.log(`  ${e.handle}  JSON ${e.sku} · Shopify ${e.skuShopify}`)); }

  if (!COMMIT) { console.log('\nDry-run: no se ha enviado nada. Repite con --commit para sembrar.'); return; }

  const antes = await (await fetch(`${WORKER}/?action=ig-feed&t=${Date.now()}`)).json();
  console.log(`\nFeed actual: ${antes.items?.length ?? '?'} discos (se conservan; los repetidos suben).`);
  const BS = await pedirBearer();
  if (!BS) { console.error('Sin Bearer no se siembra.'); process.exit(2); }

  let ok = 0;
  for (const r of resueltos) {
    let intento = 0;
    for (;;) {
      try {
        const res = await fetch(`${WORKER}/?action=ig-feed-add`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${BS}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ handle: r.handle, sku: r.sku, title: r.title, artist: r.artist }),
        });
        if (res.status === 401) { console.error('\n401: Bearer incorrecto para este entorno. Parado sin mandar nada mas.'); process.exit(1); }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
        break;
      } catch (e) {
        if (++intento >= 3) { console.error(`\n✗ ${r.handle}: ${e.message}. Parado tras ${ok} de ${resueltos.length}; repetir es seguro (no duplica).`); process.exit(1); }
        await sleep(1000 * intento);
      }
    }
    ok++;
    process.stdout.write(`\r${ok}/${resueltos.length} ${r.handle.padEnd(20)}`);
    await sleep(PAUSA_MS);
  }
  const despues = await (await fetch(`${WORKER}/?action=ig-feed&t=${Date.now()}`)).json();
  const items = despues.items || [];
  console.log(`\n\nHecho: ${ok} enviados. El feed tiene ${items.length}; primero ${items[0]?.handle}, ultimo ${items.at(-1)?.handle}.`);
  console.log('(El GET publico lleva 60 s de cache: si el recuento no cuadra, repite en un minuto.)');
}

main().catch(e => { console.error(e); process.exit(1); });
