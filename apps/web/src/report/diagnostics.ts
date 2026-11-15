/**
 * What "Include diagnostics" and "Include my course" attach to a report. Diagnostics hold no
 * place: the plan fields say what kind of course is on screen and how long, never where it is or
 * what it is called. Only the course link, which the user opts into, carries the course itself.
 */
import { MAX_REPORT_BROWSER_CHARS, type ReportDiagnostics, type SharedCourse } from "@pp/core";
import { courseName } from "../plan/export.ts";
import { type AppState, type CourseState, appStore } from "../state/app.ts";
import { type DrawState, drawStore } from "../state/draw.ts";
import { readyProfile } from "../state/focus.ts";
import { type PlanView, planStore } from "../state/plan.ts";
import { prepareShare, shareUrl } from "../state/session.ts";
import { resolveTheme } from "../theme.ts";
import { errorLog } from "./errors.ts";

/** The build's git commit, set by `vite.config.ts`. */
export const APP_VERSION: string = __APP_VERSION__;

export interface DiagnosticsSource {
  app: AppState;
  draw: Pick<DrawState, "editing" | "history">;
  plan: Pick<PlanView, "profile" | "plan" | "error">;
  version: string;
  userAgent: string;
  viewport: { width: number; height: number; dpr: number };
  systemDark: boolean;
  errors: ReportDiagnostics["errors"];
}

/** The plan inputs and the shape of the course on screen. */
function planFields({ app, draw, plan }: DiagnosticsSource): ReportDiagnostics["plan"] {
  const { course } = app;
  const fields: ReportDiagnostics["plan"] = { course: course.status };
  if (course.status === "loaded") {
    fields["tracks"] = course.file.tracks.length;
    fields["track"] = course.track;
    fields["elevation"] = course.elevation.status;
    if (course.copy) fields["copy"] = course.copy;
  }
  if (course.status === "drawn") {
    fields["drawing"] = draw.editing;
    fields["waypoints"] = draw.history.present.waypoints.length;
  }
  const profile = readyProfile(course);
  if (profile) {
    fields["distanceM"] = Math.round(profile.course.points.at(-1)?.distM ?? 0);
    fields["points"] = profile.course.points.length;
    fields["elevationSource"] = profile.source;
  }
  fields["goalTimeS"] = app.goalTimeS;
  fields["paceChanges"] = app.paceChanges;
  fields["minSegmentM"] = app.minSegmentM;
  if (plan.plan && plan.profile === profile) fields["segments"] = plan.plan.segments.length;
  if (plan.error) fields["planError"] = plan.error.slice(0, 200);
  return fields;
}

export function buildDiagnostics(source: DiagnosticsSource): ReportDiagnostics {
  const { app, viewport } = source;
  const dpr = Math.round(viewport.dpr * 100) / 100;
  return {
    version: source.version,
    browser: source.userAgent.slice(0, MAX_REPORT_BROWSER_CHARS),
    viewport: `${viewport.width}x${viewport.height} @${dpr}x`,
    units: app.units,
    theme: `${resolveTheme(app.theme, source.systemDark)} (${app.theme})`,
    plan: planFields(source),
    errors: source.errors,
  };
}

/** The diagnostics for the page as it is now. */
export function currentDiagnostics(): ReportDiagnostics {
  return buildDiagnostics({
    app: appStore.get(),
    draw: drawStore.get(),
    plan: planStore.get(),
    version: APP_VERSION,
    userAgent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    systemDark: matchMedia("(prefers-color-scheme: dark)").matches,
    errors: errorLog.list(),
  });
}

/** Whether there is a course on screen that a link could carry. */
export function hasShareableCourse(course: CourseState, route: { waypoints: readonly unknown[] }): boolean {
  if (course.status === "drawn") return route.waypoints.length >= 2;
  return course.status === "loaded" && !!course.file.tracks[course.track];
}

/**
 * A share link to the course and plan on screen, the same one Copy link makes, or null when
 * there is no course or it is too large for a link.
 */
export async function currentCourseLink(signal?: AbortSignal): Promise<string | null> {
  const app = appStore.get();
  const { course } = app;
  let shared: SharedCourse | undefined;
  if (course.status === "drawn") {
    const route = drawStore.get().history.present;
    if (route.waypoints.length >= 2) shared = { kind: "drawn", route };
  } else if (course.status === "loaded") {
    const points = course.file.tracks[course.track]?.course.points;
    if (points) shared = { kind: "track", points };
  }
  if (!shared) return null;
  const name = course.status === "loaded" ? courseName(course) : undefined;
  const prepared = await prepareShare(shared, name, signal ? { signal } : {});
  if (!prepared) return null;
  return shareUrl(prepared, {
    goalTimeS: app.goalTimeS,
    paceChanges: app.paceChanges,
    minSegmentM: app.minSegmentM,
    unit: app.units,
  });
}
