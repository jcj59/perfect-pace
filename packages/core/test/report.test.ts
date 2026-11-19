import { describe, expect, it } from "vitest";
import {
  MAX_REPORT_BODY_BYTES,
  MAX_REPORT_BROWSER_CHARS,
  MAX_REPORT_DESCRIPTION_CHARS,
  MAX_REPORT_EMAIL_CHARS,
  MAX_REPORT_ERRORS,
  MAX_REPORT_ERROR_MESSAGE_CHARS,
  MAX_REPORT_ERROR_STACK_CHARS,
  MAX_REPORT_LINK_CHARS,
  MAX_REPORT_PLAN_FIELDS,
  MAX_REPORT_PLAN_KEY_CHARS,
  MAX_REPORT_PLAN_VALUE_CHARS,
  MAX_REPORT_SHORT_CHARS,
  MAX_REPORT_TOKEN_CHARS,
  type ReportDiagnostics,
  ReportError,
  parseReportRequest,
} from "../src/index.ts";

const ORIGIN = "https://perfect-pace.example";
const LINK = `${ORIGIN}/#v=1&c=d.ps.abc_-DEF&g=10800&k=6&s=402.336&u=mi&n=My%20course`;

const diagnostics = (overrides: Partial<ReportDiagnostics> = {}): ReportDiagnostics => ({
  version: "abc1234",
  browser: "Mozilla/5.0",
  viewport: "390x844 @3x",
  units: "mi",
  theme: "dark (system)",
  plan: { course: "loaded", goalTimeS: 10800, suggested: false, name: "Boston", minSegmentM: null },
  errors: [{ kind: "error", message: "boom", stack: "at x", at: "2026-11-15T12:00:00.000Z" }],
  ...overrides,
});

const valid = { kind: "bug", description: "  The chart is blank  ", turnstileToken: "token" };

function expectInvalid(body: unknown, message: RegExp, origin?: string): void {
  try {
    parseReportRequest(body, origin);
  } catch (error) {
    expect(error).toBeInstanceOf(ReportError);
    expect((error as ReportError).code).toBe("invalid_request");
    expect((error as ReportError).message).toMatch(message);
    return;
  }
  throw new Error("expected a ReportError");
}

describe("parseReportRequest", () => {
  it("accepts the smallest report and trims the description", () => {
    expect(parseReportRequest(valid)).toEqual({
      kind: "bug",
      description: "The chart is blank",
      turnstileToken: "token",
    });
  });

  it("keeps every optional field and drops unknown ones", () => {
    const parsed = parseReportRequest(
      { ...valid, kind: "idea", email: " runner@example.com ", diagnostics: diagnostics(), courseLink: LINK, x: 1 },
      ORIGIN,
    );
    expect(parsed).toEqual({
      kind: "idea",
      description: "The chart is blank",
      turnstileToken: "token",
      email: "runner@example.com",
      diagnostics: diagnostics(),
      courseLink: LINK,
    });
  });

  it("keeps an error without a stack", () => {
    const errors = [{ kind: "rejection" as const, message: "nope", at: "now" }];
    expect(parseReportRequest({ ...valid, diagnostics: diagnostics({ errors }) }).diagnostics?.errors).toEqual(errors);
  });

  it.each([
    ["a non-object", "x", /JSON object/],
    ["an array", [], /JSON object/],
    ["an unknown kind", { ...valid, kind: "rant" }, /kind/],
    ["no description", { ...valid, description: undefined }, /description must be a string/],
    ["a blank description", { ...valid, description: " \n " }, /description must not be empty/],
    ["a long description", { ...valid, description: "x".repeat(MAX_REPORT_DESCRIPTION_CHARS + 1) }, /at most 4000/],
    ["no token", { ...valid, turnstileToken: "" }, /turnstileToken must not be empty/],
    ["a long token", { ...valid, turnstileToken: "x".repeat(MAX_REPORT_TOKEN_CHARS + 1) }, /turnstileToken/],
    ["a bad email", { ...valid, email: "not an email" }, /email must be an email/],
    ["an email with markup", { ...valid, email: "<a>@b.co" }, /email must be an email/],
    ["a long email", { ...valid, email: `${"a".repeat(MAX_REPORT_EMAIL_CHARS)}@b.co` }, /at most/],
    ["diagnostics that are not an object", { ...valid, diagnostics: 3 }, /diagnostics must be an object/],
    ["a numeric version", { ...valid, diagnostics: { ...diagnostics(), version: 1 } }, /version must be a string/],
    [
      "a long browser",
      { ...valid, diagnostics: diagnostics({ browser: "x".repeat(MAX_REPORT_BROWSER_CHARS + 1) }) },
      /browser/,
    ],
    [
      "a long theme",
      { ...valid, diagnostics: diagnostics({ theme: "x".repeat(MAX_REPORT_SHORT_CHARS + 1) }) },
      /theme/,
    ],
    [
      "errors that are not a list",
      { ...valid, diagnostics: { ...diagnostics(), errors: {} } },
      /errors must be an array/,
    ],
    [
      "too many errors",
      {
        ...valid,
        diagnostics: diagnostics({
          errors: Array.from({ length: MAX_REPORT_ERRORS + 1 }, () => ({
            kind: "error" as const,
            message: "",
            at: "",
          })),
        }),
      },
      /at most 20/,
    ],
    ["an error that is not an object", { ...valid, diagnostics: { ...diagnostics(), errors: [1] } }, /errors\[0\]/],
    [
      "an error of another kind",
      { ...valid, diagnostics: { ...diagnostics(), errors: [{ kind: "warn", message: "", at: "" }] } },
      /kind must be/,
    ],
    [
      "a long error message",
      {
        ...valid,
        diagnostics: diagnostics({
          errors: [{ kind: "error", message: "x".repeat(MAX_REPORT_ERROR_MESSAGE_CHARS + 1), at: "" }],
        }),
      },
      /message/,
    ],
    [
      "a long stack",
      {
        ...valid,
        diagnostics: diagnostics({
          errors: [{ kind: "error", message: "", stack: "x".repeat(MAX_REPORT_ERROR_STACK_CHARS + 1), at: "" }],
        }),
      },
      /stack/,
    ],
    ["a plan that is not an object", { ...valid, diagnostics: { ...diagnostics(), plan: [] } }, /plan must be/],
    [
      "too many plan fields",
      {
        ...valid,
        diagnostics: diagnostics({
          plan: Object.fromEntries(Array.from({ length: MAX_REPORT_PLAN_FIELDS + 1 }, (_, i) => [`f${i}`, i])),
        }),
      },
      /at most 20 fields/,
    ],
    ["a plan field name with markup", { ...valid, diagnostics: diagnostics({ plan: { "<b>": 1 } }) }, /field name/],
    [
      "a long plan field name",
      { ...valid, diagnostics: diagnostics({ plan: { ["a".repeat(MAX_REPORT_PLAN_KEY_CHARS + 1)]: 1 } }) },
      /field name/,
    ],
    [
      "a long plan value",
      { ...valid, diagnostics: diagnostics({ plan: { name: "x".repeat(MAX_REPORT_PLAN_VALUE_CHARS + 1) } }) },
      /plan\.name/,
    ],
    ["a nested plan value", { ...valid, diagnostics: { ...diagnostics(), plan: { a: { b: 1 } } } }, /plan\.a/],
    ["an infinite plan value", { ...valid, diagnostics: { ...diagnostics(), plan: { a: Infinity } } }, /plan\.a/],
    ["a course link that is not a URL", { ...valid, courseLink: "nope" }, /share link/],
    ["a javascript: course link", { ...valid, courseLink: "javascript:alert(1)#v=1" }, /share link/],
    ["a course link with a query", { ...valid, courseLink: `${ORIGIN}/?x=1#v=1` }, /share link/],
    ["a course link with credentials", { ...valid, courseLink: `https://a:b@x.example/#v=1` }, /share link/],
    ["a course link without a share fragment", { ...valid, courseLink: `${ORIGIN}/` }, /share link/],
    ["a course link with markup", { ...valid, courseLink: `${ORIGIN}/#v=1&c=)[x](y` }, /share link/],
    [
      "a long course link",
      { ...valid, courseLink: `${ORIGIN}/#v=1&c=${"a".repeat(MAX_REPORT_LINK_CHARS)}` },
      /at most/,
    ],
  ])("rejects %s", (_, body, message) => {
    expectInvalid(body, message);
  });

  it("only takes a course link to the given origin", () => {
    expectInvalid({ ...valid, courseLink: LINK }, /link to this app/, "https://elsewhere.example");
    expect(parseReportRequest({ ...valid, courseLink: LINK }).courseLink).toBe(LINK);
  });

  it("fits a request at every cap inside the body cap", () => {
    const longest = {
      kind: "idea",
      description: "x".repeat(MAX_REPORT_DESCRIPTION_CHARS),
      email: `${"a".repeat(MAX_REPORT_EMAIL_CHARS - 6)}@b.com`,
      turnstileToken: "t".repeat(MAX_REPORT_TOKEN_CHARS),
      diagnostics: {
        version: "v".repeat(MAX_REPORT_SHORT_CHARS),
        browser: "b".repeat(MAX_REPORT_BROWSER_CHARS),
        viewport: "v".repeat(MAX_REPORT_SHORT_CHARS),
        units: "u".repeat(MAX_REPORT_SHORT_CHARS),
        theme: "t".repeat(MAX_REPORT_SHORT_CHARS),
        plan: Object.fromEntries(
          Array.from({ length: MAX_REPORT_PLAN_FIELDS }, (_, i) => [
            `f${i}`.padEnd(MAX_REPORT_PLAN_KEY_CHARS, "a"),
            "p".repeat(MAX_REPORT_PLAN_VALUE_CHARS),
          ]),
        ),
        errors: Array.from({ length: MAX_REPORT_ERRORS }, () => ({
          kind: "rejection",
          message: "m".repeat(MAX_REPORT_ERROR_MESSAGE_CHARS),
          stack: "s".repeat(MAX_REPORT_ERROR_STACK_CHARS),
          at: "a".repeat(MAX_REPORT_SHORT_CHARS),
        })),
      },
      courseLink: `${ORIGIN}/#v=1&c=${"c".repeat(MAX_REPORT_LINK_CHARS - ORIGIN.length - 9)}`,
    };
    expect(() => parseReportRequest(longest, ORIGIN)).not.toThrow();
    expect(new TextEncoder().encode(JSON.stringify(longest)).length).toBeLessThan(MAX_REPORT_BODY_BYTES);
  });
});
