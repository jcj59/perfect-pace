import { expect, test } from "@playwright/test";
import { hasHorizontalScroll, markTime, openApp } from "../support/app.ts";

// @smoke tests are safe against any deployment, including production after a deploy.
test.describe("smoke @smoke", () => {
  test("the app shell renders the panel, the map and the empty state", async ({ page }) => {
    await openApp(page);
    await expect(page).toHaveTitle("Perfect Pace");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Perfect Pace");
    await expect(page.getByRole("region", { name: "Course panel" })).toBeVisible();
    await expect(page.getByTestId("empty-state")).toBeAttached();
    expect(await hasHorizontalScroll(page)).toBe(false);
  });

  test("the core Web Worker starts and answers", async ({ page }) => {
    await openApp(page);
    // `pp:worker-ready` is set when the worker replies to the startup ping over the RPC bridge.
    await expect.poll(() => markTime(page, "pp:worker-ready")).not.toBeNull();
  });

  test("/api/health reports ok", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    // After a deploy, the workflow passes the version it just shipped.
    const expected = process.env["PP_EXPECT_VERSION"];
    if (expected) expect(body.version).toBe(expected);
  });

  test("forced failure for the rollback dry run", () => {
    test.skip(process.env["PP_FORCE_SMOKE_FAIL"] !== "1", "only when PP_FORCE_SMOKE_FAIL=1");
    expect(false, "PP_FORCE_SMOKE_FAIL=1 forces the smoke suite to fail").toBe(true);
  });
});
