#!/usr/bin/env node
/**
 * scout — el vigia semanal de tiendas de discos.
 *
 * Visita las tiendas de sites.json —y houseonly.store, con la misma huella—,
 * saca de cada pagina su ESTRUCTURA y la compara con todo lo que esa tienda
 * habia ensenado antes. Que es estructura y por que, en filtro.mjs; el juicio
 * de si lo nuevo es una funcion que nos interese, en report.mjs.
 *
 * Paginas, por orden de importancia: ficha de un disco, carrito, listado,
 * portada. El carrito se mira vacio: aqui no se anade nada ni se compra nada.
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
import { huella, compara } from './filtro.mjs';

const AQUI  = dirname(fileURLToPath(import.meta.url));
const RAIZ  = join(AQUI, '..', '..');
// Huellas v2 en su propia carpeta: la de la version anterior queda intacta y
// solo se lee una vez, como punto de partida de formularios, scripts y
// funciones.
const SNAPS    = join(RAIZ, 'docs', 'scout', 'snapshots-v2');
const SNAPS_V1 = join(RAIZ, 'docs', 'scout', 'snapshots');

const args     = process.argv.slice(2);
const soloUna  = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';
const guardar  = !args.includes('--no-save');
const PAUSA_MS = 7000;   // entre pagina y pagina: cortesia, no sigilo
const ESPERA   = 30000;

const dormir = ms => new Promise(r => setTimeout(r, ms));
const HOY = new Date().toISOString().slice(0, 10);

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

// ── LO CRUDO ────────────────────────────────────────────────────────
// Se ejecuta dentro de la pagina y devuelve materia prima; filtro.mjs decide
// que es estructura. Los textos solo viajan para buscar palabras-funcion y no
// se guardan nunca.
const CRUDO = () => {
  const limpia = s => String(s || '').replace(/\s+/g, ' ').trim();
  const host = src => { try { const h = new URL(src, location.href).host; return h && h !== location.host ? h.replace(/^www\./, '') : null; } catch { return null; } };

  const forms = [...document.querySelectorAll('form')].map(f => ({
    action: f.getAttribute('action') || '',
    campos: [...f.querySelectorAll('input[name], select[name], textarea[name]')].map(i => i.name),
  }));
  const scripts = [...document.querySelectorAll('script[src]')].map(s => host(s.src));
  const iframes = [...document.querySelectorAll('iframe[src]')].map(f => host(f.src));

  const aria = new Set(), data = new Set();
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes) {
      if (a.name.startsWith('aria-')) aria.add(a.name);
      else if (a.name.startsWith('data-')) data.add(a.name);
    }
  }

  // Rutas solo de cabecera, menus y pie: el centro de la pagina es catalogo.
  const rutas = new Set();
  document.querySelectorAll('header a[href], nav a[href], footer a[href], [role="navigation"] a[href]').forEach(a => {
    try { const u = new URL(a.href, location.href); if (u.host === location.host) rutas.add(u.pathname); } catch { /* href raro */ }
  });

  const textos = new Set();
  const anota = t => { const n = limpia(t); if (n && n.length <= 40) textos.add(n); };
  document.querySelectorAll('button, [role="button"], summary, label, a, input[type="submit"], input[type="button"]')
    .forEach(el => anota(el.value || el.textContent));
  document.querySelectorAll('[aria-label], [title]').forEach(el => { anota(el.getAttribute('aria-label')); anota(el.getAttribute('title')); });
  document.querySelectorAll('input[placeholder]').forEach(el => anota(el.getAttribute('placeholder')));

  return {
    title: limpia(document.title).slice(0, 120),
    forms, scripts, iframes,
    aria: [...aria], data: [...data], rutas: [...rutas], textos: [...textos],
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

/**
 * Una captura por pagina. Es la prueba: el informe dice "control nuevo: notify
 * me" y la captura enseña donde esta y como lo han puesto. JPEG de calidad
 * media y solo lo que entra en pantalla — un full-page de un listado son ocho
 * megas y nadie los mira.
 */
async function captura(page, key, nombre) {
  const dir = join(RAIZ, 'docs', 'scout', 'shots', HOY);
  mkdirSync(dir, { recursive: true });
  const ruta = join(dir, `${key}-${nombre}.jpg`);
  await page.screenshot({ path: ruta, type: 'jpeg', quality: 55 }).catch(() => {});
  return ruta;
}

/**
 * Retos de verificacion. Si una tienda decide que quiere comprobar quien entra,
 * esa es su decision: se anota y se sigue. NO se intenta pasar —ni esperando a
 * que caduque, ni falseando nada—, porque eso ya seria saltarse un control de
 * acceso en vez de mirar un escaparate.
 */
const ES_RETO = /^(just a moment|checking your browser|verifying you are human|attention required|access denied|un momento)/i;

async function miraPagina(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ESPERA });
  await page.waitForTimeout(2000);
  const consent = await fueraElMuro(page);
  await page.waitForTimeout(1500);            // que arranque lo que carga tarde
  const crudo = await page.evaluate(CRUDO);
  if (ES_RETO.test(crudo.title)) return { url, reto: crudo.title.slice(0, 40) };
  return { consent, ...huella({ url: page.url(), ...crudo }) };
}

async function primerDisco(page) {
  // El primer enlace que parece una ficha. Solo se usa para mirar UNA ficha:
  // no se recorre el catalogo de nadie.
  return page.evaluate(() => {
    // Formas habituales de una ficha, incluida la de id numerico de Hard Wax.
    // Clone usa /item12345.html y Deejay /Artista_Titulo__1234567.
    const pistas = /\/(product|products|release|releases|item|items|artikel|detail|album|records?|vinyl|lp|12|catalog(ue)?)\/[^/]|\/\d{4,}\/|\/item\d+\.html$|__\d{6,}$/i;
    for (const a of document.querySelectorAll('a[href]')) {
      const u = new URL(a.href, location.href);
      if (u.host === location.host && pistas.test(u.pathname)) return u.href;
    }
    return null;
  }).catch(() => null);
}

async function visita(browser, site) {
  const reglas = await robots(site.home);
  const out = { key: site.key, name: site.name, visto: new Date().toISOString(), paginas: {}, errores: [], notas: [] };
  const page = PERFIL ? await browser.newPage() : await browser.newPage({ userAgent: UA, viewport: { width: 1440, height: 1000 } });

  const mira = async (nombre, url, { opcional = false } = {}) => {
    const fallo = msg => (opcional ? out.notas : out.errores).push(`${nombre}: ${msg}`);
    if (prohibido(reglas, url)) { fallo('robots.txt lo prohibe'); return false; }
    try {
      const visto = await miraPagina(page, url);
      if (visto.reto) { fallo(`reto de verificacion (${visto.reto}) — no se pasa por diseno`); return false; }
      out.paginas[nombre] = visto;
      visto.shot = await captura(page, site.key, nombre);
      return true;
    } catch (e) {
      fallo(String(e.message || e).split('\n')[0].slice(0, 120));
      return false;
    } finally {
      await dormir(PAUSA_MS);
    }
  };

  await mira('home', site.home);
  // La ficha sale del listado, o de la portada si la tienda no tiene listado
  // mirable. Si pinta los enlaces con JS raro, se le pone en sites.json.
  const desde = site.listing
    ? ((await mira('listing', site.listing)) ? site.listing : null)
    : (out.paginas.home ? site.home : null);
  if (desde) {
    const ficha = site.product || (await primerDisco(page));
    if (!ficha) out.errores.push('product: no se encontro enlace a ficha de disco');
    else await mira('product', ficha);
  }
  // Carrito vacio: lo que la tienda ofrece antes de pagar (envios, notas,
  // regalos). Shopify lo prohibe en robots.txt y se respeta; no es un error.
  if (site.cart !== null) await mira('cart', site.cart || new URL('/cart', site.home).href, { opcional: true });

  await page.close();
  return out;
}

// ── PRINCIPAL ───────────────────────────────────────────────────────
const { sites } = JSON.parse(readFileSync(join(AQUI, 'sites.json'), 'utf8'));
const lista = soloUna ? sites.filter(s => s.key === soloUna) : sites;
if (!lista.length) { console.error(`No hay tienda "${soloUna}" en sites.json`); process.exit(1); }

/**
 * Chrome de verdad, con ventana. Varias tiendas grandes —Boomkat, Juno— no
 * sirven nada al modo headless, y con una ventana normal cargan enteras: no hay
 * nada que saltarse, solo un navegador que se comporta como un navegador. La
 * ventana se abre fuera de la pantalla para no molestar al lunes por la mañana.
 *
 * Con SCOUT_PROFILE se usa un perfil propio y persistente en vez de uno limpio.
 * Sirve para paginas que solo existen tras iniciar sesion: la sesion la abre
 * Eduardo a mano una vez —`node scripts/scout/login.mjs`— y el vigia reutiliza
 * esa cookie. Aqui NO hay contraseñas: ni se guardan, ni se escriben, ni se
 * piden. Si la cookie caduca, la pagina sale como no accesible y se vuelve a
 * entrar a mano; no se intenta nada mas.
 */
const ARGS = ['--window-position=-2400,0', '--window-size=1440,1000'];
const PERFIL = process.env.SCOUT_PROFILE || '';
const headless = process.env.SCOUT_HEADLESS === '1';

const browser = PERFIL
  ? await chromium.launchPersistentContext(PERFIL, { channel: 'chrome', headless, args: ARGS, viewport: { width: 1440, height: 1000 } })
  : await chromium.launch({ channel: 'chrome', headless, args: ARGS });
const informe = { version: 2, fecha: new Date().toISOString().slice(0, 10), tiendas: [] };

const leeJson = ruta => (existsSync(ruta) ? JSON.parse(readFileSync(ruta, 'utf8')) : null);

for (const site of lista) {
  process.stdout.write(`  ${site.name}… `);
  const nuevo = await visita(browser, site);
  const ruta = join(SNAPS, `${site.key}.json`);
  const viejo = leeJson(ruta) || leeJson(join(SNAPS_V1, `${site.key}.json`));
  const vistas = Object.keys(nuevo.paginas).length;
  const { candidatos, desaparecidos, vistos, capturas } = vistas
    ? compara(viejo, nuevo)
    : { candidatos: [], desaparecidos: [], vistos: null, capturas: 0 };

  informe.tiendas.push({
    key: site.key, name: site.name, propia: !!site.propia,
    paginas: Object.keys(nuevo.paginas),
    primeraVez: !viejo,
    desde: viejo?.visto || null,
    errores: nuevo.errores,
    candidatos,
    // De las demas tiendas no importa lo que quitan; de la nuestra, si.
    desaparecidos: site.propia ? desaparecidos : [],
    // Para el juicio: lo que la tienda tenia antes y tiene ahora, por pagina.
    antes: viejo?.version === 2 ? viejo.paginas : null,
    ahora: nuevo.paginas,
    shots: Object.fromEntries(Object.entries(nuevo.paginas).map(([n, p]) => [n, p.shot || null])),
  });

  if (guardar && vistas) {
    // Lo que esta semana no se dejo ver conserva su huella anterior: mejor un
    // dato de hace siete dias que un agujero que finge que la tienda cambio.
    const paginas = { ...(viejo?.version === 2 ? viejo.paginas : {}), ...nuevo.paginas };
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, JSON.stringify({ version: 2, key: site.key, visto: nuevo.visto, capturas, paginas, vistos }, null, 1));
  }
  console.log(`${vistas} pág · ${viejo ? `${candidatos.length} candidato(s)` : 'primera huella'}${nuevo.errores.length ? ` · ${nuevo.errores.length} error(es)` : ''}`);
}

await browser.close();
// Una pasada de una sola tienda no pisa el diff de la semana: ese lo escribe la
// pasada completa, que es la que se lee el lunes.
const salida = join(RAIZ, 'docs', 'scout', `diff-${informe.fecha}${soloUna ? `-${soloUna}` : ''}.json`);
mkdirSync(dirname(salida), { recursive: true });
writeFileSync(salida, JSON.stringify(informe, null, 1));
console.log(`\n  diferencias en ${salida}`);
