import { existsSync, readFileSync } from "node:fs";
import { courseLengthM, parseGpx } from "@pp/core";
import { describe, expect, it } from "vitest";
import catalog from "../src/races/catalog.json";
import {
  DISTANCE_LABELS,
  RACE_SERIES,
  type Race,
  distanceLabel,
  filterRaces,
  groupRaces,
  racePlace,
} from "../src/races/catalog.ts";

const races = catalog as Race[];
const MARATHON_M = 42195;
const HALF_M = 21097.5;
/** As in `scripts/races-add.ts`: how far a course may measure from the race distance. */
const DISTANCE_TOLERANCE = 0.015;

const isTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

describe("race catalog", () => {
  it("has the seed list's races", () => {
    expect(races.length).toBeGreaterThanOrEqual(70);
    expect(races.filter((r) => r.series.includes("world-marathon-majors"))).toHaveLength(8);
  });

  it("has unique, URL-safe slugs", () => {
    const slugs = races.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it.each(races.map((r) => [r.slug, r] as const))("%s has valid facts", (_, race) => {
    expect(race.name.trim()).not.toBe("");
    expect(race.city.trim()).not.toBe("");
    expect(race.region.trim()).not.toBe("");
    // ISO 3166-1 alpha-2, a real region.
    expect(race.country).toMatch(/^[A-Z]{2}$/);
    expect(new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(race.country)).toBeTruthy();
    expect(isTimeZone(race.timezone), race.timezone).toBe(true);
    // Canonical IANA names only: an alias like `US/Eastern` would also pass `isTimeZone`.
    expect(race.timezone).toMatch(/^(Africa|America|Asia|Australia|Europe|Pacific)\/[A-Za-z_]+(\/[A-Za-z_]+)?$/);
    expect(race.startTimeLocal).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    expect(Number.isInteger(race.usualMonth) && race.usualMonth >= 1 && race.usualMonth <= 12).toBe(true);
    expect(DISTANCE_LABELS.has(race.distanceM), `unknown distance ${race.distanceM}`).toBe(true);
    expect(new URL(race.website).protocol).toBe("https:");
    expect(race.series.length).toBeGreaterThan(0);
    for (const s of race.series) expect(RACE_SERIES).toContain(s);
  });

  it.each(races.map((r) => [r.slug, r] as const))("%s is listed under groups that fit it", (_, race) => {
    for (const s of race.series) {
      if (s === "world-marathon-majors") expect(race.distanceM).toBe(MARATHON_M);
      if (s === "us-marathons") expect([race.distanceM, race.country]).toEqual([MARATHON_M, "US"]);
      if (s === "half-marathons") expect(race.distanceM).toBe(HALF_M);
      // As the seed list groups them: 12K races run with the 15Ks, the 7-milers with the 10Ks.
      if (s === "10-mile-to-15k") expect(race.distanceM >= 12000 && race.distanceM <= 16093.4).toBe(true);
      if (s === "10k-and-shorter") expect(race.distanceM).toBeLessThan(12000);
    }
    // A US marathon that is also a Major is listed with the Majors.
    if (race.series.includes("us-marathons") && race.series.includes("world-marathon-majors")) {
      expect(race.series[0]).toBe("world-marathon-majors");
    }
  });

  it.each(races.map((r) => [r.slug, r] as const))("%s says when its facts were checked", (_, race) => {
    if (race.verified === null) {
      // Anything not confirmed on the race's website is named.
      expect(race.unverified?.length).toBeGreaterThan(0);
      for (const key of race.unverified ?? []) expect(Object.keys(race)).toContain(key);
    } else {
      expect(race.verified).toMatch(/^20\d\d-(0[1-9]|1[0-2])$/);
      expect(race.unverified).toBeUndefined();
    }
  });

  it.each(races.map((r) => [r.slug, r] as const))("%s has a course file only where it says so", (_, race) => {
    const file = new URL(`../public/races/${race.slug}.gpx`, import.meta.url);
    if (race.gpx === null) {
      expect(existsSync(file)).toBe(false);
    } else {
      expect(race.gpx).toBe(`/races/${race.slug}.gpx`);
      expect(existsSync(file)).toBe(true);
    }
  });

  // Vacuous until the courses are added with `pnpm races:add`; then it guards each one.
  const withCourse = races.filter((r) => r.gpx !== null);
  it.each(withCourse.map((r) => [r.slug, r] as const))("%s's course parses and measures its distance", (_, race) => {
    const text = readFileSync(new URL(`../public/races/${race.slug}.gpx`, import.meta.url), "utf8");
    const file = parseGpx(text);
    const track = file.tracks[file.defaultTrack]!;
    const off = Math.abs(courseLengthM(track.course) - race.distanceM) / race.distanceM;
    expect(off).toBeLessThanOrEqual(DISTANCE_TOLERANCE);
  });
});

describe("race search and groups", () => {
  const slugs = (list: readonly Race[]) => list.map((r) => r.slug);

  it("finds races by name or city, ignoring case, accents and punctuation", () => {
    expect(slugs(filterRaces(races, "st george", null))).toEqual(["st-george-marathon"]);
    expect(slugs(filterRaces(races, "BAA", null))).toEqual(["baa-10k"]);
    expect(slugs(filterRaces(races, "duluth", null)).sort()).toEqual([
      "garry-bjorklund-half-marathon",
      "grandmas-marathon",
    ]);
    expect(slugs(filterRaces(races, "  philadelphia   half ", null))).toEqual(["philadelphia-half-marathon"]);
    expect(slugs(filterRaces(races, "japan", null))).toEqual(["tokyo-marathon"]);
    expect(filterRaces(races, "zzz", null)).toEqual([]);
  });

  it("filters by group, and searches within it", () => {
    const majors = filterRaces(races, "", "world-marathon-majors");
    expect(majors).toHaveLength(8);
    expect(slugs(filterRaces(races, "boston", "us-marathons"))).toEqual(["boston-marathon"]);
    expect(slugs(filterRaces(races, "boston", "10k-and-shorter")).sort()).toEqual(["baa-10k", "boston-5k"]);
  });

  it("lists each race once, under its first group, by month", () => {
    const groups = groupRaces(races, null);
    expect(groups.map((g) => g.series)).toEqual([...RACE_SERIES]);
    const listed = groups.flatMap((g) => g.races);
    expect(listed).toHaveLength(races.length);
    expect(groups[1]!.races.some((r) => r.slug === "boston-marathon")).toBe(false);
    for (const g of groups) {
      const months = g.races.map((r) => r.usualMonth);
      expect(months).toEqual([...months].sort((a, b) => a - b));
    }
  });

  it("puts everything in the picked group", () => {
    const groups = groupRaces(filterRaces(races, "", "us-marathons"), "us-marathons");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.races.some((r) => r.slug === "boston-marathon")).toBe(true);
  });

  it("shows places and distances the way runners say them", () => {
    const race = (slug: string) => races.find((r) => r.slug === slug)!;
    expect(racePlace(race("boston-marathon"))).toBe("Boston, MA");
    expect(racePlace(race("berlin-marathon"))).toBe("Berlin, Germany");
    expect(distanceLabel(race("cherry-blossom-ten-mile").distanceM)).toBe("10 mi");
    expect(distanceLabel(race("manchester-road-race").distanceM)).toBe("4.737 mi");
    expect(distanceLabel(race("houston-half-marathon").distanceM)).toBe("Half");
  });
});
