// Discogs inventory snapshot: the eBay pass prices from here instead of one
// getListing per record. Discogs counts its 60/min per source IP, and on the
// shared Cloudflare egress that budget is usually spent by others: per-record
// reads held almost every eBay record on a 429 (2026-10-27).
//
// - Seed: the Discogs inventory export CSV (admin upload, or loaded by hand).
// - Refresh: the eBay cron reads the inventory API, 100 a page (~10 calls for
//   ~1,000 listings), sorted by listing date ascending so new listings land on
//   the last page. No 429 retries: the first 429 saves the progress and the
//   next run resumes from that page. A complete read replaces the snapshot.
// - Freshness: the pass uses it while it is under 48 h old; past that, records
//   wait (hold `discogs_snapshot_caducado`) and the admin warns.
//
// The snapshot's time is when the read STARTED (or the export's own time):
// a page read later can only be fresher than that.

import { getInventory, type DiscogsListing } from './discogs';

export const SNAPSHOT_KEY = 'discogs:snapshot';
export const SNAPSHOT_BUILD_KEY = 'discogs:snapshot:building';
export const SNAPSHOT_LAST_REFRESH_KEY = 'meta:discogs_snapshot_last_refresh';
export const SNAPSHOT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
// A complete snapshot younger than this is left alone: the quota is shared with
// order sync, which matters more than a price a few minutes fresher.
export const SNAPSHOT_REFRESH_EVERY_MS = 60 * 60 * 1000;
// A half-built read older than this starts over: its early pages are too old.
const BUILD_RESTART_MS = 12 * 60 * 60 * 1000;
const PAGES_PER_RUN = 15;

/** One listing, as the eBay pass needs it. Status and grades in the API's own strings. */
export interface SnapshotListing {
  status: string;              // 'For Sale' | 'Draft' | 'Sold' | …
  price: number;
  currency: string;
  condition?: string;          // 'Mint (M)', 'Near Mint (NM or M-)', …
  sleeve_condition?: string;
}

export interface DiscogsSnapshot {
  taken_at: string;
  source: 'csv' | 'api';
  count: number;
  listings: Record<string, SnapshotListing>;
}

interface SnapshotBuild {
  started_at: string;
  next_page: number;
  pages: number | null;
  listings: Record<string, SnapshotListing>;
}

interface KvEnv { SYNC_STATE: KVNamespace; DISCOGS_TOKEN?: string }

export async function loadSnapshot(env: KvEnv): Promise<DiscogsSnapshot | null> {
  const raw = await env.SYNC_STATE.get(SNAPSHOT_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as DiscogsSnapshot; } catch { return null; }
}

export const snapshotAgeMs = (s: DiscogsSnapshot | null, now = Date.now()) =>
  s ? now - Date.parse(s.taken_at) : Infinity;
export const snapshotFresh = (s: DiscogsSnapshot | null, now = Date.now()) =>
  snapshotAgeMs(s, now) < SNAPSHOT_MAX_AGE_MS;

export async function saveSnapshot(env: KvEnv, listings: Record<string, SnapshotListing>, takenAt: string, source: DiscogsSnapshot['source']): Promise<DiscogsSnapshot> {
  const snap: DiscogsSnapshot = { taken_at: takenAt, source, count: Object.keys(listings).length, listings };
  await env.SYNC_STATE.put(SNAPSHOT_KEY, JSON.stringify(snap));
  return snap;
}

// ── CSV (Discogs inventory export) ─────────────────────────────────

// The export writes enum names; the API (and eBay's grading) uses these.
const CSV_STATUS: Record<string, string> = { FOR_SALE: 'For Sale', DRAFT: 'Draft', SOLD: 'Sold', EXPIRED: 'Expired', DELETED: 'Deleted' };
const CSV_GRADE: Record<string, string> = {
  MINT: 'Mint (M)', NEAR_MINT: 'Near Mint (NM or M-)', VERY_GOOD_PLUS: 'Very Good Plus (VG+)', VERY_GOOD: 'Very Good (VG)',
  GOOD_PLUS: 'Good Plus (G+)', GOOD: 'Good (G)', FAIR: 'Fair (F)', POOR: 'Poor (P)',
  GENERIC: 'Generic', NOT_GRADED: 'Not Graded', NO_COVER: 'No Cover',
};

/** RFC 4180: quoted fields may hold commas, quotes ("") and newlines (the comments column does). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Export file name: 147628-2026-10-27T16_23_00.255419-EXPORT.csv (UTC).
const EXPORT_NAME_TIME = /(\d{4}-\d{2}-\d{2})T(\d{2})_(\d{2})_(\d{2})/;

/**
 * CSV text → listings. The export has no currency column: the account sells in
 * EUR (every API read so far), so EUR is assumed. taken_at: the export's time
 * from its file name; without one, the newest `updated` in the file, which can
 * only make it look older than it is. Never later than now.
 */
export function snapshotFromCsv(text: string, fileName = '', now = new Date()): { listings: Record<string, SnapshotListing>; taken_at: string } {
  const [head, ...rows] = parseCsv(text);
  const col = (name: string) => {
    const i = (head || []).indexOf(name);
    if (i < 0) throw new Error(`Discogs export: no "${name}" column`);
    return i;
  };
  const id = col('listing_id'), status = col('status'), price = col('price');
  const media = col('media_condition'), sleeve = col('sleeve_condition'), updated = col('updated');
  const listings: Record<string, SnapshotListing> = {};
  let newest = '';
  for (const r of rows) {
    if (!r[id]) continue;
    listings[r[id]] = {
      status: CSV_STATUS[r[status]] || r[status],
      price: Math.round(Number(r[price]) * 100) / 100,
      currency: 'EUR',
      condition: CSV_GRADE[r[media]],
      sleeve_condition: CSV_GRADE[r[sleeve]],
    };
    if ((r[updated] || '') > newest) newest = r[updated];
  }
  if (!Object.keys(listings).length) throw new Error('Discogs export: no listings');
  const m = EXPORT_NAME_TIME.exec(fileName);
  const t = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : Date.parse(`${newest}Z`);
  const taken = Number.isFinite(t) ? Math.min(t, now.getTime()) : 0;
  return { listings, taken_at: new Date(taken).toISOString() };
}

// ── API refresh (cron) ─────────────────────────────────────────────

const fromApi = (l: DiscogsListing): SnapshotListing => ({
  status: String(l.status || ''),
  price: Math.round(Number(l.price?.value) * 100) / 100,
  currency: String(l.price?.currency || ''),
  condition: l.condition || undefined,
  sleeve_condition: l.sleeve_condition || undefined,
});

export interface SnapshotRefreshResult {
  at: string;
  result: 'skipped_fresh' | 'progress' | 'complete' | 'discogs_429' | 'error' | 'not_configured';
  pages_read: number;
  next_page?: number;
  pages?: number | null;
  error?: string;
}

/** One cron's worth of inventory pages. Never waits out a 429. */
export async function refreshDiscogsSnapshot(env: KvEnv, username: string): Promise<SnapshotRefreshResult> {
  const now = Date.now();
  const out: SnapshotRefreshResult = { at: new Date(now).toISOString(), result: 'progress', pages_read: 0 };
  const done = async () => { await env.SYNC_STATE.put(SNAPSHOT_LAST_REFRESH_KEY, JSON.stringify(out)); return out; };
  if (!env.DISCOGS_TOKEN) { out.result = 'not_configured'; return done(); }

  let build: SnapshotBuild | null = null;
  try { build = JSON.parse((await env.SYNC_STATE.get(SNAPSHOT_BUILD_KEY)) || 'null'); } catch { build = null; }
  if (build && now - Date.parse(build.started_at) > BUILD_RESTART_MS) build = null;
  if (!build) {
    if (snapshotAgeMs(await loadSnapshot(env), now) < SNAPSHOT_REFRESH_EVERY_MS) { out.result = 'skipped_fresh'; return done(); }
    build = { started_at: new Date(now).toISOString(), next_page: 1, pages: null, listings: {} };
  }

  for (let n = 0; n < PAGES_PER_RUN; n++) {
    let page;
    try {
      page = await getInventory(env.DISCOGS_TOKEN, username, build.next_page, undefined, { sort: 'listed', sortOrder: 'asc', retry429: false });
    } catch (e: any) {
      const msg = e?.message || String(e);
      out.result = /\b429\b/.test(msg) ? 'discogs_429' : 'error';
      if (out.result === 'error') out.error = msg;
      break;
    }
    out.pages_read++;
    for (const l of page.listings || []) build.listings[String(l.id)] = fromApi(l);
    build.pages = page.pagination?.pages ?? 1;
    build.next_page++;
    if (build.next_page > build.pages) {
      await saveSnapshot(env, build.listings, build.started_at, 'api');
      await env.SYNC_STATE.delete(SNAPSHOT_BUILD_KEY);
      out.result = 'complete';
      out.pages = build.pages;
      return done();
    }
  }
  await env.SYNC_STATE.put(SNAPSHOT_BUILD_KEY, JSON.stringify(build));
  out.next_page = build.next_page;
  out.pages = build.pages;
  return done();
}

/** What the admin shows. */
export async function snapshotStatus(env: KvEnv) {
  const snap = await loadSnapshot(env);
  let build: SnapshotBuild | null = null;
  try { build = JSON.parse((await env.SYNC_STATE.get(SNAPSHOT_BUILD_KEY)) || 'null'); } catch { build = null; }
  let last = null;
  try { last = JSON.parse((await env.SYNC_STATE.get(SNAPSHOT_LAST_REFRESH_KEY)) || 'null'); } catch { last = null; }
  return {
    taken_at: snap?.taken_at || null,
    source: snap?.source || null,
    count: snap?.count || 0,
    age_hours: snap ? Math.round(snapshotAgeMs(snap) / 360000) / 10 : null,
    stale: !snapshotFresh(snap),
    max_age_hours: SNAPSHOT_MAX_AGE_MS / 3600000,
    building: build ? { started_at: build.started_at, next_page: build.next_page, pages: build.pages } : null,
    last_refresh: last,
  };
}
