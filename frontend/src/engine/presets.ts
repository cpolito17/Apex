// Component weights and presets. Weights are 0–100 except lanes, which is
// bipolar (-100..100): positive favors fewer lanes (rural two-lane), negative
// favors more (highway presets). Re-ranking with these is pure client math —
// the scan never reruns when a slider moves.

export interface SubScores {
  twist: number; // distance spent genuinely cornering (density), higher = twistier
  length: number; // longer sustained road, diminishing returns
  homes: number; // higher = LESS residential/pedestrian exposure
  driveways: number; // higher = fewer driveways per km
  stops: number; // higher = fewer stops/signals/junctions per km
  isolation: number; // higher = further from arterials (traffic proxy)
  fewLanes: number; // higher = fewer lanes
}

export type ComponentKey = keyof SubScores;

export type Weights = Record<ComponentKey, number>;

export const COMPONENT_LABELS: Record<ComponentKey, string> = {
  twist: "Twistiness",
  length: "Length",
  homes: "Away from homes",
  driveways: "Few driveways",
  stops: "Few stops",
  isolation: "Isolation",
  fewLanes: "Lanes",
};

export const PRESETS: Record<string, Weights> = {
  // §2: fun and appropriateness are equal partners — the default reflects it.
  Balanced: { twist: 80, length: 50, homes: 80, driveways: 55, stops: 55, isolation: 45, fewLanes: 30 },
  "Slow Twisty": { twist: 100, length: 40, homes: 85, driveways: 70, stops: 65, isolation: 50, fewLanes: 60 },
  "Fast Highway": { twist: 30, length: 85, homes: 55, driveways: 50, stops: 80, isolation: 35, fewLanes: -50 },
  "Gravel Rally": { twist: 85, length: 60, homes: 70, driveways: 40, stops: 40, isolation: 65, fewLanes: 55 },
};

export const DEFAULT_PRESET = "Balanced";

/** Weighted combination of normalized sub-scores -> 0..100 display score.
 * A negative lanes weight scores against the fewLanes signal. */
export function combineScore(sub: SubScores, weights: Weights): number {
  let total = 0;
  let wsum = 0;
  for (const key of Object.keys(sub) as ComponentKey[]) {
    const w = weights[key];
    if (w === 0) continue;
    const s = w >= 0 ? sub[key] : 1 - sub[key];
    total += Math.abs(w) * s;
    wsum += Math.abs(w);
  }
  return wsum === 0 ? 0 : (total / wsum) * 100;
}
