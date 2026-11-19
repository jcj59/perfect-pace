import { expect, test, type Page } from "@playwright/test";
import { haversineM, polylineLengthM } from "../../packages/core/src/index.ts";
import {
  ITHACA,
  METERS_PER_MILE,
  type RoutingStub,
  addPoints,
  dragFromTo,
  expectLegsSettled,
  handleCenter,
  showEditor,
  mapPoint,
  routeLengthM,
  shownDistance,
  startDrawing,
  tabToMap,
  tapAt,
  waypointAt,
  waypoints,
} from "../support/draw.ts";
import { expectPlanSettled } from "../support/plan.ts";
import { isPhone, statNumber } from "../support/course.ts";

// B2, with `/api/route` stubbed from the ORS fixture (support/draw.ts). Every project runs it:
// desktop with the mouse, iPhone and Pixel with touch events (taps and one-finger drags).
test.use({ geolocation: ITHACA, permissions: ["geolocation"] });

const FOUR: [number, number][] = [
  [0.25, 0.3],
  [0.7, 0.25],
  [0.75, 0.7],
  [0.3, 0.75],
];

/** The panel's distance agrees with the route's length, to the two decimals (in miles) it shows. */
async function expectDistance(page: Page, meters: number): Promise<void> {
  await expect
    .poll(async () => Math.abs((await shownDistance(page)) - meters / METERS_PER_MILE), { timeout: 10_000 })
    .toBeLessThanOrEqual(0.0051);
}

async function drawFour(page: Page): Promise<RoutingStub> {
  const stub = await startDrawing(page);
  await addPoints(page, FOUR);
  await expectLegsSettled(page, 3);
  return stub;
}

test("draw 4 points: 3 routed legs, the live distance, and the course in the chart, plan and stats", async ({
  page,
}) => {
  const stub = await drawFour(page);
  expect(stub.calls).toHaveLength(3);
  await expect(page.getByTestId("draw-summary")).toHaveText("4 points, 3 legs");
  await expect(page.locator('[data-testid="draw-leg"][data-status="ready"]')).toHaveCount(3);
  const lengthM = routeLengthM(stub, await waypoints(page));
  // The routed legs are longer than straight lines between the points.
  const straightM = polylineLengthM(await waypoints(page));
  expect(lengthM).toBeGreaterThan(straightM * 1.05);
  await expectDistance(page, lengthM);

  // The drawn course flows into the same profile, plan and stats as an uploaded file.
  await expect(page.getByTestId("elevation-source")).toContainText("terrain data");
  await expect(page.getByRole("slider", { name: "Elevation profile" })).toBeAttached();
  // The plan's colors go on the map after Done; while drawing, its table is in the panel.
  await expect(page.getByTestId("segment-table")).toBeAttached({ timeout: 15_000 });
  expect(await statNumber(page, "stat-distance")).toBeCloseTo(lengthM / METERS_PER_MILE, 1);

  // Done: the map shows the course with its plan colors, as for a file.
  await page.getByRole("button", { name: "Done" }).locator("visible=true").first().click();
  await expect(page.getByTestId("map")).not.toHaveAttribute("data-drawing");
  await expect(page.getByTestId("map")).toHaveAttribute("data-course", "drawn", { timeout: 15_000 });
  if (isPhone(page)) await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "half");
  await expectPlanSettled(page);
  await expect(page.getByTestId("course-title")).toHaveText("Drawn route");
  // And back to editing, with the same route.
  await page.getByTestId("edit-route").locator("visible=true").first().click();
  await expect(page.getByTestId("waypoint")).toHaveCount(4);
  expect(stub.calls).toHaveLength(3);
});

test("dragging a waypoint re-routes only its two legs; undo and redo use the cache", async ({ page, browserName }) => {
  test.skip(
    isPhone(page) && browserName !== "chromium",
    "touch drags go through CDP, Chromium only: https://github.com/jcj59/perfect-pace/issues/42",
  );
  const stub = await drawFour(page);
  const before = await waypoints(page);
  const lengthBefore = routeLengthM(stub, before);

  const from = await handleCenter(page, "waypoint", 1);
  const to = await mapPoint(page, 0.55, 0.5);
  await dragFromTo(page, from, to);
  await expect.poll(() => stub.calls.length).toBe(5);
  await expectLegsSettled(page, 3);
  const moved = await waypoints(page);
  expect(haversineM(moved[1]!, before[1]!)).toBeGreaterThan(50);
  expect(moved.filter((p, i) => i !== 1)).toEqual(before.filter((p, i) => i !== 1));
  // Exactly the two legs touching the moved point.
  const newCalls = stub.calls.slice(3);
  expect(newCalls.map((c) => [c.from, c.to])).toEqual(
    expect.arrayContaining([
      [before[0], moved[1]],
      [moved[1], before[2]],
    ]),
  );
  await expectDistance(page, routeLengthM(stub, moved));

  const toolbar = page.getByRole("toolbar", { name: "Drawing" });
  await toolbar.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => waypointAt(page, 1)).toEqual(before[1]);
  await expectLegsSettled(page, 3);
  await expectDistance(page, lengthBefore);
  await toolbar.getByRole("button", { name: "Redo" }).click();
  await expect.poll(() => waypointAt(page, 1)).toEqual(moved[1]);
  await expectLegsSettled(page, 3);
  await expect(toolbar.getByRole("button", { name: "Redo" })).toBeDisabled();
  // Undo and redo never asked the router again.
  expect(stub.calls).toHaveLength(5);

  // Undo all the way back to nothing, then clear a redrawn route.
  for (let i = 0; i < 5; i++) await toolbar.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("waypoint")).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "Undo" })).toBeDisabled();
  await addPoints(page, FOUR.slice(0, 2));
  await toolbar.getByRole("button", { name: "Clear the route" }).click();
  await expect(page.getByTestId("waypoint")).toHaveCount(0);
  await expect(page.getByTestId("draw-summary")).toHaveText("0 points, 0 legs");
});

test("dragging a leg's midpoint inserts a point; tapping a point removes it", async ({ page, browserName }) => {
  test.skip(
    isPhone(page) && browserName !== "chromium",
    "touch drags go through CDP, Chromium only: https://github.com/jcj59/perfect-pace/issues/42",
  );
  const stub = await drawFour(page);
  const before = await waypoints(page);
  await dragFromTo(page, await handleCenter(page, "leg-midpoint", 0), await mapPoint(page, 0.45, 0.1));
  await expect(page.getByTestId("waypoint")).toHaveCount(5);
  await expect.poll(() => stub.calls.length).toBe(5);
  await expectLegsSettled(page, 4);
  const inserted = await waypoints(page);
  expect([inserted[0], ...inserted.slice(2)]).toEqual(before);

  // Removing the inner point joins its two legs back into one, which routes once.
  await tapAt(page, await handleCenter(page, "waypoint", 1));
  await expect(page.getByTestId("waypoint")).toHaveCount(4);
  await expectLegsSettled(page, 3);
  expect(await waypoints(page)).toEqual(before);
  // The joined leg is the original first leg, still cached.
  expect(stub.calls).toHaveLength(5);
  await expectDistance(page, routeLengthM(stub, before));
});

test("close loop and out and back", async ({ page }) => {
  const stub = await startDrawing(page);
  await addPoints(page, FOUR.slice(0, 3));
  await expectLegsSettled(page, 2);
  const three = await waypoints(page);

  await showEditor(page);
  await page.getByRole("button", { name: "Close loop" }).click();
  await expectLegsSettled(page, 3);
  const loop = await waypoints(page);
  expect(loop).toEqual([...three, three[0]]);
  expect(stub.calls).toHaveLength(3);
  await expectDistance(page, routeLengthM(stub, loop));
  await expect(page.getByRole("button", { name: "Close loop" })).toBeDisabled();

  // Undo the loop, then retrace the route instead: the way back reuses the routed legs.
  await page.getByRole("toolbar", { name: "Drawing" }).getByRole("button", { name: "Undo" }).click();
  await expectLegsSettled(page, 2);
  await page.getByRole("button", { name: "Out and back" }).click();
  await expectLegsSettled(page, 4);
  const back = await waypoints(page);
  expect(back).toEqual([...three, three[1], three[0]]);
  expect(stub.calls).toHaveLength(3);
  const outM = routeLengthM(stub, three);
  await expectDistance(page, 2 * outM);
});

test("per-leg mode: straight legs need no routing", async ({ page }) => {
  const stub = await drawFour(page);
  const points = await waypoints(page);
  await showEditor(page);
  const leg = page.getByTestId("draw-leg").nth(1);
  await leg.getByTitle("Straight line").click();
  await expect(leg.getByRole("radio", { name: "Straight line" })).toBeChecked();
  await expect(leg).toHaveAttribute("data-mode", "straight");
  await expectLegsSettled(page, 3);
  await expectDistance(page, routeLengthM(stub, points, new Set([1])));
  // Back to paths: the routed line is still cached.
  await leg.getByTitle("Follow paths").click();
  await expect(leg).toHaveAttribute("data-mode", "snap");
  await expectDistance(page, routeLengthM(stub, points));

  // New legs in straight mode, from the toolbar.
  await page.getByTitle("New legs are straight lines").click();
  await expect(page.getByRole("radio", { name: "New legs are straight lines" })).toBeChecked();
  await addPoints(page, [[0.1, 0.9]]);
  await expectLegsSettled(page, 4);
  await expect(page.getByTestId("draw-leg").nth(3)).toHaveAttribute("data-mode", "straight");
  expect(stub.calls).toHaveLength(3);
  await expectDistance(page, routeLengthM(stub, await waypoints(page), new Set([3])));
});

test("a leg that fails to route offers a straight line, without stopping the drawing", async ({ page }) => {
  const stub = await startDrawing(page);
  stub.failRequest(2);
  await addPoints(page, FOUR.slice(0, 3));
  const alert = page.getByTestId("routing-error");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Leg 2 couldn't follow paths");
  await expect(alert).toContainText("not set up on this server");
  await expect(page.getByTestId("draw-leg").nth(1)).toHaveAttribute("data-status", "error");
  await expect(page.getByTestId("draw-leg").nth(0)).toHaveAttribute("data-status", "ready");
  // Drawing carries on.
  await addPoints(page, FOUR.slice(3));
  await expect(page.getByTestId("draw-leg").nth(2)).toHaveAttribute("data-status", "ready");

  await alert.getByRole("button", { name: "Use a straight line" }).click();
  await expect(alert).toBeHidden();
  await expectLegsSettled(page, 3);
  await expect(page.getByTestId("draw-leg").nth(1)).toHaveAttribute("data-mode", "straight");
  const points = await waypoints(page);
  await expectDistance(page, routeLengthM(stub, points, new Set([1])));
  await expect(page.getByTestId("elevation-source")).toContainText("terrain data");

  // Undo brings the failure back; Try again routes it (the stub only failed the first time).
  await page.getByRole("toolbar", { name: "Drawing" }).getByRole("button", { name: "Undo" }).click();
  await expect(alert).toBeVisible();
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(alert).toBeHidden();
  await expectLegsSettled(page, 3);
  await expectDistance(page, routeLengthM(stub, points));
});

test("starting to draw replaces nothing until there is a route, and Cancel goes back", async ({ page }) => {
  await startDrawing(page);
  await expect(page.getByTestId("draw-hint")).toContainText("where your course starts");
  await page.getByRole("button", { name: "Cancel" }).locator("visible=true").first().click();
  await expect(page.getByTestId("empty-state")).toBeAttached();
  await expect(page.getByTestId("map")).not.toHaveAttribute("data-drawing");
});

// Keyboard only: the arrow keys pan the focused map, Enter adds a point at its crosshair, the
// arrow keys move a focused point (routing once the key is let go), and Enter removes it.
test("drawing with the keyboard alone: add, move and remove points", async ({ page }) => {
  const stub = await startDrawing(page);
  await tabToMap(page);
  const canvas = page.locator("canvas.maplibregl-canvas");
  await expect(canvas).toHaveAttribute("aria-label", /Enter adds a point at the center/);
  await expect(page.getByTestId("draw-crosshair")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("waypoint")).toHaveCount(1);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("waypoint")).toHaveCount(2);
  await expectLegsSettled(page, 1);
  const [start, finish] = await waypoints(page);
  expect(finish!.lon).toBeGreaterThan(start!.lon);

  // Hold ArrowDown to move the finish south: the leg routes once, when the key is let go.
  const calls = stub.calls.length;
  await page.getByTestId("waypoint").nth(1).focus();
  for (let i = 0; i < 4; i++) await page.keyboard.down("ArrowDown");
  await page.keyboard.up("ArrowDown");
  await expect.poll(async () => (await waypointAt(page, 1)).lat).toBeLessThan(finish!.lat);
  await expectLegsSettled(page, 1);
  expect(stub.calls.length - calls).toBe(1);
  expect((await waypointAt(page, 1)).lon).toBeCloseTo(finish!.lon, 6);

  // Enter on a point removes it.
  await page.getByTestId("waypoint").nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("waypoint")).toHaveCount(1);
});
