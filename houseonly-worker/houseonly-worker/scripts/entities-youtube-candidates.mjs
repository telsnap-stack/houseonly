#!/usr/bin/env node
/**
 * entities-youtube-candidates.mjs — sets candidatos por busqueda en YouTube.
 *
 * Fase 7B de docs/entities.md. La busqueda es un GENERADOR DE CANDIDATOS, no
 * una fuente: lo que encuentra va a setreview:{slug} y **no se enseña en la
 * tienda hasta que alguien lo aprueba** en Entities → Links. Sin aprobar,
 * caduca solo a los 30 dias (TTL de la clave).
 *
 * Dos busquedas por entidad, las que de verdad devuelven sets:
 *   "{nombre} dj set"   y   "{nombre} boiler room"
 *
 * El cupo manda: `search.list` tiene su propio bote de **100 llamadas al dia**
 * (verificado en la documentacion de Google el 2026-09-17; ya no sale de las
 * 10.000 unidades). Dos por entidad = **50 entidades al dia como mucho**, y por
 * defecto se hacen menos. Se reparten por turnos: primero las entidades
 * SEGUIDAS por algun cliente, luego las indexables, y dentro de cada grupo las
 * que llevan mas tiempo sin mirarse (o no se han mirado nunca).
 *
 * Uso:
 *   node entities-youtube-candidates.mjs                  # dry-run: busca y enseña, no envia
 *   node entities-youtube-candidates.mjs --send --prod    # envia a produccion
 *   node entities-youtube-candidates.mjs --entities 10    # cuantas entidades (por defecto 25)
 *   node entities-youtube-candidates.mjs --only omar-s    # una concreta
 *
 * Env: YOUTUBE_API_KEY, PROD_BS (o STAGING_BS sin --prod).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKERS = {
  staging: 'https://houseonly-worker-staging.emontagut.workers.dev',
  prod: 'https://houseonly-worker.emontagut.workers.dev',
};
const ENTITIES_ID = { prod: 'e1148360f4af4c72ad608e60c03e9813', staging: 'bf137c15dc6d4c4f8f21a9987108f2f2' };
const INDEXABLE_MIN = 3;
// Tope duro del bote de search.list. Se para antes de pasarse, siempre.
const SEARCH_BUDGET = 100;
const QUERIES = ['dj set', 'boiler room'];
const RESULTS_PER_QUERY = 5;
const KEEP_PER_ENTITY = 6;
const CACHE_DIR = join(tmpdir(), 'houseonly-yt-candidates');
const CACHE_TTL_MS = 24 * 3600 * 1000;

const argv = process.argv.slice(2);
const args = new Set(argv);
const SEND = args.has('--send');
const PROD = args.has('--prod');
const num = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) || def : def; };
const ENTITIES = num('--entities', 25);
const ONLY = (() => { const i = argv.indexOf('--only'); return i >= 0 ? new Set((argv[i + 1] || '').split(',').filter(Boolean)) : null; })();
const TARGET = SEND && !PROD ? 'staging' : 'prod';
const WORKER = WORKERS[TARGET];
const BEARER = TARGET === 'prod' ? process.env.PROD_BS : process.env.STAGING_BS;
const KEY = process.env.YOUTUBE_API_KEY;
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function die(msg) { console.error(`\n✘ ${msg}\n`); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => (s || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');

mkdirSync(CACHE_DIR, { recursive: true });

async function cachedJson(url) {
  const file = join(CACHE_DIR, createHash('sha1').update(url).digest('hex') + '.json');
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, 'utf8'));
      if (Date.now() - c.at < CACHE_TTL_MS) return { ...c.body, _cached: true };
    } catch { /* se vuelve a pedir */ }
  }
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await r.json();
  if (body.error) die(`YouTube: ${body.error.message}`);
  writeFileSync(file, JSON.stringify({ at: Date.now(), body }));
  await sleep(200);
  return body;
}

async function worker(action, { method = 'GET', body, qs = '' } = {}) {
  const r = await fetch(`${WORKER}?action=${action}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { die(`${action}: respuesta no JSON (${r.status})`); }
  if (!r.ok) die(`${action}: ${r.status} ${text.slice(0, 200)}`);
  return j;
}

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], { cwd: WORKER_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** A quien le toca: seguidas primero, y dentro de cada grupo, las mas antiguas. */
async function porTurno() {
  const idx = (await (await fetch(`${WORKER}?action=entity-index`)).json()).entities || [];
  const keys = JSON.parse(wrangler(['kv', 'key', 'list', `--namespace-id=${ENTITIES_ID[TARGET]}`, '--remote', '--prefix=fanout:']));
  const followed = new Set(keys.map(k => k.name.split(':')[1]).filter(Boolean));

  // Cuando se miro por ultima vez cada una: lo dice su fila pendiente, si la
  // hay. Las que no tienen fila van primero, que es lo que se quiere.
  const pend = await worker('sets-review-list');
  const visto = new Map((pend.records || []).map(r => [r.slug, r.fetchedAt]));

  let targets = idx
    .filter(e => e.total >= INDEXABLE_MIN || followed.has(e.slug))
    .map(e => ({ ...e, followed: followed.has(e.slug), visto: visto.get(e.slug) || 0 }));
  if (ONLY) return targets.filter(t => ONLY.has(t.slug));

  targets.sort((a, b) => Number(b.followed) - Number(a.followed) || a.visto - b.visto || b.total - a.total);
  return targets;
}

/** Los resultados que de verdad hablan de esta entidad. */
function filtrar(items, target, query) {
  const n = norm(target.display);
  return items
    .filter(i => i.id?.videoId)
    // El titulo o el canal tienen que nombrarla. Sin esto, "Wax dj set" trae
    // media plataforma.
    .filter(i => norm(i.snippet.title).includes(n) || norm(i.snippet.channelTitle).includes(n))
    .map(i => ({
      url: `https://www.youtube.com/watch?v=${i.id.videoId}`,
      title: i.snippet.title,
      author: i.snippet.channelTitle,
      thumbnail: i.snippet.thumbnails?.medium?.url || i.snippet.thumbnails?.default?.url,
      publishedAt: i.snippet.publishedAt,
      query,
    }));
}

async function main() {
  if (!KEY) die('falta YOUTUBE_API_KEY (vive en ~/.houseonly-secrets)');
  if (!BEARER) die(TARGET === 'prod' ? 'falta PROD_BS' : 'falta STAGING_BS');

  const todas = await porTurno();
  const cuantas = ONLY ? todas.length : Math.min(ENTITIES, Math.floor(SEARCH_BUDGET / QUERIES.length));
  const turno = todas.slice(0, cuantas);
  console.log(`\n▶ youtube-candidates · ${SEND ? `ENVIA a ${TARGET}` : `dry-run (lee de ${TARGET})`}`);
  console.log(`  ${turno.length} entidades × ${QUERIES.length} busquedas = ${turno.length * QUERIES.length} de las ${SEARCH_BUDGET} del dia\n`);

  const items = [];
  let usadas = 0;
  for (const t of turno) {
    const encontrados = new Map();
    for (const q of QUERIES) {
      if (usadas >= SEARCH_BUDGET) break;
      const query = `${t.display} ${q}`;
      const d = await cachedJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${RESULTS_PER_QUERY}`
        + `&q=${encodeURIComponent(query)}&key=${KEY}`);
      if (!d._cached) usadas++;
      for (const c of filtrar(d.items || [], t, query)) if (!encontrados.has(c.url)) encontrados.set(c.url, c);
    }
    const candidates = [...encontrados.values()].slice(0, KEEP_PER_ENTITY);
    console.log(`  ${t.followed ? '★' : ' '} ${t.display.padEnd(34).slice(0, 34)} ${candidates.length} candidatos`);
    for (const c of candidates) console.log(`      ${c.publishedAt.slice(0, 10)} · ${c.author} · ${c.title.slice(0, 60)}`);
    if (candidates.length) items.push({ slug: t.slug, candidates });
  }

  console.log(`\n  busquedas gastadas: ${usadas} · entidades con candidatos: ${items.length}`);
  if (!SEND) { console.log('\n  dry-run: no se ha enviado nada. --send --prod para produccion.\n'); return; }

  let written = 0, dropped = 0, skipped = 0;
  for (let i = 0; i < items.length; i += 20) {
    const r = await worker('sets-review-put', { method: 'POST', body: { items: items.slice(i, i + 20) } });
    written += r.written; dropped += r.dropped; skipped += r.skipped;
  }
  const list = await worker('sets-review-list');
  console.log(`\n  enviado: ${written} filas · ${dropped} ya decididas · ${skipped} saltadas`);
  console.log(`  cola de sets en ${TARGET}: ${list.records.length} entidades · ${list.candidates} candidatos\n`);
}

main().catch(e => die(e.stack || e.message));
