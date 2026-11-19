/**
 * Report a problem: the wire contract of the Worker's `/api/report` endpoint, which files a bug
 * or an idea from the app as a GitHub issue.
 *
 * - `GET /api/report`: `ReportConfig`, whether reporting is set up and the Turnstile site key
 * - `POST /api/report`: a `ReportRequest` as JSON (at most `MAX_REPORT_BODY_BYTES`); success is
 *   201 `{ ok: true }`, failure `{ error: ReportErrorCode, message, retryAfterS? }` with the
 *   status in `REPORT_ERROR_STATUS`
 *
 * Issues can be public, so the request carries an `email` only when the user asked for it to be
 * shown in the issue. Every string has a length cap, so a valid request always fits the body cap
 * and the issue it becomes fits GitHub's limit.
 */
import { MAX_SHARE_URL_LENGTH } from "./share.ts";

export type ReportKind = "bug" | "idea";
export const REPORT_KINDS: readonly ReportKind[] = ["bug", "idea"];

/** The largest request body accepted, in bytes. A request at every cap below is about 38 KB. */
export const MAX_REPORT_BODY_BYTES = 48 * 1024;
export const MAX_REPORT_DESCRIPTION_CHARS = 4000;
export const MAX_REPORT_EMAIL_CHARS = 254;
export const MAX_REPORT_TOKEN_CHARS = 2048;
/** Uncaught errors and unhandled rejections kept and sent, most recent last. */
export const MAX_REPORT_ERRORS = 20;
export const MAX_REPORT_ERROR_MESSAGE_CHARS = 300;
export const MAX_REPORT_ERROR_STACK_CHARS = 1000;
/** Fields of `ReportDiagnostics.plan`, and the longest key and string value. */
export const MAX_REPORT_PLAN_FIELDS = 20;
export const MAX_REPORT_PLAN_KEY_CHARS = 40;
export const MAX_REPORT_PLAN_VALUE_CHARS = 200;
/** The longest of `version`, `viewport`, `units` and `theme`. */
export const MAX_REPORT_SHORT_CHARS = 64;
export const MAX_REPORT_BROWSER_CHARS = 400;
/** A course link is a share link, so it is at most a share link's length. */
export const MAX_REPORT_LINK_CHARS = MAX_SHARE_URL_LENGTH;

/** One uncaught error or unhandled rejection the page saw. */
export interface ReportedError {
  kind: "error" | "rejection";
  message: string;
  stack?: string;
  /** When it happened, ISO 8601. */
  at: string;
}

/** What the app sends about itself when "Include diagnostics" is on. */
export interface ReportDiagnostics {
  /** The build's git commit. */
  version: string;
  /** The user agent string. */
  browser: string;
  /** For example `390x844 @3x`. */
  viewport: string;
  units: string;
  /** For example `dark (system)`. */
  theme: string;
  /** The plan inputs and the course on screen, as flat fields. */
  plan: Record<string, string | number | boolean | null>;
  errors: ReportedError[];
}

export interface ReportRequest {
  kind: ReportKind;
  description: string;
  /** Only when the user chose to show it in the (possibly public) issue. */
  email?: string;
  /** The Cloudflare Turnstile token from the dialog's widget. */
  turnstileToken: string;
  diagnostics?: ReportDiagnostics;
  /** A share link to the course and plan on screen, only when the user opted in. */
  courseLink?: string;
}

/** `GET /api/report`. */
export interface ReportConfig {
  /** False until the server has its GitHub token, Turnstile secret and site key. */
  configured: boolean;
  /** The public Turnstile site key, or null when not configured. */
  siteKey: string | null;
}

export type ReportErrorCode =
  /** The body is not a valid `ReportRequest`. */
  | "invalid_request"
  /** The body is larger than `MAX_REPORT_BODY_BYTES`. */
  | "payload_too_large"
  /** The Turnstile token is missing, expired or was rejected. */
  | "captcha_failed"
  /** Too many reports from this client; retry after `retryAfterS`. */
  | "rate_limited"
  /** The server has no GitHub token, Turnstile secret or site key yet. */
  | "not_configured"
  /** GitHub or Turnstile failed or could not be reached. */
  | "upstream_unavailable";

export const REPORT_ERROR_STATUS: Readonly<Record<ReportErrorCode, number>> = {
  invalid_request: 400,
  payload_too_large: 413,
  captcha_failed: 403,
  rate_limited: 429,
  not_configured: 503,
  upstream_unavailable: 502,
};

/** The error body of `/api/report`. */
export interface ReportErrorBody {
  error: ReportErrorCode;
  message: string;
  retryAfterS?: number;
}

export class ReportError extends Error {
  override readonly name = "ReportError";
  readonly retryAfterS: number | undefined;
  constructor(
    readonly code: ReportErrorCode,
    message: string,
    options?: { retryAfterS?: number },
  ) {
    super(message);
    this.retryAfterS = options?.retryAfterS;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const invalid = (message: string): ReportError => new ReportError("invalid_request", message);

function text(value: unknown, name: string, max: number, options: { required?: boolean } = {}): string {
  if (typeof value !== "string") throw invalid(`${name} must be a string`);
  if (value.length > max) throw invalid(`${name} must be at most ${max} characters`);
  if (options.required && value.trim() === "") throw invalid(`${name} must not be empty`);
  return value;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, name, max);
}

/** A plain address: no spaces, quotes, brackets or backticks, one `@`, a dotted domain. */
const EMAIL = /^[^\s@<>()[\]\\,;:"`]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function parseErrors(value: unknown): ReportedError[] {
  if (!Array.isArray(value)) throw invalid("diagnostics.errors must be an array");
  if (value.length > MAX_REPORT_ERRORS) throw invalid(`diagnostics.errors must have at most ${MAX_REPORT_ERRORS}`);
  return value.map((entry, i) => {
    const name = `diagnostics.errors[${i}]`;
    if (!isRecord(entry)) throw invalid(`${name} must be an object`);
    if (entry["kind"] !== "error" && entry["kind"] !== "rejection") {
      throw invalid(`${name}.kind must be "error" or "rejection"`);
    }
    const stack = optionalText(entry["stack"], `${name}.stack`, MAX_REPORT_ERROR_STACK_CHARS);
    return {
      kind: entry["kind"],
      message: text(entry["message"], `${name}.message`, MAX_REPORT_ERROR_MESSAGE_CHARS),
      ...(stack === undefined ? {} : { stack }),
      at: text(entry["at"], `${name}.at`, MAX_REPORT_SHORT_CHARS),
    };
  });
}

function parsePlan(value: unknown): ReportDiagnostics["plan"] {
  if (!isRecord(value)) throw invalid("diagnostics.plan must be an object");
  const entries = Object.entries(value);
  if (entries.length > MAX_REPORT_PLAN_FIELDS) {
    throw invalid(`diagnostics.plan must have at most ${MAX_REPORT_PLAN_FIELDS} fields`);
  }
  const plan: ReportDiagnostics["plan"] = {};
  for (const [key, field] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || key.length > MAX_REPORT_PLAN_KEY_CHARS) {
      throw invalid(`diagnostics.plan has a bad field name`);
    }
    if (typeof field === "string") plan[key] = text(field, `diagnostics.plan.${key}`, MAX_REPORT_PLAN_VALUE_CHARS);
    else if (field === null || typeof field === "boolean" || (typeof field === "number" && Number.isFinite(field))) {
      plan[key] = field;
    } else throw invalid(`diagnostics.plan.${key} must be a string, finite number, boolean or null`);
  }
  return plan;
}

function parseDiagnostics(value: unknown): ReportDiagnostics {
  if (!isRecord(value)) throw invalid("diagnostics must be an object");
  return {
    version: text(value["version"], "diagnostics.version", MAX_REPORT_SHORT_CHARS),
    browser: text(value["browser"], "diagnostics.browser", MAX_REPORT_BROWSER_CHARS),
    viewport: text(value["viewport"], "diagnostics.viewport", MAX_REPORT_SHORT_CHARS),
    units: text(value["units"], "diagnostics.units", MAX_REPORT_SHORT_CHARS),
    theme: text(value["theme"], "diagnostics.theme", MAX_REPORT_SHORT_CHARS),
    plan: parsePlan(value["plan"]),
    errors: parseErrors(value["errors"]),
  };
}

/**
 * A share link as `shareUrl` writes it: an http(s) origin, a path, no query, and a fragment that
 * starts with the version and holds only the characters `encodeShare` writes. Parsed by pattern,
 * since core has no `URL` (no DOM or Node types), and strictly, since it ends up in the issue.
 */
const SHARE_LINK = /^(https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?)\/[A-Za-z0-9._~%/-]*#v=[A-Za-z0-9._~%&=-]+$/;

/** A course link, which must be a share link; `origin`, when given, is the only origin allowed. */
function parseCourseLink(value: unknown, origin: string | undefined): string {
  const link = text(value, "courseLink", MAX_REPORT_LINK_CHARS);
  const match = SHARE_LINK.exec(link);
  if (!match) throw invalid("courseLink must be a share link");
  if (origin !== undefined && match[1] !== origin) throw invalid("courseLink must be a link to this app");
  return link;
}

/**
 * Validate a `POST /api/report` body (already parsed from JSON). Unknown fields are dropped.
 * `origin` is the app's own origin, the only one a course link may point at.
 */
export function parseReportRequest(body: unknown, origin?: string): ReportRequest {
  if (!isRecord(body)) throw invalid("the body must be a JSON object");
  const kind = body["kind"];
  if (kind !== "bug" && kind !== "idea") throw invalid(`kind must be "bug" or "idea"`);
  const description = text(body["description"], "description", MAX_REPORT_DESCRIPTION_CHARS, { required: true });
  const turnstileToken = text(body["turnstileToken"], "turnstileToken", MAX_REPORT_TOKEN_CHARS, { required: true });
  const request: ReportRequest = { kind, description: description.trim(), turnstileToken };
  if (body["email"] !== undefined) {
    const email = text(body["email"], "email", MAX_REPORT_EMAIL_CHARS).trim();
    if (!EMAIL.test(email)) throw invalid("email must be an email address");
    request.email = email;
  }
  if (body["diagnostics"] !== undefined) request.diagnostics = parseDiagnostics(body["diagnostics"]);
  if (body["courseLink"] !== undefined) request.courseLink = parseCourseLink(body["courseLink"], origin);
  return request;
}
