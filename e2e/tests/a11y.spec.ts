import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openApp, type ColorScheme } from "../support/app.ts";

for (const scheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`placeholder page has no axe violations, ${scheme}`, async ({ page }) => {
    await openApp(page, scheme);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}
