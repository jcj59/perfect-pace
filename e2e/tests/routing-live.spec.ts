import { expect, test } from "@playwright/test";

// @live: calls real OpenRouteService through the deployed Worker's /api/route, so it runs only in
// the Nightly workflow (against production), and only when the ORS_API_KEY repository secret is
// set (the Deploy workflow uploads it to the Worker). Each run spends one request of the free ORS
// quota. Do not tag it @smoke: an ORS outage must not roll back a deploy.
const KEY_SET = process.env["PP_ORS_KEY_SET"] === "1";

test.describe("routing @live", () => {
  test.skip(
    !KEY_SET,
    "PP_ORS_KEY_SET is not 1: the ORS_API_KEY repository secret is not set (or this is not the Nightly run), so live routing is skipped",
  );

  test("/api/route snaps a Central Park leg to footpaths", async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "an API test: once is enough, to save ORS quota");
    const from = { lat: 40.77423, lon: -73.97169 };
    const to = { lat: 40.78267, lon: -73.96463 };
    const res = await request.post("/api/route", { data: { from, to, profile: "foot-walking" } });
    const body = (await res.json()) as {
      type: string;
      geometry: { type: string; coordinates: [number, number][] };
      properties: { distanceM: number; profile: string };
      error?: string;
    };
    expect(res.status(), `error ${body.error ?? "none"}`).toBe(200);
    expect(body.type).toBe("Feature");
    expect(body.geometry.type).toBe("LineString");
    expect(body.properties.profile).toBe("foot-walking");
    const line = body.geometry.coordinates;
    expect(line.length).toBeGreaterThan(2);
    // Starts and ends near the requested points (ORS snaps to the nearest path, within 350 m).
    const [first, last] = [line[0]!, line[line.length - 1]!];
    expect(Math.abs(first[1] - from.lat) + Math.abs(first[0] - from.lon)).toBeLessThan(0.005);
    expect(Math.abs(last[1] - to.lat) + Math.abs(last[0] - to.lon)).toBeLessThan(0.005);
    // The straight line is about 1.07 km; a walking route is longer, but not absurdly so.
    expect(body.properties.distanceM).toBeGreaterThan(1000);
    expect(body.properties.distanceM).toBeLessThan(3000);
  });
});
