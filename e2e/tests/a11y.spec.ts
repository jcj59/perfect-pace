import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openApp, type ColorScheme } from "../support/app.ts";
import { corpusPath, expectRouteDrawn, invalidPath, uploadGpx } from "../support/course.ts";
import { ITHACA, addPoints, expectLegsSettled, startDrawing } from "../support/draw.ts";
import { enterGoal, planBoston } from "../support/plan.ts";
import { openReportDialog, stubReport } from "../support/report.ts";

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

  test(`the pacing plan has no axe violations, ${scheme}`, async ({ page }) => {
    await planBoston(page, scheme);
    await page.getByTestId("segment-row").nth(1).getByRole("button").click();
    await expect(page.getByTestId("map")).toHaveAttribute("data-selected-segment", "1");
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    // With a goal it cannot plan, and its error showing.
    await enterGoal(page, "3:30");
    await expect(page.getByTestId("goal-error")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test(`the plan explanation, open, has no axe violations, ${scheme}`, async ({ page }) => {
    await planBoston(page, scheme);
    await page.getByRole("button", { name: "How the plan works" }).click();
    await expect(page.getByRole("dialog", { name: "How the plan works" })).toBeFocused();
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test(`a link that cannot be opened has no axe violations, ${scheme}`, async ({ page }) => {
    await openApp(page, scheme);
    await page.evaluate(() => {
      location.hash = "v=3&c=t.AAAA";
    });
    await expect(page.getByTestId("link-error")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test(`share and export, after copying a link by hand, has no axe violations, ${scheme}`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no")) } });
    });
    await planBoston(page, scheme);
    await page.getByTestId("copy-link").click();
    await expect(page.getByTestId("share-url")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test(`the error state has no axe violations, ${scheme}`, async ({ page }) => {
    await openApp(page, scheme);
    await uploadGpx(page, invalidPath("tcx.gpx"));
    await expect(page.getByTestId("load-error")).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}

// B12: the header menu and the report dialog, filled in, sent, and unavailable.
for (const scheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`the header menu and the report dialog have no axe violations, ${scheme}`, async ({ page }) => {
    await stubReport(page);
    await openApp(page, scheme);
    await page.getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("menuitem", { name: "Report a problem" })).toBeFocused();
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    await page.getByRole("menuitem", { name: "Report a problem" }).click();
    await page.getByLabel("Description").fill("The chart is blank.");
    await page.getByLabel(/^Email/).fill("runner@example.com");
    await page.getByRole("dialog").getByText("Preview").click();
    await expect(page.getByTestId("report-diagnostics-preview")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    await page.getByRole("button", { name: "Send report" }).click();
    await expect(page.getByText("Thanks, report sent")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test(`the report dialog while reporting is unavailable has no axe violations, ${scheme}`, async ({ page }) => {
    await stubReport(page, { config: { configured: false, siteKey: null } });
    await openApp(page, scheme);
    await openReportDialog(page);
    await expect(page.getByText("Reporting is unavailable right now.")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}

// B7: offline, before and after loading a course.
for (const scheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`offline has no axe violations, ${scheme}`, async ({ page }) => {
    await openApp(page, scheme);
    await page.context().setOffline(true);
    await expect(page.getByTestId("status-line")).toHaveAttribute("data-state", "offline");
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    await page.context().setOffline(false);
    await uploadGpx(page, corpusPath("boston.gpx"));
    await expectRouteDrawn(page);
    await page.context().setOffline(true);
    await expect(page.getByTestId("status-line")).toHaveAttribute("data-state", "offline");
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}

test.describe("drawing", () => {
  test.use({ geolocation: ITHACA, permissions: ["geolocation"] });

  for (const scheme of ["light", "dark"] satisfies ColorScheme[]) {
    test(`drawing mode, with a leg that failed to route, has no axe violations, ${scheme}`, async ({ page }) => {
      const stub = await startDrawing(page, scheme);
      stub.failRequest(2);
      await addPoints(page, [
        [0.25, 0.3],
        [0.7, 0.25],
        [0.75, 0.7],
      ]);
      await expect(page.getByTestId("routing-error")).toBeVisible();
      await expectLegsSettled(page, 2);
      expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    });

    // From the keyboard: the focused map shows its crosshair; offline, the toolbar's notice shows.
    test(`keyboard drawing, then offline, has no axe violations, ${scheme}`, async ({ page }) => {
      await startDrawing(page, scheme);
      await page.keyboard.press("Shift");
      await page.locator("canvas.maplibregl-canvas").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("draw-crosshair")).toBeVisible();
      await expect(page.getByTestId("waypoint")).toHaveCount(1);
      expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
      await page.context().setOffline(true);
      await expect(page.getByTestId("draw-offline")).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    });
  }
});
