import { expect, test, type Page } from "@playwright/test";
import type { ReportConfig, ReportErrorBody } from "../../packages/core/src/index.ts";
import { openApp } from "../support/app.ts";
import { corpusPath, expectRouteDrawn, isPhone, uploadGpx } from "../support/course.ts";
import { expectPlanSettled } from "../support/plan.ts";
import { E2E_TURNSTILE_TOKEN, openReportDialog, stubReport } from "../support/report.ts";

// B12: "Report a problem", against a stubbed /api/report (the Worker side is tested with Miniflare
// in apps/worker/test/report.test.ts) and a stubbed Turnstile script.

const dialog = (page: Page) => page.getByRole("dialog", { name: "Report a problem" });

async function loadBoston(page: Page): Promise<void> {
  await openApp(page);
  await uploadGpx(page, corpusPath("boston.gpx"));
  await expectRouteDrawn(page);
  await expectPlanSettled(page);
}

/** An uncaught error and an unhandled rejection, as the app's own code would raise them. */
async function raiseErrors(page: Page): Promise<void> {
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("e2e uncaught error");
    });
    void Promise.reject(new Error("e2e unhandled rejection"));
  });
  // Let both reach the page's handlers.
  await page.waitForTimeout(50);
}

test("sends a bug with diagnostics, and neither the course nor the email unless asked", async ({ page }) => {
  const stub = await stubReport(page);
  await loadBoston(page);
  await raiseErrors(page);
  await openReportDialog(page);

  const send = page.getByRole("button", { name: "Send report" });
  await expect(send).toBeDisabled();
  await expect(page.getByLabel("Include diagnostics")).toBeChecked();
  await expect(page.getByLabel("Include my course")).not.toBeChecked();
  await page.getByLabel("Description").fill("The plan table jumps when I scroll.");
  await page.getByLabel(/^Email/).fill("runner@example.com");
  await expect(page.getByLabel("Show my email in the issue, so I can be contacted")).not.toBeChecked();
  await send.click();

  await expect(dialog(page).getByText("Thanks, report sent")).toBeVisible();
  expect(stub.sent).toHaveLength(1);
  const report = stub.sent[0]!;
  expect(report.kind).toBe("bug");
  expect(report.description).toBe("The plan table jumps when I scroll.");
  expect(report.turnstileToken).toMatch(new RegExp(`^${E2E_TURNSTILE_TOKEN}-\\d+$`));
  expect(report).not.toHaveProperty("email");
  expect(report).not.toHaveProperty("courseLink");

  const viewport = page.viewportSize()!;
  const diagnostics = report.diagnostics!;
  expect(diagnostics.version).toMatch(/^([0-9a-f]{7,}|unknown)$/);
  expect(diagnostics.browser).toBe(await page.evaluate(() => navigator.userAgent));
  expect(diagnostics.viewport).toMatch(new RegExp(`^${viewport.width}x${viewport.height} @[\\d.]+x$`));
  expect(diagnostics.units).toBe("mi");
  expect(diagnostics.theme).toBe("light (system)");
  expect(diagnostics.plan).toMatchObject({
    course: "loaded",
    elevationSource: "gps",
    goalTimeS: null,
    paceChanges: 4,
  });
  expect(diagnostics.plan["distanceM"]).toBeGreaterThan(42_000);
  expect(diagnostics.errors.map((e) => [e.kind, e.message])).toEqual([
    ["error", "Error: e2e uncaught error"],
    ["rejection", "Error: e2e unhandled rejection"],
  ]);
  // Diagnostics never carry a place.
  expect(JSON.stringify(diagnostics)).not.toMatch(/lat|lon|Boston/i);

  // Closing goes back to the menu button.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "More" })).toBeFocused();
});

test("attaches the course and the email only when opted in", async ({ page, baseURL }) => {
  const stub = await stubReport(page);
  await loadBoston(page);
  await openReportDialog(page);
  await dialog(page).getByText("An idea").click();
  await expect(page.getByRole("radio", { name: "An idea" })).toBeChecked();
  await page.getByLabel("Description").fill("Show splits every 5 km.");
  await page.getByLabel(/^Email/).fill("runner@example.com");
  await page.getByLabel("Show my email in the issue, so I can be contacted").check();
  const course = page.getByLabel("Include my course");
  await course.check();
  await expect(dialog(page).getByText("A course can show where you live or run")).toBeVisible();
  await page.getByLabel("Include diagnostics").uncheck();
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(dialog(page).getByText("Thanks, report sent")).toBeVisible();

  const report = stub.sent[0]!;
  expect(report.kind).toBe("idea");
  expect(report.email).toBe("runner@example.com");
  expect(report).not.toHaveProperty("diagnostics");
  expect(report.courseLink).toMatch(new RegExp(`^${baseURL}/#v=\\d+&c=t\\.[A-Za-z0-9_-]+&`));

  // The link opens the same course.
  await page.goto(report.courseLink!);
  await expectRouteDrawn(page);
  await expect(page.getByTestId("course-title")).toContainText("Boston");
});

test("without a course on screen, the course cannot be included", async ({ page }) => {
  await stubReport(page);
  await openApp(page);
  await openReportDialog(page);
  await expect(page.getByLabel("Include my course")).toBeDisabled();
  await expect(dialog(page).getByText("There is no course on screen to include.")).toBeVisible();
});

test("previews the diagnostics it will send", async ({ page }) => {
  await stubReport(page);
  await openApp(page);
  await raiseErrors(page);
  await openReportDialog(page);
  await dialog(page).getByText("Preview").click();
  const preview = page.getByTestId("report-diagnostics-preview");
  await expect(preview).toContainText('"course": "empty"');
  await expect(preview).toContainText("e2e unhandled rejection");
});

test("keeps the text when sending fails, then sends on retry with a fresh token", async ({ page }) => {
  const stub = await stubReport(page, {
    answers: [
      { status: 502, body: { error: "upstream_unavailable", message: "x" } },
      { status: 201, body: { ok: true } },
    ],
  });
  await openApp(page);
  await openReportDialog(page);
  await page.getByLabel("Description").fill("Drawing stops working offline.");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByRole("alert")).toHaveText("The report could not be sent. Try again in a minute.");
  await expect(page.getByLabel("Description")).toHaveValue("Drawing stops working offline.");

  // Closed and opened again, the draft is still there.
  await page.keyboard.press("Escape");
  await openReportDialog(page);
  await expect(page.getByLabel("Description")).toHaveValue("Drawing stops working offline.");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(dialog(page).getByText("Thanks, report sent")).toBeVisible();
  expect(stub.sent).toHaveLength(2);
  expect(stub.sent[1]!.turnstileToken).not.toBe(stub.sent[0]!.turnstileToken);

  // Once sent, the next report starts empty.
  await page.keyboard.press("Escape");
  await openReportDialog(page);
  await expect(page.getByLabel("Description")).toHaveValue("");
});

test("says when the client is rate limited", async ({ page }) => {
  await stubReport(page, {
    answers: [{ status: 429, body: { error: "rate_limited", message: "x", retryAfterS: 1500 } }],
  });
  await openApp(page);
  await openReportDialog(page);
  await page.getByLabel("Description").fill("Hello");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "You have sent several reports in a short time. Try again in 25 minutes.",
  );
});

test("says reporting is unavailable until the server is set up", async ({ page }) => {
  await stubReport(page, { config: { configured: false, siteKey: null } });
  await openApp(page);
  await openReportDialog(page);
  await expect(dialog(page).getByText("Reporting is unavailable right now.")).toBeVisible();
  await expect(dialog(page).getByText("This server is not set up to receive reports yet.")).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveCount(0);
});

test("switches to unavailable if the server answers not_configured on send", async ({ page }) => {
  await stubReport(page, { answers: [{ status: 503, body: { error: "not_configured", message: "x" } }] });
  await openApp(page);
  await openReportDialog(page);
  await page.getByLabel("Description").fill("Hello");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(dialog(page).getByText("Reporting is unavailable right now.")).toBeVisible();
});

test("the real Worker answers not_configured without its secrets", async ({ request }) => {
  // Previews and E2E runs have no GitHub token or Turnstile secret.
  const config = (await (await request.get("/api/report")).json()) as ReportConfig;
  test.skip(config.configured === true, "this deploy has the report secrets");
  expect(config).toEqual({ configured: false, siteKey: null });
  const response = await request.post("/api/report", { data: { kind: "bug", description: "x", turnstileToken: "t" } });
  expect(response.status()).toBe(503);
  expect(((await response.json()) as ReportErrorBody).error).toBe("not_configured");
});

test("the menu and dialog work from the keyboard, and the dialog keeps focus", async ({ page }) => {
  test.skip(isPhone(page), "keyboard use is a desktop path");
  await stubReport(page);
  await openApp(page);
  const more = page.getByRole("button", { name: "More" });
  await more.focus();
  await page.keyboard.press("Enter");
  const item = page.getByRole("menuitem", { name: "Report a problem" });
  await expect(item).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(more).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByLabel("Description")).toBeVisible();
  // Tabbing many times never leaves the dialog.
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(more).toBeFocused();
});

test("on a phone, the menu sits in the sheet's corner and opens over the map at peek", async ({ page }) => {
  test.skip(!isPhone(page), "phones only");
  await stubReport(page);
  await openApp(page);
  await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "peek");
  await page.getByRole("button", { name: "More" }).click();
  const menu = page.getByRole("menu");
  const sheetTop = (await page.getByTestId("sheet").boundingBox())!.y;
  const box = (await menu.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(sheetTop + 40);
  await page.getByRole("menuitem", { name: "Report a problem" }).click();
  await expect(dialog(page)).toBeVisible();
  // The sheet does not move under the dialog.
  await expect(page.getByTestId("sheet")).toHaveAttribute("data-snap", "peek");
});
