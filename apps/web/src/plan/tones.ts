/**
 * Plan segment colors, shared by the map line, the elevation chart and the segment table. A
 * segment's color says how its pace compares with the goal's flat-ground pace: blues are faster
 * (downhill), reds slower (uphill), gray about even. It is a diverging scale with three steps per
 * side, so adjacent segments can share a color; the chart and the map mark every boundary.
 */
import { METERS_PER_MILE } from "@pp/core";
import type { Theme } from "../state/app.ts";

/** -3 is much faster than flat pace, 0 about even, 3 much slower. */
export type Tone = -3 | -2 | -1 | 0 | 1 | 2 | 3;
export const TONES: readonly Tone[] = [-3, -2, -1, 0, 1, 2, 3];

/**
 * Where each step starts, in seconds per mile away from flat pace. Under Daniels' rule 1% of
 * grade is 12 s per mile uphill and 7 downhill, so a 1% climb lands on the second step.
 */
export const TONE_STEPS_S_PER_MI = [4, 10, 20] as const;

/** The tone of a segment held at `paceSPerM` when the goal's flat pace is `flatPaceSPerM`. */
export function segmentTone(paceSPerM: number, flatPaceSPerM: number): Tone {
  const delta = (paceSPerM - flatPaceSPerM) * METERS_PER_MILE;
  const size = TONE_STEPS_S_PER_MI.filter((step) => Math.abs(delta) >= step - 1e-9).length;
  return (Math.sign(delta) * size || 0) as Tone;
}

/** The CSS custom property holding a tone's color (defined in `styles.css`, per theme). */
export function toneVar(tone: Tone): string {
  return `var(--pp-tone-${tone < 0 ? "m" : "p"}${Math.abs(tone)})`;
}

/**
 * The same colors as `styles.css`, for MapLibre (which cannot read CSS variables). A unit test
 * keeps the two in step.
 */
export const TONE_COLORS: Record<Theme, Record<Tone, string>> = {
  light: {
    [-3]: "#1d5fae",
    [-2]: "#3b82d9",
    [-1]: "#7aaee9",
    0: "#7c756f",
    1: "#ec9a6c",
    2: "#e0652f",
    3: "#b9381c",
  },
  dark: {
    [-3]: "#9cc6f7",
    [-2]: "#4f93e6",
    [-1]: "#2f69ad",
    0: "#8a837d",
    1: "#ad5a33",
    2: "#e7703c",
    3: "#f6a37c",
  },
};

/** How a tone reads in words, for the legend and for screen readers. */
export function toneLabel(tone: Tone): string {
  if (tone === 0) return "about flat pace";
  const how = Math.abs(tone) === 3 ? "much " : Math.abs(tone) === 2 ? "" : "a little ";
  return `${how}${tone < 0 ? "faster" : "slower"} than flat pace`;
}
