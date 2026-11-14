/**
 * Sanity check against the original project's committed plans (`fixtures/original-results`). The
 * old plans used a different segmenter and an unweighted objective, so exact paces and breakpoints
 * differ by design. What must agree is the direction: wherever the old plan sped up or slowed down
 * from one of its segments to the next, our plan, averaged over the same two stretches, must move
 * the same way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  METERS_PER_MILE,
  type Plan,
  buildElevationProfile,
  computePlan,
  courseLengthM,
  paceToUnit,
  parseDuration,
  parseGpx,
} from "../src/index.ts";
import { fixtureDemProvider } from "./support/dem.ts";

interface OriginalPlan {
  gpx: string;
  source: string;
  goalMinutes: number;
  segments: { startMi: number; distanceMi: number; pace: string }[];
}

const FIXTURES = join(import.meta.dirname, "fixtures");
const originals = JSON.parse(
  readFileSync(join(FIXTURES, "original-results", "seg-plans.json"), "utf8"),
) as OriginalPlan[];

/** Shifts smaller than this (s/mi) in the old plan are not a clear direction, so they are skipped. */
const MIN_ORIGINAL_SHIFT_S_PER_MI = 5;

/** Our plan's average pace (s/mi) over `[startM, endM)`: its time there over the distance. */
function averagePace(plan: Plan, startM: number, endM: number): number {
  let timeS = 0;
  for (const s of plan.segments) {
    const overlap = Math.min(endM, s.endM) - Math.max(startM, s.startM);
    if (overlap > 0) timeS += overlap * s.paceSPerM;
  }
  return paceToUnit(timeS / (endM - startM), "mi");
}

describe("direction of pace shifts vs the original project", () => {
  it.each(originals.map((o) => [o.gpx, o] as const))("%s", async (_, original) => {
    const gpx = parseGpx(readFileSync(join(FIXTURES, "gpx", original.gpx), "utf8"));
    const profile = await buildElevationProfile(gpx.tracks[gpx.defaultTrack]!.course, {
      provider: fixtureDemProvider(),
    });
    const lengthM = courseLengthM(profile.course);
    const plan = computePlan(profile.course, {
      goalTimeS: original.goalMinutes * 60,
      paceChanges: 9,
      unit: "mi",
      minSegmentM: 0.2 * METERS_PER_MILE,
    });
    // The old distances came from its own parser; scale them onto ours (they agree within 1%).
    const originalLengthMi = original.segments.reduce((s, seg) => s + seg.distanceMi, 0);
    expect(Math.abs(originalLengthMi * METERS_PER_MILE - lengthM) / lengthM).toBeLessThan(0.01);
    const toM = (mi: number) => (mi / originalLengthMi) * lengthM;
    const paces = original.segments.map((seg) => ({
      old: parseDuration(seg.pace)!,
      ours: averagePace(plan, toM(seg.startMi), toM(seg.startMi + seg.distanceMi)),
    }));
    let compared = 0;
    for (let i = 1; i < paces.length; i++) {
      const oldShift = paces[i]!.old - paces[i - 1]!.old;
      const ourShift = paces[i]!.ours - paces[i - 1]!.ours;
      if (Math.abs(oldShift) < MIN_ORIGINAL_SHIFT_S_PER_MI) continue;
      compared++;
      expect(
        Math.sign(ourShift),
        `${original.source}: segment ${i - 1} to ${i}, old ${oldShift} s/mi, ours ${ourShift.toFixed(1)} s/mi`,
      ).toBe(Math.sign(oldShift));
    }
    // Every shift in the old plans is clear enough to compare (the 5K has a single segment).
    expect(compared).toBe(paces.length - 1);
  });
});
