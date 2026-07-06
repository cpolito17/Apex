// Stitching OSM way-fragments into human-perceived roads: greedy bidirectional
// extension from high-quality seeds (§4 of the spec). Two seed families feed
// the pool — curvature seeds (twisty roads) and corridor seeds (long
// arterials) — so both "Slow Twisty" and "Fast Highway" presets have real
// routes to rank without a re-scan.

import { angleDiff, bearing, dist, type XY } from "./geo";
import type { Edge, RoadGraph, SurfaceKind } from "./graph";

export type SurfaceChoice = "paved" | "gravel" | "both";

export interface StitchedRoute {
  /** Ordered, oriented edges. */
  parts: Array<{ edge: Edge; forward: boolean }>;
  edgeIds: Set<number>;
  lengthM: number;
  curvature: number;
}

const MAX_ROUTE_M = 45_000;
const MIN_ROUTE_M = 1_500;
const THROUGH_RAD = (40 * Math.PI) / 180; // "carry roughly straight through"
const MAX_TURN_RAD = (110 * Math.PI) / 180; // hard cap — never u-turn
const CURVE_SEEDS = 140;
const CORRIDOR_SEEDS = 40;

function surfaceAllowed(surface: SurfaceKind, certain: boolean, choice: SurfaceChoice): boolean {
  if (choice === "both") return true;
  if (choice === "paved") return surface === "paved"; // untagged majors are assumed paved
  // gravel: explicit gravel plus unknown-leaning-unpaved (uncertain) edges
  return surface === "gravel" || !certain;
}

function endNode(part: { edge: Edge; forward: boolean }, front: boolean): number {
  // front=false -> the route's tail (last part's far node); front=true -> head.
  return front ? (part.forward ? part.edge.a : part.edge.b) : part.forward ? part.edge.b : part.edge.a;
}

/** Bearing of the route leaving its end, pointing outward. */
function exitBearing(part: { edge: Edge; forward: boolean }, front: boolean): number {
  const xy = part.edge.xy;
  let p1: XY;
  let p2: XY;
  if (front) {
    // Heading outward from the front = reverse of travel direction there.
    [p1, p2] = part.forward ? [xy[1], xy[0]] : [xy[xy.length - 2], xy[xy.length - 1]];
  } else {
    [p1, p2] = part.forward ? [xy[xy.length - 2], xy[xy.length - 1]] : [xy[1], xy[0]];
  }
  return bearing(p1, p2);
}

/** Bearing entering candidate edge from `node`. */
function entryBearing(edge: Edge, node: number): number {
  const xy = edge.xy;
  return edge.a === node ? bearing(xy[0], xy[1]) : bearing(xy[xy.length - 1], xy[xy.length - 2]);
}

function nameKey(e: Edge): string | null {
  return e.tags.name ?? e.tags.ref ?? null;
}

export function stitchRoutes(
  graph: RoadGraph,
  surface: SurfaceChoice,
  radiusM: number,
  onProgress?: (done: number, total: number) => void
): StitchedRoute[] {
  const eligible = (e: Edge) => e.candidate && surfaceAllowed(e.surface, e.surfaceCertain, surface);

  // Seed selection. Curvature seeds: most weighted-cornering first. Corridor
  // seeds: longest arterial fragments, so sweeping highways exist in the pool.
  const pool = graph.edges.filter(eligible);
  const curveSeeds = [...pool]
    .filter((e) => e.curvature > 40)
    .sort((x, y) => y.curvature - x.curvature)
    .slice(0, CURVE_SEEDS);
  const corridorSeeds = [...pool]
    .filter((e) => e.arterial && e.lengthM > 400)
    .sort((x, y) => y.lengthM - x.lengthM)
    .slice(0, CORRIDOR_SEEDS);
  const seeds = [...curveSeeds, ...corridorSeeds];

  const consumed = new Set<number>(); // edges already in an accepted route
  const routes: StitchedRoute[] = [];

  const maxFromCenter = radiusM * 1.2;

  for (let si = 0; si < seeds.length; si++) {
    onProgress?.(si, seeds.length);
    const seed = seeds[si];
    if (consumed.has(seed.id)) continue;

    const parts: StitchedRoute["parts"] = [{ edge: seed, forward: true }];
    const used = new Set<number>([seed.id]);
    let lengthM = seed.lengthM;
    let curvature = seed.curvature;
    const seedDensity = Math.max(seed.curvDensity, 40);

    // Grow each end until no acceptable continuation remains.
    for (const front of [false, true]) {
      for (;;) {
        if (lengthM >= MAX_ROUTE_M) break;
        const tip = front ? parts[0] : parts[parts.length - 1];
        const node = endNode(tip, front);
        const outward = exitBearing(tip, front);
        const routeDensity = curvature / (lengthM / 1000);
        const nameOfRoute = nameKey(tip.edge);

        let best: { edge: Edge; score: number } | null = null;
        for (const cand of graph.adjacency.get(node) ?? []) {
          // Note: edges consumed by earlier routes stay extendable — blocking
          // them fragments long roads; overlap is resolved by de-duplication.
          if (used.has(cand.id) || !eligible(cand)) continue;
          // Stay roughly inside the search radius.
          const farNode = cand.a === node ? cand.xy[cand.xy.length - 1] : cand.xy[0];
          if (dist(farNode, [0, 0]) > maxFromCenter) continue;

          const turn = angleDiff(outward, entryBearing(cand, node));
          if (turn > MAX_TURN_RAD) continue;
          const through = turn < THROUGH_RAD;
          const sameName = nameOfRoute !== null && nameKey(cand) === nameOfRoute;
          const qualityOk = cand.curvDensity >= Math.max(40, 0.4 * seedDensity, 0.35 * routeDensity);
          if (!through && !sameName && !qualityOk) continue;
          // Don't let long straight connectors dilute a twisty route (a
          // straight stretch on an arterial corridor is fine — that's the road).
          if (!cand.arterial && !sameName && !qualityOk && cand.lengthM > 1200 && cand.curvDensity < 25) continue;

          const score =
            Math.min(cand.curvDensity, 400) +
            (through ? 80 : 0) +
            (sameName ? 70 : 0) -
            (turn * 60) / Math.PI;
          if (!best || score > best.score) best = { edge: cand, score };
        }
        if (!best) break;

        const e = best.edge;
        const forward = front ? e.b === node : e.a === node;
        if (front) parts.unshift({ edge: e, forward });
        else parts.push({ edge: e, forward });
        used.add(e.id);
        lengthM += e.lengthM;
        curvature += e.curvature;
      }
    }

    // Trim weak straight tails on non-arterial routes so a twisty road doesn't
    // drag a random straight suburb street along with it.
    const arterialLen = parts.reduce((s, p) => s + (p.edge.arterial ? p.edge.lengthM : 0), 0);
    if (arterialLen < lengthM * 0.5) {
      for (const front of [true, false]) {
        for (;;) {
          if (parts.length <= 1) break;
          const tip = front ? parts[0] : parts[parts.length - 1];
          if (tip.edge.curvDensity >= 25 || tip.edge.lengthM <= 400 || tip.edge.id === seed.id) break;
          if (front) parts.shift();
          else parts.pop();
          lengthM -= tip.edge.lengthM;
          curvature -= tip.edge.curvature;
          used.delete(tip.edge.id);
        }
      }
    }

    if (lengthM < MIN_ROUTE_M) continue;
    for (const id of used) consumed.add(id);
    routes.push({ parts, edgeIds: used, lengthM, curvature });
  }

  return routes;
}

/** Ordered route coordinates (dedupes the shared junction point at each seam). */
export function routeCoords(route: StitchedRoute): { coords: XY[]; lonlat: [number, number][]; segLens: number[] } {
  const lonlat: [number, number][] = [];
  const coords: XY[] = [];
  for (const { edge, forward } of route.parts) {
    const cs = forward ? edge.coords : [...edge.coords].reverse();
    const xs = forward ? edge.xy : [...edge.xy].reverse();
    const start = lonlat.length > 0 ? 1 : 0;
    for (let i = start; i < cs.length; i++) {
      lonlat.push(cs[i]);
      coords.push(xs[i]);
    }
  }
  const segLens: number[] = [];
  for (const { edge, forward } of route.parts) {
    const ls = forward ? edge.segLens : [...edge.segLens].reverse();
    segLens.push(...ls);
  }
  return { coords, lonlat, segLens };
}

/** Ordered node ids along the route (for matching stops/driveways). */
export function routeNodeIds(route: StitchedRoute): number[] {
  const out: number[] = [];
  for (const { edge, forward } of route.parts) {
    const ns = forward ? edge.nodeIds : [...edge.nodeIds].reverse();
    const start = out.length > 0 ? 1 : 0;
    for (let i = start; i < ns.length; i++) out.push(ns[i]);
  }
  return out;
}
