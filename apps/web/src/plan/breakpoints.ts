/**
 * Editing custom breakpoints, as pure functions on the profile's course: where a placed, moved,
 * typed or added breakpoint lands, and reading a distance the user typed. Every breakpoint sits
 * on a course point (the resample spacing), strictly between the start and the finish. Unit
 * tested apart from the DOM.
 */
import {
  type Course,
  type DistanceUnit,
  MAX_CUSTOM_BREAKPOINTS,
  MAX_PARTITION_SEGMENTS,
  courseLengthM,
  metersToUnit,
  snapToCourse,
  unitToMeters,
} from "@pp/core";
import { MIN_SPLIT_M } from "../state/app.ts";

/** The distance of the course point nearest `distM`, or undefined when that is the start or the finish. */
export function snapBreakpointM(course: Course, distM: number): number | undefined {
  const index = snapToCourse(course, distM);
  if (index <= 0 || index >= course.points.length - 1) return undefined;
  return course.points[index]!.distM;
}

/**
 * The breakpoints with one more at `distM` (snapped), or undefined when it cannot go there: on the
 * start or the finish, on a breakpoint already there, or past `MAX_CUSTOM_BREAKPOINTS`.
 */
export function withBreakpoint(course: Course, breakpointsM: readonly number[], distM: number): number[] | undefined {
  if (breakpointsM.length >= MAX_CUSTOM_BREAKPOINTS) return undefined;
  const at = snapBreakpointM(course, distM);
  if (at === undefined || breakpointsM.includes(at)) return undefined;
  return [...breakpointsM, at].sort((a, b) => a - b);
}

/**
 * Where to add a breakpoint when there is no spot picked: the middle of the longest segment the
 * breakpoints make now. Undefined when no more fit.
 */
export function nextBreakpointM(course: Course, breakpointsM: readonly number[]): number | undefined {
  const edges = [0, ...breakpointsM, courseLengthM(course)];
  let best = 0;
  for (let i = 1; i < edges.length - 1; i++) {
    if (edges[i + 1]! - edges[i]! > edges[best + 1]! - edges[best]!) best = i;
  }
  const at = (edges[best]! + edges[best + 1]!) / 2;
  return withBreakpoint(course, breakpointsM, at) ? snapBreakpointM(course, at) : undefined;
}

/**
 * Breakpoint `index` moved toward `distM`: snapped, and kept at least one course point clear of its
 * neighbors (and the ends), so a drag never passes or lands on another and the order holds.
 */
export function movedBreakpoints(
  course: Course,
  breakpointsM: readonly number[],
  index: number,
  distM: number,
): number[] {
  const last = course.points.length - 1;
  const lo = index > 0 ? snapToCourse(course, breakpointsM[index - 1]!) + 1 : 1;
  const hi = index < breakpointsM.length - 1 ? snapToCourse(course, breakpointsM[index + 1]!) - 1 : last - 1;
  if (lo > hi) return [...breakpointsM];
  const at = Math.min(hi, Math.max(lo, snapToCourse(course, distM)));
  const out = [...breakpointsM];
  out[index] = course.points[at]!.distM;
  return out;
}

/**
 * Breakpoint `index` replaced by a typed distance (snapped). A distance on another breakpoint
 * merges the two. Undefined when it lands on the start or the finish.
 */
export function retypedBreakpoints(
  course: Course,
  breakpointsM: readonly number[],
  index: number,
  distM: number,
): number[] | undefined {
  const at = snapBreakpointM(course, distM);
  if (at === undefined) return undefined;
  const out = [...breakpointsM];
  out[index] = at;
  return [...new Set(out)].sort((a, b) => a - b);
}

/** A distance typed in the units (`3`, `3.25`, ` 13.1 `, `5,5` with a decimal comma), in meters; undefined if unreadable. */
export function parseDistance(text: string, unit: DistanceUnit): number | undefined {
  const t = text.trim().replace(",", ".");
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return undefined;
  return unitToMeters(Number(t), unit);
}

/** A distance in the units for an input: up to two decimals, no trailing zeros (`3.1`, `13.11`, `5`). */
export function distanceInput(meters: number, unit: DistanceUnit): string {
  return String(Math.round(metersToUnit(meters, unit) * 100) / 100);
}

export type SplitCheck = { ok: true; meters: number } | { ok: false; message: string };

/**
 * Read a split length typed in the units for a course `lengthM` long: at least a tenth of the unit
 * (never under `MIN_SPLIT_M`), and few enough splits to plan.
 */
export function checkSplit(text: string, unit: DistanceUnit, lengthM: number): SplitCheck {
  const meters = parseDistance(text, unit);
  if (meters === undefined) return { ok: false, message: `Enter a distance in ${unit}, like 5 or 0.5.` };
  if (meters < Math.max(MIN_SPLIT_M, unitToMeters(0.1, unit)) - 1e-9) {
    return { ok: false, message: `Use splits of at least 0.1 ${unit}.` };
  }
  if (lengthM / meters > MAX_PARTITION_SEGMENTS) {
    return { ok: false, message: `That makes more than ${MAX_PARTITION_SEGMENTS} splits. Try a longer one.` };
  }
  return { ok: true, meters };
}
