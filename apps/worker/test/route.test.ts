import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { ROUTE_RATE_LIMIT, ROUTE_RATE_PERIOD_S } from "../src/route.ts";
import atlanticOcean from "./fixtures/ors/atlantic-ocean.json";
import centralPark from "./fixtures/ors/central-park.json";
import ithacaFalls from "./fixtures/ors/ithaca-falls.json";

// The test key comes from `miniflare.bindings` in vitest.config.ts.
const TEST_KEY = "test-ors-key";

interface LatLon {
  lat: number;
  lon: number;
}
interface Fixture {
  source: string;
  case: { name: string; from: LatLon; to: LatLon };
  upstream: { url: string; body: unknown };
  response: { status: number; body: unknown };
}
const FIXTURES = [centralPark, ithacaFalls, atlanticOcean] as Fixture[];

interface UpstreamCall {
  url: string;
  headers: Headers;
  body: unknown;
}
let calls: UpstreamCall[] = [];
type Upstream = (call: UpstreamCall) => Response | Promise<Response>;

/** Replaces the global `fetch` (which the Worker uses to reach ORS) with `upstream`. */
function mockUpstream(upstream: Upstream): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const call = { url: request.url, headers: request.headers, body: await request.json() };
    calls.push(call);
    return upstream(call);
  });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Answers every upstream request with the fixture whose recorded request body matches. */
const replayFixtures: Upstream = ({ body }) => {
  const fixture = FIXTURES.find((f) => JSON.stringify(f.upstream.body) === JSON.stringify(body));
  if (!fixture) throw new Error(`no ORS fixture for ${JSON.stringify(body)}`);
  return jsonResponse(fixture.response.status, fixture.response.body);
};

const okFeatureCollection = (coordinates: number[][], distance?: number): unknown => ({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { summary: distance === undefined ? {} : { distance, duration: distance * 0.72 } },
      geometry: { type: "LineString", coordinates },
    },
  ],
});

let ipCounter = 0;
let legCounter = 0;
/** A fresh leg (its own cache key) near Central Park. */
function uniqueLeg(): { from: LatLon; to: LatLon } {
  legCounter++;
  return { from: { lat: 40.7 + legCounter * 0.001, lon: -73.97 }, to: { lat: 40.7 + legCounter * 0.001, lon: -73.96 } };
}

interface PostOptions {
  ip?: string;
  method?: string;
  env?: Partial<typeof env> & { ORS_API_KEY?: string };
}

async function post(body: unknown, options: PostOptions = {}): Promise<Response> {
  const ip = options.ip ?? `198.51.100.${++ipCounter % 250}`;
  const method = options.method ?? "POST";
  // Typed as an incoming request (with `cf`) for the handler; the tests send no `cf` object.
  const request = new Request<unknown, IncomingRequestCfProperties>("https://perfect-pace.test/api/route", {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, ...options.env }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

interface ErrorBody {
  error: string;
  message: string;
  retryAfterS?: number;
}

async function expectError(response: Response, status: number, code: string): Promise<ErrorBody> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = await response.json<ErrorBody>();
  expect(body.error).toBe(code);
  expect(typeof body.message).toBe("string");
  expect(JSON.stringify(body)).not.toContain(TEST_KEY);
  return body;
}

beforeEach(() => {
  calls = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/route with recorded ORS responses", () => {
  it("has every fixture listed in cases.json", async () => {
    const cases = (await import("./fixtures/ors/cases.json")).default as { name: string }[];
    expect(FIXTURES.map((f) => f.case.name).sort()).toEqual(cases.map((c) => c.name).sort());
  });

  it.each(FIXTURES.filter((f) => f.response.status === 200).map((f) => [f.case.name, f] as const))(
    "routes %s, then serves it from the cache without calling ORS",
    async (_, fixture) => {
      mockUpstream(replayFixtures);
      const { from, to } = fixture.case;

      const first = await post({ from, to, profile: "foot-walking" });
      expect(first.status).toBe(200);
      expect(first.headers.get("x-route-cache")).toBe("miss");
      expect(first.headers.get("cache-control")).toBe("no-store");
      const feature = await first.json<{
        type: string;
        geometry: { type: string; coordinates: number[][] };
        properties: { distanceM: number; profile: string };
      }>();
      const upstreamFeature = (
        fixture.response.body as {
          features: { geometry: { coordinates: number[][] }; properties: { summary: { distance: number } } }[];
        }
      ).features[0]!;
      expect(feature).toEqual({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: upstreamFeature.geometry.coordinates.map(([lon, lat]) => [lon, lat]),
        },
        properties: { distanceM: upstreamFeature.properties.summary.distance, profile: "foot-walking" },
      });

      // The Worker sends exactly the recorded request, with the key in the Authorization header.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(fixture.upstream.url);
      expect(calls[0]!.body).toEqual(fixture.upstream.body);
      expect(calls[0]!.headers.get("authorization")).toBe(TEST_KEY);

      // The same leg again, and one that differs only below the rounding (about 1 m): cache hits.
      const second = await post({ from, to });
      expect(second.headers.get("x-route-cache")).toBe("hit");
      expect(await second.json()).toEqual(feature);
      const nudged = await post({ from: { lat: from.lat + 2e-6, lon: from.lon - 2e-6 }, to });
      expect(nudged.headers.get("x-route-cache")).toBe("hit");
      expect(calls).toHaveLength(1);
    },
  );

  it("answers no_route when ORS finds no routable point, and does not cache it", async () => {
    mockUpstream(replayFixtures);
    const { from, to } = atlanticOcean.case;
    await expectError(await post({ from, to }), 422, "no_route");
    await expectError(await post({ from, to }), 422, "no_route");
    expect(calls).toHaveLength(2);
  });
});

describe("/api/route input validation", () => {
  it.each([
    ["not JSON", "{from:", /JSON/],
    ["an array", [1, 2], /JSON object/],
    ["a missing to", { from: { lat: 40, lon: -73 } }, /^to must be/],
    ["a latitude out of range", { from: { lat: 95, lon: -73 }, to: { lat: 40, lon: -73 } }, /from\.lat/],
    ["a string longitude", { from: { lat: 40, lon: "-73" }, to: { lat: 40, lon: -73 } }, /from\.lon/],
    ["another profile", { ...uniqueLeg(), profile: "driving-car" }, /profile/],
    ["a leg over 100 km", { from: { lat: 40, lon: -73 }, to: { lat: 41, lon: -73 } }, /100 km/],
    ["an oversized body", JSON.stringify({ ...uniqueLeg(), pad: "x".repeat(4000) }), /at most 2048 bytes/],
  ])("rejects %s with invalid_request and no upstream call", async (_, body, message) => {
    mockUpstream(replayFixtures);
    const error = await expectError(await post(body), 400, "invalid_request");
    expect(error.message).toMatch(message);
    expect(calls).toHaveLength(0);
  });

  it("only accepts POST", async () => {
    const response = await post(undefined, { method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
  });

  it("answers a leg that starts where it ends without routing it", async () => {
    mockUpstream(replayFixtures);
    const point = { lat: 40.77423, lon: -73.97169 };
    const response = await post({ from: point, to: { lat: point.lat + 1e-6, lon: point.lon } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [point.lon, point.lat],
          [point.lon, point.lat],
        ],
      },
      properties: { distanceM: 0, profile: "foot-walking" },
    });
    expect(calls).toHaveLength(0);
  });
});

describe("/api/route without an API key", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "  "],
  ])("answers not_configured when the key is %s, without calling ORS", async (_, key) => {
    mockUpstream(replayFixtures);
    const error = await expectError(await post(uniqueLeg(), { env: { ORS_API_KEY: key } }), 503, "not_configured");
    expect(error.message).toContain("ORS_API_KEY");
    expect(calls).toHaveLength(0);
  });
});

describe("/api/route rate limiting", () => {
  it(`allows ${ROUTE_RATE_LIMIT} upstream requests per IP per minute, then answers rate_limited`, async () => {
    mockUpstream(({ body }) => {
      const coordinates = (body as { coordinates: number[][] }).coordinates;
      return jsonResponse(200, okFeatureCollection(coordinates, 850));
    });
    const ip = "203.0.113.7";
    const cached = uniqueLeg();
    expect((await post(cached, { ip })).status).toBe(200);
    for (let i = 1; i < ROUTE_RATE_LIMIT; i++) {
      expect((await post(uniqueLeg(), { ip })).status, `request ${i + 1}`).toBe(200);
    }
    expect(calls).toHaveLength(ROUTE_RATE_LIMIT);

    const limited = await post(uniqueLeg(), { ip });
    const error = await expectError(limited, 429, "rate_limited");
    expect(error.retryAfterS).toBe(ROUTE_RATE_PERIOD_S);
    expect(limited.headers.get("retry-after")).toBe(String(ROUTE_RATE_PERIOD_S));
    expect(calls).toHaveLength(ROUTE_RATE_LIMIT);

    // Cache hits cost nothing, so a limited client still gets legs it already routed.
    const hit = await post(cached, { ip });
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-route-cache")).toBe("hit");

    // Other clients are unaffected.
    expect((await post(uniqueLeg(), { ip: "203.0.113.8" })).status).toBe(200);
  });
});

describe("/api/route upstream error mapping", () => {
  it.each([
    [
      "429 with Retry-After",
      jsonResponse(429, { error: "Rate limit exceeded" }, { "retry-after": "120" }),
      503,
      "upstream_rate_limited",
      120,
    ],
    ["429 without Retry-After", jsonResponse(429, { error: "Rate limit exceeded" }), 503, "upstream_rate_limited", 60],
    [
      "403 (bad key)",
      jsonResponse(403, { error: "Access to this API has been disallowed" }),
      503,
      "not_configured",
      undefined,
    ],
    [
      "401 (no key)",
      jsonResponse(401, { error: "Daily quota reached or API key unauthorized" }),
      503,
      "not_configured",
      undefined,
    ],
    [
      "404 error 2009",
      jsonResponse(404, { error: { code: 2009, message: "Route could not be found" } }),
      422,
      "no_route",
      undefined,
    ],
    ["404 without a code", new Response("Not Found", { status: 404 }), 422, "no_route", undefined],
    [
      "400 error 2004",
      jsonResponse(400, { error: { code: 2004, message: "distance exceeds limit" } }),
      400,
      "invalid_request",
      undefined,
    ],
    [
      "400 error 2003",
      jsonResponse(400, { error: { code: 2003, message: "Parameter has incorrect value" } }),
      502,
      "upstream_unavailable",
      undefined,
    ],
    [
      "500 error 2099",
      jsonResponse(500, { error: { code: 2099, message: "Unknown internal error" } }),
      502,
      "upstream_unavailable",
      undefined,
    ],
    [
      "502 HTML from a proxy",
      new Response("<html>Bad Gateway</html>", { status: 502 }),
      502,
      "upstream_unavailable",
      undefined,
    ],
    [
      "200 with no features",
      jsonResponse(200, { type: "FeatureCollection", features: [] }),
      502,
      "upstream_unavailable",
      undefined,
    ],
    [
      "200 with a Point",
      jsonResponse(200, { features: [{ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] } }] }),
      502,
      "upstream_unavailable",
      undefined,
    ],
    [
      "200 with bad coordinates",
      jsonResponse(200, okFeatureCollection([[-73, 40]], 10)),
      502,
      "upstream_unavailable",
      undefined,
    ],
    ["200 that is not JSON", new Response("ok", { status: 200 }), 502, "upstream_unavailable", undefined],
  ] as const)("maps ORS %s to %i %s", async (_, upstream, status, code, retryAfterS) => {
    mockUpstream(() => upstream.clone());
    const response = await post(uniqueLeg());
    const error = await expectError(response, status, code);
    expect(error.retryAfterS).toBe(retryAfterS);
    expect(response.headers.get("retry-after")).toBe(retryAfterS === undefined ? null : String(retryAfterS));
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["a network failure", new TypeError("Network connection lost")],
    ["a timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
  ])("maps %s to 502 upstream_unavailable", async (_, failure) => {
    mockUpstream(() => Promise.reject(failure));
    await expectError(await post(uniqueLeg()), 502, "upstream_unavailable");
  });

  it("does not cache failures", async () => {
    mockUpstream(() => jsonResponse(500, { error: { code: 2099, message: "Unknown internal error" } }));
    const leg = uniqueLeg();
    await expectError(await post(leg), 502, "upstream_unavailable");
    await expectError(await post(leg), 502, "upstream_unavailable");
    expect(calls).toHaveLength(2);
  });

  it("measures the line when ORS leaves out a zero or missing distance", async () => {
    const coordinates = [
      [-73.97, 40.77],
      [-73.97, 40.771],
    ];
    mockUpstream(() => jsonResponse(200, okFeatureCollection(coordinates)));
    const response = await post(uniqueLeg());
    expect(response.status).toBe(200);
    const body = await response.json<{ properties: { distanceM: number } }>();
    expect(body.properties.distanceM).toBeCloseTo(111.2, 1);
  });
});
