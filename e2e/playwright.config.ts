import { defineConfig, devices, type Project } from "@playwright/test";

/**
 * Environment:
 * - PP_BASE_URL: test a deployed URL (PR preview or production). Unset, Playwright starts the
 *   real Worker locally with `wrangler dev` (build the web app first: `pnpm build`).
 * - PP_BROWSERS=all: add Firefox and WebKit projects (nightly). Visual baselines are Chromium only.
 * - PP_QUARANTINE=1: run only `@quarantine` tests (CI runs them in a non-blocking step).
 * - PP_VISUAL=1: compare screenshots outside CI. Baselines come from the Linux Playwright
 *   container, so local runs skip screenshot assertions unless you run `pnpm visual:update`.
 */
const CI = !!process.env["CI"];
const LOCAL_PORT = 8788;
const baseURL = process.env["PP_BASE_URL"] || `http://localhost:${LOCAL_PORT}`;
const quarantine = process.env["PP_QUARANTINE"] === "1";

// Timing budgets that must not share the CPU with other tests run in their own project, last.
const ISOLATED = /load-perf\.spec\.ts/;

// Per-PR projects: Chromium only, at desktop and two phone sizes.
const projects: Project[] = [
  { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: ISOLATED },
  { name: "iphone", use: { ...devices["iPhone 15"], defaultBrowserType: "chromium" }, testIgnore: ISOLATED },
  { name: "pixel", use: { ...devices["Pixel 7"] }, testIgnore: ISOLATED },
  {
    name: "load-perf",
    use: { ...devices["Desktop Chrome"] },
    testMatch: ISOLATED,
    dependencies: ["desktop", "iphone", "pixel"],
  },
];

if (process.env["PP_BROWSERS"] === "all") {
  projects.push(
    { name: "desktop-firefox", use: { ...devices["Desktop Firefox"] }, grepInvert: /@visual/, testIgnore: ISOLATED },
    { name: "desktop-webkit", use: { ...devices["Desktop Safari"] }, grepInvert: /@visual/, testIgnore: ISOLATED },
    { name: "iphone-webkit", use: { ...devices["iPhone 15"] }, grepInvert: /@visual/, testIgnore: ISOLATED },
  );
}

export default defineConfig({
  testDir: "tests",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}",
  ignoreSnapshots: !CI && process.env["PP_VISUAL"] !== "1",
  fullyParallel: true,
  forbidOnly: CI,
  // One retry in CI; a test that passes only on retry is reported as flaky, not hidden.
  retries: CI ? 1 : 0,
  ...(quarantine ? { grep: /@quarantine/ } : { grepInvert: /@quarantine/ }),
  reporter: CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"]],
  outputDir: "test-results",
  expect: {
    toHaveScreenshot: { animations: "disabled", caret: "hide", scale: "css" },
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects,
  ...(process.env["PP_BASE_URL"]
    ? {}
    : {
        webServer: {
          command: `pnpm --dir ../apps/worker exec wrangler dev --port ${LOCAL_PORT} --show-interactive-dev-session=false`,
          url: `${baseURL}/api/health`,
          reuseExistingServer: !CI,
          timeout: 60_000,
          env: { WRANGLER_SEND_METRICS: "false" },
        },
      }),
});
