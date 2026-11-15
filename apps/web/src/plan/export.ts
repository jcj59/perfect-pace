/**
 * What the Share and export controls produce, as pure functions: the plan as CSV, the pace band's
 * rows, and the course as GPX. Unit tested apart from the DOM.
 */
import {
  type DistanceUnit,
  type ElevationProfile,
  type Plan,
  type CoursePoint,
  formatDuration,
  formatPace,
  metersPerUnit,
  metersToUnit,
  pointAtDistance,
  writeGpx,
} from "@pp/core";
import type { CourseState } from "../state/app.ts";
import { trackTitle } from "../state/course.ts";
import { roundPreservingSum } from "./inputs.ts";
import { type Tone, segmentTone } from "./tones.ts";

/** A field quoted for CSV when it needs to be (a comma, quote or line break in it). */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const fixed2 = (meters: number, units: DistanceUnit) => metersToUnit(meters, units).toFixed(2);

/** A grade as a signed percentage to one decimal, `1.2`, `-0.4` or `0.0`. */
function gradePercent(grade: number): string {
  const pct = (grade * 100).toFixed(1);
  return Number(pct) === 0 ? "0.0" : pct;
}

/**
 * The plan as CSV: one row per segment (where it runs, its length, pace, grade, time, the time
 * elapsed at its end and its reason), then a Finish row. Segment times are rounded so they add up
 * to the finish, as in the table. Lines end with CRLF, as RFC 4180 has it.
 */
export function planCsv(plan: Plan, units: DistanceUnit): string {
  const times = roundPreservingSum(plan.segments.map((s) => s.timeS));
  const header = [
    "Segment",
    `Start (${units})`,
    `End (${units})`,
    `Distance (${units})`,
    `Pace (/${units})`,
    "Grade (%)",
    "Time",
    "Elapsed",
    "Note",
  ];
  let elapsed = 0;
  const rows = plan.segments.map((s, i) => {
    elapsed += times[i] ?? 0;
    return [
      String(i + 1),
      fixed2(s.startM, units),
      fixed2(s.endM, units),
      fixed2(s.endM - s.startM, units),
      formatPace(s.paceSPerM, units),
      gradePercent(s.avgGrade),
      formatDuration(times[i] ?? 0),
      formatDuration(elapsed),
      s.reason,
    ];
  });
  const finish = [
    "Finish",
    fixed2(0, units),
    fixed2(plan.lengthM, units),
    fixed2(plan.lengthM, units),
    formatPace(elapsed / plan.lengthM, units),
    "",
    formatDuration(elapsed),
    formatDuration(elapsed),
    "",
  ];
  return [header, ...rows, finish].map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** One row of the pace band: a mile (or kilometer) marker, or the finish. */
export interface BandRow {
  /** The marker's distance in the units: 1, 2, ... then the finish (26.22). */
  at: number;
  finish: boolean;
  /** Seconds from the previous marker, rounded so the splits add up to the elapsed times. */
  splitS: number;
  /** Seconds from the start, to the second. */
  elapsedS: number;
  /** The tone of the segment the runner spends most of this split in. */
  tone: Tone;
  /** That segment's index. */
  segment: number;
  /** Whether this split's segment is not the one before's: the pace changes in it. */
  change: boolean;
}

/** Seconds from the start to `distM` along the plan, at each segment's pace. */
function elapsedAt(plan: Plan, distM: number): number {
  let time = 0;
  for (const s of plan.segments) {
    if (distM >= s.endM) time += s.timeS;
    else {
      if (distM > s.startM) time += (distM - s.startM) * s.paceSPerM;
      break;
    }
  }
  return time;
}

/** The segment with the most time between `fromM` and `toM`. */
function mainSegment(plan: Plan, fromM: number, toM: number): number {
  let best = 0;
  let bestS = -1;
  plan.segments.forEach((s, i) => {
    const overlap = (Math.min(toM, s.endM) - Math.max(fromM, s.startM)) * s.paceSPerM;
    if (overlap > bestS) {
      bestS = overlap;
      best = i;
    }
  });
  return best;
}

/**
 * The pace band: the time to reach every mile (or kilometer) marker and the finish, and each
 * split. The finish time is the plan's total rounded to the second, the same as the table's.
 */
export function paceBand(plan: Plan, units: DistanceUnit): BandRow[] {
  const unitM = metersPerUnit(units);
  const total = plan.lengthM;
  const marks: number[] = [];
  for (let k = 1; k * unitM < total - 1; k++) marks.push(k * unitM);
  marks.push(total);
  const finishS = roundPreservingSum(plan.segments.map((s) => s.timeS)).reduce((a, b) => a + b, 0);
  let previousM = 0;
  let previousS = 0;
  let previousSegment = -1;
  return marks.map((m, i) => {
    const finish = i === marks.length - 1;
    const elapsedS = finish ? finishS : Math.round(elapsedAt(plan, m));
    const segment = mainSegment(plan, previousM, m);
    const s = plan.segments[segment]!;
    const row: BandRow = {
      at: finish ? Number(metersToUnit(total, units).toFixed(2)) : i + 1,
      finish,
      splitS: elapsedS - previousS,
      elapsedS,
      tone: segmentTone(s.paceSPerM, plan.flatPaceSPerM),
      segment,
      change: previousSegment !== -1 && segment !== previousSegment,
    };
    previousM = m;
    previousS = elapsedS;
    previousSegment = segment;
    return row;
  });
}

/** A file name from a course title: `Boston Marathon` becomes `boston-marathon`. */
export function fileSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "course";
}

/** The name the panel and the exports give the course on screen. */
export function courseName(course: CourseState): string {
  if (course.status === "loaded") return trackTitle(course.file, course.track, course.fileName);
  return "Drawn route";
}

/** A course to download as GPX: its text, and a file name for it. */
export interface GpxDownload {
  fileName: string;
  text: string;
}

/**
 * The course on screen as GPX. A drawn route is written with its elevation from terrain data
 * (taken from the profile at each point), since it has none of its own. A loaded course is
 * written as loaded: the track on screen, with the file's own elevation (a simplified copy has
 * none, so it gets the profile's too). Undefined while there is no course.
 */
export function courseGpx(course: CourseState, profile: ElevationProfile | undefined): GpxDownload | undefined {
  let points: readonly CoursePoint[];
  let withProfile: boolean;
  if (course.status === "drawn") {
    if (!course.course) return undefined;
    points = course.course.points;
    withProfile = true;
  } else if (course.status === "loaded") {
    const track = course.file.tracks[course.track];
    if (!track) return undefined;
    points = track.course.points;
    withProfile = !!course.copy;
  } else return undefined;
  const name = courseName(course);
  const out =
    withProfile && profile && profile.course.points.length > 1
      ? points.map((p) => {
          const ele = pointAtDistance(profile.course, p.distM).ele;
          return ele === undefined ? { lat: p.lat, lon: p.lon } : { lat: p.lat, lon: p.lon, ele };
        })
      : points.map(({ lat, lon, ele }) => (ele === undefined ? { lat, lon } : { lat, lon, ele }));
  return { fileName: `${fileSlug(name)}.gpx`, text: writeGpx(out, { name }) };
}

/** Save `text` as a file named `fileName`, the way a download link does. */
export function downloadText(fileName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked later: some browsers start the download only after the click handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
