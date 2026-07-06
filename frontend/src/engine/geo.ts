// Geometry primitives. Everything works in a local equirectangular projection
// (meters, centered on the search point) — accurate to well under 1% at the
// 40 km radius cap, and much cheaper than proper geodesics for the volume of
// point math the scan does.

export type LonLat = [number, number]; // [lon, lat] — GeoJSON order
export type XY = [number, number]; // local meters

const EARTH_R = 6371000;
const DEG = Math.PI / 180;

export function haversineM(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

/** Local flat projection centered on `origin`. */
export class Projection {
  private cosLat: number;
  constructor(private origin: LonLat) {
    this.cosLat = Math.cos(origin[1] * DEG);
  }
  toXY(p: LonLat): XY {
    return [
      (p[0] - this.origin[0]) * DEG * EARTH_R * this.cosLat,
      (p[1] - this.origin[1]) * DEG * EARTH_R,
    ];
  }
}

export function dist(a: XY, b: XY): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * Circumcircle radius through three points (meters). This is the corner
 * radius approximation from the circumcircle-radius method: r = abc / 4A.
 * Collinear (or near-collinear) points return Infinity — a straight.
 */
export function circumradius(p1: XY, p2: XY, p3: XY): number {
  const a = dist(p2, p3);
  const b = dist(p1, p3);
  const c = dist(p1, p2);
  const area2 = Math.abs(
    (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p3[0] - p1[0]) * (p2[1] - p1[1])
  );
  if (area2 < 1e-6) return Infinity;
  return (a * b * c) / (2 * area2);
}

/** Bearing of the vector a->b, radians. */
export function bearing(a: XY, b: XY): number {
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

/** Absolute angular difference, radians, in [0, PI]. */
export function angleDiff(t1: number, t2: number): number {
  let d = Math.abs(t1 - t2) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

/** Ray-casting point-in-polygon on projected coordinates. */
export function pointInPolygon(p: XY, poly: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Uniform grid over projected points for radius queries. The scan does tens of
 * thousands of "what's near this sample point" lookups; this keeps them O(1).
 */
export class GridIndex<T> {
  private cells = new Map<string, Array<{ p: XY; item: T }>>();
  constructor(private cellSize: number) {}

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  insert(p: XY, item: T): void {
    const cx = Math.floor(p[0] / this.cellSize);
    const cy = Math.floor(p[1] / this.cellSize);
    const k = this.key(cx, cy);
    let arr = this.cells.get(k);
    if (!arr) {
      arr = [];
      this.cells.set(k, arr);
    }
    arr.push({ p, item });
  }

  /** All items within `radius` of `p`. */
  query(p: XY, radius: number): T[] {
    const out: T[] = [];
    this.forEachNear(p, radius, (item) => out.push(item));
    return out;
  }

  countNear(p: XY, radius: number): number {
    let n = 0;
    this.forEachNear(p, radius, () => n++);
    return n;
  }

  forEachNear(p: XY, radius: number, fn: (item: T, q: XY) => void): void {
    const r2 = radius * radius;
    const minX = Math.floor((p[0] - radius) / this.cellSize);
    const maxX = Math.floor((p[0] + radius) / this.cellSize);
    const minY = Math.floor((p[1] - radius) / this.cellSize);
    const maxY = Math.floor((p[1] + radius) / this.cellSize);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const arr = this.cells.get(this.key(cx, cy));
        if (!arr) continue;
        for (const e of arr) {
          const dx = e.p[0] - p[0];
          const dy = e.p[1] - p[1];
          if (dx * dx + dy * dy <= r2) fn(e.item, e.p);
        }
      }
    }
  }
}
