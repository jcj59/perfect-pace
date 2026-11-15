import { useCallback, useState, useSyncExternalStore } from "react";
import {
  type PanelWidthRange,
  clampPanelWidth,
  panelWidthRange,
  readPanelWidth,
  writePanelWidth,
} from "./panelWidth.ts";
import { subscribeResize } from "./useMediaQuery.ts";

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export interface PanelWidth {
  /** The width shown now, in CSS pixels: it follows a drag as it happens. */
  width: number;
  /**
   * The width the panel rests at: the stored choice, clamped to the window. It changes when a drag
   * ends (not during one), a key moves the handle, or the window shrinks past it, so it is what the
   * map's camera keeps clear of.
   */
  settledWidth: number;
  range: PanelWidthRange;
  /** Show a width while dragging, without keeping it. */
  preview: (widthPx: number | null) => void;
  /** Settle at a width and keep it for the next visit. */
  commit: (widthPx: number) => void;
}

/**
 * The desktop panel's width. The stored choice is kept as the user left it; a narrower window
 * only clamps where it is shown, so widening the window again brings it back.
 */
export function usePanelWidth(): PanelWidth {
  const windowPx = useSyncExternalStore(subscribeResize, () => window.innerWidth);
  const [chosen, setChosen] = useState(() => readPanelWidth(browserStorage()));
  const [dragged, setDragged] = useState<number | null>(null);
  const commit = useCallback(
    (widthPx: number) => {
      const width = clampPanelWidth(widthPx, windowPx);
      setDragged(null);
      setChosen(width);
      writePanelWidth(browserStorage(), width);
    },
    [windowPx],
  );
  const settledWidth = clampPanelWidth(chosen, windowPx);
  return {
    width: dragged === null ? settledWidth : clampPanelWidth(dragged, windowPx),
    settledWidth,
    range: panelWidthRange(windowPx),
    preview: setDragged,
    commit,
  };
}
