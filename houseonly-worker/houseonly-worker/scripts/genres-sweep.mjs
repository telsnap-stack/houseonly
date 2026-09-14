#!/usr/bin/env node
/**
 * Barrido de generos del catalogo. Calcado de entities-backfill-metafields.mjs:
 * dry-run por defecto, --apply para escribir, lotes y rate limit.
 *
 * DOS PASADAS, y el orden NO es negociable:
 *
 *   A (por defecto)   ADITIVA: escribe `genre:<id>` y no borra nada.
 *   ...despliegue del codigo nuevo a produccion y verificacion...
 *   B (--limpieza)    BORRA las grafias equivalentes y los no-generos.
 *
 * Al reves se rompe la tienda de verdad: si "dnb" desaparece antes de que el
 * codigo nuevo este en produccion, DNB_TAGS deja de encontrar nada y la seccion
 * de Drum & Bass se queda vacia para el cliente.
 *
 *   node scripts/genres-sweep.mjs                 dry-run de la pasada A
 *   node scripts/genres-sweep.mjs --apply         aplica la A  (pide Admin)
 *   node scripts/genres-sweep.mjs --limpieza      dry-run de la pasada B
 *   node scripts/genres-sweep.mjs --limpieza --apply
 */
import { GENRES, NO_SON_GENEROS, resolveGenre, clasificaValor, genreTag } from '../src/lib/genres.mjs';

const SHOP = 'house-only-2.myshopify.com';
const STOREFRONT = '3edf470af24f9bd4b81bca274121eec4';   // token publico, solo lectura
const API_SF = '2024-01', API_ADMIN = '2026-04';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMPIEZA = args.includes('--limpieza');

/** Tags que el producto ya trae y que NO son genero: se dejan en paz. */
const esEstructural = t => /:/.test(t) || /^\d{4}$/.test(t) || /^forthcoming$/i.test(t)
  || /^(12|excl|lp|ep|single|vinyl|kudos)/i.test(t);

// ── LECTURA ─────────────────────────────────────────────────────────
// El dry-run lee por Storefront: no necesita credenciales y devuelve
// exactamente los mismos 1276 que `status:active` en la Admin API (medido).
async function leerStorefront() {
  const q = `query($cursor:String){ products(first:250, after:$cursor){ pageInfo{hasNextPage endCursor}
    edges{node{ id title tags variants(first:1){edges{node{sku}}} }}}}`;
  let cursor = null, out = [];
  while (true) {
    const r = await fetch(`https://${SHOP}/api/${API_SF}/graphql.json`, { method:'POST',
      headers:{'Content-Type':'application/json','X-Shopify-Storefront-Access-Token':STOREFRONT},
      body: JSON.stringify({ query:q, variables:{cursor} }) });
    const d = await r.json();
    const p = d?.data?.products; if (!p) throw new Error(JSON.stringify(d).slice(0,200));
    out.push(...p.edges.map(e => ({ id:e.node.id, title:e.node.title, tags:e.node.tags,
      sku: e.node.variants.edges[0]?.node.sku || '' })));
    if (!p.pageInfo.hasNextPage) break;
    cursor = p.pageInfo.endCursor;
  }
  return out;
}

async function tokenAdmin() {
  const id = process.env.SHOPIFY_ADMIN_CLIENT_ID, secret = process.env.SHOPIFY_ADMIN_CLIENT_SECRET;
  if (!id || !secret) throw new Error('faltan SHOPIFY_ADMIN_CLIENT_ID / SHOPIFY_ADMIN_CLIENT_SECRET');
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, { method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({ grant_type:'client_credentials', client_id:id, client_secret:secret }) });
  if (!r.ok) throw new Error(`token admin ${r.status}`);
  return (await r.json()).access_token;
}

// ── EL PLAN ─────────────────────────────────────────────────────────
function plan(productos) {
  const p = { porGenero:new Map(), sinGenero:[], desconocidos:new Map(), escrituras:[], yaTienen:0, borrados:new Map() };
  for (const prod of productos) {
    const crudos = (prod.tags || []).filter(t => !esEstructural(t));
    const g = resolveGenre(crudos);

    if (g) p.porGenero.set(g.id, (p.porGenero.get(g.id) || 0) + 1);
    else p.sinGenero.push(prod);

    for (const v of crudos) {
      if (clasificaValor(v) === 'desconocido') {
        if (!p.desconocidos.has(v)) p.desconocidos.set(v, []);
        p.desconocidos.get(v).push(prod.sku || prod.title);
      }
    }

    if (!LIMPIEZA) {
      if (!g) continue;
      if ((prod.tags || []).includes(g.tag)) { p.yaTienen++; continue; }
      p.escrituras.push({ ...prod, anadir:[g.tag], quitar:[] });
    } else {
      const quitar = (prod.tags || []).filter(t => !esEstructural(t) && clasificaValor(t) === 'borrar');
      if (!quitar.length) continue;
      // Nunca se quita nada si el canonico no esta ya puesto: seria perder el dato.
      if (g && !(prod.tags || []).includes(g.tag)) continue;
      for (const t of quitar) p.borrados.set(t, (p.borrados.get(t) || 0) + 1);
      p.escrituras.push({ ...prod, anadir:[], quitar });
    }
  }
  return p;
}

// ── ESCRITURA ───────────────────────────────────────────────────────
async function escribir(token, prod) {
  const tags = new Set(prod.tags || []);
  for (const t of prod.quitar) tags.delete(t);
  for (const t of prod.anadir) tags.add(t);
  const q = `mutation($input:ProductInput!){ productUpdate(input:$input){ product{id} userErrors{field message} } }`;
  const r = await fetch(`https://${SHOP}/admin/api/${API_ADMIN}/graphql.json`, { method:'POST',
    headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},
    body: JSON.stringify({ query:q, variables:{ input:{ id:prod.id, tags:[...tags] } } }) });
  const d = await r.json();
  const err = d?.data?.productUpdate?.userErrors || [];
  if (err.length) throw new Error(err.map(e => e.message).join('; '));
  const t = d?.extensions?.cost?.throttleStatus;
  if (t && t.currentlyAvailable < 200) await new Promise(s => setTimeout(s, 1000));
}

// ── PRINCIPAL ───────────────────────────────────────────────────────
const pasada = LIMPIEZA ? 'B · LIMPIEZA (borra)' : 'A · ADITIVA (solo escribe genre:)';
console.log(`\ngenres-sweep — pasada ${pasada}`);
console.log(APPLY ? '  MODO APLICAR: se escribe en la tienda real.\n' : '  DRY-RUN: no se escribe nada. Usa --apply para aplicar.\n');

const productos = await leerStorefront();
console.log(`  ${productos.length} productos activos leidos\n`);
const p = plan(productos);

if (!LIMPIEZA) {
  console.log('  GENERO CANONICO QUE RECIBIRIA CADA PRODUCTO');
  for (const g of GENRES) {
    const n = p.porGenero.get(g.id) || 0;
    if (n) console.log(`    ${genreTag(g.id).padEnd(22)} ${String(n).padStart(5)}   (${g.seccion})`);
  }
  console.log(`    ${'(sin genero)'.padEnd(22)} ${String(p.sinGenero.length).padStart(5)}`);
  console.log(`\n  ya lo tienen puesto: ${p.yaTienen} · se escribirian: ${p.escrituras.length}`);
} else {
  console.log('  TAGS QUE SE BORRARIAN, y en cuantos productos');
  const orden = [...p.borrados.entries()].sort((a,b) => b[1]-a[1]);
  for (const [t,n] of orden) console.log(`    ${t.padEnd(28)} ${String(n).padStart(5)}`);
  console.log(`\n  productos tocados: ${p.escrituras.length} · tags distintos: ${orden.length}`);
}

const desc = [...p.desconocidos.entries()].sort((a,b) => b[1].length - a[1].length);
console.log(`\n  A LA COLA DE REVISION — ${desc.length} valores que no estan en la lista ni en los alias:`);
for (const [v, skus] of desc) {
  console.log(`    ${v.slice(0,30).padEnd(32)} ${String(skus.length).padStart(4)}  p.ej. ${skus.slice(0,2).join(', ')}`);
}


if (!APPLY) { console.log('\nDry-run: nada escrito.\n'); process.exit(0); }

const token = await tokenAdmin();
let ok = 0, fallos = 0;
for (const prod of p.escrituras) {
  try { await escribir(token, prod); ok++; } catch (e) { fallos++; console.error(`  ${prod.sku}: ${e.message}`); }
  if (ok % 50 === 0 && ok) process.stdout.write(`  ${ok}/${p.escrituras.length}…\r`);
}
console.log(`\n  escritos ${ok} · fallos ${fallos}\n`);
