/**
 * El filtro del vigia: de lo que la pagina trae en crudo se queda solo la
 * ESTRUCTURA, y de la estructura solo lo que la tienda no habia ensenado nunca.
 *
 * Por que asi (2026-10-19): la primera version comparaba textos de botones y
 * enlaces. Las portadas rotan discos cada semana, y "play: artista – titulo" o
 * "+11" salian como "controles nuevos": 175 cambios en un informe, ninguno una
 * funcion. Ahora:
 *
 *   formularios  accion + nombres de campo, con ids normalizados: /cart/add/186575
 *                y /cart/add/186639 son el mismo carrito
 *   scripts      dominios de terceros (y los de los iframes: embeds)
 *   aria / data  NOMBRES de atributo, nunca valores
 *   rutas        enlaces de cabecera, menu y pie: una seccion nueva sale ahi
 *   funciones    el unico texto que pasa: palabras-funcion de una lista corta
 *                (notify me, wishlist, pre-order…). Hay funciones que solo dejan
 *                rastro como texto de boton — el "notify me" de Hard Wax es un
 *                <a> sin formulario ni script propio.
 *
 * Y "nuevo" es contra todo lo visto antes en esa tienda, no contra la semana
 * pasada: el "notify me" de Hard Wax solo aparece cuando hay un disco agotado
 * en el listado, y semana si semana no parecia una funcion recien estrenada.
 *
 * Sin dependencias ni DOM: lo usan scout.mjs y los tests.
 */

export const TIPOS = ['forms', 'scripts', 'iframes', 'aria', 'data', 'rutas', 'funciones'];

/** Tipos todavia sin validar con capturas reales: el informe los marca. */
export const TIPOS_NUEVOS = new Set(['aria', 'data', 'rutas']);
export const CAPTURAS_PARA_VALIDAR = 2;

/** Orden del informe: ficha y carrito dicen mas de una tienda que la portada. */
export const PRIORIDAD = ['product', 'cart', 'listing', 'home'];

/**
 * Palabras-funcion. Corta a proposito: cada entrada es una funcion que una
 * tienda de discos monta, no una palabra que aparezca en un titulo.
 */
export const FUNCIONES = [
  ['aviso-reposicion', /notify me|back in stock|restock alert|email me when|benachrichtig|av[ií]same/i],
  ['wishlist', /wish ?list|merkliste|watch ?list|add to favou?rites/i],
  ['preventa', /pre-?order|vorbestell/i],
  ['pre-save', /pre-?save/i],
  ['tarjeta-regalo', /gift ?(card|voucher)|gutschein/i],
  ['suscripcion', /subscription|record club|membership/i],
  ['cola-escucha', /(add to|clear|open|close) (the )?(queue|crate)|enqueue|player queue/i],
  ['comparar', /^compare$|add to compare/i],
  ['seguimiento-pedido', /track (your |my )?order/i],
  ['recogida-tienda', /click ?(&|and) ?collect|pick ?up in store|abholung/i],
  ['pago-aplazado', /klarna|afterpay|clearpay|pay later|pay in [34]/i],
  ['chat', /live chat|chat with us/i],
  ['resenas-cliente', /write a review|customer reviews/i],
  ['seguir-artista', /follow (this )?(artist|label)/i],
];

/** Texto de un control que huele a catalogo: no se mira ni para funciones. */
const esContenido = t =>
  !t || t.length > 40 || (t.match(/\d/g) || []).length >= 3 || /[€$£¥]/.test(t);

export function funcionesDe(textos) {
  const out = new Set();
  for (const raw of textos || []) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (esContenido(t)) continue;
    for (const [k, re] of FUNCIONES) if (re.test(t)) out.add(k);
  }
  return [...out].sort();
}

/** Un trozo de ruta que es un disco, un id o un slug, no una seccion. */
export const esVariable = s =>
  /\d{3,}/.test(s) || s.length > 32 || /__|_.*_/.test(s) || /^[0-9a-f-]{8,}$/i.test(s) || /\.html?$/i.test(s);

const decodifica = s => { try { return decodeURIComponent(s); } catch { return s; } };
const trozos = path => String(path || '').split(/[?#]/)[0].split('/').filter(Boolean).map(decodifica);

/**
 * /cart/add/186575 → /cart/add/:id. La accion se queda entera (hasta 4 trozos)
 * porque en un formulario cada trozo es funcion.
 */
export function normAccion(accion) {
  const sinHost = String(accion || '').replace(/^(https?:)?\/\/[^/]+/, '');
  const t = trozos(sinHost).slice(0, 4).map(s => (esVariable(s) || /^\d+$/.test(s) ? ':id' : s.toLowerCase()));
  return t.length ? '/' + t.join('/') : '(misma pagina)';
}

/**
 * Acepta {action, campos} o la cadena "accion [a,b]" de la huella antigua.
 * `pagina` es la ruta de la pagina donde esta el formulario: un form que se
 * envia a si mismo en /record/vinyl/daydreaming-0 es "(misma pagina)", no una
 * ruta nueva por disco. Campos con el mismo prefijo se pliegan: genre[House],
 * genre[Breaks]… son catalogo; genre[*] es el filtro.
 * Devuelve null para un formulario sin accion ni campos: no dice nada.
 */
export function normForm(f, pagina = '') {
  let accion, campos;
  if (typeof f === 'string') {
    const m = f.match(/^(.*?) \[(.*)\]$/);
    accion = m ? m[1] : f;
    campos = m && m[2] ? m[2].split(',') : [];
  } else ({ action: accion, campos } = f);
  if (accion === '(misma pagina)') accion = '';
  const sinHost = String(accion || '').replace(/^(https?:)?\/\/[^/]+/, '').split(/[?#]/)[0];
  if (pagina && sinHost.replace(/\/$/, '') === String(pagina).replace(/\/$/, '')) accion = '';

  const nombres = (campos || []).map(x => String(x).trim()).filter(Boolean);
  const prefijo = x => (x.match(/^([^[]+)\[/) || [])[1];
  const veces = {};
  for (const x of nombres) if (prefijo(x)) veces[prefijo(x)] = (veces[prefijo(x)] || 0) + 1;
  const c = [...new Set(nombres
    .map(x => (veces[prefijo(x)] > 1 ? `${prefijo(x)}[*]` : x))
    .map(x => x.replace(/\d+/g, 'N')).filter(x => x.length < 32))].sort().slice(0, 8);
  const a = normAccion(accion);
  if (a === '(misma pagina)' && !c.length) return null;
  return `${a} [${c.join(',')}]`;
}

/** Contenedores que no son seccion por si mismos: se mira el trozo siguiente. */
const CONTENEDORES = new Set(['pages', 'page', 'collections', 'blogs', 'info', 'content', 'service', 'help', 'c']);
const PREFIJOS = new Set(['shop', 'store', 'en', 'de', 'nl', 'es', 'fr', 'uk', 'gb', 'en-gb', 'en-us', 'de-de']);

export function normRuta(path) {
  let t = trozos(path).map(s => s.toLowerCase());
  while (t.length && PREFIJOS.has(t[0])) t = t.slice(1);
  if (!t.length) return null;
  const cuantos = CONTENEDORES.has(t[0]) ? 2 : 1;
  const r = t.slice(0, cuantos);
  if (r.some(esVariable)) return null;      // un disco enlazado desde el menu no es una seccion
  return '/' + r.join('/');
}

/** data-v-3f2a1b (Vue), data-product-1234: nombres que cambian con el build o el disco. */
export const normDataAttr = n => (/\d|[0-9a-f]{6,}/i.test(n.replace(/^data-/, '')) ? null : n.toLowerCase());

const rutaDe = url => { try { return new URL(url).pathname; } catch { return ''; } };

/** Lo crudo de la pagina → huella guardable. Sin un solo texto de catalogo. */
export function huella(crudo) {
  const set = xs => [...new Set((xs || []).filter(Boolean))].sort();
  return {
    url: crudo.url,
    forms: set((crudo.forms || []).map(f => normForm(f, rutaDe(crudo.url)))),
    scripts: set(crudo.scripts),
    iframes: set(crudo.iframes),
    aria: set(crudo.aria),
    data: set((crudo.data || []).map(normDataAttr)),
    rutas: set((crudo.rutas || []).map(normRuta)),
    funciones: funcionesDe(crudo.textos),
  };
}

/**
 * Lo visto hasta ahora en una tienda, desde una huella de la version anterior
 * (controls/forms/scriptHosts). Solo los tipos que existian: el resto se toma
 * como base la primera vez, en vez de salir entero como "nuevo".
 */
export function vistosDesdeV1(viejo) {
  const pags = Object.values(viejo?.paginas || {});
  return {
    forms: [...new Set(pags.flatMap(p => (p.forms || []).map(f => normForm(f, rutaDe(p.url)))).filter(Boolean))],
    scripts: [...new Set(pags.flatMap(p => p.scriptHosts || []))],
    funciones: [...new Set(pags.flatMap(p => funcionesDe(p.controls)))],
  };
}

/**
 * @param viejo  snapshot anterior (v2, v1 o null)
 * @param nuevo  { paginas: { home|listing|product|cart: huella } }
 * @returns { candidatos, desaparecidos, vistos, capturas }
 *   candidatos     lo que esta tienda ensena por primera vez
 *   desaparecidos  lo que estaba en la captura anterior y ya no (paginas
 *                  presentes en las dos); solo se informa de la web propia
 */
export function compara(viejo, nuevo) {
  const v2 = viejo?.version === 2;
  const previos = viejo ? (v2 ? viejo.vistos : vistosDesdeV1(viejo)) : null;
  const capturasAntes = v2 ? (viejo.capturas || 0) : 0;
  const candidatos = [];
  const vistos = {};

  for (const tipo of TIPOS) {
    const base = previos?.[tipo];
    const ya = new Set(base || []);
    const anotado = new Set();
    for (const pagina of PRIORIDAD) {
      const p = nuevo.paginas[pagina];
      if (!p) continue;
      for (const valor of p[tipo] || []) {
        if (base && !ya.has(valor) && !anotado.has(valor)) {
          anotado.add(valor);
          candidatos.push({
            pagina, tipo, valor, url: p.url,
            sinValidar: TIPOS_NUEVOS.has(tipo) && capturasAntes < CAPTURAS_PARA_VALIDAR,
          });
        }
        ya.add(valor);
      }
    }
    vistos[tipo] = [...ya].sort();
  }

  const desaparecidos = [];
  if (v2) {
    for (const pagina of PRIORIDAD) {
      const a = viejo.paginas?.[pagina], b = nuevo.paginas[pagina];
      if (!a || !b) continue;
      for (const tipo of TIPOS) {
        const ahora = new Set(b[tipo] || []);
        for (const valor of a[tipo] || []) {
          if (!ahora.has(valor)) desaparecidos.push({
            pagina, tipo, valor, url: b.url,
            sinValidar: TIPOS_NUEVOS.has(tipo) && capturasAntes < CAPTURAS_PARA_VALIDAR,
          });
        }
      }
    }
  }

  return { candidatos, desaparecidos, vistos, capturas: capturasAntes + 1 };
}
