#!/usr/bin/env node
/**
 * scout — el vigia semanal de tiendas de discos.
 *
 * Visita las tiendas de sites.json, saca de cada pagina una huella de su
 * INTERFAZ —no de su contenido— y la compara con la de la semana pasada. Lo que
 * cambia de una semana a otra en el catalogo (discos, precios, stock) no dice
 * nada; lo que dice algo es que aparezca un boton nuevo, un filtro nuevo o un
 * script de terceros nuevo, porque eso es una funcion que alguien ha montado.
 *
 * La huella son tres cosas:
 *   controls     textos de botones, etiquetas, filtros y selects, normalizados
 *   scriptHosts  dominios de los <script> de terceros — el mejor chivato: un
 *                cdn.judge.me es resenas, un klaviyo es avisos de stock
 *   signals      presencia de reproductores, wishlist, pre-order, chat…
 *
 * Solo paginas publicas, una tienda cada vez y con pausas: esto no es un
 * crawler. Respeta robots.txt. No copia diseno, ni textos, ni imagenes: de aqui
 * salen ideas, y las ideas no tienen dueno.
 *
 *   node scripts/scout/scout.mjs                 todas las tiendas
 *   node scripts/scout/scout.mjs --only=hhv      una
 *   node scripts/scout/scout.mjs --no-save       sin escribir la huella nueva
 */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI  = dirname(fileURLToPath(import.meta.url));
const RAIZ  = join(AQUI, '..', '..');
const SNAPS = join(RAIZ, 'docs', 'scout', 'snapshots');

const args     = process.argv.slice(2);
const soloUna  = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';
const guardar  = !args.includes('--no-save');
const PAUSA_MS = 2500;   // entre pagina y pagina: cortesia, no sigilo
const ESPERA   = 30000;

const dormir = ms => new Promise(r => setTimeout(r, ms));

// ── ROBOTS ──────────────────────────────────────────────────────────
// Lectura simple y estricta: ante la duda, no se entra.
async function robots(base) {
  try {
    const u = new URL('/robots.txt', base);
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return [];
    const txt = await r.text();
    const reglas = [];
    let aplica = false;
    for (const linea of txt.split('\n')) {
      const l = linea.split('#')[0].trim();
      const m = l.match(/^(user-agent|disallow)\s*:\s*(.*)$/i);
      if (!m) continue;
      if (m[1].toLowerCase() === 'user-agent') aplica = m[2].trim() === '*';
      else if (aplica && m[2].trim()) reglas.push(m[2].trim());
    }
    return reglas;
  } catch { return []; }
}
const prohibido = (reglas, url) => {
  const ruta = new URL(url).pathname;
  return reglas.some(r => ruta.startsWith(r));
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// ── LA HUELLA ───────────────────────────────────────────────────────
// Se ejecuta dentro de la pagina. Todo lo que huela a contenido —nombres de
// discos, precios, catalogos— se descarta: cambia cada semana y no es una
// funcion.
const HUELLA = () => {
  const limpia = s => String(s || '').replace(/\s+/g, ' ').trim();
  const esContenido = t =>
    !t || t.length > 38 || (t.match(/\d/g) || []).length >= 3 ||
    /^[€$£]/.test(t) || /\b(19|20)\d{2}\b/.test(t);

  // "cantiga de longe play" es el boton de reproducir de un disco concreto: la
  // funcion es "play" y el resto es catalogo, que cambia cada semana. Se recorta
  // al verbo para que la huella no se llene de ruido.
  const ACCION_FINAL = /(add to (cart|basket|bag)|play|listen|preview|buy( now)?|pre-?order|wishlist|notify me|download)$/;
  const controls = new Set();
  const anota = t => {
    let n = limpia(t).toLowerCase();
    const m = n.match(ACCION_FINAL);
    if (m && n !== m[0] && n.split(' ').length > 1) n = m[0];
    if (!esContenido(n)) controls.add(n);
  };

  document.querySelectorAll('button, [role="button"], summary, label, legend, fieldset > legend')
    .forEach(el => anota(el.textContent));
  document.querySelectorAll('input[type="submit"], input[type="button"]').forEach(el => anota(el.value));
  document.querySelectorAll('[aria-label]').forEach(el => anota(el.getAttribute('aria-label')));
  document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(el => anota(el.getAttribute('placeholder')));
  // Filtros y ordenaciones: donde mejor se ve lo que una tienda cree que
  // importa de un disco.
  document.querySelectorAll('select').forEach(sel => {
    anota(sel.getAttribute('name') || sel.id);
    [...sel.options].slice(0, 12).forEach(o => anota(o.textContent));
  });
  document.querySelectorAll('[class*="filter" i] a, [class*="facet" i] a, [id*="filter" i] a')
    .forEach(el => anota(el.textContent));
  // No todas las tiendas usan <button>. Muchas ponen un <a> con clase de boton,
  // y ahi es donde vive "add to cart" o "notify me".
  document.querySelectorAll('[class*="btn" i], [class*="button" i], [class*="action" i]')
    .forEach(el => anota(el.textContent));
  document.querySelectorAll('a[href]').forEach(a => {
    const pista = `${a.getAttribute('href') || ''} ${a.className || ''}`;
    if (/cart|basket|warenkorb|wish|merk|notify|alert|pre-?order|account|login|compare/i.test(pista)) {
      anota(a.textContent || a.getAttribute('title'));
    }
  });

  // Lo que la tienda es capaz de RECIBIR: un form a /wishlist/add dice mas que
  // cualquier texto, y no depende del idioma ni del tema.
  const forms = new Set();
  document.querySelectorAll('form').forEach(f => {
    const accion = (f.getAttribute('action') || '').split('?')[0].replace(/^https?:\/\/[^/]+/, '');
    const campos = [...f.querySelectorAll('input[name], select[name]')]
      .map(i => i.name).filter(n => n && n.length < 24).slice(0, 6).sort();
    if (accion || campos.length) forms.add(`${accion || '(misma pagina)'} [${campos.join(',')}]`.slice(0, 90));
  });

  const scriptHosts = new Set();
  document.querySelectorAll('script[src]').forEach(s => {
    try {
      const h = new URL(s.src, location.href).host;
      if (h && h !== location.host) scriptHosts.add(h.replace(/^www\./, ''));
    } catch { /* src raro */ }
  });

  const hay = sel => !!document.querySelector(sel);
  const texto = document.body.innerText.toLowerCase();
  const signals = {
    audio:        hay('audio') || hay('[class*="player" i]') || hay('[class*="waveform" i]'),
    embedSonido:  hay('iframe[src*="soundcloud"], iframe[src*="bandcamp"], iframe[src*="youtube"], iframe[src*="spotify"]'),
    wishlist:     /wishlist|favourite|favorite|watchlist/.test(texto),
    preorder:     /pre-?order/.test(texto),
    backorder:    /back-?order|request a copy|notify me|back in stock/.test(texto),
    suscripcion:  /subscription|record club|membership/.test(texto),
    chat:         hay('[class*="chat" i], [id*="chat" i]'),
    resenas:      /review|rating/.test(texto),
    listas:       /staff pick|editor|curated|chart/.test(texto),
    newsletter:   hay('input[type="email"]'),
  };

  return {
    title: limpia(document.title).slice(0, 120),
    controls: [...controls].sort(),
    forms: [...forms].sort(),
    scriptHosts: [...scriptHosts].sort(),
    signals,
  };
};

// ── RECORRIDO ───────────────────────────────────────────────────────
/**
 * El muro de cookies tapa la interfaz, que es justo lo que se viene a mirar.
 * Se pulsa RECHAZAR —lo no esencial— y nunca aceptar: ni se consiente nada en
 * nombre de la tienda ni se recogen cookies que no hacen falta. Si la unica
 * salida es aceptar, se deja el muro puesto y se anota; esa pagina valdra menos
 * esa semana, y es el precio correcto.
 */
const RECHAZO = /^(reject|decline|refuse)( all| cookies| non-essential)?$|^(only |use )?(strictly )?necessary( cookies| only)?$|^essential( cookies)? only$|^ablehnen$|^nur (technisch )?notwendige|^alle ablehnen$|^rechazar( todo| todas)?$|^weigeren$|^alles weigeren$/i;

async function fueraElMuro(page) {
  const candidatos = page.locator('button, [role="button"], a[role="button"], input[type="button"]');
  const n = Math.min(await candidatos.count().catch(() => 0), 60);
  for (let i = 0; i < n; i++) {
    const el = candidatos.nth(i);
    const t = ((await el.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (!t || !RECHAZO.test(t)) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return 'rechazado';
  }
  // Sin boton de rechazo: puede que no haya muro, o que solo deje aceptar.
  const hayMuro = await page.evaluate(() =>
    !!document.querySelector('[id*="consent" i], [class*="consent" i], [id*="cookie" i], [class*="cookie-banner" i], [class*="cookiebanner" i]')
  ).catch(() => false);
  return hayMuro ? 'muro sin salida de rechazo' : 'sin muro';
}

async function miraPagina(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ESPERA });
  await page.waitForTimeout(2000);
  const consent = await fueraElMuro(page);
  await page.waitForTimeout(1500);            // que arranque lo que carga tarde
  const h = await page.evaluate(HUELLA);
  return { url, consent, ...h };
}

async function primerDisco(page, listing) {
  // El primer enlace que parece una ficha. Solo se usa para mirar UNA ficha:
  // no se recorre el catalogo de nadie.
  return page.evaluate(() => {
    // Formas habituales de una ficha, incluida la de id numerico de Hard Wax.
    const pistas = /\/(product|products|release|releases|item|items|artikel|detail|album|records?|vinyl|lp|12|catalog(ue)?)\/[^/]|\/\d{4,}\//i;
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href;
      if (pistas.test(new URL(href, location.href).pathname)) return href;
    }
    return null;
  }).catch(() => null);
}

async function visita(browser, site) {
  const reglas = await robots(site.home);
  const out = { key: site.key, name: site.name, visto: new Date().toISOString(), paginas: {}, errores: [] };
  const page = await browser.newPage({ userAgent: UA, viewport: { width: 1440, height: 1000 } });

  const objetivos = [['home', site.home], ['listing', site.listing]];
  for (const [nombre, url] of objetivos) {
    if (!url) continue;
    if (prohibido(reglas, url)) { out.errores.push(`${nombre}: robots.txt lo prohibe`); continue; }
    try {
      out.paginas[nombre] = await miraPagina(page, url);
      if (nombre === 'listing') {
        // Si la tienda pinta el listado con JS o usa una forma de URL rara, se
        // le pone la ficha a mano en sites.json y se deja de adivinar.
        const ficha = (await primerDisco(page, url)) || site.product || null;
        if (!ficha) out.errores.push('listing: no se encontro enlace a ficha de disco');
        if (ficha && !prohibido(reglas, ficha)) {
          await dormir(PAUSA_MS);
          out.paginas.product = await miraPagina(page, ficha);
        }
      }
    } catch (e) {
      out.errores.push(`${nombre}: ${String(e.message || e).split('\n')[0].slice(0, 120)}`);
    }
    await dormir(PAUSA_MS);
  }
  await page.close();
  return out;
}

// ── DIFERENCIA ──────────────────────────────────────────────────────
const menos = (a, b) => (a || []).filter(x => !(b || []).includes(x));

function compara(viejo, nuevo) {
  const cambios = [];
  for (const nombre of Object.keys(nuevo.paginas)) {
    const n = nuevo.paginas[nombre];
    const v = viejo?.paginas?.[nombre];
    if (!v) { cambios.push({ pagina: nombre, url: n.url, nuevaPagina: true }); continue; }
    const c = {
      pagina: nombre, url: n.url,
      controlsNuevos: menos(n.controls, v.controls),
      controlsIdos:   menos(v.controls, n.controls),
      formsNuevos:    menos(n.forms, v.forms),
      scriptsNuevos:  menos(n.scriptHosts, v.scriptHosts),
      scriptsIdos:    menos(v.scriptHosts, n.scriptHosts),
      signalsNuevas:  Object.keys(n.signals).filter(k => n.signals[k] && !v.signals[k]),
    };
    if (c.controlsNuevos.length || c.scriptsNuevos.length || c.signalsNuevas.length ||
        c.formsNuevos.length || c.controlsIdos.length || c.scriptsIdos.length) cambios.push(c);
  }
  return cambios;
}

// ── PRINCIPAL ───────────────────────────────────────────────────────
const { sites } = JSON.parse(readFileSync(join(AQUI, 'sites.json'), 'utf8'));
const lista = soloUna ? sites.filter(s => s.key === soloUna) : sites;
if (!lista.length) { console.error(`No hay tienda "${soloUna}" en sites.json`); process.exit(1); }

const browser = await chromium.launch({ channel: 'chrome' });
const informe = { fecha: new Date().toISOString().slice(0, 10), tiendas: [] };

for (const site of lista) {
  process.stdout.write(`  ${site.name}… `);
  const nuevo = await visita(browser, site);
  const ruta = join(SNAPS, `${site.key}.json`);
  const viejo = existsSync(ruta) ? JSON.parse(readFileSync(ruta, 'utf8')) : null;
  const cambios = viejo ? compara(viejo, nuevo) : [];

  informe.tiendas.push({
    key: site.key, name: site.name,
    paginas: Object.keys(nuevo.paginas).length,
    primeraVez: !viejo,
    desde: viejo?.visto || null,
    errores: nuevo.errores,
    cambios,
  });

  if (guardar && Object.keys(nuevo.paginas).length) {
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, JSON.stringify(nuevo, null, 1));
  }
  console.log(`${Object.keys(nuevo.paginas).length} pág · ${viejo ? `${cambios.length} con cambios` : 'primera huella'}${nuevo.errores.length ? ` · ${nuevo.errores.length} error(es)` : ''}`);
}

await browser.close();
// Una pasada de una sola tienda no pisa el diff de la semana: ese lo escribe la
// pasada completa, que es la que se lee el lunes.
const salida = join(RAIZ, 'docs', 'scout', `diff-${informe.fecha}${soloUna ? `-${soloUna}` : ''}.json`);
mkdirSync(dirname(salida), { recursive: true });
writeFileSync(salida, JSON.stringify(informe, null, 1));
console.log(`\n  diferencias en ${salida}`);
