#!/usr/bin/env node
/**
 * entities-backfill-metafields.mjs — escribe el slug de entidad en los productos
 * que ya estaban subidos.
 *
 * Fase 4, paso (c) de docs/entities.md. Los importers ya escriben las dos
 * columnas al generar el CSV, pero eso solo vale para lo que entre a partir de
 * ahora: los ~1276 productos que ya estan en la tienda no tienen el metafield, y
 * sin el, el feed de la fase 5 no los ve.
 *
 * Que hace:
 *   1. Pagina el catalogo PUBLICADO por Admin API pidiendo vendor, tags y los
 *      dos metafields que ya tenga.
 *   2. Resuelve vendors y sellos contra la capa de entidades, en lotes.
 *   3. Compara lo que hay con lo que deberia haber y escribe SOLO lo que cambia,
 *      con metafieldsSet en lotes de 25.
 *
 * Lo que NO hace, y conviene que siga siendo asi:
 *   - No toca `vendor` ni los tags. Solo escribe metafields. La capa de
 *     entidades vive al lado del catalogo, no encima.
 *   - No borra nunca. Si un producto ya tiene un valor y el barrido no sabe
 *     resolverlo, se deja como esta: lo que hay pudo ponerlo una persona con
 *     mejor informacion que la de un script.
 *   - No crea entidades. entity-resolve solo propone; lo que no resuelve entra
 *     en la cola de revision —tambien en dry-run, porque la cola es idempotente
 *     y agrupar por nombre normalizado no duplica filas.
 *
 * Uso:
 *   node entities-backfill-metafields.mjs           # dry-run con resumen
 *   node entities-backfill-metafields.mjs --apply   # escribe
 *   node entities-backfill-metafields.mjs --limit 50 --apply   # una tanda corta
 *
 * Env:
 *   SHOPIFY_ADMIN_CLIENT_ID / SHOPIFY_ADMIN_CLIENT_SECRET
 *   STAGING_BS   (o PROD_BS con --prod)  Bearer de la capa de entidades
 */

import {
  ENTITY_MF_NAMESPACE, ENTITY_MF_KEYS, planMetafield, chunkMetafieldWrites,
  labelFromTags, METAFIELDS_SET_MAX,
} from '../src/lib/entity-metafields.ts';

const SHOP = 'house-only-2.myshopify.com';
const API = '2026-04';
const WORKERS = {
  staging: 'https://houseonly-worker-staging.emontagut.workers.dev',
  prod: 'https://houseonly-worker.emontagut.workers.dev',
};

const argv = process.argv.slice(2);
const args = new Set(argv);
const APPLY = args.has('--apply');
const PROD = args.has('--prod');
const LIMIT = Number(argv[argv.indexOf('--limit') + 1]) || 0;
const TARGET = PROD ? 'prod' : 'staging';
const WORKER = WORKERS[TARGET];
const BEARER = PROD ? process.env.PROD_BS : process.env.STAGING_BS;

// Margen del cubo de la Admin API por debajo del cual conviene esperar. El coste
// va por puntos, no por peticiones: la respuesta dice cuantos quedan y a que
// ritmo se rellenan, asi que se mira eso en vez de dormir a ojo.
const COST_FLOOR = 200;

function die(msg) { console.error(`\n✘ ${msg}\n`); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── SHOPIFY ─────────────────────────────────────────────────────────

async function adminToken() {
  const id = process.env.SHOPIFY_ADMIN_CLIENT_ID;
  const secret = process.env.SHOPIFY_ADMIN_CLIENT_SECRET;
  if (!id || !secret) die('faltan SHOPIFY_ADMIN_CLIENT_ID / SHOPIFY_ADMIN_CLIENT_SECRET');
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!r.ok) {
    const plain = (await r.text()).replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const oauth = plain.match(/Oauth error [^.]*/i);
    die(`credenciales de Shopify rechazadas (${r.status}): ${(oauth ? oauth[0] : plain).slice(0, 200)}`);
  }
  return (await r.json()).access_token;
}

/**
 * Una llamada a la Admin API, respetando el cubo de coste. Si la tienda contesta
 * THROTTLED se reintenta con espera creciente; si el cubo baja del margen, se
 * espera lo justo para que se rellene ANTES de la siguiente.
 */
async function gql(token, query, variables, depth = 0) {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (r.status === 429) {
    if (depth > 5) die('429 seis veces seguidas: la tienda no da mas, parar y mirar');
    await sleep(2000 * (depth + 1));
    return gql(token, query, variables, depth + 1);
  }
  if (!r.ok) die(`Admin API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();

  if (j.errors) {
    const throttled = JSON.stringify(j.errors).includes('THROTTLED');
    if (throttled && depth <= 5) {
      await sleep(2000 * (depth + 1));
      return gql(token, query, variables, depth + 1);
    }
    die(`Admin API GraphQL: ${JSON.stringify(j.errors).slice(0, 300)}`);
  }

  const t = j.extensions?.cost?.throttleStatus;
  if (t && t.currentlyAvailable < COST_FLOOR) {
    const falta = COST_FLOOR - t.currentlyAvailable;
    const espera = Math.ceil((falta / (t.restoreRate || 50)) * 1000);
    process.stdout.write(`\r  cubo a ${Math.round(t.currentlyAvailable)}, esperando ${espera} ms…`);
    await sleep(espera);
  }
  return j.data;
}

// `status:active` y NO `published_status:published`. En la Admin API el segundo
// va relativo a la publicacion del PROPIO app que pregunta, no a lo que ve el
// cliente: en esta tienda deja fuera 98 productos que la Storefront API si
// sirve. `status:active` da 1276, exactamente los mismos que devuelve la
// Storefront. Los 2 borradores se quedan fuera a proposito: cuando se publiquen
// pasaran por el webhook.
const PRODUCTS = `
  query backfill($cursor: String, $ns: String!, $artistKey: String!, $labelKey: String!) {
    products(first: 250, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        vendor
        tags
        artist: metafield(namespace: $ns, key: $artistKey) { value }
        label: metafield(namespace: $ns, key: $labelKey) { value }
      }
    }
  }
`;

const SET = `
  mutation setEntityMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key namespace }
      userErrors { field message code }
    }
  }
`;

async function readCatalogue(token) {
  const out = [];
  let cursor = null;
  for (let page = 1; page <= 40; page++) {
    const d = await gql(token, PRODUCTS, {
      cursor, ns: ENTITY_MF_NAMESPACE,
      artistKey: ENTITY_MF_KEYS.artist, labelKey: ENTITY_MF_KEYS.label,
    });
    out.push(...d.products.nodes);
    process.stdout.write(`\r  leidos ${out.length} productos…`);
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  process.stdout.write('\n');
  return out;
}

// ── ENTIDADES ───────────────────────────────────────────────────────

/** Devuelve Map raw → { slugs, status } para una tanda de valores. */
async function resolveAll(kind, raws) {
  const items = [...new Set(raws)].map(raw => ({ raw }));
  const out = new Map();
  for (let i = 0; i < items.length; i += 100) {
    const r = await fetch(`${WORKER}/?action=entity-resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEARER}` },
      body: JSON.stringify({ kind, source: 'backfill', items: items.slice(i, i + 100) }),
    });
    if (!r.ok) die(`entity-resolve ${kind} → HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const d = await r.json();
    for (const res of d.results || []) out.set(res.raw, { slugs: res.slugs || [], status: res.status });
    process.stdout.write(`\r  ${kind}: ${Math.min(i + 100, items.length)}/${items.length}…`);
  }
  process.stdout.write('\n');
  return out;
}

const WHY = { review: 'en la cola de revision', ignored: 'a proposito (V.A., white label…)' };

// ── MAIN ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nentities-backfill-metafields → ${SHOP} · entidades de ${TARGET}`);
  if (!APPLY) console.log('MODO DRY-RUN: no se escribe nada. Usa --apply para aplicar.');
  if (PROD && APPLY) console.log('⚠ resolviendo contra PRODUCCION\n');
  if (!BEARER) die(`falta ${PROD ? 'PROD_BS' : 'STAGING_BS'} en el entorno`);

  const token = await adminToken();
  let products = await readCatalogue(token);
  if (LIMIT) { products = products.slice(0, LIMIT); console.log(`  --limit ${LIMIT}: solo los primeros ${products.length}`); }

  const vendors = products.map(p => (p.vendor || '').trim()).filter(Boolean);
  const labels = products.map(p => labelFromTags(p.tags)).filter(Boolean);
  console.log(`\n  ${new Set(vendors).size} vendors distintos · ${new Set(labels).size} sellos distintos`);

  const aMap = await resolveAll('artist', vendors);
  const lMap = await resolveAll('label', labels);

  // ── plan ──
  const writes = [];                     // entradas de metafieldsSet
  const stats = { write: 0, same: 0, keep: 0, empty: 0 };
  const empties = {};                    // motivo → cuantos
  const muestras = { write: [], keep: [] };

  for (const p of products) {
    const vendor = (p.vendor || '').trim();
    const label = labelFromTags(p.tags);
    const a = vendor ? aMap.get(vendor) : null;
    const l = label ? lMap.get(label) : null;

    const plans = [
      planMetafield('artist', a?.slugs || [], p.artist?.value,
        vendor ? (WHY[a?.status] || '') : 'el producto no tiene vendor'),
      planMetafield('label', l?.slugs || [], p.label?.value,
        label ? (WHY[l?.status] || '') : 'el producto no tiene tag label:'),
    ];

    for (const plan of plans) {
      stats[plan.status]++;
      if (plan.status === 'write') {
        writes.push({
          ownerId: p.id, namespace: ENTITY_MF_NAMESPACE, key: plan.key,
          type: 'single_line_text_field', value: plan.desired,
        });
        if (muestras.write.length < 5) muestras.write.push(`${p.handle} · ${plan.key} = "${plan.desired}"${plan.existing ? ` (antes "${plan.existing}")` : ''}`);
      } else if (plan.status === 'empty') {
        empties[plan.why] = (empties[plan.why] || 0) + 1;
      } else if (plan.status === 'keep') {
        if (muestras.keep.length < 5) muestras.keep.push(`${p.handle} · ${plan.key} conserva "${plan.existing}" (${plan.why})`);
      }
    }
  }

  console.log(`\n  ${products.length} productos · ${products.length * 2} metafields mirados\n`);
  console.log(`  ${String(stats.write).padStart(5)}  se escribirian`);
  console.log(`  ${String(stats.same).padStart(5)}  ya coinciden — no se tocan`);
  console.log(`  ${String(stats.keep).padStart(5)}  conservan lo que tienen (no resuelve, pero hay valor)`);
  console.log(`  ${String(stats.empty).padStart(5)}  se quedan vacios:`);
  for (const [why, n] of Object.entries(empties).sort((a, b) => b[1] - a[1])) {
    console.log(`        ${String(n).padStart(5)}  ${why || 'sin motivo registrado'}`);
  }
  if (muestras.write.length) { console.log('\n  muestra de escrituras:'); muestras.write.forEach(m => console.log(`      ${m}`)); }
  if (muestras.keep.length) { console.log('\n  muestra de conservados:'); muestras.keep.forEach(m => console.log(`      ${m}`)); }

  if (!APPLY) {
    console.log(`\n  ${chunkMetafieldWrites(writes).length} llamadas a metafieldsSet (${METAFIELDS_SET_MAX} metafields por llamada)`);
    console.log('\nDry-run: nada escrito. Repite con --apply.\n');
    return;
  }

  // ── aplicar ──
  console.log('\nEscribiendo…');
  const lotes = chunkMetafieldWrites(writes);
  let escritos = 0, fallidos = 0;
  for (let i = 0; i < lotes.length; i++) {
    const d = await gql(token, SET, { metafields: lotes[i] });
    const errs = d.metafieldsSet.userErrors || [];
    if (errs.length) {
      // metafieldsSet es atomico: si hay error, ese lote entero no se escribio.
      fallidos += lotes[i].length;
      console.error(`\n  ⚠ lote ${i + 1}/${lotes.length} sin escribir: ${JSON.stringify(errs).slice(0, 200)}`);
    } else {
      escritos += d.metafieldsSet.metafields.length;
    }
    process.stdout.write(`\r  lote ${i + 1}/${lotes.length} · ${escritos} metafields escritos…`);
  }
  console.log(`\n\n  ${escritos} escritos · ${stats.same} ya coincidian · ${fallidos} fallidos\n`);
}

main().catch(e => die(e?.stack || String(e)));
