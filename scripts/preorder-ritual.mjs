#!/usr/bin/env node
/**
 * preorder-ritual.mjs — ritual de sesion sobre los emails archivados en Drive.
 *
 * Lee la carpeta Preorders/ del Drive local y entrega la lista de lo NUEVO para
 * que Eduardo escoja que importar. No escribe en Shopify ni toca la carpeta
 * fuente: el import lo hace el Pre-order tab, que es la unica parada humana.
 *
 *   node scripts/preorder-ritual.mjs                  el informe de sesion
 *   node scripts/preorder-ritual.mjs --abrir PACE009  abre el .html en el navegador
 *   node scripts/preorder-ritual.mjs --promopack PACE009
 *   node scripts/preorder-ritual.mjs --importado PACE009 VOYA007
 *   node scripts/preorder-ritual.mjs --descartado DT001
 *   node scripts/preorder-ritual.mjs --todo            incluye ya importados/descartados
 *
 * ── ESTE RITUAL ES EL INTERINO, NO EL DESTINO ────────────────────────────────
 * El endgame es que el Pre-order tab lea estos ficheros por si mismo y recuerde
 * que proceso, sin depender de Claude. Por eso aqui NO hay logica de negocio
 * nueva: las reglas de triage estan documentadas abajo en tablas explicitas y el
 * estado es un JSON plano con clave = filename. Migrarlo a la UI debe ser un
 * trasplante, no una reescritura.
 *
 * ── LO QUE ESTE SCRIPT NO HACE, A PROPOSITO ──────────────────────────────────
 *  - No reparsea campos (Artist/Title/Cat/Price). Ese parseo vive en UN sitio,
 *    App.jsx, y aqui solo se clasifica por nombre de fichero y marcadores
 *    minimos. El catno que se muestra es DECORATIVO: sale del filename, sirve
 *    para que Eduardo reconozca el disco, y no se usa jamas para emparejar.
 *  - No lee los PDF de confirmacion (WSORD__/RDORD__). Se cuentan y se aparcan:
 *    el flujo pedido -> forthcoming es de la fase siguiente.
 *  - No comprueba el catalogo vivo. Eso lo hace el tab con fetchLiveHandles().
 *  - No mueve ni renombra nada en Preorders/. El Apps Script deduplica por
 *    filename: tocarlo ahi haria que rearchivase emails ya archivados.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const HOME = os.homedir();
const DRIVE = path.join(HOME, 'Library/CloudStorage/GoogleDrive-emontagut@telsnap.com/My Drive/Houseonly.store');
const SRC    = path.join(DRIVE, 'Preorders');
const ASSETS = path.join(DRIVE, 'Assets');
const HERE   = path.dirname(new URL(import.meta.url).pathname);
const STATE  = path.join(HERE, '.preorder-state.json');
const STALE_HOURS = 48;

// ── REGLAS DE TRIAGE (migrar tal cual a la UI) ───────────────────────────────
// 1. El prefijo del filename decide de quien es y si es material o pedido.
const SOURCES = {
  WS:    { label: 'Word & Sound',  assets: 'wordandsound',   kind: 'material' },
  DBH:   { label: 'DBH',           assets: 'DBH',            kind: 'material' },
  TV:    { label: 'Triple Vision', assets: 'Triple Vision',  kind: 'material' },
  RD:    { label: 'Rubadub',       assets: 'Rubadub',        kind: 'material' },
  WSORD: { label: 'W&S · pedido',  assets: null,             kind: 'pedido'   },
  RDORD: { label: 'RD · pedido',   assets: null,             kind: 'pedido'   },
};

// 2. Digest vs per-release: por SUBJECT (que va dentro del filename). Un digest
//    es un catalogo — muchos releases, no un anuncio. Verificado contra los
//    emails reales del archivo. Se mira el filename, no el contenido, salvo el
//    desempate barato de mas abajo.
const DIGEST_SUBJECT = [
  /All-Rubadub-Pre-sales/i,           // RD  round-up semanal (sin bloques de campos)
  /New-Releases-Shipping/i,           // RD  digest de envios
  /Imports-Shipping-Today/i,          // RD  idem
  /Triple-Vision-New-Releases/i,      // TV  semanal
  /Wordandsound-Update/i,             // WS  semanal
  /Newsletter-KW\d+/i,                // DBH semanal
  /Label-Special/i,                   // TV  recopilatorio de sello
  /Represses/i,                       // varios releases en un email
];

// 2b. Señal de pedido escondida bajo prefijo de material. El Apps Script archiva
//     los Fwd/Re de Eduardo a distribution@rubadub.co.uk con el prefijo del
//     distribuidor (RD__Fwd-…, RD__Re-…), no bajo RDORD__ — ese esta reservado a
//     los quotes. Son SU pedido ("2 of this please"), no material nuevo: si se
//     cuentan como release duplican el anuncio original en la lista. Aqui solo
//     se aparcan junto a los RDORD__/WSORD__; consumirlos es de la fase
//     siguiente. Comprobado que no hay falsos positivos: los asuntos que
//     empiezan por "Repress-"/"Release-" no llevan guion tras "Re".
const ORDER_SUBJECT = /^(Fwd|Re)-/;

// 3. Un email que corrige a otro anterior NO es material nuevo: es una revision
//    del mismo disco. Se marca para que Eduardo sepa que puede reemplazar algo
//    ya importado (y, en TV, que la URL del promopack habra cambiado).
const REVISION_SUBJECT = /^(ART-UPDATE|UPDATE|Price-correction|Artist-and-release-title-correction|Updated-artwork|New-release-date|RELEASE-DATE-SET|Repress)/i;

// 4. Catno DECORATIVO desde el filename. Best-effort por distribuidor; si no
//    sale, se deja vacio y no pasa nada. NUNCA se usa para emparejar.
// Un catno de verdad mezcla letras y digitos ("PACE009", "RAWAX030LTD"). Exigirlo
// descarta las palabras sueltas que si no se colaban como si fueran catnos —
// "VIA", "RAWAX", "OUT" — y un catno vacio es mucho mejor que uno inventado:
// esta columna solo existe para que Eduardo reconozca el disco de un vistazo.
const looksLikeCatno = (t) => /[A-Z]/.test(t) && /\d/.test(t) && t.length >= 4;

function catnoFromName(src, subject) {
  const s = subject.replace(/-+/g, ' ').trim();
  if (src === 'TV') {
    // TV__CITB019---Titulo...  /  TV__Price-correction---CITB019---Titulo...
    const head = subject.replace(REVISION_SUBJECT, '').replace(/^-+/, '');
    const tok = head.split(/---|-{1,2}/).map(t => t.trim()).find(looksLikeCatno);
    return tok || '';
  }
  if (src === 'RD') {
    // RD__DJ-Yoshino---Back-to-Basics-Pace-Yourself-PACE009__fecha -> va al final
    const m = s.match(/([A-Z][A-Z0-9._#/-]*\d[A-Z0-9._#/-]*)\s*$/);
    return m && looksLikeCatno(m[1]) ? m[1] : '';
  }
  if (src === 'DBH') {
    // "OUT SOON VIA MAINRECORDS MAINRECORDS13 VARIOUS ARTISTS" -> MAINRECORDS13
    const after = s.split(/OUT SOON|Out soon|Upcoming/i)[1];
    if (!after) return '';
    return after.split(/\s+/).find(looksLikeCatno) || '';
  }
  return '';
}

// ── estado ───────────────────────────────────────────────────────────────────
const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return {}; }
};
const saveState = (st) => fs.writeFileSync(STATE, JSON.stringify(st, null, 2) + '\n');
const today = () => new Date().toISOString().slice(0, 10);

// ── lectura de la carpeta (SOLO LECTURA) ─────────────────────────────────────
function readSource() {
  if (!fs.existsSync(SRC)) {
    console.error(`No existe la carpeta de Drive:\n  ${SRC}\n¿Google Drive for desktop esta corriendo?`);
    process.exit(1);
  }
  const out = [];
  for (const name of fs.readdirSync(SRC)) {
    const m = name.match(/^([A-Z]+)__(.+?)__(\d{4}-\d{2}-\d{2})(?:__.*)?\.(html|pdf)$/);
    if (!m) continue;                       // .DS_Store, CSVs sueltos, notas
    const [, prefix, subject, date, ext] = m;
    const src = SOURCES[prefix];
    if (!src) continue;
    const stat = fs.statSync(path.join(SRC, name));
    const esPedido = src.kind === 'pedido' || ORDER_SUBJECT.test(subject);
    out.push({
      name, prefix, subject, date, ext,
      mtime: stat.mtimeMs,
      label: esPedido && src.kind === 'material' ? `${src.label} · pedido` : src.label,
      kind: esPedido ? 'pedido' : src.kind,
      assets: src.assets,
      digest: DIGEST_SUBJECT.some(re => re.test(subject)),
      revision: REVISION_SUBJECT.test(subject),
      catno: esPedido ? '' : catnoFromName(prefix, subject),
    });
  }
  return out;
}

// El sync de Drive puede estar parado y la carpeta parecer simplemente vacia de
// novedades. Sin esta comprobacion, "no hay nada nuevo" es indistinguible de
// "llevo dos dias sin sincronizar", asi que nunca se reporta lo uno sin lo otro.
function freshness(files) {
  if (!files.length) return { hours: Infinity, stale: true, newest: null };
  const newest = files.reduce((a, b) => (a.mtime > b.mtime ? a : b));
  const hours = (Date.now() - newest.mtime) / 3600000;
  return { hours, stale: hours > STALE_HOURS, newest };
}

const pretty = (f) => {
  const tipo = f.kind === 'pedido' ? 'pedido'
             : f.revision ? 'revision'
             : f.digest   ? 'digest'
             : 'per-release';
  return { fecha: f.date, tipo, catno: f.catno || '—', asunto: f.subject.replace(/-+/g, ' ').slice(0, 58) };
};

function table(rows) {
  if (!rows.length) return;
  const w = { fecha: 10, tipo: 12, catno: 16 };
  for (const f of rows) {
    const p = pretty(f);
    console.log(`  ${p.fecha.padEnd(w.fecha)} ${p.tipo.padEnd(w.tipo)} ${p.catno.padEnd(w.catno)} ${p.asunto}`);
  }
}

// ── el informe ───────────────────────────────────────────────────────────────
function report({ includeAll = false } = {}) {
  const files = readSource();
  const state = loadState();
  const fresh = freshness(files);

  console.log(`\nPreorders/  ${files.length} ficheros reconocidos`);
  if (fresh.stale) {
    console.log(`\n  !! SYNC SOSPECHOSO: el fichero mas reciente tiene ${Math.round(fresh.hours)}h.`);
    console.log(`     Puede que Google Drive lleve parado. NO te fies de "no hay nada nuevo".`);
  } else {
    console.log(`  sync ok — mas reciente hace ${fresh.hours < 1 ? '<1' : Math.round(fresh.hours)}h (${fresh.newest.date})`);
  }

  const material = files.filter(f => f.kind === 'material');
  const pedidos  = files.filter(f => f.kind === 'pedido');

  const st = (f) => state[f.name]?.status || 'nuevo';
  const nuevos      = material.filter(f => st(f) === 'nuevo');
  const pendientes  = material.filter(f => st(f) === 'presentado');
  const cerrados    = material.filter(f => ['importado', 'descartado'].includes(st(f)));

  const byLabel = (rows) => {
    const g = {};
    for (const f of rows) (g[f.label] = g[f.label] || []).push(f);
    for (const k of Object.keys(g)) g[k].sort((a, b) => b.date.localeCompare(a.date));
    return g;
  };

  for (const [titulo, rows] of [['NUEVOS', nuevos], ['PENDIENTES de sesiones anteriores', pendientes]]) {
    console.log(`\n${'='.repeat(78)}\n${titulo}: ${rows.length}\n${'='.repeat(78)}`);
    const g = byLabel(rows);
    for (const label of Object.keys(g).sort()) {
      console.log(`\n▸ ${label}  (${g[label].length})`);
      table(g[label]);
    }
    if (!rows.length) console.log('  (ninguno)');
  }

  if (includeAll && cerrados.length) {
    console.log(`\n${'='.repeat(78)}\nYA CERRADOS: ${cerrados.length}\n${'='.repeat(78)}`);
    const g = byLabel(cerrados);
    for (const label of Object.keys(g).sort()) {
      console.log(`\n▸ ${label}  (${g[label].length})`);
      for (const f of g[label]) {
        const s = state[f.name];
        console.log(`  ${f.date}  ${(s.status).padEnd(12)} ${(f.catno || '—').padEnd(16)} ${f.subject.replace(/-+/g,' ').slice(0,50)}`);
      }
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`Señal de pedido archivada (fase siguiente, no se lee aqui): ${pedidos.length} ficheros`);
  console.log(`Cerrados: ${cerrados.length}   ·   estado: scripts/.preorder-state.json`);

  // Presentar = pasar de nuevo a presentado. Idempotente: correrlo dos veces no
  // cambia nada la segunda vez, solo mueve las filas de "nuevos" a "pendientes".
  for (const f of nuevos) state[f.name] = { status: 'presentado', fecha: today() };
  saveState(state);

  if (nuevos.length) {
    console.log(`\nEscoge por catno o por trozo del nombre, p.ej.:`);
    console.log(`  node scripts/preorder-ritual.mjs --abrir PACE009`);
    console.log(`  node scripts/preorder-ritual.mjs --promopack PACE009`);
    console.log(`  node scripts/preorder-ritual.mjs --importado PACE009`);
  }
}

// ── acciones sobre un elegido ────────────────────────────────────────────────
// --abrir y --promopack solo tienen sentido sobre material, y cada release suele
// venir con su gemelo Fwd-/Re- (la señal de pedido), que si no haria ambiguo
// cualquier match por catno. Se filtra a material antes de exigir unicidad.
const match = (files, pat) => {
  const p = pat.toLowerCase();
  const hits = files.filter(f => f.kind === 'material' && f.name.toLowerCase().includes(p));
  if (!hits.length) { console.error(`  x sin coincidencias: ${pat}`); return null; }
  if (hits.length > 1) {
    console.error(`  x "${pat}" coincide con ${hits.length} ficheros — afina:`);
    hits.slice(0, 8).forEach(f => console.error(`      ${f.name}`));
    return null;
  }
  return hits[0];
};

// Abrir para copiar. El onPaste del tab coge la version text/html del
// portapapeles, asi que hay que copiar de una pagina renderizada.
//
// PERO no vale cualquiera: en el .html archivado (el que entrega Gmail) el
// enlace de Dropbox viene envuelto en un tracker de Mailchimp
// (rubadub.us1.list-manage.com/track/click), y el parser busca
// "dropbox.com/scl/fo", asi que copiando de ahi el release sale SIN ZIP. La
// pagina de archivo de mailchi.mp —enlazada dentro del propio email como "View
// this email in your browser"— sirve el href de Dropbox limpio y la misma
// portada. Se prefiere esa; el fichero local queda de reserva.
function archivoWeb(f) {
  const html = fs.readFileSync(path.join(SRC, f.name), 'utf8');
  const m = html.match(/https:\/\/mailchi\.mp\/[^\s"'<?]+/);
  return m ? m[0] : null;
}

function abrir(pats) {
  const files = readSource();
  for (const p of pats) {
    const f = match(files, p);
    if (!f) continue;
    if (f.ext !== 'html') { console.error(`  x ${f.name} no es .html`); continue; }
    const web = archivoWeb(f);
    if (web) {
      execFileSync('open', [web]);
      console.log(`  v ${f.catno || f.subject.slice(0, 30)} — abierto el archivo web:`);
      console.log(`    ${web}`);
      console.log(`    (esta version trae el Dropbox limpio; el .html de Drive lo trae tras un tracker)`);
    } else {
      execFileSync('open', [path.join(SRC, f.name)]);
      console.log(`  ! ${f.name}`);
      console.log(`    sin enlace a mailchi.mp — abierto el fichero local. Ojo: si el Dropbox`);
      console.log(`    viene tras un tracker, el release entrara sin ZIP.`);
    }
    console.log(`    Copia el email ENTERO (Cmd+A): el texto de ENCIMA del bloque de campos`);
    console.log(`    lleva "Please Pre-Order" y la fecha de envio.`);
  }
}

// Descarga del promopack con los scripts que ya existen, sin reimplementarlos.
function promopack(pats) {
  const files = readSource();
  for (const raw of pats) {
    // "patron=CATNO" fuerza el nombre del zip. Hace falta mas de lo que parece:
    // el Apps Script recorta el asunto a ~70 caracteres, asi que un catno al
    // final llega partido ("…Voyager-Recordings-VOYA0"), y un email que anuncia
    // dos discos a la vez no tiene UN catno que extraer. El catno del filename
    // es decorativo; el del zip tiene que ser exacto porque el Pre-order tab
    // empareja por ahi.
    const [p, override] = raw.split('=');
    const f = match(files, p);
    if (!f) continue;
    if (!f.assets) { console.error(`  x ${f.name} es señal de pedido, no material`); continue; }
    const catno = (override || f.catno || '').trim().toUpperCase();
    if (!catno) {
      console.error(`  x ${p}: no se puede deducir el catno del nombre del fichero.`);
      console.error(`    Pasalo explicito:  --promopack "${p}=CATNO"`);
      continue;
    }
    const dest = path.join(ASSETS, f.assets);
    fs.mkdirSync(dest, { recursive: true });

    if (f.prefix === 'TV') {
      // La primitiva de TV: resuelve la URL vigente desde el email mas reciente
      // que apunte al MISMO order-item UUID. Ver el script para el porque.
      console.log(`  > TV ${catno} — tv-resolve-promopacks.py`);
      spawnSync(path.join(HERE, 'tv-resolve-promopacks.py'), [catno], { stdio: 'inherit' });
      continue;
    }
    if (f.prefix === 'RD') {
      // rd-download.sh lee un manifest {catno, zip_url} y YA limpia el tracking
      // de Mailchimp y fuerza dl=1 — aqui solo hay que SACAR el enlace.
      //
      // En el .html archivado el Dropbox casi nunca esta a la vista: viene tras
      // un tracker de Mailchimp que responde 302 al enlace real. Misma primitiva
      // que en Triple Vision — resolver el redirect y quedarse con el destino —
      // salvo que aqui el destino es Dropbox en vez del bucket de DO.
      const html = fs.readFileSync(path.join(SRC, f.name), 'utf8');
      let m = html.match(/https:\/\/www\.dropbox\.com\/scl\/fo\/[^\s"'<)]+/);
      if (!m) {
        const trackers = [...new Set((html.match(/https:\/\/[a-z0-9.-]*list-manage\.com\/track\/click\?[^\s"'<)]+/g) || [])
          .map(u => u.replace(/&amp;/g, '&')))];
        for (const t of trackers) {
          const dest = execFileSync('curl',
            ['-sS', '-o', '/dev/null', '-w', '%{redirect_url}', '-A', 'Mozilla/5.0', t],
            { encoding: 'utf8' }).trim();
          if (dest.includes('dropbox.com/scl/fo')) { m = [dest]; break; }
        }
      }
      if (!m) {
        // Normal en represses y restocks: el disco ya existe y Rubadub no manda
        // material promocional nuevo. Tambien pasa en los digests.
        console.error(`  x ${catno}: el email no lleva promopack (habitual en repress/restock/digest).`);
        console.error(`    Si necesitas portada, sacala de otra fuente o del producto que ya tengas.`);
        continue;
      }
      const tmp = path.join(os.tmpdir(), `rd_${catno.replace(/[^\w-]/g, '_')}.json`);
      fs.writeFileSync(tmp, JSON.stringify({ items: [{ catno, zip_url: m[0].replace(/&amp;/g, '&') }] }));
      const rd = path.join(HOME, 'Downloads/rd-download.sh');
      if (!fs.existsSync(rd)) { console.error(`  x falta ${rd}`); continue; }
      console.log(`  > RD ${catno} — rd-download.sh`);
      spawnSync('bash', [rd, tmp, dest], { stdio: 'inherit' });
      continue;
    }
    console.error(`  x ${f.prefix}: sin descargador (W&S y DBH se bajan desde el propio tab)`);
  }
}

// Arranque en frio: la primera vez TODO el archivo es "nuevo" (196 ficheros que
// se remontan a mayo), y eso no es una lista de trabajo, es ruido. Esto cierra
// de golpe lo anterior a una fecha para que el ritual empiece a contar desde
// donde Eduardo diga. Solo mueve estado; no toca Preorders/.
function marcarAntesDe(status, fecha) {
  const files = readSource().filter(f => f.kind === 'material' && f.date < fecha);
  const state = loadState();
  for (const f of files) state[f.name] = { status, fecha: today() };
  saveState(state);
  console.log(`  v ${files.length} ficheros anteriores a ${fecha} marcados como ${status}.`);
}

function marcar(status, pats) {
  const files = readSource();
  const state = loadState();
  let n = 0;
  for (const p of pats) {
    // Aqui SI se permite marcar varios de golpe: es la operacion natural
    // ("todo lo de este catno"), y no destruye nada — solo mueve el estado.
    const hits = files.filter(f => f.name.toLowerCase().includes(p.toLowerCase()) && f.kind === 'material');
    if (!hits.length) { console.error(`  x sin coincidencias: ${p}`); continue; }
    for (const f of hits) {
      state[f.name] = { status, fecha: today() };
      console.log(`  v ${status.padEnd(11)} ${f.name}`);
      n++;
    }
  }
  saveState(state);
  console.log(`\n${n} marcados como ${status}.`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const [, , flag, ...rest] = process.argv;
switch (flag) {
  case undefined:        report(); break;
  case '--todo':         report({ includeAll: true }); break;
  case '--abrir':        abrir(rest); break;
  case '--promopack':    promopack(rest); break;
  case '--importado':    marcar('importado', rest); break;
  case '--descartado':   marcar('descartado', rest); break;
  case '--descartar-antes-de':
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rest[0] || '')) {
      console.error('uso: --descartar-antes-de YYYY-MM-DD'); process.exit(2);
    }
    marcarAntesDe('descartado', rest[0]);
    break;
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n').replace(/^ \* ?/gm, ''));
    process.exit(2);
}
