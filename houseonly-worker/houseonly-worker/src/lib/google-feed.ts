// ── FEED DE GOOGLE MERCHANT CENTER ──────────────────────────────────
//
// RSS 2.0 con el namespace g: de Google Shopping. Un item por disco que se
// puede comprar YA: producto ACTIVE con stock > 0 y sin el tag `forthcoming`.
// Es la misma regla con la que la rejilla principal esconde lo que no se vende
// en el momento: los pre-orders llevan `forthcoming`, y los request/backorder
// tienen stock 0.
//
// Se genera recorriendo la Admin API (status:active, paginada) y se guarda en
// SYNC_STATE (`google:feed`, con fecha y recuento en los metadatos). El GET
// sirve de KV; si no hay nada, genera en el momento. Lo regenera el cron
// diario de las 06:00 y, a mano, POST ?action=google-feed-rebuild.
//
// Decisiones (docs/sessions/2026-10-09-google-merchant.md):
//   - g:link usa el SLUG del sitio (makeReleaseSlug con el vendor tal cual y el
//     SKU de la primera variante, como scripts/prerender.mjs), NO el handle:
//     /products/<handle>/ sirve la portada, no la ficha (comprobado en prod).
//   - g:google_product_category 543523 = "Media > Music & Sound Recordings >
//     Records & LPs" (taxonomia oficial de Google, version 2021-09-21; no hay
//     una hoja "Vinyl").
//   - Sin g:shipping_weight: el peso en Shopify es un 0,5 kg generico.

import { shopifyAdminGraphQL, type ShopifyAdminEnv } from './shopify-admin';
import { makeReleaseSlug } from './slug';
import { descripcionDeProducto } from './html-text.mjs';

export interface GoogleFeedEnv extends ShopifyAdminEnv {
  SYNC_STATE: KVNamespace;
}

export const GOOGLE_FEED_KEY = 'google:feed';
export const GOOGLE_PRODUCT_CATEGORY = '543523';
const SITE = 'https://houseonly.store';

/** Lo que hace falta de cada producto de la Admin API. */
export interface AdminProduct {
  handle: string;
  title: string;
  vendor: string;
  status?: string;
  tags: string[];
  descriptionHtml: string;
  featuredMedia?: { preview?: { image?: { url?: string } | null } | null } | null;
  variants: { nodes: Array<{ sku: string | null; barcode: string | null; price: string; inventoryQuantity: number | null }> };
}

export interface FeedItem {
  id: string;
  title: string;
  description: string;
  link: string;
  image_link: string;
  price: string;
  brand: string;
  mpn: string;
  gtin: string;
}

export type SkipReason = 'forthcoming' | 'sin_stock' | 'sin_sku' | 'sin_imagen' | 'no_activo';

// ── reglas ─────────────────────────────────────────────────────────

/**
 * GTIN valido para Google: 8, 12, 13 o 14 digitos con el digito de control GS1
 * correcto. Devuelve el codigo limpio o '' si no vale.
 */
export function gtinValido(raw: string | null | undefined): string {
  const code = String(raw || '').replace(/[\s-]/g, '');
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return '';
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  // Desde la derecha (sin el de control): pesos 3, 1, 3, 1…
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check ? code : '';
}

const recorta = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…');

function selloDeTags(tags: string[]): string {
  const t = (tags || []).find(x => /^label:/i.test(x));
  return t ? t.slice(t.indexOf(':') + 1).trim() : '';
}

/** Producto de la Admin API → item del feed, o el motivo por el que no entra. */
export function productoAItem(p: AdminProduct): FeedItem | { skip: SkipReason } {
  if (p.status && p.status !== 'ACTIVE') return { skip: 'no_activo' };
  if ((p.tags || []).includes('forthcoming')) return { skip: 'forthcoming' };
  const variantes = p.variants?.nodes || [];
  const conStock = variantes.find(v => (v.inventoryQuantity ?? 0) > 0);
  if (!conStock) return { skip: 'sin_stock' };
  const sku = (conStock.sku || '').trim();
  if (!sku) return { skip: 'sin_sku' };
  const image = p.featuredMedia?.preview?.image?.url || '';
  if (!image) return { skip: 'sin_imagen' };

  // Como parseProduct: el vendor por defecto de Shopify no es un artista.
  const vendor = (p.vendor || '').trim();
  const artista = vendor === 'House Only' ? '' : vendor;
  const titulo = (p.title || '').trim();
  const title = recorta(artista ? `${artista} – ${titulo}` : titulo, 150);
  const texto = descripcionDeProducto(p.descriptionHtml || '').texto;
  // El slug de la pagina prerenderizada: vendor tal cual y SKU de la PRIMERA
  // variante (scripts/prerender.mjs), no el de la variante con stock.
  const slug = makeReleaseSlug(vendor, titulo, variantes[0]?.sku || sku);

  return {
    id: sku,
    title,
    description: recorta(texto || title, 5000),
    link: `${SITE}/products/${slug}/`,
    image_link: image,
    price: `${Number(conStock.price || 0).toFixed(2)} EUR`,
    brand: selloDeTags(p.tags),
    mpn: sku,
    gtin: gtinValido(conStock.barcode),
  };
}

// ── XML ────────────────────────────────────────────────────────────

export function escapeXml(s: string): string {
  return String(s ?? '')
    // Caracteres que XML 1.0 no admite ni escapados.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function itemXml(it: FeedItem): string {
  const campo = (k: string, v: string) => `      <g:${k}>${escapeXml(v)}</g:${k}>`;
  const lineas = [
    campo('id', it.id),
    campo('title', it.title),
    campo('description', it.description),
    campo('link', it.link),
    campo('image_link', it.image_link),
    campo('price', it.price),
    campo('availability', 'in_stock'),
    campo('condition', 'new'),
    ...(it.brand ? [campo('brand', it.brand)] : []),
    campo('mpn', it.mpn),
    ...(it.gtin ? [campo('gtin', it.gtin)] : [campo('identifier_exists', 'no')]),
    campo('google_product_category', GOOGLE_PRODUCT_CATEGORY),
    campo('product_type', 'Vinyl'),
  ];
  return `    <item>\n${lineas.join('\n')}\n    </item>`;
}

export function renderFeedXml(items: FeedItem[], builtAt: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>House Only</title>
    <link>${SITE}</link>
    <description>House Only — vinyl records in stock. Generated ${escapeXml(builtAt)}.</description>
${items.map(itemXml).join('\n')}
  </channel>
</rss>
`;
}

// ── generacion ─────────────────────────────────────────────────────

const PRODUCTS_QUERY = `
  query googleFeed($cursor: String) {
    products(first: 50, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        handle title vendor status tags descriptionHtml
        featuredMedia { preview { image { url } } }
        variants(first: 5) { nodes { sku barcode price inventoryQuantity } }
      }
    }
  }
`;

export interface FeedBuild {
  xml: string;
  builtAt: string;
  count: number;
  activos: number;
  saltados: Partial<Record<SkipReason, number>>;
}

export async function buildGoogleFeed(env: GoogleFeedEnv): Promise<FeedBuild> {
  const items: FeedItem[] = [];
  const saltados: Partial<Record<SkipReason, number>> = {};
  let activos = 0;
  let cursor: string | null = null;
  // 50 por pagina y 5 variantes: lejos del tope de coste de 1000 por consulta de
  // la Admin API (el catalogo tiene como mucho 2 variantes por disco).
  for (let page = 0; page < 120; page++) {          // 120 x 50: un tope, no un limite esperado
    const r = await shopifyAdminGraphQL(env, PRODUCTS_QUERY, { cursor });
    if (r.errors?.length) throw new Error(`Admin API: ${r.errors[0].message}`);
    const conn = r.data?.products;
    for (const p of conn?.nodes || []) {
      activos++;
      const it = productoAItem(p);
      if ('skip' in it) saltados[it.skip] = (saltados[it.skip] || 0) + 1;
      else items.push(it);
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  const builtAt = new Date().toISOString();
  return { xml: renderFeedXml(items, builtAt), builtAt, count: items.length, activos, saltados };
}

/** Genera y guarda en KV. Devuelve el resumen (sin el XML). */
export async function rebuildGoogleFeed(env: GoogleFeedEnv): Promise<Omit<FeedBuild, 'xml'>> {
  const b = await buildGoogleFeed(env);
  await env.SYNC_STATE.put(GOOGLE_FEED_KEY, b.xml, {
    metadata: { builtAt: b.builtAt, count: b.count, activos: b.activos, saltados: b.saltados },
  });
  const { xml: _xml, ...resumen } = b;
  return resumen;
}

// ── handlers ───────────────────────────────────────────────────────

function xmlRes(xml: string, builtAt: string, count: number): Response {
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
      'X-Feed-Built-At': builtAt,
      'X-Feed-Items': String(count),
    },
  });
}

/** GET ?action=google-feed — publico. De KV; si no hay, se genera ahora. */
export async function handleGoogleFeed(env: GoogleFeedEnv): Promise<Response> {
  const { value, metadata } = await env.SYNC_STATE.getWithMetadata<{ builtAt: string; count: number }>(GOOGLE_FEED_KEY);
  if (value) return xmlRes(value, metadata?.builtAt || '', metadata?.count ?? 0);
  const b = await buildGoogleFeed(env);
  await env.SYNC_STATE.put(GOOGLE_FEED_KEY, b.xml, {
    metadata: { builtAt: b.builtAt, count: b.count, activos: b.activos, saltados: b.saltados },
  });
  return xmlRes(b.xml, b.builtAt, b.count);
}

/** POST ?action=google-feed-rebuild — Bearer admin. */
export async function handleGoogleFeedRebuild(env: GoogleFeedEnv, autorizado: boolean): Promise<Response> {
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), {
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
  if (!autorizado) return json({ error: 'unauthorized' }, 401);
  try {
    return json({ ok: true, ...(await rebuildGoogleFeed(env)) });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) }, 502);
  }
}
