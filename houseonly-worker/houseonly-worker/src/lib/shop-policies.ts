// ── POLITICAS DE LA TIENDA (shopPolicies) ───────────────────────────
//
// Las paginas /shipping, /returns, /contact, /privacy, /terms y /legal de la
// tienda pintan el texto que hay en Shopify, sin copias a mano: si se cambia
// una politica en el admin de Shopify, el siguiente build (y la app, en menos
// de una hora) la recogen.
//
// Por que en el worker: el prerender de Pages solo tiene el token publico de
// la Storefront, y la Storefront devuelve VACIOS el body de Privacy y Terms
// (comprobado 2026-10-09) y no expone Contact ni Legal notice. La Admin API
// (`shop.shopPolicies`, scope read_legal_policies) los da todos.
//
// El HTML de Shopify se limpia AQUI, una sola vez, para el prerender y para la
// app: solo p, strong, a (href http/https/mailto/tel o ruta local), ul, li y
// h2. Las lineas en negrita o en mayusculas que abren un bloque
// ("<p><strong>Damages and issues</strong><br>…") pasan a h2, y los <br><br>
// separan parrafos.
//
// Cache: SYNC_STATE `shop:policies`, 1 hora (expirationTtl), y la misma cabecera
// Cache-Control en la respuesta. Un fallo se recuerda 5 min.

import { shopifyAdminGraphQL, type ShopifyAdminEnv } from './shopify-admin';

export interface ShopPoliciesEnv extends ShopifyAdminEnv {
  SYNC_STATE: KVNamespace;
}

export interface CleanPolicy {
  type: string;          // ShopPolicyType: SHIPPING_POLICY, REFUND_POLICY, ...
  title: string;
  html: string;          // ya limpio
  lastUpdated: string;   // "Last updated: …" si la politica lo trae (se pinta aparte)
  url: string;           // la pagina de Shopify (checkout.shopify.com)
  updatedAt: string;
}

export const SHOP_POLICIES_KEY = 'shop:policies';
export const SHOP_POLICIES_ERROR_KEY = 'shop:policies:error';
const TTL_S = 3600;
const ERROR_TTL_S = 300;

// ── limpieza ───────────────────────────────────────────────────────

const ENT: Record<string, string> = { '&nbsp;': ' ', '&#160;': ' ' };

function hrefSeguro(raw: string): string {
  const h = raw.trim().replace(/&amp;/g, '&');
  if (/^(https?:|mailto:|tel:)/i.test(h) || /^\/(?!\/)/.test(h)) return h.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return '';
}

/** Texto visible de un trozo de HTML (para decidir si un bloque es un titulo). */
function textoDe(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** ¿Este parrafo es en realidad un titulo de seccion? */
function esTitulo(inner: string): boolean {
  const t = textoDe(inner);
  if (!t || t.length > 90 || /[.:;,]$/.test(t) && !/^[A-Z0-9 \-–—&/()]+:$/.test(t)) return false;
  // Todo en negrita…
  if (/^\s*<strong>[\s\S]*<\/strong>\s*$/.test(inner) && !/<\/strong>[\s\S]*<strong>/.test(inner)) return true;
  // …o todo en mayusculas ("SECTION 1 - ONLINE STORE TERMS").
  return /[A-Z]/.test(t) && t === t.toUpperCase() && t.length >= 4;
}

export function cleanPolicyHtml(raw: string): string {
  let h = String(raw || '');
  // 1 · fuera lo que no es contenido
  h = h.replace(/<!--[\s\S]*?-->/g, '')
       .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, '')
       .replace(/<(meta|link)\b[^>]*>/gi, '');
  for (const [k, v] of Object.entries(ENT)) h = h.split(k).join(v);

  // 1b · Titulos numerados guardados como lista de un solo punto: Shopify
  // escribe "<ol start="3"><li>Pre-orders and requests</li></ol>" (Terms of
  // Service, 2026-10-10). Si el unico punto es corto y no acaba en punto, es un
  // titulo: "<h2>3. Pre-orders and requests</h2>".
  // (El contenido del punto no puede llevar otro <li>: si no, una lista de
  // varios puntos se tomaria por uno solo.)
  h = h.replace(/<ol\b([^>]*)>\s*<li\b[^>]*>((?:(?!<li\b)[\s\S])*?)<\/li>\s*<\/ol>/gi, (m, attrs: string, li: string) => {
    const t = textoDe(li);
    if (!t || t.length > 90 || /[.;:]$/.test(t)) return m;
    const n = parseInt((attrs.match(/\bstart\s*=\s*["']?(\d+)/i) || [])[1] || '1', 10);
    return `<h2>${n}. ${t}</h2>`;
  });

  // 2 · cada etiqueta a su forma permitida, sin atributos (salvo href)
  h = h.replace(/<\s*(\/?)\s*([a-z][a-z0-9]*)\b([^>]*)>/gi, (_m, cierre: string, tag: string, attrs: string) => {
    const t = tag.toLowerCase();
    if (t === 'br') return '\n';
    if (/^h[1-6]$/.test(t)) return `<${cierre}h2>`;
    if (t === 'b' || t === 'strong') return `<${cierre}strong>`;
    // em/i acaban tambien en strong (al final, ver abajo): los destacados de
    // Shopify ("<em>Spain</em> Standard Shipping") no se pierden. Hasta entonces
    // van aparte para que un destacado no se tome por un titulo.
    if (t === 'em' || t === 'i') return `<${cierre}em>`;
    if (t === 'ol' || t === 'ul') return `<${cierre}ul>`;
    if (t === 'li') return `<${cierre}li>`;
    if (t === 'p' || t === 'div') return cierre ? '</p>' : '<p>';
    if (t === 'a') {
      if (cierre) return '</a>';
      const href = hrefSeguro((attrs.match(/\bhref\s*=\s*"([^"]*)"/i) || attrs.match(/\bhref\s*=\s*'([^']*)'/i) || [])[1] || '');
      return href ? `<a href="${href}">` : '<a>';
    }
    return '';                                  // span, em, u, font, table…: solo el texto
  });
  h = h.replace(/<a>([\s\S]*?)<\/a>/g, '$1');    // enlaces sin href valido: texto

  // 3 · parrafos: <br><br> separa, un <br> suelto es un espacio. Un parrafo que
  // empieza con su titulo ("<strong>X</strong>\n texto") se parte en h2 + p.
  const bloques: string[] = [];
  const partes = h.split(/(<\/?(?:p|h2|ul)>)/);
  let modo: 'p' | 'h2' | 'ul' | null = null, buf = '';
  const vaciar = () => {
    const b = buf; buf = '';
    if (modo === 'h2') { const t = b.replace(/\n+/g, ' ').trim(); if (textoDe(t)) bloques.push(`<h2>${textoDe(t)}</h2>`); return; }
    if (modo === 'ul') { const t = b.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim(); if (textoDe(t)) bloques.push(`<ul>${t}</ul>`); return; }
    for (const trozo of b.split(/\n\s*\n+/)) {
      let t = trozo.trim();
      if (!t) continue;
      // Titulo que abre el parrafo: tras un <br> ("<strong>X</strong><br>texto")
      // o en linea ("<strong>Processing time</strong> All orders…"). En linea
      // solo si es corto, sin puntuacion final y lo que sigue empieza en
      // mayuscula: "<strong>Note:</strong> prices…" se queda como esta.
      const m = t.match(/^(<strong>[^<]*<\/strong>)\s*\n([\s\S]+)$/)
        || t.match(/^(<strong>[^<]{2,60}<\/strong>)\s+(?=[A-Z0-9¿¡“"(])([\s\S]+)$/);
      if (m && esTitulo(m[1]) && !/[.:;,!?]\s*$/.test(textoDe(m[1]))) { bloques.push(`<h2>${textoDe(m[1])}</h2>`); t = m[2].trim(); }
      t = t.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
      if (!textoDe(t)) continue;
      bloques.push(esTitulo(t) ? `<h2>${textoDe(t)}</h2>` : `<p>${t}</p>`);
    }
  };
  for (const p of partes) {
    if (p === '<p>' || p === '<h2>' || p === '<ul>') { if (modo !== 'ul' || p === '<ul>') { vaciar(); modo = p.slice(1, -1) as any; } }
    else if (p === '</p>' || p === '</h2>' || p === '</ul>') { if (p === '</ul>' || modo !== 'ul') { vaciar(); modo = null; } }
    else buf += p;
  }
  vaciar();
  return bloques.join('\n')
    .replace(/<(\/?)em>/g, '<$1strong>')
    .replace(/<strong>\s*<\/strong>/g, '')
    .replace(/<li>\s*<\/li>/g, '');
}

// ── reglas por politica ────────────────────────────────────────────
// Lo que no es limpieza generica sino de una politica concreta, sobre el HTML
// ya limpio. Si cambia el texto en Shopify y la frase deja de estar, la regla
// simplemente no hace nada.

const REGLAS: Record<string, (html: string) => string> = {
  // /returns: dos bloques que en Shopify no llevan titulo.
  REFUND_POLICY: (h) => h
    .replace(/(<p>If a record arrives damaged)/, '<h2>Damaged, defective or wrong records</h2>\n$1')
    .replace(/(<p>If you[’']re in the EU)/, '<h2>EU customers</h2>\n$1'),
  // /contact: la pagina ya pone el correo en grande (mailto) y debajo Instagram
  // y Discogs. Del texto de Shopify sale la linea de Instagram y el mailto se
  // queda como texto, para que cada enlace aparezca una sola vez.
  CONTACT_INFORMATION: (h) => h
    .replace(/<p>[^<]*Instagram\b[^<]*(?:<a href="https?:\/\/(?:www\.)?instagram\.com[^"]*">[^<]*<\/a>)?[^<]*<\/p>\n?/gi, '')
    .replace(/<a href="mailto:[^"]*">([^<]*)<\/a>/g, '$1'),
};

/** Limpieza completa de una politica: generica, titulo repetido, "Last updated" y reglas propias. */
export function prepararPolitica(type: string, title: string, body: string): { html: string; lastUpdated: string } {
  let html = cleanPolicyHtml(body);
  // Muchas politicas abren repitiendo su titulo ("Contact information" bajo
  // "Contact", "Terms of Service — House Only"): la pagina ya lo pone en su h1.
  // Se quita un primer h2 que EMPIECE por el titulo.
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const primero = html.match(/^<h2>([^<]*)<\/h2>\n?/);
  if (primero && norm(title) && norm(primero[1]).startsWith(norm(title))) html = html.slice(primero[0].length);
  // "Last updated: …" al principio: va aparte, en pequeno bajo el titulo.
  let lastUpdated = '';
  const lu = html.match(/^(?:<h2>[^<]*<\/h2>\n)?<p>\s*(Last updated\b[^<]*?)\s*<\/p>\n?/i);
  if (lu) { lastUpdated = lu[1].trim(); html = html.replace(lu[0].replace(/^<h2>[^<]*<\/h2>\n/, ''), ''); }
  if (REGLAS[type]) html = REGLAS[type](html);
  return { html: html.trim(), lastUpdated };
}

// ── Admin API ──────────────────────────────────────────────────────

const QUERY = `{ shop { shopPolicies { type title body url updatedAt } } }`;

export async function fetchShopPolicies(env: ShopifyAdminEnv): Promise<CleanPolicy[]> {
  // Un token emitido antes de anadir el scope lo renueva shopifyAdminGraphQL.
  const r = await shopifyAdminGraphQL(env, QUERY);
  if (r.errors?.length) throw new Error(`Admin API: ${r.errors[0].message}`);
  const lista = r.data?.shop?.shopPolicies;
  if (!Array.isArray(lista)) throw new Error('Admin API: shopPolicies no vino');
  return lista
    .filter((p: any) => p && String(p.body || '').trim())
    .map((p: any) => {
      const { html, lastUpdated } = prepararPolitica(p.type, p.title || '', p.body);
      return { type: p.type, title: p.title || '', html, lastUpdated, url: p.url || '', updatedAt: p.updatedAt || '' };
    });
}

/** GET ?action=shop-policies — publico, 1 h de cache (KV + Cache-Control). */
export async function handleShopPolicies(env: ShopPoliciesEnv): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': `public, max-age=${TTL_S}` };
  const enKv = await env.SYNC_STATE.get(SHOP_POLICIES_KEY);
  if (enKv) return new Response(enKv, { headers });
  // Un fallo reciente se recuerda 5 min: cada visita no puede costar una
  // peticion de token a Shopify mientras falte el scope.
  const fallo = await env.SYNC_STATE.get(SHOP_POLICIES_ERROR_KEY);
  if (fallo) return new Response(JSON.stringify({ error: fallo, cached: true }), {
    status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
  try {
    const body = JSON.stringify({ policies: await fetchShopPolicies(env), fetchedAt: new Date().toISOString() });
    await env.SYNC_STATE.put(SHOP_POLICIES_KEY, body, { expirationTtl: TTL_S });
    return new Response(body, { headers });
  } catch (e: any) {
    const msg = e?.message || String(e);
    await env.SYNC_STATE.put(SHOP_POLICIES_ERROR_KEY, msg, { expirationTtl: ERROR_TTL_S });
    return new Response(JSON.stringify({ error: msg }), {
      status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
