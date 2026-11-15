import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DrawnRoute,
  type LatLon,
  LEG_MODES,
  type LegMode,
  MAX_SHARE_LENGTH_ERROR,
  MAX_SHARE_URL_LENGTH,
  type SharedPlan,
  type SharedSettings,
  ShareError,
  type ShareErrorCode,
  buildShareLink,
  createDrawHistory,
  decodeShare,
  decodeSharedCourse,
  drawReducer,
  encodeShare,
  encodeSharedCourse,
  isShareFragment,
  parseGpx,
  polylineLengthM,
  roundCoordinate,
  simplifyForShare,
} from "../src/index.ts";
import { mulberry32 } from "./support/rng.ts";
import { randomTrack } from "./support/tracks.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "gpx");
const BASE = "https://perfect-pace.example.workers.dev/";

const SETTINGS: SharedSettings = { goalTimeS: 10_800, paceChanges: 6, minSegmentM: 402.336, unit: "mi" };

/** A random drawn route of `count` waypoints, built through the drawing reducer as the app does. */
function randomRoute(seed: number, count: number): DrawnRoute {
  const next = mulberry32(seed);
  let lat = -60 + 120 * next();
  let lon = -179 + 358 * next();
  let history = createDrawHistory();
  for (let i = 0; i < count; i++) {
    lat = Math.max(-89, Math.min(89, lat + (next() - 0.5) * 0.02));
    lon = Math.max(-180, Math.min(180, lon + (next() - 0.5) * 0.02));
    history = drawReducer(history, { type: "add", at: { lat, lon }, mode: LEG_MODES[next() < 0.3 ? 1 : 0]! });
  }
  return history.present;
}

function shareError(fragment: string): ShareError {
  try {
    decodeShare(fragment);
  } catch (error) {
    if (error instanceof ShareError) return error;
    throw error;
  }
  throw new Error(`decoded ${fragment}`);
}

const expectRefused = (fragment: string, code: ShareErrorCode) => expect(shareError(fragment).code).toBe(code);

/** Distance in meters from `p` to the line through `line`, in a local flat projection around `p`. */
function distanceToLine(p: LatLon, line: readonly LatLon[]): number {
  const kx = Math.cos((p.lat * Math.PI) / 180) * 111_195;
  const xy = (q: LatLon) => [(q.lon - p.lon) * kx, (q.lat - p.lat) * 111_195] as const;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = xy(line[i - 1]!);
    const [bx, by] = xy(line[i]!);
    const dx = bx - ax;
    const dy = by - ay;
    const t = dx || dy ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

describe("share links: drawn routes", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`round-trips the waypoints and leg modes exactly (seed ${seed})`, () => {
      const route = randomRoute(seed, 2 + Math.floor(mulberry32(seed)() * 60));
      const plan: SharedPlan = { course: { kind: "drawn", route }, settings: SETTINGS };
      expect(decodeShare(encodeShare(plan)), `seed ${seed}`).toEqual(plan);
    });
  }

  it("keeps runs of leg modes, from one leg to many", () => {
    const waypoints = Array.from({ length: 31 }, (_, i) => ({ lat: 42 + i * 0.001, lon: -76 }));
    const run = (n: number, mode: LegMode): LegMode[] => Array.from({ length: n }, () => mode);
    const cases: DrawnRoute["modes"][] = [
      run(30, "snap"),
      run(30, "straight"),
      Array.from({ length: 30 }, (_, i) => (i % 2 ? "snap" : "straight")),
      [...run(12, "snap"), "straight", ...run(17, "snap")],
    ];
    for (const modes of cases) {
      const route = { waypoints, modes };
      expect(decodeSharedCourse(encodeSharedCourse({ kind: "drawn", route }))).toEqual({ kind: "drawn", route });
    }
    expect(encodeSharedCourse({ kind: "drawn", route: { waypoints, modes: cases[3]! } })).toMatch(/^d\.12ps17p\./);
    const two = { waypoints: waypoints.slice(0, 2), modes: ["straight" as const] };
    expect(decodeSharedCourse(encodeSharedCourse({ kind: "drawn", route: two }))).toEqual({
      kind: "drawn",
      route: two,
    });
  });

  it("keeps routes at the edges of the map", () => {
    const route: DrawnRoute = {
      waypoints: [
        { lat: 89.99999, lon: 179.99999 },
        { lat: 89.99999, lon: -179.99999 },
        { lat: -89.99999, lon: -0.00001 },
      ],
      modes: ["straight", "straight"],
    };
    expect(decodeShare(encodeShare({ course: { kind: "drawn", route }, settings: SETTINGS })).course).toEqual({
      kind: "drawn",
      route,
    });
  });

  it("keeps every setting, including a suggested goal, no minimum and kilometers", () => {
    const route = randomRoute(3, 4);
    for (const settings of [
      SETTINGS,
      { goalTimeS: null, paceChanges: 0, minSegmentM: 0, unit: "km" as const },
      { goalTimeS: 1, paceChanges: 10, minSegmentM: 1609.344, unit: "mi" as const },
      { goalTimeS: 7 * 24 * 3600, paceChanges: 4, minSegmentM: 2000, unit: "km" as const },
    ]) {
      expect(decodeShare(encodeShare({ course: { kind: "drawn", route }, settings })).settings).toEqual(settings);
    }
  });

  it("keeps the name, with any characters, and drops an empty one", () => {
    const route = randomRoute(4, 3);
    const name = "Tom & Jerry's #1 = 5K? 100% été \u{1f3c3}";
    const fragment = encodeShare({ course: { kind: "drawn", route }, settings: SETTINGS, name });
    expect(fragment).toMatch(/^[A-Za-z0-9_.=&%~*'()!-]+$/);
    expect(decodeShare(fragment).name).toBe(name);
    expect(decodeShare(`#${fragment}`).name).toBe(name);
    expect(
      decodeShare(encodeShare({ course: { kind: "drawn", route }, settings: SETTINGS, name: " " })),
    ).not.toHaveProperty("name");
    const long = decodeShare(
      encodeShare({ course: { kind: "drawn", route }, settings: SETTINGS, name: "x".repeat(300) }),
    );
    expect(long.name).toHaveLength(80);
  });

  it("builds a link only while it fits, and says so when it does not", () => {
    const small = buildShareLink(`${BASE}#old`, {
      course: { kind: "drawn", route: randomRoute(5, 50) },
      settings: SETTINGS,
    });
    expect(small?.url.startsWith(`${BASE}#v=1&c=d.`)).toBe(true);
    expect(small?.track).toBeUndefined();
    expect(decodeShare(new URL(small!.url).hash).course.kind).toBe("drawn");
    const huge = randomRoute(6, 3000);
    expect(buildShareLink(BASE, { course: { kind: "drawn", route: huge }, settings: SETTINGS })).toBeUndefined();
  });
});

describe("share links: uploaded courses", () => {
  const corpus = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".gpx"))
    .map((f) => {
      const file = parseGpx(readFileSync(join(FIXTURES, f), "utf8"));
      return { name: f, points: file.tracks[file.defaultTrack]!.course.points };
    });

  it("carries every corpus course within the stated distance bound and the line tolerance", () => {
    for (const { name, points } of corpus) {
      const link = buildShareLink(BASE, { course: { kind: "track", points }, settings: SETTINGS, name });
      expect(link, name).toBeDefined();
      expect(link!.url.length, name).toBeLessThanOrEqual(MAX_SHARE_URL_LENGTH);
      const decoded = decodeShare(new URL(link!.url).hash);
      expect(decoded.settings).toEqual(SETTINGS);
      expect(decoded.name).toBe(name);
      expect(decoded.course).toEqual({ kind: "track", points: link!.track!.points });
      const carried = link!.track!.points;
      const error = Math.abs(polylineLengthM(carried) - polylineLengthM(points)) / polylineLengthM(points);
      expect(error, name).toBeLessThanOrEqual(MAX_SHARE_LENGTH_ERROR);
      expect(link!.track!.lengthError).toBeCloseTo(error, 9);
      expect(carried[0], name).toEqual({ lat: roundCoordinate(points[0]!.lat), lon: roundCoordinate(points[0]!.lon) });
      // Every original point stays within the tolerance, plus the rounding to 5 places (under 1 m).
      for (const p of points.filter((_, i) => i % 7 === 0)) {
        expect(distanceToLine(p, carried), name).toBeLessThanOrEqual(link!.track!.toleranceM + 1);
      }
    }
  });

  for (const seed of [21, 22, 23]) {
    it(`simplifies a long, detailed track only as far as it must (seed ${seed})`, () => {
      const points = randomTrack(seed, { count: 8000, minStepM: 2, maxStepM: 6, maxTurnDeg: 4 });
      const roomy = simplifyForShare(points, 1_000_000)!;
      const tight = simplifyForShare(points, 1200)!;
      expect(roomy.toleranceM).toBe(1);
      expect(tight.toleranceM).toBeGreaterThan(roomy.toleranceM);
      expect(tight.points.length).toBeLessThan(roomy.points.length);
      expect(encodeSharedCourse({ kind: "track", points: tight.points }).length).toBeLessThanOrEqual(1200);
      expect(tight.lengthError).toBeLessThanOrEqual(MAX_SHARE_LENGTH_ERROR);
    });
  }

  it("gives up on a track that cannot fit within the distance bound", () => {
    // A long zigzag: simplifying it enough to fit would cut its length by far more than 0.5%.
    const points = randomTrack(31, { count: 60_000, minStepM: 5, maxStepM: 15, maxTurnDeg: 120 });
    expect(simplifyForShare(points, MAX_SHARE_URL_LENGTH)).toBeUndefined();
    expect(buildShareLink(BASE, { course: { kind: "track", points }, settings: SETTINGS })).toBeUndefined();
  });

  it("refuses a track without two distinct points", () => {
    expect(() => decodeSharedCourse(encodeSharedCourse({ kind: "track", points: [{ lat: 1, lon: 1 }] }))).toThrow(
      ShareError,
    );
    const same = [
      { lat: 1, lon: 1 },
      { lat: 1, lon: 1 },
    ];
    expect(() => decodeSharedCourse(encodeSharedCourse({ kind: "track", points: same }))).toThrow(/damaged/);
  });
});

describe("share links: links that cannot be opened", () => {
  const good = encodeShare({ course: { kind: "drawn", route: randomRoute(8, 6) }, settings: SETTINGS });
  const replace = (field: string, value: string | null) =>
    good
      .split("&")
      .map((part) => (part.startsWith(`${field}=`) ? (value === null ? "" : `${field}=${value}`) : part))
      .filter(Boolean)
      .join("&");

  it("tells a newer version from one no longer supported", () => {
    const newer = shareError(replace("v", "2"));
    expect(newer.code).toBe("newer");
    expect(newer.message).toMatch(/newer version of Perfect Pace\. Reload the page/);
    for (const v of ["0", "abc", "1.5", "-1", ""]) {
      const old = shareError(replace("v", v));
      expect(old.code, `v=${v}`).toBe("unsupported");
      expect(old.message).toMatch(/no longer supported/);
    }
  });

  it("refuses missing or unreadable fields with the damaged-link message", () => {
    for (const fragment of [
      "",
      "c=t.abc",
      replace("c", null),
      replace("c", "x.abc"),
      replace("c", "d.p.@@@"),
      replace("c", "d.9p.AAAA"),
      replace("c", "d.q5.AAAA"),
      replace("k", null),
      replace("k", "11"),
      replace("k", "2.5"),
      replace("g", "0"),
      replace("g", `${7 * 24 * 3600 + 1}`),
      replace("g", "1e4"),
      replace("s", "-1"),
      replace("s", "abc"),
      replace("s", null),
      replace("u", "ft"),
      replace("u", null),
      `${good}&n=%E0%A4%A`,
    ]) {
      const error = shareError(fragment);
      expect(error.code, fragment).toBe("corrupt");
      expect(error.message).toMatch(/incomplete or damaged/);
      expect(error.detail.length).toBeGreaterThan(0);
    }
  });

  it("refuses positions off the globe", () => {
    // The encoder writes any finite number; the decoder must not take it back.
    for (const far of [
      { lat: 95, lon: 0 },
      { lat: 0, lon: -181 },
    ]) {
      const course = encodeSharedCourse({ kind: "track", points: [{ lat: 0, lon: 0 }, far] });
      expectRefused(replace("c", course), "corrupt");
    }
  });

  for (const seed of [41, 42, 43, 44]) {
    it(`fails only with a ShareError on a cut off or mangled link (seed ${seed})`, () => {
      const next = mulberry32(seed);
      const alphabet = "ABCabc019-_.&=%~#";
      for (let i = 0; i < 300; i++) {
        let fragment = good.slice(0, Math.floor(next() * good.length));
        if (next() < 0.5) {
          const at = Math.floor(next() * good.length);
          fragment = good.slice(0, at) + alphabet[Math.floor(next() * alphabet.length)] + good.slice(at + 1);
        }
        try {
          decodeShare(fragment);
        } catch (error) {
          expect(error, `seed ${seed}: ${fragment}`).toBeInstanceOf(ShareError);
        }
      }
    });
  }

  it("knows a share fragment from any other", () => {
    expect(isShareFragment(`#${good}`)).toBe(true);
    expect(isShareFragment("#v=9")).toBe(true);
    expect(isShareFragment("")).toBe(false);
    expect(isShareFragment("#section-2")).toBe(false);
  });
});
