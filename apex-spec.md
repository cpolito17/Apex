# Apex — Project Specification

*Find the roads worth driving — and keep the fun where it belongs.*

---

## How to use this document

This is the build spec for a self-hosted web app that finds and ranks the best driving roads within a radius of a location. It defines the product, the features, and the decisions already made. It intentionally does **not** prescribe file structure, internal architecture, or exact scoring formulas — those are yours to design. The external services named below are fixed; everything else about *how* is your call.

Before building: read the whole spec, then ask only the clarifying questions that would *materially* change the build. If nothing is blocking, scope the work and execute it end to end. Don't pause for confirmation on reversible decisions that clearly follow from this spec.

While building: don't add features, sources, or abstractions beyond what's described here — do the simplest thing that works well. There's a "v2 — design for, don't build" section at the end; treat it as a list of things *not* to build now. Establish a way to verify the app actually works (containers come up, a search on a known good driving area returns real ranked roads, the map draws them with curvature coloring) and check against it as you go rather than at the end. When you report back, lead with what works and what doesn't against that check.

---

## 1. What we're building

A web app that answers one question: **"Where are the good driving roads near here?"** The user enters an address and a search radius; the app scans the road network in that radius, scores every road on how good it is for spirited, low-risk, legal driving, and returns the **top 10 ranked roads**. Each road is drawn on a map, colored by how twisty it is, and comes with an **"Open in Maps"** button that routes the user to the start of the road.

The point is not just to find twisty roads — it's to find twisty roads **in the right places**: away from homes, foot traffic, and driveways, where enjoying a car isn't a hazard to anyone. Too many enthusiasts end up hooning through residential streets because they don't know where the genuinely appropriate roads are. This tool surfaces the lesser-travelled, low-consequence roads so the fun happens where it's safe and legal.

**Who it's for:** driving and motorcycling enthusiasts who want to find good roads near a location — home, a trip stop, a meet-up point — without local knowledge.

**Scope for v1:** single location + radius search, top 10 results, map visualization, tunable scoring. No accounts. No turn-by-turn navigation (that's handed to the user's map app at the end).

---

## 2. The thing that matters most

**The ranking has to feel right to someone who actually drives these roads.** A driver looking at the top 10 should nod — "yes, those are the good ones, and they're in sensible places" — not scratch their head at a fast arterial or a road that runs past a school.

Two properties define a good result, and they're equal partners:

1. **It's fun to drive** — genuinely twisty, sustained, flowing, not a broad sweeping bend that's only interesting above the speed limit.
2. **It's an appropriate place to drive it** — low pedestrian exposure, few homes and driveways, low traffic, minimal stops. This is what separates this tool from every "twisty roads" map that will happily point you at a fun-but-residential street.

When trade-offs arise, protect both. A slightly less twisty road in an empty rural area should be able to out-rank a slightly twistier one lined with houses. The scoring is user-tunable (see §6), but the *defaults* should embody this balance.

---

## 3. Decisions already made

These are settled — you don't need to re-open them.

**External services & infrastructure (fixed):**
- **Road & land-use data:** OpenStreetMap, queried live via the **public Overpass API**, with local caching (see §4). No paid street/traffic/routing APIs anywhere — out of scope by design.
- **Geocoding** (address → coordinates): **Nominatim** public endpoint, with respectful rate limiting.
- **Map rendering:** **MapLibre GL JS**.
- **Map tiles:** a **free, no-key** style (OpenFreeMap is the default choice) so the app can be shared with friends without distributing secrets. A light/muted basemap is preferred so the colored road overlays pop.
- **Deployment target:** Docker / Docker Compose, self-hostable on a personal Linux server, and equally deployable somewhere friends can reach it. No required external secrets.

**Backend:** **Python** with a modern async framework (**FastAPI** recommended). The scan is CPU-bound vector geometry and graph work — Python's geometry/graph ecosystem (e.g. Shapely, NetworkX) is the right fit and the reason the compute lives server-side rather than in the browser. If you have a strong reason to choose otherwise, flag it.

**Frontend:** a light single-page app (React is fine and matches the family of prior projects). Internal architecture and file layout are your call.

**Compute location:** server-side. The browser sends a location + radius + options; the backend does the scan and returns scored roads. The one thing that must **not** require a server round-trip is re-ranking when the user moves a scoring slider — see the re-ranking decision below.

**Twistiness algorithm:** adapt the well-established **circumcircle-radius method** (from Adam Franco's open-source `curvature` project): for each set of three consecutive road points, the circumcircle's radius approximates the corner radius at that point; tighter corners are weighted more heavily; sum the length spent genuinely cornering. This is a solved problem and beats naive distance-ratio ("sinuosity") approaches, which get fooled by circular roads and can't tell fun corners from broad highway curves. **Note the license:** the reference project is GPLv3 — if Apex is ever open-sourced, keep that in mind; adapting the *method* is fine regardless. The per-point corner radius this produces does double duty as the map coloring signal (see §6).

**Scan-once, re-rank-instantly (architectural principle):** the expensive scan computes each road's **component sub-scores once** (twistiness, isolation, length, etc., each stored per road). Moving a scoring slider or switching a preset just **reweights and re-sorts the already-scored roads on the client** — no new Overpass call, no re-scan. This is what makes slider tuning pleasant and is the intended way the user dials in good default weights.

**Speed limit:** **dropped from the score** (US `maxspeed` coverage in OSM is too spotty to rank on reliably), but **still shown in the results display** — the actual `maxspeed` where tagged, otherwise a value inferred from road class, clearly marked as approximate.

**Radius cap & warning:** cap the search radius (default ceiling ~**40 km** / ~25 mi). Dense metro areas pull enormous building/road data, so above a size/density threshold, warn the user that the scan will be slower and may be trimmed, and handle Overpass timeouts gracefully rather than failing hard.

**Result count:** top **10** distinct roads.

**Open in Maps:** deep-links to the **start of the road** in the user's default map app (Google/Apple Maps directions link to the start coordinate). The known caveat — if the user approaches from the far end they'll be routed to drive *through* the road to reach the pin — is **acceptable**; don't build anything clever to solve it.

---

## 4. Data & the scan pipeline (concept, not formulas)

Everything comes from OpenStreetMap via Overpass. For a search, the pipeline is roughly:

1. **Geocode** the address to a center point (Nominatim).
2. **Fetch** the road network and surrounding context within the radius from Overpass: roads (`highway=*` of the drivable classes), plus the context needed for scoring — buildings, `landuse=residential`, stop signs and traffic signals (`highway=stop` / `traffic_signals`), driveways/service ways, surface tags, lane counts, speed limits. Cache responses keyed by a rounded bounding box + query so repeat/near-repeat searches are fast (road geometry doesn't change).
3. **Build a graph** of the local road network from the OSM ways and their shared nodes.
4. **Stitch roads** from that graph (see below) — this is the core algorithmic step.
5. **Score** each stitched road on the components in §5.
6. **De-duplicate** overlapping roads (see below).
7. **Return** the top 10, each with: its full geometry (for drawing), per-component sub-scores (for client re-ranking), per-point corner-radius data (for coloring), and display metadata (length, surface, speed limit, start coordinate).

**Stitching ways into roads (the hard part).** OSM splits a single human-perceived road into many "ways" at every intersection and tag change, so a "road" must be assembled. Use **greedy bidirectional extension**: pick high-scoring seed segments, then grow each seed outward in both directions, continuing across a junction when either (a) the driver could carry roughly straight through it (small heading change), or (b) the onward segment also scores well even through a turn — so a short twisty road that hits an intersection with *another* good road extends into one continuous route. Keep extending while the running quality stays above a threshold; stop when it drops off. This deliberately avoids global "best route in the radius" optimization, which is a v2 concern. If greedy extension proves too slow on real data, that's an acceptable place to reconsider the approach after testing — note it rather than silently swapping in something heavier.

**De-duplication.** Growing from many seeds will surface the same road several times with slightly different extents. Merge routes that substantially overlap so the final top 10 are **ten distinct roads**, not one road ten times.

**Surface handling (paved vs. gravel).** The user selects paved, gravel, or both (see §6). Because surface tagging is incomplete, use the established fallback: an explicit unpaved/gravel/dirt tag → treat as gravel; an explicit paved/asphalt/concrete tag → paved; no tag on a major road class → assume paved; no tag on a minor road → unknown-leaning-unpaved (include when gravel is allowed, flag as uncertain).

---

## 5. Scoring components (principles, not formulas)

Each road gets a set of **normalized component sub-scores**, combined by user-weighted sliders into a final rank (see §6). Normalization matters: because the raw signals are in different units (meters, counts-per-km, degrees), each must be scaled to a comparable range so the slider weights actually mean something. Tune the exact scaling yourself — the principles below are what's fixed.

- **Twistiness** — distance spent genuinely cornering, tighter corners weighted more (circumcircle method, §3). The headline "fun" signal.
- **Road length** — longer sustained good road is better, with diminishing returns (a great road doesn't get twice as good for being twice as long).
- **Residential / pedestrian exposure** ("homes") — building density within a buffer of the road, and/or the fraction of the road passing through `landuse=residential`. **More exposure is worse.** This is the primary "is it appropriate" signal.
- **Driveway density** — count of driveways and minor private access points along the road, per unit length. More is worse. A distinct safety signal from raw building count (it's about things pulling out at you).
- **Stop / intersection density** — stop signs, traffic signals, and junctions per unit length. More is worse (kills flow).
- **Connectivity (traffic proxy)** — we can't get real traffic without paid APIs, so approximate it: roads that are relatively isolated, further from dense junction networks and major arterials, carry less traffic and score better. A proxy, and fine as one.
- **Lane count** — from the `lanes` tag. Its *desirable direction depends on intent*: twisty-road presets favor fewer lanes (rural two-lane and under); highway presets tolerate or prefer more. Because it's slider-weighted per preset, treat lane count as an available signal whose contribution the presets set, rather than hard-coding "more = better."

Road class (`highway=*`) informs several of the above (residential class is inherently penalized; track class leans gravel) and can also gate what's even considered a drivable candidate.

---

## 6. Features

### 6.1 Search panel

A compact panel (anchored to a sensible edge on desktop; collapsible on mobile). Contains:
- **Address input** with Nominatim-backed autocomplete.
- **Radius control** — a slider up to the ~40 km cap, with the slower/trimmed warning appearing past the density threshold.
- **Surface selector** — paved / gravel / both.
- **Search button** — triggers the scan and a loading state (the scan can take real seconds; show honest progress, not a spinner that implies it hung).

### 6.2 Scoring sliders & presets

The heart of the tuning experience, and instant to use because re-ranking is client-side (§3).
- **A weight slider per scoring component** in §5 (twistiness, length, residential exposure, driveway density, stop/intersection density, connectivity, lane count).
- **Presets** that set slider configurations for common intents — at minimum **"Slow Twisty"** and **"Fast Highway"**, plus a sensible **"Balanced"** default and a **gravel/rally-leaning** preset. Selecting a preset moves the sliders (and the user can then adjust from there).
- Moving any slider **re-ranks and re-orders the top 10 immediately** with no re-scan.
- Remembering the user's last slider/preset state in the browser is a nice touch but optional.

### 6.3 Results list

A ranked list of the top 10 roads, highest score first. Each entry shows: a rank, the road's name (or a sensible label when unnamed), its **length**, **surface**, **speed limit** (actual or marked-approximate, §3), a compact readout of its standout qualities (e.g. how twisty / how isolated), and an **"Open in Maps"** button (§3).
- **Hovering a result zooms the map to fit that road** in the window (see §6.4).

### 6.4 Map

MapLibre GL JS filling the main area, light basemap.
- **After a search completes, the map zooms to fit all top roads** in view at once.
- **Hovering a result road zooms to fit that single road.**
- **Each road is drawn with per-segment curvature coloring**: a gradient from **light blue on straights to deep purple in the tightest corners**, driven by the per-point corner radius from the twistiness calculation. This gives an at-a-glance read of a road's character — a road that's mostly purple is wall-to-wall corners; blue-to-purple transitions show where the good bits are.

### 6.5 Open in Maps

Each road's button opens a directions link to the **start coordinate** of that road in the user's default maps app. Nothing more.

---

## 7. UI / UX & design system

The feel should read **automotive and precise** — think instrument cluster, track map, telemetry — not a generic map app. The curvature gradient is the signature visual element; let it carry the aesthetic.

Direction (refine as you build, not prescriptive):
- **Palette:** a dark, low-glare base (so the blue→purple road gradient and the light basemap read clearly), with a single sharp accent for interactive elements. The curvature gradient's blue and purple are effectively brand colors — build around them.
- **Typography:** a clean technical sans for UI, with a monospace for numbers (lengths, speeds, coordinates, scores) to reinforce the telemetry feel.
- **Motion:** map fit/zoom transitions (search-complete fit, hover-to-fit) should be smooth and quick — they're central to the experience, so they should feel responsive, not sluggish.
- **Mobile:** must be usable on a phone; the results list becomes a bottom sheet over the map, the search panel collapses once a search is active.

---

## 8. v2 — design for, don't build

Leave room for these; **do not build them now.**
- **Adjustable-weight sliders already ship in v1** — but *saved custom presets* the user names and stores are v2.
- **Global route optimization** (best continuous driving *loop* or *route* through the radius, rather than best individual roads) — explicitly deferred; greedy extension is the v1 approach.
- **Elevation / grade scoring** (climbs and passes) from a free DEM — a real future signal, adds a data dependency; not now.
- **Scenery scoring** (proximity to water, forest, viewpoints).
- **Self-hosted Overpass / Nominatim** for higher traffic or offline use.
- **Result sharing** (link to a found road or a search).
- **Coverage beyond the default region**, limited only by OSM data density, not architecture.

Architecture shouldn't preclude these — that's all that's required of v1.

---

## 9. To confirm before starting

1. **Name.** The working name is **Apex** — the racing term for the inside point of a corner, which fits both the subject and the naming style of the sibling projects. Confirm or replace before branding and container/image names go in. (Alternatives if it doesn't land: *Carve*, *Switchback*, *Tarmac*.)
2. **Default region / geocoding scope.** v1 is built around one starting region for testing and tuning. Confirm the intended primary area (e.g. Southern California / the user's home area) so the defaults, the density-warning threshold, and the test cases are tuned somewhere real with good OSM coverage.
