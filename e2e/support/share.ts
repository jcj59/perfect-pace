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
  // Text content, not innerText: on a phone the sheet may be at peek, and WebKit's innerText is
  // empty for anything clipped out of sight in its scroll area.
  const text = async (testId: string) => (await page.getByTestId(testId).textContent()) ?? "";
  return {
    title: await text("course-title"),
    goal: await page.getByLabel("Goal time").inputValue(),
    paceChanges: await page.getByLabel("Pace changes").inputValue(),
    minSegment: await page.getByTestId("min-segment").inputValue(),
    distance: await text("stat-distance"),
    paces: await page.getByTestId("segment-pace").allTextContents(),
    times: await page.getByTestId("segment-time").allTextContents(),
    total: await text("plan-total"),
  };
}

/**
 * Press Copy link as a person does, see it confirm, and return the link it put on the clipboard.
 * Chromium and Firefox read the clipboard back. Headless WebKit refuses every `readText()` (it
 * has no paste prompt to show), so there the link is the one the app handed to `writeText`.
 */
export async function copyShareLink(page: Page): Promise<string> {
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const writeText = clipboard.writeText.bind(clipboard);
    clipboard.writeText = (text: string) => {
      (window as unknown as { ppCopied: string }).ppCopied = text;
      return writeText(text);
    };
  });
  const button = page.getByTestId("copy-link");
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await expect(button).toHaveText("Copied");
  await expect(page.getByRole("status").filter({ hasText: "Link copied to the clipboard." })).toBeAttached();
  const copied = await page.evaluate(() => (window as unknown as { ppCopied: string }).ppCopied);
  if (page.context().browser()?.browserType().name() !== "webkit") {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(copied);
  }
  return copied;
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
