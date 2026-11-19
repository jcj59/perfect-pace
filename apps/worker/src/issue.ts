/**
 * The GitHub issue a report becomes. Everything in a report is untrusted text from anyone on the
 * internet, and the issue may be public, so:
 *
 * - Free text (the description, every diagnostic, the errors) goes inside a fenced code block
 *   whose fence is longer than any run of backticks in it, so it cannot close the block, and
 *   GitHub renders it as plain text: no markdown, links, images, HTML or @mentions (mentions in
 *   code never notify anyone).
 * - The title is a single line with every `@` before a name broken by a zero-width space, so it
 *   cannot mention anyone either.
 * - The only values outside code blocks are ones `parseReportRequest` restricts to safe
 *   characters: the kind, the email (in a code span; it holds no backticks) and the course link
 *   (letters, digits and `._~%&=-` after the `#`).
 * - Control characters other than newlines and tabs are dropped.
 *
 * The request's length caps keep the body far below GitHub's 65,536 characters.
 */
import type { ReportRequest } from "@pp/core";

/** The longest title, before the kind prefix. */
export const MAX_TITLE_CHARS = 80;

// Control characters except tab (09) and newline (0a), and the Unicode line and paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g;

/** `text` with Windows newlines made plain and control characters removed. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(CONTROL, "");
}

/** `content` in a fenced code block that nothing inside it can close. */
export function fenced(content: string, info = "text"): string {
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${info}\n${content}\n${fence}`;
}

/** Breaks every `@name` with a zero-width space, so it does not mention anyone. */
export function neutralizeMentions(text: string): string {
  return text.replace(/@(?=[\w-])/g, "@\u200b");
}

export function issueTitle(report: ReportRequest): string {
  const line = cleanText(report.description).replace(/\s+/g, " ").trim();
  const short = line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 3).trimEnd()}...` : line;
  return `[${report.kind}] ${neutralizeMentions(short)}`;
}

function diagnosticsText(diagnostics: NonNullable<ReportRequest["diagnostics"]>): string {
  const plan = Object.entries(diagnostics.plan).map(([key, value]) => `  ${key}: ${String(value)}`);
  return [
    `Version: ${diagnostics.version}`,
    `Browser: ${diagnostics.browser}`,
    `Viewport: ${diagnostics.viewport}`,
    `Units: ${diagnostics.units}`,
    `Theme: ${diagnostics.theme}`,
    "Plan:",
    ...(plan.length > 0 ? plan : ["  (none)"]),
  ].join("\n");
}

function errorsText(errors: NonNullable<ReportRequest["diagnostics"]>["errors"]): string {
  return errors
    .map((e) => [`[${e.at}] ${e.kind === "rejection" ? "Unhandled rejection" : "Error"}: ${e.message}`, e.stack ?? ""])
    .map((lines) => lines.filter(Boolean).join("\n"))
    .join("\n\n");
}

export function issueBody(report: ReportRequest): string {
  const sections = [
    "<!-- Filed from the app's Report a problem dialog. -->",
    `**Kind:** ${report.kind === "bug" ? "Bug" : "Idea"}`,
    `**Contact:** ${report.email ? `\`${report.email}\` (the reporter chose to show it here)` : "none given"}`,
    "### Description",
    fenced(cleanText(report.description)),
    "### Course",
    report.courseLink ? `[Open the reporter's course and plan](${report.courseLink})` : "Not included.",
    "### Diagnostics",
  ];
  const { diagnostics } = report;
  if (!diagnostics) sections.push("Not included.");
  else {
    sections.push(fenced(cleanText(diagnosticsText(diagnostics))));
    sections.push(`### Recent errors (${diagnostics.errors.length})`);
    sections.push(diagnostics.errors.length > 0 ? fenced(cleanText(errorsText(diagnostics.errors))) : "None.");
  }
  return sections.join("\n\n") + "\n";
}
