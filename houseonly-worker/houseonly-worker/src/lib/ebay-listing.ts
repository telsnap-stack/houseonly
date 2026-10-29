// ── EBAY LISTING CONTENT ─────────────────────────────────────────────
//
// Shopify product → eBay inventory item + offer. Pure functions, so the rules
// are testable without a single network call; ebay.ts does the I/O.
//
// Content comes from OUR Shopify product: title, artist (vendor), label
// (label: tag), catalogue number (SKU), genre (genre: tag), description and our
// images. Nothing is pulled from a Discogs RELEASE — matches there are not
// trusted (see discogs-match memory). From our own Discogs LISTING of the
// record (sku:{SKU} in SYNC_STATE) come the price and the media/sleeve grades.
//
// PRICE is never derived from the Shopify price (resolvePrice in ebay.ts):
//   - linked Discogs listing → its current price (EUR);
//   - product tagged `discogs:no` → Shopify unitCost × multiplier;
//   - neither → no listing; the record waits in the queue.
//
// No shipping/exclusion text is ever added (no "Canarias" line), and shipping
// sentences already in the Shopify description ("Worldwide shipping from House
// Only.") are removed: shipping is the fulfillment policy's job.
//
// Catalogue (ePID) matching: "try silently, fall back to standalone". eBay
// tries to match the product to its catalogue from the EAN/UPC we send; we
// pass includeCatalogProductDetails=false so a match never overwrites our
// title, photos or description with a possibly different pressing's. If the
// publish fails while an EAN was sent, ebay.ts retries once without it.

import { generoDeTags } from './genres.mjs';
import { decodeHtmlEntities, htmlToText } from './html-text.mjs';
import { gtinValido } from './google-feed';
import type { EbayPolicyIds } from './ebay-api';
import { EBAY_MARKETPLACE } from './ebay-api';

// Vinyl records leaf category. 176985 is "Vinyl Records" across eBay sites;
// confirm it on EBAY_ES's own tree with `node scripts/ebay-oauth.mjs check`
// once the keys arrive. Override without a deploy: KV meta:ebay_category_id.
export const EBAY_DEFAULT_CATEGORY_ID = '176985';

// EBAY_ES requires an EAN in 176985 (publish fails with 25002 "El campo EAN
// está vacío"). With no barcode, eBay wants its per-site "does not apply"
// text in product.ean: "No aplicable" for eBay Spain (Inventory API,
// Product.ean note → "Product Identifier Text" page, checked 2026-10-27).
export const EBAY_NO_GTIN_TEXT = 'No aplicable';

// eBay title limit: 80 characters.
const TITLE_MAX = 80;
// product.description limit is 4000 characters (Inventory API spec).
const PRODUCT_DESCRIPTION_MAX = 4000;
// Up to 24 images per item; all ours are on cdn.shopify.com (https).
const IMAGES_MAX = 24;
// Item specific values: max 65 characters. Not in getItemAspectsForCategory
// (aspectMaxLength comes back empty for 176985); eBay states it when it refuses
// one: 25002 "…de Artista es demasiado largo. Introduce un valor de 65
// caracteres como máximo" (NERO050R, HW020, 2026-10-28).
export const ASPECT_VALUE_MAX = 65;
// SKU path parameter: max length 50.
const SKU_MAX = 50;

// Item specifics, in the marketplace language (Content-Language es-ES).
// Artista, Género and Subgénero are eBay's own names for 176985 on EBAY_ES
// (getItemAspectsForCategory, 2026-10-27). eBay has no aspect for label or
// catalogue number; they go as custom specifics because record buyers search
// by them. Grades only on used records: a NEW listing with "Near Mint" reads
// as second-hand.
export const ASPECTS = {
  artist: 'Artista',
  genre: 'Género',
  subgenre: 'Subgénero',
  label: 'Discográfica',
  catno: 'Número de catálogo',
  mediaGrade: 'Calidad del disco',
  sleeveGrade: 'Calidad de la funda',
};

// Our genre (genres.mjs id) → eBay's Género / Subgénero values for 176985.
// Both are FREE_TEXT on eBay, but only their listed values feed the filters.
const DJ = 'DJ, dance, house';
export const EBAY_GENRE: Record<string, { genero: string; subgenero?: string }> = {
  house: { genero: DJ, subgenero: 'House' },
  deephouse: { genero: DJ, subgenero: 'House' },
  techhouse: { genero: DJ, subgenero: 'House' },
  techno: { genero: DJ, subgenero: 'Techno, electro' },
  electro: { genero: DJ, subgenero: 'Techno, electro' },
  garage: { genero: DJ, subgenero: 'Garage' },
  brokenbeat: { genero: DJ, subgenero: 'Breakbeat' },
  drumandbass: { genero: DJ, subgenero: 'Drum and bass, jungle' },
  bassmusic: { genero: DJ, subgenero: 'Electrónica' },
  electronica: { genero: DJ, subgenero: 'Electrónica' },
  soulfunkdisco: { genero: 'R&B, soul' },
  jazz: { genero: 'Jazz' },
};

// Store categories (our eBay Store, set up by hand in Seller Hub) by genre.
// Editable in KV as meta:ebay_store_category_map, same shape; these are the
// defaults. `by_tag` goes first and matches a raw tag (case-insensitive): it
// catches what our taxonomy keeps as a sub-genre tag and not as a canonical
// one, like "Minimal" (canonical techno). Then `by_genre`, by genres.mjs id.
// No match → no store category (eBay files it under "Other").
export interface StoreCategoryMap {
  by_tag: Record<string, string>;
  by_genre: Record<string, string>;
}
export const EBAY_STORE_CATEGORY_DEFAULTS: StoreCategoryMap = {
  by_tag: {
    'minimal': 'Minimal', 'deep minimal': 'Minimal', 'techno - minimal': 'Minimal',
    'breakbeat': 'UK Garage & Breaks',
  },
  by_genre: {
    house: 'House', deephouse: 'House', techhouse: 'House',
    techno: 'Techno',
    garage: 'UK Garage & Breaks',
    drumandbass: 'Drum & Bass',
    bassmusic: 'Bass Music',
  },
};

/** The store category name for a product's tags, or null. */
export function storeCategoryFor(tags: string[], map: StoreCategoryMap): string | null {
  const byTag = Object.fromEntries(Object.entries(map.by_tag || {}).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const t of tags || []) {
    const hit = byTag[String(t).trim().toLowerCase()];
    if (hit) return hit;
  }
  const ours = generoDeTags(tags);
  return (ours && map.by_genre?.[ours.id]) || null;
}

/** Discogs price → the eBay price: up to the next .99 (12.97 → 12.99, 21.23 → 21.99, 12.99 stays). */
export function roundUpTo99(value: number): number {
  const cents = Math.round(value * 100);
  return (Math.floor(cents / 100) * 100 + 99) / 100;
}

// Products that will never go to Discogs. Set by hand in Shopify; their eBay
// price comes from the unit cost instead of a Discogs listing.
export const NOT_FOR_DISCOGS_TAG = 'discogs:no';
export const notForDiscogs = (tags: string[]) =>
  (tags || []).some(t => String(t).trim().toLowerCase() === NOT_FOR_DISCOGS_TAG);

// Discogs grade names, which eBay's record grading uses too.
export const GRADE_MINT = 'Mint (M)';

/** What we need of a Shopify product (Admin API) to list it. */
export interface EbaySourceProduct {
  productId: string;
  status: string;
  title: string;
  vendor: string;
  tags: string[];
  descriptionHtml: string;
  images: string[];
  variant: {
    id: string;
    sku: string;
    price: string;
    barcode: string | null;
    inventoryQuantity: number | null;
    unitCost: number | null;      // inventoryItem.unitCost.amount (EUR)
    weightKg?: number | null;     // inventoryItem.measurement.weight, in kg; null = not set
  };
}

export interface EbayPrice {
  value: number;                  // EUR
  source: 'discogs' | 'cost' | 'shopify';
  detail: string;                 // e.g. "Discogs listing 4190680911" / "cost 9.50 × 2"
}

export interface Grades {
  media: string;
  sleeve: string;
  source: 'discogs' | 'condition-tag';
}

export type EbayCondition = 'NEW' | 'USED_EXCELLENT';

// Why a record cannot be listed right now. All are re-checked by the cron.
export type EbayHoldReason =
  | 'no_en_shopify' | 'no_activo' | 'forthcoming' | 'sin_stock' | 'sin_sku' | 'sku_largo' | 'sin_imagen'
  | 'usado_sin_grado'
  | 'esperando_discogs'       // no Discogs listing linked yet
  | 'discogs_no_disponible'   // linked listing is Sold / not For Sale or Draft
  | 'discogs_no_eur'          // linked listing priced in another currency
  | 'discogs_error'           // Discogs did not answer (usually 429): try next run
  | 'discogs_snapshot_caducado' // the Discogs inventory snapshot is over 48 h old
  | 'sin_politica_envio'      // heavy parcel and its shipping policy isn't on eBay yet
  | 'imagen_pequena'          // eBay refused the photos (under 500 px): waits until they change in Shopify
  | 'sin_fuente_de_precio';   // discogs:no and no unit cost: flagged in the admin

export interface EbayListingPayload {
  sku: string;
  inventoryItem: any;
  offer: any;
  ean: string;
  grades: Grades;
  price: EbayPrice;
}

// ── condition & grades ─────────────────────────────────────────────

/**
 * Condition from Shopify tags. The catalogue has no condition tags today
 * (checked 2026-10-26: 1,524 products, all new stock), so no tag = new.
 * Recognised: condition:sealed / condition:new / sealed / new → NEW;
 * condition:used… / used / second-hand → USED.
 */
export function conditionFromTags(tags: string[]): EbayCondition {
  const t = (tags || []).map(x => String(x).trim().toLowerCase());
  const used = t.some(x => x === 'used' || x === 'second-hand' || x === 'secondhand'
    || /^condition:\s*(used|second)/.test(x));
  return used ? 'USED_EXCELLENT' : 'NEW';
}

/**
 * Grades: our Discogs listing's when linked, else Mint for new/sealed stock.
 * A used record with no Discogs grade has no honest default → null (skip).
 */
export function gradesFor(
  tags: string[],
  discogs?: { condition?: string; sleeve_condition?: string } | null,
): Grades | null {
  if (discogs?.condition) {
    return { media: discogs.condition, sleeve: discogs.sleeve_condition || discogs.condition, source: 'discogs' };
  }
  if (conditionFromTags(tags) === 'NEW') return { media: GRADE_MINT, sleeve: GRADE_MINT, source: 'condition-tag' };
  return null;
}

// ── text ───────────────────────────────────────────────────────────

function tagValue(tags: string[], prefix: string): string {
  const t = (tags || []).find(x => x.toLowerCase().startsWith(prefix));
  return t ? t.slice(prefix.length).trim() : '';
}

/**
 * An item specific value cut to eBay's 65: at the last ", " (artist lists),
 * else at a word; never ending in an unclosed "(" or on punctuation.
 */
export function fitAspectValue(v: string, max = ASPECT_VALUE_MAX): string {
  v = v.trim();
  if (v.length <= max) return v;
  let cut = v.slice(0, max);
  const comma = cut.lastIndexOf(', ');
  const space = cut.lastIndexOf(' ');
  if (comma > max / 3) cut = cut.slice(0, comma);
  else if (v[max] !== ' ' && space > max / 3) cut = cut.slice(0, space);
  const open = cut.lastIndexOf('(');
  if (open > 0 && cut.indexOf(')', open) < 0) cut = cut.slice(0, open);
  return cut.replace(/[\s,;:&(\-–]+$/, '');
}

function artistOf(vendor: string): string {
  // As google-feed: Shopify's default vendor is the shop, not an artist.
  const v = decodeHtmlEntities((vendor || '').trim());
  return v === 'House Only' ? '' : v;
}

/**
 * "Artist - Title", then the catalogue number and "Vinilo" while they fit in
 * 80 characters. A title too long on its own is cut with an ellipsis.
 */
export function ebayTitle(artist: string, title: string, catno: string): string {
  const base = (artist ? `${artist} - ${title}` : title).replace(/\s+/g, ' ').trim();
  if (base.length > TITLE_MAX) return base.slice(0, TITLE_MAX - 1).trimEnd() + '…';
  let out = base;
  for (const extra of [catno, 'Vinilo']) {
    if (extra && (out + ' ' + extra).length <= TITLE_MAX) out += ' ' + extra;
  }
  return out;
}

const escapeHtml = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Active content is not allowed in eBay descriptions; Shopify's has none, but strip it anyway. */
function sanitizeHtml(html: string): string {
  return String(html || '')
    .replace(/<(script|style|iframe|object|embed|form)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|iframe|object|embed)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

// A sentence that talks about shipping ("Worldwide shipping from House Only.",
// a Spanish "envío" line, Canarias). Sentences end at . ! ? or at a tag.
const SHIPPING_SENTENCE = /[^.!?<>]*\b(shipping|env[ií]os?|canarias)\b[^.!?<>]*[.!?]?/gi;

/** Shopify description without its shipping sentences (and without paragraphs they leave empty). */
export function stripShippingText(html: string): string {
  return String(html || '')
    .replace(SHIPPING_SENTENCE, '')
    .replace(/<p>\s*<\/p>/gi, '')
    .replace(/[ \t]+(<\/p>)/gi, '$1');
}

// eBay hides listings that point buyers off eBay ("offering to buy or sell
// outside eBay", 2026-10-27; the trigger was PFGXX50LP's distributor text
// "LISTEN LINK: https://open.spotify.com/…"): links, emails, "Listen link" /
// "Listen:" lines, our web shop, Discogs, Instagram, our handle. Links and contacts become a marker first (their dots would cut a
// sentence short), then every sentence holding a marker or one of the words
// goes, like the shipping ones. Plain text "House Only" (an artist/label name)
// stays: only the domain and the handle are off-eBay pointers.
const OFF_EBAY_TOKEN = '\u2063';   // invisible separator, never in our texts
const OFF_EBAY_TOKENS: RegExp[] = [
  /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi,                                   // URLs
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,                                         // emails
  /@[A-Za-z0-9_.]*[A-Za-z0-9_]/g,                                             // handles (@onlyhouseonly)
  /\b[\w-]+(?:\.[\w-]+)*\.(?:store|shop|com|net|org|es|io|fm|eu|de|fr|it|nl|uk|info|online|me)\b(?:\/[^\s<>"']*)?/gi,  // bare domains (houseonly.store)
];
// A sentence or a line (plain-text descriptions break lines with \n).
const OFF_EBAY_SENTENCE = new RegExp(`[^.!?<>\\n]*(?:${OFF_EBAY_TOKEN}|\\b(?:discogs|instagram)\\b|\\blisten\\s*link\\b|\\blisten\\s*:)[^.!?<>\\n]*[.!?]?`, 'gi');
/** Anything a reviewer would read as "buy elsewhere": true when the text has it. */
export const OFF_EBAY_TEXT = /https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w-]+|houseonly\.store|\bdiscogs\b|\binstagram\b|@onlyhouseonly|\blisten\s*link\b|\blisten\s*:/i;

export function stripOffEbayText(html: string): string {
  let s = String(html || '').replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1');
  for (const re of OFF_EBAY_TOKENS) s = s.replace(re, OFF_EBAY_TOKEN);
  // A "://" left after the URLs (the Berlin club "://about blank") failed BB009
  // with 25002 "no puede contener JavaScript" (2026-10-29).
  s = s.replace(/:\/\//g, '');
  return s
    .replace(OFF_EBAY_SENTENCE, '')
    .split(OFF_EBAY_TOKEN).join('')
    .replace(/<(p|li|div|span|strong|b|em|i)>\s*<\/\1>/gi, '')
    .replace(/(<(?:p|li|div)>)[ \t]+/gi, '$1')
    .replace(/[ \t]+(<\/p>)/gi, '$1');
}

function listingDescription(f: { artist: string; title: string; label: string; catno: string; genre: string; grades: Grades | null; html: string }): string {
  const rows: Array<[string, string]> = [
    ['Artista', f.artist], ['Título', f.title], ['Sello', f.label],
    ['Nº de catálogo', f.catno], ['Género', f.genre],
    ['Disco', f.grades?.media || ''], ['Funda', f.grades?.sleeve || ''],
  ];
  const table = rows.filter(([, v]) => v)
    .map(([k, v]) => `<tr><td><b>${escapeHtml(k)}</b></td><td>${escapeHtml(v)}</td></tr>`).join('');
  return `<table>${table}</table>${f.html ? `<div>${sanitizeHtml(f.html)}</div>` : ''}`;
}

// ── builder ────────────────────────────────────────────────────────

export interface ListingConfig {
  categoryId: string;
  policies: EbayPolicyIds;
  merchantLocationKey: string;
  withEan: boolean;
  storeCategory?: string | null;   // a name the store has (checked by the caller)
}

/** Can this product be listed right now (price aside)? Checked before any eBay or Discogs call. */
export function holdReason(p: EbaySourceProduct): EbayHoldReason | null {
  if (p.status !== 'ACTIVE') return 'no_activo';
  if ((p.tags || []).some(t => t.toLowerCase() === 'forthcoming')) return 'forthcoming';
  const sku = (p.variant?.sku || '').trim();
  if (!sku) return 'sin_sku';
  if (sku.length > SKU_MAX) return 'sku_largo';
  if ((p.variant.inventoryQuantity ?? 0) <= 0) return 'sin_stock';
  if (!p.images.some(u => /^https:\/\//.test(u))) return 'sin_imagen';
  return null;
}

/** discogs:no records: unit cost × multiplier, or nothing. Never a guess. */
export function priceFromCost(p: EbaySourceProduct, multiplier: number): EbayPrice | null {
  const cost = p.variant.unitCost;
  if (!(cost && cost > 0) || !(multiplier > 0)) return null;
  // Up to .99, like the Discogs prices: 3.45 × 2 = 6.90 → 6.99.
  const raw = Math.round(cost * multiplier * 100) / 100;
  const value = roundUpTo99(raw);
  return { value, source: 'cost', detail: `cost ${cost.toFixed(2)} × ${multiplier}${value === raw ? '' : ` = ${raw.toFixed(2)} → ${value.toFixed(2)}`}` };
}

/** No Discogs listing and no unit cost: Shopify price × markup (Eduardo, 2026-10-29), or nothing. */
export function priceFromShopify(p: EbaySourceProduct, markup: number): EbayPrice | null {
  const shop = Number(p.variant.price);
  if (!(shop > 0) || !(markup > 0)) return null;
  const raw = Math.round(shop * markup * 100) / 100;
  const value = roundUpTo99(raw);
  return { value, source: 'shopify', detail: `Shopify ${shop.toFixed(2)} × ${markup}${value === raw ? '' : ` = ${raw.toFixed(2)} → ${value.toFixed(2)}`}` };
}

export function buildEbayListing(p: EbaySourceProduct, grades: Grades, price: EbayPrice, cfg: ListingConfig): EbayListingPayload {
  if (!(price.value > 0)) throw new Error('buildEbayListing: no price');
  const sku = p.variant.sku.trim();
  const artist = artistOf(p.vendor);
  const title = decodeHtmlEntities((p.title || '').trim());
  const label = tagValue(p.tags, 'label:');
  const ours = generoDeTags(p.tags);
  const genre = ours?.label || '';
  const ebayGenre = ours ? EBAY_GENRE[ours.id] : undefined;
  const condition = conditionFromTags(p.tags);
  const used = condition !== 'NEW';
  const ean = cfg.withEan ? gtinValido(p.variant.barcode) : '';
  const html = stripOffEbayText(stripShippingText(p.descriptionHtml || ''));

  const aspects: Record<string, string[]> = {};
  if (artist) aspects[ASPECTS.artist] = [artist];
  if (ebayGenre) aspects[ASPECTS.genre] = [ebayGenre.genero];
  if (ebayGenre?.subgenero) aspects[ASPECTS.subgenre] = [ebayGenre.subgenero];
  if (label) aspects[ASPECTS.label] = [label];
  aspects[ASPECTS.catno] = [sku];
  if (used) {
    aspects[ASPECTS.mediaGrade] = [grades.media];
    aspects[ASPECTS.sleeveGrade] = [grades.sleeve];
  }
  for (const k of Object.keys(aspects)) aspects[k] = aspects[k].map(v => fitAspectValue(v));

  const product: any = {
    title: ebayTitle(artist, title, sku),
    description: (htmlToText(html) || title).slice(0, PRODUCT_DESCRIPTION_MAX),
    aspects,
    imageUrls: p.images.filter(u => /^https:\/\//.test(u)).slice(0, IMAGES_MAX),
  };
  // A real EAN when we have one (and the catalogue retry hasn't dropped it);
  // otherwise eBay's "does not apply" text. `ean` in the result stays the real one.
  product.ean = [ean || EBAY_NO_GTIN_TEXT];

  const inventoryItem: any = {
    // One copy per channel, like the Discogs listing: a sale anywhere ends it.
    availability: { shipToLocationAvailability: { quantity: 1 } },
    condition,
    product,
  };
  if (used) {
    inventoryItem.conditionDescription = `Disco: ${grades.media} · Funda: ${grades.sleeve}`;
  }

  const offer = {
    sku,
    marketplaceId: EBAY_MARKETPLACE,
    format: 'FIXED_PRICE',
    listingDuration: 'GTC',
    availableQuantity: 1,
    categoryId: cfg.categoryId,
    merchantLocationKey: cfg.merchantLocationKey,
    includeCatalogProductDetails: false,
    listingDescription: listingDescription({ artist, title, label, catno: sku, genre, grades: used ? grades : null, html }),
    listingPolicies: {
      fulfillmentPolicyId: fulfillmentPolicyFor(shippingBandFor(p.variant.weightKg), cfg.policies) || cfg.policies.fulfillmentPolicyId,
      paymentPolicyId: cfg.policies.paymentPolicyId,
      returnPolicyId: cfg.policies.returnPolicyId,
    },
    pricingSummary: { price: { value: price.value.toFixed(2), currency: 'EUR' } },
    // Full path from the store root: our categories are all top level.
    ...(cfg.storeCategory ? { storeCategoryNames: [`/${cfg.storeCategory}`] } : {}),
  };

  return { sku, inventoryItem, offer, ean, grades, price };
}

// ── Shopify fetch ──────────────────────────────────────────────────

export const PRODUCT_BY_SKU_QUERY = `
  query ebayProductBySku($q: String!) {
    products(first: 5, query: $q) {
      nodes {
        id status title vendor tags descriptionHtml
        media(first: 24) { nodes { ... on MediaImage { image { url } } } }
        variants(first: 10) { nodes { id sku price barcode inventoryQuantity inventoryItem { unitCost { amount currencyCode } measurement { weight { unit value } } } } }
      }
    }
  }
`;

const KG_PER_UNIT: Record<string, number> = { KILOGRAMS: 1, GRAMS: 0.001, POUNDS: 0.45359237, OUNCES: 0.028349523125 };

/** Shopify Weight → kg. Zero or missing counts as "not set": Shopify stores 0 when nobody filled it in. */
export function weightToKg(w: { unit?: string; value?: number } | null | undefined): number | null {
  const k = KG_PER_UNIT[String(w?.unit || '')];
  const v = Number(w?.value);
  return k && v > 0 ? Math.round(v * k * 1000) / 1000 : null;
}

// Shipping by parcel weight (Eduardo, 2026-10-27). 3+ starts at 1.0 kg, not
// the store's 1.125: our import weights make a 3LP 1.05 kg (0.15 + 3 × 0.30),
// which must ship as 3+; a 2LP (0.75, or 0.90 on older imports) stays on 2.
export const SHIPPING_BAND_KG = { standardMax: 0.675, threeFrom: 1.0 };
export type ShippingBand = 'standard' | 'two' | 'three';

/** Weight band → which eBay shipping policy. No weight: the one-record policy (and the admin flags it). */
export function shippingBandFor(kg: number | null | undefined): ShippingBand {
  if (!(kg && kg > 0) || kg <= SHIPPING_BAND_KG.standardMax) return 'standard';
  return kg < SHIPPING_BAND_KG.threeFrom ? 'two' : 'three';
}

/** The policy ID for a band, or null when that policy doesn't exist on eBay. */
export function fulfillmentPolicyFor(band: ShippingBand, policies: EbayPolicyIds): string | null {
  if (band === 'standard') return policies.fulfillmentPolicyId;
  return policies.fulfillmentByBand?.[band] || null;
}

/** Admin API product node → EbaySourceProduct for the exact SKU, or null. */
export function toSourceProduct(nodes: any[], sku: string): EbaySourceProduct | null {
  for (const p of nodes || []) {
    const v = (p.variants?.nodes || []).find((x: any) => (x.sku || '').trim() === sku);
    if (!v) continue;
    return {
      productId: p.id,
      status: p.status,
      title: p.title || '',
      vendor: p.vendor || '',
      tags: p.tags || [],
      descriptionHtml: p.descriptionHtml || '',
      images: (p.media?.nodes || []).map((m: any) => m?.image?.url).filter(Boolean),
      variant: {
        id: v.id, sku: v.sku, price: v.price, barcode: v.barcode ?? null,
        inventoryQuantity: v.inventoryQuantity ?? null,
        // The shop currency is EUR; a cost in anything else is not used.
        unitCost: v.inventoryItem?.unitCost && (v.inventoryItem.unitCost.currencyCode || 'EUR') === 'EUR'
          ? Number(v.inventoryItem.unitCost.amount) || null : null,
        weightKg: weightToKg(v.inventoryItem?.measurement?.weight),
      },
    };
  }
  return null;
}
