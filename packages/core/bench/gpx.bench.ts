import { bench, describe } from "vitest";
import { parseGpx, simplify } from "../src/index.ts";
import { toGpx } from "../test/support/gpx-dialects.ts";
import { randomTrack } from "../test/support/tracks.ts";

// B1: a 50k-point file parses in well under 1 s. Garmin's activity dialect is the most verbose
// (time and a heart rate extension on every point), about 19 MB of text.
const track = randomTrack(50, { count: 50_000, minStepM: 1, maxStepM: 5, maxTurnDeg: 20, withEle: true });
const garmin = toGpx("garmin", track, { name: "Long run", segments: 3 });
const course = parseGpx(garmin).tracks[0]!.course;

describe("gpx", () => {
  bench("parseGpx 50k-point Garmin activity", () => {
    parseGpx(garmin);
  });

  bench("simplify 50k points at 2 m", () => {
    simplify(course.points, 2);
  });
});
