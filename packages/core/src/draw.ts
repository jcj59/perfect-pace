/**
 * Drawing a course on the map: the waypoint editor as a pure reducer with undo/redo history, the
 * legs a drawn route asks the router for, and leg stitching.
 *
 * A drawn route is its waypoints plus one mode per leg (leg `i` runs from `waypoints[i]` to
 * `waypoints[i + 1]`): `snap` follows paths through the routing provider, `straight` is a straight
 * line. That pair is the whole route. Each leg's geometry is derived from it and can be cached by
 * `legKey`, so moving one waypoint changes the keys of only its two neighboring legs, undo brings
 * back keys that are already cached, and a share link can encode the waypoints and modes alone.
 *
 * Every edit rounds positions to `ROUTE_COORDINATE_DECIMALS` places, the same rounding routing
 * requests use, so a waypoint and the request for its legs always agree.
 */
import { type LatLon, haversineM, lerpLatLon } from "./geo.ts";
import { roundCoordinate } from "./routing.ts";

/** How a leg gets from one waypoint to the next: along paths (routed) or in a straight line. */
export type LegMode = "snap" | "straight";

/** Every `LegMode`. */
export const LEG_MODES: readonly LegMode[] = ["snap", "straight"];

/** A drawn route: its waypoints, and the mode of each leg between them (one fewer than waypoints). */
export interface DrawnRoute {
  readonly waypoints: readonly LatLon[];
  /** `modes[i]` is the mode of leg `i`, from `waypoints[i]` to `waypoints[i + 1]`. */
  readonly modes: readonly LegMode[];
}

export const EMPTY_ROUTE: DrawnRoute = { waypoints: [], modes: [] };

/**
 * One change to a drawn route. Indexes out of range, and edits that would change nothing, leave
 * the route as it is (the same object), so they never add an undo step.
 */
export type RouteEdit =
  /** Add a waypoint at the end. The new leg to it (if any) gets `mode`. */
  | { type: "add"; at: LatLon; mode: LegMode }
  /** Move waypoint `index`. Its two neighboring legs keep their modes. */
  | { type: "move"; index: number; to: LatLon }
  /** Split leg `leg` with a new waypoint (dragged from its midpoint). Both halves keep its mode. */
  | { type: "insert"; leg: number; at: LatLon }
  /**
   * Remove waypoint `index`. Removing an inner one joins its two legs into one, which takes the
   * mode of the leg that arrived at the removed waypoint.
   */
  | { type: "remove"; index: number }
  /** Set the mode of leg `leg`. */
  | { type: "setMode"; leg: number; mode: LegMode }
  /** Back to the start: a last leg (in `mode`) from the final waypoint to the first. Needs 2 waypoints. */
  | { type: "closeLoop"; mode: LegMode }
  /** Retrace the route back to the start: the waypoints and legs again in reverse. Needs 2 waypoints. */
  | { type: "outAndBack" }
  /** Remove every waypoint. */
  | { type: "clear" };

function checkPosition(p: LatLon, what: string): LatLon {
  if (!(
    Number.isFinite(p.lat) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    Number.isFinite(p.lon) &&
    p.lon >= -180 &&
    p.lon <= 180
  )) {
    throw new RangeError(`${what}: invalid position ${p.lat}, ${p.lon}`);
  }
  return { lat: roundCoordinate(p.lat), lon: roundCoordinate(p.lon) };
}

const samePosition = (a: LatLon, b: LatLon): boolean => a.lat === b.lat && a.lon === b.lon;

const isIndex = (i: number, length: number): boolean => Number.isInteger(i) && i >= 0 && i < length;

/**
 * The route after `edit`, as a new object, or `route` itself when the edit changes nothing (an
 * index out of range, a shortcut without enough waypoints, a move to where the waypoint already
 * is). Throws a `RangeError` for a position outside latitude [-90, 90] or longitude [-180, 180].
 */
export function applyRouteEdit(route: DrawnRoute, edit: RouteEdit): DrawnRoute {
  const { waypoints, modes } = route;
  const n = waypoints.length;
  switch (edit.type) {
    case "add": {
      const at = checkPosition(edit.at, "add");
      return { waypoints: [...waypoints, at], modes: n === 0 ? [] : [...modes, edit.mode] };
    }
    case "move": {
      const to = checkPosition(edit.to, "move");
      if (!isIndex(edit.index, n) || samePosition(waypoints[edit.index]!, to)) return route;
      return { waypoints: waypoints.map((w, i) => (i === edit.index ? to : w)), modes };
    }
    case "insert": {
      const at = checkPosition(edit.at, "insert");
      if (!isIndex(edit.leg, modes.length)) return route;
      const leg = edit.leg;
      return {
        waypoints: [...waypoints.slice(0, leg + 1), at, ...waypoints.slice(leg + 1)],
        modes: [...modes.slice(0, leg + 1), modes[leg]!, ...modes.slice(leg + 1)],
      };
    }
    case "remove": {
      const i = edit.index;
      if (!isIndex(i, n)) return route;
      const kept = waypoints.filter((_, k) => k !== i);
      if (kept.length < 2) return { waypoints: kept, modes: [] };
      // The first or last waypoint takes its one leg with it; an inner one joins its two legs,
      // keeping the mode of the leg that arrived (leg i - 1) and dropping leg i.
      const dropLeg = i === 0 ? 0 : i;
      return { waypoints: kept, modes: modes.filter((_, k) => k !== Math.min(dropLeg, modes.length - 1)) };
    }
    case "setMode": {
      if (!isIndex(edit.leg, modes.length) || modes[edit.leg] === edit.mode) return route;
      return { waypoints, modes: modes.map((m, i) => (i === edit.leg ? edit.mode : m)) };
    }
    case "closeLoop": {
      if (n < 2 || samePosition(waypoints[0]!, waypoints[n - 1]!)) return route;
      return { waypoints: [...waypoints, waypoints[0]!], modes: [...modes, edit.mode] };
    }
    case "outAndBack": {
      if (n < 2) return route;
      return {
        waypoints: [...waypoints, ...waypoints.slice(0, -1).reverse()],
        modes: [...modes, ...[...modes].reverse()],
      };
    }
    case "clear":
      return n === 0 ? route : EMPTY_ROUTE;
  }
}

/** Whether the route ends where it starts (a loop, or an out and back), with at least one leg. */
export function isClosed(route: DrawnRoute): boolean {
  const { waypoints } = route;
  return waypoints.length > 2 && samePosition(waypoints[0]!, waypoints.at(-1)!);
}

/** The edit history: the route now, the routes undo goes back to, and the ones redo replays. */
export interface DrawHistory {
  /** Oldest first, so the last entry is what undo restores. */
  readonly past: readonly DrawnRoute[];
  readonly present: DrawnRoute;
  /** Next first, so the first entry is what redo restores. */
  readonly future: readonly DrawnRoute[];
}

/** Undo steps kept. Older ones are forgotten, oldest first. */
export const MAX_UNDO_STEPS = 100;

/** A history that starts at `route` (empty by default), with nothing to undo or redo. */
export function createDrawHistory(route: DrawnRoute = EMPTY_ROUTE): DrawHistory {
  return { past: [], present: route, future: [] };
}

/** What the drawing reducer takes: an edit, or a step back or forward through the history. */
export type DrawAction = RouteEdit | { type: "undo" } | { type: "redo" };

export const canUndo = (history: DrawHistory): boolean => history.past.length > 0;
export const canRedo = (history: DrawHistory): boolean => history.future.length > 0;

/**
 * The history after `action`. An edit that changes the route becomes one undo step and drops
 * anything there was to redo; one that changes nothing returns `history` itself. Undo and redo
 * with nothing to step to also return `history`.
 */
export function drawReducer(history: DrawHistory, action: DrawAction): DrawHistory {
  if (action.type === "undo") {
    const previous = history.past.at(-1);
    if (!previous) return history;
    return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
  }
  if (action.type === "redo") {
    const next = history.future[0];
    if (!next) return history;
    return { past: [...history.past, history.present], present: next, future: history.future.slice(1) };
  }
  const present = applyRouteEdit(history.present, action);
  if (present === history.present) return history;
  return { past: [...history.past, history.present].slice(-MAX_UNDO_STEPS), present, future: [] };
}

/** One leg of a drawn route, as the router sees it. */
export interface LegSpec {
  /** The leg's index in the route: it runs from `waypoints[index]` to `waypoints[index + 1]`. */
  index: number;
  from: LatLon;
  to: LatLon;
  mode: LegMode;
  /** Identifies the leg's geometry: the same ends and mode always give the same key. */
  key: string;
}

const positionKey = (p: LatLon): string => `${p.lat},${p.lon}`;

/** The cache key of a leg's geometry: its mode and its two (rounded) ends, in order. */
export function legKey(from: LatLon, to: LatLon, mode: LegMode): string {
  return `${mode}:${positionKey(from)}>${positionKey(to)}`;
}

/** The legs of a route, in order. */
export function routeLegs(route: DrawnRoute): LegSpec[] {
  return route.modes.map((mode, index) => {
    const from = route.waypoints[index]!;
    const to = route.waypoints[index + 1]!;
    return { index, from, to, mode, key: legKey(from, to, mode) };
  });
}

/** Leg ends closer than this (meters) are the same point, joined without a zero-length hop. */
export const STITCH_JOIN_M = 0.5;

/**
 * Join leg lines (each in order, from its start to its end) into one line. Where a leg starts
 * within `STITCH_JOIN_M` of where the one before ended (the waypoint they share, which the router
 * snaps the same way for both), that duplicate point is dropped; otherwise the gap is bridged by a
 * straight hop. Empty legs are skipped. Returns new points; the input is not changed.
 */
export function stitchLegs(legs: readonly (readonly LatLon[])[]): LatLon[] {
  const out: LatLon[] = [];
  for (const leg of legs) {
    leg.forEach((p, i) => {
      const last = out.at(-1);
      if (i === 0 && last && haversineM(last, p) < STITCH_JOIN_M) return;
      out.push({ lat: p.lat, lon: p.lon });
    });
  }
  return out;
}

/**
 * The point halfway along a line (by length), where the editor puts a leg's drag-to-insert
 * handle. The first point for a line of zero length; undefined for an empty one.
 */
export function lineMidpoint(points: readonly LatLon[]): LatLon | undefined {
  const first = points[0];
  if (!first) return undefined;
  const hops = points.slice(1).map((p, i) => haversineM(points[i]!, p));
  let remaining = hops.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i]!;
    if (remaining <= hop && hop > 0) {
      return lerpLatLon(points[i]!, points[i + 1]!, remaining / hop);
    }
    remaining -= hop;
  }
  return { lat: first.lat, lon: first.lon };
}
