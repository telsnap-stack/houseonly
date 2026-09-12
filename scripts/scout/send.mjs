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

// Las capturas de lo que cambio van adjuntas: el informe dice "control nuevo:
// notify me" y la imagen enseña donde esta y como lo han puesto. Solo las de las
// tiendas que cambiaron, y con tope: un correo de diez megas no lo abre nadie.
const TOPE_ADJUNTOS = 4, TOPE_BYTES = 3_500_000;
const attachments = [];
try {
  const diffs = readdirSync(DIR).filter(f => f === `diff-${fecha}.json`);
  if (diffs.length) {
    const d = JSON.parse(readFileSync(join(DIR, diffs[0]), 'utf8'));
    let bytes = 0;
    for (const t of d.tiendas) {
      if (t.primeraVez) continue;
      for (const c of t.cambios) {
        if (!c.shot || attachments.length >= TOPE_ADJUNTOS) continue;
        try {
          const raw = readFileSync(c.shot);
          if (bytes + raw.length > TOPE_BYTES) continue;
          bytes += raw.length;
          attachments.push({ filename: `${t.key}-${c.pagina}.jpg`, content: raw.toString('base64') });
        } catch { /* la captura pudo no salir */ }
      }
    }
  }
} catch { /* sin adjuntos se manda igual: el texto es lo que importa */ }

const r = await fetch(`${WORKER}/?action=scout-report`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ to, subject, markdown, attachments }),
});
const d = await r.json().catch(() => ({}));
if (!r.ok) { console.error(`  fallo al mandar (${r.status}): ${d.error || ''}`); process.exit(1); }
console.log(`  enviado a ${d.to} · ${subject}${attachments.length ? ` · ${attachments.length} captura(s)` : ''}`);
