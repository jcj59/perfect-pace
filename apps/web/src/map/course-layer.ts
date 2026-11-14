/**
 * The course on the map: a GeoJSON source with the route line and its start and finish points,
 * drawn over the roads and under the place labels (the start and finish dots go over everything).
 * It is part of the style itself, so a theme change restyles it without losing the data.
 */
import type { CoursePoint } from "@pp/core";
import type {
  ExpressionSpecification,
  GeoJSONSourceSpecification,
  LayerSpecification,
  StyleSpecification,
} from "maplibre-gl";
import type { Theme } from "../state/app.ts";

export const COURSE_SOURCE = "course";
export const COURSE_LINE_LAYER = "course-line";

type Coordinates = [number, number][];

export interface CourseFeatures {
  type: "FeatureCollection";
  features: (
    | { type: "Feature"; properties: { role: "route" }; geometry: { type: "LineString"; coordinates: Coordinates } }
    | {
        type: "Feature";
        properties: { role: "start" | "finish" };
        geometry: { type: "Point"; coordinates: [number, number] };
      }
  )[];
}

export const NO_COURSE: CourseFeatures = { type: "FeatureCollection", features: [] };

/** The route line plus start and finish points for a course, as GeoJSON (longitude first). */
export function courseFeatures(points: readonly CoursePoint[]): CourseFeatures {
  const coordinates: Coordinates = points.map((p) => [p.lon, p.lat]);
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

/** A line `base` px wide at zoom 14, thinner zoomed out and wider zoomed in. */
function lineWidth(base: number): ExpressionSpecification {
  return ["interpolate", ["linear"], ["zoom"], 8, base * 0.6, 14, base, 18, base * 1.6];
}

function lineLayers(theme: Theme): LayerSpecification[] {
  const c = COLORS[theme];
  return [
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
      paint: { "line-width": lineWidth(4.5), "line-color": c.line },
    },
  ];
}

function pointLayers(theme: Theme): LayerSpecification[] {
  const c = COLORS[theme];
  return [
    {
      id: "course-ends",
      type: "circle",
      source: COURSE_SOURCE,
      filter: ["!=", ["get", "role"], "route"],
      paint: {
        "circle-radius": 6.5,
        "circle-color": ["match", ["get", "role"], "start", c.line, c.finish],
        "circle-stroke-color": c.casing,
        "circle-stroke-width": 3,
      },
    },
  ];
}

/** `style` with the course source and layers added, holding `data`. */
export function withCourse(style: StyleSpecification, theme: Theme, data: CourseFeatures): StyleSpecification {
  const source: GeoJSONSourceSpecification = { type: "geojson", data, tolerance: 0.5 };
  const firstLabel = style.layers.findIndex((l) => l.type === "symbol");
  const at = firstLabel === -1 ? style.layers.length : firstLabel;
  return {
    ...style,
    sources: { ...style.sources, [COURSE_SOURCE]: source },
    layers: [...style.layers.slice(0, at), ...lineLayers(theme), ...style.layers.slice(at), ...pointLayers(theme)],
  };
}
