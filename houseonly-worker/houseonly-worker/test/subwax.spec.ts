import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { leeXlsx, parseStocklist, resuelveSoundcloud, refreshSubwax, handleSubwaxOrder, handleSubwaxStock, handleSubwaxRefresh, resuelvePendientes, normSku, desentidad } from "../src/lib/subwax";
import * as shopifyAdmin from "../src/lib/shopify-admin";

const E = env as any;

// xlsx minimo con la forma del export de Google Sheets: sharedStrings, dos
// hojas por rels, formulas HYPERLINK en LISTEN (t="str"), precios numericos.
function xlsx(): Uint8Array {
  const sst = ['LABEL', 'NEW ARRIVALS', 'BACK CATALOGUE', 'BinarySound', 'BNSD010', 'Antoine Sy', 'Seksensun EP', "12''", 'Daydream', 'DAYDREAM024', 'Soha', 'Eyes Closed EP', 'PRE ORDERS', 'Exarde', 'XRD045', 'Rambal &amp; Co', 'Dreamcast Boy', 'Certain', 'CMR010', 'VA', '10 Years', "2 x 12''"];
  const si = sst.map((t) => `<si><t>${t}</t></si>`).join('');
  const s = (ref: string, i: number) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
  const n = (ref: string, v: number) => `<c r="${ref}"><v>${v}</v></c>`;
  const link = (ref: string, url: string, label: string) => `<c r="${ref}" t="str"><f>HYPERLINK(&quot;${url}&quot;,&quot;${label}&quot;)</f><v>${label}</v></c>`;
  const sheet1 = `<worksheet><sheetData>
<row r="5">${s('D5', 1)}</row>
<row r="7">${s('B7', 0)}</row>
<row r="9">${s('B9', 3)}${s('C9', 4)}${s('D9', 5)}${s('E9', 6)}${s('F9', 7)}${link('G9', 'https://soundcloud.com/subwax-bcn-distribution/bnsd010/s-rstbrivTXe9?si=abc', 'BNSD010')}${n('I9', 7.99)}</row>
<row r="10">${s('B10', 8)}${s('C10', 9)}${s('D10', 10)}${s('E10', 11)}${s('F10', 7)}${s('G10', 9)}${n('I10', 7.99)}</row>
<row r="12">${s('D12', 2)}</row>
<row r="13">${s('B13', 17)}${s('C13', 18)}${s('D13', 19)}${s('E13', 20)}${s('F13', 21)}${link('G13', 'https://soundcloud.com/subwax-bcn-distribution/cmr010', 'CMR010')}${n('I13', 17.99)}</row>
</sheetData></worksheet>`;
  const sheet2 = `<worksheet><sheetData>
<row r="4">${s('D4', 12)}</row>
<row r="6">${s('B6', 0)}</row>
<row r="8">${s('B8', 13)}${s('C8', 14)}${s('D8', 15)}${s('E8', 16)}${s('F8', 7)}${link('G8', 'https://soundcloud.com/subwax-bcn-distribution/xrd045/s-gjaPhMU5xHp', 'XRD045')}${n('I8', 8.49)}</row>
</sheetData></worksheet>`;
  return zipSync({
    'xl/workbook.xml': strToU8(`<workbook><sheets><sheet state="visible" name="STOCKLIST" sheetId="1" r:id="rId4"/><sheet state="visible" name="PRE-ORDERS" sheetId="2" r:id="rId5"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<Relationships><Relationship Id="rId4" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId5" Type="x" Target="worksheets/sheet2.xml"/></Relationships>`),
    'xl/sharedStrings.xml': strToU8(`<sst count="${sst.length}" uniqueCount="${sst.length}">${si}</sst>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet1),
    'xl/worksheets/sheet2.xml': strToU8(sheet2),
  });
}

const oembed = (id: number, tok?: string) => new Response(JSON.stringify({
  html: `<iframe src="https://w.soundcloud.com/player/?visual=true&amp;url=${encodeURIComponent(`https://api.soundcloud.com/tracks/${id}`)}&amp;show_artwork=true${tok ? `&amp;secret_token=${tok}` : ''}"></iframe>`,
}), { headers: { 'content-type': 'application/json' } });

const xlsxResponse = () => new Response(xlsx(), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });

function fetcher(onOembed = (u: string) => oembed(111, 's-rstbrivTXe9')): typeof fetch {
  return vi.fn(async (input: any) => {
    const u = String(input);
    if (u.includes('/export?format=xlsx')) return xlsxResponse();
    if (u.includes('soundcloud.com/oembed')) return onOembed(u);
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('subwax: xlsx y stocklist', () => {
  it('lee las dos hojas, las secciones y el URL de las formulas HYPERLINK', () => {
    const filas = parseStocklist(leeXlsx(xlsx()));
    expect(filas.map((f) => [f.cat, f.section])).toEqual([
      ['BNSD010', 'NEW ARRIVALS'], ['DAYDREAM024', 'NEW ARRIVALS'], ['CMR010', 'BACK CATALOGUE'], ['XRD045', 'PRE ORDERS'],
    ]);
    expect(filas[0]).toMatchObject({ label: 'BinarySound', artist: 'Antoine Sy', title: 'Seksensun EP', format: "12''", price: 7.99, listen: 'https://soundcloud.com/subwax-bcn-distribution/bnsd010/s-rstbrivTXe9?si=abc' });
    expect(filas[1].listen).toBeNull();            // texto sin enlace = sin audio
    expect(filas[3].artist).toBe('Rambal & Co');   // entidades del sharedStrings
  });
  it('desentidad y normSku', () => {
    expect(desentidad('a&amp;b &quot;c&quot; &#39;d&#39; &#x41;')).toBe(`a&b "c" 'd' A`);
    expect(normSku(' mid-flow01 ')).toBe('MIDFLOW01');
  });
});

describe('subwax: soundcloud', () => {
  it('saca id y token del oembed y quita el ?si= del enlace', async () => {
    const f = fetcher();
    const r = await resuelveSoundcloud('https://soundcloud.com/subwax-bcn-distribution/bnsd010/s-rstbrivTXe9?si=abc', f);
    expect(r.embed).toBe('https://api.soundcloud.com/tracks/111?secret_token=s-rstbrivTXe9');
    expect(String((f as any).mock.calls[0][0])).toContain(encodeURIComponent('https://soundcloud.com/subwax-bcn-distribution/bnsd010/s-rstbrivTXe9'));
    expect(String((f as any).mock.calls[0][0])).not.toContain('si%3D');
  });
  it('publico sin token y errores', async () => {
    expect((await resuelveSoundcloud('https://soundcloud.com/x/y', fetcher(() => oembed(5)))).embed).toBe('https://api.soundcloud.com/tracks/5');
    expect(await resuelveSoundcloud('https://soundcloud.com/x/y', fetcher(() => new Response('', { status: 404 })))).toEqual({ embed: null, error: 'oembed 404' });
    expect((await resuelveSoundcloud('https://us.list-manage.com/x', fetcher())).error).toBe('no-soundcloud');
  });
});

describe('subwax: refresh y pedidos', () => {
  beforeEach(async () => {
    await E.SYNC_STATE.delete('subwax:stock');
    await E.SYNC_STATE.delete('subwax:orders');
    vi.restoreAllMocks();
  });

  it('guarda la stocklist, resuelve por tandas, cruza con Shopify y detecta nuevos/agotados', async () => {
    vi.spyOn(shopifyAdmin, 'searchVariantsBySkus').mockResolvedValue([
      { id: 'gid://1', sku: 'cmr010', inventoryQuantity: 2, title: 'VA - 10 Years', status: 'ACTIVE' },
    ]);
    const now = new Date('2026-11-05T06:00:00Z');
    const r1 = await refreshSubwax(E, { fetcher: fetcher(), now, maxResolve: 2, minRows: 1 });
    expect(r1).toMatchObject({ ok: true, rows: 4, nuevos: 4, agotados: 0, resueltos: 2, pendientes: 1, shop_matched: 1 });
    const s1 = JSON.parse(await E.SYNC_STATE.get('subwax:stock'));
    expect(s1.rows.find((r: any) => r.cat === 'CMR010').shop).toMatchObject({ sku: 'cmr010', qty: 2 });
    expect(s1.rows.find((r: any) => r.cat === 'DAYDREAM024').embed).toBeNull();
    expect(s1.rows.filter((r: any) => r.embed).length).toBe(2);

    // Segunda pasada: termina de resolver, nada nuevo, conserva first_seen.
    const r2 = await refreshSubwax(E, { fetcher: fetcher(), now: new Date('2026-11-06T06:00:00Z'), maxResolve: 30, minRows: 1 });
    expect(r2).toMatchObject({ nuevos: 0, resueltos: 1, pendientes: 0 });
    const s2 = JSON.parse(await E.SYNC_STATE.get('subwax:stock'));
    expect(s2.rows[0].first_seen).toBe(now.toISOString());
    expect((fetcher() as any).mock).toBeDefined();

    // Tercera: la hoja pierde CMR010 → agotado, con su embed guardado.
    const f3 = vi.fn(async (input: any) => {
      const u = String(input);
      if (u.includes('format=xlsx')) {
        const z = xlsx();
        // misma hoja pero sin la fila 13: se reconstruye quitando esa fila del xml
        const { unzipSync, zipSync: zs, strFromU8, strToU8: su } = await import('fflate');
        const files = unzipSync(z);
        const x = strFromU8(files['xl/worksheets/sheet1.xml']).replace(/<row r="13">[\s\S]*?<\/row>/, '');
        files['xl/worksheets/sheet1.xml'] = su(x);
        return new Response(zs(files), { headers: { 'content-type': 'application/zip' } });
      }
      return oembed(1);
    }) as unknown as typeof fetch;
    const r3 = await refreshSubwax(E, { fetcher: f3, now: new Date('2026-11-07T06:00:00Z'), shopify: false, minRows: 1 });
    expect(r3).toMatchObject({ rows: 3, agotados: 1 });
    const s3 = JSON.parse(await E.SYNC_STATE.get('subwax:stock'));
    expect(s3.gone[0]).toMatchObject({ cat: 'CMR010', gone_at: '2026-11-07T06:00:00.000Z' });
  });

  it('only=resolve resuelve sobre lo guardado sin bajar la hoja ni tocar Shopify', async () => {
    const spy = vi.spyOn(shopifyAdmin, 'searchVariantsBySkus').mockResolvedValue([]);
    await refreshSubwax(E, { fetcher: fetcher(), maxResolve: 0, minRows: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    const f = fetcher();
    const r1 = await resuelvePendientes(E, 2, f);
    expect(r1).toMatchObject({ resueltos: 2, fallidos: 0, pendientes: 1 });
    const r2 = await resuelvePendientes(E, 40, f);
    expect(r2).toMatchObject({ resueltos: 1, pendientes: 0 });
    expect((f as any).mock.calls.every((c: any) => String(c[0]).includes('oembed'))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await E.SYNC_STATE.get('subwax:stock')).rows.filter((r: any) => r.embed).length).toBe(3);
    // Sin stock guardado no rompe; y la ruta exige Bearer.
    await E.SYNC_STATE.delete('subwax:stock');
    expect(await resuelvePendientes(E, 5, f)).toMatchObject({ pendientes: 0, sin_stock: true });
    expect((await handleSubwaxRefresh(new Request('https://w/?action=subwax-refresh&only=resolve', { method: 'POST' }), E, false)).status).toBe(401);
  });

  it('no pisa la stocklist si la hoja deja de ser publica (html) o viene vacia', async () => {
    const f = vi.fn(async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(refreshSubwax(E, { fetcher: f, shopify: false })).rejects.toThrow(/content-type/);
    await expect(refreshSubwax(E, { fetcher: fetcher(), shopify: false })).rejects.toThrow(/solo 4 filas/);
    expect(await E.SYNC_STATE.get('subwax:stock')).toBeNull();
  });

  it('libro de pedidos: alta con precios de la stocklist, estado y borrado; todo con Bearer', async () => {
    vi.spyOn(shopifyAdmin, 'searchVariantsBySkus').mockResolvedValue([]);
    await refreshSubwax(E, { fetcher: fetcher(), maxResolve: 0, minRows: 1 });
    const post = (body: any, ok = true) => handleSubwaxOrder(new Request('https://w/?action=subwax-order', { method: 'POST', body: JSON.stringify(body) }), E, ok);
    expect((await post({ op: 'add', lines: [] }, false)).status).toBe(401);
    expect((await post({ op: 'add', lines: [] })).status).toBe(400);
    const a: any = await (await post({ op: 'add', kind: 'order', date: '05/11/2026', lines: [{ cat: 'BNSD010', qty: 3 }, { cat: 'CMR010', qty: 2 }, { cat: 'NOEXISTE', qty: 0 }] })).json();
    expect(a.order).toMatchObject({ kind: 'order', status: 'draft', total: 59.95, client: 'Telsnap S.L.' });
    expect(a.order.lines).toHaveLength(2);
    expect(a.order.lines[1]).toMatchObject({ cat: 'CMR010', label: 'Certain', artist: 'VA', price: 17.99 });
    const p: any = await (await post({ op: 'add', kind: 'preorder', lines: [{ cat: 'XRD045', qty: 1 }] })).json();
    expect(p.order.id.startsWith('p_')).toBe(true);
    const st: any = await (await post({ op: 'status', id: a.order.id, status: 'sent' })).json();
    expect(st.orders.find((o: any) => o.id === a.order.id).status).toBe('sent');
    expect((await post({ op: 'status', id: a.order.id, status: 'perdido' })).status).toBe(400);
    expect((await post({ op: 'delete', id: 'nada' })).status).toBe(404);
    await post({ op: 'delete', id: p.order.id });
    const all: any = await (await handleSubwaxStock(E, true)).json();
    expect(all.orders).toHaveLength(1);
    expect(all.stock.rows).toHaveLength(4);
    expect((await handleSubwaxStock(E, false)).status).toBe(401);
  });
});

describe('subwax: puente con la bandeja de Pre-order', () => {
  const rel = (clave: string, extra: any = {}) => ({
    clave, catno: clave, distribuidor: 'SUBWAX', artist: 'A', title: 'T', label: 'L', format: '12"', release: '', dealerPrice: 8,
    email: 'x.html', email_date: '2026-11-04', estado: 'listo', tracks: [], bytes: 0, ingested_at: '2026-11-04T09:00:00Z', ...extra,
  });
  const meta = (r: any) => ({ c: r.catno, d: r.distribuidor, e: r.estado, x: r.decision });
  beforeEach(async () => {
    await E.SYNC_STATE.delete('subwax:stock'); await E.SYNC_STATE.delete('subwax:orders');
    for (const k of ['XRD045', 'BNSD010', 'OTRO1']) await E.SYNC_STATE.delete(`listen:rel:${k}`);
    vi.restoreAllMocks();
    vi.spyOn(shopifyAdmin, 'searchVariantsBySkus').mockResolvedValue([]);
    const a = rel('XRD045', { decision: 'pendiente' }), b = rel('BNSD010', { decision: 'rechazado', rechazo: 'temporal' }), c = rel('OTRO1', { distribuidor: 'RD' });
    for (const r of [a, b, c]) await E.SYNC_STATE.put(`listen:rel:${r.clave}`, JSON.stringify(r), { metadata: meta(r) });
    await E.SYNC_STATE.put('preorder:rejected:BNSD010', JSON.stringify({ catno: 'BNSD010', tipo: 'temporal' }));
    await refreshSubwax(E, { fetcher: fetcher(), maxResolve: 0, minRows: 1 });
  });

  it('subwax-stock devuelve la decision de la bandeja solo para Subwax', async () => {
    const j: any = await (await handleSubwaxStock(E, true)).json();
    expect(j.bandeja.XRD045).toMatchObject({ decision: 'pendiente', estado: 'listo' });
    expect(j.bandeja.BNSD010.decision).toBe('rechazado');
    expect(j.bandeja.OTRO1).toBeUndefined();
  });

  it('un Pre-order Form deja sus discos como elegidos (y levanta el rechazo); un Order Form no toca la bandeja', async () => {
    const post = (body: any) => handleSubwaxOrder(new Request('https://w/?action=subwax-order', { method: 'POST', body: JSON.stringify(body) }), E, true);
    const j: any = await (await post({ op: 'add', kind: 'preorder', lines: [{ cat: 'XRD045', qty: 2 }, { cat: 'BNSD010', qty: 2 }, { cat: 'CMR010', qty: 1 }] })).json();
    expect(j.elegidos.sort()).toEqual(['BNSD010', 'XRD045']);
    const x = JSON.parse(await E.SYNC_STATE.get('listen:rel:XRD045'));
    expect(x.decision).toBe('preorder'); expect(x.decided_at).toBeTruthy();
    const b = JSON.parse(await E.SYNC_STATE.get('listen:rel:BNSD010'));
    expect(b.decision).toBe('preorder'); expect(b.rechazo).toBeUndefined();
    expect(await E.SYNC_STATE.get('preorder:rejected:BNSD010')).toBeNull();
    const o: any = await (await post({ op: 'add', kind: 'order', lines: [{ cat: 'XRD045', qty: 1 }] })).json();
    expect(o.elegidos).toEqual([]);
  });
});
