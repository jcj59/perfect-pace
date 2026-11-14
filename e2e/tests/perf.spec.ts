import { expect, test } from "@playwright/test";
import { markTime, openApp } from "../support/app.ts";

// Browser-side budgets read `performance` marks the app sets. Later PRs add parse and
// plan-recompute marks measured in the Web Worker.
const BUDGETS_MS = { "pp:ready": 3000 };

for (const [mark, budget] of Object.entries(BUDGETS_MS)) {
  test(`${mark} is under ${budget} ms`, async ({ page }) => {
    await openApp(page);
    const time = await markTime(page, mark);
    expect(time, `performance mark ${mark} was never set`).not.toBeNull();
    expect(time).toBeLessThan(budget);
  });
}
