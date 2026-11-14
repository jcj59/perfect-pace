/**
 * `POST /api/route`: route one leg on foot through hosted OpenRouteService, holding the API key
 * server side. The request and response shapes, and the error codes, are the wire contract in
 * `@pp/core` (`routing.ts`).
 *
 * Caching: successful routes are stored with the Cache API for `ROUTE_CACHE_TTL_S`, keyed by the
 * profile and the coordinates rounded to 5 decimals (about 1 m), so redrawing or undoing a leg
 * costs no upstream request. The Cache API is per Cloudflare data center, and it does nothing on
 * `*.workers.dev` hostnames, so it only takes effect once the Worker is on a custom domain.
 *
 * Rate limiting: each client IP (`CF-Connecting-IP`) may send `ROUTE_RATE_LIMIT` upstream
 * requests per minute; cache hits are free. A counter in Worker memory would be per isolate
 * (Cloudflare runs many isolates, in many locations, and evicts them at will), so a client could
 * exceed it just by landing on fresh isolates. The limit is the Workers Rate Limiting binding
 * (`ROUTE_RATE_LIMITER` in `wrangler.jsonc`) instead: no dependency, shared by every isolate in
 * a Cloudflare location, and only eventually consistent, so a burst can slightly overshoot. It
 * guards the ORS free quota (40 directions requests a minute, 2,000 a day, shared by everyone),
 * not the daily total; the upstream answers `upstream_rate_limited` once that is used up.
 */
import {
  type RouteErrorBody,
  type RouteLeg,
  type RouteRequest,
  ROUTING_ERROR_STATUS,
  RoutingError,
  parseRouteRequest,
  routeToFeature,
} from "@pp/core";
import { orsRoutingProvider } from "./ors.ts";

/** Upstream (cache miss) requests allowed per client IP per minute. Must match `wrangler.jsonc`. */
export const ROUTE_RATE_LIMIT = 20;
/** The rate limit window in seconds. Must match `wrangler.jsonc`. */
export const ROUTE_RATE_PERIOD_S = 60;
/** How long a routed leg stays cached: a week (paths change slowly). */
export const ROUTE_CACHE_TTL_S = 7 * 24 * 60 * 60;
/** The largest request body accepted, in bytes. A valid one is under 150. */
export const MAX_ROUTE_BODY_BYTES = 2048;

/** Bindings `/api/route` uses. `ORS_API_KEY` is a secret, so it is not in the generated `Env`. */
export interface RouteEnv {
  ROUTE_RATE_LIMITER: RateLimit;
  ORS_API_KEY?: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function errorResponse(error: RoutingError): Response {
  const code = error.code === "network" ? "upstream_unavailable" : error.code;
  const body: RouteErrorBody = { error: code, message: error.message };
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (error.retryAfterS !== undefined) {
    body.retryAfterS = error.retryAfterS;
    headers["retry-after"] = String(error.retryAfterS);
  }
  if (code === "not_configured" || code === "upstream_unavailable" || code === "upstream_rate_limited") {
    const cause = error.cause instanceof Error ? error.cause.message : error.cause;
    console.error(`/api/route ${code}: ${typeof cause === "string" ? cause : error.message}`);
  }
  return new Response(JSON.stringify(body), { status: ROUTING_ERROR_STATUS[code], headers });
}

function cacheKey(origin: string, request: Required<RouteRequest>): Request {
  const { from, to, profile } = request;
  return new Request(`${origin}/api/route/cache/v1/${profile}/${from.lat},${from.lon};${to.lat},${to.lon}`);
}

async function readRequest(request: Request): Promise<Required<RouteRequest>> {
  const text = await request.text();
  if (text.length > MAX_ROUTE_BODY_BYTES) {
    throw new RoutingError("invalid_request", `the body must be at most ${MAX_ROUTE_BODY_BYTES} bytes`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RoutingError("invalid_request", "the body must be JSON");
  }
  return parseRouteRequest(body);
}

async function route(request: Request, env: RouteEnv, ctx: ExecutionContext): Promise<Response> {
  const leg = await readRequest(request);
  const respond = (routed: RouteLeg, cache: "hit" | "miss" | "none"): Response =>
    new Response(JSON.stringify(routeToFeature(routed, leg.profile)), {
      headers: { ...JSON_HEADERS, "x-route-cache": cache },
    });

  // A leg that starts where it ends needs no routing (a double tap on the same spot).
  if (leg.from.lat === leg.to.lat && leg.from.lon === leg.to.lon) {
    return respond({ points: [leg.from, leg.to], distanceM: 0 }, "none");
  }

  const apiKey = env.ORS_API_KEY?.trim();
  if (!apiKey) throw new RoutingError("not_configured", "Routing is not set up on this server (no ORS_API_KEY).");

  const cache = caches.default;
  const key = cacheKey(new URL(request.url).origin, leg);
  const cached = await cache.match(key);
  if (cached) return respond(await cached.json<RouteLeg>(), "hit");

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.ROUTE_RATE_LIMITER.limit({ key: `route:${ip}` });
  if (!success) {
    throw new RoutingError("rate_limited", "Too many routing requests. Wait a minute and try again.", {
      retryAfterS: ROUTE_RATE_PERIOD_S,
    });
  }

  const routed = await orsRoutingProvider({ apiKey }).route(leg);
  const stored = new Response(JSON.stringify(routed), {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${ROUTE_CACHE_TTL_S}` },
  });
  ctx.waitUntil(cache.put(key, stored));
  return respond(routed, "miss");
}

/** Handles `/api/route`. Every failure is a JSON `{ error, message }` with a stable code. */
export async function handleRoute(request: Request, env: RouteEnv, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...JSON_HEADERS, allow: "POST" },
    });
  }
  try {
    return await route(request, env, ctx);
  } catch (error) {
    if (error instanceof RoutingError) return errorResponse(error);
    console.error("/api/route failed unexpectedly", error);
    return errorResponse(new RoutingError("upstream_unavailable", "Routing failed unexpectedly. Try again."));
  }
}
