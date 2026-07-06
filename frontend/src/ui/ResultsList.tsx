// Ranked results (§6.3): rank, name, length, surface, speed limit (marked
// when inferred), standout-quality chips, and Open in Maps.

import type { PublicRoute } from "../engine/scan";
import { describe, fmtMiles, fmtSpeed, fmtSurface } from "../lib/format";
import { mapsLink } from "../lib/mapsLink";

interface Props {
  routes: Array<{ route: PublicRoute; score: number }>;
  hoveredId: number | null;
  onHover: (id: number | null) => void;
}

export default function ResultsList({ routes, hoveredId, onHover }: Props) {
  return (
    <div className="results" onMouseLeave={() => onHover(null)}>
      {routes.map(({ route: r, score }, i) => (
        <div
          key={r.id}
          className={`result${hoveredId === r.id ? " hovered" : ""}`}
          onMouseEnter={() => onHover(r.id)}
        >
          <div className="result-head">
            <span className="rank">{String(i + 1).padStart(2, "0")}</span>
            <span className="result-name" title={r.name}>
              {r.name}
            </span>
            <span className="result-score">{score.toFixed(1)}</span>
          </div>
          <div className="result-meta">
            <span>{fmtMiles(r.lengthM)}</span>
            <span>{fmtSurface(r)}</span>
            <span className={r.speedIsEstimate ? "est" : ""} title={r.speedIsEstimate ? "Estimated from road class" : "Posted limit"}>
              {fmtSpeed(r)}
            </span>
            <span>{r.hwyClass}</span>
          </div>
          <div className="result-tags">
            {describe(r).map((t) => (
              <span key={t.text} className={`tag${t.hot ? " hot" : ""}`}>
                {t.text}
              </span>
            ))}
          </div>
          <div className="result-actions">
            <a className="maps-btn" href={mapsLink(r.startCoord)} target="_blank" rel="noreferrer">
              Open in Maps ↗
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}
