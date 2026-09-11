# Session — Rubadub importer to production (2026-06-24)

Shipped the **Rubadub import tab** to production (frontend + worker) and fixed
the ZIP↔invoice matcher. End-to-end: import in-app → Shopify CSV, and the worker
now accepts the resulting `source:rd` products for auto-listing / review.

## Context at start

- Frontend on `staging`, worker deployed from `main` (worker lives on `main`).
- `RubadubImporter` (+343 lines) was sitting uncommitted in the `staging`
  working tree.
- The worker working tree had **unrelated** uncommitted changes (the *House Only
  Radar* daily-discovery feature: `RADAR_KV` binding, `0 8 * * *` cron,
  `src/lib/radar.ts`, backfill scripts). Those were left untouched throughout —
  not part of this work.

## What the Rubadub importer does

`src/App.jsx` → `RubadubImporter` (tab `💿 Rubadub`).

Rubadub ships **no promopacks of its own**. The importer treats the **invoice
PDF as the spine** and sources cover/audio ZIPs from W&S (or other distributors):

- **Invoice PDF** (`parseRubadubInvoicePdf`): each line = `{qty} {Artist - Title}
  {SKU} {HS code?} £{net} £{total}`. Parsed by y-position grouping; anchors on
  the two trailing £ amounts; SKU = last body token. Wrapped/continuation SKUs
  are rejoined; shipping/postage/fee lines dropped.
- **Matching**: `rdKey()` normalizes catno/SKU (uppercase, strip non-alphanumeric)
  so Rubadub's SKU matches a W&S ZIP filename across punctuation differences.
- **Spine model**: every invoiced disc gets a row. With a matching ZIP → cover +
  audio + press text (uploaded to R2). Without → cover-less (add art in Shopify).
- **Pricing**: dealer £ × FX (GBP→EUR) × (1 + margin%), ceil − 0.01 (ends `.99`).
- **Output**: `shopify_import_rd.csv`. Products tagged `vinyl, source:rd, label:…,
  {genre}`.

## Matcher fixes (the debugging core of this session)

Symptom: many invoiced records came through **cover-less even though their ZIPs
were provided**. Root cause was in **SKU↔ZIP matching**, not the PDF parser (the
parser was correct — 41/41 lines parsed on the real invoice `SI-283012`).

Reproduced the exact parser + matcher in Node (pdfjs-dist) against the real
invoice + the 50-ZIP batch. Two real defects, both in `catnoFromFilename` /
matching:

1. **URL-encoded filenames** — W&S download names URL-encode catno punctuation:
   `150865-DBS%231.zip` is really `DBS#1`. Without decoding, `DBS%231` → key
   `DBS231` never matched invoice `DBS#1` → key `DBS1`.
   **Fix:** `catnoFromFilename` now `decodeURIComponent()`s the filename (wrapped
   in try/catch for malformed escapes) before extracting the catno. *(Shared with
   the W&S importer — benefits it too.)* Recovered `DBS#1`, `DBS#2`.

2. **Format-suffix mismatch** — W&S filenames sometimes carry a trailing format
   token the Rubadub SKU omits: invoice `AOS-111` ↔ zip `aos111lp` (…`LP`),
   invoice `EB004` ↔ zip `EB004S` (…`S`).
   **Fix:** a guarded fallback in `RubadubImporter.process()` — when no exact
   catno match, claim an **unused** ZIP whose key is `SKU key + a known format
   suffix` (`LP, EP, S, RE, X, R, 12, 7, CD`). The "unused ZIP" guard prevents a
   near-miss like `AOS-432-J` (…`432J`) from stealing the `AOS-432Z` (…`432Z`)
   ZIP. (Decision: applied automatically, no fuzzy-match badge in the UI.)

### Validation (deterministic, against real files)

| Stage | Matches |
|-------|---------|
| Before | 30 / 41 |
| + URL-decode | 32 / 41 |
| + suffix fallback | **34 / 41** |

- All **34** matched ZIPs were confirmed to contain a usable cover image (same
  `/front|cover|artwork/i \|\| first image` selection logic). → import renders 34
  covers.
- The remaining **7** are genuinely cover-less: no ZIP for them in the batch
  (`164422902`, `AOS-2023`, `AOS-432-J`, `AOS-444`, `AYHR0060`, `BIGFXHE`,
  `BLNDTROP5.5`). Expected — art added in Shopify.
- Minor: `DMSR8602-1` has only a BACKCOVER image (matches `/cover/`, still
  renders); `AOS-111` / `AOS-432Z` ZIPs have a cover but `audio=0`.

## Worker change

`houseonly-worker/.../src/lib/sync.ts` — added `source:rd` to
`ACCEPTED_SOURCE_TAGS`:

```js
const ACCEPTED_SOURCE_TAGS = ['source:ws', 'source:kudos', 'source:dbh', 'source:mt', 'source:tv', 'source:rd'];
```

This gate is checked in the **product-create webhook**. Without `source:rd`,
Rubadub products were dropped with `"no recognized source tag"` and never
auto-listed on Discogs / queued for review. *(Note: the constant lives in
`sync.ts` on `main`, not `index.ts`, and did not exist on `staging`.)*

## Branches, PRs, deploys

- `staging` commits: `6271887` (importer), `71c5fec` (matcher fixes).
- **PR #3** `worker/rd-accepted-source-tag` → `main` — worker `source:rd`. Merged (`359ee3e`).
- **PR #4** `rubadub-importer-to-main` → `main` — importer cherry-picked clean
  onto `main` (`ecb72f9` + `fd93820`, +368/−1, no conflicts). Merged (`cc8b682`).
- **Worker prod deploy**: `wrangler deploy` from a **clean `main` worktree**
  (not the dirty `staging` tree, to avoid shipping the Radar WIP). Version
  `2dfafd7f`. Verified bindings = WISHLIST / SYNC_STATE / R2 and cron `*/15`
  only — no `RADAR_KV`, no `0 8` cron.
- **Frontend prod**: Cloudflare Pages auto-deployed from `main`; prod bundle
  `index-iMVoxAI_.js` confirmed to contain the importer + both matcher fixes.

## Conventions applied (worth repeating)

- Worker lives on `main`; never deploy the worker from the `staging` working tree
  (it carries unrelated Radar WIP). Deploy from a clean `main` checkout/worktree.
- Commit the importer with **explicit `git add src/App.jsx`** — never `git add .`
  (the worker tree has unrelated uncommitted changes).
- `wrangler deploy` warns about multiple environments; the top-level env is
  production. Silence with `--env=""`.
