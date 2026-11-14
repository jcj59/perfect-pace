import { expect, test, type Page } from "@playwright/test";
import { hasHorizontalScroll, openApp } from "../support/app.ts";

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

/** The sheet's visible height: from its top edge to the bottom of the viewport. */
async function sheetVisiblePx(page: Page): Promise<number> {
  const box = await page.getByTestId("sheet").boundingBox();
  return (page.viewportSize()?.height ?? 0) - (box?.y ?? 0);
}

/** Drag the sheet's header by `dy` pixels (negative is up) with a slow, fling-free gesture. */
async function dragSheet(page: Page, dy: number): Promise<void> {
  const header = page.getByRole("heading", { level: 1 });
  const box = (await header.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const viewport = page.viewportSize()!;
  await page.mouse.move(x, Math.min(viewport.height - 2, Math.max(2, y + dy)), { steps: 12 });
  // Pause before releasing so the release has no fling velocity.
  await page.waitForTimeout(150);
  await page.mouse.up();
}

test("the map fills the viewport with no horizontal scroll", async ({ page }) => {
  await openApp(page);
  expect(await hasHorizontalScroll(page)).toBe(false);
  const viewport = page.viewportSize()!;
  const map = (await page.getByTestId("map").boundingBox())!;
  expect(map).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  await expect(page.getByRole("region", { name: "Map" })).toBeVisible();
});

test.describe("desktop", () => {
  test.skip(({ page }) => isPhone(page), "desktop layout only");

  test("the panel floats over the left of the map, with zoom buttons on the map", async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId("sheet")).toHaveCount(0);
    const panel = page.getByRole("region", { name: "Course panel" });
    await expect(panel).toBeVisible();
    const box = (await panel.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBe(16);
    expect(box.y).toBe(16);
    expect(box.height).toBe(viewport.height - 32);
    expect(box.width).toBe(384);
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await expect(page.getByRole("button", { name: "Zoom in" })).toBeVisible();
  });
});

test.describe("phone", () => {
  test.skip(({ page }) => !isPhone(page), "phone layout only");

  test("the sheet starts at peek, showing only its header", async ({ page }) => {
    await openApp(page);
    const sheet = page.getByRole("region", { name: "Course panel" });
    await expect(sheet).toHaveAttribute("data-snap", "peek");
    expect(await sheetVisiblePx(page)).toBe(92);
    await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();
    await expect(page.getByRole("heading", { level: 2 })).not.toBeInViewport();
    // Off-screen content is inert, so it cannot take focus.
    await expect(page.getByTestId("sheet-content")).toHaveAttribute("inert");
    await expect(page.getByRole("button", { name: "Zoom in" })).toHaveCount(0);
  });

  test("a 375 px wide phone has no horizontal scroll at any snap", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openApp(page);
    for (const snap of ["peek", "half", "full"]) {
      await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", snap);
      expect(await hasHorizontalScroll(page)).toBe(false);
      const sheet = (await page.getByTestId("sheet").boundingBox())!;
      expect(sheet.width).toBe(375);
      await page.getByTestId("sheet-handle").click();
    }
  });

  test("dragging the header snaps the sheet to half, full and back to peek", async ({ page }) => {
    await openApp(page);
    const sheet = page.getByTestId("sheet");
    const viewport = page.viewportSize()!;

    await dragSheet(page, -viewport.height * 0.35);
    await expect(sheet).toHaveAttribute("data-snap", "half");
    await expect.poll(() => sheetVisiblePx(page)).toBe(Math.round(viewport.height * 0.5));
    await expect(page.getByRole("heading", { level: 2 })).toBeInViewport();

    await dragSheet(page, -viewport.height * 0.3);
    await expect(sheet).toHaveAttribute("data-snap", "full");
    await expect.poll(() => sheetVisiblePx(page)).toBe(viewport.height - 56);

    // A small drag settles back where it started.
    await dragSheet(page, 40);
    await expect(sheet).toHaveAttribute("data-snap", "full");

    await dragSheet(page, viewport.height);
    await expect(sheet).toHaveAttribute("data-snap", "peek");
    await expect.poll(() => sheetVisiblePx(page)).toBe(92);
    expect(await hasHorizontalScroll(page)).toBe(false);
  });

  test("tapping the handle steps through the snaps, and the arrow keys move it", async ({ page }) => {
    await openApp(page);
    const sheet = page.getByTestId("sheet");
    const handle = page.getByTestId("sheet-handle");
    await expect(handle).toHaveAccessibleName("Expand panel");
    await handle.click();
    await expect(sheet).toHaveAttribute("data-snap", "half");
    await handle.click();
    await expect(sheet).toHaveAttribute("data-snap", "full");
    await expect(handle).toHaveAccessibleName("Collapse panel");
    await handle.click();
    await expect(sheet).toHaveAttribute("data-snap", "peek");

    await handle.focus();
    await page.keyboard.press("ArrowUp");
    await expect(sheet).toHaveAttribute("data-snap", "half");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(sheet).toHaveAttribute("data-snap", "full");
    await page.keyboard.press("ArrowDown");
    await expect(sheet).toHaveAttribute("data-snap", "half");
  });

  test("at full height the panel content scrolls inside the sheet, not the page", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("sheet-handle").click();
    await page.getByTestId("sheet-handle").click();
    await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "full");
    const appearance = page.getByRole("group", { name: "Appearance" });
    await appearance.scrollIntoViewIfNeeded();
    await expect(appearance).toBeInViewport();
    expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
    expect(await hasHorizontalScroll(page)).toBe(false);
  });
});
