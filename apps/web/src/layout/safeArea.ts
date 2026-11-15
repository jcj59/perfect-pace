import { useSyncExternalStore } from "react";

/** The device's safe-area insets in CSS pixels: notches, rounded corners and the home indicator. */
export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const NONE: SafeArea = { top: 0, right: 0, bottom: 0, left: 0 };
let probe: HTMLElement | null = null;
let current: SafeArea = NONE;

/**
 * Read `env(safe-area-inset-*)` (non-zero with `viewport-fit=cover` in index.html) through a
 * hidden element's padding, since script cannot read `env()` directly.
 */
function measure(): SafeArea {
  if (!probe) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
    document.body.append(probe);
  }
  const style = getComputedStyle(probe);
  const next = {
    top: parseFloat(style.paddingTop) || 0,
    right: parseFloat(style.paddingRight) || 0,
    bottom: parseFloat(style.paddingBottom) || 0,
    left: parseFloat(style.paddingLeft) || 0,
  };
  const same = (Object.keys(next) as (keyof SafeArea)[]).every((k) => next[k] === current[k]);
  if (!same) current = next;
  return current;
}

function subscribe(onChange: () => void): () => void {
  // The insets change with orientation, which always resizes the viewport.
  window.addEventListener("resize", onChange);
  window.addEventListener("orientationchange", onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    window.removeEventListener("orientationchange", onChange);
  };
}

/** The current safe-area insets, kept up to date as the device rotates. */
export function useSafeArea(): SafeArea {
  return useSyncExternalStore(subscribe, measure, () => NONE);
}
