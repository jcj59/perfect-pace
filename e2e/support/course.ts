import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { expect, type Page } from "@playwright/test";

/** The GPX fixture corpus shared with the core tests. */
export const GPX_DIR = new URL("../../packages/core/test/fixtures/gpx/", import.meta.url);
const GOLDEN_DIR = new URL("../../packages/core/test/golden/", import.meta.url);

export const METERS_PER_MILE = 1609.344;

/** Every course in the corpus (not the `invalid/` files), by file name. */
export const CORPUS = readdirSync(GPX_DIR)
  .filter((f) => f.endsWith(".gpx"))
  .sort();

/** Every file the parser must reject. */
export const INVALID = readdirSync(new URL("invalid/", GPX_DIR))
  .filter((f) => f.endsWith(".gpx"))
  .sort();

/** What the golden snapshot (written by the core tests) records for a corpus file. */
export interface Golden {
  defaultTrack: number;
  tracks: { name: string | null; kind: "track" | "route"; distanceM: number }[];
  elevation: { source: string; gainM: number; lossM: number; minM: number; maxM: number };
}

/** The golden snapshot name for a corpus file, as `packages/core/test/golden-cases.ts` names it. */
const courseName = (file: string): string =>
  file
    .replace(/\.gpx$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");

export function golden(file: string): Golden {
  return JSON.parse(readFileSync(new URL(`course-${courseName(file)}.json`, GOLDEN_DIR), "utf8")) as Golden;
}

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

export type GpxSource = string | { name: string; buffer: Buffer };

/**
 * Load a GPX file the way a person does: press the visible upload button and pick the file in
 * the chooser. On a phone, before any course, that is the button in the sheet's header at peek.
 */
export async function uploadGpx(page: Page, source: GpxSource): Promise<void> {
  const files =
    typeof source === "string" ? source : { name: source.name, mimeType: "application/gpx+xml", buffer: source.buffer };
  const visibleButton = page
    .getByRole("button", { name: /^(Load GPX|Choose a GPX file|Choose another file|Replace)$/ })
    .locator("visible=true")
    .first();
  const chooser = page.waitForEvent("filechooser");
  await visibleButton.click();
  await (await chooser).setFiles(files);
}

export const corpusPath = (file: string) => new URL(file, GPX_DIR).pathname;
export const invalidPath = (file: string) => new URL(`invalid/${file}`, GPX_DIR).pathname;
export const fileLabel = (path: string) => basename(path);

/** Wait until the map has rendered the course route in view. */
export async function expectRouteDrawn(page: Page): Promise<void> {
  await expect(page.getByTestId("map")).toHaveAttribute("data-course", "drawn", { timeout: 15_000 });
}

/** The number in a stat tile, such as 26.28 from "26.28 mi". */
export async function statNumber(page: Page, testId: string): Promise<number> {
  const text = (await page.getByTestId(testId).innerText()).replace(/,/g, "");
  return Number.parseFloat(text);
}
