import "maplibre-gl/dist/maplibre-gl.css";
import type { CoursePoint, LatLon } from "@pp/core";
import {
  AttributionControl,
  type ControlPosition,
  type GeoJSONSource,
  type IControl,
  type MapLayerMouseEvent,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
// MapLibre finds its worker next to its own module, which a bundle moves; point it at the built file.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { Theme } from "../state/app.ts";
import {
  COURSE_HIT_LAYER,
  COURSE_LINE_LAYER,
  COURSE_SOURCE,
  type CourseFeatures,
  type MapSegment,
  NO_COURSE,
  PLAN_HALO_LAYER,
  PLAN_LINE_LAYER,
  PLAN_SOURCE,
  courseBounds,
  courseFeatures,
  planFeatures,
  planPaint,
  routeLineOpacity,
  withCourse,
} from "./course-layer.ts";
import { mapStyle } from "./style.ts";

/** Screen space covered by the panel or sheet, in CSS pixels. The camera keeps content out of it. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** `loading` until the first frame with every tile in view has drawn; `unavailable` without WebGL. */
export type MapState = "loading" | "ready" | "unavailable";

/** The contiguous United States, the view before any course is loaded. */
const INITIAL_BOUNDS: [number, number, number, number] = [-124.8, 24.5, -66.9, 49.4];
const VIEW_MARGIN_PX = 24;
/** Course framing: never closer than this, so a short track still shows its streets. */
const COURSE_MAX_ZOOM = 16;
/** Room around a framed course, so its start and finish dots sit clear of the edges and controls. */
const COURSE_MARGIN_PX = 56;

export interface MapViewProps {
  theme: Theme;
  /** Where the panel sits: the camera frames the initial view and each new course clear of it. */
  insets: Insets;
  /** Desktop gets zoom buttons; phones pinch. */
  compact: boolean;
  /** The course to draw, or null for none. A new array draws it and frames the camera on it. */
  route: readonly CoursePoint[] | null;
  /** Called once a new route is on screen: drawn at its framed view (basemap tiles may still be loading). */
  onRouteDrawn?: () => void;
  /** Where to show the course marker (the point picked on the elevation chart), or null for none. */
  marker?: LatLon | null;
  /**
   * Called with the pointer's position while it hovers the route line (or taps it), and with null
   * once it leaves the line.
   */
  onRouteHover?: (at: LatLon | null) => void;
  /** The plan's segments, drawn over the route in their tones (without moving the camera), or null. */
  segments?: readonly MapSegment[] | null;
  /** The plan segment to highlight (wider, the rest faded), or null. */
  selectedSegment?: number | null;
}

/**
 * Whether the route is on the map, as the `data-course` attribute: `none`, `drawing` (sent to the
 * map, not yet confirmed) or `drawn` (the map has rendered route features in view).
 */
export type CourseDrawState = "none" | "drawing" | "drawn";

function padding(insets: Insets, margin = VIEW_MARGIN_PX) {
  return {
    top: insets.top + margin,
    right: insets.right + margin,
    bottom: insets.bottom + margin,
    left: insets.left + margin,
  };
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

setWorkerUrl(workerUrl);

/** Whether this browser can draw the map. WebGL can be missing, or turned off by policy or a GPU blocklist. */
function hasWebGL(): boolean {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  context?.getExtension("WEBGL_lose_context")?.loseContext();
  return context !== null;
}

/** The marker's element: a dot styled by `.pp-course-marker`, which never takes the pointer. */
function markerElement(): HTMLElement {
  const element = document.createElement("div");
  element.className = "pp-course-marker";
  element.dataset["testid"] = "map-marker";
  element.setAttribute("aria-hidden", "true");
  return element;
}

export default function MapView({
  theme,
  insets,
  compact,
  route,
  onRouteDrawn,
  marker = null,
  onRouteHover,
  segments = null,
  selectedSegment = null,
}: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [webgl] = useState(hasWebGL);
  const [state, setState] = useState<MapState>(webgl ? "loading" : "unavailable");
  // The first render's props frame the initial view; later changes go through the effects below.
  const initial = useRef({ theme, insets });
  // The latest insets and route, read when framing a course and when rebuilding the style.
  const latestInsets = useRef(insets);
  const courseData = useRef<CourseFeatures>(NO_COURSE);
  const planData = useRef<CourseFeatures>(NO_COURSE);
  const latestSelected = useRef(selectedSegment);
  /** Segments the map has rendered of which set, for the `data-segments` attribute (tests wait on it). */
  const [drawnSegments, setDrawnSegments] = useState<{ of: readonly MapSegment[] | null; count: number }>({
    of: null,
    count: 0,
  });
  const onDrawn = useRef(onRouteDrawn);
  const onHover = useRef(onRouteHover);
  const courseMarker = useRef<Marker | null>(null);
  const [drawnRoute, setDrawnRoute] = useState<readonly CoursePoint[] | null>(null);
  useLayoutEffect(() => {
    latestInsets.current = insets;
    onDrawn.current = onRouteDrawn;
    onHover.current = onRouteHover;
  });

  useEffect(() => {
    const element = container.current;
    if (!element || !webgl) return;
    const { theme, insets } = initial.current;
    let instance: MapLibreMap;
    try {
      instance = new MapLibreMap({
        container: element,
        style: withCourse(mapStyle(theme), theme, courseData.current, planData.current, latestSelected.current),
        bounds: INITIAL_BOUNDS,
        fitBoundsOptions: { padding: padding(insets) },
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        fadeDuration: 0,
      });
    } catch (error) {
      console.error("The map could not start", error);
      return;
    }
    instance.touchZoomRotate.disableRotation();
    instance.once("idle", () => setState("ready"));
    // Layer events are matched by layer id, so they keep working across theme (style) switches.
    const hover = (event: MapLayerMouseEvent) => onHover.current?.({ lat: event.lngLat.lat, lon: event.lngLat.lng });
    const leave = () => onHover.current?.(null);
    instance.on("mousemove", COURSE_HIT_LAYER, hover);
    instance.on("click", COURSE_HIT_LAYER, hover);
    instance.on("mouseleave", COURSE_HIT_LAYER, leave);
    map.current = instance;
    return () => {
      courseMarker.current?.remove();
      courseMarker.current = null;
      instance.remove();
      map.current = null;
    };
  }, [webgl]);

  // Phones keep the attribution clear of the bottom sheet and pinch to zoom; desktop gets buttons.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const controls: [IControl, ControlPosition][] = [
      [new AttributionControl({ compact: true }), compact ? "top-right" : "bottom-right"],
    ];
    if (!compact) controls.push([new NavigationControl({ showCompass: false }), "bottom-right"]);
    for (const [control, at] of controls) instance.addControl(control, at);
    // MapLibre opens the compact attribution once the source credits arrive. On a phone that
    // covers the top of the map, so leave it at its info button there (tap to read it).
    const collapse = () =>
      instance.getContainer().querySelector(".maplibregl-compact-show")?.classList.remove("maplibregl-compact-show");
    if (compact) instance.once("idle", collapse);
    return () => {
      instance.off("idle", collapse);
      // Removing the map already removed its controls.
      if (map.current === instance) controls.forEach(([control]) => instance.removeControl(control));
    };
  }, [compact]);

  const styledTheme = useRef(theme);
  useEffect(() => {
    if (theme === styledTheme.current) return; // the map was created with this theme
    styledTheme.current = theme;
    // The course is part of the style, so it survives the switch with its current data.
    map.current?.setStyle(
      withCourse(mapStyle(theme), theme, courseData.current, planData.current, latestSelected.current),
    );
  }, [theme]);

  // Draw a new route, frame it clear of the panel, and report once it is on screen.
  useEffect(() => {
    const data = route ? courseFeatures(route) : NO_COURSE;
    courseData.current = data;
    const instance = map.current;
    if (!instance) return;
    let cancelled = false;
    // Checked after each frame: the camera has settled on the course, the new data is tiled, and
    // the frame drew route features. Basemap tiles are not waited for.
    const confirm = () => {
      if (cancelled || !route || instance.isMoving() || !instance.isSourceLoaded(COURSE_SOURCE)) return;
      if (instance.queryRenderedFeatures({ layers: [COURSE_LINE_LAYER] }).length === 0) return;
      instance.off("render", confirm);
      setDrawnRoute(route);
      onDrawn.current?.();
    };
    const apply = () => {
      if (cancelled) return;
      const source = instance.getSource<GeoJSONSource>(COURSE_SOURCE);
      // Mid style switch the source can be missing for a moment; the new style brings the data.
      if (!source) {
        instance.once("styledata", apply);
        return;
      }
      void source.setData(data);
      const bounds = route && courseBounds(route);
      if (!bounds) return;
      instance.fitBounds(bounds, {
        padding: padding(latestInsets.current, COURSE_MARGIN_PX),
        maxZoom: COURSE_MAX_ZOOM,
        duration: reducedMotion() ? 0 : 700,
      });
      instance.on("render", confirm);
    };
    apply();
    return () => {
      cancelled = true;
      instance.off("styledata", apply);
      instance.off("render", confirm);
    };
  }, [route]);

  // Draw the plan's segments over the route, in place: the camera stays where it is.
  useEffect(() => {
    const data = planFeatures(segments);
    planData.current = data;
    const instance = map.current;
    if (!instance) return;
    let cancelled = false;
    const expected = segments?.length ?? 0;
    const confirm = () => {
      if (cancelled || !instance.isSourceLoaded(PLAN_SOURCE)) return;
      const drawn = new Set(
        instance.queryRenderedFeatures({ layers: [PLAN_LINE_LAYER] }).map((f) => f.properties["index"] as number),
      );
      if (drawn.size < expected) return;
      instance.off("render", confirm);
      setDrawnSegments({ of: segments, count: drawn.size });
    };
    const apply = () => {
      if (cancelled) return;
      const source = instance.getSource<GeoJSONSource>(PLAN_SOURCE);
      if (!source) {
        instance.once("styledata", apply);
        return;
      }
      void source.setData(data);
      instance.setPaintProperty(COURSE_LINE_LAYER, "line-opacity", routeLineOpacity(expected > 0));
      if (expected > 0) instance.on("render", confirm);
    };
    apply();
    return () => {
      cancelled = true;
      instance.off("styledata", apply);
      instance.off("render", confirm);
    };
  }, [segments]);

  // Highlight the selected segment. The style carries it too, for a theme switch.
  useEffect(() => {
    latestSelected.current = selectedSegment;
    const instance = map.current;
    if (!instance?.getLayer(PLAN_LINE_LAYER)) return;
    const paint = planPaint(selectedSegment);
    instance.setPaintProperty(PLAN_LINE_LAYER, "line-opacity", paint.opacity);
    instance.setPaintProperty(PLAN_LINE_LAYER, "line-width", paint.width);
    instance.setFilter(PLAN_HALO_LAYER, paint.halo);
  }, [selectedSegment]);

  // The marker is a DOM element over the map, so moving it costs no map redraw.
  const markerLat = marker?.lat;
  const markerLon = marker?.lon;
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (markerLat === undefined || markerLon === undefined) {
      courseMarker.current?.remove();
      courseMarker.current = null;
      return;
    }
    courseMarker.current ??= new Marker({ element: markerElement() }).setLngLat([markerLon, markerLat]).addTo(instance);
    courseMarker.current.setLngLat([markerLon, markerLat]);
    const { dataset } = courseMarker.current.getElement();
    dataset["lat"] = String(markerLat);
    dataset["lon"] = String(markerLon);
  }, [markerLat, markerLon]);

  const courseState: CourseDrawState = !route ? "none" : drawnRoute === route ? "drawn" : "drawing";

  return (
    <div
      className="absolute inset-0 bg-map"
      data-testid="map"
      data-map-state={state}
      data-course={courseState}
      data-segments={drawnSegments.of === segments ? drawnSegments.count : 0}
      data-selected-segment={selectedSegment ?? undefined}
    >
      <div ref={container} className="size-full" />
      {state === "unavailable" && (
        <p className="absolute inset-x-0 top-1/3 px-8 text-center text-sm text-ink-muted">
          The map needs WebGL, which this browser has turned off.
        </p>
      )}
    </div>
  );
}
