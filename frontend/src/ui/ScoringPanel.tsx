// Scoring sliders + presets (§6.2). Every change re-ranks instantly on the
// client — the scan result already carries per-component sub-scores.

import { COMPONENT_LABELS, PRESETS, type ComponentKey, type Weights } from "../engine/presets";

const ORDER: ComponentKey[] = ["twist", "length", "homes", "driveways", "stops", "isolation", "fewLanes"];

interface Props {
  weights: Weights;
  preset: string | null; // null = custom
  onChange: (w: Weights, preset: string | null) => void;
}

export default function ScoringPanel({ weights, preset, onChange }: Props) {
  return (
    <div className="section">
      <div className="section-title">
        Scoring
        <button onClick={() => onChange({ ...PRESETS.Balanced }, "Balanced")}>reset</button>
      </div>
      <div className="preset-row">
        {Object.keys(PRESETS).map((name) => (
          <button
            key={name}
            className={preset === name ? "active" : ""}
            onClick={() => onChange({ ...PRESETS[name] }, name)}
          >
            {name}
          </button>
        ))}
      </div>
      {ORDER.map((key) => {
        const isLanes = key === "fewLanes";
        return (
          <div key={key}>
            <div className="wslider">
              <label>{COMPONENT_LABELS[key]}</label>
              <input
                type="range"
                min={isLanes ? -100 : 0}
                max={100}
                step={5}
                value={weights[key]}
                onChange={(e) => onChange({ ...weights, [key]: Number(e.target.value) }, null)}
              />
              <span className="val">{weights[key]}</span>
            </div>
            {isLanes && <div className="lanes-hint">− favors more lanes · + favors fewer (rural two-lane)</div>}
          </div>
        );
      })}
    </div>
  );
}
