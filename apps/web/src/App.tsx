import { Suspense, lazy, useEffect, useMemo, useSyncExternalStore } from "react";
import { BottomSheet } from "./layout/BottomSheet.tsx";
import { SIDE_PANEL_GAP_PX, SIDE_PANEL_WIDTH_PX, SidePanel } from "./layout/SidePanel.tsx";
import { SHEET_PEEK_PX, snapHeights } from "./layout/sheet.ts";
import { DESKTOP_QUERY, useMediaQuery } from "./layout/useMediaQuery.ts";
import type { Insets } from "./map/MapView.tsx";
import { CourseSummary } from "./panel/CourseSummary.tsx";
import { DropOverlay } from "./panel/DropOverlay.tsx";
import { EmptyState } from "./panel/EmptyState.tsx";
import { FileButton } from "./panel/FileButton.tsx";
import { LoadError } from "./panel/LoadError.tsx";
import { PanelHeader } from "./panel/PanelHeader.tsx";
import { ThemeSwitch } from "./panel/ThemeSwitch.tsx";
import { type CourseState, type SheetSnap, setSheet, useAppState } from "./state/app.ts";
import { LOAD_MEASURE, LOAD_START_MARK, ROUTE_DRAWN_MARK } from "./state/course.ts";
import { useApplyTheme, useTheme } from "./theme.ts";
import { warmUpCoreWorker } from "./worker/client.ts";

// MapLibre is most of the bundle; load it beside the panel instead of before it.
const MapView = lazy(() => import("./map/MapView.tsx"));

const PANEL_LABEL = "Course panel";
const DESKTOP_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: SIDE_PANEL_WIDTH_PX + SIDE_PANEL_GAP_PX };

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

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

/** What the panel shows for the course state, the same in the side panel and the sheet. */
function PanelContent({ course }: { course: CourseState }) {
  switch (course.status) {
    case "loaded":
      return <CourseSummary course={course} />;
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

/** The app shell: a full-bleed map with the panel beside it (desktop) or over it as a sheet (phones). */
export function App() {
  const theme = useTheme();
  useApplyTheme(theme);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const sheet = useAppState((s) => s.sheet);
  const course = useAppState((s) => s.course);
  const phoneInsets = usePhoneInsets(sheet);
  const route = course.status === "loaded" ? (course.file.tracks[course.track]?.course.points ?? null) : null;
  // At peek only the header shows, so on a phone it carries the way in until there is a course.
  // (An error raises the sheet, and its card has its own button.)
  const headerAction = course.status === "empty" ? <FileButton variant="compact">Load GPX</FileButton> : null;

  useEffect(() => {
    performance.mark("pp:ready");
    warmUpCoreWorker().catch((error: unknown) => console.error("The core worker did not start", error));
  }, []);

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-map text-ink">
      <Suspense fallback={<div className="absolute inset-0 bg-map" data-testid="map" data-map-state="loading" />}>
        <MapView
          theme={theme}
          insets={desktop ? DESKTOP_INSETS : phoneInsets}
          compact={!desktop}
          route={route}
          onRouteDrawn={markRouteDrawn}
        />
      </Suspense>
      {desktop ? (
        <SidePanel label={PANEL_LABEL} header={<PanelHeader />} footer={<ThemeSwitch />}>
          <PanelContent course={course} />
        </SidePanel>
      ) : (
        <BottomSheet
          label={PANEL_LABEL}
          snap={sheet}
          onSnapChange={setSheet}
          header={<PanelHeader action={headerAction} />}
        >
          <PanelContent course={course} />
          <div className="border-t border-line px-6 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <ThemeSwitch />
          </div>
        </BottomSheet>
      )}
      <DropOverlay />
    </main>
  );
}
