import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ElevationProfile,
  METERS_PER_MILE,
  buildElevationProfile,
  courseLengthM,
  parseGpx,
  prefixSums,
} from "../src/index.ts";
import { fixtureDemProvider } from "./support/dem.ts";
import { PRECISION, roundTo } from "./support/precision.ts";
import { randomValues } from "./support/rng.ts";

/**
 * One golden case: a frozen, JSON-serializable output plus a few headline numbers for
 * `golden-summary.md`. There is one case per fixture course (point count, distance, and the default
 * track's elevation profile so far; later PRs add plans). Round every number with `roundTo` and
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

/** The default track's elevation profile, every number rounded. */
async function elevationGolden(gpx: ReturnType<typeof parseGpx>) {
  const track = gpx.tracks[gpx.defaultTrack]!;
  const profile = await buildElevationProfile(track.course, { provider: fixtureDemProvider() });
  const ele = (m: number) => roundTo(m, PRECISION.elevationM);
  return {
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
      const elevation = await elevationGolden(gpx);
      return {
        output: {
          name: gpx.name ?? null,
          creator: gpx.creator ?? null,
          defaultTrack: gpx.defaultTrack,
          tracks,
          elevation,
        },
        summary: {
          tracks: tracks.length,
          points: main?.points ?? 0,
          "distance (m)": main?.distanceM ?? 0,
          "distance (mi)": roundTo((main?.distanceM ?? 0) / METERS_PER_MILE, 0.01),
          "elevation source": elevation.source,
          "gain / loss (m)": `${elevation.gainM} / ${elevation.lossM}`,
          "min / max (m)": `${elevation.minM} / ${elevation.maxM}`,
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
];
