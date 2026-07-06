import type { PublicRoute } from "../engine/scan";

export function fmtMiles(lengthM: number): string {
  return `${(lengthM / 1609.34).toFixed(1)} mi`;
}

export function fmtSpeed(r: PublicRoute): string {
  return `${r.speedIsEstimate ? "~" : ""}${r.speedLimitMph} mph`;
}

export function fmtSurface(r: PublicRoute): string {
  return r.surfaceCertain ? r.surface : `${r.surface}?`;
}

/** Compact standout-quality chips for a result row (§6.3). */
export function describe(r: PublicRoute): Array<{ text: string; hot: boolean }> {
  const tags: Array<{ text: string; hot: boolean }> = [];
  const s = r.sub;
  if (s.twist > 0.75) tags.push({ text: "wall-to-wall corners", hot: true });
  else if (s.twist > 0.55) tags.push({ text: "properly twisty", hot: true });
  else if (s.twist > 0.35) tags.push({ text: "flowing bends", hot: false });
  else tags.push({ text: "fast sweepers", hot: false });

  if (s.homes > 0.92 && s.driveways > 0.75) tags.push({ text: "far from homes", hot: true });
  else if (s.homes > 0.8) tags.push({ text: "lightly settled", hot: false });
  else if (s.homes < 0.6) tags.push({ text: "near homes", hot: false });

  if (s.stops > 0.9) tags.push({ text: "uninterrupted", hot: false });
  if (s.isolation > 0.9) tags.push({ text: "isolated", hot: false });
  return tags.slice(0, 3);
}
