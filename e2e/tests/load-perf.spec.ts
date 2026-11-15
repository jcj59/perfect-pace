import { type Page, expect, test } from "@playwright/test";
import { toGpx } from "../../packages/core/test/support/gpx-dialects.ts";
import { randomTrack } from "../../packages/core/test/support/tracks.ts";
import { markTime, openApp } from "../support/app.ts";
import { calibrationMs, loadHeadroom } from "../support/calibrate.ts";
import { expectRouteDrawn, uploadGpx } from "../support/course.ts";

// This file runs in the `load-perf` project, after every other project has finished, so the
// timing is not shared with other tests' CPU (see playwright.config.ts).
//
// B1: a 50k-point file parses and renders in under 1 s on a mid-range laptop. The same file as
// the core parse benchmark (a seeded Garmin activity, about 19 MB). `pp:load-course` runs from the
// file being picked to the route being drawn on the map: the worker reading and parsing it, sending
// the course back, and MapLibre tiling and rendering the line. Reduced motion skips the camera's
// 0.7 s glide, which is a deliberate animation, not load time.
//
// CI runners are slower than that laptop, and differ by about 2x among themselves, so the budget
// is scaled by a calibration run in the same page (see `support/calibrate.ts` and CONTRIBUTING.md):
// a machine at least as fast as the reference gets the plain 1000 ms. Like the core benchmarks,
// the budget holds the median of a few loads, each in a fresh browser context.
const LOAD_BUDGET_MS = 1000;
const LOADS = 3;
const LARGE = toGpx(
  "garmin",
  randomTrack(50, { count: 50_000, minStepM: 1, maxStepM: 5, maxTurnDeg: 20, withEle: true }),
  {
    name: "Long run",
    segments: 3,
  },
);

const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

test(`a 50k-point GPX loads and draws in under ${LOAD_BUDGET_MS} ms`, async ({ browser }) => {
  test.setTimeout(120_000);
  const durations: number[] = [];
  const calibrations: number[] = [];
  for (let i = 0; i < LOADS; i++) {
    // A fresh context each time: no saved session to restore, no warm caches from the last load.
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await openApp(page);
    await expect.poll(() => markTime(page, "pp:worker-ready")).not.toBeNull();
    calibrations.push(await calibrationMs(page));
    await uploadGpx(page, { name: "long-run.gpx", buffer: Buffer.from(LARGE) });
    await expectRouteDrawn(page);
    await expect(page.getByTestId("course-title")).toHaveText("Long run");
    const duration = await page.evaluate(() => performance.getEntriesByName("pp:load-course", "measure")[0]?.duration);
    expect(duration, "the pp:load-course measure was never recorded").toBeDefined();
    durations.push(duration!);
    console.log(`pp:load-course for 50k points: ${duration!.toFixed(0)} ms (${await phases(page)})`);
    // After the load too, so a runner slowed down during it is seen.
    calibrations.push(await calibrationMs(page));
    await context.close();
  }
  const calibration = median(calibrations);
  const headroom = loadHeadroom(calibration);
  const budget = LOAD_BUDGET_MS * headroom;
  const load = median(durations);
  console.log(
    `pp:load-course median ${load.toFixed(0)} ms of ${durations.map((d) => d.toFixed(0)).join(", ")}; ` +
      `calibration ${calibration.toFixed(1)} ms (${calibrations.map((c) => c.toFixed(1)).join(", ")}), ` +
      `headroom ${headroom.toFixed(2)}x, budget ${budget.toFixed(0)} ms`,
  );
  expect(load, `the median load against ${budget.toFixed(0)} ms (${headroom.toFixed(2)}x headroom)`).toBeLessThan(
    budget,
  );
});

/**
 * Where a load's time went, for the log: each mark's time since the load started, and the
 * worker's own read and parse time. A slow run on CI says which phase grew.
 */
async function phases(page: Page): Promise<string> {
  const marks = await page.evaluate(() => {
    const start = performance.getEntriesByName("pp:load-start", "mark")[0]?.startTime ?? NaN;
    const at = (name: string) => (performance.getEntriesByName(name, "mark")[0]?.startTime ?? NaN) - start;
    return { parsed: at("pp:parsed"), routeSet: at("pp:route-set"), drawn: at("pp:route-drawn") };
  });
  const worker = page.workers().find((w) => w.url().includes("core"));
  const parse = await worker?.evaluate(() => performance.getEntriesByName("pp:parse", "measure")[0]?.duration);
  const ms = (value: number | undefined) => (value === undefined || Number.isNaN(value) ? "-" : value.toFixed(0));
  return [
    `parsed at ${ms(marks.parsed)} (worker read and parse ${ms(parse)})`,
    `line on the map at ${ms(marks.routeSet)}`,
    `drawn at ${ms(marks.drawn)}`,
  ].join(", ");
}
