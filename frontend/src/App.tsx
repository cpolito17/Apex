import { useEffect, useMemo, useRef, useState } from "react";
import type { LonLat } from "./engine/geo";
import { combineScore, DEFAULT_PRESET, PRESETS, type Weights } from "./engine/presets";
import type { ScanProgress, ScanResult } from "./engine/scan";
import type { SurfaceChoice } from "./engine/stitch";
import MapView from "./ui/MapView";
import ResultsList from "./ui/ResultsList";
import ScoringPanel from "./ui/ScoringPanel";
import SearchPanel from "./ui/SearchPanel";

const API_BASE = `${import.meta.env.BASE_URL}api`;
const TOP_N = 10;
const STORE_KEY = "apex-prefs-v1";

interface Prefs {
  weights: Weights;
  preset: string | null;
  surface: SurfaceChoice;
  radiusKm: number;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as Prefs;
  } catch {
    /* fall through to defaults */
  }
  return { weights: { ...PRESETS[DEFAULT_PRESET] }, preset: DEFAULT_PRESET, surface: "paved", radiusKm: 24 };
}

type ScanState =
  | { kind: "idle" }
  | { kind: "loading"; progress: ScanProgress }
  | { kind: "error"; message: string }
  | { kind: "done"; result: ScanResult };

export default function App() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [scanState, setScanState] = useState<ScanState>({ kind: "idle" });
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [fitAllKey, setFitAllKey] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  function startScan(center: LonLat) {
    workerRef.current?.terminate();
    const worker = new Worker(new URL("./scan.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    setHoveredId(null);
    setScanState({ kind: "loading", progress: { stage: "roads", detail: "Starting scan…", pct: 0 } });
    worker.onmessage = (e) => {
      const msg = e.data as
        | ({ type: "progress" } & ScanProgress)
        | { type: "done"; result: ScanResult }
        | { type: "error"; message: string };
      if (msg.type === "progress") {
        setScanState({ kind: "loading", progress: msg });
      } else if (msg.type === "done") {
        setScanState({ kind: "done", result: msg.result });
        setFitAllKey((k) => k + 1);
        if (window.matchMedia("(max-width: 720px)").matches) setCollapsed(false);
      } else {
        setScanState({ kind: "error", message: msg.message });
      }
    };
    worker.postMessage({ center, radiusM: prefs.radiusKm * 1000, surface: prefs.surface, apiBase: API_BASE });
  }

  // Scan-once, re-rank-instantly: slider moves only re-run this memo (§3).
  const ranked = useMemo(() => {
    if (scanState.kind !== "done") return [];
    return scanState.result.routes
      .map((route) => ({ route, score: combineScore(route.sub, prefs.weights) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_N);
  }, [scanState, prefs.weights]);

  const busy = scanState.kind === "loading";

  return (
    <div className="app">
      <a className="portfolio-link" href="https://charliepolito.com/" aria-label="Back to CharliePolito.com portfolio">
        <img src={`${import.meta.env.BASE_URL}charlie-monogram.svg`} alt="" width="24" height="24" />
        <span>CharliePolito.com</span>
      </a>
      <MapView routes={ranked.map((r) => r.route)} hoveredId={hoveredId} fitAllKey={fitAllKey} />

      <div className={`panel${collapsed ? " collapsed" : ""}`}>
        <div className="sheet-handle" onClick={() => setCollapsed((c) => !c)} />
        <div className="brand" onClick={() => setCollapsed((c) => !c)}>
          <h1>Apex</h1>
          <span>find the roads worth driving</span>
        </div>

        <div className="panel-scroll">
          <SearchPanel
            radiusKm={prefs.radiusKm}
            surface={prefs.surface}
            busy={busy}
            onRadius={(radiusKm) => setPrefs((p) => ({ ...p, radiusKm }))}
            onSurface={(surface) => setPrefs((p) => ({ ...p, surface }))}
            onSearch={(center) => {
              startScan(center);
              if (window.matchMedia("(max-width: 720px)").matches) setCollapsed(true);
            }}
          />

          {busy && scanState.kind === "loading" && (
            <div className="section">
              <div className="progress">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${scanState.progress.pct * 100}%` }} />
                </div>
                <div className="progress-label">
                  <span>{scanState.progress.detail}</span>
                  <span>{Math.round(scanState.progress.pct * 100)}%</span>
                </div>
              </div>
            </div>
          )}
          {scanState.kind === "error" && (
            <div className="section">
              <div className="error-note">{scanState.message}</div>
            </div>
          )}
          {scanState.kind === "done" && scanState.result.warnings.length > 0 && (
            <div className="section">
              {scanState.result.warnings.map((w) => (
                <div key={w} className="warn-note" style={{ marginTop: 0 }}>
                  {w}
                </div>
              ))}
            </div>
          )}

          <ScoringPanel
            weights={prefs.weights}
            preset={prefs.preset}
            onChange={(weights, preset) => setPrefs((p) => ({ ...p, weights, preset }))}
          />

          {scanState.kind === "done" ? (
            <ResultsList routes={ranked} hoveredId={hoveredId} onHover={setHoveredId} />
          ) : (
            <div className="empty-note">
              Enter a location and hit <b>Find roads</b>. Apex scans every road in the radius, scores each on
              how fun <i>and</i> how appropriate it is to drive, and maps the top {TOP_N} — colored blue on the
              straights, purple through the corners.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
