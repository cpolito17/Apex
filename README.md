# Apex — Scenic Road Finder

Apex is a free, interactive road-discovery map that finds scenic, curvy roads near any location. It evaluates OpenStreetMap road geometry and surrounding context, then ranks routes for drivers who want to explore engaging roads responsibly.

**Live app:** [https://charliepolito.com/apex/](https://charliepolito.com/apex/)

**Portfolio:** [charliepolito.com](https://charliepolito.com/)

**Source:** [github.com/cpolito17/Apex](https://github.com/cpolito17/Apex)

## Features

- Search by address, town, or place.
- Scan a configurable 5–40 km radius.
- Choose paved roads, gravel roads, or both.
- Rank roads with adjustable twistiness, length, isolation, traffic-control, driveway, and lane weights.
- Re-rank locally without another network request.
- Inspect the top ten on a MapLibre map with curvature-based coloring.
- Use the responsive desktop panel or mobile bottom sheet.

## Architecture and technology

Apex uses React, TypeScript, Vite, MapLibre GL, Cloudflare Workers, Static Assets, and KV. A browser Web Worker fetches OpenStreetMap data, builds a graph, measures curvature, stitches useful segments, and calculates normalized scores off the main UI thread. The Cloudflare Worker serves `/apex/`, proxies Nominatim and Overpass through same-origin routes, validates input, and caches successful responses.

## Local development

Requirements: a current Node.js LTS release and npm.

```sh
npm install
cd frontend
npm install
cd ..
npm run build
npm run dev
```

Open `http://localhost:8787/apex/`. For Vite hot reload, keep the Worker running and run `npm run dev` from `frontend/`; Vite proxies `/apex/api` to port 8787.

## Configuration

Apex requires no API keys. The deployed Worker expects:

| Binding | Type | Purpose |
| --- | --- | --- |
| `ASSETS` | Static Assets | Built frontend files |
| `CACHE` | KV namespace | Cached road and geocoding responses |

Never put secret values in `wrangler.toml` or commits. Add future secrets with Cloudflare's secret management.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run build` | Type-check and build the frontend |
| `npm run dev` | Run the Worker locally |
| `npm run verify` | Exercise the scoring engine against live Overpass data |
| `npm run deploy` | Build and deploy with Wrangler |

The verification script accepts optional latitude, longitude, radius, and surface arguments:

```sh
npx tsx scripts/verify.ts 35.61 -83.93 15 paved
```

## Deployment

`wrangler.toml` defines the Worker, KV binding, static assets, and both `charliepolito.com/apex` routes. Deploy with `npm run deploy`. The Vite base path and web manifest intentionally use `/apex/`; preserve that prefix.

## Security and privacy

- No account, cookie, analytics tracker, or application secret is required.
- Preferences remain in browser local storage.
- Location and road queries pass through the same-origin Worker; successful responses may be cached in KV.
- Input is size- and shape-validated, cross-site browser requests are rejected, and the Overpass route accepts only generated read-only JSON queries.
- Cloudflare rate limiting constrains each API route per network before it can reach an upstream provider.

Review the policies of Cloudflare, OpenStreetMap, Nominatim, Overpass, OpenFreeMap, and Google Maps before production use.

## Project status

This is a working public portfolio project. Rankings are estimates, not navigation or safety guidance. Follow laws, closures, road conditions, and safe-driving practices.

The curvature method was independently implemented from the mathematical approach used by Adam Franco's GPLv3 `curvature` project; no source code was copied.

## License

No software license has been declared. Copyright remains with the repository owner unless a license is added.
