import type { LonLat } from "../engine/geo";

/** Directions deep-link to the start of the road (§6.5) — Apple Maps on
 * Apple devices, Google Maps everywhere else. */
export function mapsLink(start: LonLat): string {
  const [lon, lat] = start;
  const apple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  return apple
    ? `https://maps.apple.com/?daddr=${lat},${lon}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
}
