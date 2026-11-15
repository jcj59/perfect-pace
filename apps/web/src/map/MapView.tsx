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
import type { MapCamera } from "../state/camera.ts";
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
import {
  DRAW_SOURCE,
  type DrawFeatures,
  DrawHandles,
  type DrawPreview,
  type DrawingView,
  type MapDrawEdit,
  NO_DRAWING,
  drawFeatures,
  withDrawing,
} from "./draw-layer.ts";
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
/** How long the camera takes to follow the panel to a new width. */
const INSETS_MOVE_MS = 300;
/**
 * Drawing: zoomed out further than this, a click zooms in to `DRAW_ZOOM_IN` there instead of
 * adding a waypoint (a click on a whole-country view can't be meant as one, and its legs would be
 * too long to route).
 */
export const MIN_DRAW_ZOOM = 11;
const DRAW_ZOOM_IN = 14;

/** Where to move the camera; a new `id` moves it again. */
export interface CameraRequest {
  id: number;
  center: LatLon;
  zoom: number;
}

export interface MapViewProps {
  theme: Theme;
  /** Where the panel sits: the camera frames the initial view and each new course clear of it. */
  insets: Insets;
  /**
   * Whether the camera follows a change of `insets` (the desktop panel resized): a course still
   * framed as it was loaded is framed again clear of the panel, and any other view keeps what was
   * in the middle of the visible map there. Without it (the phone sheet) the camera stays put.
   */
  reframeOnInsets?: boolean;
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
  /**
   * The route being drawn, or null when not drawing. While drawing, a click on the map adds a
   * waypoint (see `draw-layer.ts` for the handles), reported through `onDrawEdit`.
   */
  drawing?: DrawingView | null;
  onDrawEdit?: (edit: MapDrawEdit) => void;
  /** Move the camera here, once per `id` (for example to where the user is, to start drawing). */
  camera?: CameraRequest | null;
  /**
   * Where the map starts (read on the first render only), or null for the whole-US view. Its
   * center is the middle of the whole map, as `onCameraChange` reports it.
   */
  initialCamera?: MapCamera | null;
  /**
   * Asked for each new route: true draws it without moving the camera, instead of framing it
   * (the restored course, when the map starts at the saved camera).
   */
  keepCamera?: (route: readonly CoursePoint[]) => boolean;
  /** Called with the camera each time the map comes to rest. */
  onCameraChange?: (camera: MapCamera) => void;
}

/**
 * Whether the route is on the map, as the `data-course` attribute: `none`, `drawing` (sent to the
 * map, not yet confirmed) or `drawn` (the map has rendered route features in view).
 */
export type CourseDrawState = "none" | "drawing" | "drawn";

const sameInsets = (a: Insets, b: Insets) =>
  a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;

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
  reframeOnInsets = false,
  compact,
  route,
  onRouteDrawn,
  marker = null,
  onRouteHover,
  segments = null,
  selectedSegment = null,
  drawing = null,
  onDrawEdit,
  camera = null,
  initialCamera = null,
  keepCamera,
  onCameraChange,
}: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [webgl] = useState(hasWebGL);
  const [state, setState] = useState<MapState>(webgl ? "loading" : "unavailable");
  // The first render's props frame the initial view; later changes go through the effects below.
  const initial = useRef({ theme, insets, initialCamera });
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
  const onEdit = useRef(onDrawEdit);
  const keep = useRef(keepCamera);
  const onCamera = useRef(onCameraChange);
  const drawData = useRef<DrawFeatures>(NO_DRAWING);
  const latestDrawing = useRef(drawing);
  const courseMarker = useRef<Marker | null>(null);
  const [drawnRoute, setDrawnRoute] = useState<readonly CoursePoint[] | null>(null);
  const latestRoute = useRef(route);
  /** Write the route's on-screen box (`data-route-box`) for the camera as it is now. */
  const measureRoute = useRef(() => {});
  /** The route the camera framed, until the user moves the map; then null. */
  const framedRoute = useRef<readonly CoursePoint[] | null>(null);
  /**
   * The route's bounding box on screen (`left top right bottom`, CSS pixels) once the camera
   * rests, as the `data-route-box` attribute, so tests can check it sits clear of the panel.
   */
  const [routeBox, setRouteBox] = useState<{ of: readonly CoursePoint[] | null; box: string }>({ of: null, box: "" });
  /**
   * The camera once it rests (`lat lon zoom`, its center being the middle of the whole map), as
   * the `data-view` attribute, so tests can check a reload brings it back.
   */
  const [view, setView] = useState("");
  useLayoutEffect(() => {
    latestInsets.current = insets;
    latestRoute.current = route;
    onDrawn.current = onRouteDrawn;
    onHover.current = onRouteHover;
    onEdit.current = onDrawEdit;
    keep.current = keepCamera;
    onCamera.current = onCameraChange;
    latestDrawing.current = drawing;
  });

  useEffect(() => {
    const element = container.current;
    if (!element || !webgl) return;
    const { theme, insets, initialCamera } = initial.current;
    // Start right at the saved view (no move from the whole US), or fit the whole US clear of the panel.
    const start = initialCamera
      ? { center: [initialCamera.center.lon, initialCamera.center.lat] as [number, number], zoom: initialCamera.zoom }
      : { bounds: INITIAL_BOUNDS, fitBoundsOptions: { padding: padding(insets) } };
    let instance: MapLibreMap;
    try {
      instance = new MapLibreMap({
        container: element,
        style: withDrawing(
          withCourse(mapStyle(theme), theme, courseData.current, planData.current, latestSelected.current),
          theme,
          drawData.current,
        ),
        ...start,
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
    // A pan or zoom by the user (it carries the input event) leaves the framed view behind.
    instance.on("movestart", (event) => {
      if (event.originalEvent) framedRoute.current = null;
    });
    const rest = (report: boolean) => {
      // The middle of the whole map, not of the part clear of the panel: a camera request moves
      // with padding, which `getCenter` would count.
      const { clientWidth, clientHeight } = instance.getContainer();
      const middle = instance.unproject([clientWidth / 2, clientHeight / 2]).wrap();
      const zoom = instance.getZoom();
      setView(`${middle.lat.toFixed(6)} ${middle.lng.toFixed(6)} ${zoom.toFixed(3)}`);
      if (report) onCamera.current?.({ center: { lat: middle.lat, lon: middle.lng }, zoom });
      measureRoute.current();
    };
    measureRoute.current = () => {
      const shown = latestRoute.current;
      const bounds = shown && courseBounds(shown);
      if (!bounds) return;
      const [west, south, east, north] = bounds;
      const a = instance.project([west, north]);
      const b = instance.project([east, south]);
      setRouteBox({ of: shown, box: [a.x, a.y, b.x, b.y].map(Math.round).join(" ") });
    };
    instance.on("moveend", () => rest(true));
    // The first view shows in `data-view` too, but only a move is kept: a start at the whole-US
    // view must never be saved over the course the session is about to frame.
    instance.once("load", () => rest(false));
    // Layer events are matched by layer id, so they keep working across theme (style) switches.
    const hover = (event: MapLayerMouseEvent) => onHover.current?.({ lat: event.lngLat.lat, lon: event.lngLat.lng });
    const leave = () => onHover.current?.(null);
    instance.on("mousemove", COURSE_HIT_LAYER, hover);
    instance.on("click", COURSE_HIT_LAYER, hover);
    instance.on("mouseleave", COURSE_HIT_LAYER, leave);
    // Drawing: a click on the map itself (not on a handle or a control) adds a waypoint.
    instance.on("click", (event) => {
      if (!latestDrawing.current || !(event.originalEvent.target instanceof HTMLCanvasElement)) return;
      if (instance.getZoom() < MIN_DRAW_ZOOM) {
        instance.easeTo({ center: event.lngLat, zoom: DRAW_ZOOM_IN, duration: reducedMotion() ? 0 : 600 });
        return;
      }
      onEdit.current?.({ type: "add", at: { lat: event.lngLat.lat, lon: event.lngLat.lng } });
    });
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
      withDrawing(
        withCourse(mapStyle(theme), theme, courseData.current, planData.current, latestSelected.current),
        theme,
        drawData.current,
      ),
    );
  }, [theme]);

  // Draw a new route, frame it clear of the panel, and report once it is on screen.
  useEffect(() => {
    const data = route ? courseFeatures(route) : NO_COURSE;
    courseData.current = data;
    framedRoute.current = null;
    const instance = map.current;
    if (!instance) return;
    let cancelled = false;
    // The restored course at the saved camera is drawn where it is; any other is framed.
    const kept = route !== null && (keep.current?.(route) ?? false);
    // Checked after each frame: the camera has settled on the course, the new data is tiled, and
    // the frame drew route features. Basemap tiles are not waited for. A course left where the
    // saved camera is may be out of view, so it only needs to be tiled.
    const confirm = () => {
      if (cancelled || !route || instance.isMoving() || !instance.isSourceLoaded(COURSE_SOURCE)) return;
      if (!kept && instance.queryRenderedFeatures({ layers: [COURSE_LINE_LAYER] }).length === 0) return;
      instance.off("render", confirm);
      if (kept) measureRoute.current();
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
      if (kept) {
        instance.on("render", confirm);
        return;
      }
      instance.fitBounds(bounds, {
        padding: padding(latestInsets.current, COURSE_MARGIN_PX),
        maxZoom: COURSE_MAX_ZOOM,
        duration: reducedMotion() ? 0 : 700,
      });
      framedRoute.current = route;
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

  // The route being drawn: its legs in the draw source, its waypoints and midpoints as handles.
  const handles = useRef<DrawHandles | null>(null);
  const preview = useRef<DrawPreview | null>(null);
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    // Reads the refs, so the handles' preview callback (made once) always draws the latest route.
    const show = () => {
      const data = drawFeatures(latestDrawing.current, preview.current);
      drawData.current = data;
      void instance.getSource<GeoJSONSource>(DRAW_SOURCE)?.setData(data);
    };
    if (!drawing) {
      handles.current?.remove();
      handles.current = null;
      preview.current = null;
      show();
      return;
    }
    handles.current ??= new DrawHandles(instance, {
      onEdit: (edit) => onEdit.current?.(edit),
      onPreview: (next) => {
        preview.current = next;
        show();
      },
    });
    handles.current.update(drawing);
    show();
  }, [drawing]);

  const isDrawing = drawing !== null;
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    // Two quick clicks are two waypoints while drawing, not a zoom.
    if (isDrawing) instance.doubleClickZoom.disable();
    else instance.doubleClickZoom.enable();
    instance.getCanvas().style.cursor = isDrawing ? "crosshair" : "";
  }, [isDrawing]);

  useEffect(
    () => () => {
      handles.current?.remove();
      handles.current = null;
    },
    [],
  );

  const latestCamera = useRef(camera);
  /** The last camera request the map has finished moving to, for the `data-camera` attribute. */
  const [cameraDone, setCameraDone] = useState<number | null>(null);
  useLayoutEffect(() => {
    latestCamera.current = camera;
  });
  // Only a new request moves the camera, not a re-render with the same one.
  const cameraId = camera?.id;
  useEffect(() => {
    const instance = map.current;
    const camera = latestCamera.current;
    if (!instance || !camera || cameraId === undefined) return;
    const done = () => setCameraDone(cameraId);
    framedRoute.current = null;
    instance.once("moveend", done);
    instance.flyTo({
      center: [camera.center.lon, camera.center.lat],
      zoom: camera.zoom,
      padding: padding(latestInsets.current, 0),
      duration: reducedMotion() ? 0 : 1200,
    });
    return () => {
      instance.off("moveend", done);
    };
  }, [cameraId]);

  // Follow the panel to a new width (once it settles: the app passes the width a drag ends at).
  const placedInsets = useRef(insets);
  useEffect(() => {
    const previous = placedInsets.current;
    placedInsets.current = insets;
    const instance = map.current;
    if (!instance || !reframeOnInsets || sameInsets(previous, insets)) return;
    // A smaller window can be what moved the panel: measure the map first (its own resize
    // observer runs later), so the camera is worked out for the size it now is.
    instance.resize();
    const duration = reducedMotion() ? 0 : INSETS_MOVE_MS;
    const framed = framedRoute.current;
    const bounds = framed && courseBounds(framed);
    if (bounds) {
      instance.fitBounds(bounds, { padding: padding(insets, COURSE_MARGIN_PX), maxZoom: COURSE_MAX_ZOOM, duration });
      return;
    }
    // Keep the middle of the visible map where it was: it moves by half the change on each axis.
    const dx = insets.left - previous.left - (insets.right - previous.right);
    const dy = insets.top - previous.top - (insets.bottom - previous.bottom);
    instance.panBy([-dx / 2, -dy / 2], { duration });
  }, [insets, reframeOnInsets]);

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
      data-drawing={drawing ? "on" : undefined}
      data-camera={cameraDone ?? undefined}
      data-route-box={route && routeBox.of === route ? routeBox.box : undefined}
      data-view={view || undefined}
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
