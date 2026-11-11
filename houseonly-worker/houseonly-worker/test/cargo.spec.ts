import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseBandcampSearch, parseTralbum, resuelveCargo, mismoDisco, siguientes, validaFilas,
  handleCargoUpload, handleCargoAudio, handleCargoStock, pasadaCargo, type CargoRow,
} from "../src/lib/cargo";

const E = env as any;
const PUB = "https://pub.example";
const row = (ean: string, e = 1, artist = "Kuedo", title = "Severant"): CargoRow =>
  ["PLANET308", artist, title, ean, "VL", 1, 3, 12.5, 20261101, 32, e];

const SEARCH_HTML = `<ul><li class="searchresult data-search" data-search="{}">
<div class="result-info"><div class="itemtype">ALBUM</div>
<div class="heading"><a href="https://kuedo.bandcamp.com/album/severant?from=search&amp;search_item_id=1">Severant</a></div>
<div class="subhead">by Kuedo</div></div></li>
<li class="searchresult data-search"><div class="heading"><a href="https://x.bandcamp.com/track/foo?from=search">Foo</a></div><div class="subhead">from Bar by Baz</div></li></ul>`;
const tralbum = { artist: "Kuedo", current: { title: "Severant" }, trackinfo: [
  { title: "Ascension Theme", file: { "mp3-128": "https://t4.bcbits.com/stream/aaa/mp3-128/1?p=0&ts=1" } },
  { title: "Truth Flood", file: { "mp3-128": "https://t4.bcbits.com/stream/bbb/mp3-128/2?p=0&ts=1" } },
  { title: "Unreleased", file: null },
] };
const ALBUM_HTML = `<html><link rel="image_src" href="https://f4.bcbits.com/img/a1_16.jpg"><script data-tralbum="${JSON.stringify(tralbum).replace(/"/g, "&quot;")}"></script></html>`;

const J = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
const MP3 = () => new Response(new Uint8Array(2048), { status: 206, headers: { "content-type": "audio/mpeg" } });

function router(over: Record<string, (u: URL, init?: RequestInit) => Response | Promise<Response>> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: any, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    calls.push({ url: u.toString(), init });
    for (const [k, h] of Object.entries(over)) if (u.toString().includes(k)) return h(u, init);
    if (u.hostname === "api.discogs.com" && u.pathname === "/database/search") {
      return J({ results: u.searchParams.get("barcode") ? [{ id: 77, title: "Kuedo - Severant", format: ["Vinyl"] }] : [] });
    }
    if (u.hostname === "api.discogs.com" && u.pathname === "/releases/77") {
      return J({ id: 77, title: "Severant", year: 2011, artists: [{ name: "Kuedo" }], labels: [{ name: "Planet Mu (2)" }],
        genres: ["Electronic"], styles: ["Footwork", "Synth-pop"], images: [{ uri: "https://i.discogs.com/a.jpg" }],
        videos: [{ title: "Kuedo - Truth Flood", uri: "https://www.youtube.com/watch?v=abcdefghijk" }] });
    }
    if (u.hostname === "api.deezer.com") return J(u.pathname.startsWith("/album/upc:") ? { error: { code: 800 } } : { data: [] });
    if (u.hostname === "itunes.apple.com") return J({ resultCount: 0, results: [] });
    if (u.hostname === "bandcamp.com") return new Response(SEARCH_HTML, { headers: { "content-type": "text/html" } });
    if (u.hostname === "kuedo.bandcamp.com") return new Response(ALBUM_HTML, { headers: { "content-type": "text/html" } });
    if (u.hostname.endsWith("bcbits.com")) return MP3();
    return new Response("not mocked " + u, { status: 599 });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(fn as any);
  return calls;
}

describe("cargo: parsers", () => {
  it("bandcamp search: solo albumes, sin query", () => {
    expect(parseBandcampSearch(SEARCH_HTML)).toEqual([{ url: "https://kuedo.bandcamp.com/album/severant", title: "Severant", artist: "Kuedo" }]);
  });
  it("tralbum: pistas con stream mp3-128 y portada", () => {
    const t = parseTralbum(ALBUM_HTML)!;
    expect(t.tracks.map((x) => x.name)).toEqual(["Ascension Theme", "Truth Flood"]);
    expect(t.cover).toBe("https://f4.bcbits.com/img/a1_16.jpg");
  });
  it("mismoDisco tolera LP/remaster y exige artista salvo VA", () => {
    expect(mismoDisco("Burial", "Antidawn EP", "Burial", "Antidawn")).toBe(true);
    expect(mismoDisco("Burial", "Antidawn", "Kode9", "Antidawn")).toBe(false);
    expect(mismoDisco("Various Artists", "Hyperdub 15", "Various", "Hyperdub 15")).toBe(true);
  });
  it("validaFilas descarta EAN raros y duplicados", () => {
    const r = validaFilas([row("5055869500001"), row("5055869500001"), ["X", "a", "b", "abc", "VL", 1, 1, 0, 0, 32, 0], "basura"]);
    expect(r).toHaveLength(1);
  });
});

describe("cargo: resolver", () => {
  beforeEach(() => { E.DISCOGS_TOKEN = "tok"; });
  afterEach(() => vi.restoreAllMocks());

  it("Discogs da sello/generos y Bandcamp el audio; guarda un tramo en R2", async () => {
    const calls = router();
    const a = await resuelveCargo(E, row("5055869500002"), PUB);
    expect(a.label).toBe("Planet Mu");
    expect(a.genres).toEqual(["Electronic"]);
    expect(a.src).toBe("bandcamp");
    expect(a.tried).toMatchObject({ discogs: "ok", deezer: "sin coincidencia", apple: "sin coincidencia", bandcamp: "ok" });
    expect(a.tracks).toEqual([
      { name: "Ascension Theme", url: `${PUB}/cargo/5055869500002/bandcamp-1.mp3` },
      { name: "Truth Flood", url: `${PUB}/cargo/5055869500002/bandcamp-2.mp3` },
    ]);
    const bc = calls.find((c) => c.url.includes("bcbits.com/stream"))!;
    expect((bc.init!.headers as any).Range).toMatch(/^bytes=\d+-\d+$/);
    const obj = await E.R2.get("cargo/5055869500002/bandcamp-1.mp3");
    expect(obj?.httpMetadata?.contentType).toBe("audio/mpeg");
    await obj?.arrayBuffer();
  });

  it("Bandcamp con challenge -> YouTube de Discogs", async () => {
    router({ "bandcamp.com/search": () => new Response("<title>Client Challenge</title>", { status: 200 }) });
    const a = await resuelveCargo(E, row("5055869500003"), PUB);
    expect(a.tried.bandcamp).toBe("challenge");
    expect(a.state).toBe("ok");
    expect(a.src).toBe("youtube");
    expect(a.yt).toEqual([{ name: "Kuedo - Truth Flood", yt: "abcdefghijk" }]);
  });

  it("Deezer por UPC gana y los previews se copian enteros", async () => {
    const calls = router({
      "api.deezer.com/album/upc:": () => J({ id: 9, title: "Severant", artist: { name: "Kuedo" }, link: "https://deezer.com/album/9",
        tracks: { data: [{ title: "Ascension Theme", preview: "https://cdnt-preview.dzcdn.net/a.mp3?hdnea=exp=1" }] } }),
      "dzcdn.net": () => new Response(new Uint8Array(1000), { headers: { "content-type": "audio/mpeg" } }),
    });
    const a = await resuelveCargo(E, row("5055869500004"), PUB);
    expect(a.src).toBe("deezer");
    expect(a.tracks[0].url).toBe(`${PUB}/cargo/5055869500004/deezer-1.mp3`);
    expect((calls.find((c) => c.url.includes("dzcdn"))!.init!.headers as any).Range).toBeUndefined();
    expect(calls.some((c) => c.url.includes("bandcamp"))).toBe(false);
  });

  it("solo metadatos cuando no se pide audio", async () => {
    const calls = router();
    const a = await resuelveCargo(E, row("5055869500005", 0), PUB, { audio: false });
    expect(a.state).toBe("meta");
    expect(a.label).toBe("Planet Mu");
    expect(calls.some((c) => c.url.includes("deezer"))).toBe(false);
  });
});

describe("cargo: cola y handlers", () => {
  beforeEach(async () => {
    E.DISCOGS_TOKEN = "tok";
    for (const k of ["cargo:stock", "cargo:idx", "cargo:last"]) await E.SYNC_STATE.delete(k);
  });
  afterEach(() => vi.restoreAllMocks());

  it("siguientes: electronicos con audio primero, luego metadatos; m de Discogs Electronic vuelve a por audio", () => {
    const rows = [row("1000000000001", 0), row("1000000000002", 1), row("1000000000003", 0)];
    expect(siguientes(rows, {}, 5).map((x) => [x.row[3], x.audio])).toEqual([["1000000000002", true], ["1000000000001", false], ["1000000000003", false]]);
    expect(siguientes(rows, { "1000000000001": ["Hyperdub", "Electronic", "m", 1] }, 1)[0]).toMatchObject({ audio: true });
  });

  it("upload exige Bearer y un minimo de filas; audio resuelve en el acto y queda en el indice", async () => {
    const mk = (body: unknown) => new Request("https://w/?action=cargo-upload", { method: "POST", body: JSON.stringify(body) });
    expect((await handleCargoUpload(mk({}), E, false)).status).toBe(401);
    expect((await handleCargoUpload(mk({ rows: [row("5055869500010")] }), E, true)).status).toBe(400);
    const rows = Array.from({ length: 25 }, (_, i) => row(String(5055869600000 + i)));
    const up = await (await handleCargoUpload(mk({ file: "x.xlsx", rows }), E, true)).json() as any;
    expect(up).toMatchObject({ ok: true, filas: 25, electronicos: 25 });

    router({ "bandcamp.com/search": () => new Response("Client Challenge") });
    const res = await handleCargoAudio(new Request(`https://w/?action=cargo-audio&ean=${rows[0][3]}`), E, true, PUB);
    expect(((await res.json()) as any).src).toBe("youtube");
    const st = await (await handleCargoStock(E, true)).json() as any;
    expect(st.idx[rows[0][3]]).toEqual(["Planet Mu", "Electronic, Footwork, Synth-pop", "y", 1]);
    expect(st.stock.rows).toHaveLength(25);
  });

  it("pasada: hace n y deja resumen con pendientes", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(String(5055869700000 + i)));
    await handleCargoUpload(new Request("https://w/", { method: "POST", body: JSON.stringify({ rows }) }), E, true);
    router();
    const r = await pasadaCargo(E, PUB, 3);
    expect(r).toMatchObject({ hechos: 3, pendientes: 22, resultado: { bandcamp: 3 } });
    expect(JSON.parse((await E.SYNC_STATE.get("cargo:last"))!).pendientes).toBe(22);
  });
});
