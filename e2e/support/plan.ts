import { expect, type Page } from "@playwright/test";
import { openApp, type ColorScheme } from "./app.ts";
import { corpusPath, expectRouteDrawn, uploadGpx } from "./course.ts";

/** When the latest plan reached the screen (`pp:plan-rendered`), or -1 before any. */
export function planRenderedAt(page: Page): Promise<number> {
  return page.evaluate(() => performance.getEntriesByName("pp:plan-rendered", "mark")[0]?.startTime ?? -1);
}

/** Wait until the plan in view is current: rendered, nothing pending, and drawn on the map. */
export async function expectPlanSettled(page: Page): Promise<void> {
  await expect(page.getByTestId("segment-table")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("plan-pending")).not.toHaveAttribute("data-pending");
  const rows = await page.getByTestId("segment-row").count();
  await expect(page.getByTestId("map")).toHaveAttribute("data-segments", String(rows), { timeout: 15_000 });
}

/** Do `change` to the plan inputs and wait for the plan it produces to settle. */
export async function changePlan(page: Page, change: () => Promise<void>): Promise<void> {
  const before = await planRenderedAt(page);
  await change();
  await expect.poll(() => planRenderedAt(page), { timeout: 15_000 }).toBeGreaterThan(before);
  await expectPlanSettled(page);
}

/** Type a goal time and commit it with Enter, as a person does. */
export async function enterGoal(page: Page, text: string): Promise<void> {
  const input = page.getByLabel("Goal time");
  await input.fill(text);
  await input.press("Enter");
}

/** Open the app and load the Boston Marathon, then wait for its first plan. */
export async function loadBostonPlan(page: Page, scheme: ColorScheme = "light"): Promise<void> {
  await openApp(page, scheme);
  await uploadGpx(page, corpusPath("boston.gpx"));
  await expectRouteDrawn(page);
  await expectPlanSettled(page);
}

/** Load Boston and plan it for 3:00:00 with 6 pace changes (the B4 scenario). */
export async function planBoston(page: Page, scheme: ColorScheme = "light"): Promise<void> {
  await loadBostonPlan(page, scheme);
  await changePlan(page, () => enterGoal(page, "3:00:00"));
  await changePlan(page, () => page.getByLabel("Pace changes").fill("6"));
}

/** `h:mm:ss` or `m:ss` to seconds. */
export function seconds(text: string): number {
  return text
    .trim()
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
}
