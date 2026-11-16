import { expect, test, type Page } from "@playwright/test";
import { parseGpx, polylineLengthM } from "../../packages/core/src/index.ts";
import { openApp } from "../support/app.ts";
import { corpusPath, expectRouteDrawn, isPhone, statNumber, uploadGpx } from "../support/course.ts";
import { ITHACA, addPoints, expectLegsSettled, startDrawing } from "../support/draw.ts";
import { changePlan, enterGoal, expectPlanSettled, planBoston, seconds } from "../support/plan.ts";
import { copyShareLink, downloadFrom, freshContext, openLink, planSnapshot } from "../support/share.ts";

// B6: share links, the saved session, and the exports. `/api/route` is stubbed from the ORS
// fixture (support/draw.ts) in every page, so a drawn route routes the same everywhere.
// Only Chromium has clipboard permissions (Playwright rejects them elsewhere); Firefox and WebKit let
// a click write the clipboard, and the page read back what it wrote, without one.
test.use({
  geolocation: ITHACA,
  permissions: async ({ browserName }, use) =>
    use(["geolocation", ...(browserName === "chromium" ? ["clipboard-read", "clipboard-write"] : [])]),
});

const FOUR: [number, number][] = [
  [0.25, 0.3],
  [0.7, 0.25],
  [0.75, 0.7],
  [0.3, 0.75],
];

/** Draw four points, press Done, and plan the route for 25:00 with 3 changes and no minimum. */
async function planDrawnRoute(page: Page): Promise<void> {
  await startDrawing(page);
  await addPoints(page, FOUR);
  await expectLegsSettled(page, 3);
  await page.getByRole("button", { name: "Done" }).locator("visible=true").first().click();
  await expect(page.getByTestId("map")).toHaveAttribute("data-course", "drawn", { timeout: 15_000 });
  await expectPlanSettled(page);
  await changePlan(page, () => enterGoal(page, "25:00"));
  await changePlan(page, () => page.getByLabel("Pace changes").fill("3"));
  await changePlan(page, async () => {
    await page.getByTestId("min-segment").selectOption({ label: "No minimum" });
  });
}

/** Load an Ithaca course (inside the fixture DEM) and plan it. */
async function planLakefront(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  await uploadGpx(page, corpusPath("Lakefront-Loops-5K.gpx"));
  await expectRouteDrawn(page);
  await expectPlanSettled(page);
  await changePlan(page, () => enterGoal(page, "24:30"));
  await changePlan(page, () => page.getByLabel("Pace changes").fill("2"));
}

test("a drawn route's link opens the same plan in a fresh browser", async ({ page, browser }, testInfo) => {
  await planDrawnRoute(page);
  const before = await planSnapshot(page);
  const link = await copyShareLink(page);
  expect(link).toMatch(/#v=1&c=d\.3p\.[A-Za-z0-9_-]+&g=1500&k=3&s=0&u=mi$/);

  const context = await freshContext(browser, testInfo);
  const other = await context.newPage();
  await openLink(other, link);
  await expect(other.getByTestId("map")).toHaveAttribute("data-course", "drawn", { timeout: 15_000 });
  expect(await planSnapshot(other)).toEqual(before);
  // The link is taken off the address once opened, so a reload keeps later changes.
  expect(new URL(other.url()).hash).toBe("");
  await expect(other.getByTestId("edit-route")).toBeVisible();
  await context.close();
});

test("an uploaded course's link opens a simplified copy with the same inputs", async ({ page, browser }, testInfo) => {
  await planLakefront(page);
  const before = await planSnapshot(page);
  await expect(page.getByTestId("share-note")).toContainText("simplified copy of this course, within");
  const link = await copyShareLink(page);
  expect(link).toMatch(/#v=1&c=t\.[A-Za-z0-9_-]+&g=1470&k=2&s=402\.336&u=mi&n=/);

  const context = await freshContext(browser, testInfo);
  const other = await context.newPage();
  await openLink(other, link);
  await expectRouteDrawn(other);
  const after = await planSnapshot(other);
  expect(after.title).toBe(before.title);
  expect(after.goal).toBe(before.goal);
  expect(after.paceChanges).toBe(before.paceChanges);
  expect(after.minSegment).toBe(before.minSegment);
  expect(after.paces).toHaveLength(before.paces.length);
  expect(seconds(after.total)).toBe(seconds(before.total));
  // Within the stated 0.5% of the distance.
  const distance = (s: string) => Number.parseFloat(s);
  expect(Math.abs(distance(after.distance) - distance(before.distance))).toBeLessThanOrEqual(
    distance(before.distance) * 0.005 + 0.01,
  );
  await expect(other.getByTestId("course-source")).toHaveText("From a shared link");
  await expect(other.getByTestId("elevation-source")).toContainText("simplified copy");
  await context.close();
});

test("a damaged or newer link says so, and the page still works", async ({ page }) => {
  await openLink(page, "/#v=1&c=d.3p.AAAA&k=4&s=0&u=mi");
  await expect(page.getByTestId("link-error")).toBeInViewport();
  await expect(page.getByTestId("link-error-message")).toContainText("incomplete or damaged");
  expect(new URL(page.url()).hash).toBe("");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByTestId("link-error")).toHaveCount(0);

  // Pasted into the address bar of the open app: only the fragment changes.
  await page.evaluate(() => {
    location.hash = "v=2&c=t.AAAA";
  });
  await expect(page.getByTestId("link-error-message")).toContainText("newer version of Perfect Pace");
  // Loading a course clears the message.
  await uploadGpx(page, corpusPath("Lakefront-Loops-5K.gpx"));
  await expectRouteDrawn(page);
  await expect(page.getByTestId("link-error")).toHaveCount(0);
});

test("a reload brings back a drawn route and its plan", async ({ page }) => {
  await planDrawnRoute(page);
  const before = await planSnapshot(page);
  await page.reload();
  await expect(page.getByTestId("map")).toHaveAttribute("data-course", "drawn", { timeout: 15_000 });
  expect(await planSnapshot(page)).toEqual(before);
});

test("a reload brings back an uploaded file exactly, with its plan", async ({ page }) => {
  await planBoston(page);
  await changePlan(page, async () => {
    await page.getByTestId("min-segment").selectOption({ label: "1 mi" });
  });
  const before = await planSnapshot(page);
  await page.reload();
  await expectRouteDrawn(page);
  expect(await planSnapshot(page)).toEqual(before);
  await expect(page.getByTestId("course-source")).toHaveText("boston.gpx");
  await expect(page.getByTestId("elevation-source")).toContainText("GPS");
});

test("with storage blocked the app still works, and simply starts empty again", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await planLakefront(page);
  await page.reload();
  await expect(page.getByRole("button", { name: /^(Choose a GPX file|Load GPX)$/ }).first()).toBeVisible();
  await expect(page.getByTestId("course-title")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("without the clipboard the link shows in a field to copy by hand", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
    });
  });
  await planLakefront(page);
  await page.getByTestId("copy-link").click();
  const field = page.getByTestId("share-url");
  await expect(field).toBeVisible();
  expect(await field.inputValue()).toMatch(/#v=1&c=t\./);
  await expect(page.getByTestId("copy-link")).toHaveText("Copy link");
});

test("the plan downloads as CSV and the course as GPX that reads back the same", async ({ page }) => {
  await planBoston(page);
  const csv = await downloadFrom(page, "export-csv");
  const title = await page.getByTestId("course-title").innerText();
  expect(title).toBe("127th Boston Marathon - 42.195 km");
  expect(csv.name).toBe("127th-boston-marathon-42-195-km-pacing-plan.csv");
  const lines = csv.text.trimEnd().split("\r\n");
  const rows = await page.getByTestId("segment-row").count();
  expect(lines[0]).toBe("Segment,Start (mi),End (mi),Distance (mi),Pace (/mi),Grade (%),Time,Elapsed,Note");
  expect(lines).toHaveLength(rows + 2);
  const times = await page.getByTestId("segment-time").allInnerTexts();
  const paces = await page.getByTestId("segment-pace").allInnerTexts();
  lines.slice(1, -1).forEach((line, i) => {
    const fields = line.split(",");
    expect(fields[0]).toBe(String(i + 1));
    expect(fields[4]).toBe(paces[i]);
    expect(fields[6]).toBe(times[i]);
  });
  expect(lines.at(-1)).toMatch(/^Finish,0\.00,26\.28,26\.28,6:51,,3:00:00,3:00:00,$/);

  const gpx = await downloadFrom(page, "export-gpx");
  expect(gpx.name).toBe("127th-boston-marathon-42-195-km.gpx");
  const file = parseGpx(gpx.text);
  expect(file.name).toBe(title);
  const points = file.tracks[0]!.course.points;
  expect(points.every((p) => p.ele !== undefined)).toBe(true);
  expect(polylineLengthM(points) / 1609.344).toBeCloseTo(await statNumber(page, "stat-distance"), 2);
});

test("a drawn route downloads as GPX with its terrain elevation", async ({ page }) => {
  await planDrawnRoute(page);
  await expect(page.getByTestId("export-gpx")).toContainText("elevation from terrain data");
  const gpx = await downloadFrom(page, "export-gpx");
  expect(gpx.name).toBe("drawn-route.gpx");
  const points = parseGpx(gpx.text).tracks[0]!.course.points;
  expect(points.every((p) => p.ele !== undefined && p.ele > 100 && p.ele < 600)).toBe(true);
  expect(polylineLengthM(points) / 1609.344).toBeCloseTo(await statNumber(page, "stat-distance"), 2);
});

test("printing shows only the pace band, with a time at every mile adding up to the goal", async ({ page }) => {
  await planBoston(page);
  await expect(page.getByTestId("print-band")).toBeVisible();
  await expect(page.getByTestId("pace-band")).toBeHidden();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("pace-band")).toBeVisible();
  await expect(page.getByTestId("side-panel").or(page.getByTestId("sheet"))).toBeHidden();
  const rows = page.getByTestId("band-row");
  await expect(rows).toHaveCount(27);
  await expect(page.getByTestId("band-elapsed").last()).toHaveText("3:00:00");
  await expect(page.getByTestId("band-goal")).toHaveText("3:00:00");
  // Five pace changes inside the course's 26 splits mark where the pace changes.
  expect(await page.locator('[data-testid="band-row"][data-change]').count()).toBeGreaterThan(0);
  const elapsed = (await page.getByTestId("band-elapsed").allInnerTexts()).map(seconds);
  expect(elapsed.every((t, i) => i === 0 || t > elapsed[i - 1]!)).toBe(true);
});

test("the controls are complete on a phone too, with no horizontal scroll", async ({ page }) => {
  test.skip(!isPhone(page), "phones only");
  await planBoston(page);
  for (const id of ["copy-link", "export-gpx", "export-csv", "print-band"]) {
    const control = page.getByTestId(id);
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport();
    const box = (await control.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(36);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
