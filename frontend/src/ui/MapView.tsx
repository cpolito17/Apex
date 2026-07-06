// MapLibre map: light basemap, per-segment curvature coloring (light blue
// straights -> deep purple in the tightest corners), fit-all on new results,
// fit-one on result hover (§6.4).

import type { Feature, FeatureCollection } from "geojson";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import type { PublicRoute } from "../engine/scan";

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

// Radius (m) -> 0..1 "corner intensity". 175 m is the not-cornering threshold
// from the curvature method; -1 encodes a straight.
function intensity(radius: number): number {
  if (radius < 0 || radius >= 175) return 0;
  return Math.min(1, (175 - radius) / 165);
}

const LINE_COLOR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["get", "curv"],
  0,
  "#93c5fd",
  0.45,
  "#818cf8",
  0.75,
  "#a855f7",
  1,
  "#5b21b6",
];

function routesToSegments(routes: PublicRoute[]): FeatureCollection {
  const features: Feature[] = [];
  // Reverse rank order so rank 1 draws on top.
  for (let ri = routes.length - 1; ri >= 0; ri--) {
    const r = routes[ri];
    for (let i = 1; i < r.coords.length; i++) {
      const curv = Math.max(intensity(r.radii[i - 1]), intensity(r.radii[i]));
      features.push({
        type: "Feature",
        properties: { routeId: r.id, curv: Math.round(curv * 100) / 100 },
        geometry: { type: "LineString", coordinates: [r.coords[i - 1], r.coords[i]] },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

function startPoints(routes: PublicRoute[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: routes.map((r, i) => ({
      type: "Feature",
      properties: { routeId: r.id, rank: String(i + 1) },
      geometry: { type: "Point", coordinates: r.startCoord },
    })),
  };
}

function routeBounds(coordsList: Array<[number, number][]>): maplibregl.LngLatBounds | null {
  let bounds: maplibregl.LngLatBounds | null = null;
  for (const coords of coordsList) {
    for (const c of coords) {
      if (!bounds) bounds = new maplibregl.LngLatBounds(c, c);
      else bounds.extend(c);
    }
  }
  return bounds;
}

interface Props {
  routes: PublicRoute[]; // current ranked top N, rank order
  hoveredId: number | null;
  fitAllKey: number; // bump to re-fit all routes
}

export default function MapView({ routes, hoveredId, fitAllKey }: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const routesRef = useRef(routes);
  routesRef.current = routes;

  useEffect(() => {
    if (!divRef.current) return;
    const map = new maplibregl.Map({
      container: divRef.current,
      style: STYLE_URL,
      center: [-83.98, 42.43],
      zoom: 9,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      map.addSource("routes", { type: "geojson", data: routesToSegments(routesRef.current) });
      map.addSource("starts", { type: "geojson", data: startPoints(routesRef.current) });

      // Dark casing so the gradient pops on the light basemap.
      map.addLayer({
        id: "route-casing",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#0b0e14", "line-width": 6, "line-opacity": 0.55 },
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": LINE_COLOR, "line-width": 3.25 },
      });
      map.addLayer({
        id: "route-hover",
        type: "line",
        source: "routes",
        filter: ["==", ["get", "routeId"], -1],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": LINE_COLOR, "line-width": 6.5 },
      });
      map.addLayer({
        id: "start-points",
        type: "circle",
        source: "starts",
        paint: {
          "circle-radius": 9,
          "circle-color": "#0b0e14",
          "circle-stroke-color": "#8b5cf6",
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "start-labels",
        type: "symbol",
        source: "starts",
        layout: {
          "text-field": ["get", "rank"],
          "text-size": 10,
          "text-font": ["Noto Sans Bold"],
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#e6e9f0" },
      });
      readyRef.current = true;
      // Data may have arrived before style load.
      const b = routeBounds(routesRef.current.map((r) => r.coords));
      if (b) map.fitBounds(b, { padding: 56, duration: 700 });
    });
    mapRef.current = map;
    return () => {
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Push route data + fit all whenever a new result set (or re-rank) lands.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource("routes") as maplibregl.GeoJSONSource | undefined)?.setData(routesToSegments(routes));
    (map.getSource("starts") as maplibregl.GeoJSONSource | undefined)?.setData(startPoints(routes));
  }, [routes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || fitAllKey === 0) return;
    const b = routeBounds(routes.map((r) => r.coords));
    if (b) map.fitBounds(b, { padding: 56, duration: 700 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitAllKey]);

  // Hover a result -> fit that road; hover off -> back to the full set.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setFilter("route-hover", ["==", ["get", "routeId"], hoveredId ?? -1]);
    if (hoveredId !== null) {
      const r = routes.find((x) => x.id === hoveredId);
      if (r) {
        const b = routeBounds([r.coords]);
        if (b) map.fitBounds(b, { padding: 72, duration: 550 });
      }
    } else if (routes.length > 0) {
      const b = routeBounds(routes.map((r) => r.coords));
      if (b) map.fitBounds(b, { padding: 56, duration: 550 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredId]);

  return (
    <div className="map-wrap">
      <div ref={divRef} className="map" />
      <div className="legend">
        curvature
        <div className="legend-bar" />
        <div className="legend-ends">
          <span>straight</span>
          <span>tight</span>
        </div>
      </div>
    </div>
  );
}
