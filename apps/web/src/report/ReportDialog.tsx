import {
  MAX_REPORT_DESCRIPTION_CHARS,
  MAX_REPORT_EMAIL_CHARS,
  type ReportConfig,
  type ReportErrorBody,
  type ReportKind,
  type ReportRequest,
} from "@pp/core";
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { BUTTON_BASE, BUTTON_VARIANTS } from "../panel/FileButton.tsx";
import { useAppState } from "../state/app.ts";
import { useDrawState } from "../state/draw.ts";
import { useTheme } from "../theme.ts";
import { currentCourseLink, currentDiagnostics, hasShareableCourse } from "./diagnostics.ts";
import { type TurnstileApi, loadTurnstile } from "./turnstile.ts";

/** What the user has typed and picked. Kept while the page is open, so closing loses nothing. */
interface Draft {
  kind: ReportKind;
  description: string;
  email: string;
  showEmail: boolean;
  includeDiagnostics: boolean;
  includeCourse: boolean;
}

const EMPTY_DRAFT: Draft = {
  kind: "bug",
  description: "",
  email: "",
  showEmail: false,
  includeDiagnostics: true,
  includeCourse: false,
};
let savedDraft: Draft = EMPTY_DRAFT;

/** How long to wait for the human check before giving up on a send. */
const TOKEN_WAIT_MS = 20_000;

type Config = { status: "loading" } | { status: "ready"; siteKey: string } | { status: "unavailable"; why: string };
type Send = { status: "idle" } | { status: "sending" } | { status: "sent" } | { status: "error"; message: string };
type CourseLink = { status: "off" } | { status: "preparing" } | { status: "ready"; url: string } | { status: "none" };
/** A worked-out course link, and the course (`for`) it is for. */
type PreparedLink = { for: unknown; url: string | null };

const NOT_CONFIGURED = "This server is not set up to receive reports yet.";
const UNREACHABLE = "The server could not be reached. Check your connection and try again later.";

async function fetchConfig(signal: AbortSignal): Promise<Config> {
  try {
    const response = await fetch("/api/report", { signal });
    if (!response.ok) return { status: "unavailable", why: UNREACHABLE };
    const config = (await response.json()) as ReportConfig;
    return config.configured && config.siteKey
      ? { status: "ready", siteKey: config.siteKey }
      : { status: "unavailable", why: NOT_CONFIGURED };
  } catch {
    return { status: "unavailable", why: UNREACHABLE };
  }
}

function failureMessage(status: number, body: Partial<ReportErrorBody> | null): string {
  switch (body?.error) {
    case "rate_limited": {
      const minutes = Math.max(1, Math.ceil((body.retryAfterS ?? 60) / 60));
      return `You have sent several reports in a short time. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    }
    case "captcha_failed":
      return "The human check did not pass. Try sending again.";
    case "payload_too_large":
      return "The report is too large to send. Shorten the description or leave out the course.";
    case "invalid_request":
      return `The report could not be sent: ${body.message ?? "it was not accepted"}.`;
    default:
      return status === 0
        ? "The report could not be sent. Check your connection and try again."
        : "The report could not be sent. Try again in a minute.";
  }
}

const CHECKBOX = "mt-0.5 size-4 shrink-0 cursor-pointer accent-accent disabled:cursor-default";
const NOTE = "mt-1 text-[13px] leading-snug text-ink-muted";

function Option({
  id,
  label,
  note,
  children,
  ...input
}: {
  id: string;
  label: ReactNode;
  note?: ReactNode;
  children?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        className={CHECKBOX}
        checked={input.checked}
        disabled={input.disabled}
        onChange={(e) => input.onChange(e.target.checked)}
        aria-describedby={note ? `${id}-note` : undefined}
      />
      <div className="min-w-0 flex-1">
        <label
          htmlFor={id}
          className={`block text-sm leading-snug font-medium ${input.disabled ? "text-ink-muted" : "cursor-pointer text-ink"}`}
        >
          {label}
        </label>
        {note && (
          <p id={`${id}-note`} className={NOTE}>
            {note}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea, summary, iframe, [tabindex="0"]';

/**
 * Keep Tab inside the dialog. A modal `<dialog>` makes the page inert, but Tab past its last
 * control still leaves it for the browser's own toolbar; this wraps around instead.
 */
function trapTab(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const all = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const focusable = all.filter((el) => el.getClientRects().length > 0);
  // Radios in a group are one stop: only the checked one takes focus.
  const stops = focusable.filter((el) => !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked));
  const first = stops[0];
  const last = stops.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * "Report a problem": a bug or an idea, filed as a GitHub issue through `/api/report`. A native
 * modal `<dialog>`: the rest of the page is inert while it is open (so focus stays in it), Esc
 * closes it, and focus goes back to the menu button after.
 */
export default function ReportDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const theme = useTheme();
  const [draft, setDraftState] = useState<Draft>(savedDraft);
  const [config, setConfig] = useState<Config>({ status: "loading" });
  const [send, setSend] = useState<Send>({ status: "idle" });
  const [prepared, setPrepared] = useState<PreparedLink | null>(null);
  const course = useAppState((s) => s.course);
  const route = useDrawState((s) => s.history.present);
  const shareable = hasShareableCourse(course, route);
  // A drawn route changes without the course state changing, so it is the key for drawn courses.
  const courseKey: unknown = course.status === "drawn" ? route : course;
  const wantLink = draft.includeCourse && shareable;
  const link: CourseLink = !wantLink
    ? { status: "off" }
    : !prepared || prepared.for !== courseKey
      ? { status: "preparing" }
      : prepared.url
        ? { status: "ready", url: prepared.url }
        : { status: "none" };
  const turnstileBox = useRef<HTMLDivElement>(null);
  const turnstile = useRef<{ api: TurnstileApi; id: string } | null>(null);
  const token = useRef<string | null>(null);
  const tokenWaiters = useRef<((token: string) => void)[]>([]);

  const setDraft = (patch: Partial<Draft>) => {
    setDraftState((d) => {
      const next = { ...d, ...patch };
      savedDraft = next;
      return next;
    });
  };

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchConfig(controller.signal).then((c) => {
      if (!controller.signal.aborted) setConfig(c);
    });
    return () => controller.abort();
  }, []);

  // The human check, once the form shows. Invisible unless Turnstile needs the user to act.
  const siteKey = config.status === "ready" ? config.siteKey : null;
  const showForm = siteKey !== null && send.status !== "sent";
  useEffect(() => {
    if (!siteKey || !showForm) return;
    let cancelled = false;
    loadTurnstile().then(
      (api) => {
        if (cancelled || !turnstileBox.current) return;
        const id = api.render(turnstileBox.current, {
          sitekey: siteKey,
          action: "report",
          theme,
          size: "flexible",
          appearance: "interaction-only",
          callback: (t) => {
            token.current = t;
            for (const resolve of tokenWaiters.current.splice(0)) resolve(t);
          },
          "expired-callback": () => {
            token.current = null;
          },
          "error-callback": () => {
            token.current = null;
          },
        });
        if (id !== undefined) turnstile.current = { api, id };
      },
      () => {
        if (!cancelled) setConfig({ status: "unavailable", why: UNREACHABLE });
      },
    );
    return () => {
      cancelled = true;
      if (turnstile.current) turnstile.current.api.remove(turnstile.current.id);
      turnstile.current = null;
      token.current = null;
    };
    // The theme is read once per widget; a change while the dialog is open keeps the widget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, showForm]);

  // The course link, worked out when the user opts in.
  useEffect(() => {
    if (!wantLink) return;
    const controller = new AbortController();
    currentCourseLink(controller.signal).then(
      (url) => {
        if (!controller.signal.aborted) setPrepared({ for: courseKey, url });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("Could not prepare the course link", error);
        setPrepared({ for: courseKey, url: null });
      },
    );
    return () => controller.abort();
  }, [wantLink, courseKey]);

  function waitForToken(): Promise<string | null> {
    if (token.current) return Promise.resolve(token.current);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), TOKEN_WAIT_MS);
      tokenWaiters.current.push((t) => {
        clearTimeout(timer);
        resolve(t);
      });
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (send.status === "sending") return;
    const description = draft.description.trim();
    if (!description) return;
    setSend({ status: "sending" });
    const turnstileToken = await waitForToken();
    if (!turnstileToken) {
      setSend({ status: "error", message: "The human check did not finish. Try sending again." });
      return;
    }
    const email = draft.email.trim();
    const body: ReportRequest = {
      kind: draft.kind,
      description,
      turnstileToken,
      ...(draft.showEmail && email ? { email } : {}),
      ...(draft.includeDiagnostics ? { diagnostics: currentDiagnostics() } : {}),
      ...(draft.includeCourse && link.status === "ready" ? { courseLink: link.url } : {}),
    };
    // A token is good for one check, so the next attempt needs a new one either way.
    token.current = null;
    if (turnstile.current) turnstile.current.api.reset(turnstile.current.id);
    let status = 0;
    let answer: Partial<ReportErrorBody> | null = null;
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      status = response.status;
      if (response.ok) {
        savedDraft = EMPTY_DRAFT;
        setSend({ status: "sent" });
        return;
      }
      answer = (await response.json().catch(() => null)) as Partial<ReportErrorBody> | null;
    } catch {
      // Offline, or the request never reached the server: `status` stays 0.
    }
    if (answer?.error === "not_configured") {
      setConfig({ status: "unavailable", why: NOT_CONFIGURED });
      setSend({ status: "idle" });
      return;
    }
    setSend({ status: "error", message: failureMessage(status, answer) });
  }

  const titleId = `${ids}-title`;
  const sending = send.status === "sending";
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      data-testid="report-dialog"
      onClose={onClose}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={trapTab}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[440px] overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface p-0 text-ink shadow-panel backdrop:bg-black/45"
    >
      <div className="flex items-center gap-3 px-5 pt-4 pb-2">
        <h2 id={titleId} className="min-w-0 flex-1 text-[17px] font-semibold tracking-tight">
          Report a problem
        </h2>
        <button
          type="button"
          aria-label="Close"
          onClick={() => dialog.current?.close()}
          className="-mr-2 grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-ink-muted hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      {config.status === "loading" ? (
        <p className="px-5 pb-6 text-sm text-ink-muted" role="status">
          Loading...
        </p>
      ) : config.status === "unavailable" ? (
        <div className="px-5 pb-5" data-testid="report-unavailable">
          <p className="text-[15px] font-medium text-ink">Reporting is unavailable right now.</p>
          <p className={NOTE}>{config.why}</p>
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              autoFocus
              onClick={() => dialog.current?.close()}
              className={`${BUTTON_BASE} ${BUTTON_VARIANTS.secondary}`}
            >
              Close
            </button>
          </div>
        </div>
      ) : send.status === "sent" ? (
        <div className="px-5 pb-5" data-testid="report-sent">
          <div className="flex items-center gap-3" role="status">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
              <svg
                viewBox="0 0 24 24"
                className="size-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m5 12.5 4.5 4.5L19 7.5" />
              </svg>
            </span>
            <p className="text-[15px] font-semibold text-ink">Thanks, report sent</p>
          </div>
          <p className={`${NOTE} mt-2`}>It is now an issue for the developer to look at.</p>
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              autoFocus
              onClick={() => dialog.current?.close()}
              className={`${BUTTON_BASE} ${BUTTON_VARIANTS.secondary}`}
            >
              Close
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="px-5 pb-5" data-testid="report-form">
          <fieldset>
            <legend className="text-sm font-medium text-ink">Kind</legend>
            <div className="mt-1.5 flex w-fit rounded-full bg-surface-raised p-1 ring-1 ring-line ring-inset">
              {(["bug", "idea"] as const).map((kind) => (
                <label
                  key={kind}
                  className="relative cursor-pointer rounded-full px-4 py-1.5 text-[13px] font-medium text-ink-muted select-none hover:text-ink has-checked:bg-surface has-checked:text-ink has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-accent"
                >
                  <input
                    type="radio"
                    name={`${ids}-kind`}
                    value={kind}
                    checked={draft.kind === kind}
                    onChange={() => setDraft({ kind })}
                    className="sr-only"
                  />
                  {kind === "bug" ? "Something is wrong" : "An idea"}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-4">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={`${ids}-description`} className="text-sm font-medium text-ink">
                Description
              </label>
              <span className="text-xs text-ink-subtle tabular-nums" aria-hidden="true">
                {draft.description.length} / {MAX_REPORT_DESCRIPTION_CHARS}
              </span>
            </div>
            <textarea
              id={`${ids}-description`}
              required
              rows={5}
              maxLength={MAX_REPORT_DESCRIPTION_CHARS}
              value={draft.description}
              onChange={(e) => setDraft({ description: e.target.value })}
              placeholder={
                draft.kind === "bug" ? "What happened, and what did you expect?" : "What would make the app better?"
              }
              data-testid="report-description"
              className="mt-1.5 block w-full resize-y rounded-xl border border-line bg-surface-raised px-3 py-2 text-[15px] leading-snug text-ink placeholder:text-ink-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:outline-none"
            />
          </div>

          <div className="mt-4">
            <label htmlFor={`${ids}-email`} className="text-sm font-medium text-ink">
              Email <span className="font-normal text-ink-muted">(optional)</span>
            </label>
            <input
              id={`${ids}-email`}
              type="email"
              autoComplete="email"
              maxLength={MAX_REPORT_EMAIL_CHARS}
              value={draft.email}
              onChange={(e) => setDraft({ email: e.target.value })}
              data-testid="report-email"
              className="mt-1.5 block h-10 w-full rounded-xl border border-line bg-surface-raised px-3 text-[15px] text-ink focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:outline-none"
            />
            <div className="mt-2">
              <Option
                id={`${ids}-show-email`}
                label="Show my email in the issue, so I can be contacted"
                note="Reports become GitHub issues, which can be public. Your email is sent only if you check this."
                checked={draft.showEmail}
                disabled={draft.email.trim() === ""}
                onChange={(showEmail) => setDraft({ showEmail })}
              />
            </div>
          </div>

          <div className="mt-4 space-y-3 border-t border-line pt-4">
            <Option
              id={`${ids}-diagnostics`}
              label="Include diagnostics"
              note="App version, browser, screen size, units, theme, plan inputs and recent errors. No location."
              checked={draft.includeDiagnostics}
              onChange={(includeDiagnostics) => setDraft({ includeDiagnostics })}
            >
              {draft.includeDiagnostics && <DiagnosticsPreview />}
            </Option>
            <Option
              id={`${ids}-course`}
              label="Include my course"
              note={
                !shareable
                  ? "There is no course on screen to include."
                  : link.status === "none"
                    ? "This course is too large for a link, so it cannot be included."
                    : "Adds a link that opens your course and plan. A course can show where you live or run, and the issue can be public."
              }
              checked={draft.includeCourse && shareable}
              disabled={!shareable}
              onChange={(includeCourse) => setDraft({ includeCourse })}
            />
          </div>

          <div ref={turnstileBox} className="mt-3 empty:hidden" data-testid="report-turnstile" />

          {send.status === "error" && (
            <p
              role="alert"
              className="mt-4 rounded-xl border border-danger/25 bg-danger-soft px-3 py-2 text-sm leading-snug text-ink"
              data-testid="report-error"
            >
              {send.message}
            </p>
          )}

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className={`${BUTTON_BASE} ${BUTTON_VARIANTS.secondary} h-10 px-4`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={sending || draft.description.trim() === "" || link.status === "preparing"}
              className={`${BUTTON_BASE} ${BUTTON_VARIANTS.primary} h-10 rounded-lg px-4 text-sm`}
              data-testid="report-send"
            >
              {sending ? "Sending..." : "Send report"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/** What diagnostics will send, shown on request. Read when opened, so it is current. */
function DiagnosticsPreview() {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-1.5" onToggle={(e) => setOpen(e.currentTarget.open)} data-testid="report-diagnostics">
      <summary className="w-fit cursor-pointer rounded text-[13px] font-medium text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
        Preview
      </summary>
      {open && (
        <pre
          className="mt-2 max-h-48 overflow-auto rounded-lg bg-surface-raised p-2.5 text-[11px] leading-snug whitespace-pre-wrap text-ink-muted ring-1 ring-line ring-inset"
          data-testid="report-diagnostics-preview"
          tabIndex={0}
        >
          {JSON.stringify(currentDiagnostics(), null, 2)}
        </pre>
      )}
    </details>
  );
}
