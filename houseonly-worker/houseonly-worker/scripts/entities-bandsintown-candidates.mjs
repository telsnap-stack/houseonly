#!/usr/bin/env node
/**
 * entities-bandsintown-candidates.mjs — a que artista de Bandsintown
 * corresponde cada entidad, SIN fiarse del nombre.
 *
 * Fase 7D de docs/entities.md. Bandsintown es la unica fuente de fechas que se
 * puede enseñar dentro de la ficha (su widget). Para eso hace falta su id de
 * artista, y ahi esta el peligro de siempre: buscar "Harmony" o "Neroli" por
 * nombre devuelve a OTRO artista. En una muestra de 8, tres eran otro.
 *
 * La salida de esto: su ficha devuelve el `mbid` del artista. Si ese MBID es el
 * que una persona ya aprobo en la cola, es la misma persona y no hay que
 * adivinar. Si no coincide, no se propone. Nunca se propone por nombre.
 *
 * Lo propuesto entra en la cola de Links como un candidato mas
 * (`why: 'mbid'`), y de ahi no sale hasta que alguien lo aprueba.
 *
 * AVISO, y no es menor: esto llama a la API de Bandsintown, que segun sus
 * terminos pide consentimiento por escrito. El widget del navegador hace
 * exactamente estas mismas llamadas, pero eso no lo convierte en permiso. El
 * texto para pedirlo esta escrito en docs/fase7-solicitudes.md y **no se ha
 * enviado**. Mientras tanto: pocas llamadas, a 1/s, y solo cuando se pide.
 *
 * Uso:
 *   node entities-bandsintown-candidates.mjs                 # dry-run
 *   node entities-bandsintown-candidates.mjs --send --prod
 *   node entities-bandsintown-candidates.mjs --limit 20      # cuantas mirar
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
const LIMIT = num('--limit', 40);
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
  console.log(`\n▶ bandsintown-candidates · ${SEND ? `ENVIA a ${TARGET}` : `dry-run (lee de ${TARGET})`}\n`);

  const idx = (await (await fetch(`${WORKER}?action=entity-index`)).json()).entities || [];
  const porSlug = new Map(idx.map(e => [e.slug, e]));

  // Solo ARTISTAS con MBID aprobado y sin Bandsintown todavia: un sello no da
  // conciertos, y sin MBID no hay nada que verificar.
  const candidatos = [];
  for (const e of idx) {
    if (!e.roles.includes('artist')) continue;
    const ext = (await worker('external-get', { qs: `&slug=${encodeURIComponent(e.slug)}` })).external;
    if (!ext?.mbid || ext.bandsintown) continue;
    if ((ext.rejected?.bandsintown || []).length) continue;
    candidatos.push({ ...e, mbid: ext.mbid });
    if (candidatos.length >= LIMIT) break;
  }
  console.log(`  a mirar: ${candidatos.length} artistas con MBID y sin Bandsintown\n`);

  const items = [];
  let casan = 0, otros = 0, sinFicha = 0;
  for (const c of candidatos) {
    const d = await bit(encodeURIComponent(c.display));
    if (!d?.id) { sinFicha++; console.log(`  · ${c.display.padEnd(28).slice(0, 28)} no esta en Bandsintown`); continue; }
    if (d.mbid !== c.mbid) {
      otros++;
      console.log(`  ✗ ${c.display.padEnd(28).slice(0, 28)} es OTRO artista (mbid ${String(d.mbid).slice(0, 8)}…)`);
      continue;
    }
    casan++;
    console.log(`  ✓ ${c.display.padEnd(28).slice(0, 28)} id ${String(d.id).padEnd(9)} · ${d.upcoming_event_count || 0} fechas`);
    items.push({
      slug: c.slug, display: c.display, roles: c.roles, total: c.total, followed: false,
      candidates: [{
        mbid: c.mbid, mbKind: 'artist', name: d.name, why: 'mbid', discogs: [],
        urls: [{ url: `https://www.bandsintown.com/a/${d.id}`, from: 'mb' }],
        previews: [{ url: `https://www.bandsintown.com/a/${d.id}`, name: d.name, title: `${d.upcoming_event_count || 0} upcoming dates`, note: d.upcoming_event_count ? undefined : 'sin fechas ahora mismo' }],
      }],
      evidence: [], fetchedAt: Date.now(),
    });
  }

  console.log(`\n  MBID que coincide: ${casan} · otro artista con el mismo nombre: ${otros} · sin ficha: ${sinFicha}`);
  if (!SEND) { console.log('\n  dry-run: no se ha enviado nada. --send --prod para produccion.\n'); return; }

  let written = 0, dropped = 0, skipped = 0;
  for (let i = 0; i < items.length; i += 20) {
    const r = await worker('external-review-put', { method: 'POST', body: { items: items.slice(i, i + 20) } });
    written += r.written; dropped += r.dropped; skipped += r.skipped;
  }
  console.log(`\n  enviado: ${written} filas a la cola de Links · ${dropped} ya decididas · ${skipped} saltadas\n`);
}

main().catch(e => die(e.stack || e.message));
