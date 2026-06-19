/**
 * radar.ts — House Only "Radar"
 * ----------------------------------------------------------------------------
 * Daily house discovery + taste-scored, ever-growing crate. Self-contained:
 * dropping this file in causes NO behaviour change until you do the wiring below.
 *
 * WHAT IT DOES (once a day, via cron):
 *   1. Reads Bandcamp Daily's house-leaning columns (Best Electronic / Club / Dance 12s),
 *      finds the latest article in each, and harvests every release on it.
 *   2. For each NEW release: fetches the album page → album id (for the player),
 *      track count (is it streamable), label, year, and format (Vinyl present? → stock, else press).
 *   3. Scores each candidate against YOUR taste (taste:profile in KV) with Claude Haiku.
 *      Keeps the ones that fit; writes them to the crate. Nothing already in the crate is removed.
 *   4. Records what it has seen so it never surfaces the same record twice.
 *
 * STORAGE (KV binding env.RADAR_KV):
 *   taste:profile        JSON  – the durable taste description (seeded below)
 *   item:{albumId}       JSON  – an enriched, scored candidate
 *   index                JSON  – array of albumIds, newest first (the crate order)
 *   vote:{albumId}       JSON  – { v:"keep"|"pass", ts }
 *   seen:{key}           "1"   – dedupe marker (key = lowercased "artist|title")
 *   run:last             JSON  – summary + timestamp of the last run
 *
 * HTTP (all Bearer-gated with env.BOOTSTRAP_AUTH_SECRET; consumed by RadarPanel):
 *   POST /radar/run      { dry?:bool, sources?:string[] }  – run the pipeline (dry = parse+score, don't write)
 *   GET  /radar/feed     ?limit&offset                     – the crate, newest first, with votes
 *   POST /radar/vote     { id, vote:"keep"|"pass"|null }   – record a vote
 *   GET  /radar/profile                                    – read taste profile
 *   POST /radar/profile  { profile }                       – replace taste profile
 *
 * ===== WIRING (the only changes that touch your existing files) =====
 *
 * wrangler.jsonc  (top-level = prod; mirror under env.staging):
 *   "triggers": { "crons": ["* /15 * * * *", "0 8 * * *"] }   // add the daily 08:00 UTC trigger
 *   "kv_namespaces": [ ...existing..., { "binding": "RADAR_KV", "id": "<prod-id>", "preview_id": "<staging-id>" } ]
 *   "vars": { ... }  // ANTHROPIC_API_KEY already a secret in prod
 *   Add secret:  npx wrangler secret put BOOTSTRAP_AUTH_SECRET            (and --env staging)
 *   Create KV:   npx wrangler kv namespace create RADAR_KV      (and "RADAR_KV" --preview)
 *
 * src/index.ts:
 *   import { handleRadar, runDailyRadar } from "./radar";
 *   // inside fetch(), before your normal routing:
 *     const radar = await handleRadar(request, env); if (radar) return radar;
 *   // inside scheduled():
 *     if (event.cron === "0 8 * * *") { ctx.waitUntil(runDailyRadar(env)); return; }
 *
 * Validate in STAGING first: POST /radar/run { "dry": true } and read the JSON it returns
 * before enabling the live cron — Bandcamp's HTML is the one fragile part, and dry mode lets
 * us confirm the parser against reality without writing anything.
 * ----------------------------------------------------------------------------
 */

export interface RadarEnv {
  RADAR_KV: KVNamespace;
  ANTHROPIC_API_KEY: string;
  BOOTSTRAP_AUTH_SECRET: string;
}

/* ---- seed of what I already know about your taste; editable via /radar/profile ---- */
const DEFAULT_PROFILE = {
  summary:
    "Curated house for houseonly.store. The throughline is WARM, CHARACTERFUL, ALBUM-GRADE house from real " +
    "auteurs: soulful & dub-laden deep house (Smallville, Slices Of Life, Skylax, Yore vein), Detroit house & " +
    "techno (KMS/Inner City, Terrence Parker, Fowlkes), hypnotic minimal (rawax, perlon-ish), dub techno " +
    "(Basic Channel lineage), and tastemaker/leftfield electronic with genuine musicality (Text, Public " +
    "Possession, jiaolong). Prizes warmth, groove, patience, soul and personality. Steers AWAY from " +
    "functional peak-time DJ-tools, generic tech-house, and anything built for the festival main stage.",
  love: [
    "soulful deep house", "dub house", "dub techno", "Detroit house/techno",
    "hypnotic minimal house", "late-night warmth", "broken beat", "album-grade auteur electronic",
    "characterful / personality-driven house"
  ],
  avoid: [
    "functional peak-time DJ-tools with no depth", "generic / commercial tech-house",
    "big-room / EDM / festival progressive", "vocal pop-house", "loud bashy bangers without soul",
    "off-genre for this store: dubstep, drum & bass, trance, hardcore, hip-hop, pop, beatless ambient"
  ],
  lovedLabels: [
    "Smallville", "Slices Of Life", "Skylax", "rawax", "Yore", "Text", "Public Possession",
    "Local Talk", "Quintessentials", "Mojuba", "Aim", "Cabinet"
  ],
  keepExamples: [
    "BETKE", "The Mole", "Cobblestone Jazz", "John Tejada", "Lawrence (Smallville)",
    "Losoul", "Frank & Tony", "Scissor & Thread"
  ],
  passExamples: [
    "Msolnusic (functional dub remixes, no real soul)", "LOVEFOXY (upfront club / vocal-led)"
  ],
  // Hard block: artists never to surface again, regardless of score or genre. Matched as a
  // case-insensitive substring of "artist + title" (covers label-hosted releases). Empty by
  // default; a pass on one release never adds anyone here - only manual, explicit vetoes.
  blockArtists: [],
  guidance:
    "Candidates come from house-tagged Bandcamp discovery plus the monthly editorial column, so they skew " +
    "house but are NOT all hand-curated — judge each on its own merits. Judge primarily on SONIC LANE, read " +
    "from the release's `tags` and `about` text plus artist/title " +
    "cues, against the axes above. CRITICAL: do NOT lower the score because the artist or label is unfamiliar, " +
    "self-released, or has no visible discography — surfacing new underground names is the entire point of this " +
    "radar, so treat unknown pedigree as neutral. Reward warm, deep, dub-tinged, soulful, minimal, Detroit, " +
    "hypnotic, album-grade house and tastemaker electronic with real musicality. Penalize only genuine off-lane: " +
    "functional/generic tech-house, big-room/EDM, peak-time tools with no depth, or clearly other genres " +
    "(dubstep, drum & bass, trance, hardcore, hip-hop, pop, beatless ambient). Match the spirit of keepExamples " +
    "(strong yes) and passExamples (clear no)."
};

// best-club-music (last update Jan 2024) and best-dance-12s (Oct 2022) are abandoned columns —
// they only surface stale releases and waste the enrich budget. best-electronic is the live,
// monthly, house-forward column. Add more LIVE sources here later if volume is needed.
const SECTIONS = ["best-electronic"];
// The discovery FIREHOSE: house-family tag pages, sorted newest-first. Each page is
// server-rendered HTML; extractAlbumUrls() harvests the album links regardless of the
// page's internal shape. Curated to Eduardo's lane (no trance/dnb/dubstep tags).
const HOUSE_TAGS = [
  "deep-house", "house", "dub-techno", "minimal-house", "detroit-house", "soulful-house",
  "broken-beat", "dub-house", "deep-techno", "lo-fi-house", "raw-house", "microhouse", "nu-disco"
];
// Permissive house-family hint: keeps a Haiku call from being spent on obvious off-lane
// tag bleed (pure jazz/rock/ambient/folk/metal). Haiku still does the fine filtering.
const HOUSE_HINT = [
  "house", "techno", "disco", "deep", "minimal", "detroit", "dub", "garage", "breakbeat",
  "broken beat", "brokenbeat", "acid", "electro", "balearic", "downtempo", "lo-fi", "leftfield",
  "electronic", "club", "dance", "afro"
];
const MAX_ENRICH = 40;     // album-page fetches per run (batched; Workers Paid subreq cap = 1000)
const MAX_SCORE  = 30;     // Haiku calls per run (cost cap); the rest wait for the next run
const ENRICH_BATCH = 6;    // concurrent album-page fetches
const SCORE_BATCH  = 5;    // concurrent Haiku scoring calls
const KEEP_THRESHOLD = 62; // model says keep AND score >= this -> in
const CORE_FLOOR = 50;     // OR: it carries a core-genre tag AND score >= this -> in
// Eduardo's rule: anything whose PRIMARY genre is one he collects should surface, even if the
// model is cautious about it. These are matched as EXACT lowercased tags (so "tech house" does
// NOT match bare "house"). The CORE_FLOOR keeps explicit passes (e.g. Msolnusic ~38) out.
const CORE_GENRE = [
  "deep house", "deephouse", "dub house", "dubhouse", "dub techno", "dubtechno",
  "detroit house", "detroit techno", "minimal house", "soulful house",
  "broken beat", "brokenbeat", "house"
];
function isKeeper(c: any): boolean {
  if (c.keep && c.score >= KEEP_THRESHOLD) return true;
  const tags: string[] = Array.isArray(c.tags) ? c.tags : [];
  const isCore = tags.some((t) => CORE_GENRE.includes(t));
  return isCore && c.score >= CORE_FLOOR;
}
function isBlocked(meta: any, profile: any): boolean {
  const list: string[] = (profile && Array.isArray(profile.blockArtists)) ? profile.blockArtists : [];
  if (!list.length) return false;
  const hay = ((meta.artist || "") + " " + (meta.title || "")).toLowerCase();
  return list.some((name) => {
    const n = String(name || "").trim().toLowerCase();
    return n.length >= 2 && hay.includes(n);
  });
}

/* ============================== HTTP router ============================== */

export async function handleRadar(request: Request, env: RadarEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/radar/")) return null;

  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  if (!authed(request, env)) return cors(json({ error: "unauthorized" }, 401));

  try {
    if (url.pathname === "/radar/run" && request.method === "POST") {
      const body = await safeJson(request);
      const summary = await runDailyRadar(env, { dry: !!body.dry, sources: body.sources, probe: !!body.probe });
      return cors(json(summary));
    }
    if (url.pathname === "/radar/feed" && request.method === "GET") {
      const limit = clamp(parseInt(url.searchParams.get("limit") || "30", 10), 1, 100);
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
      return cors(json(await getFeed(env, limit, offset)));
    }
    if (url.pathname === "/radar/vote" && request.method === "POST") {
      const { id, vote } = await safeJson(request);
      if (!id) return cors(json({ error: "id required" }, 400));
      if (vote === null) await env.RADAR_KV.delete("vote:" + id);
      else await env.RADAR_KV.put("vote:" + id, JSON.stringify({ v: vote, ts: Date.now() }));
      return cors(json({ ok: true }));
    }
    if (url.pathname === "/radar/profile" && request.method === "GET") {
      return cors(json(await getProfile(env)));
    }
    if (url.pathname === "/radar/profile" && request.method === "POST") {
      const { profile } = await safeJson(request);
      await env.RADAR_KV.put("taste:profile", JSON.stringify(profile));
      return cors(json({ ok: true }));
    }
    return cors(json({ error: "not found" }, 404));
  } catch (e: any) {
    return cors(json({ error: String(e && e.message || e) }, 500));
  }
}

/* ============================== the daily run ============================== */

export async function runDailyRadar(
  env: RadarEnv,
  opts: { dry?: boolean; sources?: string[]; probe?: boolean } = {}
): Promise<any> {
  const profile = await getProfile(env);
  const debug: any[] = [];

  // 1) gather album URLs: the discovery FIREHOSE (house-family tag pages, newest first)
  //    unioned with the monthly editorial column. A manual run with `sources` stays scoped
  //    to those article URLs only (no firehose).
  const albumUrls = new Set<string>();
  let articles: string[] = [];
  if (opts.sources && opts.sources.length) {
    articles = opts.sources;
  } else {
    for (const s of SECTIONS) {
      const { status, html } = await fetchHtml("https://daily.bandcamp.com/" + s);
      const latest = firstArticleUrl(html, s);
      debug.push({ stage: "section", section: s, status, htmlLen: html.length, latest });
      if (latest) articles.push(latest);
    }
  }
  for (const a of articles) {
    const { status, html } = await fetchHtml(a);
    const urls = extractAlbumUrls(html);
    debug.push({ stage: "article", article: a, status, htmlLen: html.length, albums: urls.length });
    urls.forEach((u) => albumUrls.add(u));
  }
  if (!(opts.sources && opts.sources.length)) {
    const tagUrls = await harvestDiscover(debug);
    tagUrls.forEach((u) => albumUrls.add(u));
  }

  // 2) pull the shop catalogue once, to skip what's already stocked
  const catalog = await fetchCatalog(debug);
  const scanned = albumUrls.size;

  // probe: source + catalogue only (no enrich, no scoring) — fast sanity check that the
  // firehose returns albums and the catalogue loaded, without spending Haiku or timing out.
  if (opts.probe) {
    return {
      probe: true, articles, scanned,
      catalog: { releases: catalog.releases.size, artists: catalog.artists.size },
      sampleUrls: [...albumUrls].slice(0, 25),
      debug
    };
  }

  // 3) enrich + score the NEW ones, BATCHED so a full run fits the request window.
  //    Phase A: fetch album pages concurrently; dedupe vs the catalogue, vs prior runs, and
  //    vs off-lane tag bleed (no Haiku spent). Phase B: score the survivors concurrently.
  //    Everything processed is marked `seen`, so the firehose drains fresh releases over time
  //    instead of re-scoring the same ones every day.
  const urls = [...albumUrls];
  const remember = async (dk: string) => { if (!opts.dry) await env.RADAR_KV.put("seen:" + dk, "1"); };
  let enriched = 0, ownedSkipped = 0, offGenre = 0;
  const toScore: any[] = [];
  for (let i = 0; i < urls.length && enriched < MAX_ENRICH; i += ENRICH_BATCH) {
    const metas = await Promise.all(
      urls.slice(i, i + ENRICH_BATCH).map((u) => enrichAlbum(u).catch(() => null))
    );
    for (const meta of metas) {
      if (enriched >= MAX_ENRICH) break;
      if (!meta || !meta.id || !meta.tracks) continue;        // vinyl-only / unstreamable / unparsed
      if (isBlocked(meta, profile)) continue;                 // hard artist veto
      const dk = dedupeKey(meta.artist, meta.title);
      if (!opts.dry && (await env.RADAR_KV.get("seen:" + dk))) continue;   // processed in a prior run
      enriched++;
      meta._dk = dk;
      if (catalog.releases.has(relKey(meta.artist, meta.title))) { ownedSkipped++; await remember(dk); continue; } // already stocked
      if (!tagsLookHouse(meta.tags)) { offGenre++; await remember(dk); continue; }                                  // off-lane tag bleed
      meta.artistInStore = catalog.artists.has(normArtist(meta.artist));   // positive prior, not a gate
      toScore.push(meta);
    }
  }

  const candidates: any[] = [];
  let scored = 0;
  const pool = toScore.slice(0, MAX_SCORE);   // the rest wait for the next run
  for (let i = 0; i < pool.length; i += SCORE_BATCH) {
    const slice = pool.slice(i, i + SCORE_BATCH);
    const results = await Promise.all(slice.map((m) => scoreWithClaude(env, m, profile).catch(() => null)));
    for (let j = 0; j < slice.length; j++) {
      const m = slice[j], sc = results[j];
      if (!sc) continue;                                      // transient model fail: leave unseen, retry next run
      scored++;
      await remember(m._dk);
      candidates.push({ ...m, ...sc, addedAt: Date.now() });
    }
  }

  // 4) keep the fits; write (unless dry)
  const kept = candidates.filter(isKeeper).sort((a, b) => b.score - a.score);
  if (!opts.dry) {
    const index: string[] = (await readJson(env, "index")) || [];
    for (const it of kept) {
      await env.RADAR_KV.put("item:" + it.id, JSON.stringify(it));
      await env.RADAR_KV.put("seen:" + dedupeKey(it.artist, it.title), "1");
      if (!index.includes(it.id)) index.unshift(it.id);   // newest first, never removed
    }
    await env.RADAR_KV.put("index", JSON.stringify(index));
    await env.RADAR_KV.put("run:last", JSON.stringify({
      ts: Date.now(), articles: articles.length, scanned, enriched, kept: kept.length
    }));
  }

  return {
    dry: !!opts.dry, articles, scanned, enriched, scored, ownedSkipped, offGenre, keptCount: kept.length,
    kept: kept.map(slim),
    // in dry mode also show what was scored but rejected, to tune the threshold/prompt:
    rejected: opts.dry ? candidates.filter((c) => !isKeeper(c)).map(slim) : undefined,
    debug: opts.dry ? debug : undefined
  };
}

/* ============================== Bandcamp parsing ============================== */

function firstArticleUrl(html: string, section: string): string | null {
  // Bandcamp's same-domain nav links are RELATIVE (/section/slug); match the path,
  // tolerate JSON-escaped slashes, and rebuild an absolute URL. First match = newest.
  const h = html.replace(/\\\//g, "/");
  const re = new RegExp("/" + section + "/([a-z0-9][a-z0-9-]{6,})", "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(h))) {
    const slug = m[1];
    if (slug === "all-nav") continue;
    return "https://daily.bandcamp.com/" + section + "/" + slug;
  }
  return null;
}
async function latestArticle(section: string): Promise<string | null> {
  const { html } = await fetchHtml("https://daily.bandcamp.com/" + section);
  return firstArticleUrl(html, section);
}

function extractAlbumUrls(html: string): string[] {
  const out = new Set<string>();
  html = decodeEntities(html);
  const re = /https?:\/\/[a-z0-9-]+\.bandcamp\.com\/album\/[a-z0-9-]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.add(m[0]);
  return [...out];
}

async function enrichAlbum(albumUrl: string): Promise<any | null> {
  const html = await fetchText(albumUrl);
  const id = pick(html, /"item_id":(\d+)/) || pick(html, /EmbeddedPlayer\/(?:v=2\/)?album=(\d+)/);
  if (!id) return null;
  const ogTitle = pick(html, /<meta property="og:title" content="([^"]+)"/i) || "";
  let artist = "", title = ogTitle;
  const byIdx = ogTitle.lastIndexOf(", by ");
  if (byIdx > -1) { title = ogTitle.slice(0, byIdx).trim(); artist = ogTitle.slice(byIdx + 5).trim(); }
  const trackStr = pick(html, /<meta property="og:description" content="(\d+) track/i);
  const tracks = trackStr ? parseInt(trackStr, 10) : 0;
  const label = pick(html, /<meta property="og:site_name" content="([^"]+)"/i) || artist;
  const year = pick(html, /released[^,<]*,?\s*(\d{4})/i) || pick(html, /"release_date":"[^"]*?(\d{4})/);
  // format: is a vinyl package present on the page?
  const vinyl = /"type_name"\s*:\s*"[^"]*vinyl/i.test(html)
             || /"musicReleaseFormat"\s*:\s*"VinylFormat"/i.test(html)
             || /Record\/Vinyl/i.test(html)
             || /merchType[^}]*[Vv]inyl/i.test(html);
  const ld = ldJson(html);
  const tags = extractTags(ld);
  const about = extractAbout(ld);
  return {
    id: String(id), artist: clean(artist), title: clean(title), label: clean(label),
    year: year ? parseInt(year, 10) : null, tracks, route: vinyl ? "stock" : "press",
    tags, about, url: albumUrl
  };
}

// Bandcamp embeds a JSON-LD MusicAlbum block server-side; the genre tags live in its
// `keywords` array and the real write-up is the album-level `description` (the per-release
// descriptions are boilerplate). Client-side /tag/ links and any "about" key are NOT present.
function ldJson(html: string): string {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  return m ? m[1] : "";
}

function unescapeJson(s: string): string {
  return s
    .replace(/\\r\\n|\\n|\\r/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\\u[0-9a-fA-F]{4}/g, (x) => { try { return String.fromCharCode(parseInt(x.slice(2), 16)); } catch { return " "; } })
    .replace(/\\(.)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTags(ld: string): string[] {
  const m = ld.match(/"keywords"\s*:\s*\[([^\]]*)\]/);
  if (!m) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let g: RegExpExecArray | null;
  while ((g = re.exec(m[1])) && out.length < 14) {
    const t = g[1].replace(/\\(.)/g, "$1").trim().toLowerCase();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

function extractAbout(ld: string): string {
  const re = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const isBoiler = (x: string) =>
    /unlimited streaming via the free Bandcamp app|high-quality download in (MP3|FLAC)|^Pre-order|^Includes |shipping (approx|early|late|mid|end)/i.test(x);
  const cands: string[] = [];
  let g: RegExpExecArray | null;
  while ((g = re.exec(ld))) cands.push(unescapeJson(g[1]));
  const pool = cands.filter((c) => c.length > 40 && !isBoiler(c));
  let best = "";
  for (const c of (pool.length ? pool : cands)) if (c.length > best.length) best = c;
  return best.slice(0, 700);
}

/* ============================== discovery firehose + shop dedupe ============================== */

// House-family discovery via Bandcamp's discover backend — the JSON XHR the new React
// "discover" SPA calls. The old tag pages (bandcamp.com/tag/<x>) are now a client-rendered
// SPA whose HTML carries ZERO /album/ links, so there is nothing to scrape; instead we POST
// to /api/discover/1/discover_web with the tag + slice:"new" and read results[].item_url
// (already absolute, newest-first), paginating via the opaque cursor. The HOUSE_TAGS slugs
// double as the API's tag_norm_names (verified live against the endpoint).
const DISCOVER_API = "https://bandcamp.com/api/discover/1/discover_web";
const DISCOVER_PAGES = 3;           // pages per tag (DISCOVER_PAGE_SIZE each) → ~60 newest/tag
const DISCOVER_PAGE_SIZE = 20;
const ALBUM_URL_RE = /^https?:\/\/[a-z0-9-]+\.bandcamp\.com\/album\/[a-z0-9-]+/i;

// One page of the discover backend for a tag. Returns absolute album URLs (query stripped),
// the total result count for the tag, and the cursor for the next page (null when exhausted).
async function discoverPage(
  tag: string,
  cursor: string
): Promise<{ status: number; urls: string[]; total: number; cursor: string | null }> {
  try {
    const r = await fetch(DISCOVER_API, {
      method: "POST",
      headers: { ...BROWSER_HEADERS, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        tag_norm_names: [tag],
        geoname_id: 0,
        slice: "new",
        cursor,
        size: DISCOVER_PAGE_SIZE,
        include_result_types: ["a"],
      }),
    });
    if (!r.ok) return { status: r.status, urls: [], total: 0, cursor: null };
    const d: any = await r.json();
    const urls = (Array.isArray(d?.results) ? d.results : [])
      .map((x: any) => (typeof x?.item_url === "string" ? x.item_url.split("?")[0] : null))
      .filter((u: string | null): u is string => !!u && ALBUM_URL_RE.test(u));
    return { status: r.status, urls, total: Number(d?.result_count) || 0, cursor: d?.cursor || null };
  } catch {
    return { status: 0, urls: [], total: 0, cursor: null };
  }
}

// Harvest the firehose: a few newest-first pages per house-family tag, deduped to absolute
// album URLs. Keeps one per-source `debug` entry per tag (status + total + albums) so probes
// stay legible. The MAX_ENRICH cap + daily cron + seen: dedup turn this stream into a steadily
// growing crate — the firehose volume comes from the source breadth, not one giant run.
async function harvestDiscover(debug: any[]): Promise<string[]> {
  const out = new Set<string>();
  const lists = await Promise.all(HOUSE_TAGS.map(async (tag) => {
    const tagUrls = new Set<string>();
    let cursor: string | null = "*", status = 0, total = 0, pages = 0;
    for (let p = 0; p < DISCOVER_PAGES && cursor; p++) {
      const res = await discoverPage(tag, cursor);
      status = res.status;
      total = res.total || total;
      res.urls.forEach((u) => tagUrls.add(u));
      cursor = res.cursor;
      pages++;
      if (!res.urls.length) break;        // exhausted or error — stop paging this tag
    }
    debug.push({ stage: "discover", tag, status, total, pages, albums: tagUrls.size });
    return [...tagUrls];
  }));
  lists.forEach((urls) => urls.forEach((u) => out.add(u)));
  return [...out];
}

// The shop catalogue, via the public Storefront API (same token as the site). Builds a set of
// release keys (artist|title-core) and a set of artist keys. Note: Storefront returns only
// PUBLISHED products, so sold-out/draft titles aren't deduped (acceptable for now).
const SHOP_DOMAIN = "house-only-2.myshopify.com";
const SHOP_TOKEN  = "3edf470af24f9bd4b81bca274121eec4";
const SHOP_API    = "2024-01";
const CATALOG_PAGES = 30;
async function fetchCatalog(debug: any[]): Promise<{ releases: Set<string>; artists: Set<string> }> {
  const releases = new Set<string>();
  const artists = new Set<string>();
  let cursor: string | null = null, pages = 0;
  try {
    while (pages < CATALOG_PAGES) {
      const q = "query($c:String){products(first:250,after:$c){pageInfo{hasNextPage endCursor} edges{node{title vendor}}}}";
      const r = await fetch("https://" + SHOP_DOMAIN + "/api/" + SHOP_API + "/graphql.json", {
        method: "POST",
        headers: { "content-type": "application/json", "x-shopify-storefront-access-token": SHOP_TOKEN },
        body: JSON.stringify({ query: q, variables: { c: cursor } })
      });
      if (!r.ok) { debug.push({ stage: "catalog", page: pages, status: r.status }); break; }
      const d: any = await r.json();
      const conn = d && d.data && d.data.products;
      if (!conn) break;
      for (const e of (conn.edges || [])) {
        const n = (e && e.node) || {};
        if (n.vendor) artists.add(normArtist(n.vendor));
        if (n.vendor && n.title) releases.add(relKey(n.vendor, n.title));
      }
      pages++;
      if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  } catch (e: any) { debug.push({ stage: "catalog", error: String(e && e.message || e) }); }
  debug.push({ stage: "catalog-done", pages, releases: releases.size, artists: artists.size });
  return { releases, artists };
}

// Normalisation shared by the catalogue and the Bandcamp side so keys line up.
function normWord(s: string): string { return (s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); }
function normArtist(a: string): string {
  const s = normWord(a).split(/\b(?:feat|ft|featuring|with|vs|presents|pres)\b| & |, | x /)[0];
  return s.replace(/[^a-z0-9]+/g, "");
}
function normTitleCore(t: string): string {
  let s = normWord(t).replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  s = s.replace(/\b(ep|lp|single|album|12inch|7inch)\b/g, " ").replace(/12"|7"/g, " ");
  return s.replace(/[^a-z0-9]+/g, "");
}
function relKey(a: string, t: string): string { return normArtist(a) + "|" + normTitleCore(t); }
function tagsLookHouse(tags: any): boolean {
  if (!Array.isArray(tags) || !tags.length) return true;   // untagged -> let Haiku decide
  return tags.some((t: string) => HOUSE_HINT.some((h) => t === h || t.indexOf(h) !== -1));
}

/* ============================== Claude taste scoring ============================== */

async function scoreWithClaude(env: RadarEnv, meta: any, profile: any): Promise<any | null> {
  const sys =
    "You are the A&R filter for an underground house-music vinyl store (houseonly.store). Score how well ONE " +
    "release fits the owner's taste, which is fully described in the OWNER TASTE profile. Follow that profile's " +
    "`guidance` exactly — especially: judge on SONIC LANE from the release's tags/about, and do NOT penalize " +
    "unknown or self-released artists. Respond ONLY with minified JSON, no prose, no markdown: " +
    '{"score":0-100,"keep":true|false,"axis":"short genre/lane tag","reason":"one concrete sentence"}. ' +
    "Ground `reason` in the release's tags/about and sonic lane, NOT in label pedigree or how famous it is. " +
    "Calibrate to the profile's keepExamples (strong yes, 75-95) and passExamples (clear no, under 45). " +
    "Set keep=true only when it sits in the owner's house lane. If `artistInStore` is true the store already " +
    "stocks this artist (a positive signal they fit) — lean toward keep when the lane matches.";
  const user =
    "OWNER TASTE\n" + JSON.stringify(profile) + "\n\nRELEASE\n" +
    JSON.stringify({
      artist: meta.artist, title: meta.title, label: meta.label, year: meta.year,
      tags: meta.tags || [], about: meta.about || "", artistInStore: !!meta.artistInStore
    });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: sys,
      messages: [{ role: "user", content: user }]
    })
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const parsed = parseJson(text);
  if (!parsed || typeof parsed.score !== "number") return null;
  return { score: parsed.score, keep: !!parsed.keep, axis: parsed.axis || "", reason: parsed.reason || "" };
}

/* ============================== KV helpers ============================== */

async function getProfile(env: RadarEnv): Promise<any> {
  return (await readJson(env, "taste:profile")) || DEFAULT_PROFILE;
}
async function getFeed(env: RadarEnv, limit: number, offset: number): Promise<any> {
  const index: string[] = (await readJson(env, "index")) || [];
  const slice = index.slice(offset, offset + limit);
  const items = [];
  for (const id of slice) {
    const it = await readJson(env, "item:" + id);
    if (!it) continue;
    const v = await readJson(env, "vote:" + id);
    items.push({ ...it, vote: v ? v.v : null });
  }
  return { total: index.length, offset, limit, items };
}
async function readJson(env: RadarEnv, key: string): Promise<any> {
  const raw = await env.RADAR_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/* ============================== small utils ============================== */

function authed(req: Request, env: RadarEnv): boolean {
  const h = req.headers.get("authorization") || "";
  return h === "Bearer " + env.BOOTSTRAP_AUTH_SECRET && !!env.BOOTSTRAP_AUTH_SECRET;
}
function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("access-control-allow-headers", "authorization,content-type");
  return new Response(res.body, { status: res.status, headers: h });
}
function json(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
async function safeJson(req: Request): Promise<any> { try { return await req.json(); } catch { return {}; } }
const BROWSER_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};
async function fetchHtml(url: string): Promise<{ status: number; html: string }> {
  try {
    const r = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
    const html = await r.text();
    return { status: r.status, html };
  } catch {
    return { status: 0, html: "" };
  }
}
async function fetchText(url: string): Promise<string> {
  return (await fetchHtml(url)).html;
}
function pick(s: string, re: RegExp): string | null { const m = s.match(re); return m ? m[1] : null; }
function parseJson(t: string): any { try { return JSON.parse(t.replace(/```json|```/g, "").trim()); } catch { return null; } }
function clean(s: string): string { return (s || "").replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').trim(); }
// Bandcamp's React pages embed their data as a JSON data-blob in an HTML attribute, so URLs
// arrive entity-encoded (https:&#x2F;&#x2F;artist.bandcamp.com&#x2F;album&#x2F;…). Decode the
// slash/quote/amp entities (and JSON-escaped slashes) so the album-URL regex can match them.
function decodeEntities(s: string): string {
  return (s || "")
    .replace(/\\\//g, "/")
    .replace(/&#x2[fF];/g, "/").replace(/&#47;/g, "/")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
function dedupeKey(a: string, t: string): string { return (a + "|" + t).toLowerCase().replace(/[^a-z0-9|]+/g, ""); }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, isNaN(n) ? lo : n)); }
function slim(c: any) {
  return { id: c.id, artist: c.artist, title: c.title, label: c.label, year: c.year,
           tracks: c.tracks, route: c.route, tags: c.tags, score: c.score, axis: c.axis,
           reason: c.reason, url: c.url };
}
