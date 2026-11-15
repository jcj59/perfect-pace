/**
 * Drawing a course on the map. The route itself (waypoints plus leg modes, with undo and redo) is
 * the pure `drawReducer` from `@pp/core`; this module turns it into legs on the map and a course
 * in the app store:
 *
 * - **Incremental routing.** Each leg's geometry is cached by its `legKey` (mode plus both ends),
 *   so an edit asks the router only for legs whose ends changed: moving a waypoint re-routes its
 *   two neighboring legs, and undo or redo finds its legs already cached. A leg back along one
 *   already routed (an out and back) reuses that line reversed. Requests for legs the route no
 *   longer has are aborted.
 * - **Failures are per leg and non-blocking.** A leg the router could not route keeps its error,
 *   so the panel can offer a straight line instead (an ordinary, undoable mode change) or a retry.
 *   Drawing carries on meanwhile.
 * - **The course.** Once every leg has its line, they are stitched into a course whose elevation
 *   profile comes from the DEM (drawn routes always use it), which feeds the same chart, stats and
 *   plan as an uploaded file. While the next one is on its way, the last profile stays up.
 */
import {
  type Course,
  type DrawAction,
  type ElevationProfile,
  type LatLon,
  type LegMode,
  type RouteLeg,
  type RouteOptions,
  type RouteRequest,
  type RoutingErrorCode,
  type RoutingProvider,
  RoutingError,
  buildCourse,
  createDrawHistory,
  drawReducer,
  type DrawHistory,
  type DrawnRoute,
  legKey,
  polylineLengthM,
  routeLegs,
  stitchLegs,
  httpRoutingProvider,
} from "@pp/core";
import { coreClient } from "../worker/client.ts";
import type { CallOptions } from "../worker/rpc.ts";
import { type AppState, type CourseState, type SheetSnap, appStore } from "./app.ts";
import { elevationErrorMessage } from "./course.ts";
import { type Store, createStore, useStore } from "./store.ts";

/** Where a leg stands: its line is `ready`, on its way (`pending`), or could not be routed (`error`). */
export type LegStatus = "pending" | "ready" | "error";

/** A leg of the route being drawn, as the map and the panel show it. */
export interface LegView {
  index: number;
  key: string;
  from: LatLon;
  to: LatLon;
  mode: LegMode;
  status: LegStatus;
  /** The leg's line once `ready`; until then (or after an error) the straight line between its ends. */
  points: readonly LatLon[];
  /** The length of `points` in meters once `ready`, else 0. */
  distanceM: number;
  /** Why the router could not route it, when `status` is `error`. */
  error?: { code: RoutingErrorCode; message: string };
}

/** Where to move the camera (a new `id` each time), for example to start drawing near the user. */
export interface CameraRequest {
  id: number;
  center: LatLon;
  zoom: number;
}

export interface DrawState {
  /** Whether the map is in drawing mode: clicks add waypoints, and the drawing controls show. */
  editing: boolean;
  history: DrawHistory;
  /** The mode new legs get (the toolbar's "Paths" or "Straight"). */
  newLegMode: LegMode;
  /** The legs of `history.present`, in order. */
  legs: readonly LegView[];
  /** The length of the legs that are ready, meters. */
  distanceM: number;
  camera: CameraRequest | null;
}

/** The zoom drawing starts at when it finds the user's location. */
export const LOCATE_ZOOM = 15;
/** How long to wait for the user's location before drawing where the map already is. */
const LOCATE_TIMEOUT_MS = 8000;
/** Leg lines kept in the cache beyond the ones the route uses (for undo and redo). */
const CACHE_LIMIT = 400;

type CacheEntry =
  | { status: "pending"; controller: AbortController }
  | { status: "ready"; points: readonly LatLon[] }
  | { status: "error"; code: RoutingErrorCode; message: string };

/** What the panel says for each routing failure. The server's own message is for the logs. */
export const ROUTING_MESSAGES: Record<RoutingErrorCode, string> = {
  invalid_request: "These points are too far apart to follow paths between.",
  rate_limited: "Too many routes at once. Wait a minute, then try again.",
  no_route: "No path for walking or running joins these points.",
  upstream_rate_limited: "The routing service is busy. Try again in a minute.",
  upstream_unavailable: "The routing service did not answer. Try again in a moment.",
  not_configured: "Following paths is not set up on this server.",
  network: "The routing service could not be reached. Check your connection.",
};

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export interface DrawControllerOptions {
  store?: Store<AppState>;
  draws?: Store<DrawState>;
  /** Routes snapped legs. Default: the Worker's `/api/route`. */
  routing?: RoutingProvider;
  /** Builds a drawn course's elevation profile. Default: the core worker, with the DEM. */
  elevation?: (course: Course, options: CallOptions) => Promise<ElevationProfile>;
  /** Finds the user's position for where to start drawing, or rejects. Default: the Geolocation API. */
  locate?: () => Promise<LatLon>;
}

export function initialDrawState(): DrawState {
  return { editing: false, history: createDrawHistory(), newLegMode: "snap", legs: [], distanceM: 0, camera: null };
}

function browserLocate(): Promise<LatLon> {
  return new Promise((resolve, reject) => {
    const geolocation = globalThis.navigator?.geolocation;
    if (!geolocation) {
      reject(new Error("no geolocation"));
      return;
    }
    geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      reject,
      { timeout: LOCATE_TIMEOUT_MS, maximumAge: 10 * 60 * 1000 },
    );
  });
}

type Drawn = Extract<CourseState, { status: "drawn" }>;

/** The drawing controller: the actions the UI calls, over a draw store and the app store. */
export interface DrawController {
  /** Start a new drawing (replacing any course), near the user when there was no course on the map. */
  start: () => void;
  /** Apply an edit, or undo or redo. */
  dispatch: (action: DrawAction) => void;
  setNewLegMode: (mode: LegMode) => void;
  /** Leave drawing mode. A route of fewer than two waypoints is dropped, back to the empty state. */
  finish: () => void;
  /** Back into drawing mode for the drawn course. */
  edit: () => void;
  /**
   * Show a finished route (from a share link or the saved session) as the course, replacing any
   * other, and route its legs. Its history starts there, with nothing to undo. If a leg cannot be
   * routed, drawing mode opens so its error and the straight-line offer show.
   */
  load: (route: DrawnRoute) => void;
  /** Ask the router again for a leg that failed. */
  retryLeg: (index: number) => void;
  /** Build the elevation profile again after it failed. */
  retryElevation: () => void;
  /** Stop listening to the app store and abort everything in flight. */
  dispose: () => void;
}

export function createDrawController(options: DrawControllerOptions = {}): DrawController {
  const store = options.store ?? appStore;
  const draws = options.draws ?? createStore(initialDrawState());
  const routing = options.routing ?? httpRoutingProvider();
  const elevation =
    options.elevation ?? ((course, opts) => coreClient().call("elevation", { course, origin: "drawn" }, opts));
  const locate = options.locate ?? browserLocate;
  const cache = new Map<string, CacheEntry>();
  let elevationRequest: AbortController | undefined;
  /** The stitched course the last elevation request was for, so an unchanged route is not rebuilt. */
  let builtFrom: string | undefined;
  let cameraId = 0;
  let locating = 0;

  // As `setCourse` and `setSheet` in app.ts, on this controller's store.
  const setCourse = (course: CourseState, fresh = false) =>
    store.set({
      course,
      focusDistM: null,
      selectedSegment: null,
      ...(fresh ? { goalTimeS: null, linkError: null } : {}),
    });
  const setSheet = (sheet: SheetSnap) => store.set({ sheet });

  const drawn = (): Drawn | undefined => {
    const course = store.get().course;
    return course.status === "drawn" ? course : undefined;
  };

  function request(key: string, req: RouteRequest): CacheEntry {
    const controller = new AbortController();
    const entry: CacheEntry = { status: "pending", controller };
    const routeOptions: RouteOptions = { signal: controller.signal };
    routing.route(req, routeOptions).then(
      (leg: RouteLeg) => {
        if (controller.signal.aborted || cache.get(key) !== entry) return;
        cache.set(key, { status: "ready", points: leg.points });
        sync();
      },
      (error: unknown) => {
        if (controller.signal.aborted || cache.get(key) !== entry || isAbort(error)) return;
        const code: RoutingErrorCode = error instanceof RoutingError ? error.code : "network";
        if (!(error instanceof RoutingError)) console.error("Routing failed", error);
        cache.set(key, { status: "error", code, message: ROUTING_MESSAGES[code] });
        sync();
      },
    );
    return entry;
  }

  /** The cache entry for a snapped leg, reusing the reverse leg's line or starting a request. */
  function snapped(key: string, from: LatLon, to: LatLon): CacheEntry {
    const cached = cache.get(key);
    if (cached) return cached;
    const reverse = cache.get(legKey(to, from, "snap"));
    const entry: CacheEntry =
      reverse?.status === "ready"
        ? { status: "ready", points: [...reverse.points].reverse() }
        : request(key, { from, to });
    cache.set(key, entry);
    return entry;
  }

  function trimCache(needed: Set<string>): void {
    for (const [key, entry] of cache) {
      if (needed.has(key)) continue;
      if (entry.status === "pending") {
        entry.controller.abort();
        cache.delete(key);
      }
    }
    // Oldest first: a Map iterates in insertion order.
    for (const key of cache.keys()) {
      if (cache.size <= CACHE_LIMIT + needed.size) break;
      if (!needed.has(key)) cache.delete(key);
    }
  }

  /** Bring the legs, the distance and the course in line with the route now. */
  function sync(): void {
    const { present } = draws.get().history;
    const specs = routeLegs(present);
    const legs = specs.map<LegView>((spec) => {
      const straight = [spec.from, spec.to];
      const base = { index: spec.index, key: spec.key, from: spec.from, to: spec.to, mode: spec.mode };
      if (spec.mode === "straight") {
        return { ...base, status: "ready", points: straight, distanceM: polylineLengthM(straight) };
      }
      const entry = snapped(spec.key, spec.from, spec.to);
      if (entry.status === "ready") {
        return { ...base, status: "ready", points: entry.points, distanceM: polylineLengthM(entry.points) };
      }
      if (entry.status === "error") {
        return {
          ...base,
          status: "error",
          points: straight,
          distanceM: 0,
          error: { code: entry.code, message: entry.message },
        };
      }
      return { ...base, status: "pending", points: straight, distanceM: 0 };
    });
    trimCache(new Set(specs.map((s) => s.key)));
    draws.set({ legs, distanceM: legs.reduce((sum, leg) => sum + leg.distanceM, 0) });
    // A finished route with a leg that failed would never become a course; show the editor, which offers the fixes.
    if (!draws.get().editing && drawn() && legs.some((leg) => leg.status === "error")) draws.set({ editing: true });
    updateCourse(present.waypoints.length, legs);
  }

  function updateCourse(waypointCount: number, legs: readonly LegView[]): void {
    const current = drawn();
    if (!current) return;
    if (waypointCount < 2) {
      elevationRequest?.abort();
      builtFrom = undefined;
      if (current.course) setCourse({ status: "drawn", course: null, elevation: null, updating: false });
      return;
    }
    if (legs.some((leg) => leg.status !== "ready")) {
      // Keep the last profile up, marked as updating, until every leg has its line.
      if (current.course && !current.updating) setCourse({ ...current, updating: true });
      return;
    }
    const points = stitchLegs(legs.map((leg) => leg.points));
    const signature = points.map((p) => `${p.lat},${p.lon}`).join(";");
    if (signature === builtFrom && current.course) {
      if (current.updating && current.elevation?.status !== "loading") setCourse({ ...current, updating: false });
      return;
    }
    builtFrom = signature;
    buildProfile(buildCourse(points));
  }

  function buildProfile(course: Course): void {
    elevationRequest?.abort();
    const controller = new AbortController();
    elevationRequest = controller;
    const current = drawn();
    if (!current) return;
    const previous = current.elevation?.status === "ready" ? current.elevation : { status: "loading" as const };
    const pending: Drawn = { status: "drawn", course, elevation: previous, updating: true };
    setCourse(pending);
    elevation(course, { signal: controller.signal }).then(
      (profile) => {
        if (controller.signal.aborted || store.get().course !== pending) return;
        setCourse({ status: "drawn", course, elevation: { status: "ready", profile }, updating: false });
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbort(error) || store.get().course !== pending) return;
        console.error("Could not build the elevation profile", error);
        setCourse({
          status: "drawn",
          course,
          elevation: { status: "error", message: elevationErrorMessage(error) },
          updating: false,
        });
      },
    );
  }

  function abortAll(): void {
    for (const entry of cache.values()) if (entry.status === "pending") entry.controller.abort();
    for (const [key, entry] of cache) if (entry.status === "pending") cache.delete(key);
    elevationRequest?.abort();
    builtFrom = undefined;
  }

  // Another course (a GPX file) replaces the drawing: stop drawing and drop what is in flight.
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.course.status === "drawn" || previous.course.status !== "drawn") return;
    abortAll();
    locating++;
    draws.set({ ...initialDrawState(), newLegMode: draws.get().newLegMode });
  });

  return {
    start() {
      const hadCourse = store.get().course.status === "loaded" || store.get().course.status === "drawn";
      abortAll();
      setCourse({ status: "drawn", course: null, elevation: null, updating: false }, true);
      draws.set({ editing: true, history: createDrawHistory(), legs: [], distanceM: 0 });
      setSheet("peek");
      if (hadCourse) return;
      const attempt = ++locating;
      locate().then(
        (center) => {
          if (attempt !== locating || !draws.get().editing) return;
          // Only if nothing has been drawn yet: never move the map out from under a route.
          if (draws.get().history.present.waypoints.length > 0) return;
          draws.set({ camera: { id: ++cameraId, center, zoom: LOCATE_ZOOM } });
        },
        () => {
          // No location (refused, unavailable, or too slow): draw wherever the map is.
        },
      );
    },
    dispatch(action) {
      const { history } = draws.get();
      const next = drawReducer(history, action);
      if (next === history) return;
      draws.set({ history: next });
      sync();
    },
    setNewLegMode(mode) {
      draws.set({ newLegMode: mode });
    },
    finish() {
      if (!drawn()) return;
      if (draws.get().history.present.waypoints.length < 2) {
        abortAll();
        draws.set({ editing: false, history: createDrawHistory(), legs: [], distanceM: 0 });
        setCourse({ status: "empty" }, true);
        return;
      }
      draws.set({ editing: false });
      if (store.get().sheet === "peek") setSheet("half");
    },
    edit() {
      if (!drawn()) return;
      draws.set({ editing: true });
      setSheet("peek");
    },
    load(route) {
      abortAll();
      locating++;
      setCourse({ status: "drawn", course: null, elevation: null, updating: false }, true);
      draws.set({ editing: false, history: createDrawHistory(route), legs: [], distanceM: 0 });
      sync();
    },
    retryLeg(index) {
      const leg = draws.get().legs[index];
      if (!leg || leg.status !== "error") return;
      cache.delete(leg.key);
      sync();
    },
    retryElevation() {
      const current = drawn();
      if (!current?.course || current.elevation?.status !== "error") return;
      buildProfile(current.course);
    },
    dispose() {
      unsubscribe();
      abortAll();
    },
  };
}

export const drawStore: Store<DrawState> = createStore<DrawState>(initialDrawState());

export function useDrawState<T>(selector: (state: DrawState) => T): T {
  return useStore(drawStore, selector);
}

/** The app's drawing controller. */
export const drawing: DrawController = createDrawController({ draws: drawStore });
