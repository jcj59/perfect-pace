import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { encodeSharedCourse, parseGpx, simplifyForShare } from "../../packages/core/src/index.ts";
import { hasHorizontalScroll, openApp } from "../support/app.ts";
import { METERS_PER_MILE, corpusPath, expectRouteDrawn, isPhone, uploadGpx } from "../support/course.ts";
import { ITHACA } from "../support/draw.ts";
import { changePlan, expectPlanSettled, planBoston, planRenderedAt, seconds } from "../support/plan.ts";
import { copyShareLink, downloadFrom, freshContext, openLink } from "../support/share.ts";

// B11: plan types (Optimal, Even, Splits, Custom) and the Segments | Splits table views.
test.use({ permissions: ["clipboard-read", "clipboard-write"], geolocation: ITHACA });

/** Boston's length as the app measures it (the golden snapshot's resampled profile ends there). */
interface PlanTypesGolden {
  units: { types: { segments: { endM: number }[] }[] }[];
}
const BOSTON_M = (
  JSON.parse(
    readFileSync(new URL("../../packages/core/test/golden/plan-types-boston.json", import.meta.url), "utf8"),
  ) as PlanTypesGolden
).units[0]!.types[0]!.segments[0]!.endM;

function planType(page: Page, name: "Optimal" | "Even pace" | "Splits" | "Custom"): Locator {
  return page.getByTestId("plan-type").getByRole("radio", { name, exact: true });
}

/** Pick a radio by its label, as a person taps it (the input itself is visually hidden). */
async function pick(radio: Locator): Promise<void> {
  const label = radio.locator("xpath=..");
  await label.scrollIntoViewIfNeeded();
  await label.click();
  await expect(radio).toBeChecked();
}

async function choosePlanType(page: Page, name: Parameters<typeof planType>[1]): Promise<void> {
  await changePlan(page, () => pick(planType(page, name)));
}

/** The segment times on screen add up to the total, which is the goal. */
async function expectTimesAddUp(page: Page, goal: string): Promise<void> {
  const times = (await page.getByTestId("segment-time").allInnerTexts()).map(seconds);
  expect(times.reduce((a, b) => a + b, 0)).toBe(seconds(goal));
  await expect(page.getByTestId("plan-total")).toHaveText(goal);
}

/** The plotted line's horizontal extent on screen, and a height inside the plot. */
async function plotSpan(page: Page): Promise<{ left: number; width: number; y: number }> {
  const chart = page.getByTestId("elevation-chart");
  await chart.scrollIntoViewIfNeeded();
  const box = (await page.getByTestId("chart-line").boundingBox())!;
  return { left: box.x, width: box.width, y: box.y + box.height * 0.6 };
}

/** A distance as the breakpoint list shows it: miles to two decimals, no trailing zeros. */
const asInput = (m: number) => String(Math.round((m / METERS_PER_MILE) * 100) / 100);

/** Load Lakefront Loops (inside the fixture DEM, so a link's copy gets the same terrain) and plan it for 24:30. */
async function planLakefront(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  await uploadGpx(page, corpusPath("Lakefront-Loops-5K.gpx"));
  await expectRouteDrawn(page);
  await expectPlanSettled(page);
  await changePlan(page, async () => {
    const input = page.getByLabel("Goal time");
    await input.fill("24:30");
    await input.press("Enter");
  });
}

/** Each custom breakpoint as the chart draws it: meters from the start. */
async function chartBreakpoints(page: Page): Promise<number[]> {
  const values = await page.getByTestId("chart-breakpoint").evaluateAll((els) => els.map((e) => e.dataset["m"]));
  return values.map(Number);
}

/** Wait until the plan on screen has `count` segments, recomputed and drawn. */
async function expectSegments(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId("segment-row")).toHaveCount(count, { timeout: 15_000 });
  await expectPlanSettled(page);
}

test("Even holds one pace, the goal's, and hides the Optimal inputs", async ({ page }) => {
  await planBoston(page);
  await expect(planType(page, "Optimal")).toBeChecked();
  await choosePlanType(page, "Even pace");
  await expectSegments(page, 1);
  await expect(page.getByLabel("Pace changes")).toHaveCount(0);
  await expect(page.getByTestId("min-segment")).toHaveCount(0);
  // 3:00:00 over Boston's 26.28 mi is 6:51 a mile.
  await expect(page.getByTestId("segment-pace")).toHaveText("6:51");
  await expect(page.getByTestId("plan-type-note")).toContainText("One pace for the whole course: 6:51 /mi");
  await expect(page.getByTestId("plan-type-note")).toContainText(/On average \d+ s\/mi off the ideal pace/);
  await expectTimesAddUp(page, "3:00:00");
  await expect(page.getByTestId("map")).toHaveAttribute("data-segments", "1");
  await expect(page.getByTestId("chart-segment")).toHaveCount(1);

  // Back to Optimal: its inputs are as they were.
  await choosePlanType(page, "Optimal");
  await expect(page.getByLabel("Pace changes")).toHaveValue("6");
  await expectSegments(page, 7);
});

test("Splits paces every mile, kilometer or typed split, the last one the remainder", async ({ page }) => {
  await planBoston(page);
  await choosePlanType(page, "Splits");
  const lengthMi = BOSTON_M / METERS_PER_MILE;
  await expectSegments(page, Math.ceil(lengthMi));
  await expect(page.getByTestId("split-length").getByRole("radio", { name: "1 mile" })).toBeChecked();
  const ranges = await page.getByTestId("segment-row").getByRole("button").allInnerTexts();
  expect(ranges[0]).toBe("0.0\u20131.0");
  expect(ranges.at(-1)).toBe(`26.0\u2013${lengthMi.toFixed(1)}`);
  await expect(page.getByTestId("plan-type-note")).toContainText(
    `27 splits, each at its own pace. The last is the ${(lengthMi - 26).toFixed(2)} mi left.`,
  );
  await expectTimesAddUp(page, "3:00:00");

  await changePlan(page, () => pick(page.getByTestId("split-length").getByRole("radio", { name: "1 kilometer" })));
  await expectSegments(page, Math.ceil(BOSTON_M / 1000));
  await expectTimesAddUp(page, "3:00:00");

  // A typed split: 5 to start with, then 10 (in miles, the units on screen).
  await changePlan(page, () => pick(page.getByTestId("split-length").getByRole("radio", { name: "Custom" })));
  await expectSegments(page, 6);
  const custom = page.getByLabel("Split every");
  await expect(custom).toHaveValue("5");
  await changePlan(page, () => custom.fill("10"));
  await expectSegments(page, 3);
  await expectTimesAddUp(page, "3:00:00");
  // Nonsense is refused with a reason, and the plan stays as it was.
  await custom.fill("0.01");
  await custom.press("Enter");
  await expect(page.getByTestId("split-error")).toHaveText("Use splits of at least 0.1 mi.");
  await expect(page.getByTestId("segment-row")).toHaveCount(3);
});

test.describe("custom breakpoints by mouse", () => {
  test.skip(({ page }) => isPhone(page), "a mouse gesture; phones place and drag by touch below");

  test("are placed by clicking the chart and dragged to move", async ({ page }) => {
    await planBoston(page);
    await choosePlanType(page, "Custom");
    await expectSegments(page, 1);
    await expect(page.getByTestId("elevation-chart")).toHaveAttribute("data-editing", "breakpoints");

    // A click places one, snapped to the 10 m resample spacing.
    let span = await plotSpan(page);
    await changePlan(page, () => page.mouse.click(span.left + span.width * 0.3, span.y));
    await expectSegments(page, 2);
    let [first] = await chartBreakpoints(page);
    expect(Math.abs(first! - BOSTON_M * 0.3)).toBeLessThan(BOSTON_M / 100);
    expect(first! % 10).toBe(0);
    await expect(page.getByTestId("breakpoint-input")).toHaveValue(asInput(first!));

    // A press that moves is a scrub, not a click: nothing is added.
    await page.mouse.move(span.left + span.width * 0.7, span.y);
    await page.mouse.down();
    await page.mouse.move(span.left + span.width * 0.8, span.y, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId("chart-breakpoint")).toHaveCount(1);

    // Dragging the line moves it; the segments follow and still add up to the goal.
    span = await plotSpan(page);
    const line = (await page.getByTestId("chart-breakpoint").boundingBox())!;
    const from = line.x + line.width / 2;
    const before = await planRenderedAt(page);
    await page.mouse.move(from, span.y);
    await page.mouse.down();
    await expect(page.getByTestId("chart-breakpoint")).toHaveAttribute("data-dragging", "true");
    await page.mouse.move(span.left + span.width * 0.6, span.y, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => planRenderedAt(page), { timeout: 15_000 }).toBeGreaterThan(before);
    await expectSegments(page, 2);
    [first] = await chartBreakpoints(page);
    expect(Math.abs(first! - BOSTON_M * 0.6)).toBeLessThan(BOSTON_M / 100);
    const ends = await page.getByTestId("segment-row").getByRole("button").allInnerTexts();
    expect(ends[0]).toBe(`0.0\u2013${(first! / METERS_PER_MILE).toFixed(1)}`);
    await expectTimesAddUp(page, "3:00:00");
    await expect(page.getByTestId("map")).toHaveAttribute("data-segments", "2");
  });
});

test.describe("custom breakpoints by touch", () => {
  test.skip(({ page }) => !isPhone(page), "phone touch");

  test("are placed by tapping the chart and dragged to move", async ({ page }) => {
    await planBoston(page);
    await choosePlanType(page, "Custom");
    await expectSegments(page, 1);
    await expect(page.getByTestId("breakpoint-hint")).toContainText("Tap the elevation profile");
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });

    let span = await plotSpan(page);
    await changePlan(page, async () => {
      await touch("touchStart", span.left + span.width * 0.4, span.y);
      await touch("touchEnd", span.left + span.width * 0.4, span.y);
    });
    await expectSegments(page, 2);
    const [first] = await chartBreakpoints(page);
    expect(Math.abs(first! - BOSTON_M * 0.4)).toBeLessThan(BOSTON_M / 50);

    // A second tap further on places another.
    span = await plotSpan(page);
    await changePlan(page, async () => {
      await touch("touchStart", span.left + span.width * 0.8, span.y);
      await touch("touchEnd", span.left + span.width * 0.8, span.y);
    });
    await expectSegments(page, 3);

    // Dragging the first one by touch moves it (a fingertip beside the line still picks it up).
    span = await plotSpan(page);
    const line = (await page.getByTestId("chart-breakpoint").first().boundingBox())!;
    const from = line.x + line.width / 2 + 6;
    const to = span.left + span.width * 0.6;
    const before = await planRenderedAt(page);
    await touch("touchStart", from, span.y);
    for (let i = 1; i <= 12; i++) await touch("touchMove", from + ((to - from) * i) / 12, span.y);
    await touch("touchEnd", to, span.y);
    await expect.poll(() => planRenderedAt(page), { timeout: 15_000 }).toBeGreaterThan(before);
    await expectSegments(page, 3);
    const [moved, second] = await chartBreakpoints(page);
    expect(Math.abs(moved! - BOSTON_M * 0.6)).toBeLessThan(BOSTON_M / 50);
    expect(moved!).not.toBe(first);
    expect(second!).toBeGreaterThan(moved!);
    // The drag did not move the sheet.
    await expect(page.getByTestId("sheet")).not.toHaveAttribute("data-snap", "peek");
    await expectTimesAddUp(page, "3:00:00");
    expect(await hasHorizontalScroll(page)).toBe(false);
  });
});

test("custom breakpoints work from the keyboard: Enter on the chart, typed distances and remove", async ({ page }) => {
  await planBoston(page);
  await choosePlanType(page, "Custom");
  const chart = page.getByRole("slider", { name: "Elevation profile" });
  await chart.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("PageUp");
  await page.keyboard.press("PageUp");
  await expect(chart).toHaveAttribute("aria-valuenow", "2");
  await changePlan(page, () => page.keyboard.press("Enter"));
  await expectSegments(page, 2);
  const input = page.getByTestId("breakpoint-input");
  await expect(input).toHaveValue("2");

  // Add breakpoint puts one in the middle of the longest segment.
  await changePlan(page, () => page.getByRole("button", { name: "Add breakpoint" }).click());
  await expectSegments(page, 3);
  const added = (await chartBreakpoints(page))[1]!;
  expect(Math.abs(added - (3220 + BOSTON_M) / 2)).toBeLessThanOrEqual(10);
  await expect(input.nth(1)).toHaveValue(asInput(added));

  // Type a distance; it lands on the nearest course point and the rows stay in order.
  await input.nth(1).fill("20");
  await changePlan(page, () => input.nth(1).press("Enter"));
  await expect(input.nth(1)).toHaveValue("20");
  expect((await chartBreakpoints(page))[1]).toBeCloseTo(Math.round((20 * METERS_PER_MILE) / 10) * 10, 0);
  const ranges = await page.getByTestId("segment-row").getByRole("button").allInnerTexts();
  expect(ranges).toEqual(["0.0\u20132.0", "2.0\u201320.0", `20.0\u2013${(BOSTON_M / METERS_PER_MILE).toFixed(1)}`]);
  // Past the finish is refused with a reason.
  await input.first().fill("40");
  await input.first().press("Enter");
  await expect(page.getByTestId("breakpoint-error")).toContainText("between 0 and 26.28 mi");
  await input.first().press("Escape");
  await expect(input.first()).toHaveValue("2");

  // Remove, by keyboard.
  await page.getByRole("button", { name: "Remove breakpoint 1 at 2 mi" }).focus();
  await changePlan(page, () => page.keyboard.press("Enter"));
  await expectSegments(page, 2);
  await expectTimesAddUp(page, "3:00:00");
});

test("the Splits view shows any plan by mile, and the CSV and pace band follow it", async ({ page }) => {
  await planBoston(page);
  await pick(page.getByTestId("table-view").getByRole("radio", { name: "Splits table" }));
  const rows = page.getByTestId("split-row");
  await expect(rows).toHaveCount(26);
  await expect(page.getByTestId("segment-table")).toHaveCount(0);
  const splits = (await page.getByTestId("split-time").allInnerTexts()).map(seconds);
  const elapsed = (await page.getByTestId("split-elapsed").allInnerTexts()).map(seconds);
  let sum = 0;
  splits.slice(0, -1).forEach((s, i) => {
    sum += s;
    expect(elapsed[i]).toBe(sum);
  });
  expect(sum + splits.at(-1)!).toBe(seconds("3:00:00"));
  await expect(page.getByTestId("plan-total")).toHaveText("3:00:00");
  expect(await page.locator('[data-testid="split-row"][data-change]').count()).toBeGreaterThan(0);

  const csv = await downloadFrom(page, "export-csv");
  expect(csv.name).toBe("127th-boston-marathon-42-195-km-mile-splits.csv");
  const lines = csv.text.trimEnd().split("\r\n");
  expect(lines[0]).toBe("Mile,Start (mi),End (mi),Distance (mi),Pace (/mi),Split,Elapsed");
  expect(lines).toHaveLength(28);
  expect(lines.at(-1)).toMatch(/^Finish,26\.00,26\.28,0\.28,\d:\d\d,\d:\d\d,3:00:00$/);

  // Printing in this view bands every mile.
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("band-row")).toHaveCount(27);
  await expect(page.getByTestId("band-elapsed").last()).toHaveText("3:00:00");
  await page.emulateMedia({ media: "screen" });

  // The view and every plan type go together: Even by the mile is one pace all the way.
  await choosePlanTypeInSplits(page, "Even pace");
  const paces = new Set(await page.getByTestId("split-pace").allInnerTexts());
  expect([...paces]).toEqual(["6:51"]);
});

/** Pick a plan type while the Splits view is up, and wait for its plan. */
async function choosePlanTypeInSplits(page: Page, name: Parameters<typeof planType>[1]): Promise<void> {
  const before = await planRenderedAt(page);
  await pick(planType(page, name));
  await expect.poll(() => planRenderedAt(page), { timeout: 15_000 }).toBeGreaterThan(before);
  await expect(page.getByTestId("plan-pending")).not.toHaveAttribute("data-pending");
}

test("the Segments view's pace band holds each segment's pace and the time at its end", async ({ page }) => {
  await planBoston(page);
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("band-row")).toHaveCount(7);
  await expect(page.getByTestId("band-elapsed").last()).toHaveText("3:00:00");
  const paces = await page.getByTestId("band-row").locator("td:nth-child(3)").allInnerTexts();
  await page.emulateMedia({ media: "screen" });
  expect(paces).toEqual(await page.getByTestId("segment-pace").allInnerTexts());
});

test("a link carries the plan type, split and breakpoints, and opens the same plan", async ({
  page,
  browser,
}, testInfo) => {
  await planLakefront(page);
  await choosePlanType(page, "Custom");
  await changePlan(page, () => page.getByRole("button", { name: "Add breakpoint" }).click());
  await changePlan(page, () => page.getByRole("button", { name: "Add breakpoint" }).click());
  await expectSegments(page, 3);
  const breakpoints = await chartBreakpoints(page);
  const link = await copyShareLink(page);
  expect(link).toMatch(
    new RegExp(`#v=2&c=t\\.[A-Za-z0-9_-]+&g=1470&p=c&k=4&s=402\\.336&b=${breakpoints.join("\\.")}&u=mi&n=`),
  );

  const context = await freshContext(browser, testInfo);
  const other = await context.newPage();
  await openLink(other, link);
  await expect(planType(other, "Custom")).toBeChecked({ timeout: 15_000 });
  await expectSegments(other, 3);
  // The copy is simplified, so its points can sit a few meters off; the cuts stay within one.
  const values = await chartBreakpoints(other);
  values.forEach((m, i) => expect(Math.abs(m - breakpoints[i]!)).toBeLessThanOrEqual(10));
  await expect(other.getByTestId("plan-total")).toHaveText("24:30");

  // And Splits with a typed length.
  await choosePlanType(other, "Splits");
  await changePlan(other, () => pick(other.getByTestId("split-length").getByRole("radio", { name: "Custom" })));
  await changePlan(other, () => other.getByLabel("Split every").fill("0.5"));
  await expectSegments(other, 7);
  const splitLink = await copyShareLink(other);
  expect(splitLink).toMatch(/&p=s&k=4&s=402\.336&l=804\.672&u=mi&n=/);
  const third = await context.newPage();
  await openLink(third, splitLink);
  await expect(planType(third, "Splits")).toBeChecked({ timeout: 15_000 });
  await expect(third.getByLabel("Split every")).toHaveValue("0.5");
  await expectSegments(third, 7);
  await context.close();
});

test("a version 1 link still opens, as an Optimal plan", async ({ page }) => {
  // A link as the app made them before plan types (format version 1, written out field by field
  // as docs/sharing.md had it): Lakefront Loops at 24:30 with 2 changes.
  const file = parseGpx(readFileSync(corpusPath("Lakefront-Loops-5K.gpx"), "utf8"));
  const track = simplifyForShare(file.tracks[file.defaultTrack]!.course.points, 6000)!;
  const course = encodeSharedCourse({ kind: "track", points: track.points });
  const v1 = `/#v=1&c=${course}&g=1470&k=2&s=402.336&u=mi&n=Lakefront%20Loops`;
  await openLink(page, v1);
  await expect(page.getByTestId("link-error")).toHaveCount(0);
  await expectPlanSettled(page);
  await expect(planType(page, "Optimal")).toBeChecked();
  await expect(page.getByLabel("Goal time")).toHaveValue("24:30");
  await expect(page.getByLabel("Pace changes")).toHaveValue("2");
  await expect(page.getByTestId("course-title")).toHaveText("Lakefront Loops");
  await expect(page.getByTestId("plan-total")).toHaveText("24:30");
});

test("a reload brings back the plan type, its inputs and the table view", async ({ page }) => {
  await planBoston(page);
  await choosePlanType(page, "Custom");
  await changePlan(page, () => page.getByRole("button", { name: "Add breakpoint" }).click());
  await pick(page.getByTestId("table-view").getByRole("radio", { name: "Splits table" }));
  const breakpoints = await chartBreakpoints(page);
  // The session is written once things settle (and when the page hides).
  await page.waitForTimeout(800);
  await page.reload();
  await expect(planType(page, "Custom")).toBeChecked({ timeout: 15_000 });
  await expect(page.getByTestId("split-table")).toBeVisible({ timeout: 15_000 });
  expect(await chartBreakpoints(page)).toEqual(breakpoints);
  await expect(page.getByTestId("plan-total")).toHaveText("3:00:00");
});

test("the plan types fit the panel and the sheet with no horizontal scroll, and have no axe violations", async ({
  page,
}) => {
  await planBoston(page);
  for (const name of ["Even pace", "Splits", "Custom"] as const) {
    await choosePlanType(page, name);
    expect(await hasHorizontalScroll(page)).toBe(false);
    for (const radio of await page.getByTestId("plan-type").getByRole("radio").all()) {
      const box = (await radio.locator("xpath=..").boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(32);
    }
  }
  await page.getByRole("button", { name: "Add breakpoint" }).click();
  await page.getByRole("button", { name: "Add breakpoint" }).click();
  await expectSegments(page, 3);
  expect(await hasHorizontalScroll(page)).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await pick(page.getByTestId("table-view").getByRole("radio", { name: "Splits table" }));
  await expect(page.getByTestId("split-table")).toBeVisible();
  expect(await hasHorizontalScroll(page)).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
