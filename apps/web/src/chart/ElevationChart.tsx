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
import { useWidth } from "../layout/useWidth.ts";
import { movedBreakpoints, withBreakpoint } from "../plan/breakpoints.ts";
import { type Quantity, elevationInUnits, formatDistance, formatElevation, quantityText } from "../panel/format.ts";
import { type Tone, toneVar } from "../plan/tones.ts";
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

/** A plan segment to color on the chart: its span along the course and its tone. */
export interface ChartSegment {
  startM: number;
  endM: number;
  tone: Tone;
}

/** Custom breakpoints to show and edit on the chart (see `ElevationChart`). */
export interface BreakpointEditor {
  /** Where the pace changes, meters from the start, in order. */
  valuesM: readonly number[];
  onChange: (valuesM: number[]) => void;
}

/** How far from a breakpoint's line, in CSS pixels, a press picks it up: a fingertip needs more than a mouse. */
const GRAB_PX = { mouse: 8, touch: 18 } as const;
/** A press that moves farther than this is a scrub, not a tap that places a breakpoint. */
const TAP_SLOP_PX = 8;

export interface ElevationChartProps {
  profile: ElevationProfile;
  units: DistanceUnit;
  /**
   * The plan's segments, colored by tone with a gap at each boundary. Without them the profile is
   * drawn in the accent color. The store's `selectedSegment` is highlighted and the rest dimmed.
   */
  segments?: readonly ChartSegment[] | undefined;
  /**
   * Custom breakpoints. With them, a click or tap places one, pressing on one drags it, and
   * Enter places one at the cursor.
   */
  breakpoints?: BreakpointEditor | undefined;
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

/**
 * The course's elevation against distance, in the selected units. Hovering it (or dragging along
 * it by touch, or the arrow keys once focused) points at a spot on the course: the map shows a
 * marker there, and hovering the route on the map moves this chart's cursor in turn. A slider to
 * assistive technology, with the distance and elevation as its value.
 *
 * With `breakpoints` (a Custom plan) it also edits them: a click or tap places one on the nearest
 * course point, pressing on one's line drags it (never past its neighbors), and Enter places one at
 * the cursor for the keyboard. A press that moves is still a scrub, so pointing at the course
 * works as before.
 */
export function ElevationChart({ profile, units, segments, breakpoints }: ElevationChartProps) {
  const [root, width] = useWidth<HTMLDivElement>();
  const readout = useRef<HTMLDivElement>(null);
  const gradient = useId();
  const description = useId();
  const focusDistM = useAppState((s) => s.focusDistM);
  const selectedSegment = useAppState((s) => s.selectedSegment);
  const clipId = useId();
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

  // Breakpoint editing: the press that may become a tap, the breakpoint being dragged, and
  // whether the mouse is over one (for the cursor).
  const tap = useRef<{ id: number; x: number; y: number } | null>(null);
  const drag = useRef<{ id: number; index: number } | null>(null);
  const [overHandle, setOverHandle] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const clientDistM = (clientX: number): number | undefined => {
    const element = root.current;
    if (!element || !geometry) return undefined;
    return unitToMeters(geometry.x.invert(clientX - element.getBoundingClientRect().left), units);
  };
  /** The breakpoint whose line is within reach of `clientX`, nearest first. */
  const handleAt = (clientX: number, pointerType: string): number | undefined => {
    const element = root.current;
    if (!breakpoints || !element || !geometry) return undefined;
    const x = clientX - element.getBoundingClientRect().left;
    const reach = pointerType === "mouse" ? GRAB_PX.mouse : GRAB_PX.touch;
    let best: number | undefined;
    let bestGap: number = reach;
    breakpoints.valuesM.forEach((m, i) => {
      const gap = Math.abs(geometry.x(metersToUnit(m, units)) - x);
      if (gap <= bestGap) {
        bestGap = gap;
        best = i;
      }
    });
    return best;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse") touched.current = true;
    if (breakpoints && event.button === 0) {
      const index = handleAt(event.clientX, event.pointerType);
      if (index !== undefined) {
        drag.current = { id: event.pointerId, index };
        setDragging(index);
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      } else tap.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }
    focusAtClientX(event.clientX);
  };
  const onPointerMove = (event: PointerEvent) => {
    const held = drag.current;
    if (breakpoints && held?.id === event.pointerId) {
      const distM = clientDistM(event.clientX);
      if (distM === undefined) return;
      const next = movedBreakpoints(profile.course, breakpoints.valuesM, held.index, distM);
      if (next[held.index] !== breakpoints.valuesM[held.index]) breakpoints.onChange(next);
      focusAt(next[held.index]!);
      return;
    }
    const pressed = tap.current;
    if (
      pressed?.id === event.pointerId &&
      Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > TAP_SLOP_PX
    ) {
      tap.current = null;
    }
    if (breakpoints && event.pointerType === "mouse") {
      setOverHandle(handleAt(event.clientX, "mouse") !== undefined);
    }
    // A touch moves only while pressed, and the browser captures it to this element.
    focusAtClientX(event.clientX);
  };
  const onPointerUp = (event: PointerEvent) => {
    if (drag.current?.id === event.pointerId) {
      drag.current = null;
      setDragging(null);
      return;
    }
    const pressed = tap.current;
    tap.current = null;
    if (!breakpoints || pressed?.id !== event.pointerId) return;
    const distM = clientDistM(event.clientX);
    const next = distM === undefined ? undefined : withBreakpoint(profile.course, breakpoints.valuesM, distM);
    if (next) breakpoints.onChange(next);
  };
  const onPointerLeave = (event: PointerEvent) => {
    setOverHandle(false);
    if (event.pointerType !== "touch" && drag.current === null) setFocusDistM(null);
  };
  // The browser took the touch over to scroll the panel.
  const onPointerCancel = () => {
    touched.current = false;
    tap.current = null;
    drag.current = null;
    setDragging(null);
    setFocusDistM(null);
  };

  const smallStepM = unitToMeters(0.1, units);
  const onKeyDown = (event: KeyboardEvent) => {
    const focusM = appStore.get().focusDistM;
    if (breakpoints && event.key === "Enter") {
      event.preventDefault();
      const next = focusM === null ? undefined : withBreakpoint(profile.course, breakpoints.valuesM, focusM);
      if (next) breakpoints.onChange(next);
      return;
    }
    const from = focusM ?? 0;
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
      data-editing={breakpoints ? "breakpoints" : undefined}
      className={`relative touch-pan-y rounded-lg select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${dragging !== null || overHandle ? "cursor-ew-resize" : "cursor-crosshair"}`}
      style={{ height: CHART_HEIGHT_PX }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
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
        {breakpoints && " Press Enter to add a breakpoint at that point; edit or remove breakpoints in the list below."}
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
          {segments && segments.length > 0 ? (
            <SegmentLayers
              geometry={geometry}
              segments={segments}
              selected={selectedSegment}
              units={units}
              clipId={clipId}
            />
          ) : (
            <>
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
            </>
          )}
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
          {breakpoints && (
            <BreakpointHandles geometry={geometry} valuesM={breakpoints.valuesM} units={units} dragging={dragging} />
          )}
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

/**
 * The profile cut into plan segments: each one's area and line in its tone, clipped to its span,
 * with a surface-colored gap at every boundary so neighbors of the same tone still read as two.
 * A selected segment gets a band behind it and full strength; the others recede.
 */
function SegmentLayers({
  geometry,
  segments,
  selected,
  units,
  clipId,
}: {
  geometry: Geometry;
  segments: readonly ChartSegment[];
  selected: number | null;
  units: DistanceUnit;
  clipId: string;
}) {
  const { x, plotTop, plotBottom } = geometry;
  const spans = segments.map((s) => ({ x0: x(metersToUnit(s.startM, units)), x1: x(metersToUnit(s.endM, units)) }));
  const picked = selected !== null && selected < segments.length ? selected : null;
  return (
    <>
      <defs>
        {spans.map(({ x0, x1 }, i) => (
          <clipPath key={i} id={`${clipId}-${i}`}>
            <rect x={x0} y={0} width={Math.max(0, x1 - x0)} height={CHART_HEIGHT_PX} />
          </clipPath>
        ))}
      </defs>
      {picked !== null && spans[picked] && (
        <rect
          x={spans[picked].x0}
          y={plotTop - 6}
          width={Math.max(0, spans[picked].x1 - spans[picked].x0)}
          height={plotBottom - plotTop + 6}
          rx={4}
          fill="var(--pp-ink)"
          fillOpacity={0.06}
          data-testid="chart-selection"
        />
      )}
      {segments.map((segment, i) => {
        const state = picked === null ? "normal" : picked === i ? "selected" : "dimmed";
        const color = toneVar(segment.tone);
        return (
          <g
            key={i}
            clipPath={`url(#${clipId}-${i})`}
            data-testid="chart-segment"
            data-index={i}
            data-tone={segment.tone}
            data-selected={state === "selected" || undefined}
            opacity={state === "dimmed" ? 0.35 : 1}
          >
            <path d={geometry.area} fill={color} fillOpacity={state === "selected" ? 0.42 : 0.26} />
            <path
              d={geometry.line}
              fill="none"
              stroke={color}
              strokeWidth={state === "selected" ? 3 : 2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        );
      })}
      {/* The whole line, unclipped and unpainted, for its extent (tests measure the plot by it). */}
      <path d={geometry.line} fill="none" stroke="none" data-testid="chart-line" />
      <g data-testid="chart-boundaries">
        {spans.slice(1).map(({ x0 }, i) => (
          <line key={i} x1={x0} x2={x0} y1={plotTop - 2} y2={plotBottom} stroke="var(--pp-surface)" strokeWidth={2} />
        ))}
      </g>
    </>
  );
}

/**
 * The custom breakpoints on the chart: a line across the plot at each, with a grip at its top to
 * show it can be dragged. The one being dragged is drawn stronger.
 */
function BreakpointHandles({
  geometry,
  valuesM,
  units,
  dragging,
}: {
  geometry: Geometry;
  valuesM: readonly number[];
  units: DistanceUnit;
  dragging: number | null;
}) {
  const { x, plotTop, plotBottom } = geometry;
  return (
    <g data-testid="chart-breakpoints">
      {valuesM.map((m, i) => {
        const at = x(metersToUnit(m, units));
        const active = dragging === i;
        return (
          <g key={i} data-testid="chart-breakpoint" data-m={m} data-dragging={active || undefined}>
            <line
              x1={at}
              x2={at}
              y1={plotTop}
              y2={plotBottom}
              stroke="var(--pp-ink)"
              strokeOpacity={active ? 0.9 : 0.55}
              strokeWidth={active ? 2 : 1.5}
              strokeDasharray={active ? undefined : "3 3"}
            />
            <rect
              x={at - 5.5}
              y={plotTop - 9}
              width={11}
              height={17}
              rx={5.5}
              fill={active ? "var(--pp-ink)" : "var(--pp-surface)"}
              stroke="var(--pp-ink)"
              strokeOpacity={active ? 1 : 0.7}
              strokeWidth={1.5}
            />
            <path
              d={`M${at - 1.75} ${plotTop - 3.5}v6M${at + 1.75} ${plotTop - 3.5}v6`}
              stroke={active ? "var(--pp-surface)" : "var(--pp-ink)"}
              strokeOpacity={active ? 1 : 0.7}
              strokeWidth={1.2}
              strokeLinecap="round"
            />
          </g>
        );
      })}
    </g>
  );
}
