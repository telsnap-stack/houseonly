#!/usr/bin/env node
/**
 * Manda el informe del vigia por correo. El worker pone la clave de Resend y el
 * maquetado; aqui solo va el texto.
 *
 *   SCOUT_TO=alguien@dominio SCOUT_BEARER=… node scripts/scout/send.mjs [informe.md]
 *
 * Sin SCOUT_BEARER no manda nada y lo dice: un informe que no sale es un aviso,
 * no un fallo silencioso.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR  = join(RAIZ, 'docs', 'scout');
const WORKER = process.env.SCOUT_WORKER || 'https://houseonly-worker.emontagut.workers.dev';
const to = process.env.SCOUT_TO || '';
const bearer = process.env.SCOUT_BEARER || '';

const ruta = process.argv[2] || join(DIR, readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().pop() || '');
const markdown = readFileSync(ruta, 'utf8');
const fecha = ruta.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '';

// El asunto dice lo que hay ANTES de abrirlo: una semana tranquila no deberia
// costar un clic.
const tiendas = [...markdown.matchAll(/^## (?!Huella|Sin cambios|No se dejaron)(.+)$/gm)].map(m => m[1].trim());
const subject = tiendas.length
  ? `Vigía de tiendas · ${tiendas.slice(0, 3).join(', ')}${tiendas.length > 3 ? ` y ${tiendas.length - 3} más` : ''} — ${fecha}`
  : `Vigía de tiendas · semana tranquila — ${fecha}`;

if (!to || !bearer) {
  console.log(`  NO SE MANDA (falta ${!to ? 'SCOUT_TO' : 'SCOUT_BEARER'}). Asunto habría sido: ${subject}`);
  process.exit(0);
}

const r = await fetch(`${WORKER}/?action=scout-report`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ to, subject, markdown }),
});
const d = await r.json().catch(() => ({}));
if (!r.ok) { console.error(`  fallo al mandar (${r.status}): ${d.error || ''}`); process.exit(1); }
console.log(`  enviado a ${d.to} · ${subject}`);
