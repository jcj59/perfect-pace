import type { TrackPoint } from "../../src/index.ts";
import { mulberry32 } from "./rng.ts";

export interface RandomTrackOptions {
  /** Number of points. */
  count: number;
  /** Step length between points is uniform in `[minStepM, maxStepM)`. */
  minStepM: number;
  maxStepM: number;
  /** Heading changes by up to this many degrees either way per step. */
  maxTurnDeg: number;
  /** Probability that a point repeats the previous one (duplicate GPS fixes). */
  duplicateChance?: number;
  /** Give every point an elevation (a random walk around 100 m). */
  withEle?: boolean;
}

/**
 * A seeded random walk that looks like a running track: bounded step lengths and turns,
 * anywhere on Earth between 60 S and 60 N (so it can cross the antimeridian), optionally with
 * duplicate points and elevations.
 */
export function randomTrack(seed: number, opts: RandomTrackOptions): TrackPoint[] {
  const next = mulberry32(seed);
  let lat = -60 + 120 * next();
  let lon = -180 + 360 * next();
  let heading = 360 * next();
  let ele = 100;
  const track: TrackPoint[] = [];
  for (let i = 0; i < opts.count; i++) {
    const p: TrackPoint = { lat, lon };
    if (opts.withEle) p.ele = ele;
    track.push(p);
    if (next() < (opts.duplicateChance ?? 0)) continue;
    const step = opts.minStepM + (opts.maxStepM - opts.minStepM) * next();
    heading += (2 * next() - 1) * opts.maxTurnDeg;
    const rad = (heading * Math.PI) / 180;
    lat += (step * Math.cos(rad)) / 111_195;
    lon += (step * Math.sin(rad)) / (111_195 * Math.cos((lat * Math.PI) / 180));
    if (lon > 180) lon -= 360;
    else if (lon < -180) lon += 360;
    ele += (2 * next() - 1) * 2;
  }
  return track;
}
