import { expect, test } from "@playwright/test";

// Throwaway: proves a failing test fails the aggregate `e2e` check. Never merged.
test("deliberately fails", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Not the title");
});
