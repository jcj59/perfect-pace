import { expect, test, type Page } from "@playwright/test";
import { changePlan, planBoston } from "../support/plan.ts";

// This file runs in the `plan-perf` project, alone and after every other project (the course load
// budget included) has finished, so its timing does not share the CPU (see playwright.config.ts).
//
// B4: a recompute after changing an input takes under 50 ms for a marathon at 10 m spacing
// (Boston, about 4,200 points), measured in the worker. `pp:plan-compute` is `computePlan` alone,
// in the worker's own timeline. `pp:plan-recompute` is what the user waits for once the input has
// settled: posting the request, the worker's compute, the reply and React putting the new plan on
// screen. It excludes the 120 ms debounce, which is deliberate quiet time, not work.
const WORKER_BUDGET_MS = 50;
// Locally the worker takes about 5 ms and the end-to-end recompute about 8 ms; the UI budget
// leaves room for slower CI runners.
const UI_BUDGET_MS = 150;

async function workerComputeMs(page: Page): Promise<number> {
  const worker = page.workers().find((w) => w.url().includes("core"));
  expect(worker, "the core worker is running").toBeDefined();
  const duration = await worker!.evaluate(
    () => performance.getEntriesByName("pp:plan-compute", "measure")[0]?.duration,
  );
  expect(duration, "the pp:plan-compute measure was never recorded").toBeDefined();
  return duration!;
}

const recomputeMs = (page: Page) =>
  page.evaluate(() => performance.getEntriesByName("pp:plan-recompute", "measure")[0]?.duration ?? NaN);

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

test(`a plan recompute for a marathon is under ${WORKER_BUDGET_MS} ms in the worker`, async ({ page }) => {
  await planBoston(page);
  const worker: number[] = [];
  const ui: number[] = [];
  // Every pace-change count the slider offers, then back down, each one a full recompute.
  for (const changes of [1, 2, 3, 4, 5, 7, 8, 9, 10, 6]) {
    await changePlan(page, () => page.getByLabel("Pace changes").fill(String(changes)));
    worker.push(await workerComputeMs(page));
    ui.push(await recomputeMs(page));
  }
  console.log(
    `plan recompute for Boston: worker median ${median(worker).toFixed(1)} ms (max ${Math.max(...worker).toFixed(1)}), ` +
      `end to end median ${median(ui).toFixed(1)} ms (max ${Math.max(...ui).toFixed(1)})`,
  );
  expect(median(worker)).toBeLessThan(WORKER_BUDGET_MS);
  expect(median(ui)).toBeLessThan(UI_BUDGET_MS);
});
