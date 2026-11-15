import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { GpxError, parseGpx } from "../../packages/core/src/index.ts";
import { hasHorizontalScroll, openApp } from "../support/app.ts";
import {
  CORPUS,
  INVALID,
  METERS_PER_MILE,
  corpusPath,
  expectRouteDrawn,
  golden,
  invalidPath,
  isPhone,
  statNumber,
  uploadGpx,
} from "../support/course.ts";

const FEET_PER_METER = 1 / 0.3048;

/** The error the parser throws for a file: the copy the app must show, word for word. */
function parserMessage(path: string): string {
  try {
    parseGpx(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof GpxError) return error.message;
  }
  throw new Error(`${path} parsed without a GpxError`);
}

async function expectDistanceMiles(page: Page, meters: number): Promise<void> {
  await expect(page.getByTestId("stat-distance")).toContainText("mi");
  expect(Math.abs((await statNumber(page, "stat-distance")) - meters / METERS_PER_MILE)).toBeLessThanOrEqual(0.006);
}

// B1: every file in the corpus loads, draws its route and shows its distance.
test.describe("the GPX corpus", () => {
  for (const file of CORPUS) {
    test(`${file} draws its route and shows its distance`, async ({ page }) => {
      const expected = golden(file);
      await openApp(page);
      await uploadGpx(page, corpusPath(file));
      await expectRouteDrawn(page);
      await expect(page.getByTestId("course-summary")).toBeVisible();
      await expectDistanceMiles(page, expected.tracks[expected.defaultTrack]!.distanceM);
      // Elevation always resolves, from GPS or the fixture DEM tiles, and never errors.
      await expect(page.getByTestId("elevation-source")).toBeVisible();
      await expect(page.getByTestId("elevation-error")).toHaveCount(0);
      const gainFt = expected.elevation.gainM * FEET_PER_METER;
      expect(Math.abs((await statNumber(page, "stat-gain")) - gainFt)).toBeLessThanOrEqual(1);
    });
  }
});

// B1: broken files show the parser's specific message, never a crash.
test.describe("broken files", () => {
  for (const file of INVALID) {
    test(`${file} shows its specific error`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await openApp(page);
      await uploadGpx(page, invalidPath(file));
      const alert = page.getByTestId("load-error");
      await expect(alert).toBeVisible();
      await expect(alert).toBeInViewport();
      await expect(alert).toContainText(`Couldn't load ${file}`);
      await expect(page.getByTestId("load-error-message")).toHaveText(parserMessage(invalidPath(file)));
      await expect(page.getByTestId("map")).toHaveAttribute("data-course", "none");
      expect(errors).toEqual([]);
    });
  }

  test("the copy reads as plain advice", async ({ page }) => {
    await openApp(page);
    await uploadGpx(page, invalidPath("kml.gpx"));
    await expect(page.getByRole("alert")).toContainText(
      "This file is a KML file (from Google Earth or Google My Maps), not GPX. Export the course as GPX and try again.",
    );
    await expect(page.getByRole("button", { name: "Choose another file" })).toBeVisible();
  });

  test("a good file after an error replaces the error with the course", async ({ page }) => {
    await openApp(page);
    await uploadGpx(page, invalidPath("single-point.gpx"));
    await expect(page.getByTestId("load-error")).toContainText("single");
    await uploadGpx(page, corpusPath("dodge.gpx"));
    await expectRouteDrawn(page);
    await expect(page.getByTestId("load-error")).toHaveCount(0);
    await expectDistanceMiles(page, golden("dodge.gpx").tracks[0]!.distanceM);
  });

  test("an error after a loaded course clears the course", async ({ page }) => {
    await openApp(page);
    await uploadGpx(page, corpusPath("dodge.gpx"));
    await expectRouteDrawn(page);
    await uploadGpx(page, invalidPath("truncated.gpx"));
    await expect(page.getByTestId("load-error")).toContainText("looks cut off");
    await expect(page.getByTestId("map")).toHaveAttribute("data-course", "none");
  });
});

test("a multi-track file defaults to the longest track and switches on pick", async ({ page }) => {
  const expected = golden("multi-track.gpx");
  await openApp(page);
  await uploadGpx(page, corpusPath("multi-track.gpx"));
  await expectRouteDrawn(page);
  const picker = page.getByRole("group", { name: "This file has 3 courses" });
  await expect(picker.getByRole("radio")).toHaveCount(3);
  await expect(picker.getByRole("radio", { name: /Race/ })).toBeChecked();
  await expect(page.getByTestId("course-title")).toHaveText("Race");
  await expectDistanceMiles(page, expected.tracks[1]!.distanceM);

  await picker.getByText("Cool-down").click();
  await expect(picker.getByRole("radio", { name: /Cool-down/ })).toBeChecked();
  await expect(page.getByTestId("course-title")).toHaveText("Cool-down");
  await expectDistanceMiles(page, expected.tracks[2]!.distanceM);
  await expectRouteDrawn(page);
  // The route has no elevation, so the profile comes from the DEM.
  await expect(page.getByTestId("elevation-source")).toContainText("terrain data");
});

// B3: a file without elevation still gets elevation stats, from the (fixture) DEM.
test("a GPX without elevation shows elevation from terrain data", async ({ page }) => {
  const expected = golden("no-elevation.gpx");
  expect(expected.elevation.source).toBe("dem");
  await openApp(page);
  await uploadGpx(page, corpusPath("no-elevation.gpx"));
  await expectRouteDrawn(page);
  await expect(page.getByTestId("elevation-source")).toHaveText(
    "This file has no elevation, so it comes from terrain data for the area.",
  );
  const minFt = expected.elevation.minM * FEET_PER_METER;
  const maxFt = expected.elevation.maxM * FEET_PER_METER;
  expect(Math.abs((await statNumber(page, "stat-min")) - minFt)).toBeLessThanOrEqual(1);
  expect(Math.abs((await statNumber(page, "stat-max")) - maxFt)).toBeLessThanOrEqual(1);
});

test("the units switch shows kilometers and meters, and is remembered", async ({ page }) => {
  const expected = golden("boston.gpx");
  await openApp(page);
  await uploadGpx(page, corpusPath("boston.gpx"));
  await expectRouteDrawn(page);
  await expectDistanceMiles(page, expected.tracks[0]!.distanceM);
  await page.getByText("km", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Kilometers and meters" })).toBeChecked();
  await expect(page.getByTestId("stat-distance")).toContainText("km");
  expect(Math.abs((await statNumber(page, "stat-distance")) - expected.tracks[0]!.distanceM / 1000)).toBeLessThan(
    0.006,
  );
  await expect(page.getByTestId("stat-max")).toContainText("m");
  expect(Math.abs((await statNumber(page, "stat-max")) - expected.elevation.maxM)).toBeLessThanOrEqual(1);

  // The reload brings the course back (the saved session), still in kilometers.
  await page.reload();
  await expectRouteDrawn(page);
  await expect(page.getByTestId("stat-distance")).toContainText("km");
});

test("when elevation tiles cannot be downloaded, the course still shows and can retry", async ({ page }) => {
  await openApp(page);
  // Fail every DEM tile on top of the fixture route.
  await page
    .context()
    .route("https://s3.amazonaws.com/elevation-tiles-prod/**", (route) =>
      route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" } }),
    );
  await uploadGpx(page, corpusPath("no-elevation.gpx"));
  await expectRouteDrawn(page);
  await expectDistanceMiles(page, golden("no-elevation.gpx").tracks[0]!.distanceM);
  await expect(page.getByTestId("elevation-error")).toContainText(
    "Elevation data could not be downloaded. Check your connection and try again.",
  );
  await page.context().unroute("https://s3.amazonaws.com/elevation-tiles-prod/**");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("elevation-source")).toContainText("terrain data");
});

test.describe("phone", () => {
  test.skip(({ page }) => !isPhone(page), "phone layout only");

  test("loading from the header at peek raises the sheet to show the course", async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "peek");
    await uploadGpx(page, corpusPath("Lakefront-Loops-5K.gpx"));
    await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "half");
    await expectRouteDrawn(page);
    // The sheet leads with the profile, right under the map it scrubs; the stats follow below.
    await expect(page.getByRole("slider", { name: "Elevation profile" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("course-title")).toBeAttached();
    await expect(page.getByRole("button", { name: "Load GPX", exact: true })).toHaveCount(0);
    expect(await hasHorizontalScroll(page)).toBe(false);
  });
});

test.describe("desktop", () => {
  test.skip(({ page }) => isPhone(page), "drag and drop is a desktop gesture");

  test("dropping a GPX file anywhere on the window loads it", async ({ page }) => {
    await openApp(page);
    const text = readFileSync(corpusPath("scurve.gpx"), "utf8");
    const transfer = await page.evaluateHandle((gpx) => {
      const dt = new DataTransfer();
      dt.items.add(new File([gpx], "scurve.gpx", { type: "application/gpx+xml" }));
      return dt;
    }, text);
    const map = page.getByTestId("map");
    await map.dispatchEvent("dragenter", { dataTransfer: transfer });
    await expect(page.getByTestId("drop-overlay")).toBeVisible();
    await expect(page.getByTestId("drop-overlay")).toContainText("Drop your GPX file to load it");
    await map.dispatchEvent("dragover", { dataTransfer: transfer });
    await map.dispatchEvent("drop", { dataTransfer: transfer });
    await expect(page.getByTestId("drop-overlay")).toHaveCount(0);
    await expectRouteDrawn(page);
    await expect(page.getByTestId("course-title")).toHaveText("2.54 mi route");
    await expectDistanceMiles(page, golden("scurve.gpx").tracks[0]!.distanceM);
  });

  test("dragging a file out again hides the drop target", async ({ page }) => {
    await openApp(page);
    const transfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["<gpx/>"], "x.gpx"));
      return dt;
    });
    const map = page.getByTestId("map");
    await map.dispatchEvent("dragenter", { dataTransfer: transfer });
    await expect(page.getByTestId("drop-overlay")).toBeVisible();
    await map.dispatchEvent("dragleave", { dataTransfer: transfer });
    await expect(page.getByTestId("drop-overlay")).toHaveCount(0);
  });
});
