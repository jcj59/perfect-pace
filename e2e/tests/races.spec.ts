import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { Race } from "../../apps/web/src/races/catalog.ts";
import { type ColorScheme, hasHorizontalScroll, openApp, stubDemTiles, stubMapNetwork } from "../support/app.ts";
import { corpusPath, expectRouteDrawn, isPhone } from "../support/course.ts";

// B13: the race library at /races, and opening a race's course with /?race=<slug>.

const CATALOG = JSON.parse(
  readFileSync(new URL("../../apps/web/src/races/catalog.json", import.meta.url), "utf8"),
) as Race[];
const BOSTON_GPX = readFileSync(corpusPath("boston.gpx"));

/**
 * The shipped catalog has no courses yet, so the tests that open one give Boston a course: a
 * catalog override set before the app loads (see `raceCatalog`), and its file served from the
 * core corpus's Boston Marathon.
 */
async function withBostonCourse(page: Page): Promise<void> {
  const catalog = CATALOG.map((r) => (r.slug === "boston-marathon" ? { ...r, gpx: "/races/boston-marathon.gpx" } : r));
  await page.addInitScript((races) => {
    (window as { __PP_RACE_CATALOG__?: unknown }).__PP_RACE_CATALOG__ = races;
  }, catalog);
  await page.route("**/races/boston-marathon.gpx", (route) =>
    route.fulfill({ contentType: "application/gpx+xml", body: BOSTON_GPX }),
  );
}

async function openRaces(page: Page, colorScheme: ColorScheme = "light"): Promise<void> {
  await page.emulateMedia({ colorScheme });
  await page.goto("/races");
  await expect(page.getByRole("heading", { level: 1, name: "Race library" })).toBeVisible();
}

const rows = (page: Page) => page.getByTestId("race-row");
const slugs = (page: Page) => rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-slug")));

/** The saved session's race, which is how a reload knows the course is that race's. */
const savedRace = (page: Page) =>
  page.evaluate(
    () =>
      (JSON.parse(localStorage.getItem("pp:session") ?? "null") as { course?: { race?: string } } | null)?.course
        ?.race ?? null,
  );

test("the page lists every race, grouped, each with its distance, month and a coming-soon badge", async ({ page }) => {
  await openRaces(page);
  await expect(rows(page)).toHaveCount(CATALOG.length);
  await expect(page.getByTestId("race-group")).toHaveCount(5);
  await expect(page.getByTestId("race-group").first()).toHaveAttribute("data-series", "world-marathon-majors");
  const boston = page.locator('[data-testid="race-row"][data-slug="boston-marathon"]');
  await expect(boston).toContainText("Boston Marathon");
  await expect(boston).toContainText("Boston, MA");
  await expect(boston).toContainText("April");
  await expect(boston.getByTestId("race-distance")).toHaveText("Marathon");
  await expect(boston.getByTestId("race-badge")).toHaveText("Course coming soon");
  // No course yet anywhere: nothing links into the planner.
  await expect(page.getByTestId("race-badge")).toHaveCount(CATALOG.length);
  await expect(page.locator('[data-testid="race-row"] a')).toHaveCount(0);
  expect(await hasHorizontalScroll(page)).toBe(false);
  await expect(page).toHaveTitle("Races · Perfect Pace");
});

test("search finds races by name or city", async ({ page }) => {
  await openRaces(page);
  const search = page.getByRole("searchbox", { name: "Search races" });
  await search.fill("boston");
  await expect(rows(page)).toHaveCount(4);
  expect((await slugs(page)).sort()).toEqual(["baa-10k", "boston-5k", "boston-half", "boston-marathon"]);
  await expect(page.getByTestId("race-count")).toHaveText("4 races");

  await search.fill("st. george");
  expect(await slugs(page)).toEqual(["st-george-marathon"]);
  await search.fill("Duluth");
  expect((await slugs(page)).sort()).toEqual(["garry-bjorklund-half-marathon", "grandmas-marathon"]);

  await search.fill("nowhere at all");
  await expect(page.getByTestId("races-empty")).toContainText("No races match");
  await page.getByRole("button", { name: "Show all races" }).click();
  await expect(search).toHaveValue("");
  await expect(rows(page)).toHaveCount(CATALOG.length);
});

test("the filter chips show one group at a time", async ({ page }) => {
  await openRaces(page);
  const chip = (name: string) => page.getByRole("button", { name, exact: true });
  await expect(chip("All races")).toHaveAttribute("aria-pressed", "true");

  await chip("World Marathon Majors").click();
  await expect(chip("World Marathon Majors")).toHaveAttribute("aria-pressed", "true");
  await expect(chip("All races")).toHaveAttribute("aria-pressed", "false");
  await expect(rows(page)).toHaveCount(8);

  // Boston, Chicago and New York are US marathons too.
  await chip("US marathons").click();
  await expect(page.getByTestId("race-group")).toHaveCount(1);
  expect(await slugs(page)).toEqual(expect.arrayContaining(["boston-marathon", "chicago-marathon", "nyc-marathon"]));

  await chip("Half marathons").click();
  for (const label of await page.getByTestId("race-distance").allInnerTexts()) expect(label).toBe("Half");

  await chip("10 mi to 15K").click();
  expect(await slugs(page)).toEqual(expect.arrayContaining(["cherry-blossom-ten-mile", "gate-river-run", "bloomsday"]));

  // Search works within the chip.
  await chip("10K and shorter").click();
  await page.getByRole("searchbox", { name: "Search races" }).fill("boston");
  expect((await slugs(page)).sort()).toEqual(["baa-10k", "boston-5k"]);

  // Pressing the picked chip again shows everything.
  await chip("10K and shorter").click();
  await expect(chip("All races")).toHaveAttribute("aria-pressed", "true");
});

test("the empty state's Browse races opens the page, and its back link returns", async ({ page }) => {
  await openApp(page);
  if (isPhone(page)) {
    await page.getByTestId("sheet-handle").click();
    await page.getByTestId("sheet-handle").click();
  }
  await page.getByTestId("browse-races").click();
  await expect(page).toHaveURL(/\/races$/);
  await expect(page.getByRole("heading", { level: 1, name: "Race library" })).toBeVisible();
  await page.getByTestId("races-back").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Perfect Pace" })).toBeVisible();
  // The browser's back button returns to the library too.
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Race library" })).toBeVisible();
});

test("the panel header links to the races", async ({ page }) => {
  await withBostonCourse(page);
  await stubMapNetwork(page);
  await stubDemTiles(page);
  // On a phone the header's own buttons fill it before there is a course, so open one first.
  await page.goto("/?race=boston-marathon");
  await expectRouteDrawn(page);
  await page.getByTestId("header-races").click();
  await expect(page).toHaveURL(/\/races$/);
  await expect(page.getByRole("heading", { level: 1, name: "Race library" })).toBeVisible();
});

test("a race with a course opens in the planner, and stays that race's after a reload", async ({ page }) => {
  await withBostonCourse(page);
  await stubMapNetwork(page);
  await stubDemTiles(page);
  await openRaces(page);
  const boston = page.locator('[data-testid="race-row"][data-slug="boston-marathon"]');
  await expect(boston).toHaveAttribute("data-has-course", "true");
  await expect(boston.getByTestId("race-badge")).toHaveCount(0);
  await boston.getByRole("link").click();

  await expectRouteDrawn(page);
  await expect(page.getByTestId("course-source").locator("visible=true")).toHaveText("Boston Marathon.gpx");
  // The race link is taken off the address, so a reload does not undo later changes.
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => savedRace(page)).toBe("boston-marathon");

  await page.reload();
  await expectRouteDrawn(page);
  await expect(page.getByTestId("course-source").locator("visible=true")).toHaveText("Boston Marathon.gpx");
  await expect.poll(() => savedRace(page)).toBe("boston-marathon");
});

test("a race link opened directly loads the race", async ({ page }) => {
  await withBostonCourse(page);
  await stubMapNetwork(page);
  await stubDemTiles(page);
  await page.goto("/?race=boston-marathon");
  await expectRouteDrawn(page);
  await expect(page.getByTestId("course-source").locator("visible=true")).toHaveText("Boston Marathon.gpx");
});

test("a race without a course says it is coming soon", async ({ page }) => {
  await stubMapNetwork(page);
  await page.goto("/?race=tokyo-marathon");
  await expect(page.getByTestId("link-error-message")).toHaveText(
    "The Tokyo Marathon course is coming soon. Until then, load a GPX file or draw the route.",
  );
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/?race=not-a-race");
  await expect(page.getByTestId("link-error-message")).toContainText("not in the race library");
});

test("a course that fails to download says so", async ({ page }) => {
  await withBostonCourse(page);
  await page.route("**/races/boston-marathon.gpx", (route) => route.fulfill({ status: 503 }));
  await stubMapNetwork(page);
  await page.goto("/?race=boston-marathon");
  await expect(page.getByTestId("link-error-message")).toContainText("could not be downloaded");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

for (const scheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`the races page has no axe violations, ${scheme}`, async ({ page }) => {
    await openRaces(page, scheme);
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    await page.getByRole("button", { name: "Half marathons", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search races" }).fill("nowhere");
    await expect(page.getByTestId("races-empty")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test(`a race with a course has no axe violations, ${scheme}`, async ({ page }) => {
    await withBostonCourse(page);
    await openRaces(page, scheme);
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test(`races page, ${scheme} @visual`, async ({ page }) => {
    await openRaces(page, scheme);
    await expect(page).toHaveScreenshot(`races-${scheme}.png`);
  });

  test(`races page filtered and searched, ${scheme} @visual`, async ({ page }) => {
    await withBostonCourse(page);
    await openRaces(page, scheme);
    await page.getByRole("button", { name: "US marathons", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search races" }).fill("boston");
    await page.getByRole("searchbox", { name: "Search races" }).blur();
    await expect(page).toHaveScreenshot(`races-filtered-${scheme}.png`);
  });
}
