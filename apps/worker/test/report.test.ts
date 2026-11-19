import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  MAX_REPORT_BODY_BYTES,
  MAX_REPORT_DESCRIPTION_CHARS,
  MAX_REPORT_ERRORS,
  MAX_REPORT_ERROR_MESSAGE_CHARS,
  MAX_REPORT_ERROR_STACK_CHARS,
  type ReportDiagnostics,
} from "@pp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import {
  REPORT_BURST_LIMIT,
  REPORT_BURST_PERIOD_S,
  REPORT_HOURLY_LIMIT,
  REPORT_WINDOW_S,
  TURNSTILE_VERIFY_URL,
} from "../src/report.ts";

const ORIGIN = "https://perfect-pace.test";
// Cloudflare's documented always-pass Turnstile test site key and secret.
const SITE_KEY = "1x00000000000000000000AA";
const SECRET = "1x0000000000000000000000000000000AA";
const GITHUB_TOKEN = "github_pat_test_token";
const CONFIGURED = { TURNSTILE_SITE_KEY: SITE_KEY, TURNSTILE_SECRET: SECRET, GITHUB_REPORT_TOKEN: GITHUB_TOKEN };
const ISSUES_URL = "https://api.github.com/repos/jcj59/perfect-pace/issues";

interface Call {
  url: string;
  headers: Headers;
  text: string;
}
let calls: Call[] = [];
let turnstile: () => Response | Promise<Response>;
let github: () => Response | Promise<Response>;
let logged: ReturnType<typeof vi.spyOn>;

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  turnstile = () => jsonResponse(200, { success: true, "error-codes": [] });
  github = () => jsonResponse(201, { number: 7 });
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  // The Worker reaches Turnstile and GitHub with the global `fetch`; nothing leaves the test.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      headers: request.headers,
      text: new TextDecoder().decode(await request.arrayBuffer()),
    });
    if (request.url === TURNSTILE_VERIFY_URL) return turnstile();
    if (request.url === ISSUES_URL) return github();
    throw new Error(`unexpected fetch ${request.url}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

let ipCounter = 0;
const freshIp = (): string => `203.0.113.${++ipCounter}`;

type TestEnv = Partial<typeof env> & Record<string, unknown>;

async function send(
  body: unknown,
  options: { ip?: string; method?: string; env?: TestEnv; headers?: Record<string, string> } = {},
): Promise<Response> {
  const method = options.method ?? "POST";
  const request = new Request<unknown, IncomingRequestCfProperties>(`${ORIGIN}/api/report`, {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": options.ip ?? freshIp(), ...options.headers },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, ...CONFIGURED, ...options.env } as typeof env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function expectError(response: Response, status: number, code: string): Promise<{ retryAfterS?: number }> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(GITHUB_TOKEN);
  const body = JSON.parse(text) as { error: string; message: string; retryAfterS?: number };
  expect(body.error).toBe(code);
  expect(typeof body.message).toBe("string");
  return body;
}

const diagnostics = (overrides: Partial<ReportDiagnostics> = {}): ReportDiagnostics => ({
  version: "abc1234",
  browser: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140",
  viewport: "1280x720 @1x",
  units: "mi",
  theme: "light (system)",
  plan: { course: "loaded", distanceM: 42195, goalTimeS: 10800, paceChanges: 4, minSegmentM: 402.336 },
  errors: [
    { kind: "rejection", message: "TypeError: x is undefined", stack: "at plan.ts:1", at: "2026-11-15T10:00:00Z" },
  ],
  ...overrides,
});

const LINK = `${ORIGIN}/#v=1&c=d.ps.abc_-DEF&k=6&s=402.336&u=mi`;
const report = (overrides: Record<string, unknown> = {}) => ({
  kind: "bug",
  description: "The chart goes blank after I draw a loop.",
  turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
  diagnostics: diagnostics(),
  ...overrides,
});

interface IssueRequest {
  title: string;
  body: string;
  labels: string[];
}
const issueCalls = (): Call[] => calls.filter((c) => c.url === ISSUES_URL);
const issue = (): IssueRequest => JSON.parse(issueCalls()[0]!.text) as IssueRequest;

/** The issue body with every fenced code block removed: what GitHub renders as markdown. */
function outsideFences(body: string): string {
  return body.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1$/gm, "");
}

describe("GET /api/report", () => {
  it("says reporting is unavailable until every secret is set", async () => {
    for (const missing of ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET", "GITHUB_REPORT_TOKEN"]) {
      const response = await send(undefined, { method: "GET", env: { [missing]: " " } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ configured: false, siteKey: null });
    }
  });

  it("gives the public site key once configured", async () => {
    const response = await send(undefined, { method: "GET" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ configured: true, siteKey: SITE_KEY });
  });

  it("is not configured with the wrangler.jsonc defaults alone", async () => {
    const request = new Request<unknown, IncomingRequestCfProperties>(`${ORIGIN}/api/report`);
    const response = await worker.fetch(request, env, createExecutionContext());
    expect(await response.json()).toEqual({ configured: false, siteKey: null });
  });
});

describe("POST /api/report", () => {
  it("verifies the token, then opens a labeled issue with the diagnostics", async () => {
    const ip = freshIp();
    const response = await send(report({ courseLink: LINK }), { ip });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });

    expect(calls.map((c) => c.url)).toEqual([TURNSTILE_VERIFY_URL, ISSUES_URL]);
    const verify = new URLSearchParams(calls[0]!.text);
    expect(Object.fromEntries(verify)).toEqual({ secret: SECRET, response: "XXXX.DUMMY.TOKEN.XXXX", remoteip: ip });

    const github = calls[1]!;
    expect(github.headers.get("authorization")).toBe(`Bearer ${GITHUB_TOKEN}`);
    expect(github.headers.get("accept")).toBe("application/vnd.github+json");
    expect(github.headers.get("user-agent")).toBeTruthy();
    const { title, body, labels } = issue();
    expect(labels).toEqual(["user-report", "bug"]);
    expect(title).toBe("[bug] The chart goes blank after I draw a loop.");
    expect(body).toContain("**Kind:** Bug");
    expect(body).toContain("**Contact:** none given");
    expect(body).toContain("The chart goes blank after I draw a loop.");
    expect(body).toContain(`[Open the reporter's course and plan](${LINK})`);
    for (const line of [
      "Version: abc1234",
      "Viewport: 1280x720 @1x",
      "Units: mi",
      "Theme: light (system)",
      "  goalTimeS: 10800",
      "  minSegmentM: 402.336",
      "### Recent errors (1)",
      "[2026-11-15T10:00:00Z] Unhandled rejection: TypeError: x is undefined",
      "at plan.ts:1",
    ]) {
      expect(body).toContain(line);
    }
    expect(body).not.toContain(SECRET);
  });

  it("labels an idea, and leaves out what the user did not include", async () => {
    const bare: Record<string, unknown> = report({ kind: "idea", description: "Show splits in km too" });
    delete bare["diagnostics"];
    expect((await send(bare)).status).toBe(201);
    const { title, body, labels } = issue();
    expect(labels).toEqual(["user-report", "idea"]);
    expect(title).toBe("[idea] Show splits in km too");
    expect(body).toMatch(/### Course\n\nNot included\./);
    expect(body).toMatch(/### Diagnostics\n\nNot included\./);
    expect(body).not.toContain("Recent errors");
  });

  it("puts the email in the issue only when sent, which the app does only on request", async () => {
    expect((await send(report({ email: "runner@example.com" }))).status).toBe(201);
    expect(issue().body).toContain("**Contact:** `runner@example.com` (the reporter chose to show it here)");
  });

  it("answers not_configured without calling anyone until the secrets exist", async () => {
    for (const missing of ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET", "GITHUB_REPORT_TOKEN"]) {
      await expectError(await send(report(), { env: { [missing]: undefined } }), 503, "not_configured");
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["not JSON", "{kind:"],
    ["a JSON array", [report()]],
    ["an unknown kind", report({ kind: "complaint" })],
    ["no description", report({ description: "   " })],
    ["a description over the cap", report({ description: "x".repeat(MAX_REPORT_DESCRIPTION_CHARS + 1) })],
    ["no Turnstile token", report({ turnstileToken: undefined })],
    ["a bad email", report({ email: "@everyone" })],
    [
      "too many errors",
      report({ diagnostics: diagnostics({ errors: Array(MAX_REPORT_ERRORS + 1).fill(diagnostics().errors[0]) }) }),
    ],
    ["a course link to another site", report({ courseLink: "https://evil.example/#v=1&c=x" })],
  ])("rejects %s with invalid_request and calls no one", async (_, body) => {
    await expectError(await send(body), 400, "invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("rejects a body over the size cap with payload_too_large", async () => {
    const huge = JSON.stringify(report({ padding: "x".repeat(MAX_REPORT_BODY_BYTES) }));
    await expectError(await send(huge), 413, "payload_too_large");
    // A client that understates its Content-Length is still measured.
    await expectError(await send(huge, { headers: { "content-length": "10" } }), 413, "payload_too_large");
    expect(calls).toHaveLength(0);
  });

  it("rejects a failed human check with captcha_failed and opens no issue", async () => {
    turnstile = () => jsonResponse(200, { success: false, "error-codes": ["invalid-input-response"] });
    await expectError(await send(report()), 403, "captcha_failed");
    expect(issueCalls()).toHaveLength(0);
  });

  it("only takes GET and POST", async () => {
    const response = await send(undefined, { method: "PUT" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });
});

describe("POST /api/report rate limits", () => {
  // The burst binding is replaced, so only the hourly limit is in play.
  const noBurstLimit = { REPORT_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) } };

  it(`allows ${REPORT_HOURLY_LIMIT} reports per IP per hour, then answers rate_limited until the oldest ages out`, async () => {
    const ip = freshIp();
    for (let i = 0; i < REPORT_HOURLY_LIMIT; i++) {
      expect((await send(report(), { ip, env: noBurstLimit })).status).toBe(201);
    }
    const limited = await send(report(), { ip, env: noBurstLimit });
    const body = await expectError(limited, 429, "rate_limited");
    expect(body.retryAfterS).toBeGreaterThan(REPORT_WINDOW_S - 60);
    expect(body.retryAfterS).toBeLessThanOrEqual(REPORT_WINDOW_S);
    expect(limited.headers.get("retry-after")).toBe(String(body.retryAfterS));
    expect(issueCalls()).toHaveLength(REPORT_HOURLY_LIMIT);

    // Another IP is unaffected.
    expect((await send(report(), { env: noBurstLimit })).status).toBe(201);
  });

  it("is a sliding window over the stored report times, keyed by a hash of the IP", async () => {
    const ip = freshIp();
    expect((await send(report(), { ip, env: noBurstLimit })).status).toBe(201);
    const { keys } = await env.REPORT_LIMITS.list({ prefix: "report-ip:" });
    const stored = keys.map((k) => k.name);
    expect(stored.some((name) => name.includes(ip))).toBe(false);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
    const key = `report-ip:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    expect(stored).toContain(key);

    // Four reports 50 minutes ago plus one now: limited until those age out in about 10 minutes.
    const now = Date.now();
    const old = now - 50 * 60 * 1000;
    await env.REPORT_LIMITS.put(key, JSON.stringify([old, old, old, old, now]));
    const body = await expectError(await send(report(), { ip, env: noBurstLimit }), 429, "rate_limited");
    expect(body.retryAfterS).toBeGreaterThan(9 * 60);
    expect(body.retryAfterS).toBeLessThanOrEqual(10 * 60);

    // Once they are over an hour old, they no longer count.
    const expired = now - (REPORT_WINDOW_S + 1) * 1000;
    await env.REPORT_LIMITS.put(key, JSON.stringify([expired, expired, expired, expired, now]));
    expect((await send(report(), { ip, env: noBurstLimit })).status).toBe(201);
  });

  it("does not count a failed human check against the hour", async () => {
    const ip = freshIp();
    turnstile = () => jsonResponse(200, { success: false });
    for (let i = 0; i < REPORT_HOURLY_LIMIT + 1; i++) {
      await expectError(await send(report(), { ip, env: noBurstLimit }), 403, "captcha_failed");
    }
    turnstile = () => jsonResponse(200, { success: true });
    expect((await send(report(), { ip, env: noBurstLimit })).status).toBe(201);
  });

  it(`allows ${REPORT_BURST_LIMIT} attempts per IP per minute through the binding`, async () => {
    const ip = freshIp();
    turnstile = () => jsonResponse(200, { success: false });
    for (let i = 0; i < REPORT_BURST_LIMIT; i++) {
      await expectError(await send(report(), { ip }), 403, "captcha_failed");
    }
    const body = await expectError(await send(report(), { ip }), 429, "rate_limited");
    expect(body.retryAfterS).toBe(REPORT_BURST_PERIOD_S);
    expect(calls).toHaveLength(REPORT_BURST_LIMIT);
  });
});

describe("POST /api/report upstream failures", () => {
  it.each([
    ["GitHub answers 500", () => (github = () => jsonResponse(500, { message: "oops" }))],
    ["GitHub rejects the token", () => (github = () => jsonResponse(401, { message: "Bad credentials" }))],
    ["GitHub is unreachable", () => (github = () => Promise.reject(new TypeError("network")))],
    ["Turnstile answers 500", () => (turnstile = () => new Response("", { status: 500 }))],
    ["Turnstile is unreachable", () => (turnstile = () => Promise.reject(new TypeError("network")))],
    ["Turnstile answers garbage", () => (turnstile = () => new Response("<html>", { status: 200 }))],
    [
      "Turnstile rejects the secret",
      () => (turnstile = () => jsonResponse(200, { success: false, "error-codes": ["invalid-input-secret"] })),
    ],
  ])("answers upstream_unavailable when %s, without leaking secrets", async (_, arrange) => {
    arrange();
    await expectError(await send(report()), 502, "upstream_unavailable");
    expect(logged).toHaveBeenCalled();
  });
});

describe("issue sanitization", () => {
  it("keeps user text inert: fenced, no mentions, no markup that escapes the template", async () => {
    const hostile = [
      "Hey @jcj59 and @everyone, look:",
      "```",
      "</details><img src=https://tracker.example/p.png> [click](javascript:alert(1))",
      "````",
      "### Fake heading",
      "Fixes #1 \u0007\u0000bell\r\nwindows line",
    ].join("\n");
    const errors = [{ kind: "error" as const, message: "@octocat ```` <script>", at: "@now" }];
    const body = report({
      description: hostile,
      diagnostics: diagnostics({ theme: "dark ``` @x", plan: { name: "@team <b>", n: 1 }, errors }),
    });
    expect((await send(body)).status).toBe(201);
    const { title, body: markdown } = issue();

    // The title cannot mention anyone, and is one line.
    expect(title).toBe(
      "[bug] Hey @\u200bjcj59 and @\u200beveryone, look: ``` </details><img src=https://tracker.exampl...",
    );
    expect(title).not.toMatch(/@\w/);

    // Everything user-written sits inside fences longer than any backtick run in it.
    expect(markdown).toContain("`````text\nHey @jcj59 and @everyone, look:\n```\n");
    const outside = outsideFences(markdown);
    for (const fragment of ["@", "<img", "<script", "<b>", "javascript:", "Fake heading", "Fixes #1", "tracker"]) {
      expect(outside).not.toContain(fragment);
    }
    // Control characters are gone and newlines are plain.
    for (const gone of ["\u0000", "\u0007", "\r"]) expect(markdown).not.toContain(gone);
    expect(markdown).toContain("bell\nwindows line");
    // The template's own sections are all still there, in order.
    const headings = [...outside.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(["Description", "Course", "Diagnostics", "Recent errors (1)"]);
  });

  it("keeps the largest valid report well inside GitHub's issue size", async () => {
    const error = {
      kind: "error" as const,
      message: "`".repeat(MAX_REPORT_ERROR_MESSAGE_CHARS),
      stack: "s".repeat(MAX_REPORT_ERROR_STACK_CHARS),
      at: "t",
    };
    const body = report({
      description: "d".repeat(MAX_REPORT_DESCRIPTION_CHARS),
      diagnostics: diagnostics({ errors: Array(MAX_REPORT_ERRORS).fill(error) }),
      courseLink: `${ORIGIN}/#v=1&c=${"c".repeat(7900)}`,
    });
    expect((await send(body)).status).toBe(201);
    expect(issue().body.length).toBeLessThan(65_536);
  });
});
