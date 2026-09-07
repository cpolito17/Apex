// Engine verification against live Overpass data. Usage:
//   npx tsx scripts/verify.ts [lat] [lon] [radiusKm] [surface]
// Defaults to Hell, Michigan — the classic SE-Michigan driving area — and
// prints the top 10 under each preset. Responses are cached on disk so
// re-runs don't hammer the public API.

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LonLat } from "../frontend/src/engine/geo";
import type { Fetcher, OverpassResponse } from "../frontend/src/engine/overpass";
import { combineScore, PRESETS } from "../frontend/src/engine/presets";
import { scan } from "../frontend/src/engine/scan";
import type { SurfaceChoice } from "../frontend/src/engine/stitch";

const CACHE_DIR =
  process.env.APEX_CACHE_DIR ?? join(process.cwd(), ".overpass-cache");

const fetcher: Fetcher = async (query) => {
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = createHash("sha256").update(query).digest("hex").slice(0, 24);
  const file = join(CACHE_DIR, `${key}.json`);
  if (existsSync(file)) {
    process.stderr.write(`  [cache hit ${key}]\n`);
    return JSON.parse(readFileSync(file, "utf8")) as OverpassResponse;
  }
  process.stderr.write(`  [overpass fetch ${key}] ${query.split("\n")[1]?.slice(0, 80)}\n`);
  const t0 = Date.now();
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
  ];
  let text = "";
  let lastStatus = 0;
  for (const endpoint of endpoints) {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Apex/1.0 (https://charliepolito.com/apex; contact: cpolito@umich.edu)",
      },
      body: `data=${encodeURIComponent(query)}`,
    });
    lastStatus = resp.status;
    if (resp.status === 200) {
      text = await resp.text();
      break;
    }
    process.stderr.write(`  [${endpoint.split("/")[2]} -> HTTP ${resp.status}, trying next]\n`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!text) throw new Error(`Overpass HTTP ${lastStatus} on all mirrors`);
  process.stderr.write(`  [fetched ${(text.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s]\n`);
  const json = JSON.parse(text) as OverpassResponse;
  if (json.remark) process.stderr.write(`  [overpass remark: ${json.remark}]\n`);
  writeFileSync(file, text);
  return json;
};

const lat = Number(process.argv[2] ?? 42.4348); // Hell, MI
const lon = Number(process.argv[3] ?? -83.9845);
const radiusKm = Number(process.argv[4] ?? 15);
const surface = (process.argv[5] ?? "paved") as SurfaceChoice;
const center: LonLat = [lon, lat];

const t0 = Date.now();
const result = await scan({
  center,
  radiusM: radiusKm * 1000,
  surface,
  fetcher,
  onProgress: (p) => process.stderr.write(`  [${(p.pct * 100).toFixed(0).padStart(3)}%] ${p.detail}\n`),
});
const dt = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\nScan of ${lat},${lon} r=${radiusKm}km surface=${surface} -> ${result.routes.length} distinct roads in ${dt}s`);
for (const w of result.warnings) console.log(`WARNING: ${w}`);

for (const presetName of Object.keys(PRESETS)) {
  const weights = PRESETS[presetName];
  const ranked = [...result.routes]
    .map((r) => ({ r, score: combineScore(r.sub, weights) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  console.log(`\n=== ${presetName} — top 10 ===`);
  for (let i = 0; i < ranked.length; i++) {
    const { r, score } = ranked[i];
    const s = r.sub;
    console.log(
      `${String(i + 1).padStart(2)}. [${score.toFixed(1)}] ${r.name} — ${(r.lengthM / 1000).toFixed(1)}km ` +
        `${r.surface}${r.surfaceCertain ? "" : "?"} ${r.speedLimitMph}${r.speedIsEstimate ? "~" : ""}mph ${r.hwyClass}\n` +
        `      twist/km=${r.raw.twistPerKm} bld/km=${r.raw.buildingsPerKm} res=${r.raw.residentialFrac} ` +
        `dw/km=${r.raw.drivewaysPerKm} stops/km=${r.raw.stopsPerKm} artDist=${r.raw.arterialDistM}m\n` +
        `      sub: twist=${s.twist.toFixed(2)} len=${s.length.toFixed(2)} homes=${s.homes.toFixed(2)} ` +
        `dw=${s.driveways.toFixed(2)} stops=${s.stops.toFixed(2)} iso=${s.isolation.toFixed(2)} lanes=${s.fewLanes.toFixed(2)}` +
        `  start=${r.startCoord[1].toFixed(4)},${r.startCoord[0].toFixed(4)}`
    );
  }
}
