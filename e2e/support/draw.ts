import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { type LatLon, polylineLengthM, routeToFeature, stitchLegs } from "../../packages/core/src/index.ts";
import { parseOrsRoute } from "../../apps/worker/src/ors.ts";
import { openApp, type ColorScheme } from "./app.ts";
import { isPhone } from "./course.ts";

/**
 * Where the tests "are" when they start drawing: near Cornell, inside the fixture DEM tiles
 * (`packages/core/test/fixtures/dem`), so drawn routes get real terrain elevation.
 */
export const ITHACA = { latitude: 42.4545, longitude: -76.4795 };

const ORS_FIXTURE = new URL("../../apps/worker/test/fixtures/ors/ithaca-falls.json", import.meta.url);

interface OrsFixture {
  response: {
    body: {
      features: { geometry: { coordinates: [number, number][] }; properties: { summary: { distance: number } } }[];
    };
  };
}

/** One request the app sent to `/api/route`, and the leg it got back (none when it failed). */
export interface RouteCall {
  from: LatLon;
  to: LatLon;
  points: LatLon[] | null;
}

export interface RoutingStub {
  calls: RouteCall[];
  /** Make request number `n` (1-based) fail with `code`, as the Worker would answer it. */
  failRequest: (n: number, code?: string) => void;
}

/**
 * The ORS response for a leg from `from` to `to`: the recorded ORS fixture's line (a walk with
 * switchbacks) moved, turned and scaled so it starts exactly at `from` and ends exactly at `to`,
 * with its distance scaled to match. It is shaped like ORS output, then read by the Worker's own
 * `parseOrsRoute`, so the stub answers with exactly what `/api/route` would.
 */
function orsShapedLeg(from: LatLon, to: LatLon): LatLon[] {
  const fixture = JSON.parse(readFileSync(ORS_FIXTURE, "utf8")) as OrsFixture;
  const feature = fixture.response.body.features[0]!;
  const line = feature.geometry.coordinates;
  const k = Math.cos((from.lat * Math.PI) / 180);
  // Complex numbers in a local plane (x = lon * cos(lat), y = lat): z' = from + (z - z0) * (w / v).
  const z = ([lon, lat]: [number, number]) => ({ x: lon * k, y: lat });
  const z0 = z(line[0]!);
  const zn = z(line.at(-1)!);
  const v = { x: zn.x - z0.x, y: zn.y - z0.y };
  const w = { x: (to.lon - from.lon) * k, y: to.lat - from.lat };
  const vv = v.x * v.x + v.y * v.y;
  const r = { x: (w.x * v.x + w.y * v.y) / vv, y: (w.y * v.x - w.x * v.y) / vv };
  const coordinates = line.map((c, i): [number, number] => {
    if (i === 0) return [from.lon, from.lat];
    if (i === line.length - 1) return [to.lon, to.lat];
    const d = { x: z(c).x - z0.x, y: z(c).y - z0.y };
    const p = { x: from.lon * k + d.x * r.x - d.y * r.y, y: from.lat + d.x * r.y + d.y * r.x };
    return [p.x / k, p.y];
  });
  const scale = Math.hypot(r.x, r.y);
  const body = {
    type: "FeatureCollection",
    features: [
      {
        ...feature,
        geometry: { type: "LineString", coordinates },
        properties: { summary: { distance: feature.properties.summary.distance * scale } },
      },
    ],
  };
  return parseOrsRoute(body).points;
}

const ERROR_STATUS: Record<string, number> = { not_configured: 503, no_route: 422, upstream_unavailable: 502 };

/**
 * Answer `/api/route` in the page from the ORS fixture (see `orsShapedLeg`), recording each call.
 * Requests marked with `failRequest` get the Worker's error body instead.
 */
export async function stubRouting(page: Page): Promise<RoutingStub> {
  const calls: RouteCall[] = [];
  const failures = new Map<number, string>();
  await page.route("**/api/route", async (route) => {
    const { from, to } = route.request().postDataJSON() as { from: LatLon; to: LatLon };
    const n = calls.length + 1;
    const failure = failures.get(n);
    if (failure) {
      calls.push({ from, to, points: null });
      await route.fulfill({
        status: ERROR_STATUS[failure] ?? 502,
        contentType: "application/json",
        body: JSON.stringify({ error: failure, message: `stubbed ${failure}` }),
      });
      return;
    }
    const points = orsShapedLeg(from, to);
    calls.push({ from, to, points });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(routeToFeature({ points, distanceM: polylineLengthM(points) })),
    });
  });
  return { calls, failRequest: (n, code = "not_configured") => failures.set(n, code) };
}

/** The map area clear of the panel, the sheet and the drawing toolbar, in page pixels. */
async function drawArea(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const viewport = page.viewportSize()!;
  if (isPhone(page)) {
    const toolbar = (await page.getByTestId("draw-toolbar").boundingBox())!;
    return { x: 0, y: 0, width: viewport.width, height: toolbar.y };
  }
  const panel = (await page.getByTestId("side-panel").boundingBox())!;
  const left = panel.x + panel.width;
  const toolbar = (await page.getByTestId("draw-toolbar").boundingBox())!;
  const top = toolbar.y + toolbar.height;
  return { x: left, y: top, width: viewport.width - left, height: viewport.height - top };
}

/** A point in the drawing area, as fractions of its width and height. */
export async function mapPoint(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const area = await drawArea(page);
  return { x: Math.round(area.x + area.width * fx), y: Math.round(area.y + area.height * fy) };
}

/** Click (desktop) or tap (phones, with touch events) at a page position. */
export async function tapAt(page: Page, { x, y }: { x: number; y: number }): Promise<void> {
  if (isPhone(page)) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

/** Drag from one page position to another with the mouse (desktop) or one finger (phones). */
export async function dragFromTo(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const steps = 12;
  if (isPhone(page)) {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    await touch("touchStart", from.x, from.y);
    for (let i = 1; i <= steps; i++) {
      await touch("touchMove", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    }
    await touch("touchEnd", to.x, to.y);
    await cdp.detach();
    return;
  }
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  }
  await page.mouse.up();
}

/** The center of a handle (waypoint or leg midpoint) on screen. */
export async function handleCenter(page: Page, testId: "waypoint" | "leg-midpoint", index: number) {
  const box = (await page.getByTestId(testId).nth(index).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Open the app at `ITHACA` and start drawing the way a person does: press Draw route (in the
 * panel on desktop, in the sheet's header on a phone), and wait for the map to move to them.
 * The test must grant geolocation (`test.use({ geolocation: ITHACA, permissions: ["geolocation"] })`).
 */
export async function startDrawing(page: Page, scheme: ColorScheme = "light"): Promise<RoutingStub> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stub = await stubRouting(page);
  await openApp(page, scheme);
  await page
    .getByRole("button", { name: /^Draw route$/ })
    .locator("visible=true")
    .first()
    .click();
  const map = page.getByTestId("map");
  await expect(map).toHaveAttribute("data-drawing", "on");
  await expect(map).toHaveAttribute("data-camera", /\d+/, { timeout: 15_000 });
  await expect(page.getByTestId("draw-toolbar")).toBeVisible();
  return stub;
}

/** Add waypoints by clicking (or tapping) these spots, as fractions of the drawing area. */
export async function addPoints(page: Page, spots: [number, number][]): Promise<void> {
  for (const [fx, fy] of spots) {
    const before = await page.getByTestId("waypoint").count();
    await tapAt(page, await mapPoint(page, fx, fy));
    await expect(page.getByTestId("waypoint")).toHaveCount(before + 1);
  }
}

/** Wait until every leg has its line, and return the legs' statuses. */
export async function expectLegsSettled(page: Page, count: number): Promise<void> {
  const legs = page.getByTestId("draw-leg");
  await expect(legs).toHaveCount(count);
  await expect(page.getByTestId("draw-status")).not.toHaveAttribute("data-routing");
  await expect(page.locator('[data-testid="draw-leg"][data-status="pending"]')).toHaveCount(0);
}

/** A waypoint's position, as the marker reports it. */
export async function waypointAt(page: Page, index: number): Promise<LatLon> {
  const marker = page.getByTestId("waypoint").nth(index);
  return { lat: Number(await marker.getAttribute("data-lat")), lon: Number(await marker.getAttribute("data-lon")) };
}

/** The positions of every waypoint, in order. */
export async function waypoints(page: Page): Promise<LatLon[]> {
  const count = await page.getByTestId("waypoint").count();
  const out: LatLon[] = [];
  for (let i = 0; i < count; i++) out.push(await waypointAt(page, i));
  return out;
}

/** The length (m) of the route through `waypoints`, legs looked up in `calls` or straight (`straight` legs). */
export function routeLengthM(stub: RoutingStub, points: LatLon[], straight: Set<number> = new Set()): number {
  const legs = points.slice(1).map((to, i) => {
    const from = points[i]!;
    if (straight.has(i)) return [from, to];
    const same = (a: LatLon, b: LatLon) => a.lat === b.lat && a.lon === b.lon;
    const call = stub.calls.find((c) => c.points && same(c.from, from) && same(c.to, to));
    if (call?.points) return call.points;
    const reverse = stub.calls.find((c) => c.points && same(c.from, to) && same(c.to, from));
    if (reverse?.points) return [...reverse.points].reverse();
    throw new Error(`no route call for leg ${i}`);
  });
  return polylineLengthM(stitchLegs(legs));
}

export const METERS_PER_MILE = 1609.344;

/** The distance the panel shows while drawing, in its units. */
export async function shownDistance(page: Page): Promise<number> {
  const text = (await page.getByTestId("draw-distance").innerText()).replace(/,/g, "");
  return Number.parseFloat(text);
}

/** Expect the panel's distance to be `meters`, in miles to the two decimals it shows. */
export async function expectDistance(page: Page, meters: number): Promise<void> {
  await expect.poll(() => shownDistance(page)).toBeCloseTo(meters / METERS_PER_MILE, 2);
}

/** On a phone, raise the sheet to half so the route editor's controls are in reach (the map stays above it). */
export async function showEditor(page: Page): Promise<void> {
  if (!isPhone(page)) return;
  const sheet = page.getByTestId("sheet");
  if ((await sheet.getAttribute("data-snap")) !== "peek") return;
  await page.getByTestId("sheet-handle").click();
  await expect(sheet).toHaveAttribute("data-snap", "half");
}
