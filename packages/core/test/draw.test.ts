import { describe, expect, it } from "vitest";
import {
  type DrawAction,
  type DrawHistory,
  type DrawnRoute,
  EMPTY_ROUTE,
  type LatLon,
  type LegMode,
  MAX_UNDO_STEPS,
  type RouteEdit,
  applyRouteEdit,
  canRedo,
  canUndo,
  createDrawHistory,
  drawReducer,
  haversineM,
  isClosed,
  legKey,
  lineMidpoint,
  polylineLengthM,
  routeLegs,
  stitchLegs,
} from "../src/index.ts";
import { mulberry32 } from "./support/rng.ts";

const A = { lat: 42.44922, lon: -76.48525 };
const B = { lat: 42.45276, lon: -76.49222 };
const C = { lat: 42.4501, lon: -76.4801 };
const D = { lat: 42.4466, lon: -76.4789 };

/** A route through `points`, every leg in `mode`. */
function route(points: LatLon[], mode: LegMode = "snap"): DrawnRoute {
  return points.reduce<DrawnRoute>((r, at) => applyRouteEdit(r, { type: "add", at, mode }), EMPTY_ROUTE);
}

const edit = (r: DrawnRoute, ...edits: RouteEdit[]) => edits.reduce(applyRouteEdit, r);

describe("applyRouteEdit", () => {
  it("adds waypoints, with a leg to each after the first in the given mode", () => {
    const r = edit(EMPTY_ROUTE, { type: "add", at: A, mode: "snap" }, { type: "add", at: B, mode: "straight" });
    expect(r.waypoints).toEqual([A, B]);
    expect(r.modes).toEqual(["straight"]);
    expect(edit(r, { type: "add", at: C, mode: "snap" }).modes).toEqual(["straight", "snap"]);
  });

  it("rounds positions to the routing precision", () => {
    const r = edit(EMPTY_ROUTE, { type: "add", at: { lat: 42.123456789, lon: -76.000004 }, mode: "snap" });
    expect(r.waypoints).toEqual([{ lat: 42.12346, lon: -76 }]);
  });

  it("rejects positions off the globe", () => {
    expect(() => edit(EMPTY_ROUTE, { type: "add", at: { lat: 91, lon: 0 }, mode: "snap" })).toThrow(RangeError);
    expect(() => edit(route([A]), { type: "move", index: 0, to: { lat: 0, lon: Number.NaN } })).toThrow(RangeError);
    expect(() => edit(route([A, B]), { type: "insert", leg: 0, at: { lat: 0, lon: 181 } })).toThrow(RangeError);
  });

  it("moves a waypoint and keeps every mode", () => {
    const r = edit(route([A, B, C]), { type: "setMode", leg: 1, mode: "straight" });
    const moved = edit(r, { type: "move", index: 1, to: D });
    expect(moved.waypoints).toEqual([A, D, C]);
    expect(moved.modes).toEqual(["snap", "straight"]);
  });

  it("inserts a waypoint into a leg, both halves keeping its mode", () => {
    const r = route([A, B, C], "straight");
    const inserted = edit(r, { type: "setMode", leg: 0, mode: "snap" }, { type: "insert", leg: 0, at: D });
    expect(inserted.waypoints).toEqual([A, D, B, C]);
    expect(inserted.modes).toEqual(["snap", "snap", "straight"]);
    expect(edit(r, { type: "insert", leg: 1, at: D }).waypoints).toEqual([A, B, D, C]);
  });

  it("removes the first, an inner and the last waypoint", () => {
    const r: DrawnRoute = { waypoints: [A, B, C, D], modes: ["snap", "straight", "snap"] };
    expect(edit(r, { type: "remove", index: 0 })).toEqual({ waypoints: [B, C, D], modes: ["straight", "snap"] });
    // The joined leg keeps the mode of the leg that arrived at the removed waypoint.
    expect(edit(r, { type: "remove", index: 2 })).toEqual({ waypoints: [A, B, D], modes: ["snap", "straight"] });
    expect(edit(r, { type: "remove", index: 1 })).toEqual({ waypoints: [A, C, D], modes: ["snap", "snap"] });
    expect(edit(r, { type: "remove", index: 3 })).toEqual({ waypoints: [A, B, C], modes: ["snap", "straight"] });
    expect(edit(route([A, B]), { type: "remove", index: 1 })).toEqual({ waypoints: [A], modes: [] });
    expect(edit(route([A]), { type: "remove", index: 0 })).toEqual(EMPTY_ROUTE);
  });

  it("sets one leg's mode", () => {
    expect(edit(route([A, B, C]), { type: "setMode", leg: 1, mode: "straight" }).modes).toEqual(["snap", "straight"]);
  });

  it("closes a loop back to the first waypoint", () => {
    const loop = edit(route([A, B, C]), { type: "closeLoop", mode: "straight" });
    expect(loop.waypoints).toEqual([A, B, C, A]);
    expect(loop.modes).toEqual(["snap", "snap", "straight"]);
    expect(isClosed(loop)).toBe(true);
    expect(isClosed(route([A, B, C]))).toBe(false);
    expect(isClosed(route([A, A]))).toBe(false);
  });

  it("retraces the route for an out and back", () => {
    const r: DrawnRoute = { waypoints: [A, B, C], modes: ["snap", "straight"] };
    const back = edit(r, { type: "outAndBack" });
    expect(back.waypoints).toEqual([A, B, C, B, A]);
    expect(back.modes).toEqual(["snap", "straight", "straight", "snap"]);
    expect(isClosed(back)).toBe(true);
    // Leg i on the way back is leg (n - 1 - i) on the way out, reversed.
    const legs = routeLegs(back);
    expect(legs[3]!.from).toEqual(legs[0]!.to);
    expect(legs[3]!.to).toEqual(legs[0]!.from);
  });

  it("clears the route", () => {
    expect(edit(route([A, B]), { type: "clear" })).toBe(EMPTY_ROUTE);
  });

  it.each<[string, DrawnRoute, RouteEdit]>([
    ["a move out of range", route([A, B]), { type: "move", index: 2, to: C }],
    ["a move to a fractional index", route([A, B]), { type: "move", index: 0.5, to: C }],
    ["a move to the same place", route([A, B]), { type: "move", index: 0, to: { lat: 42.449221, lon: -76.485251 } }],
    ["an insert into a missing leg", route([A, B]), { type: "insert", leg: 1, at: C }],
    ["an insert into a route without legs", route([A]), { type: "insert", leg: 0, at: C }],
    ["a remove out of range", route([A, B]), { type: "remove", index: -1 }],
    ["a mode it already has", route([A, B]), { type: "setMode", leg: 0, mode: "snap" }],
    ["a mode for a missing leg", route([A, B]), { type: "setMode", leg: 3, mode: "straight" }],
    ["closing a single waypoint", route([A]), { type: "closeLoop", mode: "snap" }],
    ["closing a closed loop", route([A, B, A]), { type: "closeLoop", mode: "snap" }],
    ["an out and back of one waypoint", route([A]), { type: "outAndBack" }],
    ["clearing nothing", EMPTY_ROUTE, { type: "clear" }],
  ])("leaves the route as it is for %s", (_, r, e) => {
    expect(applyRouteEdit(r, e)).toBe(r);
  });
});

describe("drawReducer", () => {
  const run = (history: DrawHistory, ...actions: DrawAction[]) => actions.reduce(drawReducer, history);

  it("undoes and redoes edits in order", () => {
    const h = run(
      createDrawHistory(),
      { type: "add", at: A, mode: "snap" },
      { type: "add", at: B, mode: "snap" },
      { type: "move", index: 1, to: C },
    );
    expect(h.present.waypoints).toEqual([A, C]);
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);
    const undone = run(h, { type: "undo" });
    expect(undone.present.waypoints).toEqual([A, B]);
    expect(canRedo(undone)).toBe(true);
    expect(run(undone, { type: "undo" }, { type: "undo" }).present).toBe(EMPTY_ROUTE);
    expect(run(undone, { type: "redo" }).present).toBe(h.present);
  });

  it("drops the redo steps on a new edit", () => {
    const h = run(createDrawHistory(route([A, B])), { type: "add", at: C, mode: "snap" }, { type: "undo" });
    const edited = run(h, { type: "add", at: D, mode: "snap" });
    expect(edited.future).toEqual([]);
    expect(edited.present.waypoints).toEqual([A, B, D]);
  });

  it("returns the same history for no-op edits and for undo or redo with nothing to step to", () => {
    const h = createDrawHistory(route([A, B]));
    expect(run(h, { type: "undo" })).toBe(h);
    expect(run(h, { type: "redo" })).toBe(h);
    expect(run(h, { type: "move", index: 9, to: C })).toBe(h);
  });

  it(`keeps at most ${MAX_UNDO_STEPS} undo steps`, () => {
    let h = createDrawHistory();
    for (let i = 0; i < MAX_UNDO_STEPS + 20; i++) {
      h = drawReducer(h, { type: "add", at: { lat: 42 + i / 1000, lon: -76 }, mode: "snap" });
    }
    expect(h.past).toHaveLength(MAX_UNDO_STEPS);
    while (canUndo(h)) h = drawReducer(h, { type: "undo" });
    expect(h.present.waypoints).toHaveLength(20);
  });

  // Property test: random edit sequences keep the route well formed, and undoing every step
  // replays the routes seen, newest first; redoing them all comes back to the end.
  it.each([1, 2, 3, 4, 5])("keeps the route well formed and the history exact (seed %i)", (seed) => {
    const next = mulberry32(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    const position = (): LatLon => ({ lat: 42.44 + next() * 0.02, lon: -76.5 + next() * 0.03 });
    const randomEdit = (r: DrawnRoute): RouteEdit => {
      const n = r.waypoints.length;
      const index = Math.floor(next() * (n + 1)) - (next() < 0.1 ? 1 : 0);
      const mode = pick<LegMode>(["snap", "straight"]);
      return pick<RouteEdit>([
        { type: "add", at: position(), mode },
        { type: "add", at: position(), mode },
        { type: "move", index, to: position() },
        { type: "insert", leg: index, at: position() },
        { type: "remove", index },
        { type: "setMode", leg: index, mode },
        { type: "closeLoop", mode },
        ...(n < 12 ? [{ type: "outAndBack" } as const] : []),
        ...(next() < 0.1 ? [{ type: "clear" } as const] : []),
      ]);
    };
    let h = createDrawHistory();
    const seen: DrawnRoute[] = [h.present];
    for (let step = 0; step < 60; step++) {
      const before = h;
      h = drawReducer(h, randomEdit(h.present));
      const r = h.present;
      expect(r.modes.length, `seed ${seed} step ${step}`).toBe(Math.max(0, r.waypoints.length - 1));
      expect(routeLegs(r).every((l, i) => l.index === i && l.key === legKey(l.from, l.to, l.mode))).toBe(true);
      if (h !== before) seen.push(r);
    }
    const final = h;
    for (let i = seen.length - 1; i > 0; i--) {
      expect(h.present, `seed ${seed} undo to ${i}`).toBe(seen[i]);
      h = drawReducer(h, { type: "undo" });
    }
    expect(h.present).toBe(seen[0]);
    expect(canUndo(h)).toBe(false);
    while (canRedo(h)) h = drawReducer(h, { type: "redo" });
    expect(h.present).toBe(final.present);
  });
});

describe("routeLegs and legKey", () => {
  it("lists each leg with its ends, mode and key", () => {
    const legs = routeLegs({ waypoints: [A, B, C], modes: ["snap", "straight"] });
    expect(legs).toEqual([
      { index: 0, from: A, to: B, mode: "snap", key: legKey(A, B, "snap") },
      { index: 1, from: B, to: C, mode: "straight", key: legKey(B, C, "straight") },
    ]);
  });

  it("gives different keys for a different mode or direction, the same for the same leg", () => {
    expect(legKey(A, B, "snap")).toBe("snap:42.44922,-76.48525>42.45276,-76.49222");
    expect(legKey(A, B, "snap")).not.toBe(legKey(B, A, "snap"));
    expect(legKey(A, B, "snap")).not.toBe(legKey(A, B, "straight"));
  });

  it("changes only the two neighboring leg keys when a waypoint moves", () => {
    const r = route([A, B, C, D, A]);
    const before = routeLegs(r).map((l) => l.key);
    const after = routeLegs(applyRouteEdit(r, { type: "move", index: 2, to: { lat: 42.451, lon: -76.47 } })).map(
      (l) => l.key,
    );
    expect(after.filter((k, i) => k !== before[i])).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[3]).toBe(before[3]);
  });
});

describe("stitchLegs", () => {
  it("joins legs at their shared waypoint without repeating it", () => {
    expect(
      stitchLegs([
        [A, B],
        [B, C],
        [C, D],
      ]),
    ).toEqual([A, B, C, D]);
  });

  it("joins ends a few centimeters apart, and bridges a real gap", () => {
    const nearB = { lat: B.lat + 0.000001, lon: B.lon };
    expect(
      stitchLegs([
        [A, B],
        [nearB, C],
      ]),
    ).toEqual([A, B, C]);
    expect(
      stitchLegs([
        [A, B],
        [D, C],
      ]),
    ).toEqual([A, B, D, C]);
  });

  it("skips empty legs and copies the points", () => {
    const leg = [{ ...A, ele: 3 } as LatLon, B];
    const out = stitchLegs([[], leg, []]);
    expect(out).toEqual([A, B]);
    expect(out[0]).not.toBe(leg[0]);
    expect(stitchLegs([])).toEqual([]);
  });

  // Property: for legs that meet at their waypoints, the stitched line is as long as the legs
  // together and has one point fewer per join.
  it.each([11, 12, 13])("keeps the total length of legs that meet (seed %i)", (seed) => {
    const next = mulberry32(seed);
    const waypoints = Array.from({ length: 2 + Math.floor(next() * 8) }, () => ({
      lat: 42.44 + next() * 0.02,
      lon: -76.5 + next() * 0.03,
    }));
    const legs = waypoints.slice(1).map((to, i) => {
      const from = waypoints[i]!;
      const bends = Array.from({ length: Math.floor(next() * 5) }, () => ({
        lat: from.lat + (to.lat - from.lat) * next() + (next() - 0.5) * 0.002,
        lon: from.lon + (to.lon - from.lon) * next() + (next() - 0.5) * 0.002,
      }));
      return [from, ...bends, to];
    });
    const stitched = stitchLegs(legs);
    const total = legs.reduce((sum, leg) => sum + polylineLengthM(leg), 0);
    expect(polylineLengthM(stitched), `seed ${seed}`).toBeCloseTo(total, 6);
    expect(stitched).toHaveLength(legs.reduce((sum, leg) => sum + leg.length, 0) - (legs.length - 1));
  });
});

describe("lineMidpoint", () => {
  it("finds the point halfway along the line by length", () => {
    // An L: the first arm is longer than the second, so the midpoint is on the first.
    const corner = { lat: A.lat, lon: B.lon };
    const total = haversineM(A, corner) + haversineM(corner, B);
    const mid = lineMidpoint([A, corner, B])!;
    expect(mid.lat).toBeCloseTo(A.lat, 9);
    // Interpolating degrees is within centimeters of interpolating meters over a leg this short.
    expect(haversineM(A, mid)).toBeCloseTo(total / 2, 1);
  });

  it("handles a straight leg, repeated points, a single point and no points", () => {
    const mid = lineMidpoint([A, A, B])!;
    expect(haversineM(A, mid)).toBeCloseTo(haversineM(mid, B), 1);
    expect(lineMidpoint([A, A])).toEqual(A);
    expect(lineMidpoint([C])).toEqual(C);
    expect(lineMidpoint([])).toBeUndefined();
  });
});
