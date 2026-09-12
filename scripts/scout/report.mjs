#!/usr/bin/env node
/**
 * Convierte el diff crudo de scout.mjs en un informe legible.
 *
 * El juicio —esto merece la pena, esto es una app de Shopify, esto no encaja—
 * lo pone el agente que lee esto los lunes. Aqui solo se ordena lo que cambio y
 * se marca lo que suele significar algo:
 *
 *   un script de terceros nuevo casi siempre ES una funcion nueva
 *   un control nuevo puede ser una funcion o un cambio de copy
 *   una tienda que no se deja ver es un dato, no un fallo que ocultar
 *
 *   node scripts/scout/report.mjs [docs/scout/diff-YYYY-MM-DD.json]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR  = join(RAIZ, 'docs', 'scout');

const arg = process.argv[2];
const ruta = arg || join(DIR, readdirSync(DIR).filter(f => /^diff-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop() || '');
const d = JSON.parse(readFileSync(ruta, 'utf8'));

/** Terceros que se reconocen de vista: saber que hacen ahorra media hora. */
const CONOCIDOS = {
  'klaviyo.com': 'correo y avisos de vuelta a stock',
  'judge.me': 'reseñas de producto',
  'yotpo.com': 'reseñas y fidelizacion',
  'swymrelay.com': 'wishlist y back-in-stock',
  'rebuyengine.com': 'recomendaciones y cross-sell',
  'gorgias.chat': 'soporte por chat',
  'attn.tv': 'SMS',
  'okendo.io': 'reseñas',
  'loox.io': 'reseñas con foto',
  'searchanise.com': 'buscador con facetas',
  'algolia.net': 'buscador',
  'findify.io': 'buscador',
  'bold-apps.com': 'suscripciones',
  'recharge.com': 'suscripciones',
  'shopifycdn.com': 'Shopify',
  'consentmanager.net': 'muro de cookies',
  'googletagmanager.com': 'analitica',
  'google-analytics.com': 'analitica',
};
const queEs = host => {
  for (const [k, v] of Object.entries(CONOCIDOS)) if (host.endsWith(k)) return v;
  return '';
};

const L = [];
L.push(`# Vigía de tiendas — ${d.fecha}`);
L.push('');
L.push('Lo que cambió en la **interfaz** de las tiendas vigiladas desde la semana');
L.push('pasada. No es el catálogo: son botones, filtros, formularios y scripts de');
L.push('terceros, que es donde se ve una función nueva.');
L.push('');

const conCambios = d.tiendas.filter(t => t.cambios.length && !t.primeraVez);
const primeras  = d.tiendas.filter(t => t.primeraVez);
const mudas     = d.tiendas.filter(t => !t.cambios.length && !t.primeraVez);
const rotas     = d.tiendas.filter(t => t.errores.length);

if (!conCambios.length && !primeras.length) {
  L.push('**Semana tranquila: ninguna tienda cambió nada visible.**');
  L.push('');
}

/**
 * El informe no sirve de nada si leerlo no lleva a ninguna parte. Cada tienda
 * que cambió algo se lleva un prompt listo para pegar: dice QUE se vio, DONDE
 * se vio, y pide lo mismo siempre —juicio primero, implementacion despues y
 * solo en staging—, que es como se ha trabajado aqui todo el tiempo.
 */
function prompt(t) {
  const lineas = [];
  for (const c of t.cambios) {
    const trozos = [];
    if (c.scriptsNuevos?.length) trozos.push(`servicios nuevos: ${c.scriptsNuevos.join(', ')}`);
    if (c.controlsNuevos?.length) trozos.push(`controles nuevos: ${c.controlsNuevos.slice(0, 12).join(', ')}`);
    if (c.formsNuevos?.length) trozos.push(`formularios nuevos: ${c.formsNuevos.slice(0, 4).join(' ; ')}`);
    if (c.signalsNuevas?.length) trozos.push(`señales nuevas: ${c.signalsNuevas.join(', ')}`);
    if (trozos.length) lineas.push(`- ${c.pagina} (${c.url}): ${trozos.join(' · ')}`);
  }
  return [
    `${t.name} cambió esto esta semana:`,
    ...lineas,
    '',
    'Míralo en la web y dime: qué función es de verdad cada cosa, si es código o una',
    'app de terceros que habría que contratar, si encaja con House Only y qué',
    'costaría. Ordena de más a menos interesante y recomienda una sola. Nada de',
    'copiar diseño, textos ni imágenes: ideas.',
  ].join('\n');
}

function promptImplementar(t) {
  return [
    `Implementa en staging la función que acordamos de ${t.name}.`,
    'Reglas de siempre: rama propia sobre staging con baseline fresco, tests que',
    'fallen sin el cambio, diff --stat antes de push, solo los tokens de color y',
    'tipografía que ya define App.jsx, y nada de tocar producción. Cuando esté',
    'desplegado en el preview, avísame con qué mirar y dónde.',
  ].join('\n');
}

for (const t of conCambios) {
  L.push(`## ${t.name}`);
  L.push('');
  for (const c of t.cambios) {
    if (c.nuevaPagina) { L.push(`- **${c.pagina}** — primera vez que se mira: ${c.url}`); continue; }
    const bloques = [];
    if (c.scriptsNuevos?.length) {
      bloques.push(`  - **servicios nuevos**: ${c.scriptsNuevos.map(h => queEs(h) ? `\`${h}\` (${queEs(h)})` : `\`${h}\``).join(', ')}`);
    }
    if (c.controlsNuevos?.length) bloques.push(`  - controles nuevos: ${c.controlsNuevos.map(x => `\`${x}\``).join(', ')}`);
    if (c.formsNuevos?.length)    bloques.push(`  - formularios nuevos: ${c.formsNuevos.map(x => `\`${x}\``).join(', ')}`);
    if (c.signalsNuevas?.length)  bloques.push(`  - señales nuevas: ${c.signalsNuevas.join(', ')}`);
    if (c.scriptsIdos?.length)    bloques.push(`  - servicios retirados: ${c.scriptsIdos.map(x => `\`${x}\``).join(', ')}`);
    if (c.controlsIdos?.length)   bloques.push(`  - controles que ya no están: ${c.controlsIdos.map(x => `\`${x}\``).join(', ')}`);
    if (!bloques.length) continue;
    L.push(`- **${c.pagina}** (${c.url})`);
    L.push(...bloques);
    if (c.shot) bloques.push(`  - captura: \`${c.shot.replace(/^.*\/docs\//, 'docs/')}\` (adjunta al correo)`);
  }
  L.push('');
  L.push('**Para hablarlo con Claude** — pégale esto:');
  L.push('');
  L.push('```');
  L.push(prompt(t));
  L.push('```');
  L.push('');
  L.push('Y cuando decidas cuál:');
  L.push('');
  L.push('```');
  L.push(promptImplementar(t));
  L.push('```');
  L.push('');
}

if (primeras.length) {
  L.push('## Huella tomada por primera vez');
  L.push('');
  L.push('Sin semana anterior con la que comparar; a partir del próximo lunes sí.');
  L.push('');
  for (const t of primeras) L.push(`- ${t.name} — ${t.paginas} página(s)`);
  L.push('');
}

if (mudas.length) {
  L.push(`## Sin cambios`);
  L.push('');
  L.push(mudas.map(t => t.name).join(' · '));
  L.push('');
}

if (rotas.length) {
  L.push('## No se dejaron ver');
  L.push('');
  for (const t of rotas) L.push(`- **${t.name}** — ${t.errores.join('; ')}`);
  L.push('');
  L.push('Una tienda que no se deja ver no es un fallo que ocultar: si se repite');
  L.push('varias semanas, o se arregla la URL en `sites.json` o se quita de la lista.');
  L.push('');
}

L.push('---');
L.push('');
L.push('**Si prefieres empezar por lo general**, este prompt sirve cualquier semana:');
L.push('');
L.push('```');
L.push([
  'Lee el último informe del vigía en docs/scout/ y el estado de House Only en',
  'docs/entities.md y CLAUDE.md. Dime qué de lo que hicieron esta semana las otras',
  'tiendas nos falta de verdad —no lo que es bonito, lo que le resolvería algo a un',
  'cliente nuestro—, con una recomendación única y su coste. Si no hay nada que',
  'merezca la pena, dilo y ya está.',
].join('\n'));
L.push('```');
L.push('');
L.push('**Cómo se lee esto**: un servicio de terceros nuevo casi siempre es una');
L.push('función nueva y dice cuál. Un control nuevo puede ser una función o un');
L.push('simple cambio de texto. De aquí salen **ideas**: nunca CSS, imágenes ni');
L.push('textos de nadie.');

const salida = join(DIR, `${d.fecha}.md`);
writeFileSync(salida, L.join('\n') + '\n');
console.log(`  informe en ${salida}`);
