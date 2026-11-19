import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { haversineM, parseGpx, pointAtDistance } from "../../packages/core/src/index.ts";
import { openApp } from "../support/app.ts";
import { METERS_PER_MILE, corpusPath, expectRouteDrawn, golden, isPhone, uploadGpx } from "../support/course.ts";

const FEET_PER_METER = 1 / 0.3048;
/** The marker sits on the 10 m resampled profile; the raw track is the reference. */
const MARKER_TOLERANCE_M = 15;

/** The default track's course, parsed the same way the app parses it. */
function courseOf(file: string) {
  const parsed = parseGpx(readFileSync(corpusPath(file), "utf8"));
  return parsed.tracks[golden(file).defaultTrack]!.course;
}

async function loadCourse(page: Page, file: string): Promise<Locator> {
  await openApp(page);
  await uploadGpx(page, corpusPath(file));
  await expectRouteDrawn(page);
  const chart = page.getByRole("slider", { name: "Elevation profile" });
  await expect(chart).toBeVisible();
  await expect(chart).toBeInViewport();
  return chart;
}

/** The plotted line's horizontal extent on screen: start of the course to its finish. */
async function plotSpan(page: Page): Promise<{ left: number; width: number; y: number }> {
  const box = (await page.getByTestId("chart-line").boundingBox())!;
  return { left: box.x, width: box.width, y: box.y + box.height / 2 };
}

/** The distance (m) the chart is pointing at, or null when its cursor is hidden. */
async function focusM(chart: Locator): Promise<number | null> {
  const value = await chart.getAttribute("data-focus-m");
  return value === null ? null : Number(value);
}

/** The map marker's center on screen, after checking it sits where the course is at `distM`. */
async function expectMarkerAt(page: Page, course: ReturnType<typeof courseOf>, distM: number) {
  const marker = page.getByTestId("map-marker");
  await expect(marker).toBeVisible();
  const lat = Number(await marker.getAttribute("data-lat"));
  const lon = Number(await marker.getAttribute("data-lon"));
  const expected = pointAtDistance(course, distM);
  expect(haversineM({ lat, lon }, expected)).toBeLessThan(MARKER_TOLERANCE_M);
  const box = (await marker.boundingBox())!;
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // On the map, clear of the panel or the sheet.
  const viewport = page.viewportSize()!;
  if (isPhone(page)) {
    const sheetTop = (await page.getByTestId("sheet").boundingBox())!.y;
    expect(center.y).toBeLessThan(sheetTop);
  } else {
    const panel = (await page.getByTestId("side-panel").boundingBox())!;
    expect(center.x).toBeGreaterThan(panel.x + panel.width);
  }
  expect(center.x).toBeGreaterThan(0);
  expect(center.x).toBeLessThan(viewport.width);
  expect(center.y).toBeGreaterThan(0);
  return center;
}

// B3: the profile is there even when the file has no elevation (it comes from the fixture DEM).
test("a GPX without elevation still shows an elevation profile", async ({ page }) => {
  const expected = golden("no-elevation.gpx");
  expect(expected.elevation.source).toBe("dem");
  const chart = await loadCourse(page, "no-elevation.gpx");
  await expect(page.getByTestId("elevation-source")).toContainText("terrain data");
  const line = page.getByTestId("chart-line");
  const d = (await line.getAttribute("d")) ?? "";
  expect(d.split("L").length).toBeGreaterThan(20);
  // The elevation axis spans the course's real range, in feet.
  const ticks = (await page.getByTestId("chart-y-ticks").locator("text").allTextContents()).map((t) =>
    Number.parseFloat(t.replace(/,/g, "")),
  );
  expect(Math.min(...ticks)).toBeLessThanOrEqual(expected.elevation.minM * FEET_PER_METER);
  expect(Math.max(...ticks)).toBeGreaterThanOrEqual(expected.elevation.maxM * FEET_PER_METER);
  await expect(page.getByTestId("chart-y-ticks")).toContainText("ft");
  await expect(page.getByTestId("chart-x-ticks")).toContainText("mi");
  await expect(chart).toHaveAttribute("aria-valuemax", (expected.tracks[0]!.distanceM / METERS_PER_MILE).toFixed(2));
});

test("the axes follow the units switch", async ({ page }) => {
  await loadCourse(page, "boston.gpx");
  const xTicks = page.getByTestId("chart-x-ticks");
  await expect(xTicks).toContainText("mi");
  await page.getByText("km", { exact: true }).click();
  await expect(xTicks).toContainText("km");
  await expect(xTicks).not.toContainText("mi");
  await expect(page.getByTestId("chart-y-ticks")).toContainText(" m");
  // A marathon: 0 to 40 km in whole steps, readable at every width.
  const labels = await xTicks.locator("text").allTextContents();
  expect(labels.length).toBeGreaterThanOrEqual(3);
  expect(labels.length).toBeLessThanOrEqual(8);
  expect(labels[0]).toBe("0");
});

test.describe("hovering the chart", () => {
  test.skip(({ page }) => isPhone(page), "a mouse gesture; phones scrub by touch below");

  test("moves a marker along the route on the map", async ({ page }) => {
    const course = courseOf("boston.gpx");
    const length = course.points.at(-1)!.distM;
    const chart = await loadCourse(page, "boston.gpx");
    await expect(page.getByTestId("map-marker")).toHaveCount(0);
    const span = await plotSpan(page);

    const centers = [];
    for (const fraction of [0.25, 0.5, 0.75]) {
      await page.mouse.move(span.left + span.width * fraction, span.y);
      await expect(page.getByTestId("chart-cursor")).toBeVisible();
      const at = (await focusM(chart))!;
      expect(Math.abs(at - length * fraction)).toBeLessThan(length / 100);
      await expect(page.getByTestId("chart-readout")).toContainText(`${(at / METERS_PER_MILE).toFixed(2)} mi`);
      centers.push(await expectMarkerAt(page, course, at));
    }
    // Boston runs west to east, so the marker heads right as the cursor does.
    expect(centers[1]!.x).toBeGreaterThan(centers[0]!.x);
    expect(centers[2]!.x).toBeGreaterThan(centers[1]!.x);

    // Leaving the chart clears both.
    await page.mouse.move(span.left + span.width / 2, span.y + 200);
    await expect(page.getByTestId("map-marker")).toHaveCount(0);
    await expect(page.getByTestId("chart-cursor")).toHaveCount(0);
  });

  test("hovering the route on the map highlights that point on the chart", async ({ page }) => {
    const course = courseOf("boston.gpx");
    const chart = await loadCourse(page, "boston.gpx");
    const span = await plotSpan(page);
    // Find a spot on the route: where the chart puts the marker at 60% of the course.
    await page.mouse.move(span.left + span.width * 0.6, span.y);
    const picked = (await focusM(chart))!;
    const onRoute = await expectMarkerAt(page, course, picked);
    // Away from the chart and the route: nothing is highlighted.
    await page.mouse.move(onRoute.x, 40);
    await expect(page.getByTestId("chart-cursor")).toHaveCount(0);

    await page.mouse.move(onRoute.x, onRoute.y, { steps: 5 });
    await expect(page.getByTestId("chart-cursor")).toBeVisible();
    await expect(page.getByTestId("chart-readout")).toBeVisible();
    const highlighted = (await focusM(chart))!;
    // Within a few pixels of the same spot, at Boston's framing (about 60 m a pixel).
    expect(Math.abs(highlighted - picked)).toBeLessThan(400);
    await expectMarkerAt(page, course, highlighted);

    // Off the route again: the highlight goes.
    await page.mouse.move(onRoute.x, 40, { steps: 5 });
    await expect(page.getByTestId("chart-cursor")).toHaveCount(0);
    await expect(page.getByTestId("map-marker")).toHaveCount(0);
  });
});

test.describe("touch", () => {
  test.skip(({ page }) => !isPhone(page), "phone touch scrub");

  test("dragging along the chart moves the marker, which stays until the next tap elsewhere", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "touch drags go through CDP, Chromium only: https://github.com/jcj59/perfect-pace/issues/42",
    );
    const course = courseOf("boston.gpx");
    const length = course.points.at(-1)!.distM;
    const chart = await loadCourse(page, "boston.gpx");
    const span = await plotSpan(page);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });

    const from = span.left + span.width * 0.2;
    const to = span.left + span.width * 0.7;
    await touch("touchStart", from, span.y);
    await expect(page.getByTestId("chart-cursor")).toBeVisible();
    const start = (await focusM(chart))!;
    expect(Math.abs(start - length * 0.2)).toBeLessThan(length / 50);
    const first = await expectMarkerAt(page, course, start);
    for (let i = 1; i <= 10; i++) await touch("touchMove", from + ((to - from) * i) / 10, span.y);
    await touch("touchEnd", to, span.y);

    const end = (await focusM(chart))!;
    expect(Math.abs(end - length * 0.7)).toBeLessThan(length / 50);
    const last = await expectMarkerAt(page, course, end);
    expect(last.x).toBeGreaterThan(first.x);
    // The scrub did not scroll the sheet or move it.
    await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "half");

    // Still showing after the finger lifts; a tap on the map clears it.
    await page.waitForTimeout(300);
    await expect(page.getByTestId("map-marker")).toBeVisible();
    await page.touchscreen.tap(20, 60);
    await expect(page.getByTestId("map-marker")).toHaveCount(0);
    await expect(page.getByTestId("chart-cursor")).toHaveCount(0);
  });
});

test("the arrow keys scrub the chart", async ({ page }) => {
  const course = courseOf("boston.gpx");
  const length = course.points.at(-1)!.distM;
  const chart = await loadCourse(page, "boston.gpx");
  await chart.focus();
  await page.keyboard.press("Home");
  await expect(chart).toHaveAttribute("aria-valuenow", "0");
  await expect(chart).toHaveAttribute("aria-valuetext", /^0\.00 mi, elevation \d+ ft$/);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(chart).toHaveAttribute("aria-valuenow", "0.2");
  await expectMarkerAt(page, course, (await focusM(chart))!);
  await page.keyboard.press("PageUp");
  await expect(chart).toHaveAttribute("aria-valuenow", "1.2");
  await page.keyboard.press("ArrowLeft");
  await expect(chart).toHaveAttribute("aria-valuenow", "1.1");
  await page.keyboard.press("End");
  await expect(chart).toHaveAttribute("aria-valuenow", (length / METERS_PER_MILE).toFixed(2));
  await expectMarkerAt(page, course, length);
  await chart.blur();
  await expect(page.getByTestId("map-marker")).toHaveCount(0);
});

test("a scrubbed chart has no axe violations", async ({ page }) => {
  const chart = await loadCourse(page, "boston.gpx");
  await chart.focus();
  await page.keyboard.press("PageUp");
  await expect(page.getByTestId("chart-cursor")).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
