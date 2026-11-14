import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ROUTING_PROFILE,
  type RouteFetch,
  RoutingError,
  haversineM,
  httpRoutingProvider,
  parseLineCoordinates,
  parseRouteFeature,
  parseRouteRequest,
  polylineLengthM,
  roundCoordinate,
  routeToFeature,
  routingErrorFromResponse,
} from "../src/index.ts";

const FROM = { lat: 40.77423, lon: -73.97169 };
const TO = { lat: 40.77924, lon: -73.96881 };

function expectRoutingError(fn: () => unknown, code: string, message?: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RoutingError);
    expect((error as RoutingError).code).toBe(code);
    if (message) expect((error as RoutingError).message).toMatch(message);
    return;
  }
  throw new Error("expected a RoutingError");
}

describe("roundCoordinate", () => {
  it("keeps five decimals and never returns -0", () => {
    expect(roundCoordinate(40.123456789)).toBe(40.12346);
    expect(roundCoordinate(-73.000004)).toBe(-73);
    expect(Object.is(roundCoordinate(-0.000001), 0)).toBe(true);
  });
});

describe("parseRouteRequest", () => {
  it("rounds coordinates and fills in the default profile", () => {
    const parsed = parseRouteRequest({ from: { lat: 40.774231234, lon: -73.971694 }, to: TO });
    expect(parsed).toEqual({ from: { lat: 40.77423, lon: -73.97169 }, to: TO, profile: DEFAULT_ROUTING_PROFILE });
  });

  it("accepts the foot-walking profile by name", () => {
    expect(parseRouteRequest({ from: FROM, to: TO, profile: "foot-walking" }).profile).toBe("foot-walking");
  });

  it.each([
    [null, /JSON object/],
    [[FROM, TO], /JSON object/],
    ["from=1", /JSON object/],
    [{ to: TO }, /^from must be an object/],
    [{ from: FROM, to: [1, 2] }, /^to must be an object/],
    [{ from: { lat: "40", lon: -73 }, to: TO }, /from\.lat/],
    [{ from: { lat: 91, lon: -73 }, to: TO }, /from\.lat/],
    [{ from: { lat: Number.NaN, lon: -73 }, to: TO }, /from\.lat/],
    [{ from: FROM, to: { lat: 40, lon: 180.5 } }, /to\.lon/],
    [{ from: FROM, to: { lat: 40 } }, /to\.lon/],
    [{ from: FROM, to: TO, profile: "driving-car" }, /profile must be one of: foot-walking/],
    [{ from: FROM, to: { lat: 41.8, lon: -73.97 } }, /within 100 km/],
  ])("rejects %j", (body, message) => {
    expectRoutingError(() => parseRouteRequest(body), "invalid_request", message);
  });
});

describe("GeoJSON round trip", () => {
  const leg = { points: [FROM, { lat: 40.776, lon: -73.97 }, TO], distanceM: 640.2 };

  it("writes [lon, lat] positions and reads them back", () => {
    const feature = routeToFeature(leg);
    expect(feature).toEqual({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [-73.97169, 40.77423],
          [-73.97, 40.776],
          [-73.96881, 40.77924],
        ],
      },
      properties: { distanceM: 640.2, profile: "foot-walking" },
    });
    expect(parseRouteFeature(JSON.parse(JSON.stringify(feature)))).toEqual(leg);
  });

  it.each([
    ["not a feature", { type: "FeatureCollection" }],
    ["no geometry", { type: "Feature", properties: { distanceM: 1 } }],
    ["a point", { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { distanceM: 1 } }],
    ["no properties", { type: "Feature", geometry: { type: "LineString", coordinates: [] } }],
    ["one position", { ...routeToFeature(leg), geometry: { type: "LineString", coordinates: [[-73, 40]] } }],
    ["a negative distance", { ...routeToFeature(leg), properties: { distanceM: -1, profile: "foot-walking" } }],
    ["a string distance", { ...routeToFeature(leg), properties: { distanceM: "640", profile: "foot-walking" } }],
  ])("rejects %s as upstream_unavailable", (_, body) => {
    expectRoutingError(() => parseRouteFeature(body), "upstream_unavailable", /malformed/);
  });
});

describe("parseLineCoordinates", () => {
  it("ignores elevation values", () => {
    expect(
      parseLineCoordinates([
        [-73, 40, 12],
        [-73.1, 40.1, 15],
      ]),
    ).toEqual([
      { lat: 40, lon: -73 },
      { lat: 40.1, lon: -73.1 },
    ]);
  });

  it.each([
    ["not an array", "x"],
    ["a non-array position", [[-73, 40], "x"]],
    [
      "a string number",
      [
        ["-73", 40],
        [-73, 40],
      ],
    ],
    [
      "an infinite value",
      [
        [Infinity, 40],
        [-73, 40],
      ],
    ],
    [
      "a latitude out of range",
      [
        [-73, 95],
        [-73, 40],
      ],
    ],
    [
      "a longitude out of range",
      [
        [-190, 40],
        [-73, 40],
      ],
    ],
  ])("returns undefined for %s", (_, coordinates) => {
    expect(parseLineCoordinates(coordinates)).toBeUndefined();
  });
});

describe("polylineLengthM", () => {
  it("sums the hops", () => {
    const mid = { lat: 40.776, lon: -73.97 };
    expect(polylineLengthM([FROM, mid, TO])).toBeCloseTo(haversineM(FROM, mid) + haversineM(mid, TO), 6);
    expect(polylineLengthM([FROM])).toBe(0);
  });
});

describe("routingErrorFromResponse", () => {
  it("uses the code, message and retry hint from the body", () => {
    const error = routingErrorFromResponse(429, { error: "rate_limited", message: "slow down", retryAfterS: 30 });
    expect(error).toMatchObject({ code: "rate_limited", message: "slow down", retryAfterS: 30 });
  });

  it("ignores an invalid retry hint and fills in a missing message", () => {
    const error = routingErrorFromResponse(503, { error: "upstream_rate_limited", retryAfterS: -5 });
    expect(error).toMatchObject({ code: "upstream_rate_limited", retryAfterS: undefined });
    expect(error.message).toContain("upstream_rate_limited");
  });

  it.each([
    [429, "rate_limited"],
    [400, "invalid_request"],
    [500, "upstream_unavailable"],
    [502, "upstream_unavailable"],
  ])("falls back to the status (%i) when the body has no known code", (status, code) => {
    expect(routingErrorFromResponse(status, { error: "teapot" }).code).toBe(code);
    expect(routingErrorFromResponse(status, undefined).code).toBe(code);
  });
});

function jsonResponse(status: number, body: unknown): ReturnType<RouteFetch> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

describe("httpRoutingProvider", () => {
  const leg = { points: [FROM, TO], distanceM: 612.4 };

  it("POSTs the leg to /api/route and parses the feature", async () => {
    const fetch = vi.fn<RouteFetch>(() => jsonResponse(200, routeToFeature(leg)));
    expect(await httpRoutingProvider({ fetch }).route({ from: FROM, to: TO })).toEqual(leg);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/route");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ from: FROM, to: TO, profile: "foot-walking" });
    expect(init.signal).toBeUndefined();
  });

  it("uses a custom endpoint and passes the abort signal through", async () => {
    const fetch = vi.fn<RouteFetch>(() => jsonResponse(200, routeToFeature(leg)));
    const signal = { aborted: false };
    await httpRoutingProvider({ endpoint: "https://example.test/api/route", fetch }).route(
      { from: FROM, to: TO, profile: "foot-walking" },
      { signal },
    );
    expect(fetch.mock.calls[0]![0]).toBe("https://example.test/api/route");
    expect(fetch.mock.calls[0]![1].signal).toBe(signal);
  });

  it("uses the global fetch by default", async () => {
    const fetch = vi.fn<RouteFetch>(() => jsonResponse(200, routeToFeature(leg)));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await httpRoutingProvider().route({ from: FROM, to: TO })).toEqual(leg);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects with network when there is no fetch", async () => {
    vi.stubGlobal("fetch", undefined);
    try {
      await expect(httpRoutingProvider().route({ from: FROM, to: TO })).rejects.toMatchObject({ code: "network" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps server errors to their codes", async () => {
    const fetch: RouteFetch = () => jsonResponse(422, { error: "no_route", message: "No path between the points" });
    await expect(httpRoutingProvider({ fetch }).route({ from: FROM, to: TO })).rejects.toMatchObject({
      name: "RoutingError",
      code: "no_route",
      message: "No path between the points",
    });
  });

  it("maps a non-JSON error body by its status", async () => {
    const fetch: RouteFetch = () =>
      Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError("not json")) });
    await expect(httpRoutingProvider({ fetch }).route({ from: FROM, to: TO })).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  });

  it("rejects a malformed success body", async () => {
    const fetch: RouteFetch = () => jsonResponse(200, { type: "Feature" });
    await expect(httpRoutingProvider({ fetch }).route({ from: FROM, to: TO })).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  });

  it("reports a failed fetch as network, with the cause", async () => {
    const cause = new TypeError("Failed to fetch");
    const fetch: RouteFetch = () => Promise.reject(cause);
    const error = await httpRoutingProvider({ fetch })
      .route({ from: FROM, to: TO })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "network", cause });
  });

  it("rethrows the abort error when the caller cancels", async () => {
    const abort = new Error("The operation was aborted");
    const signal = { aborted: true };
    const fetch: RouteFetch = () => Promise.reject(abort);
    await expect(httpRoutingProvider({ fetch }).route({ from: FROM, to: TO }, { signal })).rejects.toBe(abort);
    const midBody: RouteFetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(abort) });
    await expect(httpRoutingProvider({ fetch: midBody }).route({ from: FROM, to: TO }, { signal })).rejects.toBe(abort);
  });
});
