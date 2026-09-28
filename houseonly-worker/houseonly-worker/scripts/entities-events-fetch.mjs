#!/usr/bin/env node
/**
 * entities-events-fetch.mjs — las fechas de concierto, para pintarlas nosotros.
 *
 * Fase 7E de docs/entities.md. Decision de Eduardo (18-09): **nada de widgets**.
 * Esto trae de Bandsintown lo minimo que se enseña —fecha, ciudad, pais, sala—
 * y lo deja en events:{slug}; la tienda lo pinta con su propio aspecto.
 *
 * Solo entidades con el id de Bandsintown **aprobado en la cola de Links**, que
 * es el que se verifico contra el MBID. Nada de buscar por nombre: de 77
 * artistas, 35 tenian un homonimo en Bandsintown.
 *
 * AVISO: esto es la API de Bandsintown, y sus terminos piden consentimiento por
 * escrito. Su widget hace estas mismas llamadas desde el navegador, pero eso no
 * es permiso. El texto para pedirlo esta en docs/fase7-solicitudes.md y sigue
 * sin enviarse. Mientras tanto: a mano, 1 peticion/segundo, y solo esto.
 *
 * Uso:
 *   node entities-events-fetch.mjs                # dry-run
 *   node entities-events-fetch.mjs --send --prod
 *   node entities-events-fetch.mjs --only jeff-mills,theo-parrish
 *
 * Env: PROD_BS (o STAGING_BS sin --prod).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKERS = {
  staging: 'https://houseonly-worker-staging.emontagut.workers.dev',
  prod: 'https://houseonly-worker.emontagut.workers.dev',
};
// El widget deriva su app_id del dominio; se usa el nuestro, que es de donde
// saldrian las llamadas de verdad.
const APP_ID = 'js_houseonly.store';
const REFERER = 'https://houseonly.store/';
const CACHE_DIR = join(tmpdir(), 'houseonly-bit');
const CACHE_TTL_MS = 24 * 3600 * 1000;

const argv = process.argv.slice(2);
const args = new Set(argv);
const SEND = args.has('--send');
const PROD = args.has('--prod');
const num = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) || d : d; };
const LIMIT = num("--limit", 200);
const ONLY = (() => { const i = argv.indexOf('--only'); return i >= 0 ? new Set((argv[i + 1] || '').split(',').filter(Boolean)) : null; })();
const TARGET = SEND && !PROD ? 'staging' : 'prod';
const WORKER = WORKERS[TARGET];
const BEARER = TARGET === 'prod' ? process.env.PROD_BS : process.env.STAGING_BS;

function die(m) { console.error(`\n✘ ${m}\n`); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(CACHE_DIR, { recursive: true });

async function bit(path) {
  const url = `https://rest.bandsintown.com/V3.1/artists/${path}?app_id=${APP_ID}`;
  const file = join(CACHE_DIR, createHash('sha1').update(url).digest('hex') + '.json');
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, 'utf8'));
      if (Date.now() - c.at < CACHE_TTL_MS) return c.body;
    } catch { /* se vuelve a pedir */ }
  }
  await sleep(1000);   // 1/s: son pocas y son suyas
  const r = await fetch(url, { headers: { 'User-Agent': 'HouseOnly/1.0 (https://houseonly.store)', Referer: REFERER, Accept: 'application/json' } });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  writeFileSync(file, JSON.stringify({ at: Date.now(), body }));
  return body;
}

async function worker(action, { method = 'GET', body, qs = '' } = {}) {
  const r = await fetch(`${WORKER}?action=${action}${qs}`, {
    method, headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { die(`${action}: respuesta no JSON (${r.status})`); }
  if (!r.ok) die(`${action}: ${r.status} ${t.slice(0, 200)}`);
  return j;
}

async function main() {
  if (!BEARER) die(TARGET === 'prod' ? 'falta PROD_BS' : 'falta STAGING_BS');
  console.log(`\n▶ events-fetch · ${SEND ? `ESCRIBE en ${TARGET}` : `dry-run (lee de ${TARGET})`}\n`);

  const idx = (await (await fetch(`${WORKER}?action=entity-index`)).json()).entities || [];
  const conBit = [];
  for (const e of idx) {
    if (ONLY && !ONLY.has(e.slug)) continue;
    if (!e.roles.includes('artist')) continue;       // un sello no da conciertos
    const ext = (await worker('external-get', { qs: `&slug=${encodeURIComponent(e.slug)}` })).external;
    if (ext?.bandsintown) conBit.push({ ...e, bit: ext.bandsintown });
    if (conBit.length >= LIMIT) break;
  }
  console.log(`  con Bandsintown aprobado: ${conBit.length}\n`);

  const items = [];
  let total = 0;
  for (const e of conBit) {
    const d = await bit(`id_${e.bit}/events/`);
    const eventos = (Array.isArray(d) ? d : []).map(x => ({
      id: String(x.id),
      date: x.starts_at || x.datetime,
      city: x.venue?.city,
      region: x.venue?.region || undefined,
      country: x.venue?.country || undefined,
      venue: x.venue?.name || undefined,
      url: (x.url || '').split('?')[0] || undefined,
      tickets: (x.offers || []).find(o => o.type === 'Tickets' && o.status === 'available')?.url,
      festival: !!x.festival_start_date,
    })).filter(x => x.date && x.city);
    total += eventos.length;
    console.log(`  ${e.display.padEnd(26).slice(0, 26)} ${String(eventos.length).padStart(2)} fechas`
      + (eventos.length ? ` · ${eventos.slice(0, 3).map(x => `${x.date.slice(0, 10)} ${x.city}`).join(' · ')}` : ''));
    items.push({ slug: e.slug, events: eventos });
  }

  console.log(`\n  ${items.length} artistas · ${total} fechas`);
  if (!SEND) { console.log('\n  dry-run: no se ha escrito nada. --send --prod para produccion.\n'); return; }

  let written = 0, guardadas = 0;
  for (let i = 0; i < items.length; i += 20) {
    const r = await worker('events-put', { method: 'POST', body: { items: items.slice(i, i + 20) } });
    written += r.written; guardadas += r.events;
  }
  console.log(`\n  escrito: ${written} artistas · ${guardadas} fechas\n`);
}

main().catch(e => die(e.stack || e.message));
