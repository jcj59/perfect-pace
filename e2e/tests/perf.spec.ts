import { expect, test } from "@playwright/test";
import { toGpx } from "../../packages/core/test/support/gpx-dialects.ts";
import { randomTrack } from "../../packages/core/test/support/tracks.ts";
import { markTime, openApp } from "../support/app.ts";
import { expectRouteDrawn, uploadGpx } from "../support/course.ts";

// Browser-side budgets read `performance` marks the app sets. Later PRs add the plan-recompute
// mark measured in the Web Worker.
const BUDGETS_MS = {
  "pp:ready": 3000,
  // The core worker has loaded and answered its first message.
  "pp:worker-ready": 4000,
};

for (const [mark, budget] of Object.entries(BUDGETS_MS)) {
  test(`${mark} is under ${budget} ms`, async ({ page }) => {
    await openApp(page);
    await expect.poll(() => markTime(page, mark), { message: `performance mark ${mark} was never set` }).not.toBeNull();
    const time = await markTime(page, mark);
    expect(time).toBeLessThan(budget);
  });
}

// B1: a 50k-point file parses and renders in under 1 s. The same file as the core parse benchmark
// (a seeded Garmin activity, about 19 MB). `pp:load-course` runs from the file being picked to the
// route being drawn on the map: reading it, parsing in the worker, sending the course back, and
// MapLibre tiling and rendering the line. Reduced motion skips the camera's 0.7 s glide, which is
// a deliberate animation, not load time.
const LOAD_BUDGET_MS = 1000;
const LARGE = toGpx(
  "garmin",
  randomTrack(50, { count: 50_000, minStepM: 1, maxStepM: 5, maxTurnDeg: 20, withEle: true }),
  {
    name: "Long run",
    segments: 3,
  },
);

test(`a 50k-point GPX loads and draws in under ${LOAD_BUDGET_MS} ms`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  await expect.poll(() => markTime(page, "pp:worker-ready")).not.toBeNull();
  await uploadGpx(page, { name: "long-run.gpx", buffer: Buffer.from(LARGE) });
  await expectRouteDrawn(page);
  await expect(page.getByTestId("course-title")).toHaveText("Long run");
  const duration = await page.evaluate(() => performance.getEntriesByName("pp:load-course", "measure")[0]?.duration);
  expect(duration, "the pp:load-course measure was never recorded").toBeDefined();
  console.log(`pp:load-course for 50k points: ${duration?.toFixed(0)} ms`);
  expect(duration).toBeLessThan(LOAD_BUDGET_MS);
});
