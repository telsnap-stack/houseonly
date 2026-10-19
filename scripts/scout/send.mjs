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
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR  = join(RAIZ, 'docs', 'scout');
const WORKER = process.env.SCOUT_WORKER || 'https://houseonly-worker.emontagut.workers.dev';
const to = process.env.SCOUT_TO || '';
const bearer = process.env.SCOUT_BEARER || '';

const ruta = process.argv[2] || join(DIR, readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().pop() || '');
const markdown = readFileSync(ruta, 'utf8');
const fecha = ruta.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '';

// Asunto y capturas los decide report.mjs, que sabe que salio en el informe:
// el asunto dice lo que hay ANTES de abrirlo, y una semana tranquila no
// deberia costar un clic.
let d = {};
try { d = JSON.parse(readFileSync(join(DIR, `diff-${fecha}.json`), 'utf8')); } catch { /* sin diff: asunto generico */ }
const subject = d.informe?.asunto || `Vigía de tiendas — ${fecha}`;

if (!to || !bearer) {
  console.log(`  NO SE MANDA (falta ${!to ? 'SCOUT_TO' : 'SCOUT_BEARER'}). Asunto habría sido: ${subject}`);
  process.exit(0);
}

// Las capturas de lo que sale en el informe van adjuntas, con tope: un correo
// de diez megas no lo abre nadie.
const TOPE_BYTES = 3_500_000;
const attachments = [];
let bytes = 0;
for (const shot of d.informe?.adjuntos || []) {
  try {
    const raw = readFileSync(shot);
    if (bytes + raw.length > TOPE_BYTES) continue;
    bytes += raw.length;
    attachments.push({ filename: basename(shot), content: raw.toString('base64') });
  } catch { /* la captura pudo no salir: el texto es lo que importa */ }
}

const r = await fetch(`${WORKER}/?action=scout-report`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ to, subject, markdown, attachments }),
});
const res = await r.json().catch(() => ({}));
if (!r.ok) { console.error(`  fallo al mandar (${r.status}): ${res.error || ''}`); process.exit(1); }
console.log(`  enviado a ${res.to} · ${subject}${attachments.length ? ` · ${attachments.length} captura(s)` : ''}`);
