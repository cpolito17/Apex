// Component sub-scores per stitched route (§5). Each raw signal is normalized
// to 0..1 with soft saturating curves (x / (x + k)) so slider weights mean
// something across signals with different units. Raw values are kept for the
// results display.

import { GridIndex, pointInPolygon, type LonLat, type XY } from "./geo";
import type { Edge, RoadGraph, SurfaceKind } from "./graph";
import { pointRadii, weightedCornering } from "./graph";
import type { ContextData } from "./overpass";
import type { SubScores } from "./presets";
import { routeCoords, routeNodeIds, type StitchedRoute } from "./stitch";

export interface RouteResult {
  id: number;
  name: string;
  lengthM: number;
  hwyClass: string;
  surface: SurfaceKind;
  surfaceCertain: boolean;
  speedLimitMph: number;
  speedIsEstimate: boolean;
  laneCount: number;
  coords: LonLat[];
  /** Per-point corner radius (m), aligned with coords; Infinity encoded as -1. */
  radii: number[];
  startCoord: LonLat;
  sub: SubScores;
  raw: {
    twistPerKm: number;
    buildingsPerKm: number;
    residentialFrac: number;
    drivewaysPerKm: number;
    stopsPerKm: number;
    arterialDistM: number;
  };
  /** Internal: for de-duplication. */
  edgeIds: Set<number>;
}

export interface ScoringContext {
  buildingGrid: GridIndex<1>;
  residentialPolys: Array<{ xy: XY[]; bbox: [number, number, number, number] }>;
  arterialGrid: GridIndex<number>; // item = wayId, so a route can ignore itself
  ctx: ContextData;
  graph: RoadGraph;
}

const SAMPLE_STEP_M = 60;
const HOME_BUFFER_M = 120;
const ARTERIAL_SEARCH_M = 2000;

export function buildScoringContext(graph: RoadGraph, ctx: ContextData): ScoringContext {
  const buildingGrid = new GridIndex<1>(200);
  for (const b of ctx.buildings) buildingGrid.insert(graph.projection.toXY(b), 1);

  const residentialPolys = ctx.residentialPolys.map((poly) => {
    const xy = poly.map((p) => graph.projection.toXY(p));
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const [x, y] of xy) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { xy, bbox: [minX, minY, maxX, maxY] as [number, number, number, number] };
  });

  // Arterial vertices at ~100 m spacing, tagged with wayId so a route made of
  // an arterial isn't "near traffic" merely by being near itself.
  const arterialGrid = new GridIndex<number>(500);
  for (const e of graph.edges) {
    if (!e.arterial) continue;
    let acc = 0;
    arterialGrid.insert(e.xy[0], e.wayId);
    for (let i = 1; i < e.xy.length; i++) {
      acc += e.segLens[i - 1];
      if (acc >= 100) {
        arterialGrid.insert(e.xy[i], e.wayId);
        acc = 0;
      }
    }
  }

  return { buildingGrid, residentialPolys, arterialGrid, ctx, graph };
}

/** Points every ~SAMPLE_STEP_M along the polyline. */
function samplePoints(xy: XY[], segLens: number[]): XY[] {
  const out: XY[] = [xy[0]];
  let acc = 0;
  for (let i = 1; i < xy.length; i++) {
    acc += segLens[i - 1];
    if (acc >= SAMPLE_STEP_M) {
      out.push(xy[i]);
      acc = 0;
    }
  }
  return out;
}

function saturate(x: number, k: number): number {
  return x / (x + k);
}

const SPEED_BY_CLASS: Record<string, number> = {
  motorway: 70,
  trunk: 65,
  primary: 55,
  secondary: 50,
  tertiary: 45,
  unclassified: 40,
  residential: 25,
  track: 15,
};
const LANES_BY_CLASS: Record<string, number> = {
  motorway: 4,
  trunk: 3,
  primary: 2.5,
  secondary: 2,
  tertiary: 2,
  unclassified: 2,
  residential: 2,
  track: 1,
};

function parseMaxspeedMph(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return v.includes("mph") ? n : Math.round(n * 0.621371);
}

/** Length-weighted dominant value across route edges. */
function dominant<T>(parts: StitchedRoute["parts"], pick: (e: Edge) => T | null): T | null {
  const weights = new Map<T, number>();
  for (const { edge } of parts) {
    const v = pick(edge);
    if (v === null) continue;
    weights.set(v, (weights.get(v) ?? 0) + edge.lengthM);
  }
  let best: T | null = null;
  let bestW = 0;
  for (const [v, w] of weights) {
    if (w > bestW) {
      best = v;
      bestW = w;
    }
  }
  return best;
}

export function scoreRoute(route: StitchedRoute, sc: ScoringContext, id: number): RouteResult {
  const { coords, lonlat, segLens } = routeCoords(route);
  const nodeIds = routeNodeIds(route);
  const lengthKm = route.lengthM / 1000;

  // Twistiness: recomputed over the joined polyline so corners spanning edge
  // seams (i.e. at junctions the route carries through) count too.
  const radii = pointRadii(coords, segLens);
  const twist = weightedCornering(radii, segLens);
  const twistPerKm = twist / lengthKm;

  const samples = samplePoints(coords, segLens);

  // Homes: building density in a buffer + fraction of route through
  // residential landuse + fraction on residential-class roads.
  let buildingCount = 0;
  let residSamples = 0;
  for (const p of samples) {
    buildingCount += sc.buildingGrid.countNear(p, HOME_BUFFER_M);
    for (const poly of sc.residentialPolys) {
      const [minX, minY, maxX, maxY] = poly.bbox;
      if (p[0] < minX || p[0] > maxX || p[1] < minY || p[1] > maxY) continue;
      if (pointInPolygon(p, poly.xy)) {
        residSamples++;
        break;
      }
    }
  }
  const buildingsPerKm = buildingCount / lengthKm;
  const residentialFrac = residSamples / samples.length;
  const residClassFrac =
    route.parts.reduce((s, p) => s + (p.edge.hwy === "residential" ? p.edge.lengthM : 0), 0) / route.lengthM;
  // Residential road class carries substantial weight: in areas where OSM
  // lacks building footprints and landuse polygons (much of rural US), it is
  // the only reliable "people live here" signal.
  const bTerm = saturate(buildingsPerKm, 40);
  const exposure = sc.ctx.buildingsTrimmed
    ? residentialFrac * 0.5 + residClassFrac * 0.5
    : bTerm * 0.4 + residentialFrac * 0.25 + residClassFrac * 0.35;

  // Driveways: distinct driveway ways sharing a node with the route.
  const drivewayIds = new Set<number>();
  for (const n of nodeIds) {
    const ids = sc.ctx.drivewaysByNode.get(n);
    if (ids) for (const d of ids) drivewayIds.add(d);
  }
  const drivewaysPerKm = drivewayIds.size / lengthKm;

  // Stops & junctions: traffic controls on route nodes plus 3+-way junctions.
  let controlScore = 0;
  let junctions = 0;
  for (const n of nodeIds) {
    const kind = sc.ctx.controlNodes.get(n);
    if (kind === "traffic_signals") controlScore += 2;
    else if (kind === "stop") controlScore += 1.5;
    else if (kind === "give_way") controlScore += 0.75;
    if ((sc.graph.junctionDegree.get(n) ?? 0) >= 3) junctions++;
  }
  const stopsPerKm = (controlScore + junctions * 0.4) / lengthKm;

  // Isolation (traffic proxy): mean distance to the nearest arterial that
  // isn't part of this route's own ways.
  const ownWays = new Set(route.parts.map((p) => p.edge.wayId));
  let distSum = 0;
  for (const p of samples) {
    let nearest = ARTERIAL_SEARCH_M;
    sc.arterialGrid.forEachNear(p, ARTERIAL_SEARCH_M, (wayId, q) => {
      if (ownWays.has(wayId)) return;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < nearest) nearest = d;
    });
    distSum += nearest;
  }
  const arterialDistM = distSum / samples.length;

  // Lanes.
  const laneTag = dominant(route.parts, (e) => {
    const n = parseInt(e.tags.lanes ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  const hwyClass = dominant(route.parts, (e) => e.hwy) ?? "unclassified";
  const laneCount = laneTag ?? LANES_BY_CLASS[hwyClass] ?? 2;

  // Speed limit: real tag where present, else class-inferred (marked approx).
  const taggedSpeed = dominant(route.parts, (e) => parseMaxspeedMph(e.tags.maxspeed));
  const speedLimitMph = taggedSpeed ?? SPEED_BY_CLASS[hwyClass] ?? 40;

  // Surface + name.
  const surface = dominant(route.parts, (e) => e.surface) ?? "unknown";
  const uncertainLen = route.parts.reduce((s, p) => s + (p.edge.surfaceCertain ? 0 : p.edge.lengthM), 0);
  const surfaceCertain = uncertainLen < route.lengthM * 0.3;
  const name =
    dominant(route.parts, (e) => e.tags.name ?? null) ??
    dominant(route.parts, (e) => e.tags.ref ?? null) ??
    `Unnamed ${hwyClass} road`;

  const sub: SubScores = {
    twist: saturate(twistPerKm, 120),
    length: 1 - Math.exp(-lengthKm / 10),
    homes: 1 - exposure,
    driveways: 1 - saturate(drivewaysPerKm, 6),
    stops: 1 - saturate(stopsPerKm, 4),
    isolation: arterialDistM / ARTERIAL_SEARCH_M,
    fewLanes: Math.max(0, Math.min(1, (4.5 - laneCount) / 2.5)),
  };

  return {
    id,
    name,
    lengthM: route.lengthM,
    hwyClass,
    surface,
    surfaceCertain,
    speedLimitMph,
    speedIsEstimate: taggedSpeed === null,
    laneCount,
    coords: lonlat,
    radii: radii.map((r) => (Number.isFinite(r) ? Math.round(r) : -1)),
    startCoord: lonlat[0],
    sub,
    raw: {
      twistPerKm: Math.round(twistPerKm),
      buildingsPerKm: Math.round(buildingsPerKm * 10) / 10,
      residentialFrac: Math.round(residentialFrac * 100) / 100,
      drivewaysPerKm: Math.round(drivewaysPerKm * 10) / 10,
      stopsPerKm: Math.round(stopsPerKm * 10) / 10,
      arterialDistM: Math.round(arterialDistM),
    },
    edgeIds: route.edgeIds,
  };
}
