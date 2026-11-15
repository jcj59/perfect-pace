import { existsSync, readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

export type ColorScheme = "light" | "dark";

const TILEJSON = readFileSync(new URL("../fixtures/openfreemap/planet.json", import.meta.url), "utf8");

/**
 * Serve the basemap from fixtures so tests never depend on OpenFreeMap: the TileJSON comes from
 * `fixtures/openfreemap`, and every tile and glyph request gets an empty 204, so the map draws
 * only its background. That keeps screenshots stable as the live map data changes.
 */
export async function stubMapNetwork(page: Page): Promise<void> {
  await page.route("https://tiles.openfreemap.org/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/planet") {
      return route.fulfill({ contentType: "application/json", body: TILEJSON });
    }
    return route.fulfill({ status: 204 });
  });
}

const DEM_DIR = new URL("../../packages/core/test/fixtures/dem/", import.meta.url);
export const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/**";

/**
 * Serve Terrarium elevation tiles from the core fixtures (`packages/core/test/fixtures/dem`), the
 * same tiles the elevation unit tests use, so DEM lookups never touch the network. A tile that is
 * not in the fixtures gets a 404, which the app reports as an elevation download failure.
 * Routed on the context, because the requests come from the core Web Worker.
 */
export async function stubDemTiles(page: Page): Promise<void> {
  await page.context().route(TERRARIUM, (route) => {
    const match = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(new URL(route.request().url()).pathname);
    const file = match ? new URL(`${match[1]}/${match[2]}/${match[3]}.png`, DEM_DIR) : undefined;
    const headers = { "access-control-allow-origin": "*" };
    if (!file || !existsSync(file)) return route.fulfill({ status: 404, headers });
    return route.fulfill({ contentType: "image/png", headers, body: readFileSync(file) });
  });
}

/** Open the app in a color scheme and wait until the panel and the map have rendered. */
export async function openApp(page: Page, colorScheme: ColorScheme = "light"): Promise<void> {
  await page.emulateMedia({ colorScheme });
  await stubMapNetwork(page);
  await stubDemTiles(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Perfect Pace" })).toBeVisible();
  await expect(page.getByTestId("map")).toHaveAttribute("data-map-state", "ready", { timeout: 15_000 });
}

/** `startTime` (ms since navigation start) of a `performance.mark` the app sets, or null if absent. */
export function markTime(page: Page, name: string): Promise<number | null> {
  return page.evaluate((n) => performance.getEntriesByName(n, "mark")[0]?.startTime ?? null, name);
}

/** Whether the page scrolls horizontally (it never should, at any viewport). */
export function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}
