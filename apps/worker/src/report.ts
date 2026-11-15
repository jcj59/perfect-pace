/**
 * `/api/report`: files a report from the app's "Report a problem" dialog as a GitHub issue. The
 * wire contract is `report.ts` in `@pp/core`; the issue's format and how it handles untrusted
 * text is `issue.ts`.
 *
 * A `POST` goes through, in order: the configuration check (`not_configured` until the secrets
 * exist), the body size cap, the schema, a per-IP burst limit, the per-IP hourly limit, the
 * Turnstile check, and then the GitHub API.
 *
 * Rate limiting: `REPORT_HOURLY_LIMIT` reports per client IP per hour, as a sliding window. The
 * Workers Rate Limiting binding `/api/route` uses only has 10 and 60 second windows, and a
 * Durable Object would rule out the per-PR preview URLs (Workers with Durable Objects cannot
 * have them), so each IP's recent report times are a small JSON list in the `REPORT_LIMITS` KV
 * namespace, under a SHA-256 of the IP (the address itself is never stored), expiring after an
 * hour. KV is eventually consistent across locations (a write is visible at once where it was
 * made, elsewhere within about a minute), so a client spreading requests across locations could
 * get a few more through; in front of it, the `REPORT_RATE_LIMITER` binding allows at most
 * `REPORT_BURST_LIMIT` attempts per IP per minute, which bounds that overshoot and the
 * Turnstile calls an IP can cause. A report counts once it passes Turnstile, before GitHub is
 * called, so a failing upstream cannot be retried without limit.
 */
import {
  type ReportConfig,
  type ReportErrorBody,
  MAX_REPORT_BODY_BYTES,
  REPORT_ERROR_STATUS,
  ReportError,
  type ReportRequest,
  parseReportRequest,
} from "@pp/core";
import { issueBody, issueTitle } from "./issue.ts";

/** Reports allowed per client IP per hour. */
export const REPORT_HOURLY_LIMIT = 5;
export const REPORT_WINDOW_S = 60 * 60;
/** Attempts allowed per client IP per minute. Must match `wrangler.jsonc`. */
export const REPORT_BURST_LIMIT = 5;
export const REPORT_BURST_PERIOD_S = 60;
/** The repository issues go to, unless `REPORT_REPO` says otherwise. */
export const DEFAULT_REPORT_REPO = "jcj59/perfect-pace";
export const REPORT_LABEL = "user-report";
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** How long to wait for Turnstile or GitHub. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Bindings `/api/report` uses. The token and secret are secrets, so not in the generated `Env`. */
export interface ReportEnv {
  REPORT_RATE_LIMITER: RateLimit;
  REPORT_LIMITS: KVNamespace;
  /** Public; a `vars` entry in `wrangler.jsonc`. */
  TURNSTILE_SITE_KEY?: string;
  REPORT_REPO?: string;
  TURNSTILE_SECRET?: string;
  GITHUB_REPORT_TOKEN?: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function errorResponse(error: ReportError): Response {
  const body: ReportErrorBody = { error: error.code, message: error.message };
  const headers: Record<string, string> = {};
  if (error.retryAfterS !== undefined) {
    body.retryAfterS = error.retryAfterS;
    headers["retry-after"] = String(error.retryAfterS);
  }
  return json(body, REPORT_ERROR_STATUS[error.code], headers);
}

interface Secrets {
  siteKey: string;
  turnstileSecret: string;
  githubToken: string;
  repo: string;
}

function secretsOf(env: ReportEnv): Secrets | null {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  const turnstileSecret = env.TURNSTILE_SECRET?.trim();
  const githubToken = env.GITHUB_REPORT_TOKEN?.trim();
  if (!siteKey || !turnstileSecret || !githubToken) return null;
  return { siteKey, turnstileSecret, githubToken, repo: env.REPORT_REPO?.trim() || DEFAULT_REPORT_REPO };
}

const upstreamFailed = (): ReportError =>
  new ReportError("upstream_unavailable", "The report could not be sent. Try again in a minute.");

async function readReport(request: Request): Promise<ReportRequest> {
  const tooLarge = new ReportError("payload_too_large", `The report must be at most ${MAX_REPORT_BODY_BYTES} bytes.`);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_REPORT_BODY_BYTES) throw tooLarge;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_REPORT_BODY_BYTES) throw tooLarge;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ReportError("invalid_request", "the body must be JSON");
  }
  return parseReportRequest(body, new URL(request.url).origin);
}

async function ipKey(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `report-ip:${hex}`;
}

/** This key's report times (ms) within the last hour. */
async function recentReports(kv: KVNamespace, key: string, now: number): Promise<number[]> {
  const stored = await kv.get<unknown>(key, "json");
  const times = Array.isArray(stored) ? stored.filter((t): t is number => typeof t === "number") : [];
  return times.filter((t) => t > now - REPORT_WINDOW_S * 1000 && t <= now);
}

/** Ask Turnstile whether `token` is good. Throws `captcha_failed`, or `upstream_unavailable`. */
async function verifyTurnstile(token: string, secret: string, ip: string | null): Promise<void> {
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set("remoteip", ip);
  let outcome: { success?: unknown; "error-codes"?: unknown };
  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`siteverify answered ${response.status}`);
    outcome = await response.json();
  } catch (error) {
    console.error("/api/report Turnstile failed:", error instanceof Error ? error.message : error);
    throw upstreamFailed();
  }
  if (outcome.success === true) return;
  const codes = Array.isArray(outcome["error-codes"]) ? outcome["error-codes"].map(String) : [];
  if (codes.some((c) => c.includes("secret"))) {
    console.error(`/api/report Turnstile rejected the secret: ${codes.join(", ")}`);
    throw upstreamFailed();
  }
  throw new ReportError("captcha_failed", "The human check failed or expired. Try sending again.");
}

async function createIssue(report: ReportRequest, secrets: Secrets): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${secrets.repo}/issues`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${secrets.githubToken}`,
        "content-type": "application/json",
        "user-agent": "perfect-pace-report",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        title: issueTitle(report),
        body: issueBody(report),
        labels: [REPORT_LABEL, report.kind],
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("/api/report GitHub unreachable:", error instanceof Error ? error.message : error);
    throw upstreamFailed();
  }
  if (response.status !== 201) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    console.error(`/api/report GitHub answered ${response.status}: ${detail}`);
    throw upstreamFailed();
  }
}

async function report(request: Request, env: ReportEnv): Promise<Response> {
  const secrets = secretsOf(env);
  if (!secrets) throw new ReportError("not_configured", "Reporting is not set up on this server yet.");
  const parsed = await readReport(request);

  const ip = request.headers.get("cf-connecting-ip");
  const { success } = await env.REPORT_RATE_LIMITER.limit({ key: `report:${ip ?? "unknown"}` });
  if (!success) {
    throw new ReportError("rate_limited", "Too many reports. Wait a minute and try again.", {
      retryAfterS: REPORT_BURST_PERIOD_S,
    });
  }
  const key = await ipKey(ip ?? "unknown");
  const now = Date.now();
  const recent = await recentReports(env.REPORT_LIMITS, key, now);
  if (recent.length >= REPORT_HOURLY_LIMIT) {
    const oldest = Math.min(...recent);
    throw new ReportError("rate_limited", "Too many reports from here this hour. Try again later.", {
      retryAfterS: Math.max(1, Math.ceil((oldest + REPORT_WINDOW_S * 1000 - now) / 1000)),
    });
  }

  await verifyTurnstile(parsed.turnstileToken, secrets.turnstileSecret, ip);
  await env.REPORT_LIMITS.put(key, JSON.stringify([...recent, now]), { expirationTtl: REPORT_WINDOW_S });
  await createIssue(parsed, secrets);
  return json({ ok: true }, 201);
}

/** Handles `/api/report`. Every failure is a JSON `{ error, message }` with a stable code. */
export async function handleReport(request: Request, env: ReportEnv): Promise<Response> {
  if (request.method === "GET") {
    const secrets = secretsOf(env);
    const config: ReportConfig = { configured: secrets !== null, siteKey: secrets?.siteKey ?? null };
    return json(config, 200);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "GET, POST" });
  try {
    return await report(request, env);
  } catch (error) {
    if (error instanceof ReportError) return errorResponse(error);
    console.error("/api/report failed unexpectedly", error);
    return errorResponse(upstreamFailed());
  }
}
