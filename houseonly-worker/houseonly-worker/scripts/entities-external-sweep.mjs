#!/usr/bin/env node
/**
 * entities-external-sweep.mjs — candidatos de enlaces externos por entidad.
 *
 * Fase 7 de docs/entities.md. Llena la cola extreview:{slug} que se despacha en
 * la pestaña Entities → Links. NO aprueba nada: solo propone.
 *
 * Sobre que entidades: las indexables (≥ 3 discos en ?action=entity-index, el
 * mismo corte que MIN_DISCOS_INDEXABLE del prerender) y las que sigue algun
 * cliente (claves fanout:{slug}:{cid}). Ni una mas.
 *
 * De donde sale cada candidato, en orden de fiabilidad:
 *
 *   1. Discogs ID de un disco NUESTRO. Producto (metafield artist_slugs /
 *      label_slugs) → SKU → listing de Discogs (SYNC_STATE listing:{id}, via
 *      wrangler) → release publico → el artista/sello del release cuyo nombre
 *      casa con la entidad (se para en el primero que lo prueba; hasta 3) →
 *      MusicBrainz por URL de Discogs. Esto es lo que
 *      desambigua Pampa (DE) de Pampa (AR) sin mirar el nombre.
 *   2. Sin eso, busqueda por nombre en MusicBrainz, score ≥ 90 y nombre que
 *      normaliza igual. Siempre a revision fila a fila.
 *
 * Y de cada entidad de MusicBrainz: sus url-rels y, si enlaza a Wikidata, los
 * IDs de Mixcloud, SoundCloud, YouTube, RA, Songkick, Bandsintown y NTS de alli.
 * El MBID sale SOLO de MusicBrainz: el P434 de Wikidata de DJ Koze apunta a
 * "Stefan Kozalla", que es otra entidad de MB.
 *
 * Limites que se respetan:
 *   - MusicBrainz: 1 peticion/segundo por IP y User-Agent identificable.
 *   - Discogs sin token: 25/min (cabecera X-Discogs-Ratelimit). Se espera 2,5 s.
 *   - Wikidata: sin cupo publicado; se va a 1/s igualmente.
 * Todo se cachea en disco (7 dias) para que repetir no vuelva a pagar la espera.
 *
 * Uso:
 *   node entities-external-sweep.mjs                 # dry-run contra prod: busca, resume, no envia
 *   node entities-external-sweep.mjs --send          # envia a staging
 *   node entities-external-sweep.mjs --send --prod   # envia a produccion
 *   node entities-external-sweep.mjs --only omar-s,pampa   # solo esas entidades
 *   node entities-external-sweep.mjs --fresh         # ignora la cache de disco
 *
 * Los targets y las entidades se leen del MISMO worker al que se envia (staging
 * sin --prod). En dry-run se leen de prod, que es la fuente de verdad.
 *
 * Env:
 *   SHOPIFY_ADMIN_CLIENT_ID / SHOPIFY_ADMIN_CLIENT_SECRET
 *   PROD_BS      BOOTSTRAP_AUTH_SECRET de produccion
 *   STAGING_BS   ...el de staging, para --send sin --prod
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOP = 'house-only-2.myshopify.com';
const API = '2026-04';
const WORKERS = {
  staging: 'https://houseonly-worker-staging.emontagut.workers.dev',
  prod: 'https://houseonly-worker.emontagut.workers.dev',
};
const ENTITIES_ID = { prod: 'e1148360f4af4c72ad608e60c03e9813', staging: 'bf137c15dc6d4c4f8f21a9987108f2f2' };
const INDEXABLE_MIN = 3;
// SYNC_STATE de produccion: el unico sitio donde vive listing:{id} → sku.
const SYNC_STATE_ID = '5c5c0ee16cc34f68bd2109b01894f09d';
const DISCOGS_USER = 'houseonly';
const UA = 'HouseOnly-EntitySweep/1.0 ( https://houseonly.store )';
const CACHE_DIR = join(tmpdir(), 'houseonly-external-sweep');
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_RELEASES_PER_ENTITY = 3;
const SEND_BATCH = 20;

const argv = process.argv.slice(2);
const args = new Set(argv);
const SEND = args.has('--send');
const PROD = args.has('--prod');
const FRESH = args.has('--fresh');
const ONLY = (() => { const i = argv.indexOf('--only'); return i >= 0 ? new Set((argv[i + 1] || '').split(',').filter(Boolean)) : null; })();
const TARGET = SEND && !PROD ? 'staging' : 'prod';
const WORKER = WORKERS[TARGET];
const BEARER = TARGET === 'prod' ? process.env.PROD_BS : process.env.STAGING_BS;
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function die(msg) { console.error(`\n✘ ${msg}\n`); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Misma regla que normalizeName() en src/lib/entities.ts.
const norm = s => (s || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
// "Omar S (2)" en Discogs: el sufijo desambigua dentro de Discogs, no es nombre.
const discogsName = s => (s || '').replace(/\s*\(\d+\)\s*$/, '');
// Los sellos en MB suelen llevar "Records": "Pampa" casa con "Pampa Records".
const LABEL_TAIL = /(records|recordings|music|label|rec)$/;
const labelNorm = s => norm(s).replace(LABEL_TAIL, '');

// ── HTTP CON CACHE Y RITMO ──────────────────────────────────────────

mkdirSync(CACHE_DIR, { recursive: true });
const lastCall = {};

async function cachedJson(url, { host, gapMs, headers = {} }) {
  const file = join(CACHE_DIR, createHash('sha1').update(url).digest('hex') + '.json');
  if (!FRESH && existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, 'utf8'));
      if (Date.now() - c.at < CACHE_TTL_MS) return c.body;
    } catch { /* se vuelve a pedir */ }
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    const wait = (lastCall[host] || 0) + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall[host] = Date.now();
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
    if (r.status === 404) { writeFileSync(file, JSON.stringify({ at: Date.now(), body: null })); return null; }
    if (r.status === 429 || r.status === 503) { await sleep(gapMs * 4 * attempt); continue; }
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    const body = await r.json();
    writeFileSync(file, JSON.stringify({ at: Date.now(), body }));
    return body;
  }
  throw new Error(`rate limited: ${url}`);
}

const mb = path => cachedJson(`https://musicbrainz.org/ws/2/${path}${path.includes('?') ? '&' : '?'}fmt=json`, { host: 'mb', gapMs: 1100 });
const discogs = path => cachedJson(`https://api.discogs.com/${path}`, { host: 'discogs', gapMs: 2500 });
const wikidata = qs => cachedJson(`https://www.wikidata.org/w/api.php?${qs}&format=json`, { host: 'wd', gapMs: 1000 });

async function worker(action, { method = 'GET', body, qs = '', allow404 = false } = {}) {
  const r = await fetch(`${WORKER}?action=${action}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { die(`${action}: respuesta no JSON (${r.status}) — ¿worker sin desplegar?`); }
  if (r.status === 404 && allow404) return null;
  if (!r.ok) die(`${action}: ${r.status} ${text.slice(0, 200)}`);
  return j;
}

// ── SHOPIFY: SKU → SLUGS ────────────────────────────────────────────

async function adminToken() {
  const id = process.env.SHOPIFY_ADMIN_CLIENT_ID;
  const secret = process.env.SHOPIFY_ADMIN_CLIENT_SECRET;
  if (!id || !secret) die('faltan SHOPIFY_ADMIN_CLIENT_ID / SHOPIFY_ADMIN_CLIENT_SECRET');
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!r.ok) die(`credenciales de Shopify rechazadas (${r.status})`);
  return (await r.json()).access_token;
}

const PRODUCTS_QUERY = `
  query externalSweep($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        handle
        variants(first: 5) { nodes { sku } }
        artist: metafield(namespace: "houseonly", key: "artist_slugs") { value }
        label: metafield(namespace: "houseonly", key: "label_slugs") { value }
      }
    }
  }
`;

/** slug → [{sku, kind}] desde los metafields de la fase 4. */
async function skusBySlug() {
  const token = await adminToken();
  const out = new Map();
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
    });
    const j = await r.json();
    if (j.errors) die(`Admin API: ${JSON.stringify(j.errors).slice(0, 300)}`);
    for (const p of j.data.products.nodes) {
      const skus = p.variants.nodes.map(v => (v.sku || '').trim()).filter(Boolean);
      for (const [kind, mf] of [['artist', p.artist], ['label', p.label]]) {
        for (const slug of (mf?.value || '').split(',').map(s => s.trim()).filter(Boolean)) {
          const list = out.get(slug) || [];
          for (const sku of skus) list.push({ sku, kind });
          out.set(slug, list);
        }
      }
    }
    if (!j.data.products.pageInfo.hasNextPage) break;
    cursor = j.data.products.pageInfo.endCursor;
  }
  return out;
}

// ── DISCOGS: SKU → RELEASE ──────────────────────────────────────────

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], { cwd: WORKER_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** sku → release_id, cruzando listing:{id} (SYNC_STATE) con el inventario publico. */
async function releaseBySku() {
  const keys = JSON.parse(wrangler(['kv', 'key', 'list', `--namespace-id=${SYNC_STATE_ID}`, '--remote', '--prefix=listing:']))
    .map(k => k.name);
  const skuByListing = new Map();
  for (let i = 0; i < keys.length; i += 100) {
    const file = join(CACHE_DIR, 'listing-keys.json');
    writeFileSync(file, JSON.stringify(keys.slice(i, i + 100)));
    const out = wrangler(['kv', 'bulk', 'get', file, `--namespace-id=${SYNC_STATE_ID}`, '--remote']);
    const obj = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    for (const [k, v] of Object.entries(obj)) {
      try { const sku = JSON.parse(v)?.sku; if (sku) skuByListing.set(k.slice('listing:'.length), sku); } catch { /* valor raro */ }
    }
  }

  const releaseBySku = new Map();
  for (let page = 1; page <= 50; page++) {
    // El inventario cambia a diario: se pide sin cache de disco efectiva
    // (la clave lleva el dia).
    const d = await discogs(`users/${DISCOGS_USER}/inventory?per_page=100&page=${page}&_d=${new Date().toISOString().slice(0, 10)}`);
    for (const l of d?.listings || []) {
      const sku = skuByListing.get(String(l.id));
      if (sku && l.release?.id) releaseBySku.set(sku.toUpperCase(), l.release.id);
    }
    if (!d || page >= d.pagination.pages) break;
  }
  return { releaseBySku, listings: skuByListing.size };
}

/** Discogs IDs de la entidad segun sus propios discos. */
async function discogsEvidence(target, aliases, skus, releaseBySku) {
  const names = new Set([target.display, ...aliases].map(norm));
  const labelNames = new Set([target.display, ...aliases].map(labelNorm));
  const seen = new Set();
  const evidence = [];
  for (const { sku, kind } of skus) {
    const releaseId = releaseBySku.get(sku.toUpperCase());
    if (!releaseId || seen.has(releaseId)) continue;
    // Un release que ya lo prueba basta: cada release mas son 2,5 s de Discogs.
    if (evidence.length || seen.size >= MAX_RELEASES_PER_ENTITY) break;
    seen.add(releaseId);
    const rel = await discogs(`releases/${releaseId}`);
    if (!rel) continue;
    const pool = kind === 'artist' ? (rel.artists || []) : (rel.labels || []);
    for (const x of pool) {
      const n = discogsName(x.name);
      const hit = kind === 'artist'
        ? names.has(norm(n)) || (x.anv && names.has(norm(x.anv)))
        : labelNames.has(labelNorm(n));
      if (hit && x.id && !evidence.some(e => e.discogsId === String(x.id) && e.kind === kind)) {
        evidence.push({ kind, discogsId: String(x.id), name: x.name, releaseId, sku });
      }
    }
  }
  return evidence;
}

// ── MUSICBRAINZ + WIKIDATA ──────────────────────────────────────────

// Formatos de URL de Wikidata (P1630), comprobados el 2026-09-17.
const WD_PROPS = {
  P9509: v => `https://www.mixcloud.com/${v}/`,
  P3040: v => `https://soundcloud.com/${v}`,
  P2397: v => `https://www.youtube.com/channel/${v}`,
  P6600: v => `https://ra.co/dj/${v}`,
  P6601: v => `https://ra.co/labels/${v}`,
  P3478: v => `https://www.songkick.com/artists/${v}`,
  P7195: v => `https://www.bandsintown.com/a/${v}`,
  P7353: v => `https://www.nts.live/artists/${v}`,
};

async function wikidataUrls(qid) {
  const d = await wikidata(`action=wbgetentities&ids=${qid}&props=claims`);
  const claims = d?.entities?.[qid]?.claims || {};
  const urls = [];
  for (const [p, fmt] of Object.entries(WD_PROPS)) {
    for (const c of claims[p] || []) {
      const v = c.mainsnak?.datavalue?.value;
      if (typeof v === 'string' && c.rank !== 'deprecated') urls.push({ url: fmt(v), from: 'wikidata' });
    }
  }
  return urls;
}

/** Una entidad de MB → candidato con sus URLs (MB + Wikidata). */
async function mbCandidate(mbKind, mbid, why, score) {
  const e = await mb(`${mbKind}/${mbid}?inc=url-rels`);
  if (!e) return null;
  const rels = e.relations || [];
  const urls = rels.map(r => r.url?.resource).filter(Boolean).map(url => ({ url, from: 'mb' }));
  const discogsIds = rels.map(r => r.url?.resource || '').map(u => u.match(/discogs\.com\/(?:[a-z]{2}\/)?(?:artist|label)\/(\d+)/)?.[1]).filter(Boolean);
  const qid = rels.map(r => r.url?.resource || '').map(u => u.match(/wikidata\.org\/wiki\/(Q\d+)/)?.[1]).find(Boolean);
  if (qid) urls.push(...await wikidataUrls(qid));
  return {
    mbid: e.id, mbKind, name: e.name, disambiguation: e.disambiguation || undefined,
    country: e.country || undefined, score, why, discogs: [...new Set(discogsIds)],
    wikidata: qid, urls,
  };
}

async function candidatesFor(target, aliases, evidence) {
  const out = new Map();

  // 1. Por Discogs ID.
  for (const ev of evidence) {
    const rel = ev.kind === 'artist' ? 'artist-rels' : 'label-rels';
    const d = await mb(`url?resource=${encodeURIComponent(`https://www.discogs.com/${ev.kind}/${ev.discogsId}`)}&inc=${rel}`);
    for (const r of d?.relations || []) {
      const ent = r[ev.kind];
      if (ent?.id && !out.has(ent.id)) {
        const c = await mbCandidate(ev.kind, ent.id, 'discogs-id');
        if (c) out.set(c.mbid, c);
      }
    }
  }
  if (out.size) return [...out.values()];

  // 2. Por nombre, solo si no hubo ninguno por Discogs.
  const names = new Set([target.display, ...aliases].map(norm));
  const labelNames = new Set([target.display, ...aliases].map(labelNorm));
  for (const kind of target.roles) {
    const q = `${kind}:"${target.display.replace(/(["\\])/g, '\\$1')}"`;
    const d = await mb(`${kind}/?query=${encodeURIComponent(q)}&limit=5`);
    const hits = (d?.[kind === 'artist' ? 'artists' : 'labels'] || [])
      .filter(x => x.score >= 90)
      .filter(x => kind === 'artist'
        ? names.has(norm(x.name)) || (x.aliases || []).some(a => names.has(norm(a.name)))
        : labelNames.has(labelNorm(x.name)))
      .slice(0, 3);
    for (const h of hits) {
      if (out.has(h.id)) continue;
      const c = await mbCandidate(kind, h.id, 'name', h.score);
      if (c) out.set(c.mbid, c);
    }
  }
  return [...out.values()];
}

// ── TARGETS ─────────────────────────────────────────────────────────

async function loadTargets() {
  const r = await fetch(`${WORKER}?action=entity-index`);
  if (!r.ok) die(`entity-index: ${r.status}`);
  const idx = (await r.json()).entities || [];
  const keys = JSON.parse(wrangler(['kv', 'key', 'list', `--namespace-id=${ENTITIES_ID[TARGET]}`, '--remote', '--prefix=fanout:']));
  const followed = new Set(keys.map(k => k.name.split(':')[1]).filter(Boolean));

  const out = idx.filter(e => e.total >= INDEXABLE_MIN || followed.has(e.slug))
    .map(e => ({ ...e, followed: followed.has(e.slug) }));
  // Seguidas sin discos publicados hoy: siguen contando.
  for (const slug of followed) {
    if (out.some(e => e.slug === slug)) continue;
    const g = await worker('entity-get', { qs: `&slug=${encodeURIComponent(slug)}`, allow404: true });
    if (g?.entity?.status === 'active') out.push({ slug, display: g.entity.display, roles: g.entity.roles, total: 0, followed: true });
  }
  console.log(`  targets: ${out.length} (indexables ${out.filter(e => e.total >= INDEXABLE_MIN).length}, seguidas ${followed.size})`);
  return out;
}

// ── MAIN ────────────────────────────────────────────────────────────

async function main() {
  if (!BEARER) die(TARGET === 'prod' ? 'falta PROD_BS' : 'falta STAGING_BS');
  console.log(`\n▶ external-sweep · ${SEND ? `ENVIA a ${TARGET}` : `dry-run (lee de ${TARGET})`} · cache ${CACHE_DIR}\n`);

  let targets = await loadTargets();
  if (ONLY) targets = targets.filter(x => ONLY.has(x.slug));

  const [skuMap, { releaseBySku: relMap, listings }] = await Promise.all([skusBySlug(), releaseBySku()]);
  console.log(`  productos con slug: ${skuMap.size} slugs · listings con SKU: ${listings} · SKUs con release: ${relMap.size}`);

  const rows = [];
  let i = 0;
  for (const target of targets) {
    i++;
    const ent = await worker('entity-get', { qs: `&slug=${encodeURIComponent(target.slug)}` });
    const aliases = ent.entity?.aliases || [];
    const evidence = await discogsEvidence(target, aliases, skuMap.get(target.slug) || [], relMap);
    const candidates = await candidatesFor(target, aliases, evidence);
    const row = { slug: target.slug, display: target.display, roles: target.roles, total: target.total,
      followed: !!target.followed, candidates, evidence, fetchedAt: Date.now() };
    rows.push(row);
    const tag = !candidates.length ? '·' : candidates.every(c => c.why === 'discogs-id') ? 'D' : 'N';
    process.stdout.write(`\r  [${i}/${targets.length}] ${tag} ${target.display.slice(0, 40).padEnd(40)}`);
  }
  process.stdout.write('\n');

  const withCand = rows.filter(r => r.candidates.length);
  const byDiscogs = withCand.filter(r => r.candidates.length === 1 && r.candidates[0].why === 'discogs-id');
  const out = join(CACHE_DIR, `rows-${TARGET}-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(out, JSON.stringify(rows, null, 2));

  console.log(`\n  sin candidato:                      ${rows.length - withCand.length}`);
  console.log(`  un candidato por Discogs ID:        ${byDiscogs.length}  (confirmed si no hay conflictos)`);
  console.log(`  resto (nombre / varios):            ${withCand.length - byDiscogs.length}`);
  console.log(`  filas en ${out}`);

  if (!SEND) { console.log('\n  dry-run: no se ha enviado nada. --send para staging, --send --prod para produccion.\n'); return; }

  let written = 0, dropped = 0, skipped = 0;
  for (let k = 0; k < withCand.length; k += SEND_BATCH) {
    const r = await worker('external-review-put', { method: 'POST', body: { items: withCand.slice(k, k + SEND_BATCH) } });
    written += r.written; dropped += r.dropped; skipped += r.skipped;
  }
  const list = await worker('external-review-list');
  console.log(`\n  enviado: ${written} filas · ${dropped} ya decididas · ${skipped} saltadas`);
  console.log(`  cola en ${TARGET}: confirmed ${list.counts.confirmed} · review ${list.counts.review}\n`);
}

main().catch(e => die(e.stack || e.message));
