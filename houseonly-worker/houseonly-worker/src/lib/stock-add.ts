// ── ADD STOCK: llegada de una factura a productos que ya estan en la tienda ──
//
//   POST ?action=stock-add   Bearer de admin
//     { invoice: "SI-286408", source?: "rd", items: [{ sku, delta }], dry?: true }
//
// Para cada SKU: lo resuelve a su inventoryItem, lee la cantidad `available` en
// la ubicacion de la tienda y la SUMA con inventoryAdjustQuantities. Nunca fija
// cantidades —fijarlas borraria el saldo negativo de oversell, que es el
// registro de lo pre-vendido— y no toca ningun otro campo del producto.
//
// IDEMPOTENCIA, que es de donde vienen los errores de inventario. Se guarda en
// STOCK_LEDGER que factura ya sumo que SKU (`stock:{FACTURA}:{SKU}`). Ese KV es
// el MISMO para prod y staging, porque los dos workers escriben en la misma
// tienda. Por SKU:
//   - ya "aplicado"  → no se suma, se devuelve lo que se sumo y cuando.
//   - "en-curso"     → no se suma: hay un intento sin cerrar (otra pestaña, o
//                      un corte a mitad sin saber si Shopify lo aplico). Se dice.
//   - nada           → se marca "en-curso" ANTES de llamar a Shopify, y solo se
//                      borra si Shopify dice que NO lo aplico.
// Ademas changeFromQuantity = la cantidad leida: si alguien vende entre la
// lectura y la suma, Shopify rechaza (CHANGE_FROM_QUANTITY_STALE) en vez de
// sumar sobre un dato viejo.
//
// dry por defecto: lista lo que sumaria, sin tocar Shopify ni el registro.

import { shopifyAdminGraphQL, getShopifyAdminToken, type ShopifyAdminEnv } from './shopify-admin';

export interface StockAddEnv extends ShopifyAdminEnv {
  STOCK_LEDGER: KVNamespace;
}

type Estado = 'sumaria' | 'sumado' | 'ya-aplicado' | 'en-curso' | 'error';

interface Resultado {
  sku: string;
  estado: Estado;
  delta: number;
  antes?: number | null;
  despues?: number | null;
  producto?: string;
  motivo?: string;
  aplicadoEn?: string;
}

const claveRegistro = (factura: string, sku: string) => `stock:${factura}:${sku}`;

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*, Authorization',
      'Content-Type': 'application/json',
    },
  });
}

async function sha256(texto: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function scopesDeLaApp(env: StockAddEnv, refrescar: boolean): Promise<string[]> {
  // Token nuevo en el dry-run: un token cacheado anterior a un permiso recien
  // concedido no lo reflejaria.
  if (refrescar) await getShopifyAdminToken(env, true);
  const r = await shopifyAdminGraphQL(env, `query { currentAppInstallation { accessScopes { handle } } }`);
  return (r?.data?.currentAppInstallation?.accessScopes || []).map((s: any) => s.handle);
}

// La ubicacion de la tienda. Si hay mas de una activa no se elige a ciegas.
async function ubicacionDeLaTienda(env: StockAddEnv): Promise<{ id: string; name: string } | { error: string }> {
  const r = await shopifyAdminGraphQL(env, `
    query { locations(first: 10, includeInactive: false) { edges { node { id name } } } }`);
  if (r?.errors?.length) return { error: `Shopify: ${r.errors.map((e: any) => e.message).join('; ')}` };
  const locs = (r?.data?.locations?.edges || []).map((e: any) => e.node);
  if (locs.length === 1) return locs[0];
  if (!locs.length) return { error: 'la tienda no tiene ninguna ubicacion activa' };
  return { error: `hay ${locs.length} ubicaciones activas (${locs.map((l: any) => l.name).join(', ')}); no se elige a ciegas` };
}

interface Variante {
  inventoryItemId: string;
  tracked: boolean;
  disponible: number | null;   // null = el item no esta activo en esa ubicacion
  producto: string;
}

async function resolverSku(env: StockAddEnv, sku: string, locationId: string): Promise<Variante | { error: string }> {
  const r = await shopifyAdminGraphQL(env, `
    query ($q: String!, $loc: ID!) {
      productVariants(first: 10, query: $q) {
        edges { node {
          sku
          product { title }
          inventoryItem {
            id tracked
            inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } }
          }
        } }
      }
    }`, { q: `sku:"${sku.replace(/"/g, '\\"')}"`, loc: locationId });
  if (r?.errors?.length) return { error: `Shopify: ${r.errors.map((e: any) => e.message).join('; ')}` };
  // La busqueda de Shopify es laxa: solo cuenta el SKU exacto.
  const exactas = (r?.data?.productVariants?.edges || []).map((e: any) => e.node).filter((n: any) => n?.sku === sku);
  if (!exactas.length) return { error: 'no hay ninguna variante con ese SKU exacto' };
  if (exactas.length > 1) return { error: `${exactas.length} variantes comparten ese SKU; no se suma a ninguna` };
  const v = exactas[0];
  const nivel = v.inventoryItem?.inventoryLevel;
  const q = nivel?.quantities?.find((x: any) => x.name === 'available');
  return {
    inventoryItemId: v.inventoryItem?.id,
    tracked: !!v.inventoryItem?.tracked,
    disponible: nivel ? (typeof q?.quantity === 'number' ? q.quantity : null) : null,
    producto: v.product?.title || '',
  };
}

export async function handleStockAdd(request: Request, env: StockAddEnv, bearerValido: boolean): Promise<Response> {
  if (!bearerValido) return json({ error: 'unauthorized' }, 401);
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const factura = String(body?.invoice || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{2,40}$/.test(factura)) {
    return json({ error: 'invoice requerido: el numero de la factura, p. ej. SI-286408' }, 400);
  }
  const dry = body?.dry !== false;

  // Mismo SKU dos veces en la peticion = se suma en una sola linea.
  const porSku = new Map<string, number>();
  const invalidos: Resultado[] = [];
  for (const it of (Array.isArray(body?.items) ? body.items : [])) {
    const sku = String(it?.sku || '').trim();
    const delta = Number(it?.delta);
    if (!sku || !Number.isInteger(delta) || delta < 1 || delta > 1000) {
      invalidos.push({ sku, estado: 'error', delta: Number.isFinite(delta) ? delta : 0, motivo: 'delta debe ser un entero entre 1 y 1000' });
      continue;
    }
    porSku.set(sku, (porSku.get(sku) || 0) + delta);
  }
  if (!porSku.size && !invalidos.length) return json({ error: 'items requerido: [{sku, delta}]' }, 400);

  let scopes: string[] = [];
  try { scopes = await scopesDeLaApp(env, dry); }
  catch (e: any) { return json({ error: `no se pudieron leer los permisos de la app: ${e.message}` }, 502); }
  const permisos = {
    write_inventory: scopes.includes('write_inventory'),
    read_inventory: scopes.includes('read_inventory'),
    read_locations: scopes.includes('read_locations'),
  };
  if (!dry && !permisos.write_inventory) {
    return json({ error: 'la app de Admin del worker no tiene el permiso write_inventory: no se ha tocado nada', permisos }, 403);
  }

  const ubicacion = await ubicacionDeLaTienda(env);
  if ('error' in ubicacion) return json({ error: ubicacion.error, permisos }, 502);

  const resultados: Resultado[] = [...invalidos];
  for (const [sku, delta] of porSku) {
    const clave = claveRegistro(factura, sku);
    const previo = await env.STOCK_LEDGER.get(clave, 'json') as any;
    if (previo?.estado === 'aplicado') {
      const porCsv = previo.origen === 'csv';
      resultados.push({ sku, estado: 'ya-aplicado', delta: previo.delta, antes: previo.antes, despues: previo.despues,
                        producto: previo.producto, aplicadoEn: previo.at,
                        motivo: porCsv
                          ? `su cantidad (${previo.delta}) la puso el CSV de esta factura, descargado el ${String(previo.at).slice(0, 16).replace('T', ' ')} UTC; si ese CSV no se llegó a importar, corrígelo en Shopify`
                          : (previo.delta !== delta ? `esta factura ya sumó ${previo.delta}; ahora se pedía ${delta}` : '') });
      continue;
    }
    if (previo?.estado === 'en-curso') {
      resultados.push({ sku, estado: 'en-curso', delta, aplicadoEn: previo.at,
                        motivo: 'hay un intento de esta factura sin cerrar; comprueba el historial de inventario del SKU en Shopify antes de repetir' });
      continue;
    }

    let v: Variante | { error: string };
    try { v = await resolverSku(env, sku, ubicacion.id); }
    catch (e: any) { resultados.push({ sku, estado: 'error', delta, motivo: e.message }); continue; }
    if ('error' in v) { resultados.push({ sku, estado: 'error', delta, motivo: v.error }); continue; }
    if (!v.tracked) { resultados.push({ sku, estado: 'error', delta, producto: v.producto, motivo: 'el inventario de este producto no tiene seguimiento en Shopify' }); continue; }
    if (v.disponible === null) { resultados.push({ sku, estado: 'error', delta, producto: v.producto, motivo: `no está activo en la ubicación ${ubicacion.name}` }); continue; }

    if (dry) {
      resultados.push({ sku, estado: 'sumaria', delta, antes: v.disponible, despues: v.disponible + delta, producto: v.producto });
      continue;
    }

    // Se marca ANTES de tocar Shopify. Sin caducidad: si algo corta a mitad y no
    // se sabe si Shopify lo aplico, es mejor que quede bloqueado y a la vista
    // que sumar dos veces.
    const at = new Date().toISOString();
    await env.STOCK_LEDGER.put(clave, JSON.stringify({ estado: 'en-curso', factura, sku, delta, at, source: body?.source || '' }));

    let r: any;
    try {
      r = await shopifyAdminGraphQL(env, `
        mutation ($input: InventoryAdjustQuantitiesInput!, $key: String!) {
          inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
            userErrors { field message code }
            inventoryAdjustmentGroup { id changes { name delta quantityAfterChange } }
          }
        }`, {
        input: {
          reason: 'received',
          name: 'available',
          changes: [{ inventoryItemId: v.inventoryItemId, locationId: ubicacion.id, delta, changeFromQuantity: v.disponible }],
        },
        key: (await sha256(`stock-add|${factura}|${sku}|${delta}|${at}`)).slice(0, 64),
      });
    } catch (e: any) {
      // Resultado desconocido: el registro se queda en "en-curso".
      resultados.push({ sku, estado: 'error', delta, antes: v.disponible, producto: v.producto,
                        motivo: `sin respuesta de Shopify (${e.message}); queda bloqueado: comprueba el historial del SKU` });
      continue;
    }

    const grupo = r?.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup;
    const errores = [...(r?.errors || []), ...(r?.data?.inventoryAdjustQuantities?.userErrors || [])];
    if (errores.length || !grupo) {
      // Shopify dice que NO lo aplico: se libera para poder repetir.
      await env.STOCK_LEDGER.delete(clave);
      const stale = errores.some((e: any) => e?.code === 'CHANGE_FROM_QUANTITY_STALE');
      resultados.push({ sku, estado: 'error', delta, antes: v.disponible, producto: v.producto,
                        motivo: stale ? 'la cantidad cambió entre la lectura y la suma (una venta); repite'
                              : (errores.map((e: any) => e.message).join('; ') || 'Shopify no devolvió el ajuste') });
      continue;
    }
    const cambio = (grupo.changes || []).find((c: any) => c.name === 'available');
    const despues = typeof cambio?.quantityAfterChange === 'number' ? cambio.quantityAfterChange : v.disponible + delta;
    await env.STOCK_LEDGER.put(clave, JSON.stringify({
      estado: 'aplicado', factura, sku, delta, antes: v.disponible, despues, producto: v.producto,
      at, groupId: grupo.id, source: body?.source || '',
    }));
    resultados.push({ sku, estado: 'sumado', delta, antes: v.disponible, despues, producto: v.producto, aplicadoEn: at });
  }

  return json({ ok: true, dry, invoice: factura, ubicacion, permisos, resultados });
}

// ── CSV DE UNA FACTURA → LIBRO DE STOCK ──────────────────────────────────────
//
//   POST ?action=stock-csv   Bearer de admin
//     { invoice: "SI-286408", source?: "rd", items: [{ sku, delta }] }
//
// El CSV crea los productos nuevos de una factura con la cantidad de la factura.
// Si despues ese disco aparece "en tienda" y se pulsa Add stock con la MISMA
// factura, se sumaria dos veces (MEOW01, 16-09: 2 por el CSV + 2 por Add stock).
// Por eso el importer anota aqui, ANTES de descargar el CSV, que esa factura ya
// dio cantidad a esos SKUs. Nunca pisa una entrada existente: si Add stock ya
// sumo, o el CSV se descargo antes, se deja como esta y se dice.
export async function handleStockCsv(request: Request, env: StockAddEnv, bearerValido: boolean): Promise<Response> {
  if (!bearerValido) return json({ error: 'unauthorized' }, 401);
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const factura = String(body?.invoice || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{2,40}$/.test(factura)) {
    return json({ error: 'invoice requerido: el numero de la factura, p. ej. SI-286408' }, 400);
  }
  const porSku = new Map<string, number>();
  for (const it of (Array.isArray(body?.items) ? body.items : [])) {
    const sku = String(it?.sku || '').trim();
    const delta = Number(it?.delta);
    if (sku && Number.isInteger(delta) && delta >= 0 && delta <= 1000) porSku.set(sku, (porSku.get(sku) || 0) + delta);
  }
  if (!porSku.size) return json({ error: 'items requerido: [{sku, delta}]' }, 400);

  const at = new Date().toISOString();
  const resultados: any[] = [];
  for (const [sku, delta] of porSku) {
    const clave = claveRegistro(factura, sku);
    const previo = await env.STOCK_LEDGER.get(clave, 'json') as any;
    if (previo) {
      resultados.push({ sku, estado: 'ya-estaba', origen: previo.origen || 'stock-add', delta: previo.delta, at: previo.at });
      continue;
    }
    await env.STOCK_LEDGER.put(clave, JSON.stringify({
      estado: 'aplicado', origen: 'csv', factura, sku, delta, antes: null, despues: null, at, source: body?.source || '',
    }));
    resultados.push({ sku, estado: 'anotado', delta });
  }
  return json({ ok: true, invoice: factura, resultados });
}
