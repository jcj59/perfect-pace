/**
 * The route being drawn, on the map. Its legs are lines in a GeoJSON source of their own (solid
 * once routed, dashed while routing, dashed in the danger color when routing failed), and its
 * waypoints and leg midpoints are DOM markers, so they take the pointer and touch like buttons:
 *
 * - drag a waypoint to move it, click or tap it to remove it
 * - drag a leg's midpoint handle to insert a waypoint there (a click inserts it at the midpoint)
 *
 * While a handle is dragged, the legs it touches are previewed as dashed straight lines to the
 * pointer. Nothing is routed until it is dropped, so a drag costs one edit and its two legs.
 */
import { type LatLon, type LegMode, lineMidpoint } from "@pp/core";
import {
  type ExpressionSpecification,
  type GeoJSONSourceSpecification,
  type LayerSpecification,
  type Map as MapLibreMap,
  Marker,
  type StyleSpecification,
} from "maplibre-gl";
import type { Theme } from "../state/app.ts";

export const DRAW_SOURCE = "draw";
const DRAW_LINE_LAYER = "draw-line";

/** A leg as the map draws it. */
export interface DrawLeg {
  points: readonly LatLon[];
  status: "pending" | "ready" | "error";
  mode: LegMode;
}

/** The route being drawn, for the map. */
export interface DrawingView {
  waypoints: readonly LatLon[];
  legs: readonly DrawLeg[];
}

/** An edit made on the map. */
export type MapDrawEdit =
  | { type: "add"; at: LatLon }
  | { type: "move"; index: number; to: LatLon }
  | { type: "insert"; leg: number; at: LatLon }
  | { type: "remove"; index: number };

/** A handle being dragged: waypoint `index` to `at`, or a new waypoint in leg `leg` at `at`. */
export type DrawPreview = { kind: "move"; index: number; at: LatLon } | { kind: "insert"; leg: number; at: LatLon };

type Coordinates = [number, number][];
type LegStyle = DrawLeg["status"] | "preview";
interface DrawFeature {
  type: "Feature";
  properties: { style: LegStyle };
  geometry: { type: "LineString"; coordinates: Coordinates };
}
export interface DrawFeatures {
  type: "FeatureCollection";
  features: DrawFeature[];
}

export const NO_DRAWING: DrawFeatures = { type: "FeatureCollection", features: [] };

const line = (points: readonly LatLon[], style: LegStyle): DrawFeature => ({
  type: "Feature",
  properties: { style },
  geometry: { type: "LineString", coordinates: points.map((p) => [p.lon, p.lat]) },
});

/**
 * The leg lines for the map, with `preview` (a handle being dragged) replacing the legs it
 * touches by straight lines to the pointer.
 */
export function drawFeatures(view: DrawingView | null, preview: DrawPreview | null = null): DrawFeatures {
  if (!view) return NO_DRAWING;
  const { waypoints, legs } = view;
  const features: DrawFeature[] = [];
  legs.forEach((leg, i) => {
    if (preview?.kind === "move" && (preview.index === i || preview.index === i + 1)) return;
    if (preview?.kind === "insert" && preview.leg === i) return;
    if (leg.points.length >= 2) features.push(line(leg.points, leg.status));
  });
  if (preview?.kind === "move") {
    const before = waypoints[preview.index - 1];
    const after = waypoints[preview.index + 1];
    if (before) features.push(line([before, preview.at], "preview"));
    if (after) features.push(line([preview.at, after], "preview"));
  } else if (preview?.kind === "insert") {
    const from = waypoints[preview.leg];
    const to = waypoints[preview.leg + 1];
    if (from && to) features.push(line([from, preview.at, to], "preview"));
  }
  return { type: "FeatureCollection", features };
}

const COLORS: Record<Theme, { line: string; casing: string; danger: string; pending: string }> = {
  light: { line: "#23864f", casing: "#ffffff", danger: "#b42318", pending: "#57534e" },
  dark: { line: "#4cc283", casing: "#0f0e0e", danger: "#fb8a7e", pending: "#b4ada7" },
};

const styleIs = (...styles: LegStyle[]): ExpressionSpecification => ["match", ["get", "style"], styles, true, false];

function lineWidth(base: number): ExpressionSpecification {
  return ["interpolate", ["linear"], ["zoom"], 8, base * 0.6, 14, base, 18, base * 1.6];
}

function drawLayers(theme: Theme): LayerSpecification[] {
  const c = COLORS[theme];
  const round = { "line-join": "round", "line-cap": "round" } as const;
  return [
    {
      id: "draw-casing",
      type: "line",
      source: DRAW_SOURCE,
      filter: styleIs("ready"),
      layout: round,
      paint: { "line-width": lineWidth(8), "line-color": c.casing, "line-opacity": 0.9 },
    },
    {
      id: DRAW_LINE_LAYER,
      type: "line",
      source: DRAW_SOURCE,
      filter: styleIs("ready"),
      layout: round,
      paint: { "line-width": lineWidth(4.5), "line-color": c.line },
    },
    {
      id: "draw-pending",
      type: "line",
      source: DRAW_SOURCE,
      filter: styleIs("pending", "preview"),
      layout: round,
      paint: { "line-width": lineWidth(3.5), "line-color": c.pending, "line-dasharray": [1.5, 1.5] },
    },
    {
      id: "draw-error",
      type: "line",
      source: DRAW_SOURCE,
      filter: styleIs("error"),
      layout: round,
      paint: { "line-width": lineWidth(3.5), "line-color": c.danger, "line-dasharray": [1.5, 1.5] },
    },
  ];
}

/** `style` with the drawing source and its layers on top, holding `data`. */
export function withDrawing(style: StyleSpecification, theme: Theme, data: DrawFeatures): StyleSpecification {
  const source: GeoJSONSourceSpecification = { type: "geojson", data, tolerance: 0.5 };
  return {
    ...style,
    sources: { ...style.sources, [DRAW_SOURCE]: source },
    layers: [...style.layers, ...drawLayers(theme)],
  };
}

/** Clicks within this long after a drag ends belong to the drag (the pointer lifts over the handle). */
const CLICK_AFTER_DRAG_MS = 350;
/** A leg shorter than this on screen gets no midpoint handle: it would crowd its two waypoints. */
const MIN_HANDLE_LEG_PX = 64;

export interface DrawHandleCallbacks {
  onEdit: (edit: MapDrawEdit) => void;
  onPreview: (preview: DrawPreview | null) => void;
}

const toLatLon = (marker: Marker): LatLon => {
  const { lat, lng } = marker.getLngLat();
  return { lat, lon: lng };
};

function waypointLabel(index: number, count: number): string {
  if (index === 0) return count === 1 ? "Remove the start point" : "Remove point 1 (start)";
  if (index === count - 1) return `Remove point ${index + 1} (finish)`;
  return `Remove point ${index + 1}`;
}

/**
 * The waypoint and midpoint markers of the route being drawn, kept in step with it by `update`.
 * Markers are reused by position in the route, so an edit moves them instead of rebuilding them.
 */
export class DrawHandles {
  private readonly waypoints: Marker[] = [];
  private readonly midpoints: Marker[] = [];
  private view: DrawingView = { waypoints: [], legs: [] };

  constructor(
    private readonly map: MapLibreMap,
    private readonly callbacks: DrawHandleCallbacks,
  ) {
    map.on("zoom", this.placeMidpoints);
  }

  /** When each handle's last drag ended, so the click that ends a drag is not taken as a tap on it. */
  private readonly dragEnds = new WeakMap<Marker, number>();
  private readonly dragged = (marker: Marker): boolean =>
    performance.now() - (this.dragEnds.get(marker) ?? -Infinity) < CLICK_AFTER_DRAG_MS;

  private waypointMarker(): Marker {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "pp-waypoint";
    element.dataset["testid"] = "waypoint";
    element.append(document.createElement("span"));
    const marker = new Marker({ element, draggable: true });
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!this.dragged(marker)) this.callbacks.onEdit({ type: "remove", index: Number(element.dataset["index"]) });
    });
    element.addEventListener("dblclick", (event) => event.stopPropagation());
    marker.on("drag", () =>
      this.callbacks.onPreview({ kind: "move", index: Number(element.dataset["index"]), at: toLatLon(marker) }),
    );
    marker.on("dragend", () => {
      this.dragEnds.set(marker, performance.now());
      const i = Number(element.dataset["index"]);
      this.callbacks.onPreview(null);
      this.callbacks.onEdit({ type: "move", index: i, to: toLatLon(marker) });
      // Until the route comes back with the move, keep the marker where it was dropped. If the
      // edit changed nothing, put it back.
      const at = this.view.waypoints[i];
      if (at) marker.setLngLat([at.lon, at.lat]);
    });
    return marker;
  }

  private midpointMarker(): Marker {
    const element = document.createElement("div");
    element.className = "pp-midpoint";
    element.dataset["testid"] = "leg-midpoint";
    element.setAttribute("aria-hidden", "true");
    element.append(document.createElement("span"));
    const marker = new Marker({ element, draggable: true });
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!this.dragged(marker))
        this.callbacks.onEdit({ type: "insert", leg: Number(element.dataset["leg"]), at: toLatLon(marker) });
    });
    element.addEventListener("dblclick", (event) => event.stopPropagation());
    marker.on("drag", () =>
      this.callbacks.onPreview({ kind: "insert", leg: Number(element.dataset["leg"]), at: toLatLon(marker) }),
    );
    marker.on("dragend", () => {
      this.dragEnds.set(marker, performance.now());
      this.callbacks.onPreview(null);
      this.callbacks.onEdit({ type: "insert", leg: Number(element.dataset["leg"]), at: toLatLon(marker) });
    });
    return marker;
  }

  /** Match the markers to `view`: one per waypoint, one per leg (hidden when the leg is short on screen). */
  update(view: DrawingView): void {
    this.view = view;
    const { waypoints, legs } = view;
    while (this.waypoints.length > waypoints.length) this.waypoints.pop()?.remove();
    while (this.waypoints.length < waypoints.length) {
      this.waypoints.push(this.waypointMarker().setLngLat([0, 0]).addTo(this.map));
    }
    waypoints.forEach((p, i) => {
      const marker = this.waypoints[i]!;
      marker.setLngLat([p.lon, p.lat]);
      const element = marker.getElement();
      element.dataset["index"] = String(i);
      element.dataset["role"] = i === 0 ? "start" : i === waypoints.length - 1 ? "finish" : "via";
      element.dataset["lat"] = String(p.lat);
      element.dataset["lon"] = String(p.lon);
      element.setAttribute("aria-label", waypointLabel(i, waypoints.length));
      element.title = "Drag to move, click to remove";
    });
    while (this.midpoints.length > legs.length) this.midpoints.pop()?.remove();
    while (this.midpoints.length < legs.length)
      this.midpoints.push(this.midpointMarker().setLngLat([0, 0]).addTo(this.map));
    this.placeMidpoints();
  }

  private readonly placeMidpoints = (): void => {
    this.view.legs.forEach((leg, i) => {
      const marker = this.midpoints[i];
      if (!marker) return;
      const at = lineMidpoint(leg.points);
      const from = this.view.waypoints[i];
      const to = this.view.waypoints[i + 1];
      const element = marker.getElement();
      element.dataset["leg"] = String(i);
      if (!at || !from || !to) return;
      marker.setLngLat([at.lon, at.lat]);
      const a = this.map.project([from.lon, from.lat]);
      const b = this.map.project([to.lon, to.lat]);
      element.style.display = a.dist(b) < MIN_HANDLE_LEG_PX ? "none" : "";
    });
  };

  remove(): void {
    this.map.off("zoom", this.placeMidpoints);
    for (const marker of [...this.waypoints, ...this.midpoints]) marker.remove();
    this.waypoints.length = 0;
    this.midpoints.length = 0;
  }
}
