import type { ReportConfig, ReportRequest } from "../../packages/core/src/index.ts";
import { expect, type Page, type Route } from "@playwright/test";

/** The token the stubbed Turnstile widget hands out, a fresh one per render or reset. */
export const E2E_TURNSTILE_TOKEN = "e2e-turnstile-token";

/**
 * Turnstile's script, stubbed: a widget that renders nothing (as the real invisible one does
 * when no interaction is needed) and passes at once, so tests never reach Cloudflare.
 */
const TURNSTILE_STUB = `
  (() => {
    let n = 0;
    const widgets = new Map();
    const issue = (id) => setTimeout(() => widgets.get(id)?.callback?.(${JSON.stringify(E2E_TURNSTILE_TOKEN)} + "-" + ++n), 0);
    window.turnstile = {
      render(container, options) {
        const id = "w" + widgets.size;
        widgets.set(id, options);
        window.__turnstileSiteKey = options.sitekey;
        issue(id);
        return id;
      },
      reset(id) { issue(id); },
      remove(id) { widgets.delete(id); },
    };
  })();
`;

export interface ReportStub {
  /** Every report POSTed, in order. */
  sent: ReportRequest[];
}

export interface ReportStubOptions {
  config?: ReportConfig;
  /** How to answer each POST in turn (the last repeats). Default 201. */
  answers?: { status: number; body?: unknown }[];
}

/** Answer `/api/report` in the page and stub the Turnstile script. */
export async function stubReport(page: Page, options: ReportStubOptions = {}): Promise<ReportStub> {
  const stub: ReportStub = { sent: [] };
  const config = options.config ?? { configured: true, siteKey: "1x00000000000000000000AA" };
  const answers = options.answers ?? [{ status: 201, body: { ok: true } }];
  await page.route("https://challenges.cloudflare.com/turnstile/**", (route) =>
    route.fulfill({ contentType: "text/javascript", body: TURNSTILE_STUB }),
  );
  await page.route("**/api/report", (route: Route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: config });
    stub.sent.push(request.postDataJSON() as ReportRequest);
    const answer = answers[Math.min(stub.sent.length - 1, answers.length - 1)]!;
    return route.fulfill({ status: answer.status, json: answer.body ?? { ok: true } });
  });
  return stub;
}

/** Open the header menu and pick "Report a problem". */
export async function openReportDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Report a problem" }).click();
  await expect(page.getByRole("dialog", { name: "Report a problem" })).toBeVisible();
}
