import { expect, test } from "@playwright/test";
import { markTime, openApp } from "../support/app.ts";

// Browser-side budgets read `performance` marks the app sets. The course load and plan recompute
// budgets are in `load-perf.spec.ts` and `plan-perf.spec.ts`, which run on their own.
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
