// Lighthouse CI: the accessibility score of the app, on a phone and on a desktop, must be at
// least MIN_SCORE. Runs against PP_BASE_URL (the PR preview), or else starts the Worker locally
// with `wrangler dev` (build the web app first). Reports go to e2e/lighthouse-report/.
//
// Installability is not here: Lighthouse 12 removed its PWA category and audits. tests/pwa.spec.ts
// asks Chrome itself (`Page.getInstallabilityErrors`, what the old audit used) on every project.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";
import lighthouse from "lighthouse";
import desktopConfig from "lighthouse/core/config/desktop-config.js";

const MIN_SCORE = 0.95;
const LOCAL_PORT = 8789;
const OUT = new URL("../lighthouse-report/", import.meta.url);
// Third-party map and terrain data stay off the network, like everywhere else in the suites.
const BLOCKED = ["*tiles.openfreemap.org*", "*elevation-tiles-prod*"];

/** A free TCP port for Chromium's DevTools endpoint. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`${url} did not come up in ${timeoutMs / 1000} s`);
}

/** Start `wrangler dev` on the built app, and return its URL and a stop function. */
async function startLocal() {
  const worker = spawn(
    "pnpm",
    [
      "--dir",
      "../apps/worker",
      "exec",
      "wrangler",
      "dev",
      "--port",
      String(LOCAL_PORT),
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: new URL("..", import.meta.url),
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  const url = `http://localhost:${LOCAL_PORT}`;
  await waitFor(`${url}/api/health`, 60_000);
  return { url, stop: () => worker.kill() };
}

const remote = process.env["PP_BASE_URL"];
const server = remote ? { url: remote, stop: () => {} } : await startLocal();
const port = await freePort();
const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
mkdirSync(OUT, { recursive: true });
const failures = [];
try {
  for (const [name, config] of [
    ["mobile", undefined],
    ["desktop", desktopConfig],
  ]) {
    const result = await lighthouse(
      `${server.url}/`,
      {
        port,
        output: ["html", "json"],
        onlyCategories: ["accessibility"],
        blockedUrlPatterns: BLOCKED,
        logLevel: "error",
      },
      config,
    );
    if (!result) throw new Error(`Lighthouse returned no result (${name})`);
    const [html, json] = result.report;
    writeFileSync(new URL(`${name}.html`, OUT), html);
    writeFileSync(new URL(`${name}.json`, OUT), json);
    const { score } = result.lhr.categories.accessibility;
    console.log(`Lighthouse accessibility, ${name}: ${Math.round((score ?? 0) * 100)} (minimum ${MIN_SCORE * 100})`);
    for (const audit of Object.values(result.lhr.audits)) {
      if (audit.score !== null && audit.score < 1 && audit.scoreDisplayMode === "binary") {
        console.log(`  failed: ${audit.id}: ${audit.title}`);
      }
    }
    if (score === null || score < MIN_SCORE) failures.push(name);
    if (result.lhr.runtimeError) failures.push(`${name}: ${result.lhr.runtimeError.message}`);
  }
} finally {
  await browser.close();
  server.stop();
}
if (failures.length > 0) {
  console.error(`Lighthouse accessibility below ${MIN_SCORE * 100}: ${failures.join(", ")}`);
  process.exit(1);
}
