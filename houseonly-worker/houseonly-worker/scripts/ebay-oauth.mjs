#!/usr/bin/env node
// eBay: puesta en marcha del tercer canal (docs/ebay.md). Pasos, en orden:
//
//   node scripts/ebay-oauth.mjs consent
//       Imprime la URL de consentimiento. Eduardo la abre, entra con la cuenta
//       VENDEDORA de eBay y acepta. eBay redirige a la "accept URL" del RuName
//       con ?code=… en la barra de direcciones.
//
//   node scripts/ebay-oauth.mjs exchange '<URL entera o code>' [--env staging]
//       Cambia el code (caduca en ~5 min) por el refresh token y lo mete DIRECTO
//       en `wrangler secret put EBAY_REFRESH_TOKEN` por stdin. El token no se
//       imprime nunca: no debe acabar en un chat ni en el historial.
//
//   node scripts/ebay-oauth.mjs check [--env staging]
//       Solo lectura. Con el token de aplicacion: arbol de categorias de
//       EBAY_ES, sugerencias para "disco de vinilo" y los item specifics de la
//       categoria (para confirmar 176985 y los nombres de ASPECTS en
//       src/lib/ebay-listing.ts). Si hay EBAY_REFRESH_TOKEN local, ademas las
//       tres politicas por nombre y las ubicaciones de inventario.
//
//   node scripts/ebay-oauth.mjs subscribe <worker_url>
//       Crea el destino (<worker_url>/?action=ebay-notify) y la suscripcion
//       ORDER_CONFIRMATION en la Notification API. Necesita EBAY_REFRESH_TOKEN
//       local (scope commerce.notification.subscription). El endpoint de
//       Marketplace Account Deletion se da de alta a mano en el portal (misma URL).
//
// Variables (entorno o .dev.vars, nunca en git): EBAY_CLIENT_ID,
// EBAY_CLIENT_SECRET, EBAY_RUNAME (el "eBay Redirect URL name" del keyset),
// EBAY_VERIFICATION_TOKEN y, para check/subscribe, EBAY_REFRESH_TOKEN.

import { spawn } from 'node:child_process';
import { cargarDevVars, DEV_VARS_PATH } from './lib/dev-vars.mjs';

cargarDevVars(DEV_VARS_PATH, ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RUNAME', 'EBAY_VERIFICATION_TOKEN', 'EBAY_REFRESH_TOKEN']);

const API = 'https://api.ebay.com';
const MARKETPLACE = 'EBAY_ES';
// Copia de EBAY_USER_SCOPES (src/lib/ebay-api.ts): node no importa .ts. Si
// cambia alli, cambia aqui — un refresh solo puede pedir scopes consentidos.
const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription',
];
// Copia de EBAY_POLICY_NAMES (src/lib/ebay-api.ts).
const POLICIES = {
  fulfillment: 'Vinilos - envío estándar',
  return: 'Vinilos - devolución 14 días, comprador paga',
  payment: 'Vinilos - pago inmediato',
};

const [cmd, arg] = process.argv.slice(2);
const envFlag = process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1] : 'staging';

function need(...keys) {
  const missing = keys.filter(k => !process.env[k]);
  if (missing.length) { console.error(`Faltan: ${missing.join(', ')} (entorno o .dev.vars)`); process.exit(1); }
}

async function token(body) {
  const r = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams(body).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`eBay rechazo el token (${r.status}): ${d.error_description || d.error || ''}`); process.exit(1); }
  return d;
}
const appToken = async () => (await token({ grant_type: 'client_credentials', scope: SCOPES[0] })).access_token;
const userToken = async () => (await token({ grant_type: 'refresh_token', refresh_token: process.env.EBAY_REFRESH_TOKEN, scope: SCOPES.join(' ') })).access_token;

async function api(tok, method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data, location: r.headers.get('location') };
}

if (cmd === 'consent') {
  need('EBAY_CLIENT_ID', 'EBAY_RUNAME');
  const q = `client_id=${encodeURIComponent(process.env.EBAY_CLIENT_ID)}&redirect_uri=${encodeURIComponent(process.env.EBAY_RUNAME)}`
    + `&response_type=code&scope=${SCOPES.map(encodeURIComponent).join('%20')}&prompt=login`;
  console.log(`Abre esto con la cuenta VENDEDORA de eBay:\n\nhttps://auth.ebay.com/oauth2/authorize?${q}\n`);
  console.log(`Luego: node scripts/ebay-oauth.mjs exchange '<URL a la que te devuelve eBay>' --env ${envFlag}`);
} else if (cmd === 'exchange') {
  need('EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RUNAME');
  if (!arg) { console.error('Uso: exchange <URL o code> [--env staging|production]'); process.exit(1); }
  let code = arg;
  try { code = new URL(arg).searchParams.get('code') || arg; } catch { code = decodeURIComponent(arg); }
  const d = await token({ grant_type: 'authorization_code', code, redirect_uri: process.env.EBAY_RUNAME });
  if (!d.refresh_token) { console.error('eBay no devolvio refresh_token'); process.exit(1); }
  const args = ['wrangler', 'secret', 'put', 'EBAY_REFRESH_TOKEN', ...(envFlag === 'production' ? [] : ['--env', envFlag])];
  const p = spawn('npx', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  p.stdin.end(d.refresh_token);
  p.on('exit', (c) => {
    const days = Math.round(Number(d.refresh_token_expires_in || 0) / 86400);
    console.log(c === 0
      ? `EBAY_REFRESH_TOKEN guardado en ${envFlag}. Caduca en ~${days} dias: repetir consent+exchange antes.`
      : 'wrangler secret put fallo; el token NO se ha guardado.');
    process.exit(c ?? 1);
  });
} else if (cmd === 'check') {
  need('EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET');
  const app = await appToken();
  const tree = await api(app, 'GET', `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE}`);
  const treeId = tree.data?.categoryTreeId;
  console.log(`Arbol de categorias ${MARKETPLACE}: ${treeId}`);
  const sug = await api(app, 'GET', `/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent('disco de vinilo')}`);
  for (const s of (sug.data?.categorySuggestions || []).slice(0, 8)) {
    const path = (s.categoryTreeNodeAncestors || []).map(a => a.categoryName).reverse().join(' > ');
    console.log(`  ${s.category.categoryId}  ${path} > ${s.category.categoryName}`);
  }
  const cat = arg || '176985';
  const asp = await api(app, 'GET', `/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category?category_id=${cat}`);
  console.log(`\nItem specifics de ${cat} (${asp.status}):`);
  for (const a of asp.data?.aspects || []) {
    console.log(`  ${a.aspectConstraint?.aspectRequired ? '[obligatorio] ' : ''}${a.localizedAspectName}`);
  }
  if (process.env.EBAY_REFRESH_TOKEN) {
    const u = await userToken();
    for (const [kind, name] of Object.entries(POLICIES)) {
      const r = await api(u, 'GET', `/sell/account/v1/${kind}_policy/get_by_policy_name?marketplace_id=${MARKETPLACE}&name=${encodeURIComponent(name)}`);
      console.log(`Politica ${kind} "${name}": ${r.status === 200 ? r.data[`${kind}PolicyId`] : `NO (${r.status})`}`);
    }
    const loc = await api(u, 'GET', '/sell/inventory/v1/location');
    console.log('Ubicaciones:', (loc.data?.locations || []).map(l => `${l.merchantLocationKey} (${l.merchantLocationStatus})`).join(', ') || 'NINGUNA — crear una en Seller Hub');
  } else {
    console.log('\n(sin EBAY_REFRESH_TOKEN local: politicas y ubicaciones sin comprobar)');
  }
} else if (cmd === 'subscribe') {
  need('EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_REFRESH_TOKEN', 'EBAY_VERIFICATION_TOKEN');
  if (!arg || !arg.startsWith('https://')) { console.error('Uso: subscribe https://houseonly-worker-staging.emontagut.workers.dev'); process.exit(1); }
  const u = await userToken();
  const endpoint = `${arg.replace(/\/$/, '')}/?action=ebay-notify`;
  const dest = await api(u, 'POST', '/commerce/notification/v1/destination', {
    name: 'houseonly-worker', status: 'ENABLED',
    deliveryConfig: { endpoint, verificationToken: process.env.EBAY_VERIFICATION_TOKEN },
  });
  if (dest.status !== 201) { console.error('createDestination:', dest.status, JSON.stringify(dest.data)); process.exit(1); }
  const destinationId = (dest.location || '').split('/').pop();
  const sub = await api(u, 'POST', '/commerce/notification/v1/subscription', {
    topicId: 'ORDER_CONFIRMATION', status: 'ENABLED', destinationId,
    payload: { format: 'JSON', schemaVersion: '1.0', deliveryProtocol: 'HTTPS' },
  });
  console.log(sub.status === 201 ? `Suscrito ORDER_CONFIRMATION → ${endpoint}` : `createSubscription: ${sub.status} ${JSON.stringify(sub.data)}`);
} else {
  console.log('Uso: node scripts/ebay-oauth.mjs consent | exchange <url> | check [categoria] | subscribe <worker_url>   [--env staging|production]');
}
