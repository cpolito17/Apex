# Apex

*Find the roads worth driving — and keep the fun where it belongs.*

Live at **https://charliepolito.com/apex**

Apex scans the road network around any location, scores every road on how fun
**and** how appropriate it is for spirited driving, and maps the top 10 —
colored light blue on the straights, deep purple through the tightest corners.

Built from [apex-spec.md](../apex-spec.md).

## Architecture

The spec's Docker/FastAPI deployment target was overridden by the requirement
to ship on the existing Cloudflare setup (same pattern as Localize):

- **Cloudflare Worker** ([worker/index.ts](worker/index.ts)) — serves the built
  SPA under `/apex/*` and proxies the two public data services with KV caching:
  - `POST /apex/api/overpass` — OverpassQL passthrough, cached 7 days by query
    hash (clients round bbox coords, so near-repeat searches hit cache).
    Falls back to a second Overpass mirror on timeout/429.
  - `GET /apex/api/geocode?q=` — Nominatim search for the address autocomplete,
    cached 30 days, single well-identified caller.
- **Scan engine** ([frontend/src/engine/](frontend/src/engine/)) — pure
  TypeScript, no DOM. Runs in a browser **Web Worker** (so slider re-ranks and
  UI stay responsive) and in Node for verification. Pipeline:
  fetch → build graph (ways split at junctions) → per-edge curvature
  (circumcircle-radius method, Franco-style weight buckets) → greedy
  bidirectional stitching from curvature + arterial-corridor seeds → component
  scoring (twist, length, homes, driveways, stops, isolation, lanes) →
  name/overlap de-dup → top 25 returned.
- **Re-ranking is pure client math** — the scan returns normalized
  per-component sub-scores; sliders/presets reweight and re-sort instantly
  with no re-scan (§3 of the spec).
- **Frontend** — React + Vite + MapLibre GL (OpenFreeMap positron basemap),
  base `/apex/`, emitted to `frontend/dist/apex`.

No secrets anywhere; all services are free/no-key.

## Develop

```sh
npm install && cd frontend && npm install && cd ..
npm run build        # build the SPA (wrangler serves frontend/dist)
npm run dev          # wrangler dev on :8787 -> http://localhost:8787/apex/
```

For frontend iteration with hot reload: `cd frontend && npm run dev` (Vite
proxies `/apex/api` to wrangler on :8787).

## Verify the engine

Runs the real pipeline against live Overpass (disk-cached) and prints the top
10 under every preset:

```sh
npm run verify                          # Hell, MI (default test region)
npx tsx scripts/verify.ts 35.61 -83.93 15 paved   # Tail of the Dragon
```

Sanity anchors: Hell MI should surface Topping/Chilson/N Territorial/Patterson
Lake; Deals Gap should put Calderwood Highway (the Tail of the Dragon) at #1.

## Deploy

```sh
npm run deploy       # builds the frontend, then wrangler deploy
```

Routes `charliepolito.com/apex` + `/apex/*`; KV namespace `CACHE` holds the
Overpass/Nominatim response cache.

## Notes

- The twistiness algorithm adapts the circumcircle-radius *method* from Adam
  Franco's GPLv3 `curvature` project (method only, no code) — keep the license
  in mind if this repo is ever open-sourced.
- v2 candidates (saved presets, route/loop optimization, elevation, scenery,
  self-hosted Overpass, sharing) are deliberately not built; see the spec §8.
