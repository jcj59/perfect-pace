import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { DEM_CACHE, DEM_CACHE_MAX_TILES, SHELL_CACHE_PREFIX } from "../../apps/web/src/sw/policy.ts";
import { TERRARIUM, openApp } from "../support/app.ts";
import { corpusPath, expectRouteDrawn, uploadGpx } from "../support/course.ts";
import { expectPlanSettled } from "../support/plan.ts";
import { planSnapshot } from "../support/share.ts";

// B7: installable, and works offline for uploaded courses. The rest of the suite runs with
// service workers blocked (playwright.config.ts); these tests turn them on.
test.use({ serviceWorkers: "allow" });

/** Wait until the service worker is active and controls the page (it claims it on activation). */
async function expectControlled(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state ?? null)).toBe("activated");
}

/** Every URL in every cache, by cache name. */
function cachedUrls(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    for (const name of await caches.keys()) {
      out[name] = (await (await caches.open(name)).keys()).map((r) => r.url);
    }
    return out;
  });
}

test("the manifest and icons are served, and Chrome finds the app installable", async ({
  page,
  request,
  browserName,
}) => {
  await openApp(page);
  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestUrl).toBe("/manifest.webmanifest");
  const response = await request.get(manifestUrl!);
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = (await response.json()) as {
    name: string;
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };
  expect(manifest).toMatchObject({ name: "Perfect Pace", start_url: "/", display: "standalone" });
  for (const purpose of ["any", "maskable"]) {
    expect(manifest.icons.filter((i) => i.purpose === purpose).map((i) => i.sizes)).toEqual(["192x192", "512x512"]);
  }
  for (const src of [...manifest.icons.map((i) => i.src), "/icons/apple-touch-icon.png"]) {
    const icon = await request.get(src);
    expect(icon.ok(), src).toBe(true);
    expect(icon.headers()["content-type"], src).toBe("image/png");
  }
  await expectControlled(page);
  // What Chrome checks before it offers to install (Lighthouse's former installability audit),
  // through the DevTools protocol, which only Chromium has (https://github.com/jcj59/perfect-pace/issues/42).
  if (browserName !== "chromium") return;
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as {
    installabilityErrors: { errorId: string }[];
  };
  expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);
});

test("the service worker precaches the build, and never caches the API", async ({ page, request }) => {
  await openApp(page);
  await expectControlled(page);
  const sw = await request.get("/sw.js");
  expect(sw.headers()["cache-control"]).toBe("no-cache");
  await page.evaluate(() => fetch("/api/health").then((r) => r.json()));
  const caches = await cachedUrls(page);
  const shells = Object.keys(caches).filter((name) => name.startsWith(SHELL_CACHE_PREFIX));
  expect(shells).toHaveLength(1);
  const shell = caches[shells[0]!]!.map((url) => new URL(url).pathname);
  // The page's own script and styles, the shell, the manifest and the icons.
  const scripts = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>("script[src], link[rel=stylesheet]")].map(
      (e) => new URL("src" in e ? e.src : e.href).pathname,
    ),
  );
  expect(shell).toEqual(
    expect.arrayContaining(["/", "/manifest.webmanifest", "/icons/icon-192.png", "/favicon.svg", ...scripts]),
  );
  expect(shell.some((path) => /^\/assets\/MapView-.*\.js$/.test(path))).toBe(true);
  expect(shell.some((path) => /^\/assets\/core\.worker-.*\.js$/.test(path))).toBe(true);
  expect(
    Object.values(caches)
      .flat()
      .filter((url) => url.includes("/api/")),
  ).toEqual([]);
});

test("an online reload gets the latest build from the server, not the cached one", async ({ page, browserName }) => {
  test.skip(
    browserName === "firefox",
    "Firefox's Playwright cannot route a service worker's own fetches: https://github.com/jcj59/perfect-pace/issues/42",
  );
  await openApp(page);
  await expectControlled(page);
  // A "new deploy": the server's page now carries a marker the cached shell does not.
  await page.context().route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace("<head>", '<head><meta name="pp-fresh" content="1">');
      await route.fulfill({ response, body });
    },
  );
  await page.reload();
  await expect(page.locator('meta[name="pp-fresh"]')).toHaveCount(1);
});

test("a newer service worker takes over, and the page offers a reload", async ({ page }) => {
  await openApp(page);
  await expectControlled(page);
  const status = page.getByTestId("status-line");
  await expect(status).toHaveAttribute("data-state", "idle");
  // Stand-in for a deploy: the same registration gets a new worker (Playwright cannot rewrite
  // the worker script's own request, so the new one comes from another script URL).
  await page.evaluate(() => navigator.serviceWorker.register("/sw.js?next", { scope: "/" }));
  await expect(status).toHaveAttribute("data-state", "update");
  await expect(status).toContainText(/A new version is ready|Reload to update/);
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await page.getByTestId("reload-update").click();
  await expect(status).toHaveAttribute("data-state", "idle");
  await expectControlled(page);
});

test("an uploaded course reloads offline, with its elevation from cached terrain tiles", async ({
  page,
  browserName,
}) => {
  await openApp(page);
  await expectControlled(page);
  // This file has no elevation of its own, so its profile comes from the DEM tiles.
  await uploadGpx(page, corpusPath("no-elevation.gpx"));
  await expectRouteDrawn(page);
  await expect(page.getByTestId("elevation-source")).toContainText("terrain data");
  const before = await planSnapshot(page);
  const dem = (await cachedUrls(page))[DEM_CACHE] ?? [];
  expect(dem.length).toBeGreaterThan(0);

  // Offline for real: no stubs to fall back on, so only the service worker's caches can answer.
  await page.context().unrouteAll({ behavior: "ignoreErrors" });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Perfect Pace" })).toBeVisible();
  await expect(page.getByTestId("status-line")).toHaveAttribute("data-state", "offline");
  await expectRouteDrawn(page);
  await expect(page.getByTestId("elevation-source")).toContainText("terrain data");
  await expectPlanSettled(page);
  expect(await planSnapshot(page)).toEqual(before);

  // Drawing needs the network, and the panel says so.
  await expect(page.getByTestId("draw-route").locator("visible=true").first()).toBeDisabled();

  // Back online: the status line returns to the tagline, and drawing comes back. In Firefox,
  // Playwright's emulated network coming back fires no `online` in a page reloaded while
  // offline (navigator.onLine turns true silently), so the page cannot notice: https://github.com/jcj59/perfect-pace/issues/42
  if (browserName === "firefox") return;
  await page.context().setOffline(false);
  await expect(page.getByTestId("status-line")).toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("draw-route").locator("visible=true").first()).toBeEnabled();
});

test("offline with nothing loaded, the panel says drawing needs a connection", async ({ page }) => {
  await openApp(page);
  await expectControlled(page);
  // Offline for real, with no stubs left (Firefox fails a routed reload while offline before the
  // service worker can answer it).
  await page.context().unrouteAll({ behavior: "ignoreErrors" });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.getByTestId("status-line")).toHaveAttribute("data-state", "offline");
  await expect(page.getByTestId("status-line")).toContainText("Offline");
  const sheet = page.getByTestId("sheet-handle");
  if (await sheet.isVisible()) await sheet.click();
  await expect(page.getByTestId("draw-card-note")).toHaveText(/Drawing needs an internet connection/);
  for (const button of await page.getByTestId("draw-route").all()) await expect(button).toBeDisabled();
});

test(`the terrain tile cache keeps at most ${DEM_CACHE_MAX_TILES} tiles, dropping the least recently used`, async ({
  page,
}) => {
  test.slow();
  await openApp(page);
  await expectControlled(page);
  // Any tile the test asks for gets the same small PNG.
  const png = readFileSync(new URL("../../packages/core/test/fixtures/dem/12/1177/1512.png", import.meta.url));
  await page.context().unroute(TERRARIUM);
  await page
    .context()
    .route(TERRARIUM, (route) =>
      route.fulfill({ contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: png }),
    );
  const url = (i: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/${i}/1.png`;
  const fetchTiles = (from: number, to: number) =>
    page.evaluate(
      async ({ from, to, base }) => {
        for (let i = from; i < to; i++) {
          const response = await fetch(base.replace("{i}", String(i)));
          if (!response.ok) throw new Error(`tile ${i}: ${response.status}`);
        }
      },
      { from, to, base: url(0).replace("/0/", "/{i}/") },
    );
  const demKeys = async () => (await cachedUrls(page))[DEM_CACHE] ?? [];

  await page.evaluate((name) => caches.delete(name), DEM_CACHE);
  await fetchTiles(0, DEM_CACHE_MAX_TILES);
  await expect.poll(async () => (await demKeys()).length).toBe(DEM_CACHE_MAX_TILES);
  // Use tile 0 again: it becomes the most recently used.
  await fetchTiles(0, 1);
  await expect.poll(async () => (await demKeys()).at(-1)).toBe(url(0));
  await fetchTiles(DEM_CACHE_MAX_TILES, DEM_CACHE_MAX_TILES + 20);
  await expect.poll(async () => (await demKeys()).at(-1)).toBe(url(DEM_CACHE_MAX_TILES + 19));
  const keys = await demKeys();
  expect(keys).toHaveLength(DEM_CACHE_MAX_TILES);
  expect(keys).toContain(url(0));
  // The 20 least recently used (1 to 20) are gone; 21 on are kept.
  for (let i = 1; i <= 20; i++) expect(keys).not.toContain(url(i));
  expect(keys).toContain(url(21));
});
