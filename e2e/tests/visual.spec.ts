import { expect, test } from "@playwright/test";
import { openApp, type ColorScheme } from "../support/app.ts";
import { corpusPath, expectRouteDrawn, invalidPath, isPhone, uploadGpx } from "../support/course.ts";
import { expectPlanSettled, planBoston } from "../support/plan.ts";

// Baselines live in tests/__screenshots__/<project>/ and are generated in the Linux
// Playwright container (`pnpm visual:update`). Update them only with a reason in the PR.
for (const scheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`empty state, ${scheme} @visual`, async ({ page }) => {
    await openApp(page, scheme);
    await expect(page).toHaveScreenshot(`empty-state-${scheme}.png`);
  });

  test(`empty state in the full sheet, ${scheme} @visual`, async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 768, "phones only: desktop shows it in the side panel");
    await openApp(page, scheme);
    const handle = page.getByTestId("sheet-handle");
    await handle.click();
    await handle.click();
    await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "full");
    await expect(page).toHaveScreenshot(`empty-state-sheet-full-${scheme}.png`);
  });

  // The camera frames the course without the glide, so the shot is of its resting place.
  test(`loaded course, ${scheme} @visual`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page, scheme);
    await uploadGpx(page, corpusPath("boston.gpx"));
    await expectRouteDrawn(page);
    await expect(page.getByTestId("elevation-source")).toBeVisible();
    await expectPlanSettled(page);
    await expect(page).toHaveScreenshot(`loaded-course-${scheme}.png`);
  });

  // The chart's cursor and readout, and the marker on the map, at a fixed point along the course.
  test(`loaded course with the chart scrubbed, ${scheme} @visual`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page, scheme);
    await uploadGpx(page, corpusPath("boston.gpx"));
    await expectRouteDrawn(page);
    await expectPlanSettled(page);
    const line = (await page.getByTestId("chart-line").boundingBox())!;
    await page.mouse.move(line.x + line.width * 0.6, line.y + line.height / 2);
    await expect(page.getByTestId("map-marker")).toBeVisible();
    await expect(page).toHaveScreenshot(`loaded-course-scrubbed-${scheme}.png`);
  });

  test(`loaded course in the full sheet, ${scheme} @visual`, async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 768, "phones only: desktop shows it in the side panel");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page, scheme);
    await uploadGpx(page, corpusPath("boston.gpx"));
    await expectRouteDrawn(page);
    await expect(page.getByTestId("elevation-source")).toBeVisible();
    await expectPlanSettled(page);
    await page.getByTestId("sheet-handle").click();
    await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "full");
    await expect(page).toHaveScreenshot(`loaded-course-sheet-full-${scheme}.png`);
  });

  // B4 and B5: Boston planned for 3:00:00 with 6 changes, one segment picked in the table, so the
  // segment colors and the highlight show on the chart, the map and the table. On a phone the
  // sheet rests at half, with the colored chart over the map.
  test(`plan view, ${scheme} @visual`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await planBoston(page, scheme);
    await page.getByTestId("segment-row").nth(4).getByRole("button").click();
    await expect(page.getByTestId("map")).toHaveAttribute("data-selected-segment", "4");
    await page.mouse.move(page.viewportSize()!.width - 2, page.viewportSize()!.height / 2);
    if (isPhone(page)) {
      await page.getByTestId("sheet-content").evaluate((e) => e.scrollTo(0, 0));
    } else {
      await page.getByTestId("pacing-plan").evaluate((e) => e.scrollIntoView({ block: "start" }));
    }
    await expect(page).toHaveScreenshot(`plan-view-${scheme}.png`);
  });

  test(`plan in the full sheet, ${scheme} @visual`, async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 768, "phones only: desktop shows it in the side panel");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await planBoston(page, scheme);
    await page.getByTestId("sheet-handle").click();
    await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "full");
    await page.getByTestId("segment-row").nth(4).getByRole("button").click();
    await page.getByTestId("segment-table").evaluate((e) => e.scrollIntoView({ block: "start" }));
    await expect(page).toHaveScreenshot(`plan-sheet-full-${scheme}.png`);
  });

  test(`error state, ${scheme} @visual`, async ({ page }) => {
    await openApp(page, scheme);
    await uploadGpx(page, invalidPath("kml.gpx"));
    await expect(page.getByTestId("load-error")).toBeVisible();
    await expect(page).toHaveScreenshot(`error-state-${scheme}.png`);
  });
}
