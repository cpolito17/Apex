// Road graph construction. OSM ways are split at shared (junction) nodes into
// edges; each edge gets its geometry, length, surface classification, and
// curvature (circumcircle-radius method) computed once up front.

import { circumradius, haversineM, Projection, type LonLat, type XY } from "./geo";
import type { RoadsData } from "./overpass";

export type SurfaceKind = "paved" | "gravel" | "unknown";

export interface Edge {
  id: number;
  wayId: number;
  tags: Record<string, string>;
  hwy: string;
  nodeIds: number[];
  coords: LonLat[];
  xy: XY[];
  segLens: number[]; // per segment, meters (coords.length - 1)
  lengthM: number;
  a: number; // start node id
  b: number; // end node id
  surface: SurfaceKind;
  surfaceCertain: boolean;
  candidate: boolean; // eligible to be part of a stitched route
  arterial: boolean; // motorway/trunk/primary/secondary incl. links
  curvature: number; // weighted cornering meters (Franco-style buckets)
  curvDensity: number; // weighted cornering meters per km
}

export interface RoadGraph {
  edges: Edge[];
  adjacency: Map<number, Edge[]>; // node id -> incident edges
  /** Junction degree per node, counting distinct incident edges of drivable ways. */
  junctionDegree: Map<number, number>;
  projection: Projection;
}

const CANDIDATE_CLASSES = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "track",
]);
const ARTERIAL_CLASSES = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
]);

const PAVED_SURFACES = new Set([
  "paved",
  "asphalt",
  "concrete",
  "concrete:plates",
  "concrete:lanes",
  "paving_stones",
  "chipseal",
  "sett",
  "cobblestone",
  "metal",
  "wood",
]);
const GRAVEL_SURFACES = new Set([
  "unpaved",
  "gravel",
  "dirt",
  "ground",
  "earth",
  "fine_gravel",
  "compacted",
  "sand",
  "grass",
  "pebblestone",
  "mud",
  "rock",
]);

/** §4 surface fallback: explicit tag wins; untagged major classes are assumed
 * paved; untagged minor classes (track) lean unpaved and are flagged uncertain. */
export function classifySurface(tags: Record<string, string>): { surface: SurfaceKind; certain: boolean } {
  const s = tags.surface?.toLowerCase();
  if (s) {
    if (GRAVEL_SURFACES.has(s)) return { surface: "gravel", certain: true };
    if (PAVED_SURFACES.has(s)) return { surface: "paved", certain: true };
  }
  if (tags.tracktype && tags.tracktype !== "grade1") return { surface: "gravel", certain: false };
  if (tags.highway === "track") return { surface: "gravel", certain: false };
  return { surface: "paved", certain: false };
}

function accessBlocked(tags: Record<string, string>): boolean {
  const access = tags.access;
  const motor = tags.motor_vehicle ?? tags.motorcar;
  if (motor === "no" || motor === "private") return true;
  if ((access === "no" || access === "private") && motor !== "yes") return true;
  return false;
}

/** Curvature weight buckets from the circumcircle-radius method: tighter
 * corners weight the cornering length more heavily; radii above 175 m are
 * treated as not-cornering. */
export function curvatureWeight(radius: number): number {
  // Sub-8 m radii are cul-de-sac bulbs, parking geometry, or mapping noise —
  // not corners a road carries at speed.
  if (radius < 8) return 0;
  if (radius < 30) return 2.0;
  if (radius < 60) return 1.6;
  if (radius < 100) return 1.3;
  if (radius < 175) return 1.0;
  return 0;
}

/** Per-point corner radii for a projected polyline (endpoints -> Infinity). */
export function pointRadii(xy: XY[], segLens: number[]): number[] {
  const radii = new Array<number>(xy.length).fill(Infinity);
  for (let i = 1; i < xy.length - 1; i++) {
    // Sub-3m segments are GPS/drawing noise; circumradius on them is garbage.
    if (segLens[i - 1] < 3 && segLens[i] < 3) continue;
    radii[i] = circumradius(xy[i - 1], xy[i], xy[i + 1]);
  }
  return radii;
}

/** Weighted cornering meters for a polyline given its per-point radii. */
export function weightedCornering(radii: number[], segLens: number[]): number {
  let total = 0;
  for (let i = 1; i < radii.length - 1; i++) {
    const w = curvatureWeight(radii[i]);
    if (w > 0) total += (w * (segLens[i - 1] + segLens[i])) / 2;
  }
  return total;
}

export function buildGraph(roads: RoadsData, center: LonLat): RoadGraph {
  const projection = new Projection(center);

  // A node is a split point if it belongs to more than one drivable way (or
  // appears twice in one) — those are the junctions stitching can cross.
  const usage = new Map<number, number>();
  const usable = roads.ways.filter((w) => !accessBlocked(w.tags) && w.tags.area !== "yes");
  for (const way of usable) {
    for (const n of way.nodeIds) usage.set(n, (usage.get(n) ?? 0) + 1);
  }

  const edges: Edge[] = [];
  let nextId = 0;
  for (const way of usable) {
    const { surface, certain } = classifySurface(way.tags);
    const hwy = way.tags.highway;
    const candidate = CANDIDATE_CLASSES.has(hwy);
    const arterial = ARTERIAL_CLASSES.has(hwy);

    let start = 0;
    for (let i = 1; i < way.nodeIds.length; i++) {
      const isSplit = i === way.nodeIds.length - 1 || (usage.get(way.nodeIds[i]) ?? 0) > 1;
      if (!isSplit) continue;
      const nodeIds = way.nodeIds.slice(start, i + 1);
      const coords: LonLat[] = [];
      for (const n of nodeIds) {
        const c = roads.nodeCoords.get(n);
        if (c) coords.push(c);
      }
      start = i;
      if (coords.length < 2) continue;

      const xy = coords.map((c) => projection.toXY(c));
      const segLens: number[] = [];
      let lengthM = 0;
      for (let j = 1; j < coords.length; j++) {
        const d = haversineM(coords[j - 1], coords[j]);
        segLens.push(d);
        lengthM += d;
      }
      if (lengthM < 1) continue;

      const radii = pointRadii(xy, segLens);
      const curvature = weightedCornering(radii, segLens);
      edges.push({
        id: nextId++,
        wayId: way.id,
        tags: way.tags,
        hwy,
        nodeIds,
        coords,
        xy,
        segLens,
        lengthM,
        a: nodeIds[0],
        b: nodeIds[nodeIds.length - 1],
        surface,
        surfaceCertain: certain,
        candidate,
        arterial,
        curvature,
        curvDensity: curvature / (lengthM / 1000),
      });
    }
  }

  const adjacency = new Map<number, Edge[]>();
  const junctionDegree = new Map<number, number>();
  for (const e of edges) {
    for (const n of [e.a, e.b]) {
      let arr = adjacency.get(n);
      if (!arr) {
        arr = [];
        adjacency.set(n, arr);
      }
      arr.push(e);
      junctionDegree.set(n, (junctionDegree.get(n) ?? 0) + 1);
    }
  }

  return { edges, adjacency, junctionDegree, projection };
}
