import { expect, type Page } from "@playwright/test";

export type ColorScheme = "light" | "dark";

/** Open the app in a color scheme and wait until it has rendered and reached the API. */
export async function openApp(page: Page, colorScheme: ColorScheme = "light"): Promise<void> {
  await page.emulateMedia({ colorScheme });
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Coming soon");
}

/** `startTime` (ms since navigation start) of a `performance.mark` the app sets, or null if absent. */
export function markTime(page: Page, name: string): Promise<number | null> {
  return page.evaluate((n) => performance.getEntriesByName(n, "mark")[0]?.startTime ?? null, name);
}

/** Whether the page scrolls horizontally (it never should, at any viewport). */
export function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}
