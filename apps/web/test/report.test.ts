import {
  MAX_REPORT_ERRORS,
  MAX_REPORT_ERROR_MESSAGE_CHARS,
  MAX_REPORT_ERROR_STACK_CHARS,
  parseReportRequest,
} from "@pp/core";
import { describe, expect, it } from "vitest";
import { buildDiagnostics, hasShareableCourse } from "../src/report/diagnostics.ts";
import { createErrorLog } from "../src/report/errors.ts";
import { initialAppState } from "../src/state/app.ts";
import { initialDrawState } from "../src/state/draw.ts";

describe("createErrorLog", () => {
  it(`keeps the last ${MAX_REPORT_ERRORS}, oldest first`, () => {
    const log = createErrorLog();
    for (let i = 0; i < MAX_REPORT_ERRORS + 5; i++) log.add("error", new Error(`e${i}`), new Date(i * 1000));
    const list = log.list();
    expect(list).toHaveLength(MAX_REPORT_ERRORS);
    expect(list[0]!.message).toBe("Error: e5");
    expect(list.at(-1)!.message).toBe(`Error: e${MAX_REPORT_ERRORS + 4}`);
    expect(list[0]!.at).toBe("1970-01-01T00:00:05.000Z");
  });

  it("describes any rejection reason, within the report's caps", () => {
    const log = createErrorLog();
    const long = new TypeError("x".repeat(1000));
    long.stack = "s".repeat(5000);
    log.add("rejection", long);
    log.add("rejection", "plain text");
    log.add("rejection", { code: 7 });
    log.add("rejection", undefined);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    log.add("rejection", circular);
    const [first, ...rest] = log.list();
    expect(first!.message).toHaveLength(MAX_REPORT_ERROR_MESSAGE_CHARS);
    expect(first!.message.startsWith("TypeError: xxx")).toBe(true);
    expect(first!.stack).toHaveLength(MAX_REPORT_ERROR_STACK_CHARS);
    expect(rest.map((e) => e.message)).toEqual(["plain text", '{"code":7}', "undefined", "[object Object]"]);
    expect(rest.every((e) => e.stack === undefined)).toBe(true);
  });
});

describe("buildDiagnostics", () => {
  const source = (overrides = {}) => ({
    app: { ...initialAppState(undefined, "en-US"), goalTimeS: 10800 },
    draw: initialDrawState(),
    plan: { profile: null, plan: null, error: "Too fast for the descents" },
    version: "abc1234",
    userAgent: "UA",
    viewport: { width: 390, height: 844, dpr: 3 },
    systemDark: true,
    errors: [],
    ...overrides,
  });

  it("describes the app, and passes the server's own validation", () => {
    const diagnostics = buildDiagnostics(source());
    expect(diagnostics).toEqual({
      version: "abc1234",
      browser: "UA",
      viewport: "390x844 @3x",
      units: "mi",
      theme: "dark (system)",
      plan: {
        course: "empty",
        goalTimeS: 10800,
        planType: "optimal",
        splitM: diagnostics.plan["splitM"],
        breakpoints: 0,
        paceChanges: 4,
        minSegmentM: diagnostics.plan["minSegmentM"],
        planError: "Too fast for the descents",
      },
      errors: [],
    });
    const parsed = parseReportRequest({ kind: "bug", description: "x", turnstileToken: "t", diagnostics });
    expect(parsed.diagnostics).toEqual(diagnostics);
  });

  it("cuts a long user agent and rounds the pixel ratio", () => {
    const diagnostics = buildDiagnostics(
      source({ userAgent: "u".repeat(1000), viewport: { width: 1, height: 2, dpr: 1.3333 } }),
    );
    expect(diagnostics.browser).toHaveLength(400);
    expect(diagnostics.viewport).toBe("1x2 @1.33x");
  });

  it("knows when there is no course to share", () => {
    expect(hasShareableCourse({ status: "empty" }, { waypoints: [] })).toBe(false);
    expect(
      hasShareableCourse({ status: "drawn", course: null, elevation: null, updating: false }, { waypoints: [1] }),
    ).toBe(false);
    expect(
      hasShareableCourse({ status: "drawn", course: null, elevation: null, updating: false }, { waypoints: [1, 2] }),
    ).toBe(true);
  });
});
