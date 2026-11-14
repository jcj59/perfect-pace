import { expect, test } from "@playwright/test";
import { openApp } from "../support/app.ts";

const html = (page: import("@playwright/test").Page) => page.locator("html");

/** Bring the theme control into view (on phones it is further down the sheet). */
async function appearance(page: import("@playwright/test").Page) {
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.getByTestId("sheet-handle").click();
    await page.getByTestId("sheet-handle").click();
  }
  const group = page.getByRole("group", { name: "Appearance" });
  await group.scrollIntoViewIfNeeded();
  return group;
}

test("follows the system color scheme by default, live", async ({ page }) => {
  await openApp(page, "light");
  await expect(html(page)).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html(page)).toHaveClass(/dark/);
  await expect(page.getByRole("radio", { name: "Auto" })).toBeChecked();
});

test("a manual choice overrides the system and survives a reload", async ({ page }) => {
  await openApp(page, "light");
  const group = await appearance(page);
  await group.getByText("Dark").click();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(html(page)).toHaveClass(/dark/);
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await bodyBg()).toBe("rgb(26, 25, 24)");

  await page.reload();
  await expect(page.getByTestId("map")).toHaveAttribute("data-map-state", "ready");
  await expect(html(page)).toHaveClass(/dark/);
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();

  // Back to Auto: follows the (light) system again.
  await (await appearance(page)).getByText("Auto").click();
  await expect(html(page)).not.toHaveClass(/dark/);
  expect(await bodyBg()).toBe("rgb(243, 241, 236)");
  await page.reload();
  await expect(html(page)).not.toHaveClass(/dark/);
});

test("the theme is set before first paint, before any app code runs", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pp:theme", "dark"));
  await page.emulateMedia({ colorScheme: "light" });
  // Without the app's scripts, only the inline script in index.html can set the theme.
  await page.route(/\.(js|mjs|tsx?)(\?.*)?$/, (route) => route.abort());
  await page.goto("/");
  await expect(html(page)).toHaveClass("dark");
  expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
});
