import { bench, describe } from "vitest";
import { buildCourse, buildElevationProfile, smoothElevations } from "../src/index.ts";
import { noDemProvider } from "../test/support/dem.ts";
import { randomTrack } from "../test/support/tracks.ts";

// A marathon with GPS elevation every 5 to 15 m, about 4,200 points once resampled at 10 m.
const course = buildCourse(randomTrack(42, { count: 4220, minStepM: 5, maxStepM: 15, maxTurnDeg: 20, withEle: true }));
const distM = Array.from({ length: 4220 }, (_, i) => i * 10);
const eleM = distM.map((d) => 100 + 20 * Math.sin(d / 700) + ((d * 7919) % 13) / 10);

describe("elevation", () => {
  bench("smoothElevations marathon at 10 m", () => {
    smoothElevations(distM, eleM);
  });

  bench("buildElevationProfile marathon with GPS elevation", async () => {
    await buildElevationProfile(course, { provider: noDemProvider });
  });
});
