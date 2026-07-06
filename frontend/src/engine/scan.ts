// The scan pipeline (§4): fetch -> graph -> stitch -> score -> dedup -> top N.
// Pure TypeScript with an injected fetcher, so the same code runs in the
// browser Web Worker and in the Node verification script.

import type { LonLat } from "./geo";
import { buildGraph } from "./graph";
import {
  BUILDING_CAP,
  buildingCountQuery,
  buildingsQuery,
  contextQuery,
  parseBuildingCount,
  parseBuildings,
  parseContext,
  parseRoads,
  roadsQuery,
  type Fetcher,
} from "./overpass";
import { combineScore, PRESETS } from "./presets";
import { buildScoringContext, scoreRoute, type RouteResult } from "./score";
import { stitchRoutes, type SurfaceChoice } from "./stitch";

export const MAX_RADIUS_M = 40_000;
// Returning more than 10 distinct roads gives client-side re-ranking room to
// promote different roads under different slider weights without a re-scan.
const RETURN_COUNT = 25;
const OVERLAP_DUP_FRAC = 0.5;

export type ScanStage = "roads" | "context" | "graph" | "stitch" | "score" | "done";

export interface ScanProgress {
  stage: ScanStage;
  detail: string;
  /** 0..1 within the whole scan (coarse, honest). */
  pct: number;
}

export interface ScanOptions {
  center: LonLat;
  radiusM: number;
  surface: SurfaceChoice;
  fetcher: Fetcher;
  onProgress?: (p: ScanProgress) => void;
}

export type PublicRoute = Omit<RouteResult, "edgeIds">;

export interface ScanResult {
  routes: PublicRoute[];
  warnings: string[];
  center: LonLat;
  radiusM: number;
}

export async function scan(opts: ScanOptions): Promise<ScanResult> {
  const { center, surface, fetcher, onProgress } = opts;
  const radiusM = Math.min(opts.radiusM, MAX_RADIUS_M);
  const warnings: string[] = [];
  const report = (stage: ScanStage, detail: string, pct: number) => onProgress?.({ stage, detail, pct });

  report("roads", "Fetching the road network…", 0.02);
  const roadsResp = await fetcher(roadsQuery(center, radiusM));
  const roads = parseRoads(roadsResp);
  if (roads.ways.length === 0) {
    throw new Error("No roads found in this area. Try a different location or a larger radius.");
  }

  report("context", "Checking area density…", 0.25);
  const buildingCount = parseBuildingCount(await fetcher(buildingCountQuery(center, radiusM)));
  let trimmed = buildingCount > BUILDING_CAP;
  if (trimmed) {
    warnings.push(
      `Dense area (${Math.round(buildingCount / 1000)}k buildings) — home exposure estimated from residential zones only.`
    );
  }

  report("context", "Fetching driveways, stops & residential zones…", 0.3);
  const ctxResp = await fetcher(contextQuery(center, radiusM));

  let buildings: LonLat[] = [];
  if (!trimmed) {
    report("context", `Fetching ${buildingCount.toLocaleString()} buildings…`, 0.38);
    try {
      buildings = parseBuildings(await fetcher(buildingsQuery(center, radiusM)));
    } catch {
      // Degrade rather than fail: score homes from residential zones only.
      trimmed = true;
      warnings.push("Building data unavailable right now — home exposure estimated from residential zones only.");
    }
  }
  const ctx = parseContext(ctxResp, buildings, trimmed);

  report("graph", `Building road graph (${roads.ways.length.toLocaleString()} ways)…`, 0.55);
  const graph = buildGraph(roads, center);

  report("stitch", "Stitching roads…", 0.62);
  const stitched = stitchRoutes(graph, surface, radiusM, (done, total) =>
    report("stitch", `Stitching roads… ${done}/${total} seeds`, 0.62 + 0.18 * (done / Math.max(total, 1)))
  );
  if (stitched.length === 0) {
    throw new Error("No suitable roads found. Try a larger radius or a different surface setting.");
  }

  report("score", `Scoring ${stitched.length} candidate roads…`, 0.82);
  const sc = buildScoringContext(graph, ctx);
  const scored = stitched.map((r, i) => scoreRoute(r, sc, i));

  // Order by the default preset for de-duplication (keep the better twin);
  // final ordering is the client's job under its live weights.
  const weights = PRESETS.Balanced;
  scored.sort((a, b) => combineScore(b.sub, weights) - combineScore(a.sub, weights));

  report("score", "De-duplicating…", 0.95);
  const kept: RouteResult[] = [];
  const edgeLen = new Map<number, number>();
  for (const e of graph.edges) edgeLen.set(e.id, e.lengthM);
  for (const r of scored) {
    let dup = false;
    for (const k of kept) {
      // Same name inside one search radius = the same road to a driver, even
      // when offset intersections keep greedy stitching from joining the
      // fragments. Geometric overlap catches renamed/unnamed twins.
      if (!r.name.startsWith("Unnamed") && r.name === k.name) {
        dup = true;
        break;
      }
      let shared = 0;
      for (const id of r.edgeIds) if (k.edgeIds.has(id)) shared += edgeLen.get(id) ?? 0;
      if (shared > OVERLAP_DUP_FRAC * Math.min(r.lengthM, k.lengthM)) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(r);
    if (kept.length >= RETURN_COUNT) break;
  }

  report("done", "Done", 1);
  return {
    routes: kept.map(({ edgeIds: _drop, ...pub }) => pub),
    warnings,
    center,
    radiusM,
  };
}
