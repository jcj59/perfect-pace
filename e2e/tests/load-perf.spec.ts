import { expect, test } from "@playwright/test";
import { toGpx } from "../../packages/core/test/support/gpx-dialects.ts";
import { randomTrack } from "../../packages/core/test/support/tracks.ts";
import { markTime, openApp } from "../support/app.ts";
import { expectRouteDrawn, uploadGpx } from "../support/course.ts";

// This file runs in the `load-perf` project, after every other project has finished, so the
// timing is not shared with other tests' CPU (see playwright.config.ts).
//
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
  const parsed = await page.evaluate(() => {
    const at = (name: string) => performance.getEntriesByName(name, "mark")[0]?.startTime ?? NaN;
    return at("pp:parsed") - at("pp:load-start");
  });
  console.log(`pp:load-course for 50k points: ${duration?.toFixed(0)} ms (read and parse ${parsed.toFixed(0)} ms)`);
  expect(duration).toBeLessThan(LOAD_BUDGET_MS);
});
