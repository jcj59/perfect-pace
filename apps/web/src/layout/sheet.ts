import { SHEET_SNAPS, type SheetSnap } from "../state/app.ts";

/** Height of the sheet at `peek`: its grab handle plus the panel header. */
export const SHEET_PEEK_PX = 92;
/** Map left visible above the sheet at `full`, so it still reads as a sheet over the map. */
export const SHEET_TOP_GAP_PX = 56;
/** How far ahead (in seconds) a fling carries the sheet before picking the nearest snap. */
const FLING_S = 0.25;

export type SnapHeights = Record<SheetSnap, number>;

/** The visible sheet height at each snap point, for a layout `containerPx` tall. */
export function snapHeights(containerPx: number): SnapHeights {
  const full = Math.max(SHEET_PEEK_PX, containerPx - SHEET_TOP_GAP_PX);
  const half = Math.min(full, Math.max(SHEET_PEEK_PX, Math.round(containerPx * 0.5)));
  return { peek: SHEET_PEEK_PX, half, full };
}

/**
 * Where a drag released at `heightPx`, moving at `velocityPxPerS` (positive is upward), comes to
 * rest: the snap nearest to where the fling would carry it.
 */
export function releaseSnap(heightPx: number, velocityPxPerS: number, heights: SnapHeights): SheetSnap {
  const target = heightPx + velocityPxPerS * FLING_S;
  let best: SheetSnap = "peek";
  for (const snap of SHEET_SNAPS) {
    if (Math.abs(heights[snap] - target) < Math.abs(heights[best] - target)) best = snap;
  }
  return best;
}

/** The snap after `snap` when tapping the handle: up through the snaps, then back to `peek`. */
export function nextSnap(snap: SheetSnap): SheetSnap {
  const i = SHEET_SNAPS.indexOf(snap);
  return SHEET_SNAPS[(i + 1) % SHEET_SNAPS.length] ?? "peek";
}

/** One step up (`+1`) or down (`-1`), clamped at the ends. */
export function stepSnap(snap: SheetSnap, step: 1 | -1): SheetSnap {
  const i = Math.min(SHEET_SNAPS.length - 1, Math.max(0, SHEET_SNAPS.indexOf(snap) + step));
  return SHEET_SNAPS[i] ?? snap;
}
