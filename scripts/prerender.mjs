#!/usr/bin/env node
/**
 * Pre-render script for SEO.
 * Runs after Vite build (`npm run build`).
 *
 * For each Shopify product:
 *   - Generates dist/products/<slug>/index.html with full meta tags + JSON-LD
 *
 * Also generates:
 *   - dist/sitemap.xml listing the homepage and every product URL
 *   - dist/robots.txt pointing to the sitemap
 *
 * Uses the public Storefront API token (same as App.jsx).
 * Reads VITE_SHOPIFY_TOKEN from env if set, otherwise falls back to the public default.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ── Config ──────────────────────────────────────────────────────
const SITE_URL = 'https://houseonly.store';
const SHOPIFY_DOMAIN = 'house-only-2.myshopify.com';
const SHOPIFY_TOKEN  = process.env.VITE_SHOPIFY_TOKEN || '3edf470af24f9bd4b81bca274121eec4';
const SHOPIFY_API    = '2024-01';
const DIST_DIR = 'dist';

// ── Slug helpers (mirror App.jsx exactly) ───────────────────────
function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}
function makeSlug(artist, title, catalog) {
  const base = [artist, title].filter(Boolean).join(' ');
  const s = slugify(base);
  if (s) return s;
  return slugify(catalog) || 'release';
}

// ── HTML escaping ──────────────────────────────────────────────
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeJson(s) {
  // For embedding inside JSON-LD <script> tag — escape </script>
  return String(s).replace(/<\/script/gi, '<\\/script');
}

// ── Shopify fetch ──────────────────────────────────────────────
async function shopifyQuery(query) {
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/api/${SHOPIFY_API}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`Shopify HTTP ${r.status}`);
  const d = await r.json();
  if (d.errors) throw new Error(d.errors[0].message);
  return d.data;
}

async function fetchAllProducts() {
  const all = [];
  let cursor = null;
  for (let i = 0; i < 50; i++) { // hard cap — 50 pages * 50 = 2500 products
    const after = cursor ? `, after: "${cursor}"` : '';
    const data = await shopifyQuery(`{
      products(first: 50${after}) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id title vendor descriptionHtml tags
            variants(first:1) { edges { node { sku price { amount currencyCode } quantityAvailable } } }
            images(first:1) { edges { node { url } } }
          }
        }
      }
    }`);
    const { edges, pageInfo } = data.products;
    all.push(...edges.map(e => e.node));
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  return all;
}

// ── Parse product (mirror App.jsx parseProduct) ────────────────
function decodeHtmlEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;amp;/g, '&')   // double-encoded ampersand
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&euro;/g, '€')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—');
}
function cleanDescription(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<\/(p|div|br|li|h[1-6])\s*>/gi, ' ');     // close tags = space
  s = s.replace(/<br\s*\/?>/gi, ' ');                       // <br> = space
  s = s.replace(/<[^>]+>/g, '');                             // strip remaining tags
  s = decodeHtmlEntities(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function parseProduct(node) {
  const v = node.variants.edges[0]?.node;
  const img = node.images.edges[0]?.node;
  const tags = node.tags || [];
  const desc = cleanDescription(node.descriptionHtml || '');
  const artist = node.vendor || '';
  const title = node.title || '';
  const catalog = v?.sku || '';
  const label = (tags.find(t => t.toLowerCase().startsWith('label:')) || '').slice(6).trim();
  const year = parseInt(tags.find(t => /^\d{4}$/.test(t)) || '0') || null;
  const price = parseFloat(v?.price?.amount || 0) || 0;
  const stock = v?.quantityAvailable ?? 0;
  return {
    title, artist, label, catalog, desc, price, stock, year,
    image: img?.url || '',
    slug: makeSlug(artist, title, catalog),
  };
}

// ── HTML template ──────────────────────────────────────────────
// We use the same Vite-built index.html but replace <head> contents
// and inject SEO content into the body. Googlebot sees the SEO content;
// React then hydrates and replaces it on the client.
function getIndexTemplate() {
  const path = join(DIST_DIR, 'index.html');
  if (!existsSync(path)) {
    throw new Error(`${path} not found. Run \`vite build\` first.`);
  }
  return readFileSync(path, 'utf8');
}

function renderProductHtml(template, product) {
  const url = `${SITE_URL}/products/${product.slug}`;
  const fullTitle = product.artist
    ? `${product.title} — ${product.artist} | House Only`
    : `${product.title} | House Only`;
  const descShort = (product.desc || '').replace(/\s+/g, ' ').trim().slice(0, 155);
  const metaDesc = descShort
    || `${product.title} by ${product.artist} on vinyl. ${product.label || ''} ${product.catalog || ''}. Worldwide shipping.`.replace(/\s+/g, ' ').trim();

  // JSON-LD Product schema
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    description: metaDesc,
    sku: product.catalog,
    brand: product.label ? { '@type': 'Brand', name: product.label } : undefined,
    image: product.image || undefined,
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'EUR',
      price: product.price.toFixed(2),
      availability: product.stock > 0
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      seller: { '@type': 'Organization', name: 'House Only' },
    },
  };

  // Build <head> additions
  const seoHead = `
    <title>${escapeHtml(fullTitle)}</title>
    <meta name="description" content="${escapeHtml(metaDesc)}" />
    <link rel="canonical" href="${escapeHtml(url)}" />
    <meta property="og:type" content="product" />
    <meta property="og:title" content="${escapeHtml(fullTitle)}" />
    <meta property="og:description" content="${escapeHtml(metaDesc)}" />
    <meta property="og:url" content="${escapeHtml(url)}" />
    <meta property="og:site_name" content="House Only" />
    ${product.image ? `<meta property="og:image" content="${escapeHtml(product.image)}" />` : ''}
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(fullTitle)}" />
    <meta name="twitter:description" content="${escapeHtml(metaDesc)}" />
    ${product.image ? `<meta name="twitter:image" content="${escapeHtml(product.image)}" />` : ''}
    <script type="application/ld+json">${escapeJson(JSON.stringify(jsonLd))}</script>
  `;

  // Body content visible to Googlebot before React hydrates.
  // React mounts to #root and overwrites this on the client.
  const seoBody = `
    <div style="position:absolute;left:-9999px;top:0;">
      <h1>${escapeHtml(product.title)}</h1>
      ${product.artist ? `<p>by <strong>${escapeHtml(product.artist)}</strong></p>` : ''}
      ${product.label ? `<p>Label: ${escapeHtml(product.label)}</p>` : ''}
      ${product.catalog ? `<p>Catalog: ${escapeHtml(product.catalog)}</p>` : ''}
      <p>Price: €${product.price.toFixed(2)}</p>
      ${product.image ? `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}" />` : ''}
      ${product.desc ? `<p>${escapeHtml(product.desc.slice(0, 1000))}</p>` : ''}
    </div>
  `;

  // Replace the original <title>houseonly</title> and inject head + body content.
  let html = template
    .replace(/<title>[^<]*<\/title>/, '')
    .replace('</head>', `${seoHead}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root"></div>${seoBody}`);

  return html;
}

// ── Sitemap + robots.txt ────────────────────────────────────────
function renderSitemap(products) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    `<url><loc>${SITE_URL}/</loc><lastmod>${today}</lastmod><priority>1.0</priority></url>`,
    ...products.map(p =>
      `<url><loc>${SITE_URL}/products/${p.slug}</loc><lastmod>${today}</lastmod><priority>0.8</priority></url>`
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

function renderRobots() {
  return `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log('[prerender] Fetching Shopify products...');
  const nodes = await fetchAllProducts();
  const products = nodes.map(parseProduct).filter(p => p.title && p.slug);
  console.log(`[prerender] Got ${products.length} products`);

  console.log('[prerender] Reading dist/index.html template...');
  const template = getIndexTemplate();

  console.log('[prerender] Generating product pages...');
  let written = 0;
  for (const p of products) {
    const out = join(DIST_DIR, 'products', p.slug, 'index.html');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderProductHtml(template, p));
    written++;
  }
  console.log(`[prerender] Wrote ${written} product pages`);

  console.log('[prerender] Generating sitemap.xml...');
  writeFileSync(join(DIST_DIR, 'sitemap.xml'), renderSitemap(products));

  console.log('[prerender] Generating robots.txt...');
  writeFileSync(join(DIST_DIR, 'robots.txt'), renderRobots());

  console.log(`[prerender] ✓ Done. ${products.length} products, sitemap, robots.`);
}

main().catch(err => {
  console.error('[prerender] FAILED:', err);
  process.exit(1);
});
