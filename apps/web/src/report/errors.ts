/**
 * The last uncaught errors and unhandled rejections the page saw, for "Report a problem". Kept in
 * memory only (never stored or sent unless the user sends a report with diagnostics), newest
 * last, at most `MAX_REPORT_ERRORS`, each cut to the report's length caps.
 */
import {
  MAX_REPORT_ERRORS,
  MAX_REPORT_ERROR_MESSAGE_CHARS,
  MAX_REPORT_ERROR_STACK_CHARS,
  type ReportedError,
} from "@pp/core";

/** A fixed-size ring of recent errors. */
export interface ErrorLog {
  add: (kind: ReportedError["kind"], reason: unknown, at?: Date) => void;
  /** Oldest first. */
  list: () => ReportedError[];
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

function describe(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) {
    const message = reason.message ? `${reason.name}: ${reason.message}` : reason.name;
    return reason.stack ? { message, stack: reason.stack } : { message };
  }
  if (typeof reason === "string") return { message: reason };
  try {
    return { message: JSON.stringify(reason) ?? String(reason) };
  } catch {
    return { message: String(reason) };
  }
}

export function createErrorLog(capacity = MAX_REPORT_ERRORS): ErrorLog {
  const entries: ReportedError[] = [];
  return {
    add(kind, reason, at = new Date()) {
      const { message, stack } = describe(reason);
      entries.push({
        kind,
        message: cut(message, MAX_REPORT_ERROR_MESSAGE_CHARS),
        ...(stack ? { stack: cut(stack, MAX_REPORT_ERROR_STACK_CHARS) } : {}),
        at: at.toISOString(),
      });
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    },
    list: () => entries.slice(),
  };
}

/** The app's error log, filled once `captureErrors` has run. */
export const errorLog = createErrorLog();

let installed = false;

/** Start recording uncaught errors and unhandled rejections into `errorLog`. Runs once. */
export function captureErrors(target: Pick<Window, "addEventListener"> = window): void {
  if (installed) return;
  installed = true;
  target.addEventListener("error", (event: ErrorEvent) => {
    // A resource that failed to load (an image, a script) fires a plain Event, not an ErrorEvent.
    if (!(event instanceof ErrorEvent)) return;
    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
    errorLog.add("error", event.error ?? `${event.message}${where}`);
  });
  target.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    errorLog.add("rejection", event.reason);
  });
}
