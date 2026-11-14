/**
 * The hosted OpenRouteService (ORS) implementation of `RoutingProvider`, used by `/api/route`.
 *
 * It calls the directions endpoint in GeoJSON format
 * (`POST /v2/directions/{profile}/geojson`) with turn-by-turn instructions turned off, and maps
 * every failure to a `RoutingError` with a stable code. ORS answers errors as
 * `{ error: { code, message } }` with internal codes in the 2000s (2009: no route between the
 * points, 2010: no routable point near a coordinate, 2004: a limit such as distance exceeded); the
 * API gateway in front of it answers 401/403 for a bad key and 429 when the quota is used up.
 */
import {
  type LatLon,
  type RouteLeg,
  type RouteRequest,
  RoutingError,
  type RoutingProfile,
  type RoutingProvider,
  DEFAULT_ROUTING_PROFILE,
  parseLineCoordinates,
  polylineLengthM,
} from "@pp/core";

export const ORS_BASE_URL = "https://api.openrouteservice.org";

/** How long to wait for ORS before answering `upstream_unavailable`. */
export const ORS_TIMEOUT_MS = 10_000;

/** Seconds to tell clients to wait when ORS is over its quota and gives no hint. */
export const ORS_QUOTA_RETRY_S = 60;

/** The ORS directions URL for a profile. */
export function orsDirectionsUrl(profile: RoutingProfile, baseUrl = ORS_BASE_URL): string {
  return `${baseUrl}/v2/directions/${profile}/geojson`;
}

/** The JSON body sent to ORS for one leg. `pnpm fixtures:record` must send the same. */
export function orsRequestBody(from: LatLon, to: LatLon): { coordinates: [number, number][]; instructions: false } {
  return {
    coordinates: [
      [from.lon, from.lat],
      [to.lon, to.lat],
    ],
    instructions: false,
  };
}

export interface OrsOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The internal ORS error code and message of an error body, when it has them. */
function orsError(body: unknown): { code?: number; message?: string } {
  if (!isRecord(body)) return {};
  const error = body["error"];
  if (typeof error === "string") return { message: error };
  if (!isRecord(error)) return {};
  const result: { code?: number; message?: string } = {};
  if (typeof error["code"] === "number") result.code = error["code"];
  if (typeof error["message"] === "string") result.message = error["message"];
  return result;
}

function retryAfterSeconds(header: string | null): number {
  const seconds = Number(header);
  return header !== null && Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : ORS_QUOTA_RETRY_S;
}

/** The `RoutingError` for a non-2xx ORS response. */
export function mapOrsFailure(status: number, body: unknown, retryAfter: string | null = null): RoutingError {
  const { code, message } = orsError(body);
  const detail = `ORS ${status}${code === undefined ? "" : ` (${code})`}${message ? `: ${message}` : ""}`;
  if (status === 429) {
    return new RoutingError("upstream_rate_limited", "The routing service is busy. Try again in a minute.", {
      cause: detail,
      retryAfterS: retryAfterSeconds(retryAfter),
    });
  }
  if (status === 401 || status === 403) {
    return new RoutingError("not_configured", "The routing service rejected this server's API key.", {
      cause: detail,
    });
  }
  if (code === 2009 || code === 2010 || code === 2016 || (status === 404 && code === undefined)) {
    return new RoutingError("no_route", "No walkable path connects these points.", { cause: detail });
  }
  if (code === 2004) {
    return new RoutingError("invalid_request", "These points are too far apart to route.", { cause: detail });
  }
  return new RoutingError("upstream_unavailable", "The routing service failed. Try again.", { cause: detail });
}

/** The leg in a successful ORS GeoJSON response, or `upstream_unavailable` if it has none. */
export function parseOrsRoute(body: unknown): RouteLeg {
  const malformed = new RoutingError("upstream_unavailable", "The routing service sent a malformed route.", {
    cause: "ORS 200 with an unreadable body",
  });
  if (!isRecord(body) || !Array.isArray(body["features"])) throw malformed;
  const feature: unknown = body["features"][0];
  if (!isRecord(feature) || !isRecord(feature["geometry"]) || feature["geometry"]["type"] !== "LineString") {
    throw malformed;
  }
  const points = parseLineCoordinates(feature["geometry"]["coordinates"]);
  if (!points) throw malformed;
  // ORS leaves `summary.distance` out when it is 0; fall back to measuring the line.
  const properties = isRecord(feature["properties"]) ? feature["properties"] : {};
  const summary = isRecord(properties["summary"]) ? properties["summary"] : {};
  const distance = summary["distance"];
  const distanceM =
    typeof distance === "number" && Number.isFinite(distance) && distance >= 0 ? distance : polylineLengthM(points);
  return { points, distanceM: Math.round(distanceM * 10) / 10 };
}

/** A `RoutingProvider` on hosted ORS. Every failure rejects with a `RoutingError`. */
export function orsRoutingProvider(options: OrsOptions): RoutingProvider {
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? ORS_TIMEOUT_MS;
  return {
    async route(request: RouteRequest): Promise<RouteLeg> {
      const profile = request.profile ?? DEFAULT_ROUTING_PROFILE;
      let response: Response;
      try {
        response = await fetchFn(orsDirectionsUrl(profile, options.baseUrl), {
          method: "POST",
          headers: {
            authorization: options.apiKey,
            "content-type": "application/json",
            accept: "application/geo+json, application/json",
          },
          body: JSON.stringify(orsRequestBody(request.from, request.to)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new RoutingError("upstream_unavailable", "The routing service did not answer. Try again.", {
          cause: error,
        });
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      if (!response.ok) throw mapOrsFailure(response.status, body, response.headers.get("retry-after"));
      return parseOrsRoute(body);
    },
  };
}
