import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { hasHorizontalScroll, openApp, type ColorScheme } from "../support/app.ts";
import { corpusPath, expectRouteDrawn, isPhone, uploadGpx } from "../support/course.ts";
import { expectPlanSettled, planBoston } from "../support/plan.ts";

// B9: the desktop panel is resized from a handle on its right edge.

const handle = (page: Page) => page.getByRole("separator", { name: "Resize panel" });

async function panelWidth(page: Page): Promise<number> {
  return (await page.getByTestId("side-panel").boundingBox())!.width;
}

/** Drag the handle by `dx` pixels in small steps, the pointer ending up wherever that lands (over the map). */
async function dragHandle(page: Page, dx: number): Promise<void> {
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

/** The route's bounding box on screen, once the camera rests. */
async function routeBox(page: Page): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const value = await page.getByTestId("map").getAttribute("data-route-box");
  const [left = NaN, top = NaN, right = NaN, bottom = NaN] = (value ?? "").split(" ").map(Number);
  return { left, top, right, bottom };
}

/** Whether the route sits inside the map area right of the panel, clear of it and the window edges. */
async function routeClearOfPanel(page: Page): Promise<boolean> {
  const panel = (await page.getByTestId("side-panel").boundingBox())!;
  const viewport = page.viewportSize()!;
  const box = await routeBox(page);
  return box.left > panel.x + panel.width && box.right < viewport.width && box.top > 0 && box.bottom < viewport.height;
}

test.describe("desktop", () => {
  test.skip(({ page }) => isPhone(page), "desktop layout only: phones keep the bottom sheet");

  test("dragging the handle resizes the panel within its limits, and a double-click resets it", async ({ page }) => {
    await openApp(page);
    const separator = handle(page);
    await expect(separator).toHaveAttribute("aria-valuenow", "384");
    await expect(separator).toHaveAttribute("aria-valuemin", "320");
    // Desktop Chrome is 1280 wide: 60% of it is 768, so 720 is the cap.
    await expect(separator).toHaveAttribute("aria-valuemax", "720");

    await dragHandle(page, 150);
    expect(await panelWidth(page)).toBe(534);
    await expect(separator).toHaveAttribute("aria-valuenow", "534");

    await dragHandle(page, 600);
    expect(await panelWidth(page)).toBe(720);
    await dragHandle(page, -800);
    expect(await panelWidth(page)).toBe(320);
    expect(await hasHorizontalScroll(page)).toBe(false);

    await separator.dblclick();
    expect(await panelWidth(page)).toBe(384);
    await expect(separator).toHaveAttribute("aria-valuenow", "384");
  });

  test("the handle shows a grip on hover and the resize cursor", async ({ page }) => {
    await openApp(page);
    const grip = page.getByTestId("panel-resize-grip");
    await expect(grip).toHaveCSS("opacity", "0");
    await handle(page).hover();
    await expect(grip).toHaveCSS("opacity", "1");
    await expect(handle(page)).toHaveCSS("cursor", "col-resize");
  });

  test("the chart and the table reflow while dragging; the camera waits for the drop", async ({ page }) => {
    await planBoston(page);
    const chart = page.getByTestId("elevation-chart");
    const before = (await chart.boundingBox())!.width;
    const box = (await handle(page).boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const routeBefore = await routeBox(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 200, y, { steps: 10 });
    // Mid drag: the panel and its chart are wider, and the map has not moved.
    await expect.poll(async () => (await chart.boundingBox())!.width).toBeCloseTo(before + 200, 0);
    expect(await routeBox(page)).toEqual(routeBefore);
    await expect(page.locator("html")).toHaveClass(/pp-resizing/);
    await page.mouse.up();
    await expect(page.locator("html")).not.toHaveClass(/pp-resizing/);
    await expect.poll(() => routeClearOfPanel(page)).toBe(true);
    expect(await routeBox(page)).not.toEqual(routeBefore);
  });

  test("the arrow keys move the handle 16 px, and Home and End go to the limits", async ({ page }) => {
    await openApp(page);
    const separator = handle(page);
    await separator.focus();
    await expect(page.getByTestId("panel-resize-grip")).toHaveCSS("opacity", "1");
    await page.keyboard.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "400");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", "368");
    expect(await panelWidth(page)).toBe(368);
    await page.keyboard.press("End");
    await expect(separator).toHaveAttribute("aria-valuenow", "720");
    await page.keyboard.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "720");
    await page.keyboard.press("Home");
    await expect(separator).toHaveAttribute("aria-valuenow", "320");
    await page.keyboard.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", "320");
    expect(await panelWidth(page)).toBe(320);
  });

  test("the width comes back after a reload", async ({ page }) => {
    await openApp(page);
    await dragHandle(page, 200);
    expect(await panelWidth(page)).toBe(584);
    await page.reload();
    await expect(page.getByTestId("map")).toHaveAttribute("data-map-state", "ready", { timeout: 15_000 });
    expect(await panelWidth(page)).toBe(584);
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "584");
    expect(await page.evaluate(() => localStorage.getItem("pp:panelWidth"))).toBe("584");

    // Back at the default, nothing is kept.
    await handle(page).dblclick();
    expect(await page.evaluate(() => localStorage.getItem("pp:panelWidth"))).toBeNull();
    await page.reload();
    await expect(page.getByTestId("map")).toHaveAttribute("data-map-state", "ready", { timeout: 15_000 });
    expect(await panelWidth(page)).toBe(384);
  });

  test("a narrower window clamps the width, and a wider one brings it back", async ({ page }) => {
    await openApp(page);
    await handle(page).focus();
    await page.keyboard.press("End");
    expect(await panelWidth(page)).toBe(720);
    await page.setViewportSize({ width: 1000, height: 720 });
    await expect.poll(() => panelWidth(page)).toBe(600);
    await expect(handle(page)).toHaveAttribute("aria-valuemax", "600");
    expect(await hasHorizontalScroll(page)).toBe(false);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(() => panelWidth(page)).toBe(720);
  });

  test("a loaded course stays framed clear of the panel after a resize", async ({ page }) => {
    await openApp(page);
    await uploadGpx(page, corpusPath("boston.gpx"));
    await expectRouteDrawn(page);
    await expect.poll(() => routeClearOfPanel(page)).toBe(true);
    for (const dx of [400, -400, 150]) {
      const before = await routeBox(page);
      await dragHandle(page, dx);
      await expect.poll(() => routeBox(page)).not.toEqual(before);
      await expect.poll(() => routeClearOfPanel(page)).toBe(true);
    }
    // The keyboard and a smaller window move it the same way.
    await handle(page).focus();
    await page.keyboard.press("End");
    await expect.poll(async () => (await routeBox(page)).left).toBeGreaterThan(720 + 16);
    await expect.poll(() => routeClearOfPanel(page)).toBe(true);
    await page.setViewportSize({ width: 1000, height: 720 });
    await expect.poll(() => panelWidth(page)).toBe(600);
    await expect.poll(() => routeClearOfPanel(page)).toBe(true);
  });

  test("after the user moves the map, a resize keeps the middle of the view in the middle", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page);
    await uploadGpx(page, corpusPath("boston.gpx"));
    await expectRouteDrawn(page);
    await expect.poll(() => routeClearOfPanel(page)).toBe(true);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(async () => (await routeBox(page)).right - (await routeBox(page)).left).toBeGreaterThan(0);
    const zoomed = await routeBox(page);
    await handle(page).focus();
    await page.keyboard.press("End");
    // Not reframed (same size on screen), only shifted right by half of the 336 px.
    await expect.poll(async () => (await routeBox(page)).left).toBeCloseTo(zoomed.left + 168, -1);
    const moved = await routeBox(page);
    expect(moved.right - moved.left).toBeCloseTo(zoomed.right - zoomed.left, -1);
  });

  for (const scheme of ["light", "dark"] satisfies ColorScheme[]) {
    test(`the focused handle has no axe violations, ${scheme}`, async ({ page }) => {
      await openApp(page, scheme);
      await uploadGpx(page, corpusPath("boston.gpx"));
      await expectRouteDrawn(page);
      await handle(page).focus();
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    });

    // A wide panel for the table and a narrow one for the map, each settled at its limit.
    for (const [name, key] of [
      ["wide", "End"],
      ["narrow", "Home"],
    ] as const) {
      test(`plan view in a ${name} panel, ${scheme} @visual`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await planBoston(page, scheme);
        await handle(page).focus();
        await page.keyboard.press(key);
        await expect.poll(() => routeClearOfPanel(page)).toBe(true);
        await expectPlanSettled(page);
        await page.mouse.move(page.viewportSize()!.width - 2, page.viewportSize()!.height / 2);
        await handle(page).blur();
        await expect(page).toHaveScreenshot(`plan-view-${name}-panel-${scheme}.png`);
      });
    }
  }
});

test.describe("phone", () => {
  test.skip(({ page }) => !isPhone(page), "phone layout only");

  test("there is no resize handle on the bottom sheet", async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId("sheet")).toBeVisible();
    await expect(page.getByTestId("panel-resize-handle")).toHaveCount(0);
  });
});
