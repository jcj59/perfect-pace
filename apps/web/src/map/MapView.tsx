import "maplibre-gl/dist/maplibre-gl.css";
import type { CoursePoint } from "@pp/core";
import {
  AttributionControl,
  type ControlPosition,
  type GeoJSONSource,
  type IControl,
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
// MapLibre finds its worker next to its own module, which a bundle moves; point it at the built file.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { Theme } from "../state/app.ts";
import {
  COURSE_LINE_LAYER,
  COURSE_SOURCE,
  type CourseFeatures,
  NO_COURSE,
  courseBounds,
  courseFeatures,
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
  /** Called once a new route is on screen (drawn, framed, and every tile in view loaded). */
  onRouteDrawn?: () => void;
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

export default function MapView({ theme, insets, compact, route, onRouteDrawn }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [webgl] = useState(hasWebGL);
  const [state, setState] = useState<MapState>(webgl ? "loading" : "unavailable");
  // The first render's props frame the initial view; later changes go through the effects below.
  const initial = useRef({ theme, insets });
  // The latest insets and route, read when framing a course and when rebuilding the style.
  const latestInsets = useRef(insets);
  const courseData = useRef<CourseFeatures>(NO_COURSE);
  const onDrawn = useRef(onRouteDrawn);
  const [drawnRoute, setDrawnRoute] = useState<readonly CoursePoint[] | null>(null);
  useLayoutEffect(() => {
    latestInsets.current = insets;
    onDrawn.current = onRouteDrawn;
  });

  useEffect(() => {
    const element = container.current;
    if (!element || !webgl) return;
    const { theme, insets } = initial.current;
    let instance: MapLibreMap;
    try {
      instance = new MapLibreMap({
        container: element,
        style: withCourse(mapStyle(theme), theme, courseData.current),
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
    map.current = instance;
    return () => {
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
    map.current?.setStyle(withCourse(mapStyle(theme), theme, courseData.current));
  }, [theme]);

  // Draw a new route, frame it clear of the panel, and report once it is on screen.
  useEffect(() => {
    const data = route ? courseFeatures(route) : NO_COURSE;
    courseData.current = data;
    const instance = map.current;
    if (!instance) return;
    let cancelled = false;
    const confirm = () => {
      if (cancelled || !route) return;
      if (instance.queryRenderedFeatures({ layers: [COURSE_LINE_LAYER] }).length === 0) return;
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
      instance.once("idle", confirm);
    };
    apply();
    return () => {
      cancelled = true;
      instance.off("styledata", apply);
      instance.off("idle", confirm);
    };
  }, [route]);

  const courseState: CourseDrawState = !route ? "none" : drawnRoute === route ? "drawn" : "drawing";

  return (
    <div className="absolute inset-0 bg-map" data-testid="map" data-map-state={state} data-course={courseState}>
      <div ref={container} className="size-full" />
      {state === "unavailable" && (
        <p className="absolute inset-x-0 top-1/3 px-8 text-center text-sm text-ink-muted">
          The map needs WebGL, which this browser has turned off.
        </p>
      )}
    </div>
  );
}
