# CLAUDE.md

Apex — finds and ranks the best driving roads near a location. React SPA +
client-side scan engine (in a Web Worker) + a thin Cloudflare Worker proxy
with KV caching. Live at https://charliepolito.com/apex.

- **PROJECT.md** — architecture, data flow, design decisions, and the scan
  pipeline explained. Read it before touching `frontend/src/engine/`.
- **GAPS.md** — known weaknesses and pre-scoped fixes, ordered by severity.
  Check it before filing/fixing a bug — it may already be scoped there.
- **apex-spec.md** — the original product spec. Authoritative for *product*
  decisions (scoring principles, §8 v2 non-goals). NOT authoritative for
  architecture: it says Python/FastAPI/Docker, but the real implementation is
  Cloudflare + client-side TypeScript.

## Commands

```sh
npm install && cd frontend && npm install && cd ..   # TWO installs (root + frontend)

npm run build      # frontend: tsc -b && vite build -> frontend/dist/apex
npm run dev        # wrangler dev :8787 -> http://localhost:8787/apex/  (build first!)
cd frontend && npm run dev   # Vite hot reload; proxies /apex/api -> wrangler :8787
npm run verify     # run the real engine against live Overpass (Hell, MI default)
npx tsx scripts/verify.ts 35.61 -83.93 15 paved      # verify: Tail of the Dragon
npm run deploy     # build + wrangler deploy (needs Cloudflare auth)

npx tsc -p worker --noEmit    # typecheck the Worker (NOT run by any script — do it manually)
```

There is no test suite and no linter (GAPS.md #1, #12). `npm run verify` is
the only check on engine behavior — it prints top-10s per preset; compare by
eye. **Sanity anchors:** Hell MI must surface Topping/Chilson/N Territorial/
Patterson Lake; Deals Gap (35.61 -83.93) must rank Calderwood Highway #1.
Set `APEX_CACHE_DIR` before running verify — the default cache path is broken
(GAPS.md #5).

## Layout

```
worker/index.ts          # the ONLY server code: asset serving + Overpass/Nominatim proxy + KV cache
frontend/src/engine/     # pure TS scan pipeline — no DOM, runs in Web Worker AND Node
  geo.ts graph.ts stitch.ts score.ts presets.ts overpass.ts scan.ts
frontend/src/scan.worker.ts  # Web Worker wrapper; owns fetch/retry against /apex/api
frontend/src/ui/         # React components (MapView, SearchPanel, ScoringPanel, ResultsList)
frontend/src/lib/        # display-only helpers (format.ts, mapsLink.ts)
scripts/verify.ts        # Node harness for the engine (disk-caches Overpass responses)
wrangler.toml            # routes charliepolito.com/apex/*, KV namespace CACHE
```

## Rules — do not break these

1. **Scan-once, re-rank-instantly.** Sliders/presets must NEVER trigger a
   fetch or re-scan. The scan returns 25 routes with normalized sub-scores;
   ranking is `combineScore()` in a `useMemo` in `App.tsx`. Keep it that way.
2. **`engine/` stays pure.** No DOM APIs, no imports from `ui/` or `lib/`,
   all I/O through the injected `Fetcher`. It must keep running in both the
   Web Worker and Node (verify.ts imports it directly).
3. **Tuned constants change the ranking.** Curvature buckets
   (`graph.ts:curvatureWeight`), turn thresholds (`stitch.ts` 40°/110°),
   `saturate()` constants and exposure blend (`score.ts`), preset weights
   (`presets.ts`) were hand-tuned against real areas. Never touch them without
   running `npm run verify` before/after and comparing against the sanity
   anchors.
4. **`SubScores` is a cross-cutting contract.** Adding/renaming a component
   touches `presets.ts`, `score.ts`, `ScoringPanel.tsx` (`ORDER`), and breaks
   users' stored prefs (`localStorage` key `apex-prefs-v1` — currently
   unvalidated, GAPS.md #4). Bump the key version when changing the shape.
5. **Worker cache keys and client query construction must stay in sync.**
   Coordinate rounding to 3 decimals in `overpass.ts:roundCoord` is what makes
   KV cache hits happen. Don't change query text formatting casually — every
   byte changes the sha256 cache key.
6. **Don't build spec §8 v2 features** (saved presets, loop routing,
   elevation, scenery, sharing) without the owner asking.
7. **Curvature method is adapted from a GPLv3 project** (method only, no
   code — Adam Franco's `curvature`). Never copy code from it; keep the
   license note in the README if open-sourcing.
8. **`frontend/tsconfig.tsbuildinfo` is generated** (and wrongly committed —
   GAPS.md #11). Don't hand-edit it; don't commit new changes to it.

## Conventions

- Coordinates are **`[lon, lat]`** (`LonLat`, GeoJSON order) everywhere in the
  engine. Overpass/Nominatim return `lat`/`lon` fields — flip at the parse
  boundary only. This is the #1 bug source; check the order twice.
- Geometry math runs in a **local flat projection** in meters
  (`geo.ts:Projection`) centered on the search point. `haversineM` for raw
  `LonLat` pairs; `dist` for projected `XY` pairs. Never mix.
- Units: meters internally (`lengthM`, `radiusM` suffixes); the UI displays
  miles/mph (US-focused, `lib/format.ts`).
- TypeScript strict everywhere; types via `interface`; no classes except
  `Projection`/`GridIndex`/`HttpError`. No default exports in the engine;
  React components ARE default exports.
- Errors: the engine throws `Error` with user-facing messages; the Web Worker
  catches and posts `{type:"error", message}`; the Cloudflare Worker throws
  `HttpError` and returns `{detail}` JSON. Follow those channels.
- State: all UI state lives in `App.tsx` (`prefs` persisted to localStorage,
  `scanState` discriminated union). No state library — don't add one.
- Styling: single `styles.css` with CSS variables (dark telemetry theme,
  `--accent` purple / `--blue`). Mono font (`--mono`) for all numbers. No CSS
  framework — match the existing classes.
- Comments cite spec sections (e.g. "§4") — keep doing that when implementing
  spec behavior.

## Gotchas

- `npm run dev` (wrangler) **fails or serves nothing without a prior
  `npm run build`** — the `[assets]` dir `frontend/dist` must exist.
- Vite emits into `dist/apex` (not `dist/`) on purpose: built file paths must
  mirror the `/apex/` URL prefix so Cloudflare's asset host serves them.
  `base: "/apex/"` in `vite.config.ts` is load-bearing.
- The Worker only runs for `/apex/api/*` and SPA-fallback paths; real asset
  requests never reach it.
- Overpass returns **HTTP 200 with a `remark` field when it trims data**. The
  Worker declines to cache such bodies; the engine currently ignores `remark`
  entirely (GAPS.md #6).
- In `stitch.ts`, edges already consumed by earlier routes **stay extendable
  on purpose** — blocking them fragments long roads; de-dup resolves overlap
  later. Don't "fix" it.
- `MapView.tsx` deliberately omits `routes` from two effect dep arrays (the
  eslint-disable comments; no ESLint is installed). Refactor carefully —
  adding the dep naively causes fit-loops (GAPS.md #13).
- `radii` in a route result aligns 1:1 with `coords`; straights are encoded
  as `-1` (not `Infinity` — it must survive `postMessage`/JSON).
- The map legend gradient in `styles.css` (`.legend-bar`) duplicates
  `LINE_COLOR` in `MapView.tsx` — change both or the legend lies.
- Root and frontend have **separate package.json/lockfiles**; installing at
  root does not install frontend deps.
- The Worker is deployed to the owner's personal Cloudflare zone
  (`charliepolito.com`) — `npm run deploy` from CI/other machines will fail
  without his credentials. Don't attempt deploys unasked.
