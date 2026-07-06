// Web Worker wrapper around the scan engine: keeps the CPU-bound geometry and
// graph work off the UI thread and streams honest progress back.

import type { LonLat } from "./engine/geo";
import type { Fetcher } from "./engine/overpass";
import { scan } from "./engine/scan";
import type { SurfaceChoice } from "./engine/stitch";

export interface ScanRequest {
  center: LonLat;
  radiusM: number;
  surface: SurfaceChoice;
  apiBase: string;
}

self.onmessage = async (e: MessageEvent<ScanRequest>) => {
  const { center, radiusM, surface, apiBase } = e.data;

  const fetcher: Fetcher = async (query) => {
    let lastDetail: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 5000));
      const resp = await fetch(`${apiBase}/overpass`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      }).catch(() => null);
      if (resp?.ok) return resp.json();
      lastDetail = resp
        ? await resp
            .json()
            .then((d) => (d as { detail?: string }).detail ?? null)
            .catch(() => null)
        : "Network error reaching the road data service.";
    }
    throw new Error(lastDetail ?? "Road data service error.");
  };

  try {
    const result = await scan({
      center,
      radiusM,
      surface,
      fetcher,
      onProgress: (p) => self.postMessage({ type: "progress", ...p }),
    });
    self.postMessage({ type: "done", result });
  } catch (err) {
    self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
