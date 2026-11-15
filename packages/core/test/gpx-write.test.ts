import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type TrackPoint,
  buildCourse,
  courseLengthM,
  createDrawHistory,
  drawReducer,
  escapeXml,
  parseGpx,
  routeLegs,
  stitchLegs,
  writeGpx,
} from "../src/index.ts";
import { mulberry32 } from "./support/rng.ts";
import { randomTrack } from "./support/tracks.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "gpx");

/** Write, parse back, and return the one track. */
function roundTrip(points: readonly TrackPoint[], name?: string) {
  const file = parseGpx(writeGpx(points, name === undefined ? {} : { name }));
  expect(file.tracks).toHaveLength(1);
  return { file, track: file.tracks[0]! };
}

/**
 * Lengths agree to within what rounding coordinates to 7 places can change: each end of a hop
 * moves at most 0.5e-7 degrees in each axis (under 8 mm), so a hop changes by under 16 mm.
 */
function expectSameLength(actual: number, expected: number, hops: number, what: string): void {
  expect(Math.abs(actual - expected), what).toBeLessThanOrEqual(hops * 0.016);
}

function expectSamePoints(actual: readonly TrackPoint[], expected: readonly TrackPoint[], what: string): void {
  expect(actual, what).toHaveLength(expected.length);
  expected.forEach((p, i) => {
    const q = actual[i]!;
    expect(Math.abs(q.lat - p.lat), `${what} point ${i} lat`).toBeLessThanOrEqual(0.5e-7 + 1e-12);
    expect(Math.abs(q.lon - p.lon), `${what} point ${i} lon`).toBeLessThanOrEqual(0.5e-7 + 1e-12);
    if (p.ele === undefined) expect(q.ele, `${what} point ${i} ele`).toBeUndefined();
    else expect(Math.abs(q.ele! - p.ele), `${what} point ${i} ele`).toBeLessThanOrEqual(0.005 + 1e-9);
  });
}

describe("writeGpx", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`round-trips a random track through parseGpx (seed ${seed})`, () => {
      const withEle = seed % 2 === 0;
      const points = randomTrack(seed, { count: 500, minStepM: 2, maxStepM: 80, maxTurnDeg: 45, withEle });
      const { track } = roundTrip(points);
      expectSamePoints(track.course.points, points, `seed ${seed}`);
      expect(track.droppedPoints).toBe(0);
      expectSameLength(courseLengthM(track.course), courseLengthM(buildCourse(points)), points.length, `seed ${seed}`);
    });
  }

  it("round-trips every course in the corpus", () => {
    for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".gpx"))) {
      const source = parseGpx(readFileSync(join(FIXTURES, name), "utf8"));
      const original = source.tracks[source.defaultTrack]!.course.points;
      const { track } = roundTrip(original, name);
      expectSamePoints(track.course.points, original, name);
      expectSameLength(courseLengthM(track.course), courseLengthM({ points: original }), original.length, name);
    }
  });

  it("round-trips a drawn route's stitched course", () => {
    let history = createDrawHistory();
    const next = mulberry32(7);
    for (let i = 0; i < 6; i++) {
      const at = { lat: 42.45 + 0.01 * next(), lon: -76.48 + 0.01 * next() };
      history = drawReducer(history, { type: "add", at, mode: i % 2 ? "snap" : "straight" });
    }
    const line = stitchLegs(routeLegs(history.present).map((leg) => [leg.from, leg.to]));
    const course = buildCourse(line.map((p, i) => ({ ...p, ele: 250 + i * 1.25 })));
    const { track } = roundTrip(course.points, "Drawn route");
    expectSamePoints(track.course.points, course.points, "drawn");
    expectSameLength(courseLengthM(track.course), courseLengthM(course), course.points.length, "drawn");
  });

  it("writes the name as the file's and the track's, escaped", () => {
    const name = `Tom & Jerry's <5K> "loop" été \u{1f3c3}`;
    const { file, track } = roundTrip(
      [
        { lat: 1, lon: 2 },
        { lat: 1.001, lon: 2 },
      ],
      name,
    );
    expect(file.name).toBe(name);
    expect(track.name).toBe(name);
    expect(file.creator).toBe("Perfect Pace");
  });

  it("drops characters XML cannot hold, and leaves out an empty name", () => {
    const points = [
      { lat: 1, lon: 2 },
      { lat: 1.001, lon: 2 },
    ];
    expect(roundTrip(points, "Bad\u0001 name\u0008").file.name).toBe("Bad name");
    const text = writeGpx(points, { name: "  " });
    expect(text).not.toContain("<name>");
    expect(parseGpx(text).name).toBeUndefined();
  });

  it("never writes exponent notation", () => {
    const text = writeGpx([
      { lat: 1e-8, lon: -1e-8, ele: 1e-9 },
      { lat: 0.0000001, lon: 100.12345678, ele: -12.3456 },
    ]);
    expect(text).not.toMatch(/\de-?\d/i);
    expect(text).toContain('lat="0" lon="0"><ele>0</ele>');
    expect(text).toContain('lat="0.0000001" lon="100.1234568"><ele>-12.35</ele>');
  });

  it("rejects an empty track and invalid points", () => {
    expect(() => writeGpx([])).toThrow(RangeError);
    expect(() => writeGpx([{ lat: 91, lon: 0 }])).toThrow(/point 0/);
    expect(() => writeGpx([{ lat: 0, lon: 0, ele: Infinity }])).toThrow(/elevation/);
  });

  it("escapes every XML special character", () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;");
  });
});
