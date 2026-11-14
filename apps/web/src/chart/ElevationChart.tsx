import { type DistanceUnit, type ElevationProfile, metersToUnit, pointAtDistance, unitToMeters } from "@pp/core";
import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Quantity, elevationInUnits, formatDistance, formatElevation, quantityText } from "../panel/format.ts";
import { appStore, setFocusDistM, useAppState } from "../state/app.ts";
import { type LinearScale, distanceTicks, linearScale, niceAxis, thinForColumns } from "./scale.ts";

/** Chart height in CSS pixels, axes included. */
export const CHART_HEIGHT_PX = 168;
/** Room above the plot for the readout over the cursor, and below it for the distance labels. */
const TOP_PX = 30;
const BOTTOM_PX = 22;
const RIGHT_PX = 4;
/** Roughly one distance label per this many pixels, so labels never crowd at 375 px wide. */
const PX_PER_DISTANCE_TICK = 72;
/** About this many elevation intervals; the plot is short. */
const ELEVATION_TICKS = 3;
/** The smallest elevation range drawn, so a flat course reads as flat (in feet, or meters). */
const MIN_SPAN: Record<DistanceUnit, number> = { mi: 100, km: 30 };
/** Approximate width of one 11 px tabular digit, for sizing the elevation label gutter. */
const LABEL_CHAR_PX = 6.6;

export interface ElevationChartProps {
  profile: ElevationProfile;
  units: DistanceUnit;
}

interface Geometry {
  width: number;
  left: number;
  x: LinearScale;
  y: LinearScale;
  line: string;
  area: string;
  xTicks: { value: number; label: string; anchor: "start" | "middle" | "end" }[];
  yTicks: { value: number; label: string }[];
  plotTop: number;
  plotBottom: number;
}

const tickFormats = new Map<number, Intl.NumberFormat>();
function tickLabel(value: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  let format = tickFormats.get(decimals);
  if (!format) {
    format = new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
    tickFormats.set(decimals, format);
  }
  return format.format(value);
}

/** Axes, scales and paths for the profile at a given pixel width (in display units throughout). */
function layout(profile: ElevationProfile, units: DistanceUnit, width: number): Geometry {
  const { points } = profile.course;
  const lengthU = metersToUnit(points.at(-1)?.distM ?? 0, units);
  const eleUnit = units === "mi" ? "ft" : "m";
  const y = niceAxis(
    elevationInUnits(profile.stats.minM, units),
    elevationInUnits(profile.stats.maxM, units),
    ELEVATION_TICKS,
    MIN_SPAN[units],
  );
  const yLabels = y.ticks.map((v, i) => tickLabel(v, y.step) + (i === y.ticks.length - 1 ? ` ${eleUnit}` : ""));
  const left = Math.ceil(Math.max(...yLabels.map((l) => l.length)) * LABEL_CHAR_PX) + 8;
  const plotTop = TOP_PX;
  const plotBottom = CHART_HEIGHT_PX - BOTTOM_PX;
  const plotWidth = Math.max(1, width - left - RIGHT_PX);
  const xScale = linearScale([0, lengthU || 1], [left, left + plotWidth]);
  const yScale = linearScale([y.min, y.max], [plotBottom, plotTop]);

  const xs = points.map((p) => metersToUnit(p.distM, units));
  const ys = points.map((p) => elevationInUnits(p.ele ?? 0, units));
  let line = "";
  for (const i of thinForColumns(xs, ys, Math.ceil(plotWidth))) {
    line += `${line ? "L" : "M"}${xScale(xs[i] as number).toFixed(1)} ${yScale(ys[i] as number).toFixed(1)}`;
  }
  const area = `${line}L${xScale(lengthU).toFixed(1)} ${plotBottom}L${left} ${plotBottom}Z`;

  const dx = distanceTicks(lengthU, Math.max(2, Math.round(plotWidth / PX_PER_DISTANCE_TICK)));
  const xTicks = dx.ticks.map((value, i) => {
    const label = tickLabel(value, dx.step) + (i === dx.ticks.length - 1 ? ` ${units}` : "");
    const at = xScale(value);
    const half = (label.length * LABEL_CHAR_PX) / 2;
    const anchor: "start" | "middle" | "end" = at - half < left - 4 ? "start" : at + half > width ? "end" : "middle";
    return { value, label, anchor };
  });
  return {
    width,
    left,
    x: xScale,
    y: yScale,
    line,
    area,
    xTicks,
    yTicks: y.ticks.map((value, i) => ({ value, label: yLabels[i] ?? "" })),
    plotTop,
    plotBottom,
  };
}

/** The width of an element, kept current as it resizes. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * The course's elevation against distance, in the selected units. Hovering it (or dragging along
 * it by touch, or the arrow keys once focused) points at a spot on the course: the map shows a
 * marker there, and hovering the route on the map moves this chart's cursor in turn. A slider to
 * assistive technology, with the distance and elevation as its value.
 */
export function ElevationChart({ profile, units }: ElevationChartProps) {
  const [root, width] = useWidth<HTMLDivElement>();
  const readout = useRef<HTMLDivElement>(null);
  const gradient = useId();
  const description = useId();
  const focusDistM = useAppState((s) => s.focusDistM);
  const geometry = useMemo(() => (width > 0 ? layout(profile, units, width) : null), [profile, units, width]);
  const { points } = profile.course;
  const lengthM = points.at(-1)?.distM ?? 0;

  const focused = focusDistM === null || points.length === 0 ? undefined : pointAtDistance(profile.course, focusDistM);
  const cursor =
    focused && geometry
      ? {
          x: geometry.x(metersToUnit(focused.distM, units)),
          y: geometry.y(elevationInUnits(focused.ele ?? 0, units)),
        }
      : undefined;

  // Keep the readout over the cursor, but inside the chart.
  useLayoutEffect(() => {
    const element = readout.current;
    if (!element || !cursor || !geometry) return;
    const w = element.offsetWidth;
    element.style.left = `${Math.min(Math.max(cursor.x - w / 2, 0), geometry.width - w)}px`;
  });

  /** Point at a distance in meters along the course, clamped to the course. */
  const focusAt = (distM: number) => setFocusDistM(Math.min(Math.max(distM, 0), lengthM));
  const focusAtClientX = (clientX: number) => {
    const element = root.current;
    if (!element || !geometry) return;
    const x = clientX - element.getBoundingClientRect().left;
    focusAt(unitToMeters(geometry.x.invert(x), units));
  };

  // A touch scrub leaves its point showing after the finger lifts (the finger hid it on the way),
  // until the next press anywhere else.
  const touched = useRef(false);
  useEffect(() => {
    const clear = (event: globalThis.PointerEvent) => {
      if (!touched.current || root.current?.contains(event.target as Node)) return;
      touched.current = false;
      setFocusDistM(null);
    };
    document.addEventListener("pointerdown", clear, true);
    return () => document.removeEventListener("pointerdown", clear, true);
  }, [root]);

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") touched.current = true;
    focusAtClientX(event.clientX);
  };
  const onPointerMove = (event: PointerEvent) => {
    // A touch moves only while pressed, and the browser captures it to this element.
    focusAtClientX(event.clientX);
  };
  const onPointerLeave = (event: PointerEvent) => {
    if (event.pointerType !== "touch") setFocusDistM(null);
  };
  // The browser took the touch over to scroll the panel.
  const onPointerCancel = () => {
    touched.current = false;
    setFocusDistM(null);
  };

  const smallStepM = unitToMeters(0.1, units);
  const onKeyDown = (event: KeyboardEvent) => {
    const from = appStore.get().focusDistM ?? 0;
    const target: Record<string, number> = {
      ArrowRight: from + smallStepM,
      ArrowUp: from + smallStepM,
      ArrowLeft: from - smallStepM,
      ArrowDown: from - smallStepM,
      PageUp: from + smallStepM * 10,
      PageDown: from - smallStepM * 10,
      Home: 0,
      End: lengthM,
    };
    const to = target[event.key];
    if (to === undefined) return;
    event.preventDefault();
    focusAt(to);
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (focusDistM === null && event.currentTarget.matches(":focus-visible")) focusAt(0);
  };

  const at = focused ?? points[0];
  const distance: Quantity = formatDistance(at?.distM ?? 0, units);
  const elevation: Quantity = formatElevation(at?.ele ?? 0, units);
  const lengthU = metersToUnit(lengthM, units);

  return (
    <div
      ref={root}
      role="slider"
      tabIndex={0}
      aria-label="Elevation profile"
      aria-describedby={description}
      aria-valuemin={0}
      aria-valuemax={Number(lengthU.toFixed(2))}
      aria-valuenow={Number(metersToUnit(at?.distM ?? 0, units).toFixed(2))}
      aria-valuetext={`${quantityText(distance)}, elevation ${quantityText(elevation)}`}
      data-testid="elevation-chart"
      data-focus-m={focused ? focused.distM : undefined}
      className="relative cursor-crosshair touch-pan-y rounded-lg select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      style={{ height: CHART_HEIGHT_PX }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={() => setFocusDistM(null)}
    >
      <p id={description} className="sr-only">
        Elevation along the course, from {quantityText(formatElevation(profile.stats.minM, units))} to{" "}
        {quantityText(formatElevation(profile.stats.maxM, units))}. Use the arrow keys to move along the course and see
        the point on the map.
      </p>
      {geometry && (
        <svg width={geometry.width} height={CHART_HEIGHT_PX} className="block overflow-visible" aria-hidden="true">
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--pp-accent)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="var(--pp-accent)" stopOpacity="0.04" />
            </linearGradient>
          </defs>
          <g data-testid="chart-y-ticks">
            {geometry.yTicks.map(({ value, label }) => (
              <g key={value}>
                <line
                  x1={geometry.left}
                  x2={geometry.width - RIGHT_PX}
                  y1={geometry.y(value)}
                  y2={geometry.y(value)}
                  stroke="var(--pp-line)"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={geometry.left - 8}
                  y={geometry.y(value)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-ink-subtle text-[11px] tabular-nums"
                >
                  {label}
                </text>
              </g>
            ))}
          </g>
          <path d={geometry.area} fill={`url(#${gradient})`} />
          <path
            d={geometry.line}
            fill="none"
            stroke="var(--pp-accent)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            data-testid="chart-line"
          />
          <g data-testid="chart-x-ticks">
            {geometry.xTicks.map(({ value, label, anchor }) => (
              <text
                key={value}
                x={geometry.x(value)}
                y={CHART_HEIGHT_PX - 5}
                textAnchor={anchor}
                className="fill-ink-subtle text-[11px] tabular-nums"
              >
                {label}
              </text>
            ))}
          </g>
          {cursor && (
            <g data-testid="chart-cursor">
              <line
                x1={cursor.x}
                x2={cursor.x}
                y1={geometry.plotTop - 4}
                y2={geometry.plotBottom}
                stroke="var(--pp-ink)"
                strokeOpacity={0.55}
                strokeWidth={1.5}
              />
              <circle cx={cursor.x} cy={cursor.y} r={7.5} fill="var(--pp-surface)" />
              <circle
                cx={cursor.x}
                cy={cursor.y}
                r={5}
                fill="var(--pp-surface)"
                stroke="var(--pp-ink)"
                strokeWidth={3.5}
              />
            </g>
          )}
        </svg>
      )}
      {cursor && (
        <div
          ref={readout}
          className="pointer-events-none absolute top-0 rounded-lg bg-ink px-2 py-1 text-xs font-semibold whitespace-nowrap text-surface tabular-nums shadow-panel"
          data-testid="chart-readout"
        >
          {quantityText(distance)}
          <span className="mx-1.5 opacity-50">/</span>
          {quantityText(elevation)}
        </div>
      )}
    </div>
  );
}
