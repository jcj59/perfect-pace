import { expect, test, type Locator, type Page } from "@playwright/test";
import { hasHorizontalScroll } from "../support/app.ts";
import { isPhone } from "../support/course.ts";
import { planBoston } from "../support/plan.ts";

// B8: how the plan works lives behind an (i) beside the "Pacing plan" heading, not in the panel.

function infoButton(page: Page): Locator {
  return page.getByRole("button", { name: "How the plan works" });
}

/**
 * The middle of the popover's title, which is in view even when the half-height sheet clips the
 * popover's end. Pressed by position, since Playwright's own scrolling into view would also scroll
 * the page under the sheet, which no person can do.
 */
async function insidePopover(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.getByRole("dialog").getByText("How the plan works").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A spot on the map, clear of the panel, the sheet and the map's own controls. */
function mapSpot(page: Page): { x: number; y: number } {
  const { width, height } = page.viewportSize()!;
  return isPhone(page) ? { x: width / 2, y: 70 } : { x: width * 0.7, y: height * 0.3 };
}

async function expectOpen(page: Page): Promise<void> {
  const popover = page.getByRole("dialog", { name: "How the plan works" });
  await expect(infoButton(page)).toHaveAttribute("aria-expanded", "true");
  await expect(popover).toBeVisible();
  await expect(popover).toBeFocused();
  await expect(popover).toContainText("12 s per mile");
  await expect(popover).toContainText("flat ground 6:51 /mi");
}

async function expectClosed(page: Page): Promise<void> {
  await expect(infoButton(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("plan-info")).toHaveCount(0);
}

test.describe("the plan explanation", () => {
  test.beforeEach(async ({ page }) => {
    await planBoston(page);
  });

  test("is not in the panel until the (i) beside the heading opens it", async ({ page }) => {
    await expect(page.getByTestId("plan-assumption")).toHaveCount(0);
    await expect(page.getByTestId("pacing-plan")).not.toContainText("How the plan works");
    const heading = (await page.getByRole("heading", { name: "Pacing plan" }).boundingBox())!;
    const button = (await infoButton(page).boundingBox())!;
    // Beside the heading, on its line, and big enough to hit with a thumb (its hit area is 44 px).
    expect(button.x).toBeGreaterThan(heading.x + heading.width);
    expect(button.x - (heading.x + heading.width)).toBeLessThan(12);
    expect(Math.abs(button.y + button.height / 2 - (heading.y + heading.height / 2))).toBeLessThan(3);
    expect(button.width).toBeGreaterThanOrEqual(28);
  });

  test("opens and closes by mouse", async ({ page }) => {
    const button = infoButton(page);
    await button.click();
    await expectOpen(page);

    // Clicking inside keeps it open; the button again closes it and keeps focus there.
    const inside = await insidePopover(page);
    await page.mouse.click(inside.x, inside.y);
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await button.click();
    await expectClosed(page);
    await expect(button).toBeFocused();

    // A click elsewhere in the panel, or on the map, closes it.
    await button.click();
    await expectOpen(page);
    await page.getByRole("heading", { level: 1 }).click();
    await expectClosed(page);
    await button.click();
    await expectOpen(page);
    const spot = mapSpot(page);
    await page.mouse.click(spot.x, spot.y);
    await expectClosed(page);

    // So does its close button, giving focus back to the (i).
    await button.click();
    await page.getByTestId("plan-info-close").click();
    await expectClosed(page);
    await expect(button).toBeFocused();
  });

  test("opens and closes by keyboard", async ({ page }) => {
    const button = infoButton(page);
    await button.focus();
    await page.keyboard.press("Enter");
    await expectOpen(page);
    await page.keyboard.press("Escape");
    await expectClosed(page);
    await expect(button).toBeFocused();

    // Space opens it too, Tab reaches its close button, and Enter there closes it.
    await page.keyboard.press("Space");
    await expectOpen(page);
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("plan-info-close")).toBeFocused();
    await page.keyboard.press("Enter");
    await expectClosed(page);
    await expect(button).toBeFocused();

    // Tabbing out of it closes it and moves on to the goal time, as if it had not been there.
    await page.keyboard.press("Enter");
    await expectOpen(page);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expectClosed(page);
    await expect(page.getByLabel("Goal time")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(button).toBeFocused();
  });

  test.describe("by touch", () => {
    test.use({ hasTouch: true });

    test("opens and closes by touch", async ({ page }) => {
      const button = infoButton(page);
      await button.tap();
      await expectOpen(page);
      const inside = await insidePopover(page);
      await page.touchscreen.tap(inside.x, inside.y);
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await button.tap();
      await expectClosed(page);

      await button.tap();
      await expectOpen(page);
      const spot = mapSpot(page);
      await page.touchscreen.tap(spot.x, spot.y);
      await expectClosed(page);

      await button.tap();
      await expectOpen(page);
      await page.getByTestId("plan-info-close").tap();
      await expectClosed(page);
    });
  });

  test("fits inside the panel, with no horizontal scroll", async ({ page }) => {
    if (isPhone(page)) {
      await page.getByTestId("sheet-handle").click();
      await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "full");
    }
    await infoButton(page).click();
    await expectOpen(page);
    const popover = page.getByTestId("plan-info");
    await expect(popover).toBeInViewport({ ratio: 1 });
    const box = (await popover.boundingBox())!;
    const panel = (await page.getByTestId(isPhone(page) ? "sheet-content" : "side-panel-content").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(panel.x);
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
    expect(await hasHorizontalScroll(page)).toBe(false);
    const scrolls = await page
      .getByTestId(isPhone(page) ? "sheet-content" : "side-panel-content")
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrolls).toBe(false);
  });
});
