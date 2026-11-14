import {
  type Course,
  type ElevationProfile,
  type LatLon,
  type RouteLeg,
  type RouteRequest,
  type RoutingProvider,
  RoutingError,
  courseLengthM,
  polylineLengthM,
} from "@pp/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppState, initialAppState } from "../src/state/app.ts";
import { type DrawController, type DrawState, createDrawController, initialDrawState } from "../src/state/draw.ts";
import { createStore } from "../src/state/store.ts";

const A = { lat: 42.44922, lon: -76.48525 };
const B = { lat: 42.45276, lon: -76.49222 };
const C = { lat: 42.4501, lon: -76.4801 };
const D = { lat: 42.4466, lon: -76.4789 };

interface Call {
  request: RouteRequest;
  signal: AbortSignal;
  resolve: (leg: RouteLeg) => void;
  reject: (error: unknown) => void;
}

/** A routed leg with a bend, so it is longer than the straight line. */
const bent = (from: LatLon, to: LatLon): RouteLeg => {
  const points = [from, { lat: from.lat, lon: to.lon }, to];
  return { points, distanceM: polylineLengthM(points) };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the drawing controller", () => {
  let store: ReturnType<typeof createStore<AppState>>;
  let draws: ReturnType<typeof createStore<DrawState>>;
  let calls: Call[];
  let profiles: { course: Course; signal: AbortSignal; resolve: (p: ElevationProfile) => void }[];
  let controller: DrawController;
  let locate: () => Promise<LatLon>;

  /** Answer every routing call still open with a bent leg. */
  async function routeAll(): Promise<void> {
    for (const call of calls.splice(0)) call.resolve(bent(call.request.from, call.request.to));
    await flush();
  }

  beforeEach(() => {
    store = createStore(initialAppState(undefined, "en-US"));
    draws = createStore(initialDrawState());
    calls = [];
    profiles = [];
    locate = () => Promise.resolve(C);
    const routing: RoutingProvider = {
      route: (request, options) =>
        new Promise((resolve, reject) => {
          const signal = options!.signal as AbortSignal;
          calls.push({ request, signal, resolve, reject });
        }),
    };
    controller = createDrawController({
      store,
      draws,
      routing,
      elevation: (course, { signal }) => new Promise((resolve) => profiles.push({ course, signal: signal!, resolve })),
      locate: () => locate(),
    });
  });
  afterEach(() => controller.dispose());

  const add = (at: LatLon) => controller.dispatch({ type: "add", at, mode: draws.get().newLegMode });

  it("starts a fresh drawing at the user's location when there was no course", async () => {
    store.set({ goalTimeS: 3600, sheet: "half" });
    controller.start();
    expect(draws.get().editing).toBe(true);
    expect(store.get().course).toEqual({ status: "drawn", course: null, elevation: null, updating: false });
    expect(store.get().goalTimeS).toBeNull();
    expect(store.get().sheet).toBe("peek");
    await flush();
    expect(draws.get().camera).toMatchObject({ center: C, zoom: 15 });
  });

  it("does not move the map when the location comes after the first point, or is refused", async () => {
    let answer!: (p: LatLon) => void;
    locate = () => new Promise((resolve) => (answer = resolve));
    controller.start();
    add(A);
    answer(C);
    await flush();
    expect(draws.get().camera).toBeNull();
    controller.dispose();

    locate = () => Promise.reject(new Error("denied"));
    controller.start();
    await flush();
    expect(draws.get().camera).toBeNull();
  });

  it("routes each new leg once, and builds the course and its DEM profile when every leg is in", async () => {
    controller.start();
    add(A);
    add(B);
    add(C);
    expect(calls.map((c) => [c.request.from, c.request.to])).toEqual([
      [A, B],
      [B, C],
    ]);
    expect(draws.get().legs.map((l) => l.status)).toEqual(["pending", "pending"]);
    expect(draws.get().distanceM).toBe(0);
    await routeAll();
    const { legs, distanceM } = draws.get();
    expect(legs.map((l) => l.status)).toEqual(["ready", "ready"]);
    expect(distanceM).toBeCloseTo(bent(A, B).distanceM + bent(B, C).distanceM, 6);
    expect(profiles).toHaveLength(1);
    const course = store.get().course;
    expect(course.status === "drawn" && course.course && courseLengthM(course.course)).toBeCloseTo(distanceM, 6);
    expect(course).toMatchObject({ elevation: { status: "loading" }, updating: true });
    const profile = { course: profiles[0]!.course } as ElevationProfile;
    profiles[0]!.resolve(profile);
    await flush();
    expect(store.get().course).toMatchObject({ elevation: { status: "ready", profile }, updating: false });
  });

  it("moving a waypoint re-routes its two legs; undo and redo route nothing", async () => {
    controller.start();
    for (const p of [A, B, C, D]) add(p);
    await routeAll();
    profiles[0]!.resolve({} as ElevationProfile);
    await flush();
    const moved = { lat: 42.451, lon: -76.47 };
    controller.dispatch({ type: "move", index: 1, to: moved });
    expect(calls.map((c) => [c.request.from, c.request.to])).toEqual([
      [A, moved],
      [moved, C],
    ]);
    // The last profile stays up, marked as updating, while the move is routed.
    expect(store.get().course).toMatchObject({ elevation: { status: "ready" }, updating: true });
    await routeAll();
    controller.dispatch({ type: "undo" });
    controller.dispatch({ type: "redo" });
    controller.dispatch({ type: "undo" });
    expect(calls).toHaveLength(0);
    expect(draws.get().legs.every((l) => l.status === "ready")).toBe(true);
  });

  it("aborts requests for legs the route no longer has", async () => {
    controller.start();
    add(A);
    add(B);
    const first = calls[0]!;
    controller.dispatch({ type: "move", index: 1, to: C });
    expect(first.signal.aborted).toBe(true);
    // A late answer for the aborted leg is ignored.
    first.resolve(bent(A, B));
    await flush();
    expect(draws.get().legs[0]).toMatchObject({ status: "pending", to: C });
    await routeAll();
    expect(draws.get().legs[0]).toMatchObject({ status: "ready", to: C });
  });

  it("reuses the routed line backwards for an out and back, and needs no routing for straight legs", async () => {
    controller.start();
    add(A);
    add(B);
    await routeAll();
    controller.dispatch({ type: "outAndBack" });
    expect(calls).toHaveLength(0);
    const [out, back] = draws.get().legs;
    expect(back!.points).toEqual([...out!.points].reverse());
    controller.setNewLegMode("straight");
    add(C);
    expect(calls).toHaveLength(0);
    expect(draws.get().legs[2]).toMatchObject({ status: "ready", mode: "straight", points: [A, C] });
  });

  it("keeps a failed leg's error, offers a retry, and builds no course until it is fixed", async () => {
    controller.start();
    add(A);
    add(B);
    add(C);
    calls[1]!.reject(new RoutingError("no_route", "server words"));
    calls[0]!.resolve(bent(A, B));
    calls.length = 0;
    await flush();
    const failed = draws.get().legs[1]!;
    expect(failed).toMatchObject({ status: "error", error: { code: "no_route" } });
    expect(failed.error!.message).toMatch(/No path/);
    expect(profiles).toHaveLength(0);
    controller.retryLeg(1);
    expect(calls.map((c) => [c.request.from, c.request.to])).toEqual([[B, C]]);
    expect(draws.get().legs[1]!.status).toBe("pending");
    calls[0]!.reject(new TypeError("offline"));
    calls.length = 0;
    await flush();
    expect(draws.get().legs[1]).toMatchObject({ status: "error", error: { code: "network" } });
    // The straight-line fallback is an ordinary, undoable edit.
    controller.dispatch({ type: "setMode", leg: 1, mode: "straight" });
    expect(draws.get().legs[1]).toMatchObject({ status: "ready", mode: "straight" });
    expect(profiles).toHaveLength(1);
  });

  it("finish leaves drawing mode, or drops a route without a leg; edit goes back in", async () => {
    controller.start();
    add(A);
    controller.finish();
    expect(store.get().course).toEqual({ status: "empty" });
    expect(draws.get().editing).toBe(false);

    controller.start();
    add(A);
    add(B);
    await routeAll();
    controller.finish();
    expect(draws.get().editing).toBe(false);
    expect(store.get().sheet).toBe("half");
    expect(store.get().course.status).toBe("drawn");
    controller.edit();
    expect(draws.get().editing).toBe(true);
    expect(store.get().sheet).toBe("peek");
  });

  it("stops drawing and aborts what is in flight when a file replaces the drawn course", () => {
    controller.start();
    add(A);
    add(B);
    const pending = calls[0]!;
    store.set({ course: { status: "reading", fileName: "a.gpx" } });
    expect(pending.signal.aborted).toBe(true);
    expect(draws.get()).toMatchObject({ editing: false, legs: [] });
    expect(draws.get().history.present.waypoints).toEqual([]);
  });

  it("retries a failed elevation profile", async () => {
    controller.dispose();
    controller = createDrawController({
      store,
      draws,
      routing: { route: (r) => Promise.resolve(bent(r.from, r.to)) },
      elevation: () => Promise.reject(new Error("tile fetch failed")),
      locate: () => Promise.reject(new Error("no")),
    });
    controller.start();
    add(A);
    add(B);
    await flush();
    await flush();
    expect(store.get().course).toMatchObject({ elevation: { status: "error" }, updating: false });
    controller.retryElevation();
    expect(store.get().course).toMatchObject({ elevation: { status: "loading" }, updating: true });
  });
});
