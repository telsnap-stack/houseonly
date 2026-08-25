#!/usr/bin/env node
/**
 * file-promopacks.mjs — coloca los promopacks recién bajados en Assets/ con el
 * nombre que el Pre-order tab sabe emparejar.
 *
 *   node scripts/file-promopacks.mjs                 dry-run sobre ~/Downloads
 *   node scripts/file-promopacks.mjs --apply         mueve de verdad
 *   node scripts/file-promopacks.mjs --from ~/Desktop --apply
 *   node scripts/file-promopacks.mjs --to "Triple Vision" --apply
 *
 * El problema: el portal de Triple Vision sirve el fichero con el nombre del
 * objeto de su bucket (9164b519-8747-…_promopack.zip). Ahí no hay catno, así que
 * el tab no lo empareja con nada y el disco parece que sigue faltando.
 *
 * Para TRIPLE VISION la solución es mirar dentro: sus promopacks nombran los
 * ficheros con el catno delante y de ahí sale, aunque el .zip se llame como sea.
 *     CITB019_A1-snippet.mp3 · CITB019_front.jpeg · RASTA008V_promotext.txt
 *
 * Para RUBADUB NO FUNCIONA, y conviene saberlo antes de fiarse: sus promopacks
 * los arma el sello, no el distribuidor, así que dentro hay lo que a cada uno le
 * dé la gana. Medido sobre los 9 que hay en Assets/Rubadub: solo 2 llevan el
 * catno, y uno de esos lo lleva MAL — un zip del email de Logistic contenía
 * ficheros LOG88 cuando el disco pedido era LOG86. Ahí el catno solo lo sabe
 * quien descarga, y por eso la descarga desde el Pre-order tab nombra el fichero
 * ella misma: es la única fuente fiable.
 *
 * Ejemplos reales de contenido de Rubadub, para que se vea el problema:
 *     A1- OUTSIDE .mp3 · 733019542_988549377418142_2902885361164917234_n.jpg
 *     yore_ltd_011_1400.jpg · new+2+FTC+FLPS+V3+Mock+up.jpeg
 *
 * Convención de destino, la misma que ya usa Assets/: {CATNO}.zip
 * Nunca sobrescribe: si ya existe uno con ese nombre, lo dice y no toca nada.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const ASSETS = path.join(HOME,
  'Library/CloudStorage/GoogleDrive-emontagut@telsnap.com/My Drive/Houseonly.store/Assets');

const args = process.argv.slice(2);
const flag = (n, def) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : def; };
const APPLY = args.includes('--apply');
const FROM  = path.resolve(flag('--from', path.join(HOME, 'Downloads')));
const TO_FORZADO = flag('--to', '');

// Un nombre sirve si lleva letras Y dígitos y no es un UUID. "CITB019" vale;
// "9164b519-8747-4d2d-94f2-d8d9bdf59839" no, aunque cumpla lo primero.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Misma clave que usa el Pre-order tab para emparejar: solo alfanuméricos. Por
// eso da igual cómo se escriba el catno en el nombre — "SS093/094",
// "SS093-094" y "ss093094" caen todos en la misma clave.
const clave = (t) => String(t || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

// El catno puede llevar barras o almohadillas (SS093/094, DBS#1) y eso en un
// nombre de fichero crea subcarpetas o da problemas. Se sustituye por guion:
// como el emparejamiento normaliza, no rompe nada.
const nombreSeguro = (c) => c.replace(/[\/\\:*?"<>|]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const pareceCatno = (t) => !!t && /[A-Za-z]/.test(t) && /\d/.test(t) && !UUID.test(t) && t.length >= 3;

function catnoDelNombre(fichero) {
  let b = fichero.replace(/\.zip$/i, '').replace(/\s*\(\d+\)\s*$/, '').trim();
  try { b = decodeURIComponent(b); } catch { /* escape malformado */ }
  b = b.replace(/^artwork[_-]/i, '').replace(/[_-]?promopack.*$/i, '');
  const m = b.match(/^\d+-(.+)$/);           // prefijo numérico de W&S
  const cand = (m ? m[1] : b).trim();
  return pareceCatno(cand) ? cand : '';
}

/** Lista las entradas del zip sin dependencias: unzip viene con macOS. */
function entradas(zip) {
  try {
    return execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 8e6 })
      .split('\n').map((x) => x.trim()).filter(Boolean);
  } catch { return []; }
}

/**
 * Catno desde el CONTENIDO. Los promopacks nombran sus ficheros
 * "{CATNO}_front.jpeg", "{CATNO}_A1-snippet.mp3", "{CATNO}_promotext.txt".
 * Se coge el prefijo antes del primer "_" y se exige que se repita en varias
 * entradas: un solo fichero podría llamarse cualquier cosa, pero tres coincidencias
 * ya no son casualidad.
 */
function catnoDelContenido(zip) {
  const nombres = entradas(zip)
    .map((e) => e.split('/').pop())
    .filter((n) => n && !n.startsWith('._') && n !== '.DS_Store');
  const cuenta = new Map();
  for (const n of nombres) {
    const m = n.match(/^(.+?)[_-](front|back|promotext|[AB]\d|\d+-snippet|.*snippet)/i);
    const cand = m ? m[1].trim() : '';
    if (pareceCatno(cand)) cuenta.set(cand, (cuenta.get(cand) || 0) + 1);
  }
  let mejor = '', n = 0;
  for (const [k, v] of cuenta) if (v > n) { mejor = k; n = v; }
  return n >= 2 ? mejor : '';
}

/** De quién es, para saber en qué subcarpeta va. */
function distribuidor(zip, ents) {
  const s = ents.join(' ').toLowerCase();
  if (/_promotext\.txt|_front\.jpe?g|snippet\.mp3/.test(s)) return 'Triple Vision';
  if (/salespaper\.pdf/.test(s)) return 'wordandsound';
  return '';   // sin pistas: hay que decirlo con --to
}

/**
 * ¿Esto parece siquiera un promopack? En Descargas conviven copias de seguridad,
 * instaladores y exportaciones de datos, y sugerir "--to Triple Vision" para un
 * houseonly-worker-untracked-backup.zip es mal consejo. Un promopack lleva audio
 * o imágenes; si no hay ninguna de las dos, no es asunto de este script.
 */
function pareceMusica(ents) {
  return ents.some((e) => /\.(mp3|wav|flac|aiff?)$/i.test(e))
      || ents.some((e) => /\.(jpe?g|png|tiff?)$/i.test(e));
}

/**
 * Índice de lo que YA hay en Assets, por clave normalizada. Comprobar solo si
 * existe "{catno}.zip" no vale: los de W&S ya están archivados con su nombre
 * original ("100136-des133.zip"), así que preguntar por "des133.zip" diría que
 * no y acabaríamos con el mismo disco dos veces.
 */
function indiceAssets() {
  const idx = new Map();
  const rec = (d, prof) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (prof < 2) rec(f, prof + 1); continue; }
      if (!/\.zip$/i.test(e.name)) continue;
      const k = clave(catnoDelNombre(e.name) || e.name.replace(/\.zip$/i, ''));
      if (k && !idx.has(k)) idx.set(k, path.basename(d) + '/' + e.name);
    }
  };
  rec(ASSETS, 0);
  return idx;
}

function main() {
  if (!fs.existsSync(FROM)) { console.error(`no existe: ${FROM}`); process.exit(1); }
  const yaEnAssets = indiceAssets();
  console.log(`Assets/ tiene ${yaEnAssets.size} promopacks indexados`);
  const zips = fs.readdirSync(FROM).filter((f) => /\.zip$/i.test(f));
  if (!zips.length) { console.log(`sin .zip en ${FROM}`); return; }

  console.log(`${zips.length} .zip en ${FROM}${APPLY ? '' : '   (dry-run — usa --apply para mover)'}\n`);
  let movidos = 0, saltados = 0, sinCatno = 0, sinDestino = 0;

  for (const f of zips) {
    const src = path.join(FROM, f);
    const porNombre = catnoDelNombre(f);
    const ents = entradas(src);
    const porDentro = catnoDelContenido(src);
    // El contenido manda: el nombre puede venir de cualquier sitio, los ficheros
    // de dentro los pone el distribuidor.
    const catno = porDentro || porNombre;
    const dist = TO_FORZADO || distribuidor(src, ents);

    if (!catno) {
      sinCatno++;
      console.log(`  ? ${f.slice(0, 52).padEnd(54)} sin catno ni en el nombre ni dentro`);
      continue;
    }
    if (!dist) {
      sinDestino++;
      const pista = pareceMusica(ents)
        ? 'no sé de quién es — dilo con --to "Triple Vision"'
        : 'no parece un promopack (ni audio ni imágenes): lo dejo donde está';
      console.log(`  ? ${f.slice(0, 46).padEnd(48)} ${catno.slice(0, 14).padEnd(14)} ${pista}`);
      continue;
    }

    const yaEsta = yaEnAssets.get(clave(catno));
    if (yaEsta) {
      saltados++;
      console.log(`  = ${f.slice(0, 46).padEnd(48)} ${catno.padEnd(14)} ya está como ${yaEsta}`);
      continue;
    }
    const destDir = path.join(ASSETS, dist);
    const dest = path.join(destDir, `${nombreSeguro(catno)}.zip`);
    const origen = porDentro ? (porNombre && porNombre !== porDentro ? 'contenido' : porNombre ? 'ambos' : 'contenido') : 'nombre';

    if (fs.existsSync(dest)) {
      saltados++;
      console.log(`  = ${f.slice(0, 46).padEnd(48)} ${catno.padEnd(14)} ya está en ${dist}/`);
      continue;
    }
    console.log(`  ${APPLY ? '>' : '·'} ${f.slice(0, 46).padEnd(48)} ${catno.padEnd(14)} → ${dist}/${nombreSeguro(catno)}.zip  [${origen}]`);
    if (APPLY) {
      // Se apunta ya para que un segundo fichero del mismo disco —las copias
      // "(1)" que deja el navegador— no vuelva a moverse encima.
      yaEnAssets.set(clave(catno), `${dist}/${nombreSeguro(catno)}.zip`);
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(src, dest);
      // Quitar la marca de cuarentena que macOS pone a lo bajado del navegador.
      try { execFileSync('xattr', ['-c', dest]); } catch { /* da igual */ }
      movidos++;
    }
  }

  console.log();
  if (APPLY) console.log(`movidos ${movidos} · ya estaban ${saltados} · sin catno ${sinCatno} · sin destino ${sinDestino}`);
  else console.log(`se moverían ${zips.length - saltados - sinCatno - sinDestino} · ya están ${saltados} · sin catno ${sinCatno} · sin destino ${sinDestino}`);
  if (movidos) console.log('\nPulsa "Re-escanear" en el Pre-order tab para que los vea.');
}

main();
