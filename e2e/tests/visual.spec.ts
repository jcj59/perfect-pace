import { expect, test, type Page } from "@playwright/test";
import { openApp, type ColorScheme } from "../support/app.ts";
import { corpusPath, expectRouteDrawn, invalidPath, isPhone, uploadGpx } from "../support/course.ts";
import { ITHACA, addPoints, expectLegsSettled, startDrawing } from "../support/draw.ts";
import { expectPlanSettled, planBoston } from "../support/plan.ts";

/** Scroll the panel (`scroller`) so `target` sits at its top, moving nothing else (unlike `scrollIntoView`). */
async function scrollPanelTo(page: Page, scroller: string, target: string): Promise<void> {
  await page.getByTestId(scroller).evaluate((element, id) => {
    const top = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top;
    element.scrollTop += top - element.getBoundingClientRect().top - 8;
  }, target);
}

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
    if (isPhone(page)) await scrollPanelTo(page, "sheet-content", "elevation-chart");
    else await scrollPanelTo(page, "side-panel-content", "pacing-plan");
    await expect(page).toHaveScreenshot(`plan-view-${scheme}.png`);
  });

  test(`plan in the full sheet, ${scheme} @visual`, async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 768, "phones only: desktop shows it in the side panel");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await planBoston(page, scheme);
    await page.getByTestId("sheet-handle").click();
    await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "full");
    await page.getByTestId("segment-row").nth(4).getByRole("button").click();
    await scrollPanelTo(page, "sheet-content", "segment-table");
    await expect(page).toHaveScreenshot(`plan-sheet-full-${scheme}.png`);
  });

  // B6: the Share and export card under the Boston plan, scrolled into view (the full sheet on phones).
  test(`share and export, ${scheme} @visual`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await planBoston(page, scheme);
    if (isPhone(page)) {
      await page.getByTestId("sheet-handle").click();
      await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "full");
      await scrollPanelTo(page, "sheet-content", "share-export");
    } else await scrollPanelTo(page, "side-panel-content", "share-export");
    await page.mouse.move(page.viewportSize()!.width - 2, page.viewportSize()!.height / 2);
    await expect(page).toHaveScreenshot(`share-export-${scheme}.png`);
  });

  // The printed pace band, on a page the width of Letter paper inside its margins. Paper is white,
  // so the band is the same in either theme; the dark run checks that.
  test(`printed pace band, ${scheme} @visual`, async ({ page }) => {
    test.skip(isPhone(page), "the printed page is paper sized on every device");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await planBoston(page, scheme);
    await page.setViewportSize({ width: 725, height: 940 });
    await page.emulateMedia({ media: "print" });
    await expect(page.getByTestId("pace-band")).toBeVisible();
    await expect(page).toHaveScreenshot(`pace-band-${scheme}.png`, { fullPage: true });
  });

  test(`a link that cannot be opened, ${scheme} @visual`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, scheme);
    await page.evaluate(() => {
      location.hash = "v=1&c=d.3p.AAAA&k=4&s=0&u=mi";
    });
    await expect(page.getByTestId("link-error")).toBeInViewport();
    await expect(page).toHaveScreenshot(`link-error-${scheme}.png`);
  });

  test(`error state, ${scheme} @visual`, async ({ page }) => {
    await openApp(page, scheme);
    await uploadGpx(page, invalidPath("kml.gpx"));
    await expect(page.getByTestId("load-error")).toBeVisible();
    await expect(page).toHaveScreenshot(`error-state-${scheme}.png`);
  });
}

// B2: drawing mode near Ithaca (the fixture DEM), with `/api/route` stubbed from the ORS fixture.
// Four points and three routed legs, with the profile and plan worked out in the panel; then the
// same with the second leg failing to route, its error and the straight-line offer showing.
test.describe("drawing", () => {
  test.use({ geolocation: ITHACA, permissions: ["geolocation"] });
  const FOUR: [number, number][] = [
    [0.25, 0.3],
    [0.7, 0.25],
    [0.75, 0.7],
    [0.3, 0.75],
  ];

  async function settle(page: Page): Promise<void> {
    await expectLegsSettled(page, 3);
    await expect(page.getByTestId("elevation-source")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("segment-table")).toBeAttached({ timeout: 15_000 });
    await expect(page.getByTestId("plan-pending")).not.toHaveAttribute("data-pending");
    // Off the handles, so none shows its hover state.
    if (!isPhone(page)) await page.mouse.move(page.viewportSize()!.width - 2, page.viewportSize()!.height - 2);
  }

  for (const scheme of ["light", "dark"] satisfies ColorScheme[]) {
    test(`drawing mode, ${scheme} @visual`, async ({ page }) => {
      await startDrawing(page, scheme);
      await addPoints(page, FOUR);
      await settle(page);
      await expect(page).toHaveScreenshot(`drawing-${scheme}.png`);
    });

    test(`drawing with a leg that failed to route, ${scheme} @visual`, async ({ page }) => {
      const stub = await startDrawing(page, scheme);
      stub.failRequest(2);
      await addPoints(page, FOUR);
      await expect(page.getByTestId("routing-error")).toBeVisible();
      await expectLegsSettled(page, 3);
      if (!isPhone(page)) await page.mouse.move(page.viewportSize()!.width - 2, page.viewportSize()!.height - 2);
      await expect(page).toHaveScreenshot(`drawing-error-${scheme}.png`);
    });
  }
});
