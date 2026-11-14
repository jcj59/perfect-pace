/**
 * Routing: the `RoutingProvider` interface, the wire contract of the Worker's `/api/route`
 * endpoint, and a client provider that calls it.
 *
 * A provider turns one leg (`from` to `to`) into a line that follows paths, with its length. The
 * Worker implements it on hosted OpenRouteService today; a self-hosted Valhalla provider can
 * replace it later without changing callers. The browser uses `httpRoutingProvider`, which calls
 * `/api/route` and so never sees the upstream API key.
 *
 * Wire contract (`POST /api/route`, JSON both ways):
 * - request: `{ from: { lat, lon }, to: { lat, lon }, profile?: "foot-walking" }`
 * - success (200): a GeoJSON `Feature` whose geometry is a `LineString` of `[lon, lat]` pairs and
 *   whose properties are `{ distanceM, profile }` (see `RouteFeature`)
 * - failure: `{ error: RoutingErrorCode, message, retryAfterS? }` with the status in
 *   `ROUTING_ERROR_STATUS` (and a `Retry-After` header when `retryAfterS` is set)
 *
 * Coordinates are rounded to `ROUTE_COORDINATE_DECIMALS` places (about 1 m) before routing, so
 * the same click always produces the same request, and the Worker can cache it.
 */
import { type LatLon, haversineM } from "./geo.ts";

/** The travel profiles routing supports. Only walking and running on foot paths for now. */
export type RoutingProfile = "foot-walking";

/** Every supported `RoutingProfile`. */
export const ROUTING_PROFILES: readonly RoutingProfile[] = ["foot-walking"];

/** The profile used when a request does not name one. */
export const DEFAULT_ROUTING_PROFILE: RoutingProfile = "foot-walking";

/** Decimal places kept in request coordinates: 5 places is 1.1 m of latitude. */
export const ROUTE_COORDINATE_DECIMALS = 5;

/**
 * The longest straight-line distance between the ends of one leg, 100 km. Drawn legs are a click
 * apart, so anything longer is a mistake, and it keeps upstream requests and responses small.
 */
export const MAX_ROUTE_LEG_M = 100_000;

/** One leg to route. */
export interface RouteRequest {
  from: LatLon;
  to: LatLon;
  /** Default `DEFAULT_ROUTING_PROFILE`. */
  profile?: RoutingProfile;
}

/** A routed leg: the line from `from` to `to`, in order, and its length along the paths. */
export interface RouteLeg {
  points: LatLon[];
  distanceM: number;
}

/** Structural `AbortSignal`, since core is compiled without the DOM lib. */
export interface AbortSignalLike {
  readonly aborted: boolean;
}

/** Per-call options for `RoutingProvider.route`. */
export interface RouteOptions {
  /** Cancels the request (for example when the user moves the waypoint again). */
  signal?: AbortSignalLike;
}

/** A source of routes. Implementations reject with a `RoutingError`. */
export interface RoutingProvider {
  route(request: RouteRequest, options?: RouteOptions): Promise<RouteLeg>;
}

/** Why a leg could not be routed. These strings are the stable `error` codes of `/api/route`. */
export type RoutingErrorCode =
  /** The request is malformed: bad JSON, coordinates out of range, unknown profile, too long. */
  | "invalid_request"
  /** This client sent too many routing requests; retry after `retryAfterS`. */
  | "rate_limited"
  /** There is no path between the points (for example, one is in the sea). */
  | "no_route"
  /** The upstream routing service is over its quota; retry after `retryAfterS`. */
  | "upstream_rate_limited"
  /** The upstream routing service failed, timed out or answered with something unreadable. */
  | "upstream_unavailable"
  /** The server has no routing API key, or the upstream service rejected it. */
  | "not_configured"
  /** Client only: the request did not reach the server (offline, DNS, CORS). */
  | "network";

/** The HTTP status `/api/route` answers with for each server-side error code. */
export const ROUTING_ERROR_STATUS: Readonly<Record<Exclude<RoutingErrorCode, "network">, number>> = {
  invalid_request: 400,
  rate_limited: 429,
  no_route: 422,
  upstream_rate_limited: 503,
  upstream_unavailable: 502,
  not_configured: 503,
};

/** A failure to route a leg. */
export class RoutingError extends Error {
  override readonly name = "RoutingError";
  /** For the rate limit codes: seconds to wait before retrying, when known. */
  readonly retryAfterS: number | undefined;
  constructor(
    readonly code: RoutingErrorCode,
    message: string,
    options?: { cause?: unknown; retryAfterS?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.retryAfterS = options?.retryAfterS;
  }
}

/** The error body of `/api/route`. */
export interface RouteErrorBody {
  error: RoutingErrorCode;
  message: string;
  retryAfterS?: number;
}

/** The success body of `/api/route`: a GeoJSON Feature with a LineString of `[lon, lat]`. */
export interface RouteFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: { distanceM: number; profile: RoutingProfile };
}

/** `value` rounded to `ROUTE_COORDINATE_DECIMALS` places. */
export function roundCoordinate(value: number): number {
  const scale = 10 ** ROUTE_COORDINATE_DECIMALS;
  // `+ 0` turns -0 into 0, so the rounded value prints the same whichever side it came from.
  return Math.round(value * scale) / scale + 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePosition(value: unknown, name: string): LatLon {
  if (!isRecord(value)) throw new RoutingError("invalid_request", `${name} must be an object with lat and lon`);
  const { lat, lon } = value;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RoutingError("invalid_request", `${name}.lat must be a number in [-90, 90]`);
  }
  if (typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RoutingError("invalid_request", `${name}.lon must be a number in [-180, 180]`);
  }
  return { lat: roundCoordinate(lat), lon: roundCoordinate(lon) };
}

/**
 * Validates a `/api/route` request body (already parsed from JSON) and returns it in canonical
 * form: coordinates rounded to `ROUTE_COORDINATE_DECIMALS` places and the profile filled in.
 * Throws a `RoutingError` with code `invalid_request` saying what is wrong.
 */
export function parseRouteRequest(body: unknown): Required<RouteRequest> {
  if (!isRecord(body)) throw new RoutingError("invalid_request", "the body must be a JSON object with from and to");
  const from = parsePosition(body["from"], "from");
  const to = parsePosition(body["to"], "to");
  const profile = body["profile"] ?? DEFAULT_ROUTING_PROFILE;
  if (!ROUTING_PROFILES.includes(profile as RoutingProfile)) {
    throw new RoutingError("invalid_request", `profile must be one of: ${ROUTING_PROFILES.join(", ")}`);
  }
  if (haversineM(from, to) > MAX_ROUTE_LEG_M) {
    throw new RoutingError("invalid_request", `from and to must be within ${MAX_ROUTE_LEG_M / 1000} km of each other`);
  }
  return { from, to, profile: profile as RoutingProfile };
}

/** The length in meters of a polyline, as the sum of great-circle hops. */
export function polylineLengthM(points: readonly LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1]!, points[i]!);
  return total;
}

/** A leg as the `/api/route` success body. */
export function routeToFeature(leg: RouteLeg, profile: RoutingProfile = DEFAULT_ROUTING_PROFILE): RouteFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: leg.points.map((p) => [p.lon, p.lat]) },
    properties: { distanceM: leg.distanceM, profile },
  };
}

/**
 * Reads GeoJSON `[lon, lat]` positions (extra values such as elevation are ignored) into points.
 * Returns `undefined` unless there are at least two valid positions.
 */
export function parseLineCoordinates(coordinates: unknown): LatLon[] | undefined {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return undefined;
  const points: LatLon[] = [];
  for (const position of coordinates) {
    if (!Array.isArray(position)) return undefined;
    const [lon, lat] = position as unknown[];
    if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat)) {
      return undefined;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;
    points.push({ lat, lon });
  }
  return points;
}

/** Reads a `/api/route` success body back into a leg. Throws `upstream_unavailable` if malformed. */
export function parseRouteFeature(body: unknown): RouteLeg {
  const malformed = (): RoutingError =>
    new RoutingError("upstream_unavailable", "the routing service sent a malformed route");
  if (!isRecord(body) || body["type"] !== "Feature") throw malformed();
  const geometry = body["geometry"];
  const properties = body["properties"];
  if (!isRecord(geometry) || geometry["type"] !== "LineString" || !isRecord(properties)) throw malformed();
  const points = parseLineCoordinates(geometry["coordinates"]);
  const distanceM = properties["distanceM"];
  if (!points || typeof distanceM !== "number" || !Number.isFinite(distanceM) || distanceM < 0) throw malformed();
  return { points, distanceM };
}

const CODES = new Set<string>(Object.keys(ROUTING_ERROR_STATUS));

/** The `RoutingError` for a failed `/api/route` response, from its body or else its status. */
export function routingErrorFromResponse(status: number, body: unknown): RoutingError {
  if (isRecord(body) && typeof body["error"] === "string" && CODES.has(body["error"])) {
    const message = typeof body["message"] === "string" ? body["message"] : `routing failed (${body["error"]})`;
    const retry = body["retryAfterS"];
    return new RoutingError(
      body["error"] as RoutingErrorCode,
      message,
      typeof retry === "number" && Number.isFinite(retry) && retry >= 0 ? { retryAfterS: retry } : undefined,
    );
  }
  if (status === 429) return new RoutingError("rate_limited", "too many routing requests");
  if (status >= 400 && status < 500) return new RoutingError("invalid_request", `routing request rejected (${status})`);
  return new RoutingError("upstream_unavailable", `routing service unavailable (${status})`);
}

// Structural fetch types, since core is compiled without the DOM lib.
interface RouteFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
/** The subset of `fetch` that `httpRoutingProvider` uses. */
export type RouteFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignalLike },
) => Promise<RouteFetchResponse>;

/** Options for `httpRoutingProvider`. */
export interface HttpRoutingOptions {
  /** The endpoint URL. Default `"/api/route"` (same origin). */
  endpoint?: string;
  /** Default the global `fetch`, looked up at call time. */
  fetch?: RouteFetch;
}

/**
 * A `RoutingProvider` that calls the Worker's `/api/route`. Failures reject with a `RoutingError`
 * carrying the server's error code (`network` when the server could not be reached). A request
 * cancelled through `signal` rejects with the fetch's own abort error instead, so callers can
 * tell a cancellation from a failure.
 */
export function httpRoutingProvider(options: HttpRoutingOptions = {}): RoutingProvider {
  const endpoint = options.endpoint ?? "/api/route";
  return {
    async route(request, routeOptions) {
      const fetchFn = options.fetch ?? (globalThis as { fetch?: RouteFetch }).fetch;
      if (!fetchFn) throw new RoutingError("network", "no fetch is available");
      const init: Parameters<RouteFetch>[1] = {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          from: request.from,
          to: request.to,
          profile: request.profile ?? DEFAULT_ROUTING_PROFILE,
        }),
      };
      if (routeOptions?.signal) init.signal = routeOptions.signal;
      let response: RouteFetchResponse;
      try {
        response = await fetchFn(endpoint, init);
      } catch (error) {
        if (routeOptions?.signal?.aborted) throw error;
        throw new RoutingError("network", "could not reach the routing service", { cause: error });
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (routeOptions?.signal?.aborted) throw error;
        body = undefined;
      }
      if (!response.ok) throw routingErrorFromResponse(response.status, body);
      return parseRouteFeature(body);
    },
  };
}
