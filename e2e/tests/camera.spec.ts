import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { buildShareLink, parseGpx } from "../../packages/core/src/index.ts";
import { openApp } from "../support/app.ts";
import { corpusPath, expectRouteDrawn, isPhone, uploadGpx } from "../support/course.ts";
import { freshContext, openLink } from "../support/share.ts";

// B10: the map comes back where the user last looked; a share link still frames its course.

interface View {
  lat: number;
  lon: number;
  zoom: number;
}

const parseView = (value: string | null): View => {
  const [lat = NaN, lon = NaN, zoom = NaN] = (value ?? "").split(" ").map(Number);
  return { lat, lon, zoom };
};

/** The camera once it rests: the middle of the whole map, and the zoom. */
async function view(page: Page): Promise<View> {
  return parseView(await page.getByTestId("map").getAttribute("data-view"));
}

/** The camera kept in storage, or null. */
async function savedView(page: Page): Promise<View | null> {
  const text = await page.evaluate(() => localStorage.getItem("pp:camera"));
  if (!text) return null;
  const { lat, lon, zoom } = JSON.parse(text) as View;
  return { lat, lon, zoom };
}

/** Within a few meters and a hundredth of a zoom level. */
function expectSameView(actual: View, expected: View): void {
  expect(actual.lat).toBeCloseTo(expected.lat, 4);
  expect(actual.lon).toBeCloseTo(expected.lon, 4);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 2);
}

/** A point on the map clear of the panel (desktop) or the sheet (phone), as a fraction of it. */
async function mapPoint(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const viewport = page.viewportSize()!;
  const left = isPhone(page) ? 0 : (await page.getByTestId("side-panel").boundingBox())!.width + 16;
  const bottom = isPhone(page) ? (await page.getByTestId("sheet").boundingBox())!.y : viewport.height;
  return { x: left + (viewport.width - left) * fx, y: bottom * fy };
}

/** Pan the map by dragging it, then zoom in with the wheel, as a person does; wait until it is saved. */
async function panAndZoom(page: Page): Promise<View> {
  const before = await view(page);
  const from = await mapPoint(page, 0.6, 0.55);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 90, from.y - 60, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await view(page)).lon).not.toBeCloseTo(before.lon, 3);
  // A double tap zooms in on a phone (a pinch is not scriptable), the wheel on desktop.
  const at = await mapPoint(page, 0.4, 0.4);
  if (isPhone(page)) {
    await page.touchscreen.tap(at.x, at.y);
    await page.touchscreen.tap(at.x, at.y);
  } else {
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, -400);
  }
  await expect.poll(async () => (await view(page)).zoom).toBeGreaterThan(before.zoom + 0.5);
  // The camera is written a moment after the map rests.
  await expect
    .poll(async () => {
      const saved = await savedView(page);
      const shown = await view(page);
      return saved !== null && Math.abs(saved.lat - shown.lat) + Math.abs(saved.lon - shown.lon) < 1e-4;
    })
    .toBe(true);
  return view(page);
}

/** Record every view the map shows from the start of each page load, to catch a move on start-up. */
async function recordViews(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { ppViews: string[] }).ppViews = seen;
    new MutationObserver(() => {
      const value = document.querySelector("[data-testid=map]")?.getAttribute("data-view");
      if (value && seen.at(-1) !== value) seen.push(value);
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-view"] });
  });
}

const recordedViews = async (page: Page): Promise<View[]> =>
  (await page.evaluate(() => (window as unknown as { ppViews: string[] }).ppViews)).map(parseView);

/** The route sits in the map, clear of the panel (desktop) or above the sheet (phone). */
async function expectRouteFramed(page: Page): Promise<void> {
  const map = page.getByTestId("map");
  await expect(map).toHaveAttribute("data-route-box", /\d/);
  const [left = NaN, top = NaN, right = NaN, bottom = NaN] = ((await map.getAttribute("data-route-box")) ?? "")
    .split(" ")
    .map(Number);
  const viewport = page.viewportSize()!;
  const clearLeft = isPhone(page) ? 0 : (await page.getByTestId("side-panel").boundingBox())!.width;
  const clearBottom = isPhone(page) ? (await page.getByTestId("sheet").boundingBox())!.y : viewport.height;
  expect(left).toBeGreaterThan(clearLeft);
  expect(top).toBeGreaterThan(0);
  expect(right).toBeLessThan(viewport.width);
  expect(bottom).toBeLessThan(clearBottom);
}

async function reload(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByTestId("map")).toHaveAttribute("data-map-state", "ready", { timeout: 15_000 });
}

test("a reload brings the map back where it was left, with no move on the way", async ({ page }) => {
  await recordViews(page);
  await openApp(page);
  const start = await view(page);
  expect(await savedView(page)).toBeNull();
  const left = await panAndZoom(page);
  await reload(page);
  expectSameView(await view(page), left);
  // The map started there: it never showed the whole-US view first, or moved.
  const views = await recordedViews(page);
  expect(views.length).toBeGreaterThan(0);
  for (const shown of views) expectSameView(shown, left);
  expect(Math.abs(left.zoom - start.zoom)).toBeGreaterThan(0.5);
});

test("the saved view wins over framing the restored course", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  await uploadGpx(page, corpusPath("boston.gpx"));
  await expectRouteDrawn(page);
  const framed = await view(page);
  const left = await panAndZoom(page);
  expect(Math.abs(left.zoom - framed.zoom)).toBeGreaterThan(0.5);
  await reload(page);
  await expectRouteDrawn(page);
  await expect(page.getByTestId("course-title")).toBeVisible();
  expectSameView(await view(page), left);
});

test("without a saved view, a restored course is still framed", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  await uploadGpx(page, corpusPath("boston.gpx"));
  await expectRouteDrawn(page);
  const framed = await view(page);
  // Forget the view, including one still waiting to be written when the page hides.
  await page.evaluate(() => {
    localStorage.removeItem("pp:camera");
    window.addEventListener("pagehide", () => localStorage.removeItem("pp:camera"));
  });
  await reload(page);
  await expectRouteDrawn(page);
  // Framed again (on a phone the sheet can rest higher now, so the view need not match exactly).
  await expectRouteFramed(page);
  expect((await view(page)).zoom).toBeCloseTo(framed.zoom, 0);
});

test("a share link frames its course, not the saved view", async ({ browser }, testInfo) => {
  const points = parseGpx(readFileSync(corpusPath("Lakefront-Loops-5K.gpx"), "utf8")).tracks[0]!.course.points;
  const base = new URL("/", testInfo.project.use.baseURL).href;
  const link = buildShareLink(base, {
    course: { kind: "track", points },
    settings: { goalTimeS: 1500, paceChanges: 2, minSegmentM: 0, unit: "mi" },
    name: "Lakefront",
  })!.url;
  // Somewhere else entirely: Denver, close in.
  const denver = { lat: 39.7392, lon: -104.9903, zoom: 12 };
  const context = await freshContext(browser, testInfo);
  await context.addInitScript((saved) => {
    if (!localStorage.getItem("pp:camera")) localStorage.setItem("pp:camera", JSON.stringify({ v: 1, ...saved }));
  }, denver);
  const page = await context.newPage();
  await openLink(page, link);
  await expectRouteDrawn(page);
  await expect(page.getByTestId("course-title")).toHaveText("Lakefront");
  // Framed on Ithaca, not left at Denver.
  await expectRouteFramed(page);
  const shown = await view(page);
  expect(shown.lat).toBeCloseTo(42.44, 0);
  expect(shown.lon).toBeCloseTo(-76.5, 0);
  await context.close();
});

const CORRUPT: [string, string][] = [
  ["not JSON", "{lat: 42"],
  ["another version", JSON.stringify({ v: 9, lat: 42, lon: -71, zoom: 12 })],
  ["out of range", JSON.stringify({ v: 1, lat: 95, lon: -71, zoom: 12 })],
  ["a zoom out of range", JSON.stringify({ v: 1, lat: 42, lon: -71, zoom: 40 })],
];

test("a corrupt or out-of-range saved view falls back to the default", async ({ page, browser }, testInfo) => {
  await openApp(page);
  const fallback = await view(page);
  for (const [, value] of CORRUPT) {
    const context = await freshContext(browser, testInfo);
    await context.addInitScript((text) => localStorage.setItem("pp:camera", text), value);
    const other = await context.newPage();
    const errors: string[] = [];
    other.on("pageerror", (error) => errors.push(error.message));
    await openApp(other);
    expectSameView(await view(other), fallback);
    expect(errors).toEqual([]);
    await context.close();
  }
});

test.describe("desktop", () => {
  test.skip(({ page }) => isPhone(page), "the resizable panel is desktop only");

  test("with a wider panel, a reload brings back the same view and width", async ({ page }) => {
    await openApp(page);
    const separator = page.getByRole("separator", { name: "Resize panel" });
    await separator.focus();
    for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "512");
    const left = await panAndZoom(page);
    await reload(page);
    await expect(separator).toHaveAttribute("aria-valuenow", "512");
    expectSameView(await view(page), left);
  });
});
