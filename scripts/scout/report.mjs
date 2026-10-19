#!/usr/bin/env node
/**
 * Convierte el diff de scout.mjs en un informe corto.
 *
 * Lo que pasa el filtro estructural lo juzga Claude (`claude -p`, la CLI con la
 * sesion de Eduardo: no hay clave nueva que guardar). Por cada tienda recibe el
 * antes y el despues, las funciones que House Only ya tiene (features.md y la
 * huella de houseonly.store) y devuelve, por funcion real, dos lineas: que es y
 * si encaja. Lo que no es funcion, o no encaja, se descarta en silencio; lo que
 * ya tenemos, tambien, salvo que ellos lo resuelvan de forma claramente
 * distinta (una linea).
 *
 * Si `claude -p` falla, el informe sale igual con los candidatos en crudo y lo
 * dice: un informe sin juicio es peor, pero mejor que ninguno.
 *
 *   node scripts/scout/report.mjs [docs/scout/diff-YYYY-MM-DD.json]
 *
 *   SCOUT_CLAUDE   ruta de la CLI (por defecto ~/.local/bin/claude, o `claude`)
 *   SCOUT_MODEL    modelo del juicio (por defecto sonnet)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIORIDAD, TIPOS } from './filtro.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR  = join(RAIZ, 'docs', 'scout');

const arg = process.argv[2];
const ruta = arg || join(DIR, readdirSync(DIR).filter(f => /^diff-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop() || '');
const d = JSON.parse(readFileSync(ruta, 'utf8'));
if (d.version !== 2) { console.error(`  ${ruta} es de la version anterior del vigia`); process.exit(1); }

const NOMBRE_PAGINA = { product: 'ficha', cart: 'carrito', listing: 'listado', home: 'portada' };
const NOMBRE_TIPO = {
  forms: 'formulario', scripts: 'script', iframes: 'iframe', aria: 'atributo aria',
  data: 'atributo data', rutas: 'ruta', funciones: 'función',
};
const SIN_VALIDAR = ' _(sin validar)_';

// ── HOUSE ONLY ──────────────────────────────────────────────────────
const propia = d.tiendas.find(t => t.propia);
const features = existsSync(join(DIR, 'features.md')) ? readFileSync(join(DIR, 'features.md'), 'utf8') : '';
/** Huella de nuestra web, todas las paginas juntas: ¿esto ya lo tenemos? */
const nuestra = {};
for (const tipo of TIPOS) {
  nuestra[tipo] = [...new Set(Object.values(propia?.ahora || {}).flatMap(p => p[tipo] || []))].sort();
}

// ── EL JUICIO ───────────────────────────────────────────────────────
const SISTEMA = `Eres el juez del vigía de House Only, una tienda online pequeña de vinilos de música electrónica (house, techno, disco) hecha sobre Shopify con frontend propio.

Recibes los cambios ESTRUCTURALES que el vigía ha visto por primera vez en las webs de otras tiendas de discos: formularios (acción y nombres de campo), scripts e iframes de terceros (dominios), nombres de atributos aria-*/data-*, rutas nuevas en menús y pie, y palabras-función de botones. Con cada tienda y página vienen lo que tenía antes y lo que tiene ahora. También recibes lo que House Only ya tiene: su inventario de funciones (features.md) y la misma huella sacada de houseonly.store.

Para cada FUNCIÓN real para el cliente (agrupa en una los cambios que sean la misma, aunque vengan de varias tiendas):
- queEs: una frase, qué hace para quien compra.
- encaje: una frase concreta de por qué le sirve a House Only.

Reglas:
- Solo ideas: nunca propongas copiar diseño, textos ni imágenes.
- Lo que no sea una función para el cliente (analítica, publicidad, trackers, píxeles, CDN, cambios de framework o de build, accesibilidad genérica, muros de cookies) → descartar: true.
- Lo que no encaje con House Only → descartar: true. Sin explicarlo.
- Si House Only ya lo tiene → yaLoTenemos: true; en "distinto" una frase SOLO si la otra tienda lo resuelve de forma claramente distinta (si no, cadena vacía).
- En "ids" copia los id de TODOS los candidatos que cubre la función; cada candidato en una sola función.
- Cada tienda trae "yaReportadas": funciones suyas que ya salieron otra semana. Si un candidato es una de ellas, usa EXACTAMENTE ese nombre.
- Pon nombres cortos y estables ("Aviso de vuelta a stock", "Tarjeta regalo"): el mismo para la misma función en todas las tiendas.
- Castellano, frases cortas, sin adornos.`;

const ESQUEMA = {
  type: 'object',
  properties: {
    funciones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          nombre: { type: 'string' },
          queEs: { type: 'string' },
          encaje: { type: 'string' },
          descartar: { type: 'boolean' },
          yaLoTenemos: { type: 'boolean' },
          distinto: { type: 'string' },
        },
        required: ['ids', 'nombre', 'queEs', 'encaje', 'descartar', 'yaLoTenemos', 'distinto'],
      },
    },
  },
  required: ['funciones'],
};

const CLAUDE = process.env.SCOUT_CLAUDE ||
  (existsSync(join(homedir(), '.local', 'bin', 'claude')) ? join(homedir(), '.local', 'bin', 'claude') : 'claude');

/** Solo los tipos que aparecen en los candidatos: el contexto justo. */
function contexto(t) {
  const tipos = [...new Set(t.candidatos.map(c => c.tipo))];
  const paginas = [...new Set(t.candidatos.map(c => c.pagina))];
  const recorta = p => (p ? Object.fromEntries(tipos.map(k => [k, (p[k] || []).slice(0, 60)])) : null);
  return Object.fromEntries(paginas.map(n => [n, {
    url: t.ahora?.[n]?.url,
    antes: recorta(t.antes?.[n]) || 'sin huella anterior de esta página con este detalle',
    ahora: recorta(t.ahora?.[n]),
  }]));
}

/** Un solo juicio para todas las tiendas: la misma funcion vista en seis
 * tiendas sale en una linea, no en seis. */
function juzga(tiendas) {
  const entrada = {
    tiendas: tiendas.map(t => ({
      tienda: t.name,
      yaReportadas: t.yaReportadas,
      candidatos: t.candidatos.map(c => ({
        id: c.id, pagina: c.pagina, tipo: c.tipo, valor: c.valor,
        tambienEnHouseOnly: (nuestra[c.tipo] || []).includes(c.valor),
      })),
      paginas: contexto(t),
    })),
    houseOnly: { features: features || '(sin features.md)', huella: nuestra },
  };
  const r = spawnSync(CLAUDE, [
    '-p', JSON.stringify(entrada),
    '--output-format', 'json',
    '--model', process.env.SCOUT_MODEL || 'sonnet',
    '--system-prompt', SISTEMA,
    '--json-schema', JSON.stringify(ESQUEMA),
    // Sin herramientas, sin MCP, sin skills, sin ajustes ni CLAUDE.md: un juicio
    // de centimos en vez de cargar 140k tokens de contexto.
    '--tools', '',
    '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '',
    '--no-session-persistence',
  ], { cwd: tmpdir(), encoding: 'utf8', timeout: 300_000, maxBuffer: 10_000_000 });
  try {
    const out = JSON.parse(r.stdout);
    if (out.is_error || !out.structured_output) throw new Error(out.result || 'sin salida estructurada');
    return { funciones: out.structured_output.funciones, coste: out.total_cost_usd || 0 };
  } catch (e) {
    return { error: String(r.error?.message || r.stderr || e.message || e).split('\n')[0].slice(0, 160) };
  }
}

// ── EL INFORME ──────────────────────────────────────────────────────
const orden = c => PRIORIDAD.indexOf(c.pagina);
const L = [];
const yaTenemos = [];   // detras de las ideas: es contexto, no propuesta
const adjuntos = [];
let coste = 0, sinJuicio = 0;

// ── LO YA JUZGADO ───────────────────────────────────────────────────
/**
 * docs/scout/juicios.json: cada candidato juzgado, por tienda, con su veredicto
 * y la semana en que se detecto. La CLI no deja fijar la temperatura, asi que
 * el juicio puede variar entre pasadas; este registro hace que no importe:
 *
 *   - un candidato se juzga UNA vez; volver a generar el informe de la misma
 *     semana reutiliza el veredicto guardado y sale identico
 *   - una funcion se reporta una sola vez por tienda, la semana que se detecta
 *     (el juez recibe las ya reportadas y las reconoce por su nombre)
 *   - si `claude -p` falla, los candidatos quedan "pendiente" y se juzgan la
 *     semana siguiente: no se pierden aunque scout.mjs ya los de por vistos
 */
const RUTA_JUICIOS = join(DIR, 'juicios.json');
const juicios = existsSync(RUTA_JUICIOS) ? JSON.parse(readFileSync(RUTA_JUICIOS, 'utf8')) : { tiendas: {} };
const deTienda = key => (juicios.tiendas[key] ||= { candidatos: {}, funciones: {} });
const clave = c => `${c.tipo}:${c.valor}`;

const porId = new Map();
const repetidos = [];       // juzgados esta misma semana en una pasada anterior
const ajenas = [];
for (const t of d.tiendas.filter(t => !t.propia)) {
  const reg = deTienda(t.key);
  const actuales = new Set(t.candidatos.map(clave));
  const pendientes = Object.entries(reg.candidatos)
    .filter(([k, v]) => v.decision === 'pendiente' && !actuales.has(k))
    .map(([, v]) => ({ pagina: v.pagina, tipo: v.tipo, valor: v.valor, url: v.url, sinValidar: v.sinValidar }));
  const porJuzgar = [];
  for (const c of [...t.candidatos, ...pendientes]) {
    const v = reg.candidatos[clave(c)];
    if (!v || v.decision === 'pendiente') porJuzgar.push(c);
    else if (v.fecha === d.fecha) repetidos.push({ c, t, v });
  }
  if (!porJuzgar.length) continue;
  porJuzgar.sort((a, b) => orden(a) - orden(b));
  porJuzgar.forEach((c, i) => { c.id = `${t.key}-${i + 1}`; porId.set(c.id, { ...c, tienda: t }); });
  ajenas.push({ ...t, candidatos: porJuzgar, yaReportadas: Object.keys(reg.funciones).filter(n => reg.funciones[n].fecha !== d.fecha) });
}

const guarda = (t, c, decision, funcion = null) => {
  deTienda(t.key).candidatos[clave(c)] = {
    fecha: d.fecha, decision, funcion,
    pagina: c.pagina, tipo: c.tipo, valor: c.valor, url: c.url || null, sinValidar: !!c.sinValidar,
  };
};

/** nombre → { texto, cubre: [{tienda, pagina, sinValidar}] }: lo que sale esta semana. */
const salen = new Map();
const sale = (nombre, texto, t, c) => {
  if (!salen.has(nombre)) salen.set(nombre, { nombre, ...texto, cubre: [] });
  salen.get(nombre).cubre.push({ tienda: t, pagina: c.pagina, sinValidar: !!c.sinValidar });
};
for (const { c, t, v } of repetidos) {
  const f = v.funcion && deTienda(t.key).funciones[v.funcion];
  if (f && f.fecha === d.fecha && (v.decision === 'reportada' || v.decision === 'ya-lo-tenemos')) sale(v.funcion, f, t, c);
}

const j = ajenas.length ? juzga(ajenas) : { funciones: [], coste: 0 };
if (j.error) {
  sinJuicio = ajenas.length;
  console.error(`  sin juicio (${j.error})`);
  for (const t of ajenas) for (const c of t.candidatos) {
    guarda(t, c, 'pendiente');
    L.push(`- **${t.name}** · ${NOMBRE_PAGINA[c.pagina]} — ${NOMBRE_TIPO[c.tipo]} \`${c.valor}\`${c.sinValidar ? SIN_VALIDAR : ''} (sin juicio)`);
  }
} else {
  coste = j.coste;
  const cubiertos = new Set();
  for (const f of j.funciones) {
    const decision = f.descartar ? 'descartada' : f.yaLoTenemos ? 'ya-lo-tenemos' : 'reportada';
    const texto = { queEs: f.queEs, encaje: f.encaje, distinto: f.distinto || '', decision };
    for (const id of f.ids) {
      const c = porId.get(id);
      if (!c || cubiertos.has(id)) continue;
      cubiertos.add(id);
      const t = c.tienda, reg = deTienda(t.key);
      guarda(t, c, decision, f.nombre);
      if (decision === 'descartada') continue;
      const previa = reg.funciones[f.nombre];
      if (previa && previa.fecha !== d.fecha) continue;   // ya reportada otra semana
      reg.funciones[f.nombre] ||= { fecha: d.fecha, ...texto };
      sale(f.nombre, reg.funciones[f.nombre], t, c);
    }
  }
  // Lo que el juez no metio en ninguna funcion lo vio y no le dio valor.
  for (const [id, c] of porId) if (!cubiertos.has(id)) guarda(c.tienda, c, 'descartada');
}

// Lo mas interesante primero: lo que sale en ficha o carrito antes que en portada.
// Orden fijo (pagina, nombre; tiendas como en sites.json): la misma semana sale
// siempre igual, se juzgue ahora o se reutilice el veredicto guardado.
const posTienda = t => d.tiendas.findIndex(x => x.key === t.key);
const primeraPag = f => Math.min(...f.cubre.map(orden));
for (const f of [...salen.values()].sort((a, b) => primeraPag(a) - primeraPag(b) || a.nombre.localeCompare(b.nombre))) {
  f.cubre.sort((a, b) => posTienda(a.tienda) - posTienda(b.tienda) || orden(a) - orden(b));
  const tiendas = [...new Set(f.cubre.map(c => c.tienda.name))].join(', ');
  const pagina = NOMBRE_PAGINA[f.cubre.reduce((m, c) => (orden(c) < orden(m) ? c : m)).pagina];
  const marca = f.cubre.some(c => c.sinValidar) ? SIN_VALIDAR : '';
  if (f.decision === 'ya-lo-tenemos') {
    if (f.distinto) yaTenemos.push(`- ${tiendas} · ${f.nombre} — ya lo tenemos; ellos lo hacen así: ${f.distinto}${marca}`);
    continue;
  }
  L.push(`- **${tiendas}** · ${pagina} — **${f.nombre}**: ${f.queEs}${marca}`);
  L.push(`  ${f.encaje}`);
  const primera = f.cubre[0];
  const shot = primera.tienda.shots?.[primera.pagina];
  if (shot && !adjuntos.includes(shot)) adjuntos.push(shot);
}
writeFileSync(RUTA_JUICIOS, JSON.stringify(juicios, null, 1) + '\n');

// Lo que desaparece de nuestra web: un formulario o un script que se va sin
// que nadie lo haya quitado a proposito es una funcion rota.
const perdidas = [];
for (const pagina of PRIORIDAD) {
  const xs = (propia?.desaparecidos || []).filter(c => c.pagina === pagina);
  if (!xs.length) continue;
  perdidas.push(`- ${NOMBRE_PAGINA[pagina]}: ${xs.map(c => `${NOMBRE_TIPO[c.tipo]} \`${c.valor}\`${c.sinValidar ? SIN_VALIDAR : ''}`).join(', ')}`);
}

const rotas = d.tiendas.filter(t => t.errores.length);
const pie = [];
if (perdidas.length) pie.push('', '**Desaparecido de houseonly.store** desde la captura anterior:', ...perdidas);
if (rotas.length) {
  pie.push('', `No se dejaron ver: ${rotas.map(t => `${t.name} (${t.errores.map(e => e.split(' — ')[0]).join('; ')})`).join(' · ')}.`);
}
const primeras = d.tiendas.filter(t => t.primeraVez && t.paginas.length);
if (primeras.length) pie.push('', `Primera huella, sin comparación: ${primeras.map(t => t.name).join(', ')}.`);
if (sinJuicio) pie.push('', `Sin juicio: \`claude -p\` falló; van los cambios en crudo de ${sinJuicio} tienda(s).`);

if (yaTenemos.length) L.push(...yaTenemos);
const titulo = L.length
  ? `Vigía de tiendas · ${d.fecha}`
  : `Vigía de tiendas · ${d.fecha} — semana sin funciones nuevas${perdidas.length ? ', pero algo desapareció de houseonly.store' : ''}.`;
const md = [`# ${titulo}`, ...(L.length ? ['', ...L] : []), ...pie].join('\n') + '\n';

// diff-2026-10-19.json → 2026-10-19.md (y diff-…-prueba.json → …-prueba.md).
const salida = join(DIR, `${basename(ruta).replace(/^diff-/, '').replace(/\.json$/, '')}.md`);
writeFileSync(salida, md);
// Para send.mjs: asunto y capturas de lo que de verdad sale en el informe.
const conFunciones = [...new Set(L.filter(l => l.startsWith('- **')).flatMap(l => l.match(/^- \*\*(.+?)\*\*/)[1].split(', ')))];
d.informe = {
  asunto: conFunciones.length
    ? `Vigía de tiendas · ${conFunciones.slice(0, 3).join(', ')}${conFunciones.length > 3 ? ` y ${conFunciones.length - 3} más` : ''} — ${d.fecha}`
    : `Vigía de tiendas · ${perdidas.length ? 'algo desapareció de houseonly.store' : 'semana sin funciones nuevas'} — ${d.fecha}`,
  adjuntos: adjuntos.slice(0, 4),
  coste,
};
writeFileSync(ruta, JSON.stringify(d, null, 1));
console.log(`  informe en ${salida}${coste ? ` · juicio ${coste.toFixed(3)} $` : ''}`);
