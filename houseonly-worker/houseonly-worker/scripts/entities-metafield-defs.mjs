#!/usr/bin/env node
/**
 * entities-metafield-defs.mjs — crea las definiciones de metafield de entidad.
 *
 * Fase 4 de docs/entities.md, paso (a). Sin definicion, el metafield se puede
 * escribir igual pero NO se puede filtrar por el en el admin, y —lo que importa
 * de verdad— la tienda no lo ve por Storefront API, asi que el feed de la fase 5
 * se quedaria ciego.
 *
 * Que crea (una por kind, ambas en el namespace `houseonly`):
 *   Artist entities → houseonly.artist_slugs
 *   Label entities  → houseonly.label_slugs
 * `single_line_text_field` con los slugs separados por coma. El porque de no
 * usar un tipo `list.*` esta en src/lib/entity-metafields.ts, que es de donde
 * salen estas definiciones: aqui no se repite ni un nombre.
 *
 * Es IDEMPOTENTE en los dos sentidos: si la definicion ya existe la deja en paz
 * (Shopify contesta TAKEN) y ademas avisa si la que hay no coincide con la que
 * deberia, porque una definicion creada a mano con storefront en NONE rompe el
 * feed sin dar ningun error.
 *
 * Uso:
 *   node entities-metafield-defs.mjs            # dry-run: dice que haria
 *   node entities-metafield-defs.mjs --create   # las crea
 *
 * Env:
 *   SHOPIFY_ADMIN_CLIENT_ID       Custom App houseonly-backorder
 *   SHOPIFY_ADMIN_CLIENT_SECRET
 */

import { ENTITY_MF_DEFINITIONS, ENTITY_MF_NAMESPACE, isDefinitionTaken, csvHeader }
  from '../src/lib/entity-metafields.ts';

const SHOP = 'house-only-2.myshopify.com';
const API = '2026-04';

const args = new Set(process.argv.slice(2));
const CREATE = args.has('--create');

function die(msg) { console.error(`\n✘ ${msg}\n`); process.exit(1); }

async function adminToken() {
  const id = process.env.SHOPIFY_ADMIN_CLIENT_ID;
  const secret = process.env.SHOPIFY_ADMIN_CLIENT_SECRET;
  if (!id || !secret) die('faltan SHOPIFY_ADMIN_CLIENT_ID / SHOPIFY_ADMIN_CLIENT_SECRET');

  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!r.ok) {
    // Shopify contesta este endpoint con una PAGINA HTML, no con JSON. Mismo
    // tratamiento que en entities-sweep.mjs: sacar la frase y tirar el markup.
    const plain = (await r.text())
      .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const oauth = plain.match(/Oauth error [^.]*/i);
    die(`credenciales de Shopify rechazadas (${r.status}): ${(oauth ? oauth[0] : plain).slice(0, 200)}`);
  }
  return (await r.json()).access_token;
}

async function gql(token, query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) die(`Admin API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  if (j.errors) die(`Admin API GraphQL: ${JSON.stringify(j.errors).slice(0, 300)}`);
  return j.data;
}

const LIST = `
  query entityDefs($namespace: String!) {
    metafieldDefinitions(first: 25, ownerType: PRODUCT, namespace: $namespace) {
      nodes {
        id
        key
        name
        type { name }
        pinnedPosition
        access { admin storefront }
        capabilities { adminFilterable { enabled } }
      }
    }
  }
`;

const CREATE_DEF = `
  mutation createEntityDef($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key name }
      userErrors { field message code }
    }
  }
`;

/** Lo que se espera de una definicion ya existente. Devuelve la lista de peros. */
function mismatches(existing, spec) {
  const out = [];
  if (existing.type?.name !== spec.type) out.push(`type=${existing.type?.name} (deberia ser ${spec.type})`);
  if (existing.access?.storefront !== 'PUBLIC_READ') {
    out.push(`access.storefront=${existing.access?.storefront} — la tienda NO puede leerlo, el feed se queda ciego`);
  }
  if (!existing.capabilities?.adminFilterable?.enabled) out.push('adminFilterable=false — no se puede filtrar en el admin');
  return out;
}

async function main() {
  console.log(`\nentities-metafield-defs → ${SHOP} (${API})`);
  if (!CREATE) console.log('MODO DRY-RUN: no se crea nada. Usa --create para aplicar.');

  const token = await adminToken();
  const existing = (await gql(token, LIST, { namespace: ENTITY_MF_NAMESPACE }))
    .metafieldDefinitions.nodes;
  const byKey = new Map(existing.map(d => [d.key, d]));

  console.log(`\n  ${existing.length} definicion(es) en el namespace "${ENTITY_MF_NAMESPACE}"`);

  let created = 0, already = 0, wrong = 0;

  for (const spec of ENTITY_MF_DEFINITIONS) {
    const hit = byKey.get(spec.key);
    if (hit) {
      const peros = mismatches(hit, spec);
      if (peros.length) {
        wrong++;
        console.log(`\n  ⚠ ${spec.namespace}.${spec.key} YA EXISTE pero no coincide:`);
        for (const p of peros) console.log(`      · ${p}`);
        console.log('      No se toca: cambiarla es metafieldDefinitionUpdate y se hace a mano y a conciencia.');
      } else {
        already++;
        console.log(`  ✓ ${spec.namespace}.${spec.key} ya existe y esta bien`);
      }
      continue;
    }

    if (!CREATE) {
      console.log(`  + ${spec.namespace}.${spec.key} — se crearia (${spec.type}, storefront PUBLIC_READ, filtrable)`);
      continue;
    }

    const res = (await gql(token, CREATE_DEF, { definition: spec })).metafieldDefinitionCreate;
    if (res.createdDefinition) {
      created++;
      console.log(`  + creada ${spec.namespace}.${spec.key} (${res.createdDefinition.id})`);
    } else if (isDefinitionTaken(res.userErrors)) {
      already++;
      console.log(`  ✓ ${spec.namespace}.${spec.key} ya existia (TAKEN)`);
    } else {
      die(`${spec.key}: ${JSON.stringify(res.userErrors)}`);
    }
  }

  console.log(`\n  ${created} creadas · ${already} ya estaban · ${wrong} con la configuracion equivocada`);
  console.log('\n  Cabeceras para el CSV de los importers:');
  for (const kind of ['artist', 'label']) console.log(`    ${csvHeader(kind)}`);
  if (!CREATE) console.log('\nDry-run: nada creado. Repite con --create.');
  console.log('');
}

main().catch(e => die(e?.stack || String(e)));
