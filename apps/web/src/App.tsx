import { Suspense, lazy, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { BottomSheet } from "./layout/BottomSheet.tsx";
import { SIDE_PANEL_GAP_PX, SidePanel } from "./layout/SidePanel.tsx";
import { usePanelWidth } from "./layout/usePanelWidth.ts";
import { SHEET_PEEK_PX, snapHeights } from "./layout/sheet.ts";
import { DESKTOP_QUERY, subscribeResize, useMediaQuery } from "./layout/useMediaQuery.ts";
import { DrawButton } from "./draw/DrawButton.tsx";
import { DrawToolbar } from "./draw/DrawToolbar.tsx";
import { RouteEditor } from "./draw/RouteEditor.tsx";
import type { MapSegment } from "./map/course-layer.ts";
import type { DrawingView, MapDrawEdit } from "./map/draw-layer.ts";
import type { Insets, MapViewProps } from "./map/MapView.tsx";
import { CourseSummary, DrawnCourseSummary } from "./panel/CourseSummary.tsx";
import { formatDistance } from "./panel/format.ts";
import { DropOverlay } from "./panel/DropOverlay.tsx";
import { EmptyState } from "./panel/EmptyState.tsx";
import { FileButton } from "./panel/FileButton.tsx";
import { LinkError } from "./panel/LinkError.tsx";
import { LoadError } from "./panel/LoadError.tsx";
import { courseName } from "./plan/export.ts";
import { PaceBand } from "./print/PaceBand.tsx";
import { startSession, startView } from "./state/session.ts";
import { keepsStartCamera, releaseStartCamera, saveCamera, startCameraSaving } from "./state/camera.ts";
import { PanelHeader } from "./panel/PanelHeader.tsx";
import { ThemeSwitch } from "./panel/ThemeSwitch.tsx";
import { type CourseState, type SheetSnap, setSheet, useAppState } from "./state/app.ts";
import { drawStore, drawing, useDrawState } from "./state/draw.ts";
import { LOAD_MEASURE, LOAD_START_MARK, ROUTE_DRAWN_MARK } from "./state/course.ts";
import { focusNearest, focusPosition, readyProfile } from "./state/focus.ts";
import { startPlanner, usePlanView } from "./state/plan.ts";
import { segmentTone } from "./plan/tones.ts";
import { useApplyTheme, useTheme } from "./theme.ts";
import { warmUpCoreWorker } from "./worker/client.ts";

// MapLibre is most of the bundle; load it beside the panel instead of before it.
const MapView = lazy(() => import("./map/MapView.tsx"));

const PANEL_LABEL = "Course panel";

/** The phone map's insets: the sheet's footprint at `peek`, else at `half` (above that it covers most of the map). */
function usePhoneInsets(sheet: SheetSnap): Insets {
  const height = useSyncExternalStore(subscribeResize, () => window.innerHeight);
  const bottom = sheet === "peek" ? SHEET_PEEK_PX : snapHeights(height).half;
  return useMemo(() => ({ top: 0, right: 0, bottom, left: 0 }), [bottom]);
}

/** Once a new route is on screen: close the load measure that the perf budget reads. */
function markRouteDrawn(): void {
  if (performance.getEntriesByName(LOAD_START_MARK, "mark").length === 0) return;
  performance.mark(ROUTE_DRAWN_MARK);
  performance.measure(LOAD_MEASURE, LOAD_START_MARK, ROUTE_DRAWN_MARK);
}

/** An edit on the map, as a drawing action: a new waypoint's leg gets the mode picked for new legs. */
function drawOnMap(edit: MapDrawEdit): void {
  drawing.dispatch(edit.type === "add" ? { ...edit, mode: drawStore.get().newLegMode } : edit);
}

/** The route being drawn, for the map, or null when not drawing. */
function useDrawingView(): DrawingView | null {
  const editing = useDrawState((s) => s.editing);
  const waypoints = useDrawState((s) => s.history.present.waypoints);
  const legs = useDrawState((s) => s.legs);
  return useMemo(() => (editing ? { waypoints, legs } : null), [editing, waypoints, legs]);
}

/**
 * The map with the course marker at the focused point, and the route being drawn. Its own
 * component, so pointing along the course re-renders only the map, not the panel around it.
 */
function CourseMap(
  props: Omit<
    MapViewProps,
    | "marker"
    | "onRouteHover"
    | "segments"
    | "selectedSegment"
    | "route"
    | "drawing"
    | "onDrawEdit"
    | "camera"
    | "initialCamera"
    | "keepCamera"
    | "onCameraChange"
  >,
) {
  const course = useAppState((s) => s.course);
  const drawingView = useDrawingView();
  const camera = useDrawState((s) => s.camera);
  const focusDistM = useAppState((s) => s.focusDistM);
  const selectedSegment = useAppState((s) => s.selectedSegment);
  const planProfile = usePlanView((v) => v.profile);
  const plan = usePlanView((v) => v.plan);
  const profile = readyProfile(course);
  const marker = useMemo(() => focusPosition(profile, focusDistM), [profile, focusDistM]);
  // The first view (B10): the saved camera when it wins the start-up precedence, else the whole US.
  const [start] = useState(startView);
  const drawingOn = drawingView !== null;
  // A route the user draws is framed when it is done, even while the restored course is on its way.
  useEffect(() => {
    if (drawingOn) releaseStartCamera();
  }, [drawingOn]);
  // Each segment's stretch of the profile's points (which lie on the route), in its tone.
  // While drawing, the map shows the legs as they are routed; the plan's colors come back after.
  const segments = useMemo<MapSegment[] | null>(
    () =>
      !drawingView && plan && profile && planProfile === profile
        ? plan.segments.map((s) => ({
            points: profile.course.points.slice(s.startIndex, s.endIndex + 1),
            tone: segmentTone(s.paceSPerM, plan.flatPaceSPerM),
          }))
        : null,
    [plan, planProfile, profile, drawingView],
  );
  const route =
    course.status === "loaded"
      ? (course.file.tracks[course.track]?.course.points ?? null)
      : course.status === "drawn" && !drawingView
        ? (course.course?.points ?? null)
        : null;
  return (
    <MapView
      {...props}
      route={route}
      drawing={drawingView}
      onDrawEdit={drawOnMap}
      camera={camera}
      initialCamera={start.kind === "saved" ? start.camera : null}
      keepCamera={keepsStartCamera}
      onCameraChange={saveCamera}
      marker={marker}
      onRouteHover={focusNearest}
      segments={segments}
      selectedSegment={selectedSegment}
    />
  );
}

/** What the panel shows for the course state, in the side panel or (`sheet`) the phone's bottom sheet. */
function PanelContent({ course, sheet = false }: { course: CourseState; sheet?: boolean }) {
  const linkError = useAppState((s) => s.linkError);
  return (
    <>
      {linkError && (
        <div className="px-6 pt-2 pb-4">
          <LinkError message={linkError} />
        </div>
      )}
      <CourseContent course={course} sheet={sheet} />
    </>
  );
}

function CourseContent({ course, sheet }: { course: CourseState; sheet: boolean }) {
  const editing = useDrawState((s) => s.editing);
  switch (course.status) {
    case "loaded":
      return <CourseSummary course={course} profileFirst={sheet} />;
    case "drawn":
      return <DrawnCourseSummary course={course} editing={editing} editor={<RouteEditor />} profileFirst={sheet} />;
    case "error":
      return (
        <>
          <div className="px-6 pt-2">
            <LoadError fileName={course.fileName} message={course.message} />
          </div>
          <EmptyState upload={false} />
        </>
      );
    default:
      return <EmptyState />;
  }
}

/**
 * The phone header's action at `peek`, where nothing else of the panel shows: the ways in before
 * there is a course, and while drawing the live distance and Done.
 */
function PhoneHeaderAction({ course }: { course: CourseState }) {
  const editing = useDrawState((s) => s.editing);
  const distanceM = useDrawState((s) => s.distanceM);
  const waypoints = useDrawState((s) => s.history.present.waypoints.length);
  const units = useAppState((s) => s.units);
  if (course.status === "drawn" && editing) {
    const distance = formatDistance(distanceM, units);
    return (
      <div className="flex shrink-0 items-center gap-2.5">
        <span className="text-[15px] font-semibold text-ink tabular-nums" data-testid="draw-distance-compact">
          {distance.value}
          <span className="ml-0.5 text-[13px] font-medium text-ink-muted">{distance.unit}</span>
        </span>
        <button
          type="button"
          onClick={drawing.finish}
          className="inline-flex h-9 shrink-0 cursor-pointer items-center rounded-full bg-accent px-3.5 text-[13px] font-semibold text-on-accent shadow-sm hover:brightness-105 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none"
        >
          {waypoints >= 2 ? "Done" : "Cancel"}
        </button>
      </div>
    );
  }
  // An error raises the sheet, and its card has its own buttons.
  if (course.status !== "empty") return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <FileButton variant="compact" aria-label="Load GPX">
        GPX
      </FileButton>
      <DrawButton variant="compact" aria-label="Draw route">
        Draw
      </DrawButton>
    </div>
  );
}

/** The desktop map's insets: the panel at the width it rests at (a drag moves the camera once, at its end). */
function useDesktopInsets(panelWidth: number): Insets {
  return useMemo(() => ({ top: 0, right: 0, bottom: 0, left: panelWidth + SIDE_PANEL_GAP_PX }), [panelWidth]);
}

/** Where the drawing toolbar sits: right of the desktop panel (following a drag), or just above the phone sheet. */
function useToolbarStyle(desktop: boolean, panelWidth: number, insets: Insets, sheet: SheetSnap) {
  return useMemo(
    () =>
      desktop
        ? { top: SIDE_PANEL_GAP_PX, left: panelWidth + SIDE_PANEL_GAP_PX * 2, right: SIDE_PANEL_GAP_PX }
        : sheet === "full"
          ? null
          : { bottom: insets.bottom + 12, left: 12, right: 12 },
    [desktop, panelWidth, insets.bottom, sheet],
  );
}

/** The app shell: a full-bleed map with the panel beside it (desktop) or over it as a sheet (phones). */
export function App() {
  const theme = useTheme();
  useApplyTheme(theme);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const sheet = useAppState((s) => s.sheet);
  const course = useAppState((s) => s.course);
  const phoneInsets = usePhoneInsets(sheet);
  const panel = usePanelWidth();
  const desktopInsets = useDesktopInsets(panel.settledWidth);
  const editing = useDrawState((s) => s.editing);
  const toolbarStyle = useToolbarStyle(desktop, panel.width, phoneInsets, sheet);

  useEffect(() => startPlanner(), []);
  useEffect(() => startSession(), []);
  useEffect(() => startCameraSaving(), []);

  useEffect(() => {
    performance.mark("pp:ready");
    warmUpCoreWorker().catch((error: unknown) => console.error("The core worker did not start", error));
  }, []);

  return (
    <>
      <main className="pp-app relative h-dvh w-full overflow-hidden bg-map text-ink">
        <Suspense fallback={<div className="absolute inset-0 bg-map" data-testid="map" data-map-state="loading" />}>
          <CourseMap
            theme={theme}
            insets={desktop ? desktopInsets : phoneInsets}
            reframeOnInsets={desktop}
            compact={!desktop}
            onRouteDrawn={markRouteDrawn}
          />
        </Suspense>
        {editing && course.status === "drawn" && toolbarStyle && (
          <div
            className={`pointer-events-none absolute z-10 flex ${desktop ? "justify-start" : "justify-center"}`}
            style={toolbarStyle}
          >
            <DrawToolbar placement={desktop ? "top" : "bottom"} />
          </div>
        )}
        {desktop ? (
          <SidePanel
            label={PANEL_LABEL}
            header={<PanelHeader />}
            footer={<ThemeSwitch />}
            width={panel.width}
            range={panel.range}
            onPreview={panel.preview}
            onCommit={panel.commit}
          >
            <PanelContent course={course} />
          </SidePanel>
        ) : (
          <BottomSheet
            label={PANEL_LABEL}
            snap={sheet}
            onSnapChange={setSheet}
            header={<PanelHeader action={<PhoneHeaderAction course={course} />} />}
          >
            <PanelContent course={course} sheet />
            <div className="border-t border-line px-6 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <ThemeSwitch />
            </div>
          </BottomSheet>
        )}
        <DropOverlay />
      </main>
      <PrintedBand course={course} />
    </>
  );
}

/** The pace band for printing, while there is a plan for the course on screen. */
function PrintedBand({ course }: { course: CourseState }) {
  const units = useAppState((s) => s.units);
  const planProfile = usePlanView((v) => v.profile);
  const plan = usePlanView((v) => v.plan);
  const profile = readyProfile(course);
  if (!plan || !profile || planProfile !== profile) return null;
  return <PaceBand plan={plan} units={units} title={courseName(course)} />;
}
