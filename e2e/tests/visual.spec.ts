import { expect, test, type Page } from "@playwright/test";
import { openApp, type ColorScheme } from "../support/app.ts";
import { corpusPath, expectRouteDrawn, invalidPath, isPhone, uploadGpx } from "../support/course.ts";
import { ITHACA, addPoints, expectLegsSettled, startDrawing } from "../support/draw.ts";
import { expectPlanSettled, planBoston } from "../support/plan.ts";
import { openReportDialog, stubReport } from "../support/report.ts";

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

  // B8: how the plan works, open under the (i) beside the "Pacing plan" heading (the full sheet on phones).
  test(`plan explanation open, ${scheme} @visual`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await planBoston(page, scheme);
    if (isPhone(page)) {
      await page.getByTestId("sheet-handle").click();
      await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "full");
    }
    await scrollPanelTo(page, isPhone(page) ? "sheet-content" : "side-panel-content", "pacing-plan");
    await page.getByRole("button", { name: "How the plan works" }).click();
    await expect(page.getByRole("dialog", { name: "How the plan works" })).toBeFocused();
    await page.mouse.move(page.viewportSize()!.width - 2, page.viewportSize()!.height / 2);
    await expect(page).toHaveScreenshot(`plan-explanation-${scheme}.png`);
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

  // The printed pace band (in the Segments view, the default), on a page the width of Letter paper
  // inside its margins. Paper is white, so the band is the same in either theme; the dark run checks that.
  test(`printed pace band, ${scheme} @visual`, async ({ page }) => {
    test.skip(isPhone(page), "the printed page is paper sized on every device");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await planBoston(page, scheme);
    await page.setViewportSize({ width: 725, height: 940 });
    await page.emulateMedia({ media: "print" });
    await expect(page.getByTestId("pace-band")).toBeVisible();
    await expect(page).toHaveScreenshot(`pace-band-${scheme}.png`, { fullPage: true });
  });

  // B11: a Custom plan with three breakpoints, their handles on the chart and their list.
  test(`custom plan with breakpoints, ${scheme} @visual`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await planBoston(page, scheme);
    if (isPhone(page)) {
      await page.getByTestId("sheet-handle").click();
      await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "full");
    }
    const scroller = isPhone(page) ? "sheet-content" : "side-panel-content";
    await scrollPanelTo(page, scroller, "plan-type");
    await page.getByTestId("plan-type").getByText("Custom").click();
    for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Add breakpoint" }).click();
    await expect(page.getByTestId("segment-row")).toHaveCount(4, { timeout: 15_000 });
    await expectPlanSettled(page);
    await page.mouse.move(page.viewportSize()!.width - 2, page.viewportSize()!.height / 2);
    await scrollPanelTo(page, scroller, "elevation-chart");
    await expect(page).toHaveScreenshot(`plan-custom-${scheme}.png`);
  });

  // B11: mile splits shown in the Splits view.
  test(`splits plan in the Splits view, ${scheme} @visual`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await planBoston(page, scheme);
    if (isPhone(page)) {
      await page.getByTestId("sheet-handle").click();
      await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "full");
    }
    const scroller = isPhone(page) ? "sheet-content" : "side-panel-content";
    await scrollPanelTo(page, scroller, "plan-type");
    await page.getByTestId("plan-type").getByText("Splits").click();
    await expect(page.getByTestId("segment-row")).toHaveCount(27, { timeout: 15_000 });
    await expectPlanSettled(page);
    await page.getByTestId("table-view").getByText("Splits").click();
    await expect(page.getByTestId("split-table")).toBeVisible();
    await page.mouse.move(page.viewportSize()!.width - 2, page.viewportSize()!.height / 2);
    await scrollPanelTo(page, scroller, "plan-inputs");
    await expect(page).toHaveScreenshot(`plan-splits-view-${scheme}.png`);
  });

  // The pace band in the Splits view: the time at every mile.
  test(`printed pace band in the Splits view, ${scheme} @visual`, async ({ page }) => {
    test.skip(isPhone(page), "the printed page is paper sized on every device");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await planBoston(page, scheme);
    await page.getByTestId("table-view").getByText("Splits").click();
    await expect(page.getByTestId("split-table")).toBeVisible();
    await page.setViewportSize({ width: 725, height: 940 });
    await page.emulateMedia({ media: "print" });
    await expect(page.getByTestId("band-row")).toHaveCount(27);
    await expect(page).toHaveScreenshot(`pace-band-splits-${scheme}.png`, { fullPage: true });
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

// B7: offline. The status line under the name says so, and the draw card (in the full sheet on
// phones) says drawing needs a connection, with its button off.
for (const scheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`offline, ${scheme} @visual`, async ({ page }) => {
    await openApp(page, scheme);
    await page.context().setOffline(true);
    await expect(page.getByTestId("status-line")).toHaveAttribute("data-state", "offline");
    if (isPhone(page)) {
      const handle = page.getByTestId("sheet-handle");
      await handle.click();
      await handle.click();
      await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "full");
      await scrollPanelTo(page, "sheet-content", "draw-card");
    }
    await expect(page).toHaveScreenshot(`offline-${scheme}.png`);
  });

  // Drawing when the connection drops: the notice by the toolbar.
  test.describe(() => {
    test.use({ geolocation: ITHACA, permissions: ["geolocation"] });
    test(`drawing offline, ${scheme} @visual`, async ({ page }) => {
      await startDrawing(page, scheme);
      await addPoints(page, [
        [0.3, 0.4],
        [0.7, 0.45],
      ]);
      await expectLegsSettled(page, 1);
      await page.context().setOffline(true);
      await expect(page.getByTestId("draw-offline")).toBeVisible();
      if (!isPhone(page)) await page.mouse.move(page.viewportSize()!.width - 2, page.viewportSize()!.height - 2);
      await expect(page).toHaveScreenshot(`drawing-offline-${scheme}.png`);
    });
  });

  // A newer build took over: the status line offers a reload. Needs the service worker.
  test.describe(() => {
    test.use({ serviceWorkers: "allow" });
    test(`update ready, ${scheme} @visual`, async ({ page }) => {
      await openApp(page, scheme);
      await page.evaluate(() => navigator.serviceWorker.ready);
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
      await page.evaluate(() => navigator.serviceWorker.register("/sw.js?next", { scope: "/" }));
      await expect(page.getByTestId("status-line")).toHaveAttribute("data-state", "update");
      await expect(page).toHaveScreenshot(`update-ready-${scheme}.png`);
    });
  });

  // An iPhone's home indicator inset (simulated): the sheet's header rests above it at peek.
  test(`phone sheet above the home indicator, ${scheme} @visual`, async ({ page }) => {
    test.skip(!isPhone(page), "phones only");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 59, bottom: 34, left: 0, right: 0 } });
    await openApp(page, scheme);
    await expect(page).toHaveScreenshot(`safe-area-peek-${scheme}.png`);
  });

  // B12: the header menu open, then the report dialog with a description typed, and once sent.
  test(`report a problem, ${scheme} @visual`, async ({ page }) => {
    await stubReport(page);
    await openApp(page, scheme);
    await page.getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("menuitem", { name: "Report a problem" })).toBeFocused();
    await expect(page).toHaveScreenshot(`header-menu-${scheme}.png`);
    await page.getByRole("menuitem", { name: "Report a problem" }).click();
    await expect(page.getByRole("dialog", { name: "Report a problem" })).toBeVisible();
    await page.getByLabel("Description").fill("The elevation chart goes blank after I draw a loop.");
    await page.getByLabel("Description").blur();
    await expect(page).toHaveScreenshot(`report-dialog-${scheme}.png`);
    await page.getByRole("button", { name: "Send report" }).click();
    await expect(page.getByText("Thanks, report sent")).toBeVisible();
    await expect(page).toHaveScreenshot(`report-sent-${scheme}.png`);
  });

  test(`report a problem while unavailable, ${scheme} @visual`, async ({ page }) => {
    await stubReport(page, { config: { configured: false, siteKey: null } });
    await openApp(page, scheme);
    await openReportDialog(page);
    await expect(page.getByText("Reporting is unavailable right now.")).toBeVisible();
    await expect(page).toHaveScreenshot(`report-unavailable-${scheme}.png`);
  });
}
