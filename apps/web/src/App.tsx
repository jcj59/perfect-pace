import { Suspense, lazy, useEffect } from "react";
import { BottomSheet } from "./layout/BottomSheet.tsx";
import { SIDE_PANEL_GAP_PX, SIDE_PANEL_WIDTH_PX, SidePanel } from "./layout/SidePanel.tsx";
import { SHEET_PEEK_PX } from "./layout/sheet.ts";
import { DESKTOP_QUERY, useMediaQuery } from "./layout/useMediaQuery.ts";
import type { Insets } from "./map/MapView.tsx";
import { EmptyState } from "./panel/EmptyState.tsx";
import { PanelHeader } from "./panel/PanelHeader.tsx";
import { ThemeSwitch } from "./panel/ThemeSwitch.tsx";
import { setSheet, useAppState } from "./state/app.ts";
import { useApplyTheme, useTheme } from "./theme.ts";
import { warmUpCoreWorker } from "./worker/client.ts";

// MapLibre is most of the bundle; load it beside the panel instead of before it.
const MapView = lazy(() => import("./map/MapView.tsx"));

const PANEL_LABEL = "Course panel";
const DESKTOP_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: SIDE_PANEL_WIDTH_PX + SIDE_PANEL_GAP_PX };
const PHONE_INSETS: Insets = { top: 0, right: 0, bottom: SHEET_PEEK_PX, left: 0 };

/** The app shell: a full-bleed map with the panel beside it (desktop) or over it as a sheet (phones). */
export function App() {
  const theme = useTheme();
  useApplyTheme(theme);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const sheet = useAppState((s) => s.sheet);

  useEffect(() => {
    performance.mark("pp:ready");
    warmUpCoreWorker().catch((error: unknown) => console.error("The core worker did not start", error));
  }, []);

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-map text-ink">
      <Suspense fallback={<div className="absolute inset-0 bg-map" data-testid="map" data-map-state="loading" />}>
        <MapView theme={theme} insets={desktop ? DESKTOP_INSETS : PHONE_INSETS} compact={!desktop} />
      </Suspense>
      {desktop ? (
        <SidePanel label={PANEL_LABEL} header={<PanelHeader />} footer={<ThemeSwitch />}>
          <EmptyState />
        </SidePanel>
      ) : (
        <BottomSheet label={PANEL_LABEL} snap={sheet} onSnapChange={setSheet} header={<PanelHeader />}>
          <EmptyState />
          <div className="border-t border-line px-6 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <ThemeSwitch />
          </div>
        </BottomSheet>
      )}
    </main>
  );
}
