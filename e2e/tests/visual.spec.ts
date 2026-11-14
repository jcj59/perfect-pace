import { expect, test } from "@playwright/test";
import { openApp, type ColorScheme } from "../support/app.ts";

// Baselines live in tests/__screenshots__/<project>/ and are generated in the Linux
// Playwright container (`pnpm visual:update`). Update them only with a reason in the PR.
for (const scheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`empty state, ${scheme} @visual`, async ({ page }) => {
    await openApp(page, scheme);
    await expect(page).toHaveScreenshot(`empty-state-${scheme}.png`);
  });
}
