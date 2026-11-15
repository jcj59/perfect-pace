import { readFileSync } from "node:fs";
import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { stubDemTiles, stubMapNetwork } from "./app.ts";
import { stubRouting } from "./draw.ts";
import { expectPlanSettled } from "./plan.ts";

/** The plan on screen, as a person reads it: the inputs, each segment's pace and time, and the total. */
export interface PlanSnapshot {
  title: string;
  goal: string;
  paceChanges: string;
  minSegment: string;
  distance: string;
  paces: string[];
  times: string[];
  total: string;
}

export async function planSnapshot(page: Page): Promise<PlanSnapshot> {
  await expectPlanSettled(page);
  return {
    title: await page.getByTestId("course-title").innerText(),
    goal: await page.getByLabel("Goal time").inputValue(),
    paceChanges: await page.getByLabel("Pace changes").inputValue(),
    minSegment: await page.getByTestId("min-segment").inputValue(),
    distance: await page.getByTestId("stat-distance").innerText(),
    paces: await page.getByTestId("segment-pace").allInnerTexts(),
    times: await page.getByTestId("segment-time").allInnerTexts(),
    total: await page.getByTestId("plan-total").innerText(),
  };
}

/** Press Copy link as a person does, see it confirm, and return the link from the clipboard. */
export async function copyShareLink(page: Page): Promise<string> {
  const button = page.getByTestId("copy-link");
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await expect(button).toHaveText("Copied");
  await expect(page.getByRole("status").filter({ hasText: "Link copied to the clipboard." })).toBeAttached();
  return page.evaluate(() => navigator.clipboard.readText());
}

/** A new browser context like the test's own (same device), with nothing in its storage. */
export async function freshContext(browser: Browser, testInfo: TestInfo): Promise<BrowserContext> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL } = testInfo.project.use;
  return browser.newContext({
    ...(viewport ? { viewport } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
    ...(isMobile !== undefined ? { isMobile } : {}),
    ...(hasTouch !== undefined ? { hasTouch } : {}),
    ...(baseURL ? { baseURL } : {}),
  });
}

/** Open `url` in `page` with the map, DEM and routing stubbed as in every other test. */
export async function openLink(page: Page, url: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubMapNetwork(page);
  await stubDemTiles(page);
  await stubRouting(page);
  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1, name: "Perfect Pace" })).toBeVisible();
}

/** Click a download control and return the file's name and text. */
export async function downloadFrom(page: Page, testId: string): Promise<{ name: string; text: string }> {
  const control = page.getByTestId(testId);
  await control.scrollIntoViewIfNeeded();
  const download = page.waitForEvent("download");
  await control.click();
  const file = await download;
  const path = await file.path();
  return { name: file.suggestedFilename(), text: readFileSync(path, "utf8") };
}
