/**
 * The desktop panel's width: its limits, the keyboard step, and the per-device preference kept in
 * local storage. Pure functions of the window width, so the clamps are unit tested without a DOM.
 */

/** The width the panel starts at, and returns to on a double-click of its handle. */
export const PANEL_DEFAULT_WIDTH_PX = 384;
export const PANEL_MIN_WIDTH_PX = 320;
/** The widest the panel gets on a large window; a smaller one caps it at `PANEL_MAX_WINDOW_FRACTION`. */
export const PANEL_MAX_WIDTH_PX = 720;
export const PANEL_MAX_WINDOW_FRACTION = 0.6;
/** How far one arrow key press moves the handle. */
export const PANEL_KEY_STEP_PX = 16;
export const PANEL_WIDTH_STORAGE_KEY = "pp:panelWidth";

export interface PanelWidthRange {
  min: number;
  max: number;
}

/** The widths the panel may take in a window `windowPx` wide: 320 px up to `min(720 px, 60%)`. */
export function panelWidthRange(windowPx: number): PanelWidthRange {
  const max = Math.floor(Math.min(PANEL_MAX_WIDTH_PX, windowPx * PANEL_MAX_WINDOW_FRACTION));
  return { min: PANEL_MIN_WIDTH_PX, max: Math.max(PANEL_MIN_WIDTH_PX, max) };
}

/** `widthPx` brought inside `range`, in whole pixels. */
export function clampToRange(widthPx: number, { min, max }: PanelWidthRange): number {
  return Math.min(max, Math.max(min, Math.round(widthPx)));
}

/** `widthPx` brought inside the range for a window `windowPx` wide, in whole pixels. */
export function clampPanelWidth(widthPx: number, windowPx: number): number {
  return clampToRange(widthPx, panelWidthRange(windowPx));
}

/**
 * The width a key on the handle moves the panel to from `widthPx`, or null for a key that does not
 * resize it. Left and down narrow it, right and up widen it; Home and End go to the limits.
 */
export function keyedPanelWidth(key: string, widthPx: number, range: PanelWidthRange): number | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return clampToRange(widthPx - PANEL_KEY_STEP_PX, range);
    case "ArrowRight":
    case "ArrowUp":
      return clampToRange(widthPx + PANEL_KEY_STEP_PX, range);
    case "Home":
      return range.min;
    case "End":
      return range.max;
    default:
      return null;
  }
}

/**
 * The stored width, or the default when none is stored, it is not a sensible number, or storage
 * is unavailable. It is the user's choice, kept as is: the window clamps it where it is shown.
 */
export function readPanelWidth(storage: Pick<Storage, "getItem"> | undefined): number {
  try {
    const value = Number(storage?.getItem(PANEL_WIDTH_STORAGE_KEY) ?? Number.NaN);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : PANEL_DEFAULT_WIDTH_PX;
  } catch {
    return PANEL_DEFAULT_WIDTH_PX;
  }
}

/** Keep the width for the next visit (the default is kept by removing the key). Failures are ignored. */
export function writePanelWidth(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, widthPx: number): void {
  try {
    if (widthPx === PANEL_DEFAULT_WIDTH_PX) storage?.removeItem(PANEL_WIDTH_STORAGE_KEY);
    else storage?.setItem(PANEL_WIDTH_STORAGE_KEY, String(widthPx));
  } catch {
    // Storage can be full or blocked; the width still applies for this visit.
  }
}
