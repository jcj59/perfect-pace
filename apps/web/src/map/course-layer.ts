/**
 * The course on the map: a GeoJSON source with the route line and its start and finish points,
 * drawn over the roads and under the place labels (the start and finish dots go over everything).
 * It is part of the style itself, so a theme change restyles it without losing the data.
 */
import { type CoursePoint, simplify } from "@pp/core";
import type {
  ExpressionSpecification,
  GeoJSONSourceSpecification,
  LayerSpecification,
  StyleSpecification,
} from "maplibre-gl";
import { TONES, TONE_COLORS, type Tone } from "../plan/tones.ts";
import type { Theme } from "../state/app.ts";

export const COURSE_SOURCE = "course";
/** The plan's segments and the dots between them. */
export const PLAN_SOURCE = "plan";
export const COURSE_LINE_LAYER = "course-line";
/** An invisible, wide copy of the route line that catches the pointer for hovering the route. */
export const COURSE_HIT_LAYER = "course-hit";
/** The plan's segments over the route line, each in its tone. */
export const PLAN_LINE_LAYER = "plan-line";
/** A small dot where one segment ends and the next begins. */
export const PLAN_BREAK_LAYER = "plan-breaks";
/** A soft glow under the selected segment, so even a short one stands out at a whole-course zoom. */
export const PLAN_HALO_LAYER = "plan-halo";
/** Width (px) of the hover target along the route, much wider than the drawn line. */
const HIT_WIDTH_PX = 24;

type Coordinates = [number, number][];

export type CourseFeature =
  | {
      type: "Feature";
      properties: { role: "route" };
      geometry: { type: "LineString"; coordinates: Coordinates };
    }
  | {
      type: "Feature";
      properties: { role: "start" | "finish" | "break" };
      geometry: { type: "Point"; coordinates: [number, number] };
    }
  | {
      type: "Feature";
      properties: { role: "segment"; index: number; tone: Tone };
      geometry: { type: "LineString"; coordinates: Coordinates };
    };

export interface CourseFeatures {
  type: "FeatureCollection";
  features: CourseFeature[];
}

/** A plan segment to draw on the map: its stretch of course points and its tone. */
export interface MapSegment {
  points: readonly CoursePoint[];
  tone: Tone;
}

export const NO_COURSE: CourseFeatures = { type: "FeatureCollection", features: [] };

/**
 * How far (m) the drawn line may stray from the track. At the closest course zoom a pixel is about
 * 2 m, so this is invisible, and it turns a 50k-point watch recording into a few thousand points
 * for MapLibre to tile and draw.
 */
export const ROUTE_TOLERANCE_M = 1;

/** The route line plus start and finish points for a course, as GeoJSON (longitude first). */
export function courseFeatures(points: readonly CoursePoint[]): CourseFeatures {
  const coordinates: Coordinates = simplify(points, ROUTE_TOLERANCE_M).map((p) => [p.lon, p.lat]);
  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (!first || !last) return NO_COURSE;
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { role: "route" }, geometry: { type: "LineString", coordinates } },
      { type: "Feature", properties: { role: "finish" }, geometry: { type: "Point", coordinates: last } },
      { type: "Feature", properties: { role: "start" }, geometry: { type: "Point", coordinates: first } },
    ],
  };
}

/**
 * The plan's segment lines plus a break dot where each segment after the first begins, for the
 * plan source. Segment lines come from the plan's own (resampled) points, which lie on the route.
 * The plan has a source of its own, so redrawing it never makes the route's source reload.
 */
export function planFeatures(segments: readonly MapSegment[] | null): CourseFeatures {
  if (!segments || segments.length === 0) return NO_COURSE;
  const lines: CourseFeature[] = [];
  const breaks: CourseFeature[] = [];
  segments.forEach(({ points, tone }, index) => {
    const coordinates: Coordinates = simplify(points, ROUTE_TOLERANCE_M).map((p) => [p.lon, p.lat]);
    if (coordinates.length < 2) return;
    lines.push({
      type: "Feature",
      properties: { role: "segment", index, tone },
      geometry: { type: "LineString", coordinates },
    });
    if (index > 0) {
      breaks.push({
        type: "Feature",
        properties: { role: "break" },
        geometry: { type: "Point", coordinates: coordinates[0]! },
      });
    }
  });
  return { type: "FeatureCollection", features: [...lines, ...breaks] };
}

/** `[west, south, east, north]` of a course, or undefined for an empty one. */
export function courseBounds(points: readonly CoursePoint[]): [number, number, number, number] | undefined {
  if (points.length === 0) return undefined;
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { lat, lon } of points) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}

const COLORS: Record<Theme, { line: string; casing: string; finish: string }> = {
  light: { line: "#23864f", casing: "#ffffff", finish: "#1c1917" },
  dark: { line: "#4cc283", casing: "#0f0e0e", finish: "#f5f4f2" },
};

const ROUTE: ExpressionSpecification = ["==", ["get", "role"], "route"];
const SEGMENT: ExpressionSpecification = ["==", ["get", "role"], "segment"];
const ENDS: ExpressionSpecification = ["any", ["==", ["get", "role"], "start"], ["==", ["get", "role"], "finish"]];

/** A line `base` px wide at zoom 14, thinner zoomed out and wider zoomed in. */
function lineWidth(base: number): ExpressionSpecification {
  return ["interpolate", ["linear"], ["zoom"], 8, base * 0.6, 14, base, 18, base * 1.6];
}

/** Each segment's color by its tone, in this theme. */
function toneColor(theme: Theme): ExpressionSpecification {
  const pairs = TONES.flatMap((tone) => [tone, TONE_COLORS[theme][tone]]);
  return ["match", ["get", "tone"], ...pairs, TONE_COLORS[theme][0]] as unknown as ExpressionSpecification;
}

/**
 * The segment line's opacity and width with `selected` picked: it widens and the rest fade, so
 * it stands out on the map as it does on the chart. Applied with `setPaintProperty` on a change.
 */
export function planPaint(selected: number | null): {
  opacity: ExpressionSpecification | number;
  width: ExpressionSpecification;
  /** The halo layer's filter: the selected segment, or nothing. */
  halo: ExpressionSpecification;
} {
  if (selected === null) return { opacity: 1, width: lineWidth(4.5), halo: ["==", ["get", "role"], "none"] };
  const isSelected: ExpressionSpecification = ["==", ["get", "index"], selected];
  return {
    halo: ["all", SEGMENT, isSelected],
    opacity: ["case", isSelected, 1, 0.45],
    width: [
      "interpolate",
      ["linear"],
      ["zoom"],
      8,
      ["case", isSelected, 5, 2.7],
      14,
      ["case", isSelected, 8, 4.5],
      18,
      ["case", isSelected, 12.8, 7.2],
    ],
  };
}

/** The route's own line fades out under a plan, whose segments cover it. */
export const routeLineOpacity = (planned: boolean): number => (planned ? 0 : 1);

function lineLayers(theme: Theme, selected: number | null, planned: boolean): LayerSpecification[] {
  const c = COLORS[theme];
  const plan = planPaint(selected);
  return [
    {
      id: COURSE_HIT_LAYER,
      type: "line",
      source: COURSE_SOURCE,
      filter: ROUTE,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-width": HIT_WIDTH_PX, "line-color": c.line, "line-opacity": 0 },
    },
    {
      id: "course-casing",
      type: "line",
      source: COURSE_SOURCE,
      filter: ROUTE,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-width": lineWidth(8), "line-color": c.casing, "line-opacity": 0.9 },
    },
    {
      id: COURSE_LINE_LAYER,
      type: "line",
      source: COURSE_SOURCE,
      filter: ROUTE,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-width": lineWidth(4.5),
        "line-color": c.line,
        "line-opacity": routeLineOpacity(planned),
      },
    },
    {
      id: PLAN_HALO_LAYER,
      type: "line",
      source: PLAN_SOURCE,
      filter: plan.halo,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-width": lineWidth(22), "line-color": toneColor(theme), "line-opacity": 0.45, "line-blur": 3 },
    },
    {
      id: PLAN_LINE_LAYER,
      type: "line",
      source: PLAN_SOURCE,
      filter: SEGMENT,
      layout: { "line-join": "round", "line-cap": "butt" },
      paint: { "line-width": plan.width, "line-color": toneColor(theme), "line-opacity": plan.opacity },
    },
  ];
}

function pointLayers(theme: Theme): LayerSpecification[] {
  const c = COLORS[theme];
  return [
    {
      id: PLAN_BREAK_LAYER,
      type: "circle",
      source: PLAN_SOURCE,
      filter: ["==", ["get", "role"], "break"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 14, 3.5, 18, 5],
        "circle-color": c.casing,
        "circle-stroke-color": c.finish,
        "circle-stroke-width": 1.5,
      },
    },
    {
      id: "course-ends",
      type: "circle",
      source: COURSE_SOURCE,
      filter: ENDS,
      paint: {
        "circle-radius": 6.5,
        "circle-color": ["match", ["get", "role"], "start", c.line, c.finish],
        "circle-stroke-color": c.casing,
        "circle-stroke-width": 3,
      },
    },
  ];
}

/**
 * `style` with the course and plan sources and layers added, holding `data` and `plan`, with plan
 * segment `selected` picked.
 */
export function withCourse(
  style: StyleSpecification,
  theme: Theme,
  data: CourseFeatures,
  plan: CourseFeatures = NO_COURSE,
  selected: number | null = null,
): StyleSpecification {
  const source: GeoJSONSourceSpecification = { type: "geojson", data, tolerance: 0.5 };
  const planSource: GeoJSONSourceSpecification = { type: "geojson", data: plan, tolerance: 0.5 };
  const firstLabel = style.layers.findIndex((l) => l.type === "symbol");
  const at = firstLabel === -1 ? style.layers.length : firstLabel;
  return {
    ...style,
    sources: { ...style.sources, [COURSE_SOURCE]: source, [PLAN_SOURCE]: planSource },
    layers: [
      ...style.layers.slice(0, at),
      ...lineLayers(theme, selected, plan.features.length > 0),
      ...style.layers.slice(at),
      ...pointLayers(theme),
    ],
  };
}
