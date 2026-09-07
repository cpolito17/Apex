# GAPS.md — Known weaknesses, honestly

An audit of everything weak, fragile, or unfinished, ordered most severe
first. Each entry says what it is, where it lives, why it matters, and a fix
scoped small enough to execute as a single task. Architecture context is in
[PROJECT.md](PROJECT.md).

---

## 1. Zero automated tests; the entire scoring engine is untested

**What:** There are no unit tests, no test runner, no CI. The only
verification is `scripts/verify.ts`, which hits live Overpass, prints ranked
lists to stdout, and asserts nothing — a human has to eyeball it against the
README's sanity anchors.

**Where:** whole repo (no `*.test.ts`, no `.github/workflows/`, no test deps
in either `package.json`).

**Why it matters:** the engine (`frontend/src/engine/*`) is the product. It's
pure, deterministic TypeScript with injected I/O — the *easiest possible code
to unit test* — and every hand-tuned constant in it silently changes ranking
behavior when touched. Any future change to `graph.ts`, `stitch.ts`, or
`score.ts` is currently made blind. Critical untested paths: circumcircle
math (`geo.ts:circumradius` — collinear/near-collinear/degenerate inputs),
curvature bucketing (`graph.ts:curvatureWeight`/`weightedCornering`), way
splitting at junctions (`graph.ts:buildGraph`), surface fallback
(`graph.ts:classifySurface`), stitch orientation/seam handling
(`stitch.ts:routeCoords`/`routeNodeIds` — off-by-one at seams would corrupt
every downstream signal), de-dup (`scan.ts`), and `combineScore` with
negative weights (`presets.ts`).

**Fix (single task):** add `vitest` to `frontend/devDependencies` and a
`test` script; write pure unit tests with hand-built fixtures (no network) for
`geo.ts`, `classifySurface`, `curvatureWeight`, `weightedCornering`,
`combineScore`, and `routeCoords` seam dedup. A second task can snapshot a
small cached Overpass fixture and pin the Hell-MI top-10 as a regression test.

---

## 2. The Worker is an open, unauthenticated proxy with no rate limiting

**What:** `POST /apex/api/overpass` forwards *any* OverpassQL string
(10–20 000 chars) to the public Overpass API under the owner's identifying
User-Agent (`Apex/1.0 (...; contact: cpolito@umich.edu)`). `GET
/apex/api/geocode` similarly proxies Nominatim. There is no rate limiting, no
origin check, and no query-shape validation.

**Where:** `worker/index.ts` (`postOverpass`, `getGeocode`).

**Why it matters (severity: MEDIUM-HIGH):** anyone who finds the endpoint can
(a) use it as a free Overpass/Nominatim relay, burning the public APIs' quota
attributed to the owner's contact email — the realistic worst case is the
Overpass/Nominatim operators blocking that User-Agent, killing the app for
everyone; (b) spam distinct queries/geocodes to write unbounded junk into the
KV namespace (each distinct query = one KV write; free-tier KV has daily write
limits). Data exfiltration is not a concern (OSM data is public) and
cross-origin *browser* abuse is mostly blocked by accident (the JSON POST
triggers a CORS preflight the Worker 404s), but nothing stops curl.

**Fix (single task):** in `postOverpass`, validate the query matches the
shapes the client actually sends before forwarding: must start with
`[out:json]`, must contain `(around:R,LAT,LON)` with R ≤ 41 000, and must
match one of the four templates in `frontend/src/engine/overpass.ts` (a
regex per template is enough). Reject everything else with 400. A follow-up
task can add per-IP rate limiting via `request.headers.get("cf-connecting-ip")`
counted in KV with a short TTL.

---

## 3. The Worker can cache malformed or non-JSON Overpass responses for 7 days

**What:** `postOverpass` caches any 200 response body that is under 23 MB and
doesn't contain the substring `"remark"`. It never parses the body, so an HTML
error page, truncated body, or otherwise invalid JSON served with HTTP 200
gets cached and poisons that query key for 7 days — every client scan of that
area fails until the TTL expires. The `"remark"` substring check is also
fragile in the other direction: any OSM tag *value* containing `"remark"`
makes a perfectly good response uncacheable.

**Where:** `worker/index.ts:84-93`.

**Why it matters (severity: MEDIUM):** a single flaky upstream response bricks
scans for a whole region for a week, and there is no cache-purge tooling in
the repo.

**Fix (single task):** before `CACHE.put`, run `JSON.parse(text)` in a
try/catch and check the parsed object for a top-level `remark` property and a
non-empty `elements` array; only cache when it parses clean. Return the text
either way.

---

## 4. `localStorage` prefs are trusted blindly — schema drift produces NaN scores

**What:** `loadPrefs()` in `frontend/src/App.tsx:22-30` does
`JSON.parse(raw) as Prefs` with no shape validation. If a stored prefs blob
is missing a weights key (old schema, manual edit, future component
added/renamed), `combineScore` (`frontend/src/engine/presets.ts:42-53`) reads
`weights[key]` as `undefined`, and `Math.abs(undefined) * s` makes the total
`NaN` — every result renders score "NaN" and sorting becomes garbage, with no
error thrown. Same for a stored `radiusKm`/`surface` outside valid ranges.

**Where:** `frontend/src/App.tsx:22-30`; failure manifests in
`frontend/src/engine/presets.ts:combineScore`.

**Why it matters (severity: MEDIUM):** this fires the first time anyone adds,
removes, or renames a scoring component (`SubScores`) — a likely evolution —
and it breaks *silently* for returning users while looking fine in fresh
browsers. The key is versioned (`apex-prefs-v1`) but nothing bumps or migrates
it.

**Fix (single task):** in `loadPrefs`, merge the parsed object over the
defaults key-by-key: take `weights[k]` only if it's a finite number, for every
`ComponentKey`; clamp `radiusKm` to 5–40; accept `surface` only if it's one of
`paved|gravel|both`. Fall back to defaults otherwise.

---

## 5. Resolved: verification cache is portable

**What changed:** the default `CACHE_DIR` is now the repository-local
`.overpass-cache` directory, which is ignored by Git. `APEX_CACHE_DIR` remains
available for callers that want to put the cache elsewhere.

**Result:** the ranking-quality verification tool now runs out of the box on
Windows, macOS, and Linux without leaving machine-specific paths in the source.

---

## 6. The engine silently accepts Overpass-trimmed (partial) data

**What:** Overpass signals "I timed out and truncated your data" via a
`remark` field on an HTTP 200 response. `OverpassResponse` declares the field
(`frontend/src/engine/overpass.ts:10`) but `scan.ts` never reads it — a
truncated road fetch just means roads are quietly missing from results. Only
`verify.ts` prints remarks to stderr.

**Where:** `frontend/src/engine/scan.ts` (all four `fetcher(...)` calls).

**Why it matters (severity: MEDIUM):** spec §3 explicitly requires handling
trimmed results by warning, not failing or lying. A user scanning a dense
area can get a confident-looking top 10 computed from half the road network.

**Fix (single task):** in `scan()`, after each fetch, check `resp.remark`; if
present on the roads query, push a warning like "Road data was trimmed by the
data service — results may be incomplete; try a smaller radius." (warnings
plumbing already exists and renders in `App.tsx`).

---

## 7. Name-based de-dup merges genuinely different roads that share a name

**What:** de-dup treats any two routes with the same non-"Unnamed" name as the
same road (`frontend/src/engine/scan.ts:123-126` — "Same name inside one
search radius = the same road to a driver").

**Where:** `frontend/src/engine/scan.ts:117-136`.

**Why it matters (severity: LOW-MEDIUM):** common US names ("Main Street",
"River Road", "State Route 36") recur in different towns inside a 40 km
radius. The lower-ranked genuine road is silently discarded, costing a
legitimately distinct result. The geometric-overlap check right below it is
the sound half of the rule.

**Fix (single task):** make the name rule conditional on proximity: compute
each route's projected bounding box during scoring (cheap — coords are
already projected) and only name-dedupe when the boxes are within ~2 km of
each other; otherwise rely on geometric overlap alone.

---

## 8. Context sampling density depends on OSM vertex spacing, not distance

**What:** `samplePoints` (`frontend/src/engine/score.ts:91-102`) walks
existing polyline vertices and emits one every ≥60 m of accumulated length —
it never interpolates. A dead-straight road drawn with vertices 500 m apart
gets ~1 sample per 500 m, while a twisty road gets one per 60 m.

**Where:** `frontend/src/engine/score.ts:91-102` (feeds the homes,
residential-fraction, and isolation signals).

**Why it matters (severity: LOW-MEDIUM):** buildings/residential zones along
sparsely-digitized straight stretches are systematically under-counted, which
*flatters* exactly the "fast sweeper" roads where the appropriateness signal
matters most. Ranking is only softly wrong, which is why it's survivable —
but it biases the product's core differentiator.

**Fix (single task):** rewrite `samplePoints` to interpolate: walk segments,
and for each segment longer than 60 m emit intermediate points every 60 m by
linear interpolation between the two endpoints. Then re-run `npm run verify`
against Hell MI and Deals Gap and compare top-10s before/after.

---

## 9. Constants duplicated between engine and UI can drift apart

**What:**
- Max radius: `MAX_RADIUS_M = 40_000` in `frontend/src/engine/scan.ts:23`
  vs. `MAX_RADIUS_KM = 40` in `frontend/src/ui/SearchPanel.tsx:9`.
- `API_BASE` computed identically in `frontend/src/App.tsx:11` and
  `frontend/src/ui/SearchPanel.tsx:8`.
- The curvature color ramp defined in `frontend/src/ui/MapView.tsx:20-32`
  and repeated as a CSS gradient in `frontend/src/styles.css:465`
  (`.legend-bar`) — change one and the legend lies.
- Overpass mirror-fallback logic implemented twice: `worker/index.ts:67-101`
  and `scripts/verify.ts:30-53`.

**Why it matters (severity: LOW):** none of these are broken today; all are
the kind of thing that silently desyncs on the next edit.

**Fix (single task):** create `frontend/src/lib/constants.ts` exporting
`MAX_RADIUS_KM`, `API_BASE`, and the four gradient color stops; import it in
the three UI files (build the legend gradient inline from the stops instead
of hardcoding it in CSS). Leave the worker/verify duplication — they run in
different runtimes and sharing would couple them for little gain; just note
it in a comment.

---

## 10. The Worker is never typechecked by any script

**What:** `npm run build` runs `tsc -b` for the *frontend* only.
`worker/tsconfig.json` exists and typechecks clean, but nothing ever invokes
it — `wrangler deploy` bundles with esbuild, which strips types without
checking them.

**Where:** root `package.json` scripts; `worker/tsconfig.json`.

**Why it matters (severity: LOW-MEDIUM):** a type error in `worker/index.ts`
ships to production silently. The Worker is the only server code — the one
place a runtime error takes the whole app down.

**Fix (single task):** add a root script
`"check": "tsc -p worker --noEmit && cd frontend && tsc -b --force"` and make
`deploy` run it first (`"deploy": "npm run check && ..."`).

---

## 11. A generated file is committed: `frontend/tsconfig.tsbuildinfo`

**What:** the TypeScript incremental-build state file is tracked in git; every
`npm run build` dirties the working tree.

**Where:** `frontend/tsconfig.tsbuildinfo` (tracked); `.gitignore` misses it.

**Why it matters (severity: LOW):** noise in every diff, merge conflicts for
no reason, and it invites committing other build output.

**Fix (single task):** `git rm --cached frontend/tsconfig.tsbuildinfo`, add
`*.tsbuildinfo` to `.gitignore`, commit.

---

## 12. Lint tooling referenced but not installed

**What:** `frontend/src/ui/MapView.tsx:172,190` carry
`// eslint-disable-next-line react-hooks/exhaustive-deps` comments, but no
ESLint config or dependency exists anywhere in the repo. There is also no
Prettier config despite very consistent formatting (it was evidently
formatted by *something*).

**Where:** `frontend/src/ui/MapView.tsx`; both `package.json` files.

**Why it matters (severity: LOW):** the disable comments are dead weight, and
the intentionally-omitted hook deps they mark (see #13) have no tool guarding
the *other* hooks. Future edits will drift in style with nothing to stop them.

**Fix (single task):** either delete the two stale comments, or (better) add
`eslint` + `typescript-eslint` + `eslint-plugin-react-hooks` with a minimal
flat config to `frontend`, add a `lint` script, and fix what it flags.

---

## 13. Deliberate-but-undocumented stale-closure hazards in `MapView`

**What:** two `useEffect`s intentionally omit `routes` from their dependency
arrays (the fit-all effect keyed on `fitAllKey`, and the hover effect keyed on
`hoveredId`). The hover effect reads `routes` from a stale render if the
ranked list changes while a result is hovered (slider drag while hovering) —
the map may fit a route that just fell out of the top 10, or filter-highlight
a `routeId` no longer on the map.

**Where:** `frontend/src/ui/MapView.tsx:167-191`.

**Why it matters (severity: LOW):** cosmetic misbehavior only, and rare (needs
simultaneous hover + re-rank). But it's exactly the kind of thing a future
refactor "fixes" into an infinite fit-loop, so intent must be written down.

**Fix (single task):** mirror the `routesRef` pattern already used by the
load handler — read `routesRef.current` inside both effects instead of the
`routes` prop, then the omitted dep is genuinely unused and the disable
comments can go (pairs with #12).

---

## 14. Touch devices can't un-hover, and hover-to-zoom is the only zoom-to-road affordance

**What:** `ResultsList` drives map focus entirely with `onMouseEnter`/
`onMouseLeave`. On phones (a first-class target per spec §7), tapping a
result fires a synthetic mouseenter — so zoom-to-road works once — but
mouseleave never fires, so the map stays locked on that road until another
result is tapped, and there's no way to get back to the fit-all view.

**Where:** `frontend/src/ui/ResultsList.tsx:16-22`; consumed in
`frontend/src/ui/MapView.tsx:176-191`.

**Why it matters (severity: LOW):** degraded core interaction on mobile, which
the spec explicitly calls out as required ("must be usable on a phone").

**Fix (single task):** make it a toggle: `onClick` on a result sets
`hoveredId` to its id, or to `null` if it's already the hovered/selected one;
keep the mouse handlers for desktop. Also add a small "fit all" button on the
map (calls the existing fit-all path by bumping `fitAllKey`).

---

## 15. No scan cancellation and a worst-case ~6-minute silent wait

**What:** once a scan starts, the only way to stop it is to start another (the
old Web Worker is terminated in `startScan`) or reload. Inside the worker, the
fetcher retries each failed Overpass call once after 5 s
(`frontend/src/scan.worker.ts:20-36`), and the Cloudflare Worker holds the
upstream connection up to 170 s per mirror per attempt — a fully-degraded
upstream means minutes of a progress bar sitting at one stage.

**Where:** `frontend/src/App.tsx:50-72`, `frontend/src/scan.worker.ts`.

**Why it matters (severity: LOW):** honest-progress UX is a spec requirement;
an uncancelable multi-minute hang violates its spirit.

**Fix (single task):** add a "Cancel" button to the progress UI in `App.tsx`
that calls `workerRef.current?.terminate()` and resets state to `idle`. (A
client-side `AbortSignal.timeout` on the fetch inside `scan.worker.ts` is a
good follow-up.)

---

## 16. Building count/fetch misses non-way buildings and miscounts the cap

**What:** `buildingCountQuery`/`buildingsQuery` fetch `way[building]` only —
buildings mapped as relations (large/multipolygon buildings) are invisible,
and `parseBuildingCount` reads the `ways` count only. Meanwhile the context
radius pads by a flat 200 m while `HOME_BUFFER_M` is 120 m (fine today, but
the pad and the buffer aren't linked).

**Where:** `frontend/src/engine/overpass.ts:48-71,105-118`;
`frontend/src/engine/score.ts:49`.

**Why it matters (severity: LOW):** slight undercount of the homes signal in
areas with relation-mapped buildings; materially rural areas (the target) are
mostly way-mapped, so impact is small.

**Fix (single task):** change both queries to `wr[building]` (ways +
relations) and sum `ways` + `relations` in `parseBuildingCount`; relations
also return `center` with `out ids center`, so `parseBuildings` already
handles them if the type check is widened from `"way"` to `"way" ||
"relation"`.

---

## 17. Residential landuse mapped as relations is ignored (known v1 cut)

**What:** only `way[landuse=residential]` outer rings are used; multipolygon
relations (how larger residential zones are often mapped) are skipped — this
one is at least documented in a comment ("relations skipped in v1").

**Where:** `frontend/src/engine/overpass.ts:56-65,87` and `parseContext`.

**Why it matters (severity: LOW):** in metro areas where the building fetch is
trimmed, residential landuse becomes half the homes signal; missing relation
polygons weakens exactly that fallback.

**Fix (single task):** add `relation[landuse=residential]${a}; out geom qt;`
to `contextQuery` and, in `parseContext`, treat each relation member ring with
`role=outer` as an additional polygon. Keep inner rings ignored (acceptable
over-count).

---

## 18. Minor paper cuts (batch-fixable)

- **README broken link:** `README.md:11` links `../apex-spec.md`; the spec is
  in the same directory — should be `apex-spec.md`. Also `README.md` line 18
  links `worker/index.ts` relative to root correctly, but the doc says
  "Built from [apex-spec.md](../apex-spec.md)" — fix the path.
- **1.2 MB JS bundle** (MapLibre dominates; Vite warns on every build). Fix:
  `build.chunkSizeWarningLimit` or a `manualChunks` split for `maplibre-gl` in
  `frontend/vite.config.ts` — cosmetic; the app is a single page.
- **`fmtMiles` hardcodes miles** and `SPEED_BY_CLASS`/`parseMaxspeedMph`
  assume US mph conventions (`frontend/src/lib/format.ts`,
  `frontend/src/engine/score.ts:108-135`). Fine for the intended region;
  a unit toggle is v2-adjacent. Document, don't fix.
- **`describe()` chip thresholds** (`frontend/src/lib/format.ts:16-31`) are
  magic numbers tied to the `saturate` constants in `score.ts` — a re-tune of
  one without the other makes the chips lie. Add a cross-reference comment.
- **Two `package-lock.json` trees** (root + frontend) means two `npm install`
  steps and no workspace linking. Works, but trips up newcomers — documented
  in CLAUDE.md rather than restructured.
- **`overpass.ts` fetches `residential` + all link classes but
  `CANDIDATE_CLASSES` (graph.ts:38-47) excludes links** — link roads
  (ramps) are fetched, become graph edges (junction-degree context, arterial
  proximity), but can't join routes. Intentional-looking, but undocumented;
  add a comment where `ROAD_CLASS_RE` and `CANDIDATE_CLASSES` are defined
  saying the two sets differ on purpose.

---

## What is *not* here (checked and found clean)

- No secrets in the repo — all upstream services are keyless by design; the
  KV namespace id in `wrangler.toml` is not a secret.
- No TODO/FIXME/HACK markers anywhere in the source.
- No dead code found: every exported engine function is used by the pipeline,
  the UI, or verify.ts.
- No feature flags or abandoned migrations — the repo is a single coherent
  initial commit.
