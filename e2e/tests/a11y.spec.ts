import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openApp, type ColorScheme } from "../support/app.ts";
import { corpusPath, expectRouteDrawn, invalidPath, uploadGpx } from "../support/course.ts";

for (const scheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`empty state has no axe violations, ${scheme}`, async ({ page }) => {
    await openApp(page, scheme);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test(`a loaded multi-track course has no axe violations, ${scheme}`, async ({ page }) => {
    await openApp(page, scheme);
    await uploadGpx(page, corpusPath("multi-track.gpx"));
    await expectRouteDrawn(page);
    await expect(page.getByTestId("elevation-source")).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test(`the error state has no axe violations, ${scheme}`, async ({ page }) => {
    await openApp(page, scheme);
    await uploadGpx(page, invalidPath("tcx.gpx"));
    await expect(page.getByTestId("load-error")).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}
