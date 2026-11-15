import {
  type ElevationProfile,
  type GpxFile,
  METERS_PER_KM,
  METERS_PER_MILE,
  buildCourse,
  computePlan,
  formatDuration,
  parseGpx,
} from "@pp/core";
import { describe, expect, it } from "vitest";
import { courseGpx, courseName, fileSlug, paceBand, planCsv } from "../src/plan/export.ts";
import type { CourseState } from "../src/state/app.ts";

/** About 44 km of rolling road with real-looking hills. */
const points = Array.from({ length: 400 }, (_, i) => ({
  lat: 42 + i * 0.001,
  lon: -71,
  ele: 50 + 30 * Math.sin(i / 20),
}));
const course = buildCourse(points);
const plan = computePlan(course, { goalTimeS: 10_800, paceChanges: 6, unit: "mi" });

/** A CSV split into rows and fields (no quoted line breaks in these). */
function parseCsv(text: string): string[][] {
  return text
    .trimEnd()
    .split("\r\n")
    .map((line) => {
      const fields: string[] = [];
      let field = "";
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (quoted && c === '"' && line[i + 1] === '"') {
          field += '"';
          i++;
        } else if (c === '"') quoted = !quoted;
        else if (c === "," && !quoted) {
          fields.push(field);
          field = "";
        } else field += c;
      }
      fields.push(field);
      return fields;
    });
}

describe("planCsv", () => {
  it("has a row per segment, then a Finish row, with times adding up to the goal", () => {
    const rows = parseCsv(planCsv(plan, "mi"));
    expect(rows[0]).toEqual([
      "Segment",
      "Start (mi)",
      "End (mi)",
      "Distance (mi)",
      "Pace (/mi)",
      "Grade (%)",
      "Time",
      "Elapsed",
      "Note",
    ]);
    expect(rows).toHaveLength(plan.segments.length + 2);
    const body = rows.slice(1, -1);
    const toS = (t: string) => t.split(":").reduce((a, b) => a * 60 + Number(b), 0);
    let elapsed = 0;
    body.forEach((row, i) => {
      const s = plan.segments[i]!;
      expect(row[0]).toBe(String(i + 1));
      expect(Number(row[1])).toBeCloseTo(s.startM / METERS_PER_MILE, 2);
      expect(Number(row[2])).toBeCloseTo(s.endM / METERS_PER_MILE, 2);
      expect(row[8]).toBe(s.reason);
      elapsed += toS(row[6]!);
      expect(toS(row[7]!)).toBe(elapsed);
    });
    expect(elapsed).toBe(10_800);
    expect(rows.at(-1)?.slice(0, 1)).toEqual(["Finish"]);
    expect(rows.at(-1)?.[6]).toBe("3:00:00");
  });

  it("uses kilometers when asked, and quotes fields that need it", () => {
    const km = computePlan(course, { goalTimeS: 10_800, paceChanges: 2, unit: "km" });
    const quirky = { ...km, segments: km.segments.map((s, i) => (i === 0 ? { ...s, reason: 'climb, "steep"' } : s)) };
    const text = planCsv(quirky, "km");
    expect(text).toContain('"climb, ""steep"""');
    const rows = parseCsv(text);
    expect(rows[0]![1]).toBe("Start (km)");
    expect(rows[1]![8]).toBe('climb, "steep"');
    expect(Number(rows.at(-1)![2])).toBeCloseTo(km.lengthM / METERS_PER_KM, 2);
  });
});

describe("paceBand", () => {
  it("has a row per whole mile and the finish, with splits adding up to the goal", () => {
    const rows = paceBand(plan, "mi");
    const miles = plan.lengthM / METERS_PER_MILE;
    expect(rows).toHaveLength(Math.ceil(miles));
    expect(rows.slice(0, -1).map((r) => r.at)).toEqual(rows.slice(0, -1).map((_, i) => i + 1));
    expect(rows.at(-1)).toMatchObject({ finish: true, at: Number(miles.toFixed(2)), elapsedS: 10_800 });
    expect(rows.reduce((a, r) => a + r.splitS, 0)).toBe(10_800);
    rows.forEach((r, i) => i > 0 && expect(r.elapsedS).toBeGreaterThan(rows[i - 1]!.elapsedS));
    // A change is marked wherever the segment the split is mostly in differs from the one before.
    rows.forEach((r, i) => expect(r.change).toBe(i > 0 && r.segment !== rows[i - 1]!.segment));
  });

  it("matches the plan's own times at each marker", () => {
    const rows = paceBand(plan, "km");
    const at = (m: number) => {
      let t = 0;
      for (const s of plan.segments) t += Math.max(0, Math.min(m, s.endM) - s.startM) * s.paceSPerM;
      return t;
    };
    rows.slice(0, -1).forEach((r) => expect(r.elapsedS).toBe(Math.round(at(r.at * 1000))));
    expect(formatDuration(rows.at(-1)!.elapsedS)).toBe("3:00:00");
  });

  it("does not add a marker a meter short of the finish", () => {
    const exact = computePlan(
      buildCourse([
        { lat: 0, lon: 0, ele: 10 },
        { lat: 0, lon: 3000.5 / 111_195, ele: 10 },
      ]),
      {
        goalTimeS: 900,
        paceChanges: 0,
        unit: "km",
      },
    );
    expect(paceBand(exact, "km").map((r) => r.finish)).toEqual([false, false, true]);
  });
});

describe("fileSlug", () => {
  it("makes a plain file name from any title", () => {
    expect(fileSlug("127th Boston Marathon - 42.195 km")).toBe("127th-boston-marathon-42-195-km");
    expect(fileSlug("Café Loop!")).toBe("cafe-loop");
    expect(fileSlug("\u{1f3c3}")).toBe("course");
    expect(fileSlug("a".repeat(100))).toHaveLength(60);
  });
});

describe("courseGpx", () => {
  const file: GpxFile = {
    name: "Lakeside",
    tracks: [{ kind: "track", name: "Lakeside", segmentCount: 1, course, droppedPoints: 0 }],
    defaultTrack: 0,
  };
  const profile = {
    course: buildCourse(points.map((p) => ({ ...p, ele: 200 }))),
  } as ElevationProfile;

  it("writes a loaded track as loaded, with its own elevation", () => {
    const loaded: CourseState = {
      status: "loaded",
      fileName: "lake.gpx",
      file,
      track: 0,
      elevation: { status: "loading" },
    };
    const out = courseGpx(loaded, profile)!;
    expect(out.fileName).toBe("lakeside.gpx");
    const back = parseGpx(out.text);
    expect(back.name).toBe("Lakeside");
    expect(back.tracks[0]!.course.points.map((p) => p.ele)).toEqual(points.map((p) => Number(p.ele.toFixed(2))));
  });

  it("gives a drawn route, and a simplified copy, the profile's terrain elevation", () => {
    const drawn: CourseState = {
      status: "drawn",
      course: buildCourse(points.map(({ lat, lon }) => ({ lat, lon }))),
      elevation: null,
      updating: false,
    };
    const out = courseGpx(drawn, profile)!;
    expect(out.fileName).toBe("drawn-route.gpx");
    expect(parseGpx(out.text).tracks[0]!.course.points.every((p) => p.ele === 200)).toBe(true);
    const copy: CourseState = {
      status: "loaded",
      fileName: "Lakeside",
      file,
      track: 0,
      copy: "link",
      elevation: { status: "loading" },
    };
    expect(parseGpx(courseGpx(copy, profile)!.text).tracks[0]!.course.points.every((p) => p.ele === 200)).toBe(true);
  });

  it("has nothing to write without a course", () => {
    expect(courseGpx({ status: "empty" }, undefined)).toBeUndefined();
    expect(courseGpx({ status: "drawn", course: null, elevation: null, updating: false }, undefined)).toBeUndefined();
    expect(courseName({ status: "drawn", course: null, elevation: null, updating: false })).toBe("Drawn route");
  });
});
