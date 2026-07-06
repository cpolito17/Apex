// Search controls: Nominatim-backed address autocomplete, radius slider with
// the slow-scan warning, surface selector, and the search button (§6.1).

import { useEffect, useRef, useState } from "react";
import type { LonLat } from "../engine/geo";
import type { SurfaceChoice } from "../engine/stitch";

const API_BASE = `${import.meta.env.BASE_URL}api`;
const MAX_RADIUS_KM = 40;
const WARN_RADIUS_KM = 24;

interface Suggestion {
  label: string;
  lat: number;
  lon: number;
}

interface Props {
  radiusKm: number;
  surface: SurfaceChoice;
  busy: boolean;
  onRadius: (km: number) => void;
  onSurface: (s: SurfaceChoice) => void;
  onSearch: (center: LonLat, label: string) => void;
}

export default function SearchPanel({ radiusKm, surface, busy, onRadius, onSurface, onSearch }: Props) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Suggestion | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (picked && text === picked.label) return; // no lookup after a pick
    if (text.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const resp = await fetch(`${API_BASE}/geocode?q=${encodeURIComponent(text.trim())}`, {
          signal: ctrl.signal,
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as { results: Suggestion[] };
        setSuggestions(data.results.filter((r) => Number.isFinite(r.lat)));
        setOpen(true);
      } catch {
        /* aborted or offline — the dropdown just doesn't update */
      }
    }, 450);
    return () => clearTimeout(debounceRef.current);
  }, [text, picked]);

  function pick(s: Suggestion) {
    setPicked(s);
    setText(s.label);
    setOpen(false);
  }

  async function search() {
    if (busy) return;
    let target = picked;
    if (!target || text !== target.label) {
      // Typed but never picked: geocode the raw text, take the top hit.
      try {
        const resp = await fetch(`${API_BASE}/geocode?q=${encodeURIComponent(text.trim())}`);
        const data = (await resp.json()) as { results: Suggestion[] };
        target = data.results[0] ?? null;
      } catch {
        target = null;
      }
    }
    if (!target) return;
    pick(target);
    onSearch([target.lon, target.lat], target.label);
  }

  const radiusMi = Math.round(radiusKm * 0.621371);

  return (
    <div className="section">
      <div className="section-title">Search</div>
      <div className="search-row">
        <input
          className="search-input"
          placeholder="Address, town, or place…"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPicked(null);
          }}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        {open && suggestions.length > 0 && (
          <div className="suggestions">
            {suggestions.map((s) => (
              <button key={`${s.lat},${s.lon}`} onMouseDown={() => pick(s)}>
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="control-row">
        <span className="control-label">Radius</span>
        <input
          type="range"
          min={5}
          max={MAX_RADIUS_KM}
          step={1}
          value={radiusKm}
          onChange={(e) => onRadius(Number(e.target.value))}
        />
        <span className="control-value">{radiusMi} mi</span>
      </div>

      <div className="control-row">
        <span className="control-label">Surface</span>
        <div className="seg" style={{ flex: 1 }}>
          {(["paved", "gravel", "both"] as const).map((s) => (
            <button key={s} className={surface === s ? "active" : ""} onClick={() => onSurface(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {radiusKm >= WARN_RADIUS_KM && (
        <div className="warn-note">
          Large radius: dense areas can make the scan slow, and building data may be trimmed.
        </div>
      )}

      <button className="go-btn" onClick={search} disabled={busy || text.trim().length < 3}>
        {busy ? "Scanning…" : "Find roads"}
      </button>
    </div>
  );
}
