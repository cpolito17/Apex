// Overpass query construction and response parsing. Queries round the center
// coordinate so near-repeat searches map to the same proxy cache key.

import type { LonLat } from "./geo";

export type Fetcher = (query: string) => Promise<OverpassResponse>;

export interface OverpassResponse {
  elements: OverpassElement[];
  remark?: string;
}

export interface OverpassElement {
  type: "node" | "way" | "relation" | "count";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  nodes?: number[];
  center?: { lat: number; lon: number };
  geometry?: Array<{ lat: number; lon: number }>;
  count?: string;
}

/** Road classes fetched. Candidates for routes are a subset (see graph.ts). */
export const ROAD_CLASS_RE =
  "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|track|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$";

/** Above this many buildings we skip the building fetch and lean on landuse. */
export const BUILDING_CAP = 250_000;

function roundCoord(v: number): number {
  return Math.round(v * 1000) / 1000; // ~110 m — harmless for a km-scale scan
}

function around(center: LonLat, radiusM: number): string {
  return `(around:${Math.round(radiusM)},${roundCoord(center[1])},${roundCoord(center[0])})`;
}

export function roadsQuery(center: LonLat, radiusM: number): string {
  return `[out:json][timeout:150];
way[highway~"${ROAD_CLASS_RE}"]${around(center, radiusM)};
out body qt;
>;
out skel qt;`;
}

export function buildingCountQuery(center: LonLat, radiusM: number): string {
  return `[out:json][timeout:60];
way[building]${around(center, radiusM + 200)};
out count;`;
}

/** Stops, driveways, landuse — light. Buildings ship separately (heavy) so an
 * Overpass timeout on them degrades the homes signal instead of the scan. */
export function contextQuery(center: LonLat, radiusM: number): string {
  const a = around(center, radiusM + 200);
  return `[out:json][timeout:120];
node[highway~"^(stop|give_way|traffic_signals)$"]${a};
out body qt;
way[highway=service][service=driveway]${a};
out skel qt;
way[landuse=residential]${a};
out geom qt;`;
}

export function buildingsQuery(center: LonLat, radiusM: number): string {
  return `[out:json][timeout:150];
way[building]${around(center, radiusM + 200)};
out ids center qt;`;
}

// ---- Parsed shapes ---------------------------------------------------------

export interface RoadsData {
  ways: Array<{ id: number; tags: Record<string, string>; nodeIds: number[] }>;
  nodeCoords: Map<number, LonLat>;
}

export interface ContextData {
  /** Traffic-control nodes (stop / give_way / traffic_signals) by node id. */
  controlNodes: Map<number, "stop" | "give_way" | "traffic_signals">;
  /** Node id -> driveway way ids touching it (driveways join roads at shared nodes). */
  drivewaysByNode: Map<number, number[]>;
  /** Building centroids. */
  buildings: LonLat[];
  /** Residential landuse polygons (outer rings; relations skipped in v1). */
  residentialPolys: LonLat[][];
  buildingsTrimmed: boolean;
}

export function parseRoads(resp: OverpassResponse): RoadsData {
  const ways: RoadsData["ways"] = [];
  const nodeCoords = new Map<number, LonLat>();
  for (const el of resp.elements) {
    if (el.type === "way" && el.tags?.highway && el.nodes && el.nodes.length >= 2) {
      ways.push({ id: el.id, tags: el.tags, nodeIds: el.nodes });
    } else if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) {
      nodeCoords.set(el.id, [el.lon, el.lat]);
    }
  }
  return { ways, nodeCoords };
}

export function parseBuildingCount(resp: OverpassResponse): number {
  for (const el of resp.elements) {
    if (el.type === "count") return Number((el.tags as Record<string, string>)?.ways ?? el.count ?? 0);
  }
  return 0;
}

export function parseBuildings(resp: OverpassResponse): LonLat[] {
  const out: LonLat[] = [];
  for (const el of resp.elements) {
    if (el.type === "way" && el.center) out.push([el.center.lon, el.center.lat]);
  }
  return out;
}

export function parseContext(resp: OverpassResponse, buildings: LonLat[], buildingsTrimmed: boolean): ContextData {
  const controlNodes = new Map<number, "stop" | "give_way" | "traffic_signals">();
  const drivewaysByNode = new Map<number, number[]>();
  const residentialPolys: LonLat[][] = [];

  for (const el of resp.elements) {
    if (el.type === "node" && el.tags?.highway) {
      const kind = el.tags.highway;
      if (kind === "stop" || kind === "give_way" || kind === "traffic_signals") {
        controlNodes.set(el.id, kind);
      }
    } else if (el.type === "way" && el.geometry && el.tags?.landuse === "residential") {
      residentialPolys.push(el.geometry.map((g) => [g.lon, g.lat] as LonLat));
    } else if (el.type === "way" && el.nodes) {
      // Driveway (skel output: id + node refs, no tags).
      for (const n of el.nodes) {
        let arr = drivewaysByNode.get(n);
        if (!arr) {
          arr = [];
          drivewaysByNode.set(n, arr);
        }
        arr.push(el.id);
      }
    }
  }
  return { controlNodes, drivewaysByNode, buildings, residentialPolys, buildingsTrimmed };
}
