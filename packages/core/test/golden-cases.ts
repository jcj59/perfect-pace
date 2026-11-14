import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { METERS_PER_MILE, courseLengthM, parseGpx, prefixSums } from "../src/index.ts";
import { PRECISION, roundTo } from "./support/precision.ts";
import { randomValues } from "./support/rng.ts";

/**
 * One golden case: a frozen, JSON-serializable output plus a few headline numbers for
 * `golden-summary.md`. There is one case per fixture course (point count and distance so far;
 * later PRs add gain/loss, the grade profile and plans). Round every number with `roundTo` and
 * `PRECISION`.
 */
export interface GoldenCase {
  /** File-safe name; the snapshot is `test/golden/<name>.json`. */
  name: string;
  description: string;
  compute: () => { output: unknown; summary: Record<string, string | number> };
}

const GPX_DIR = join(import.meta.dirname, "fixtures", "gpx");

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
    compute: () => {
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
      return {
        output: { name: gpx.name ?? null, creator: gpx.creator ?? null, defaultTrack: gpx.defaultTrack, tracks },
        summary: {
          tracks: tracks.length,
          points: main?.points ?? 0,
          "distance (m)": main?.distanceM ?? 0,
          "distance (mi)": roundTo((main?.distanceM ?? 0) / METERS_PER_MILE, 0.01),
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
