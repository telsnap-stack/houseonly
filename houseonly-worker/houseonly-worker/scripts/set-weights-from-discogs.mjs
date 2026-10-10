#!/usr/bin/env node
/**
 * Pesos de envio reales en Shopify a partir del formato del release de Discogs.
 *
 * Hoy todo el catalogo lleva 0,5 kg generico: un 2LP o un 3LP cobra el primer
 * tramo de envio. Para cada SKU emparejado con Discogs (sku:{SKU} en
 * SYNC_STATE → listing_id → release), cuenta los formatos de tipo Vinyl del
 * release y aplica la regla de src/lib/vinyl-weight.mjs:
 *   0,15 kg embalaje + discos × (12"/LP 0,25 · 10" 0,18 · 7" 0,08) (+0,20 box set)
 * Un release sin vinilo, o que no se puede leer, no se toca y se lista.
 *
 * OJO (memoria discogs-match-needs-manual-approval): un emparejamiento con el
 * release equivocado da un peso equivocado. Por eso la tabla marca:
 *   DRAFT  el listing de Discogs no esta publicado (puede venir del auto-listado
 *          sin revisar)
 *   DISCREP  el titulo de Shopify dice otro numero de discos ("2LP", "3x12"…),
 *            o el peso actual (si no es el 0,5 generico) implica otro numero
 *   TALLA?   el release no dice el tamano del vinilo (se cuenta como 12")
 * y --commit NO aplica los marcados DRAFT o DISCREP salvo con --incluir-dudosos.
 *
 * USO (en un terminal normal; wrangler con sesion iniciada):
 *   node scripts/set-weights-from-discogs.mjs                      dry-run, tabla + CSV
 *   node scripts/set-weights-from-discogs.mjs --commit             aplica (pide credenciales Admin)
 *   node scripts/set-weights-from-discogs.mjs --commit --incluir-dudosos
 *   opciones: --limit N  --out ruta.csv
 *
 * Entorno:
 *   DISCOGS_TOKEN                opcional: 60 llamadas/min en vez de 25
 *   SHOPIFY_ADMIN_CLIENT_ID/SECRET  solo para --commit (como los otros scripts)
 *
 * Fuentes: el mapa sku → listing sale de SYNC_STATE de PROD con wrangler; las
 * respuestas de Discogs se guardan en SYNC_STATE (`discogs-release:{id}`), asi
 * que repetir el dry-run no vuelve a pedirlas. El peso actual y el titulo, de
 * la Storefront (dry-run); al aplicar, de la Admin API. Reanudable: un producto
 * que ya tiene el peso calculado se salta.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import dns from 'node:dns';
import { pesoDesdeDiscogs, pesoDesdeTexto, describirPeso, tramo } from '../src/lib/vinyl-weight.mjs';

// En esta red el IPv6 puede estar roto y el fetch de Node se cuelga (2026-10-09).
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const DUDOSOS = args.includes('--incluir-dudosos');
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const LIMIT = parseInt(opt('--limit') || '0', 10) || 0;
const OUT = opt('--out') || join(mkdtempSync(join(tmpdir(), 'pesos-')), `pesos-${new Date().toISOString().slice(0, 10)}.csv`);
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOP = 'house-only-2.myshopify.com';
const SF_TOKEN = '3edf470af24f9bd4b81bca274121eec4';       // publico, el del bundle de la tienda
const ADMIN_API = '2026-04';
const DISCOGS = 'https://api.discogs.com';
const UA = 'HouseOnlyWeights/1.0 +https://houseonly.store';
const DTOKEN = process.env.DISCOGS_TOKEN || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── wrangler (KV de PROD) ──────────────────────────────────────────
function wrangler(argv, input) {
  // Tres intentos: wrangler falla de vez en cuando al renovar su sesion OAuth
  // ("Authentication error [code: 10000]") y a la siguiente funciona.
  for (let intento = 1; ; intento++) {
    try {
      return execFileSync('npx', ['wrangler', ...argv], {
        cwd: WORKER_DIR, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: '--dns-result-order=ipv4first --no-network-family-autoselection' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (intento >= 3) throw new Error(`wrangler ${argv.slice(0, 3).join(' ')}: ${String(e.stderr || e.message).replace(/\x1b\[[0-9;]*m/g, '').split('\n').find((l) => /error/i.test(l)) || e.message}`);
      execFileSync('sleep', ['3']);
    }
  }
}
function kvList(prefix) {
  const out = wrangler(['kv', 'key', 'list', '--binding', 'SYNC_STATE', '--remote', '--prefix', prefix]);
  return JSON.parse(out.slice(out.indexOf('['))).map((k) => k.name);
}
function kvBulkGet(names) {
  const res = {};
  const dir = mkdtempSync(join(tmpdir(), 'kv-'));
  for (let i = 0; i < names.length; i += 100) {
    const f = join(dir, 'keys.json');
    writeFileSync(f, JSON.stringify(names.slice(i, i + 100)));
    const out = wrangler(['kv', 'bulk', 'get', '--binding', 'SYNC_STATE', '--remote', f]);
    const m = out.match(/\{[\s\S]*\}/);
    if (m) Object.assign(res, JSON.parse(m[0]));
  }
  return res;
}
function kvBulkPut(pairs) {
  if (!pairs.length) return;
  const dir = mkdtempSync(join(tmpdir(), 'kv-'));
  const f = join(dir, 'put.json');
  writeFileSync(f, JSON.stringify(pairs));
  wrangler(['kv', 'bulk', 'put', '--binding', 'SYNC_STATE', '--remote', f]);
}

// ── Discogs, respetando el rate limit ──────────────────────────────
let restantes = 5;
async function discogs(path) {
  for (let intento = 0; intento < 5; intento++) {
    if (restantes <= 1) await sleep(61000);
    else await sleep(DTOKEN ? 1050 : 2500);
    let r;
    try {
      r = await fetch(`${DISCOGS}${path}`, {
        headers: { 'User-Agent': UA, ...(DTOKEN ? { Authorization: `Discogs token=${DTOKEN}` } : {}) },
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      // Red inestable (ETIMEDOUT, reset): esperar y reintentar, no abortar todo.
      await sleep(5000 * (intento + 1));
      continue;
    }
    restantes = parseInt(r.headers.get('x-discogs-ratelimit-remaining') || '5', 10);
    if (r.status === 429) { restantes = 0; continue; }
    if (r.status === 404) return null;
    // 401/403: un listing en Draft/Sold que sin el token del dueno no se ve.
    if (r.status === 401 || r.status === 403) return { noAccess: true };
    if (!r.ok) throw new Error(`Discogs ${r.status} ${path}`);
    return r.json();
  }
  throw new Error(`Discogs: sin respuesta tras 5 intentos en ${path}`);
}

// ── Shopify ────────────────────────────────────────────────────────
async function storefrontCatalogo() {
  const out = new Map();
  let cursor = null;
  for (;;) {
    const after = cursor ? `, after: "${cursor}"` : '';
    const r = await fetch(`https://${SHOP}/api/2024-01/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': SF_TOKEN },
      body: JSON.stringify({ query: `{ products(first: 250${after}) { pageInfo { hasNextPage endCursor } nodes { handle title vendor variants(first: 5) { nodes { sku weight weightUnit } } } } }` }),
    });
    const d = (await r.json()).data.products;
    for (const p of d.nodes) for (const v of p.variants.nodes) {
      if (!v.sku) continue;
      const kg = v.weightUnit === 'GRAMS' ? v.weight / 1000 : v.weightUnit === 'POUNDS' ? v.weight * 0.4536 : v.weightUnit === 'OUNCES' ? v.weight * 0.02835 : v.weight;
      out.set(v.sku, { title: `${p.vendor ? p.vendor + ' – ' : ''}${p.title}`, kg: Math.round((kg || 0) * 100) / 100 });
    }
    if (!d.pageInfo.hasNextPage) break;
    cursor = d.pageInfo.endCursor;
  }
  return out;
}

let adminToken = '';
async function admin(query, variables) {
  if (!adminToken) {
    const { SHOPIFY_ADMIN_CLIENT_ID: id, SHOPIFY_ADMIN_CLIENT_SECRET: secret } = process.env;
    if (!id || !secret) throw new Error('--commit necesita SHOPIFY_ADMIN_CLIENT_ID y SHOPIFY_ADMIN_CLIENT_SECRET');
    const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
    });
    adminToken = (await r.json()).access_token;
    if (!adminToken) throw new Error('No se obtuvo token de la Admin API');
  }
  const r = await fetch(`https://${SHOP}/admin/api/${ADMIN_API}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': adminToken },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json();
  if (d.errors?.length) throw new Error(d.errors[0].message);
  return d.data;
}

// ── principal ──────────────────────────────────────────────────────
async function main() {
  console.log(`${COMMIT ? 'COMMIT' : 'DRY-RUN'} · Discogs ${DTOKEN ? 'con token (60/min)' : 'sin token (25/min)'}\n`);

  // 1 · sku → listing (SYNC_STATE de prod)
  process.stdout.write('Leyendo sku:* de SYNC_STATE… ');
  const skuNames = kvList('sku:');
  const skuMap = Object.fromEntries(Object.entries(kvBulkGet(skuNames)).filter(([, v]) => v).map(([k, v]) => [k.slice(4), JSON.parse(v)]));
  let skus = Object.keys(skuMap).sort();
  if (LIMIT) skus = skus.slice(0, LIMIT);
  console.log(`${Object.keys(skuMap).length} SKU emparejados${LIMIT ? ` (limit ${LIMIT})` : ''}.`);

  // 2 · catalogo de Shopify (titulo y peso actual)
  process.stdout.write('Leyendo el catalogo de la Storefront… ');
  const catalogo = await storefrontCatalogo();
  console.log(`${catalogo.size} variantes.`);

  // 3 · listing → release: el inventario publico de una vez, el resto uno a uno
  process.stdout.write('Inventario de Discogs (listing → release)… ');
  const listingRelease = new Map();
  for (let page = 1, pages = 1; page <= pages; page++) {
    const d = await discogs(`/users/houseonly/inventory?per_page=100&page=${page}`);
    pages = d?.pagination?.pages || 1;
    for (const l of d?.listings || []) listingRelease.set(l.id, l.release?.id);
  }
  console.log(`${listingRelease.size} listings.`);
  const sinRelease = skus.filter((s) => !listingRelease.has(skuMap[s].listing_id));
  if (sinRelease.length) console.log(`${sinRelease.length} listings fuera del inventario publico (Draft/Sold): uno a uno…`);
  const sinAcceso = new Set();
  for (const s of sinRelease) {
    let l = null;
    try { l = await discogs(`/marketplace/listings/${skuMap[s].listing_id}`); } catch { /* queda sin release y se lista */ }
    if (l?.noAccess) sinAcceso.add(s);
    else if (l?.release?.id) listingRelease.set(skuMap[s].listing_id, l.release.id);
  }
  if (sinAcceso.size) console.log(`${sinAcceso.size} listings no se pueden leer sin DISCOGS_TOKEN.`);

  // 4 · releases, con cache en KV
  const releaseIds = [...new Set(skus.map((s) => listingRelease.get(skuMap[s].listing_id)).filter(Boolean))];
  process.stdout.write(`Releases: ${releaseIds.length}. Cache en KV… `);
  const cacheNames = releaseIds.map((id) => `discogs-release:${id}`);
  const enCache = Object.fromEntries(Object.entries(kvBulkGet(cacheNames)).filter(([, v]) => v).map(([k, v]) => [Number(k.split(':')[1]), JSON.parse(v)]));
  const faltan = releaseIds.filter((id) => !enCache[id]);
  console.log(`${Object.keys(enCache).length} en cache, ${faltan.length} por pedir (~${Math.ceil(faltan.length / (DTOKEN ? 55 : 24))} min).`);
  let nuevos = [];
  for (let i = 0; i < faltan.length; i++) {
    const id = faltan[i];
    try {
      const r = await discogs(`/releases/${id}`);
      const v = r ? { id, title: r.title, artists: (r.artists || []).map((a) => a.name).join(', '), formats: r.formats || [] } : { id, error: 'not found' };
      enCache[id] = v;
      nuevos.push({ key: `discogs-release:${id}`, value: JSON.stringify(v) });
    } catch (e) { enCache[id] = { id, error: e.message }; }
    if (nuevos.length >= 50) { kvBulkPut(nuevos); nuevos = []; }
    if ((i + 1) % 25 === 0) process.stdout.write(`  ${i + 1}/${faltan.length}\r`);
  }
  kvBulkPut(nuevos);

  // 5 · calculo y marcas
  const filas = [], noTocados = [];
  for (const sku of skus) {
    const m = skuMap[sku];
    const rid = listingRelease.get(m.listing_id);
    const rel = rid ? enCache[rid] : null;
    const shop = catalogo.get(sku);
    const base = { sku, listing: m.listing_id, estado: m.status, release: rid || '', titulo: shop?.title || '' };
    if (!rid) { noTocados.push({ ...base, motivo: sinAcceso.has(sku) ? `listing ${m.status} sin acceso (falta DISCOGS_TOKEN)` : 'listing sin release legible' }); continue; }
    if (!rel || rel.error) { noTocados.push({ ...base, motivo: `release ${rid}: ${rel?.error || 'no leido'}` }); continue; }
    const p = pesoDesdeDiscogs(rel.formats);
    if (!p) { noTocados.push({ ...base, motivo: `release sin vinilo (${(rel.formats || []).map((f) => f.name).join(', ')})` }); continue; }
    if (!shop) { noTocados.push({ ...base, motivo: 'no esta en la Storefront (sin publicar o borrado)' }); continue; }
    const marcas = [];
    if (m.status === 'Draft') marcas.push('DRAFT');
    const t = pesoDesdeTexto(shop.title);
    if (t.origen === 'texto' && t.discos !== p.discos) marcas.push(`DISCREP(titulo ${t.discos})`);
    // El peso actual tambien es un dato si no es el 0,5 generico: lo pusieron los
    // importers que leen el formato del distribuidor (Triple Vision: discos ×
    // 0,5; otros 0,9 = 2LP, 1,3 = 3LP; 0,18 = 7"). Si de ahi sale otro numero de
    // discos que en Discogs, el emparejamiento es sospechoso.
    if (Math.abs(shop.kg - 0.5) >= 0.005) {
      const implicitos = Math.max(1, Math.round(shop.kg / 0.5));
      if (implicitos !== p.discos) marcas.push(`DISCREP(peso actual ${shop.kg} = ${implicitos} discos)`);
    }
    if (p.partes.some((x) => x.sinTalla)) marcas.push('TALLA?');
    filas.push({ ...base, formato: describirPeso(p), actual: shop.kg, nuevo: p.kg, cambia: Math.abs(shop.kg - p.kg) >= 0.005,
      tramoAntes: tramo(shop.kg), tramoDespues: tramo(p.kg), marcas });
  }

  // 6 · informe
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  console.log(`\n${pad('SKU', 16)} ${pad('Título', 44)} ${pad('Discogs', 14)} actual → nuevo  marcas`);
  for (const f of filas.filter((x) => x.cambia || x.marcas.length)) {
    console.log(`${pad(f.sku, 16)} ${pad(f.titulo, 44)} ${pad(f.formato, 14)} ${f.actual.toFixed(2)} → ${f.nuevo.toFixed(2)}  ${f.marcas.join(' ')}`);
  }
  const csv = [['sku', 'titulo', 'estado_listing', 'listing_id', 'release_id', 'formato_discogs', 'peso_actual', 'peso_nuevo', 'tramo_antes', 'tramo_despues', 'marcas', 'motivo_no_tocado']]
    .concat(filas.map((f) => [f.sku, f.titulo, f.estado, f.listing, f.release, f.formato, f.actual, f.nuevo, f.tramoAntes, f.tramoDespues, f.marcas.join(' '), '']))
    .concat(noTocados.map((f) => [f.sku, f.titulo, f.estado, f.listing, f.release, '', '', '', '', '', '', f.motivo]))
    .map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  writeFileSync(OUT, csv);

  const cambian = filas.filter((f) => f.cambia);
  const subenTramo = cambian.filter((f) => f.tramoAntes !== f.tramoDespues);
  const porTramo = {};
  for (const f of subenTramo) porTramo[`${f.tramoAntes} → ${f.tramoDespues}`] = (porTramo[`${f.tramoAntes} → ${f.tramoDespues}`] || 0) + 1;
  const emparejados = new Set(filas.map((f) => f.sku));
  const quedan05 = [...catalogo.entries()].filter(([sku, v]) => !emparejados.has(sku) && Math.abs(v.kg - 0.5) < 0.005).length;
  const dudosos = cambian.filter((f) => f.marcas.some((m) => m === 'DRAFT' || m.startsWith('DISCREP')));
  console.log(`
Resumen
  SKU emparejados en SYNC_STATE:      ${skus.length}
  con peso calculado (vinilo):        ${filas.length}
  no tocados:                         ${noTocados.length}  (motivos en el CSV)
  cambian de peso:                    ${cambian.length}
  cambian de tramo:                   ${subenTramo.length}  ${JSON.stringify(porTramo)}
  marcados DRAFT o DISCREP:           ${dudosos.length}  (--commit no los aplica sin --incluir-dudosos)
  sin Discogs, se quedan en 0,5 kg:   ${quedan05}
  CSV completo: ${OUT}`);

  if (!COMMIT) { console.log('\nDry-run: no se ha cambiado nada en Shopify.'); return; }

  // 7 · aplicar
  const aplicar = cambian.filter((f) => DUDOSOS || !dudosos.includes(f));
  console.log(`\nAplicando ${aplicar.length} pesos…`);
  let hechos = 0, saltados = 0;
  for (const f of aplicar) {
    const d = await admin(`query($q: String!) { productVariants(first: 5, query: $q) { nodes { sku inventoryItem { id measurement { weight { value unit } } } } } }`, { q: `sku:'${f.sku.replace(/'/g, "\\'")}'` });
    const v = d.productVariants.nodes.find((x) => x.sku === f.sku);
    if (!v) { console.log(`  ✗ ${f.sku}: no encontrado en la Admin API`); continue; }
    const w = v.inventoryItem.measurement?.weight;
    const kgActual = w ? (w.unit === 'GRAMS' ? w.value / 1000 : w.unit === 'POUNDS' ? w.value * 0.4536 : w.unit === 'OUNCES' ? w.value * 0.02835 : w.value) : 0;
    if (Math.abs(kgActual - f.nuevo) < 0.005) { saltados++; continue; }   // reanudable
    const u = await admin(`mutation($id: ID!, $input: InventoryItemInput!) { inventoryItemUpdate(id: $id, input: $input) { inventoryItem { measurement { weight { value unit } } } userErrors { field message } } }`,
      { id: v.inventoryItem.id, input: { measurement: { weight: { value: f.nuevo, unit: 'KILOGRAMS' } } } });
    const errs = u.inventoryItemUpdate.userErrors;
    if (errs?.length) console.log(`  ✗ ${f.sku}: ${errs.map((e) => e.message).join('; ')}`);
    else { hechos++; if (hechos % 25 === 0) console.log(`  ${hechos}/${aplicar.length}`); }
    await sleep(300);
  }
  console.log(`\nAplicados ${hechos}, ya estaban ${saltados}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
