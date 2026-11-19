/**
 * Share links: a course and the plan inputs, in a URL fragment. Nothing is stored on a server,
 * so the link is the whole plan. The fragment is a versioned, `&`-separated list of fields:
 *
 *     v=2&c=<course>&g=<goal s>&p=<plan type>&k=<pace changes>&s=<shortest segment m>
 *        &l=<split m>&b=<breakpoints m>&u=<mi|km>&n=<name>
 *
 * - `v`: the format version (`SHARE_VERSION`). A newer one gets a message to reload, an unknown
 *   one a clear refusal; neither is guessed at. Version 1 links (from before plan types) still
 *   open, as an `optimal` plan.
 * - `p`: the plan type, `o` (optimal), `e` (even), `s` (splits) or `c` (custom). `l` is the split
 *   length in meters, for splits only; `b` the custom breakpoints in whole meters from the start,
 *   `.`-separated in order, for custom only (left out when there are none).
 * - `c`: the course. A drawn route is `d.<modes>.<waypoints>`: its leg modes run-length encoded
 *   (`p` for paths, `s` for straight, each after its count when more than 1, so `3ps` is three
 *   path legs then a straight one) and its waypoints as a URL-safe polyline (`polyline.ts`) at the
 *   5 decimal places waypoints are already rounded to, so the route comes back exactly. Anything
 *   else (an uploaded course) is `t.<points>`, a simplified track (see `simplifyForShare`), whose
 *   elevation then comes from terrain data where the link opens.
 * - `g` is left out while the goal is the suggested one. `n` is the course name, percent-encoded.
 *
 * Every field is checked when decoding; a link that fails gets a `ShareError` with a message fit
 * to show the person who opened it.
 */
import { type DistanceUnit, METERS_PER_MILE, metersPerUnit } from "./units.ts";
import { type DrawnRoute, LEG_MODES, type LegMode } from "./draw.ts";
import type { LatLon } from "./geo.ts";
import { DEFAULT_CURVE_MAX_PACE_CHANGES, MAX_CUSTOM_BREAKPOINTS, type PlanType } from "./plan.ts";
import { PolylineError, decodePolyline, encodePolyline, fromUrlSafe, toUrlSafe } from "./polyline.ts";
import { polylineLengthM } from "./routing.ts";
import { simplify } from "./simplify.ts";

/** The share format version this code writes. It also reads every version from `OLDEST_SHARE_VERSION` up. */
export const SHARE_VERSION = 2;
/** The oldest share format version this code still reads (version 1 links open as `optimal` plans). */
export const OLDEST_SHARE_VERSION = 1;

/**
 * The longest link the app makes, in characters. Browsers take far longer ones, but links pass
 * through chat apps, email and notes, and this keeps them well inside what those carry intact.
 */
export const MAX_SHARE_URL_LENGTH = 8000;

/** Douglas-Peucker tolerances tried for an uploaded course, finest first (meters). */
export const SHARE_TOLERANCES_M: readonly number[] = [1, 2, 3, 5, 8, 12, 20];

/** The simplified track's length stays within this fraction of the course's own (0.5%). */
export const MAX_SHARE_LENGTH_ERROR = 0.005;

/** Course names are cut to this many characters. */
export const MAX_SHARE_NAME_LENGTH = 80;

/** The longest goal a link may carry: a week, past any race. */
export const MAX_SHARE_GOAL_S = 7 * 24 * 3600;

/** The longest shortest-segment (and split) a link may carry, meters. */
const MAX_SHARE_MIN_SEGMENT_M = 100 * METERS_PER_MILE;
/** The shortest split a link may carry, meters. */
const MIN_SHARE_SPLIT_M = 10;
/** The farthest breakpoint a link may carry, meters (7 digits). */
export const MAX_SHARE_BREAKPOINT_M = 9_999_999;

/** The course in a share link. */
export type SharedCourse =
  | { kind: "drawn"; route: DrawnRoute }
  /** A simplified uploaded course. */
  | { kind: "track"; points: LatLon[] };

/** The plan inputs in a share link (the same fields as the app's plan inputs). */
export interface SharedSettings {
  /** The goal entered, or null for the suggested one. */
  goalTimeS: number | null;
  planType: PlanType;
  paceChanges: number;
  minSegmentM: number;
  /** The split length, meters. Carried for `splits` only; elsewhere a link gives one `unit`. */
  splitM: number;
  /** Custom breakpoints, meters from the start. Carried (as whole meters) for `custom` only. */
  breakpointsM: readonly number[];
  unit: DistanceUnit;
}

export interface SharedPlan {
  course: SharedCourse;
  settings: SharedSettings;
  /** The course name to show, if the link has one. */
  name?: string;
}

/** Why a link could not be opened. */
export type ShareErrorCode =
  /** Made by a newer version of the app. */
  | "newer"
  /** A version this app no longer (or never did) read. */
  | "unsupported"
  /** Damaged or cut off: a field missing or unreadable. */
  | "corrupt";

const SHARE_MESSAGES: Record<ShareErrorCode, string> = {
  newer:
    "This link was made with a newer version of Perfect Pace. Reload the page to update, then open the link again.",
  unsupported: "This link is from a version of Perfect Pace that is no longer supported, so it can't be opened here.",
  corrupt:
    "This link is incomplete or damaged, so its course can't be read. Check that the whole link was copied, or ask for it again.",
};

/** A link that cannot be opened. `message` is written for the person who opened it. */
export class ShareError extends Error {
  override readonly name = "ShareError";
  constructor(
    readonly code: ShareErrorCode,
    /** What exactly was wrong, for the console. */
    readonly detail: string,
  ) {
    super(SHARE_MESSAGES[code]);
  }
}

const corrupt = (detail: string) => new ShareError("corrupt", detail);

const MODE_CHARS: Record<LegMode, string> = { snap: "p", straight: "s" };

function encodeModes(modes: readonly LegMode[]): string {
  let out = "";
  for (let i = 0; i < modes.length;) {
    let run = 1;
    while (modes[i + run] === modes[i]) run++;
    out += `${run > 1 ? run : ""}${MODE_CHARS[modes[i]!]}`;
    i += run;
  }
  return out;
}

function decodeModes(text: string, count: number): LegMode[] {
  const modes: LegMode[] = [];
  const pattern = /(\d*)([a-z])/gy;
  let match: RegExpExecArray | null;
  let end = 0;
  while ((match = pattern.exec(text))) {
    const run = match[1] ? Number(match[1]) : 1;
    const mode = LEG_MODES.find((m) => MODE_CHARS[m] === match![2]);
    if (!mode || !(run >= 1) || modes.length + run > count) throw corrupt(`bad leg modes "${text}"`);
    for (let i = 0; i < run; i++) modes.push(mode);
    end = pattern.lastIndex;
  }
  if (end !== text.length || modes.length !== count) throw corrupt(`bad leg modes "${text}" for ${count} legs`);
  return modes;
}

function encodePoints(points: readonly LatLon[]): string {
  return toUrlSafe(encodePolyline(points));
}

function decodePoints(text: string): LatLon[] {
  let points: LatLon[];
  try {
    points = decodePolyline(fromUrlSafe(text));
  } catch (error) {
    if (error instanceof PolylineError) throw corrupt(`bad points: ${error.message}`);
    throw error;
  }
  for (const p of points) {
    if (!(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)) throw corrupt(`position off the globe ${p.lat}, ${p.lon}`);
  }
  return points;
}

/** The `c` field for a course. */
export function encodeSharedCourse(course: SharedCourse): string {
  if (course.kind === "drawn") {
    const { waypoints, modes } = course.route;
    return `d.${encodeModes(modes)}.${encodePoints(waypoints)}`;
  }
  return `t.${encodePoints(course.points)}`;
}

/** The course in a `c` field. Throws a `ShareError` (code `corrupt`) when it cannot be read. */
export function decodeSharedCourse(text: string): SharedCourse {
  const [kind, ...rest] = text.split(".");
  if (kind === "d" && rest.length === 2) {
    const waypoints = decodePoints(rest[1]!);
    if (waypoints.length < 2) throw corrupt("a drawn route needs two waypoints");
    return { kind: "drawn", route: { waypoints, modes: decodeModes(rest[0]!, waypoints.length - 1) } };
  }
  if (kind === "t" && rest.length === 1) {
    const points = decodePoints(rest[0]!);
    if (points.length < 2 || polylineLengthM(points) === 0) throw corrupt("a track needs two distinct points");
    return { kind: "track", points };
  }
  throw corrupt(`unknown course "${text.slice(0, 12)}"`);
}

/** A number without trailing zeros, to at most 3 decimal places (`402.336`, `500`). */
const compact = (value: number) => String(Math.round(value * 1000) / 1000);

const PLAN_TYPE_CHARS: Record<PlanType, string> = { optimal: "o", even: "e", splits: "s", custom: "c" };

/** Custom breakpoints as the `b` field carries them: whole meters, in order, without repeats. */
function wholeBreakpoints(breakpointsM: readonly number[]): number[] {
  return [...new Set(breakpointsM.map((b) => Math.round(b)))]
    .filter((b) => b > 0 && b <= MAX_SHARE_BREAKPOINT_M)
    .sort((a, b) => a - b)
    .slice(0, MAX_CUSTOM_BREAKPOINTS);
}

/** The fragment (without `#`) for a plan. */
export function encodeShare(plan: SharedPlan): string {
  const { goalTimeS, planType, paceChanges, minSegmentM, splitM, breakpointsM, unit } = plan.settings;
  const fields = [`v=${SHARE_VERSION}`, `c=${encodeSharedCourse(plan.course)}`];
  if (goalTimeS !== null) fields.push(`g=${Math.round(goalTimeS)}`);
  fields.push(`p=${PLAN_TYPE_CHARS[planType]}`, `k=${paceChanges}`, `s=${compact(minSegmentM)}`);
  if (planType === "splits") fields.push(`l=${compact(splitM)}`);
  const breakpoints = planType === "custom" ? wholeBreakpoints(breakpointsM) : [];
  if (breakpoints.length > 0) fields.push(`b=${breakpoints.join(".")}`);
  fields.push(`u=${unit}`);
  const name = plan.name?.trim().slice(0, MAX_SHARE_NAME_LENGTH);
  if (name) fields.push(`n=${encodeURIComponent(name)}`);
  return fields.join("&");
}

function fieldsOf(fragment: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of fragment.replace(/^#/, "").split("&")) {
    if (part === "") continue;
    const at = part.indexOf("=");
    if (at <= 0) continue;
    fields.set(part.slice(0, at), part.slice(at + 1));
  }
  return fields;
}

/** Whether a URL fragment is a share link at all (it has a version field), however damaged. */
export function isShareFragment(fragment: string): boolean {
  return fieldsOf(fragment).has("v");
}

function wholeNumber(text: string | undefined, field: string, min: number, max: number): number {
  const value = text !== undefined && /^\d{1,9}$/.test(text) ? Number(text) : NaN;
  if (!(value >= min && value <= max)) throw corrupt(`bad ${field} "${text ?? ""}"`);
  return value;
}

function decodePlanType(text: string | undefined): PlanType {
  const type = (Object.keys(PLAN_TYPE_CHARS) as PlanType[]).find((t) => PLAN_TYPE_CHARS[t] === text);
  if (!type) throw corrupt(`bad p "${text ?? ""}"`);
  return type;
}

function decodeSplit(text: string | undefined): number {
  const splitM = text !== undefined && /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
  if (!(splitM >= MIN_SHARE_SPLIT_M && splitM <= MAX_SHARE_MIN_SEGMENT_M)) throw corrupt(`bad l "${text ?? ""}"`);
  return splitM;
}

function decodeBreakpoints(text: string | undefined): number[] {
  if (text === undefined) return [];
  const parts = text.split(".");
  if (parts.length > MAX_CUSTOM_BREAKPOINTS) throw corrupt(`${parts.length} breakpoints`);
  const breakpointsM = parts.map((part) => wholeNumber(part, "b", 1, MAX_SHARE_BREAKPOINT_M));
  if (breakpointsM.some((b, i) => i > 0 && b <= breakpointsM[i - 1]!)) throw corrupt("breakpoints out of order");
  return breakpointsM;
}

/**
 * The plan in a share link's fragment (with or without the `#`). Throws a `ShareError`: `newer`
 * or `unsupported` for a format version this code does not read, `corrupt` for a field missing or
 * unreadable. A version 1 link has no plan type, so it opens as `optimal`.
 */
export function decodeShare(fragment: string): SharedPlan {
  const fields = fieldsOf(fragment);
  const version = fields.get("v");
  if (version === undefined) throw corrupt("no version");
  if (!/^\d{1,6}$/.test(version)) throw new ShareError("unsupported", `version "${version}"`);
  if (Number(version) > SHARE_VERSION) throw new ShareError("newer", `version ${version}`);
  if (Number(version) < OLDEST_SHARE_VERSION) throw new ShareError("unsupported", `version ${version}`);

  const courseText = fields.get("c");
  if (!courseText) throw corrupt("no course");
  const course = decodeSharedCourse(courseText);
  const goal = fields.get("g");
  const minSegment = fields.get("s");
  const minSegmentM = minSegment !== undefined && /^\d+(\.\d+)?$/.test(minSegment) ? Number(minSegment) : NaN;
  if (!(minSegmentM >= 0 && minSegmentM <= MAX_SHARE_MIN_SEGMENT_M)) throw corrupt(`bad s "${minSegment ?? ""}"`);
  const unit = fields.get("u");
  if (unit !== "mi" && unit !== "km") throw corrupt(`bad u "${unit ?? ""}"`);
  const planType = Number(version) === 1 ? "optimal" : decodePlanType(fields.get("p"));
  const settings: SharedSettings = {
    goalTimeS: goal === undefined ? null : wholeNumber(goal, "g", 1, MAX_SHARE_GOAL_S),
    planType,
    paceChanges: wholeNumber(fields.get("k"), "k", 0, DEFAULT_CURVE_MAX_PACE_CHANGES),
    minSegmentM,
    splitM: planType === "splits" ? decodeSplit(fields.get("l")) : metersPerUnit(unit),
    breakpointsM: planType === "custom" ? decodeBreakpoints(fields.get("b")) : [],
    unit,
  };
  let name: string | undefined;
  const rawName = fields.get("n");
  if (rawName) {
    try {
      name = decodeURIComponent(rawName).trim().slice(0, MAX_SHARE_NAME_LENGTH) || undefined;
    } catch {
      throw corrupt("bad n");
    }
  }
  return name ? { course, settings, name } : { course, settings };
}

/** A course simplified for a share link, and how far it is from the course it came from. */
export interface ShareTrack {
  points: LatLon[];
  /** The Douglas-Peucker tolerance used, meters: no dropped point is farther than this from the line. */
  toleranceM: number;
  /** The simplified length's difference from the course's, as a fraction (0.001 is 0.1%). */
  lengthError: number;
}

/**
 * The finest simplification of a course (by `SHARE_TOLERANCES_M`) whose `t.` course field fits in
 * `maxChars` characters, keeping the length within `MAX_SHARE_LENGTH_ERROR`. Undefined when no
 * tolerance does both: the course is too long or too detailed for a link.
 */
export function simplifyForShare(points: readonly LatLon[], maxChars: number): ShareTrack | undefined {
  const lengthM = polylineLengthM(points);
  for (const toleranceM of SHARE_TOLERANCES_M) {
    const simplified = simplify(points, toleranceM).map(({ lat, lon }) => ({ lat, lon }));
    // The length of the line as the link carries it, with coordinates rounded.
    const carried = decodePolyline(encodePolyline(simplified));
    const lengthError = lengthM > 0 ? Math.abs(polylineLengthM(carried) - lengthM) / lengthM : 0;
    if (lengthError > MAX_SHARE_LENGTH_ERROR) return undefined;
    if (encodeSharedCourse({ kind: "track", points: carried }).length <= maxChars) {
      return { points: carried, toleranceM, lengthError };
    }
  }
  return undefined;
}

export interface ShareLink {
  url: string;
  /** For an uploaded course, the simplified track the link carries. */
  track?: ShareTrack;
}

/**
 * The share link for a plan on the page at `base` (its URL; any fragment is dropped), at most
 * `MAX_SHARE_URL_LENGTH` characters. A `track` course is given as the whole course and simplified
 * here (see `simplifyForShare`) to fit what the rest of the link leaves. Undefined when the
 * course does not fit: too many waypoints, or a track too long or detailed to simplify enough.
 */
/**
 * How many characters a `t.` course field may take in the link for `plan` on the page at `base`:
 * what `MAX_SHARE_URL_LENGTH` leaves after the page and the other fields. For `simplifyForShare`.
 */
export function shareTrackBudget(base: string, plan: Omit<SharedPlan, "course">): number {
  const page = `${base.replace(/#.*$/, "")}#`;
  const rest = page.length + encodeShare({ ...plan, course: { kind: "track", points: [] } }).length - "t.".length;
  return MAX_SHARE_URL_LENGTH - rest;
}

export function buildShareLink(base: string, plan: SharedPlan): ShareLink | undefined {
  const page = `${base.replace(/#.*$/, "")}#`;
  if (plan.course.kind === "drawn") {
    const url = page + encodeShare(plan);
    return url.length <= MAX_SHARE_URL_LENGTH ? { url } : undefined;
  }
  const track = simplifyForShare(plan.course.points, shareTrackBudget(base, plan));
  if (!track) return undefined;
  return { url: page + encodeShare({ ...plan, course: { kind: "track", points: track.points } }), track };
}
