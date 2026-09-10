#!/usr/bin/env node
/**
 * entities-sweep.mjs — llena la cola de entidades con TODO el catalogo.
 *
 * Fase 3 de docs/entities.md. Sin esto, la capa de entidades solo conoce lo que
 * entre a partir de ahora y el 96 % de la suciedad se queda fuera: "seguir a
 * Koze" se perderia la mitad de su fondo.
 *
 * Que hace:
 *   1. Pagina los ~1266 productos por Admin API pidiendo handle, vendor y tags.
 *   2. Saca de cada uno el vendor (artista) y el valor de `label:` (sello),
 *      aceptando las TRES grafias de prefijo que hay en el catalogo:
 *      `label:X`, `Label: X` y `label: X`.
 *   3. Manda todo en lotes a ?action=entity-resolve.
 *   4. Lee la cola resultante y saca el resumen.
 *
 * NO escribe nada en Shopify. NO crea entidades: entity-resolve solo propone,
 * y las entidades nacen de una aprobacion en la cola. Ver docs/entities.md.
 *
 * Idempotente: la cola agrupa por nombre normalizado y `count` deduplica por
 * handle, asi que repetir el barrido reordena igual pero no infla los numeros.
 *
 * Uso:
 *   node entities-sweep.mjs                 # dry-run: lee y clasifica, no envia
 *   node entities-sweep.mjs --send          # envia a staging
 *   node entities-sweep.mjs --send --prod   # envia a produccion (con cuidado)
 *   node entities-sweep.mjs --summary       # solo el resumen de la cola actual
 *
 * Env:
 *   SHOPIFY_ADMIN_CLIENT_ID       Custom App houseonly-backorder
 *   SHOPIFY_ADMIN_CLIENT_SECRET
 *   STAGING_BS                    BOOTSTRAP_AUTH_SECRET de staging
 *   PROD_BS                       ...o el de produccion, con --prod
 */

const SHOP = 'house-only-2.myshopify.com';
const API = '2026-04';

const WORKERS = {
  staging: 'https://houseonly-worker-staging.emontagut.workers.dev',
  prod: 'https://houseonly-worker.emontagut.workers.dev',
};

const BATCH = 200;          // items por llamada a entity-resolve (el worker corta en 500)
const PAGE = 250;           // productos por pagina de Admin API

const args = new Set(process.argv.slice(2));
const SEND = args.has('--send');
const PROD = args.has('--prod');
const ONLY_SUMMARY = args.has('--summary');
const TARGET = PROD ? 'prod' : 'staging';
const WORKER = WORKERS[TARGET];
const BEARER = PROD ? process.env.PROD_BS : process.env.STAGING_BS;

function die(msg) { console.error(`\n✘ ${msg}\n`); process.exit(1); }

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
    // Shopify contesta este endpoint con una PAGINA HTML, no con JSON. Se saca
    // la frase que importa; el resto es markup. (Ver el incidente del 2026-09-07:
    // "application_cannot_be_found" enterrado en 8KB de CSS.)
    const text = await r.text();
    const plain = text.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const oauth = plain.match(/Oauth error [^.]*/i);
    die(`credenciales de Shopify rechazadas (${r.status}): ${(oauth ? oauth[0] : plain).slice(0, 200)}`);
  }
  return (await r.json()).access_token;
}

async function gql(token, query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) die(`Admin API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  if (j.errors) die(`Admin API GraphQL: ${JSON.stringify(j.errors).slice(0, 300)}`);
  return j.data;
}

const PRODUCTS_QUERY = `
  query sweep($cursor: String) {
    products(first: ${PAGE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { handle vendor tags }
    }
  }
`;

async function readCatalogue(token) {
  const out = [];
  let cursor = null;
  for (let page = 1; page <= 40; page++) {
    const d = await gql(token, PRODUCTS_QUERY, { cursor });
    out.push(...d.products.nodes);
    process.stdout.write(`\r  leidos ${out.length} productos…`);
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  process.stdout.write('\n');
  return out;
}

/**
 * Saca el valor del tag de sello. En el catalogo conviven TRES grafias del
 * prefijo —`label:X`, `Label: X` y `label: X`— y las tres son el mismo campo:
 * `Label: Aus Music` y `label:Aus Music` son el mismo sello escrito de dos
 * maneras. Se aceptan las tres a proposito.
 */
function labelOf(tags) {
  for (const t of tags || []) {
    const m = String(t).match(/^\s*label\s*:\s*(.+)$/i);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

// ── WORKER ──────────────────────────────────────────────────────────

async function post(action, body) {
  const r = await fetch(`${WORKER}/?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEARER}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) die(`${action} → ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { die(`${action} devolvio algo que no es JSON: ${text.slice(0, 200)}`); }
}

async function get(action, qs = '') {
  const r = await fetch(`${WORKER}/?action=${action}${qs}`, {
    headers: { Authorization: `Bearer ${BEARER}` },
  });
  const text = await r.text();
  if (!r.ok) die(`${action} → ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function sendAll(kind, items) {
  const summary = { resolved: 0, review: 0, ignored: 0 };
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const res = await post('entity-resolve', { kind, source: 'sweep', items: chunk });
    for (const k of Object.keys(summary)) summary[k] += res.summary?.[k] || 0;
    process.stdout.write(`\r  ${kind}: ${Math.min(i + BATCH, items.length)}/${items.length}…`);
  }
  process.stdout.write('\n');
  return summary;
}

// ── CLASIFICACION DE LA COLA ────────────────────────────────────────
//
// Los cubos salen de lo que hay de verdad en el catalogo, medido en la
// auditoria del 2026-09-10 sobre 910 vendors y 493 sellos. El orden importa:
// una fila cae en el PRIMER cubo que la reclama, asi que los cubos que exigen
// mas trabajo humano van antes.

const VA_RE = /^\s*(v\s*[/.]?\s*a\b|various|unknown)/i;

function classify(rec) {
  const raw = rec.raw || '';
  if (VA_RE.test(raw)) return 'va';                                  // V.A. / Unknown → a ignore:
  if (rec.proposal?.action === 'split') return 'multi';              // varios artistas en un campo
  if (/[\s,;.]$/.test(raw) || raw.length === 49 || raw.length === 50) return 'truncado';
  if (raw.includes('(')) return 'parentesis';
  if ((rec.candidates || []).some(c => c.why === 'prefix')) return 'subsello';
  return 'resto';
}

/**
 * Una fila es "trivial" si no pide ninguna decision: un solo nombre, sin
 * candidatos, y el display propuesto es identico al crudo (nada que limpiar).
 * NO se aprueban solas — el diseño lo prohibe expresamente — pero contarlas
 * dice cuanto se ahorraria si algun dia se decidiera lo contrario.
 */
function isTrivial(rec) {
  return rec.proposal?.action === 'create'
    && (rec.proposal.parts || []).length === 1
    && (rec.candidates || []).length === 0
    && rec.proposal.parts[0].display === rec.raw
    && !VA_RE.test(rec.raw || '');
}

const BUCKET_LABEL = {
  multi: 'multi-artista',
  truncado: 'truncado',
  parentesis: 'parentesis',
  va: 'V.A. / Unknown',
  subsello: 'sub-sello candidato',
  resto: 'resto',
};

async function printSummary(sendSummary) {
  console.log('\n════ RESUMEN ════\n');

  if (sendSummary) {
    console.log('Enviado a entity-resolve:');
    for (const [kind, s] of Object.entries(sendSummary)) {
      console.log(`  ${kind.padEnd(7)} resueltas ${String(s.resolved).padStart(5)}` +
        ` · a la cola ${String(s.review).padStart(5)} · ignoradas ${String(s.ignored).padStart(5)}`);
    }
    const created = Object.values(sendSummary).reduce((a, s) => a + s.resolved, 0);
    console.log(`\nEntidades creadas automaticamente: 0` +
      `\n  (${created} nombres resolvieron contra entidades YA aprobadas.` +
      `\n   entity-resolve nunca crea: propone, y una persona dispone.)`);
  }

  for (const kind of ['artist', 'label']) {
    const q = await get('entity-review-list', `&kind=${kind}&limit=500`);
    const recs = q.records || [];
    const buckets = {};
    let trivial = 0;
    for (const r of recs) {
      const b = classify(r);
      buckets[b] = (buckets[b] || 0) + 1;
      if (isTrivial(r)) trivial++;
    }

    console.log(`\n── ${kind === 'artist' ? 'ARTISTAS' : 'SELLOS'} · ${recs.length} filas en la cola ──`);
    for (const key of ['multi', 'truncado', 'parentesis', 'va', 'subsello', 'resto']) {
      if (!buckets[key]) continue;
      const pct = (100 * buckets[key] / recs.length).toFixed(1);
      console.log(`  ${String(buckets[key]).padStart(4)}  ${pct.padStart(5)}%  ${BUCKET_LABEL[key]}`);
    }
    console.log(`  ${String(trivial).padStart(4)}  ${(100 * trivial / (recs.length || 1)).toFixed(1).padStart(5)}%  ` +
      `de las cuales triviales (un nombre, sin candidatos, display ya limpio)`);
    if (q.truncated) console.log('  ⚠ la cola tiene mas filas de las que cabe listar de una vez');
  }

  // Top 20 global, que es lo que ordena el trabajo.
  const all = [];
  for (const kind of ['artist', 'label']) {
    const q = await get('entity-review-list', `&kind=${kind}&limit=500`);
    for (const r of q.records || []) all.push({ ...r, kind });
  }
  all.sort((a, b) => (b.count || 0) - (a.count || 0));

  console.log('\n── 20 filas mas frecuentes (productos afectados) ──');
  for (const r of all.slice(0, 20)) {
    const flag = r.countApprox ? '~' : ' ';
    console.log(`  ${flag}${String(r.count).padStart(4)}  ${r.kind === 'artist' ? 'A' : 'L'}  ` +
      `${(r.raw || '').slice(0, 52).padEnd(52)}  ${BUCKET_LABEL[classify(r)]}`);
  }
  console.log('');
}

// ── MAIN ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nentities-sweep → ${TARGET} (${WORKER})`);
  if (!SEND && !ONLY_SUMMARY) console.log('MODO DRY-RUN: no se envia nada. Usa --send para poblar la cola.\n');
  if ((SEND || ONLY_SUMMARY) && !BEARER) die(`falta ${PROD ? 'PROD_BS' : 'STAGING_BS'} en el entorno`);
  if (PROD && SEND) console.log('⚠ apuntando a PRODUCCION\n');

  if (ONLY_SUMMARY) { await printSummary(null); return; }

  const token = await adminToken();
  const products = await readCatalogue(token);

  const artists = [];
  const labels = [];
  for (const p of products) {
    const vendor = (p.vendor || '').trim();
    if (vendor) artists.push({ raw: vendor, context: { handle: p.handle } });
    const label = labelOf(p.tags);
    if (label) labels.push({ raw: label, context: { handle: p.handle } });
  }

  console.log(`\n  ${products.length} productos`);
  console.log(`  ${artists.length} vendors (${new Set(artists.map(a => a.raw)).size} distintos)`);
  console.log(`  ${labels.length} tags de sello (${new Set(labels.map(l => l.raw)).size} distintos)`);
  console.log(`  ${products.length - labels.length} productos SIN sello`);

  if (!SEND) {
    console.log('\nDry-run: nada enviado. Repite con --send.\n');
    return;
  }

  console.log('\nEnviando…');
  const sendSummary = {
    artist: await sendAll('artist', artists),
    label: await sendAll('label', labels),
  };
  await printSummary(sendSummary);
}

main().catch(e => die(e?.stack || String(e)));
