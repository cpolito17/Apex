// Apex on Cloudflare Workers — static-asset host for /apex/* plus a thin
// caching proxy for the two public data services (Overpass, Nominatim).
// The scan itself runs client-side in a Web Worker; this proxy exists so
// responses are cached in KV (road geometry rarely changes) and so the public
// endpoints see a single well-identified caller instead of many browsers.

export interface Env {
  ASSETS: Fetcher;
  CACHE: KVNamespace;
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

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
  const body = (await request.json().catch(() => null)) as { query?: unknown } | null;
  if (!body || typeof body.query !== "string" || body.query.length < 10 || body.query.length > 20000) {
    throw new HttpError(400, "An Overpass query is required.");
  }
  const query = body.query;
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
      try {
        return await handleApi(request, env, ctx, url);
      } catch (err) {
        if (err instanceof HttpError) return json({ detail: err.message }, err.status);
        return json({ detail: "Internal error." }, 500);
      }
    }

    // Bare /apex -> canonical trailing slash.
    if (path === "/apex") {
      return Response.redirect(`${url.origin}/apex/`, 301);
    }

    // Any other non-API path under /apex that didn't match a built asset:
    // serve the SPA shell.
    const indexReq = new Request(new URL("/apex/index.html", url.origin), request);
    return env.ASSETS.fetch(indexReq);
  },
};
