# PROJECT.md — Apex

*The orientation document. Read this before touching anything. For operational
commands and conventions see [CLAUDE.md](CLAUDE.md); for the honest list of
known weaknesses see [GAPS.md](GAPS.md); for the original product requirements
see [apex-spec.md](apex-spec.md).*

## What this is

Apex is a single-page web app that answers one question: **"Where are the good
driving roads near here?"** A user enters an address and a radius (up to
40 km), the app scans the OpenStreetMap road network in that radius, scores
every road on how *fun* it is (twisty, sustained, flowing) **and** how
*appropriate* it is for spirited driving (away from homes, driveways, stop
signs, and traffic), and draws the top 10 on a map. Each road is colored by
per-corner tightness — light blue on straights, deep purple through the
tightest corners — and gets an "Open in Maps" deep link to its start point.

It's for driving and motorcycling enthusiasts. The differentiator versus
generic "twisty road" maps is the appropriateness half of the score: the tool
deliberately down-ranks fun-but-residential streets so users are steered
toward low-consequence rural roads. Read §2 of `apex-spec.md` — "the ranking
has to feel right to someone who actually drives these roads" is the product's
single most important requirement, and every scoring decision traces back to it.

It is a personal project by one developer (Charlie Polito), deployed at
**https://charliepolito.com/apex** on his existing Cloudflare zone, and built
almost entirely from the spec in one pass (the repo has a single initial
commit).

## Tech stack and why

| Piece | Choice | Why (inferred from code/comments) |
|---|---|---|
| Hosting/API | Cloudflare Worker + static assets + KV | The spec said Docker/FastAPI, but the README states this was **overridden** to ship on the owner's existing Cloudflare setup (same pattern as a sibling project, "Localize"). Free, no servers, no secrets. |
| Scan compute | TypeScript in a **browser Web Worker** | Direct consequence of dropping the Python backend: the CPU-bound geometry/graph work moved client-side. The Web Worker keeps the UI thread responsive during multi-second scans. |
| Road data | OpenStreetMap via public **Overpass API** | Fixed by spec. Free, no key. Worker proxies + caches it. |
| Geocoding | Public **Nominatim** | Fixed by spec. Free, no key. Worker proxies + caches it. |
| Map | **MapLibre GL JS** + OpenFreeMap "positron" style | Fixed by spec. Free, no key, light basemap so the blue→purple road overlay pops. |
| Frontend | React 18 + Vite 6 + TypeScript (strict) | Spec suggested React; Vite gives the Web Worker bundling (`new Worker(new URL(...))`) and the `/apex/` base path for free. |
| Verification | `tsx` running the engine in Node | The engine is pure TS with an injected fetcher precisely so the same code runs headless against live Overpass data (`scripts/verify.ts`). |

There is **no database, no auth, no user accounts, no server-side state**
beyond the KV response cache. All services are free and keyless by design so
the app can be shared without distributing secrets.

## Architecture

```
Browser
├── React UI (App.tsx + ui/*)         ← state: prefs in localStorage, scan state
│     │  postMessage({center, radius, surface})
│     ▼
├── Web Worker (scan.worker.ts)       ← runs engine/scan.ts off the UI thread
│     │  POST /apex/api/overpass  { query: OverpassQL }
│     ▼
Cloudflare Worker (worker/index.ts)   ← routes charliepolito.com/apex/*
├── /apex/api/overpass  → overpass-api.de (fallback: overpass.kumi.systems)
│                          cached in KV 7 days, keyed by sha256(query)
├── /apex/api/geocode   → nominatim.openstreetmap.org, cached in KV 30 days
├── /apex/api/health    → { ok: true }
└── everything else     → static assets (frontend/dist), SPA-fallback to index.html
```

### The scan pipeline (`frontend/src/engine/`)

This is the heart of the app. It's pure TypeScript — no DOM, no imports from
`ui/` — and runs identically in the Web Worker and in Node. The pipeline in
`scan.ts` (`scan()`):

1. **Fetch roads** (`overpass.ts`): one Overpass query for all drivable
   `highway=*` ways in the radius. Center coordinates are rounded to ~110 m
   before building the query so near-repeat searches hash to the same KV
   cache key.
2. **Check density**: a cheap `out count` query for buildings. Above 250 k
   buildings (`BUILDING_CAP`) the building fetch is skipped and the "homes"
   signal degrades to residential-landuse + road-class only, with a user
   warning. This is the dense-metro safety valve from spec §3.
3. **Fetch context**: stops/give-way/signals (nodes), driveways
   (`service=driveway` ways), residential landuse polygons; buildings
   separately (they're the heavy query — a failure there degrades the homes
   signal instead of killing the scan).
4. **Build graph** (`graph.ts`): OSM ways are split at shared nodes into
   `Edge`s. Each edge is computed once: local-projection XY coords, per-segment
   lengths, surface classification (spec §4 fallback rules), and **curvature**
   via the circumcircle-radius method — for every 3 consecutive points, the
   circumcircle radius approximates corner radius; radii are bucketed into
   weights (r<30 m → 2.0 … r<175 m → 1.0, r≥175 m → not a corner, r<8 m →
   noise/cul-de-sac, ignored) and multiplied by the length spent cornering.
   Method adapted (method only, **no code**) from Adam Franco's GPLv3
   `curvature` project — keep the license in mind if open-sourcing.
5. **Stitch** (`stitch.ts`): OSM fragments roads at every junction/tag change,
   so human-perceived "roads" are reassembled by greedy bidirectional extension
   from two seed families: the ~140 most-curved edges (twisty roads) and the
   ~40 longest arterial fragments (so "Fast Highway" preset has real routes to
   rank). Growth continues across a junction when the driver could carry
   roughly straight through (<40°), or the name/ref matches, or the onward
   edge is itself high quality; never turns more than 110°. Weak straight
   tails are trimmed from non-arterial routes. Routes shorter than 1.5 km are
   dropped; growth caps at 45 km.
6. **Score** (`score.ts`): each stitched route gets 7 normalized 0..1
   sub-scores (`SubScores` in `presets.ts`): twist, length, homes, driveways,
   stops, isolation (mean distance to nearest arterial that isn't itself — the
   traffic proxy), fewLanes. Raw signals are squashed with saturating curves
   `x/(x+k)` so slider weights are comparable across units. Twistiness is
   *recomputed over the joined polyline* so corners spanning edge seams count.
   Display metadata (name, surface, speed limit with class-based fallback
   marked "~", lane count) is the length-weighted dominant value across the
   route's edges.
7. **De-duplicate**: routes sorted by the Balanced preset, then greedily kept
   unless they share a name with an already-kept route or ≥50 % geometric
   overlap (by shared edge length). Top **25** survive (not 10 — see below).

### Scan-once, re-rank-instantly (the key design decision)

The scan returns 25 routes, each carrying its per-component sub-scores. The
final score is `combineScore(sub, weights)` — a plain weighted average
computed **on the client** in a `useMemo` in `App.tsx`. Moving a slider or
switching a preset re-sorts instantly with zero network traffic and zero
re-scan. Returning 25 instead of 10 gives the re-rank room to promote
different roads under different weightings. This is spec §3's core
architectural principle; **do not break it** by making sliders trigger fetches.

The lanes slider is the only bipolar one (−100..100): positive favors fewer
lanes (rural two-lane), negative favors more (highway). `combineScore`
implements a negative weight as scoring against `1 − sub`.

### Caching layers (three of them)

1. **Cloudflare KV** (`wrangler.toml` namespace `CACHE`): Overpass responses
   7 days keyed by `ov:` + sha256 of the query; geocode 30 days keyed by
   `geo:` + lowercased query. The client's coordinate rounding is what makes
   this cache effective.
2. **Coordinate rounding** (`overpass.ts` `roundCoord`): 3 decimal places
   (~110 m), so "near-repeat" searches are cache hits.
3. **Disk cache** in `scripts/verify.ts` (`APEX_CACHE_DIR`) so engine re-runs
   during development don't hammer the public API.

## Critical paths (what's load-bearing)

- **`engine/graph.ts` + `engine/stitch.ts` + `engine/score.ts`** — the entire
  product quality lives here. Constants like the curvature weight buckets, the
  175 m not-cornering threshold, the 40°/110° turn thresholds, the `saturate`
  half-way constants (`twistPerKm/120`, `drivewaysPerKm/6`, …), and the preset
  weights in `presets.ts` were all hand-tuned against real areas (Hell MI;
  Tail of the Dragon). **Changing any of them changes the ranking.** Always
  run `npm run verify` before and after and compare the top-10 lists against
  the sanity anchors in the README: Hell MI should surface Topping/Chilson/
  N Territorial/Patterson Lake; Deals Gap (35.61 −83.93) must put Calderwood
  Highway (the Tail of the Dragon) at #1.
- **`engine/scan.ts`** — the orchestration and de-dup. The `PublicRoute` shape
  it returns is the contract with the UI *and* the map coloring (`radii`
  aligned 1:1 with `coords`, `Infinity` encoded as `-1`).
- **`worker/index.ts`** — the only server code. Its cache keys and the
  client's query construction must stay in sync (rounding lives client-side).
- **`presets.ts` `SubScores`** — adding/removing a component touches score.ts,
  presets, ScoringPanel's `ORDER`, and any stored prefs in users'
  localStorage (`apex-prefs-v1`).

Safe to change casually: everything in `ui/` and `lib/` (presentation only),
`styles.css`, copy text, the map colors (keep the legend gradient in
`styles.css` `.legend-bar` in sync with `LINE_COLOR` in `MapView.tsx`).

## Non-obvious things that will trip you up

- **The spec is not the implementation.** `apex-spec.md` says Python/FastAPI/
  Docker; the real app is a Cloudflare Worker + client-side engine. The spec
  is still authoritative for *product* decisions (scoring principles, v2
  non-goals), not for architecture.
- **Everything is `[lon, lat]`** (GeoJSON order), type `LonLat`. Nominatim and
  Overpass return `lat`/`lon` fields; the parsing code flips them immediately.
  Mixing the order is the classic bug here.
- **Geometry is done in a local flat projection** (`geo.ts` `Projection`,
  equirectangular meters centered on the search point) — fine at ≤40 km, wrong
  for anything global. Distances between raw coords use `haversineM`; distances
  between projected `XY` use `dist`.
- **Edges consumed by earlier routes stay extendable on purpose**
  (`stitch.ts`): blocking them fragments long roads; overlap is resolved later
  by de-dup. Don't "fix" this.
- **Overpass can return HTTP 200 with a `remark` field and partial data**
  (timeout/trim). The Worker refuses to *cache* such responses (substring
  check) but still returns them; the engine currently ignores `remark` (see
  GAPS.md #6).
- **The Worker only runs for non-asset paths.** Cloudflare serves anything
  matching a file in `frontend/dist` directly; the Worker handles `/apex/api/*`
  and the SPA fallback. That's why Vite emits into `dist/apex` — the built
  file paths must mirror the `/apex/` URL prefix (see `vite.config.ts`).
- **`wrangler dev` needs a built frontend first** — the `[assets]` directory
  must exist. Run `npm run build` once before `npm run dev`.
- **The verify script is the only test rig** and it's an eyeball check, not an
  assertion suite. Its default disk-cache path is a hardcoded path from the
  original author's machine — set `APEX_CACHE_DIR` (see GAPS.md #5).
- **Mirror fallback exists twice**: the Worker falls back to a second Overpass
  mirror, and `verify.ts` has its own copy of the same logic (it bypasses the
  Worker entirely).
- **v2 features are deliberately absent** (spec §8): saved custom presets,
  route/loop optimization, elevation, scenery, sharing, self-hosted Overpass.
  Don't add them casually — the spec explicitly defers them.
