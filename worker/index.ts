// Apex on Cloudflare Workers — static-asset host for /apex/* plus a thin
// caching proxy for the two public data services (Overpass, Nominatim).
// The scan itself runs client-side in a Web Worker; this proxy exists so
// responses are cached in KV (road geometry rarely changes) and so the public
// endpoints see a single well-identified caller instead of many browsers.

export interface Env {
  ASSETS: Fetcher;
  CACHE: KVNamespace;
  API_LIMITER: RateLimit;
}

const API_PREFIX = "/apex/api";
const USER_AGENT = "Apex/1.0 (https://charliepolito.com/apex; contact: cpolito@umich.edu)";

// Overpass mirrors, tried in order on failure/timeout.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const NOMINATIM_SEARCH = "https://nominatim.openstreetmap.org/search";

// KV values are capped at 25 MB; leave headroom.
const MAX_CACHEABLE_BYTES = 23 * 1024 * 1024;
const OVERPASS_TTL_S = 7 * 24 * 3600; // road geometry is slow-moving
const GEOCODE_TTL_S = 30 * 24 * 3600;
const MAX_REQUEST_BYTES = 25_000;

const ALLOWED_OVERPASS_SHAPES = new Set([
  '[out:json][timeout:150]; way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|track|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](around:*); out body qt; >; out skel qt;',
  '[out:json][timeout:60]; way[building](around:*); out count;',
  '[out:json][timeout:120]; node[highway~"^(stop|give_way|traffic_signals)$"](around:*); out body qt; way[highway=service][service=driveway](around:*); out skel qt; way[landuse=residential](around:*); out geom qt;',
  '[out:json][timeout:150]; way[building](around:*); out ids center qt;',
]);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

function secure(response: Response, html = false): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (html) {
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://tiles.openfreemap.org https://*.openfreemap.org; connect-src 'self' https://tiles.openfreemap.org https://*.openfreemap.org; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readLimitedJson(request: Request): Promise<{ query?: unknown } | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_REQUEST_BYTES) throw new HttpError(413, "Request body is too large.");
  if (!request.body) throw new HttpError(400, "An Overpass query is required.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as { query?: unknown };
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function supportedOverpassQuery(query: string): boolean {
  const normalized = query.replace(/\s+/g, " ").trim();
  let validAround = true;
  let aroundCount = 0;
  const shape = normalized.replace(
    /\(around:(\d+),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)/g,
    (_match, radiusText: string, latText: string, lonText: string) => {
      aroundCount += 1;
      const radius = Number(radiusText);
      const lat = Number(latText);
      const lon = Number(lonText);
      if (radius < 1 || radius > 40_200 || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        validAround = false;
      }
      return "(around:*)";
    },
  );
  return validAround && aroundCount > 0 && ALLOWED_OVERPASS_SHAPES.has(shape);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * POST /apex/api/overpass  body: { query: string }
 * Forwards an OverpassQL query, caching successful JSON responses in KV keyed
 * by the query hash. The client rounds bbox coordinates before building the
 * query, so near-repeat searches hit the same key.
 */
async function postOverpass(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_REQUEST_BYTES) throw new HttpError(413, "Request body is too large.");
  const body = await readLimitedJson(request);
  if (!body || typeof body.query !== "string" || body.query.length < 10 || body.query.length > 20000) {
    throw new HttpError(400, "An Overpass query is required.");
  }
  const query = body.query;
  // This endpoint exists for Apex's generated read-only queries, not as a
  // general-purpose Overpass relay. Blocking mutation and non-JSON forms
  // limits third-party abuse of the public Worker and upstream service.
  if (!supportedOverpassQuery(query)) {
    throw new HttpError(400, "Unsupported Overpass query.");
  }
  const key = `ov:${await sha256Hex(query)}`;

  const cached = await env.CACHE.get(key, "stream");
  if (cached) {
    return new Response(cached, {
      headers: { "Content-Type": "application/json", "X-Apex-Cache": "hit" },
    });
  }

  let lastErr = "Overpass unavailable.";
  for (const endpoint of OVERPASS_ENDPOINTS) {
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(170_000),
      });
    } catch {
      lastErr = "Overpass request timed out.";
      continue;
    }
    if (resp.status === 200) {
      const text = await resp.text();
      // Overpass can return 200 with a remark-only body on timeout/trim.
      if (text.length <= MAX_CACHEABLE_BYTES && !text.includes('"remark"')) {
        ctx.waitUntil(env.CACHE.put(key, text, { expirationTtl: OVERPASS_TTL_S }));
      }
      return new Response(text, {
        headers: { "Content-Type": "application/json", "X-Apex-Cache": "miss" },
      });
    }
    if (resp.status === 429 || resp.status === 504) {
      lastErr = `Overpass is busy (HTTP ${resp.status}). Try again shortly or reduce the radius.`;
      continue;
    }
    const detail = (await resp.text().catch(() => "")).slice(0, 300);
    lastErr = `Overpass error ${resp.status}: ${detail}`;
    break;
  }
  throw new HttpError(502, lastErr);
}

/**
 * GET /apex/api/geocode?q=...  — Nominatim search for the address input
 * autocomplete. Cached aggressively; the client debounces to stay well under
 * Nominatim's 1 req/s usage policy.
 */
async function getGeocode(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2 || q.length > 200) throw new HttpError(400, "A location query (2-200 chars) is required.");

  const key = `geo:${q.toLowerCase()}`;
  const cached = await env.CACHE.get(key);
  if (cached) return new Response(cached, { headers: { "Content-Type": "application/json" } });

  const target = new URL(NOMINATIM_SEARCH);
  target.searchParams.set("q", q);
  target.searchParams.set("format", "jsonv2");
  target.searchParams.set("limit", "6");
  const resp = await fetch(target.toString(), {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status !== 200) throw new HttpError(502, `Geocoding unavailable (HTTP ${resp.status}).`);
  const raw = (await resp.json()) as Array<Record<string, unknown>>;
  const results = raw.map((r) => ({
    label: String(r.display_name ?? ""),
    lat: Number(r.lat),
    lon: Number(r.lon),
  }));
  const text = JSON.stringify({ results });
  ctx.waitUntil(env.CACHE.put(key, text, { expirationTtl: GEOCODE_TTL_S }));
  return new Response(text, { headers: { "Content-Type": "application/json" } });
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === `${API_PREFIX}/health` && request.method === "GET") return json({ ok: true });
  if (path === `${API_PREFIX}/overpass` && request.method === "POST") return postOverpass(request, env, ctx);
  if (path === `${API_PREFIX}/geocode` && request.method === "GET") return getGeocode(url, env, ctx);
  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
      if (request.headers.get("sec-fetch-site") === "cross-site") {
        return json({ detail: "Cross-site requests are not allowed." }, 403);
      }
      try {
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        const limited = await env.API_LIMITER.limit({ key: `${path}:${ip}` });
        if (!limited.success) {
          return secure(json({ detail: "Too many requests. Please wait a minute." }, 429));
        }
        return secure(await handleApi(request, env, ctx, url));
      } catch (err) {
        if (err instanceof HttpError) return secure(json({ detail: err.message }, err.status));
        return secure(json({ detail: "Internal error." }, 500));
      }
    }

    // Bare /apex -> canonical trailing slash.
    if (path === "/apex") {
      return secure(Response.redirect(`${url.origin}/apex/`, 301));
    }

    // Any other non-API path under /apex that didn't match a built asset:
    // serve the SPA shell.
    const indexReq = new Request(new URL("/apex/index.html", url.origin), request);
    const asset = await env.ASSETS.fetch(indexReq);
    return secure(asset, (asset.headers.get("content-type") ?? "").includes("text/html"));
  },
};
