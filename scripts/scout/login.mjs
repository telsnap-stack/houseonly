#!/usr/bin/env node
/**
 * Abre el Chrome del vigía con su propio perfil para que Eduardo inicie sesión
 * a mano donde quiera. La ventana es suya: escribe él, y cuando cierra, la
 * sesión queda guardada en el perfil y el vigía la reutiliza el lunes.
 *
 * Aquí no hay contraseñas: este script no las pide, no las escribe y no las
 * guarda. Lo único que queda en el perfil son las cookies que deje el propio
 * navegador, igual que en cualquier Chrome.
 *
 *   node scripts/scout/login.mjs                 abre el perfil, en blanco
 *   node scripts/scout/login.mjs boomkat.com     abre el perfil en esa tienda
 */
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PERFIL = process.env.SCOUT_PROFILE || join(homedir(), '.houseonly-scout-perfil');
const destino = process.argv[2] ? (process.argv[2].startsWith('http') ? process.argv[2] : `https://${process.argv[2]}`) : 'about:blank';

console.log(`  perfil: ${PERFIL}`);
console.log('  inicia sesión donde quieras y CIERRA la ventana cuando termines.');
console.log('  para que el vigía lo use, añade a ~/.houseonly-scout.env:');
console.log(`      SCOUT_PROFILE=${PERFIL}`);

const ctx = await chromium.launchPersistentContext(PERFIL, {
  channel: 'chrome', headless: false, viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || await ctx.newPage();
if (destino !== 'about:blank') await page.goto(destino).catch(() => {});

// Se espera a que la cierre él. Nadie toca esta ventana mas que Eduardo.
await new Promise(r => ctx.on('close', r));
console.log('  ventana cerrada; la sesión queda guardada en el perfil.');
