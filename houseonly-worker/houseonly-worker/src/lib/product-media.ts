// ── COMPLETAR MEDIA de discos que ya estan en la tienda ──────────────────────
//
//   POST ?action=product-media   Bearer de admin
//     { dry?: true, items: [{ sku, imageUrl?, tracks?: [{name, d, url}], notasHtml?, forzar? }] }
//
// Para un producto que ya existe y le falta portada o audio: añade la imagen y/o
// el <script id="tracks"> con los MP3 ya subidos a R2 por el importer. SOLO toca
// media y descripcion — nada de precio, inventario, tags ni estado.
//
// Reglas:
//   - Solo se añade lo que FALTA: portada si no tiene ninguna imagen; audio si la
//     descripcion no lleva <script id="tracks">; y el texto del importer solo si
//     la descripcion no tiene texto propio. El texto existente nunca se borra.
//   - Un producto que ya tiene portada Y audio no se toca ("completo"), salvo
//     `forzar: true`, que sustituye portada y audio (el texto sigue sin tocarse).
//   - Repetir es seguro: la segunda vez el producto ya tiene lo que faltaba.
//
// dry por defecto: dice que tiene cada producto y que haria, sin escribir.
// API vigente (2026-04): productUpdate(product, media) para descripcion e
// imagen; fileUpdate(referencesToRemove) para desvincular la portada vieja al
// forzar. productCreateMedia/productDeleteMedia estan obsoletas.

import { shopifyAdminGraphQL, getShopifyAdminToken, type ShopifyAdminEnv } from './shopify-admin';

type Estado = 'haria' | 'completado' | 'completo' | 'sin-media' | 'error';

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

const RE_TRACKS = /<script[^>]*\bid=["']tracks["'][^>]*>[\s\S]*?<\/script>/gi;
const textoVisible = (html: string) =>
  String(html || '').replace(RE_TRACKS, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function scriptTracks(tracks: any[]): string {
  // Mismo formato que escriben los importers; "<" escapado para que un titulo
  // con "</script>" no rompa la etiqueta.
  const limpio = tracks.map((t: any) => ({ name: String(t?.name || ''), d: String(t?.d || ''), url: String(t?.url || '') }))
    .filter(t => /^https:\/\//.test(t.url));
  return `<script type="application/json" id="tracks">${JSON.stringify(limpio).replace(/</g, '\\u003c')}</script>`;
}

async function productoPorSku(env: ShopifyAdminEnv, sku: string): Promise<any> {
  const r = await shopifyAdminGraphQL(env, `
    query ($q: String!) {
      productVariants(first: 10, query: $q) {
        edges { node { sku product {
          id title descriptionHtml
          media(first: 20) { nodes { id mediaContentType } }
        } } }
      }
    }`, { q: `sku:"${sku.replace(/"/g, '\\"')}"` });
  if (r?.errors?.length) return { error: `Shopify: ${r.errors.map((e: any) => e.message).join('; ')}` };
  const exactas = (r?.data?.productVariants?.edges || []).map((e: any) => e.node).filter((n: any) => n?.sku === sku);
  if (!exactas.length) return { error: 'no hay ninguna variante con ese SKU exacto' };
  const ids = [...new Set(exactas.map((n: any) => n.product?.id))];
  if (ids.length > 1) return { error: `${ids.length} productos comparten ese SKU; no se toca ninguno` };
  return exactas[0].product;
}

export async function handleProductMedia(request: Request, env: ShopifyAdminEnv, bearerValido: boolean): Promise<Response> {
  if (!bearerValido) return json({ error: 'unauthorized' }, 401);
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const dry = body?.dry !== false;
  const items = Array.isArray(body?.items) ? body.items.slice(0, 100) : [];
  if (!items.length) return json({ error: 'items requerido: [{sku, imageUrl?, tracks?, notasHtml?}]' }, 400);

  let scopes: string[] = [];
  try {
    if (dry) await getShopifyAdminToken(env, true);
    const s = await shopifyAdminGraphQL(env, `query { currentAppInstallation { accessScopes { handle } } }`);
    scopes = (s?.data?.currentAppInstallation?.accessScopes || []).map((x: any) => x.handle);
  } catch (e: any) { return json({ error: `no se pudieron leer los permisos de la app: ${e.message}` }, 502); }
  const permisos = { write_products: scopes.includes('write_products'), read_products: scopes.includes('read_products') };
  if (!dry && !permisos.write_products) {
    return json({ error: 'la app de Admin del worker no tiene el permiso write_products: no se ha tocado nada', permisos }, 403);
  }

  const resultados: any[] = [];
  for (const it of items) {
    const sku = String(it?.sku || '').trim();
    const imageUrl = /^https:\/\//.test(String(it?.imageUrl || '')) ? String(it.imageUrl) : '';
    const tracks = Array.isArray(it?.tracks) ? it.tracks : [];
    const notasHtml = String(it?.notasHtml || '');
    const forzar = it?.forzar === true;
    if (!sku) { resultados.push({ sku, estado: 'error', motivo: 'sku requerido' }); continue; }

    let p: any;
    try { p = await productoPorSku(env, sku); }
    catch (e: any) { resultados.push({ sku, estado: 'error', motivo: e.message }); continue; }
    if (p?.error) { resultados.push({ sku, estado: 'error', motivo: p.error }); continue; }

    const imagenes = (p.media?.nodes || []).filter((m: any) => m.mediaContentType === 'IMAGE');
    const tieneImagen = imagenes.length > 0;
    const tieneAudio = RE_TRACKS.test(p.descriptionHtml || ''); RE_TRACKS.lastIndex = 0;
    const tieneTexto = !!textoVisible(p.descriptionHtml);
    const base = { sku, producto: p.title, tieneImagen, tieneAudio, tieneTexto };

    if (tieneImagen && tieneAudio && !forzar) { resultados.push({ ...base, estado: 'completo' }); continue; }

    const ponerImagen = !!imageUrl && (!tieneImagen || forzar);
    const ponerAudio = tracks.length > 0 && (!tieneAudio || forzar);
    const ponerTexto = !tieneTexto && !!textoVisible(notasHtml);
    const hara = [ponerImagen && (tieneImagen ? 'sustituir portada' : 'portada'),
                  ponerAudio && (tieneAudio ? 'sustituir audio' : 'audio'),
                  ponerTexto && 'texto'].filter(Boolean);
    if (!hara.length) {
      resultados.push({ ...base, estado: 'sin-media',
        motivo: `al producto le falta ${[!tieneImagen && 'portada', !tieneAudio && 'audio'].filter(Boolean).join(' y ')} y el importer no tiene con qué completarlo` });
      continue;
    }
    if (dry) { resultados.push({ ...base, estado: 'haria', hara }); continue; }

    // Descripcion nueva: el texto que ya tenga el producto se conserva siempre.
    let desc = String(p.descriptionHtml || '');
    if (ponerTexto) desc = notasHtml.replace(RE_TRACKS, '') + desc;
    if (ponerAudio) desc = desc.replace(RE_TRACKS, '') + scriptTracks(tracks);
    RE_TRACKS.lastIndex = 0;
    const cambiaDesc = desc !== String(p.descriptionHtml || '');

    const r = await shopifyAdminGraphQL(env, `
      mutation ($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
        productUpdate(product: $product, media: $media) {
          product { id }
          userErrors { field message }
        }
      }`, {
      product: { id: p.id, ...(cambiaDesc ? { descriptionHtml: desc } : {}) },
      media: ponerImagen ? [{ originalSource: imageUrl, mediaContentType: 'IMAGE', alt: p.title }] : null,
    });
    const errores = [...(r?.errors || []), ...(r?.data?.productUpdate?.userErrors || [])];
    if (errores.length || !r?.data?.productUpdate?.product) {
      resultados.push({ ...base, estado: 'error', motivo: errores.map((e: any) => e.message).join('; ') || 'Shopify no confirmó la actualización' });
      continue;
    }

    // Forzar con portada: la vieja se desvincula DESPUES de añadir la nueva, para
    // que el producto no se quede nunca sin imagen.
    let aviso = '';
    if (ponerImagen && tieneImagen) {
      const f = await shopifyAdminGraphQL(env, `
        mutation ($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { userErrors { field message } } }`,
        { files: imagenes.map((m: any) => ({ id: m.id, referencesToRemove: [p.id] })) });
      const fe = [...(f?.errors || []), ...(f?.data?.fileUpdate?.userErrors || [])];
      if (fe.length) aviso = `portada nueva añadida, pero la vieja no se pudo quitar: ${fe.map((e: any) => e.message).join('; ')}`;
    }
    resultados.push({ ...base, estado: 'completado', hizo: hara, ...(aviso ? { motivo: aviso } : {}) });
  }
  return json({ ok: true, dry, permisos, resultados });
}
