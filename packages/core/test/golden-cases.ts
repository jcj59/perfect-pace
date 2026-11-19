import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type DistanceUnit,
  type ElevationProfile,
  METERS_PER_MILE,
  buildElevationProfile,
  computePlan,
  courseLengthM,
  formatDuration,
  formatPace,
  paceToUnit,
  parseGpx,
  prefixSums,
  unitToMeters,
} from "../src/index.ts";
import { fixtureDemProvider } from "./support/dem.ts";
import { PRECISION, roundTo } from "./support/precision.ts";
import { randomValues } from "./support/rng.ts";

/**
 * One golden case: a frozen, JSON-serializable output plus a few headline numbers for
 * `golden-summary.md`. There is one case per fixture course (point count, distance, and the default
 * track's elevation profile and its plans for a fixed set of inputs). Round every number with `roundTo` and
 * `PRECISION`.
 */
export interface GoldenResult {
  output: unknown;
  summary: Record<string, string | number>;
}

export interface GoldenCase {
  /** File-safe name; the snapshot is `test/golden/<name>.json`. */
  name: string;
  description: string;
  compute: () => GoldenResult | Promise<GoldenResult>;
}

const GPX_DIR = join(import.meta.dirname, "fixtures", "gpx");

/** Grade profile bin width: 500 m, about 85 numbers for a marathon. */
const GRADE_BIN_M = 500;

/** The distance-weighted mean grade over each `GRADE_BIN_M` of the profile (by interval start). */
function gradeProfile(profile: ElevationProfile): number[] {
  const rise: number[] = [];
  const run: number[] = [];
  const pts = profile.course.points;
  profile.grades.forEach((grade, i) => {
    const a = pts[i]!.distM;
    const length = pts[i + 1]!.distM - a;
    const bin = Math.floor(a / GRADE_BIN_M);
    rise[bin] = (rise[bin] ?? 0) + grade * length;
    run[bin] = (run[bin] ?? 0) + length;
  });
  return Array.from(run, (r, bin) => roundTo((r ?? 0) > 0 ? (rise[bin] ?? 0) / (r ?? 1) : 0, PRECISION.ratio));
}

/**
 * The fixed plan inputs every course is snapshotted with. The goal is a fixed average pace of
 * 8:00/mi (so it suits a 5K and a marathon alike), rounded to the whole second; `K` (the most
 * segments) is 1, 3, 6 and 10; each unit system has its own minimum segment length, 0.2 mi or
 * 0.3 km, as a user would type it.
 */
const PLAN_GOAL_S_PER_MI = 480;
const PLAN_MAX_SEGMENTS = [1, 3, 6, 10];
const PLAN_MIN_SEGMENT: Record<DistanceUnit, number> = { mi: 0.2, km: 0.3 };

/** The default track's plans for the fixed inputs, every number rounded, or null without a course to pace. */
function planGolden(profile: ElevationProfile) {
  const lengthM = courseLengthM(profile.course);
  if (profile.course.points.length < 2 || lengthM === 0) return null;
  const goalTimeS = Math.round((lengthM / METERS_PER_MILE) * PLAN_GOAL_S_PER_MI);
  const units = (["mi", "km"] as const).map((unit) => {
    const minSegmentM = unitToMeters(PLAN_MIN_SEGMENT[unit], unit);
    const pace = (sPerM: number) => roundTo(paceToUnit(sPerM, unit), PRECISION.paceS);
    const plans = PLAN_MAX_SEGMENTS.map((k) => {
      const plan = computePlan(profile.course, { goalTimeS, paceChanges: k - 1, unit, minSegmentM });
      return {
        maxSegments: k,
        totalTimeS: roundTo(plan.totalTimeS, PRECISION.paceS),
        segments: plan.segments.map((s) => ({
          startM: roundTo(s.startM, PRECISION.distanceM),
          endM: roundTo(s.endM, PRECISION.distanceM),
          pace: pace(s.paceSPerM),
          avgGrade: roundTo(s.avgGrade, PRECISION.ratio),
          reason: s.reason,
        })),
      };
    });
    // The curve is the same for every K (it always spans 0 to 10 changes), so it is stored once.
    const { errorCurve, flatPaceSPerM } = computePlan(profile.course, { goalTimeS, paceChanges: 0, unit, minSegmentM });
    return {
      unit,
      minSegment: PLAN_MIN_SEGMENT[unit],
      flatPace: pace(flatPaceSPerM),
      rmsPaceGapByChanges: errorCurve.map((p) => pace(p.rmsPaceGapSPerM)),
      plans,
    };
  });
  // For golden-summary.md: the paces of the plan with up to 6 segments, as the app shows them.
  const summary: Record<string, string> = { "plan goal (8:00/mi)": formatDuration(goalTimeS) };
  for (const unit of ["mi", "km"] as const) {
    const minSegmentM = unitToMeters(PLAN_MIN_SEGMENT[unit], unit);
    const plan = computePlan(profile.course, { goalTimeS, paceChanges: 5, unit, minSegmentM });
    summary[`plan paces, up to 6 segments (per ${unit})`] = plan.segments
      .map((s) => formatPace(s.paceSPerM, unit))
      .join(", ");
  }
  return { output: { goalTimeS, units }, summary };
}

/**
 * The fixed custom breakpoints every course's custom plan is snapshotted with, as fractions of its
 * length: a quarter, a half (twice, to check repeats are dropped) and three quarters.
 */
const CUSTOM_BREAKPOINT_FRACTIONS = [0.25, 0.5, 0.5, 0.75];

/**
 * The default track's plans of every fixed type (B11) for the same goal as `planGolden`: Even,
 * Splits of one unit, and Custom at `CUSTOM_BREAKPOINT_FRACTIONS`, each in both unit systems, with
 * the root mean square gap from the ideal pace so the types compare at a glance.
 */
function planTypesGolden(profile: ElevationProfile) {
  const lengthM = courseLengthM(profile.course);
  if (profile.course.points.length < 2 || lengthM === 0) return null;
  const goalTimeS = Math.round((lengthM / METERS_PER_MILE) * PLAN_GOAL_S_PER_MI);
  const units = (["mi", "km"] as const).map((unit) => {
    const pace = (sPerM: number) => roundTo(paceToUnit(sPerM, unit), PRECISION.paceS);
    const types = (["even", "splits", "custom"] as const).map((type) => {
      const breakpointsM = CUSTOM_BREAKPOINT_FRACTIONS.map((f) => f * lengthM);
      const plan = computePlan(profile.course, { goalTimeS, paceChanges: 0, unit, type, breakpointsM });
      return {
        type,
        totalTimeS: roundTo(plan.totalTimeS, PRECISION.paceS),
        rmsPaceGap: pace(Math.sqrt(plan.error / lengthM)),
        segments: plan.segments.map((s) => ({
          endM: roundTo(s.endM, PRECISION.distanceM),
          pace: pace(s.paceSPerM),
          reason: s.reason,
        })),
      };
    });
    return { unit, types };
  });
  const summary: Record<string, string> = {};
  for (const { unit, types } of units) {
    for (const t of types) {
      const paces = t.segments.map((s) => s.pace);
      summary[`${t.type} per ${unit}: segments, rms gap, slowest / fastest pace (s)`] =
        `${t.segments.length}, ${t.rmsPaceGap}, ${Math.max(...paces)} / ${Math.min(...paces)}`;
    }
  }
  return { output: { goalTimeS, units }, summary };
}

function planTypesCase(file: string): GoldenCase {
  return {
    name: `plan-types-${courseName(file)}`,
    description: `Even, Splits and Custom plans for \`test/fixtures/gpx/${file}\`.`,
    compute: async () => {
      const gpx = parseGpx(readFileSync(join(GPX_DIR, file), "utf8"));
      const track = gpx.tracks[gpx.defaultTrack]!;
      const profile = await buildElevationProfile(track.course, { provider: fixtureDemProvider() });
      const result = planTypesGolden(profile);
      return { output: result?.output ?? null, summary: result?.summary ?? { plan: "none" } };
    },
  };
}

/** The default track's elevation profile and plans, every number rounded. */
async function elevationGolden(gpx: ReturnType<typeof parseGpx>) {
  const track = gpx.tracks[gpx.defaultTrack]!;
  const profile = await buildElevationProfile(track.course, { provider: fixtureDemProvider() });
  const ele = (m: number) => roundTo(m, PRECISION.elevationM);
  return {
    plan: planGolden(profile),
    source: profile.source,
    gpsIssue: profile.gpsIssue ?? null,
    points: profile.course.points.length,
    demPoints: profile.demPoints,
    gainM: ele(profile.stats.gainM),
    lossM: ele(profile.stats.lossM),
    minM: ele(profile.stats.minM),
    maxM: ele(profile.stats.maxM),
    gradeBinM: GRADE_BIN_M,
    gradeProfile: gradeProfile(profile),
  };
}

/** `FH-Fox.gpx` is `fh-fox`, `gpx-1.0.gpx` is `gpx-1-0`. */
const courseName = (file: string): string =>
  file
    .replace(/\.gpx$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");

function gpxCase(file: string): GoldenCase {
  return {
    name: `course-${courseName(file)}`,
    description: `Parsed course from \`test/fixtures/gpx/${file}\`.`,
    compute: async () => {
      const gpx = parseGpx(readFileSync(join(GPX_DIR, file), "utf8"));
      const tracks = gpx.tracks.map((t) => ({
        kind: t.kind,
        name: t.name ?? null,
        segments: t.segmentCount,
        points: t.course.points.length,
        droppedPoints: t.droppedPoints,
        pointsWithEle: t.course.points.filter((p) => p.ele !== undefined).length,
        distanceM: roundTo(courseLengthM(t.course), PRECISION.distanceM),
      }));
      const main = tracks[gpx.defaultTrack];
      const { plan, ...elevation } = await elevationGolden(gpx);
      return {
        output: {
          name: gpx.name ?? null,
          creator: gpx.creator ?? null,
          defaultTrack: gpx.defaultTrack,
          tracks,
          elevation,
          plan: plan?.output ?? null,
        },
        summary: {
          tracks: tracks.length,
          points: main?.points ?? 0,
          "distance (m)": main?.distanceM ?? 0,
          "distance (mi)": roundTo((main?.distanceM ?? 0) / METERS_PER_MILE, 0.01),
          "elevation source": elevation.source,
          "gain / loss (m)": `${elevation.gainM} / ${elevation.lossM}`,
          "min / max (m)": `${elevation.minM} / ${elevation.maxM}`,
          ...plan?.summary,
        },
      };
    },
  };
}

export const goldenCases: GoldenCase[] = [
  {
    name: "harness-prefix-sums",
    description: "Harness check: prefix sums of 16 seeded values in [0, 100).",
    compute: () => {
      const prefix = Array.from(prefixSums(randomValues(5999, 16, 0, 100)), (v) => roundTo(v, PRECISION.ratio));
      return {
        output: { count: prefix.length - 1, prefix },
        summary: { count: prefix.length - 1, total: prefix.at(-1) ?? 0 },
      };
    },
  },
  ...readdirSync(GPX_DIR)
    .filter((f) => f.endsWith(".gpx"))
    .sort()
    .map(gpxCase),
  ...readdirSync(GPX_DIR)
    .filter((f) => f.endsWith(".gpx"))
    .sort()
    .map(planTypesCase),
];
