import { expect, test } from "@playwright/test";
import { METERS_PER_MILE, golden } from "../support/course.ts";
import { changePlan, enterGoal, expectPlanSettled, loadBostonPlan, planBoston, seconds } from "../support/plan.ts";

const BOSTON_MI = golden("boston.gpx").tracks[0]!.distanceM / METERS_PER_MILE;

// B4: upload Boston, plan it for 3:00:00 with 6 pace changes, and the table adds up to the goal.
test("a 3:00:00 plan for Boston with 6 changes adds up to 3:00:00 and is drawn on the map and chart", async ({
  page,
}) => {
  await planBoston(page);
  const rows = page.getByTestId("segment-row");
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(2);
  expect(count).toBeLessThanOrEqual(7);
  await expect(page.getByTestId("pace-changes-value")).toContainText("6");

  // The table's times add up to the goal, and the predicted finish and the total say so.
  const times = await page.getByTestId("segment-time").allTextContents();
  expect(times.reduce((sum, t) => sum + seconds(t), 0)).toBe(3 * 3600);
  await expect(page.getByTestId("plan-total")).toHaveText("3:00:00");
  await expect(page.getByTestId("plan-predicted")).toContainText("3:00:00");

  // The segments run from the start to the finish without gaps.
  const ranges = await rows.getByRole("button").allTextContents();
  const bounds = ranges.map((r) => r.split("–").map(Number) as [number, number]);
  expect(bounds[0]![0]).toBe(0);
  expect(bounds.at(-1)![1]).toBeCloseTo(BOSTON_MI, 0);
  bounds.slice(1).forEach(([start], i) => expect(start).toBe(bounds[i]![1]));
  // Every row has a pace, a grade and a reason.
  for (const pace of await page.getByTestId("segment-pace").allTextContents()) expect(pace).toMatch(/^\d+:\d\d$/);
  await expect(rows.first()).toContainText(/(climb|descent|rolling|flat)/);

  // One colored stretch per segment on the chart, in the same tones as the table, and on the map.
  const segments = page.getByTestId("chart-segment");
  await expect(segments).toHaveCount(count);
  for (let i = 0; i < count; i++) {
    await expect(segments.nth(i)).toHaveAttribute("data-tone", (await rows.nth(i).getAttribute("data-tone"))!);
  }
  await expect(page.getByTestId("map")).toHaveAttribute("data-segments", String(count));
  await expect(page.getByTestId("plan-assumption")).toContainText("12 s per mile");
});

// B5: selecting a row highlights its segment on the map and the chart; selecting it again clears it.
test("selecting a segment row highlights it on the map and the chart", async ({ page }) => {
  await planBoston(page);
  const row = page.getByTestId("segment-row").nth(2);
  const button = row.getByRole("button");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(row).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("chart-segment").nth(2)).toHaveAttribute("data-selected", "true");
  await expect(page.locator('[data-testid="chart-segment"][data-selected]')).toHaveCount(1);
  await expect(page.getByTestId("chart-selection")).toBeVisible();
  await expect(page.getByTestId("map")).toHaveAttribute("data-selected-segment", "2");

  // Another row moves the highlight; the same row again clears it.
  const other = page.getByTestId("segment-row").nth(0);
  await other.click();
  await expect(page.getByTestId("map")).toHaveAttribute("data-selected-segment", "0");
  await expect(page.getByTestId("chart-segment").nth(0)).toHaveAttribute("data-selected", "true");
  await other.getByRole("button").click();
  await expect(page.getByTestId("map")).not.toHaveAttribute("data-selected-segment");
  await expect(page.locator('[data-testid="chart-segment"][data-selected]')).toHaveCount(0);
  await expect(page.getByTestId("chart-selection")).toHaveCount(0);

  // A plan with different segments drops the selection.
  await row.getByRole("button").click();
  await changePlan(page, () => page.getByLabel("Pace changes").fill("1"));
  await expect(page.getByTestId("map")).not.toHaveAttribute("data-selected-segment");
});

test("the goal time is checked, with errors that say what to type", async ({ page }) => {
  await loadBostonPlan(page);
  const input = page.getByLabel("Goal time");
  // Before the user enters a goal, the plan uses a suggested one and says so.
  await expect(input).toHaveValue("3:55:00");
  await expect(page.getByTestId("goal-note")).toContainText("A suggestion");

  await enterGoal(page, "3:30");
  const error = page.getByTestId("goal-error");
  await expect(error).toHaveText(
    "That is 0:08 per mi, faster than anyone runs. Did you mean 3:30:00? The plan below is still for 3:55:00.",
  );
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("plan-total")).toHaveText("3:55:00");

  await enterGoal(page, "three hours");
  await expect(error).toContainText("Use hours, minutes and seconds, like 3:30:00");
  await enterGoal(page, "");
  await expect(error).toContainText("Enter a goal time");
  await enterGoal(page, "30:00:00");
  await expect(error).toContainText("slower than 1:00:00 per mi. Enter a goal up to 26:16:33.");

  // Fixing it clears the error and replans.
  await changePlan(page, () => enterGoal(page, "3:30:00"));
  await expect(page.getByTestId("goal-error")).toHaveCount(0);
  await expect(input).toHaveAttribute("aria-invalid", "false");
  await expect(page.getByTestId("plan-total")).toHaveText("3:30:00");
  await expect(page.getByTestId("goal-note")).toContainText("add up to this goal");

  // Leading zeros are tidied once the field is left.
  await changePlan(page, () => enterGoal(page, "03:15:00"));
  await expect(input).toHaveValue("3:15:00");
});

test("units, pace changes and the shortest segment all replan", async ({ page }) => {
  await planBoston(page);
  // Kilometers: headings, paces and the shortest segment switch; the total stays the goal.
  await changePlan(page, () => page.getByText("km", { exact: true }).click());
  await expect(page.getByTestId("segment-table")).toContainText("Segment (km)");
  await expect(page.getByTestId("segment-table")).toContainText("Pace /km");
  await expect(page.getByLabel("Shortest segment")).toHaveValue("500");
  await expect(page.getByTestId("plan-total")).toHaveText("3:00:00");

  // A 2 km minimum: every segment is at least that long.
  await changePlan(page, async () => {
    await page.getByLabel("Shortest segment").selectOption({ label: "2 km" });
  });
  const ranges = await page.getByTestId("segment-row").getByRole("button").allTextContents();
  for (const range of ranges) {
    const [start, end] = range.split("–").map(Number) as [number, number];
    expect(end - start).toBeGreaterThanOrEqual(1.95);
  }

  // No pace changes: one steady pace over the whole course.
  await changePlan(page, () => page.getByLabel("Pace changes").fill("0"));
  await expect(page.getByTestId("segment-row")).toHaveCount(1);
  await expect(page.getByTestId("pace-changes-value")).toContainText("1 segment");
  await expectPlanSettled(page);
});
