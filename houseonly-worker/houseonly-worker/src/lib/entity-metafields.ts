/**
 * Metafields de entidad en el producto de Shopify — fase 4 de docs/entities.md.
 *
 * El slug canonico tiene que llegar al producto: sin eso, cualquier pantalla que
 * pinte o filtre por entidad vuelve a resolver texto libre en cada carga.
 *
 * Este modulo es la UNICA definicion de como se llaman esos metafields y de como
 * se guarda su valor. Lo importan tres sitios que tienen que coincidir o el dato
 * se parte en dos: el script que crea las definiciones, el webhook de
 * products/create y el backfill. Node 24 quita los tipos al vuelo, asi que los
 * scripts .mjs pueden importar este .ts tal cual.
 */

export const ENTITY_MF_NAMESPACE = 'houseonly';

export const ENTITY_MF_KEYS = {
  artist: 'artist_slugs',
  label: 'label_slugs',
} as const;

export type EntityMetafieldKind = keyof typeof ENTITY_MF_KEYS;

/**
 * PLURAL los dos, aunque hoy el sello sea siempre uno. Un split o una licencia
 * compartida caben sin migrar nada, y el parser es el mismo para ambos.
 */
export interface MetafieldDefinitionSpec {
  name: string;
  namespace: string;
  key: string;
  type: string;
  ownerType: 'PRODUCT';
  description: string;
  pin: boolean;
  access: { admin: 'MERCHANT_READ_WRITE'; storefront: 'PUBLIC_READ' };
  capabilities: { adminFilterable: { enabled: boolean } };
}

/**
 * `single_line_text_field` con los slugs separados por COMA, no `list.*`:
 * Shopify no importa tipos list de texto por CSV, y la coma es ya la convencion
 * de `alias:{k}:{norm}`, que guarda varios slugs igual. Una regla, un parser.
 *
 * Dos ajustes que no son adorno:
 *  - `storefront: PUBLIC_READ` — sin esto la tienda no puede leer el metafield
 *    por Storefront API y el feed de la fase 5 se queda ciego.
 *  - `adminFilterable` — es lo que permite filtrar por entidad dentro del admin
 *    de Shopify sin escribir una linea de codigo.
 */
export const ENTITY_MF_DEFINITIONS: MetafieldDefinitionSpec[] = [
  {
    name: 'Artist entities',
    namespace: ENTITY_MF_NAMESPACE,
    key: ENTITY_MF_KEYS.artist,
    type: 'single_line_text_field',
    ownerType: 'PRODUCT',
    description: 'Slugs canonicos de artista, separados por coma. Ver docs/entities.md.',
    pin: true,
    access: { admin: 'MERCHANT_READ_WRITE', storefront: 'PUBLIC_READ' },
    capabilities: { adminFilterable: { enabled: true } },
  },
  {
    name: 'Label entities',
    namespace: ENTITY_MF_NAMESPACE,
    key: ENTITY_MF_KEYS.label,
    type: 'single_line_text_field',
    ownerType: 'PRODUCT',
    description: 'Slugs canonicos de sello, separados por coma. Ver docs/entities.md.',
    pin: true,
    access: { admin: 'MERCHANT_READ_WRITE', storefront: 'PUBLIC_READ' },
    capabilities: { adminFilterable: { enabled: true } },
  },
];

export function definitionFor(kind: EntityMetafieldKind): MetafieldDefinitionSpec {
  const key = ENTITY_MF_KEYS[kind];
  const def = ENTITY_MF_DEFINITIONS.find(d => d.key === key);
  if (!def) throw new Error(`sin definicion para ${kind}`);
  return def;
}

/**
 * Valor del metafield a partir de los slugs. Quita vacios y repetidos y respeta
 * el orden de entrada: en un split, el primero es el artista principal y eso se
 * ve en la tienda.
 */
export function joinSlugs(slugs: Array<string | null | undefined>): string {
  const out: string[] = [];
  for (const s of slugs || []) {
    const v = String(s || '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out.join(',');
}

/** Lo contrario. Tolera espacios alrededor de la coma y valores vacios. */
export function parseSlugs(value: string | null | undefined): string[] {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Cabecera de la columna del CSV de importacion de Shopify. El formato es
 * `Nombre (product.metafields.{namespace}.{key})`; lo que Shopify mira es el
 * parentesis, pero el nombre se mantiene igual que el de la definicion para que
 * el CSV y el admin no parezcan dos cosas distintas.
 */
export function csvHeader(kind: EntityMetafieldKind): string {
  const def = definitionFor(kind);
  return `${def.name} (product.metafields.${def.namespace}.${def.key})`;
}

/** Compara lo que hay con lo que habria que escribir. El backfill no reescribe. */
export function sameSlugs(a: Array<string | null | undefined>, b: Array<string | null | undefined>): boolean {
  return joinSlugs(a) === joinSlugs(b);
}

/**
 * Una definicion que ya existe NO es un fallo: el script se ejecuta cada vez que
 * alguien monta el entorno. Shopify lo dice con el codigo TAKEN.
 */
export function isDefinitionTaken(userErrors: Array<{ code?: string | null; message?: string | null }> | null | undefined): boolean {
  const errs = userErrors || [];
  if (!errs.length) return false;
  return errs.every(e =>
    String(e?.code || '').toUpperCase() === 'TAKEN' ||
    /already (exists|in use)|has already been taken/i.test(String(e?.message || '')),
  );
}
