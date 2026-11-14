import type { ReactNode } from "react";

/** Width of the desktop panel and its gap from the window edges, in CSS pixels. */
export const SIDE_PANEL_WIDTH_PX = 384;
export const SIDE_PANEL_GAP_PX = 16;

export interface SidePanelProps {
  label: string;
  header: ReactNode;
  /** Scrolls when it does not fit. */
  children: ReactNode;
  /** Pinned under the scrolling content. */
  footer?: ReactNode;
}

/** The desktop panel: a card floating over the map's left edge, full height. */
export function SidePanel({ label, header, children, footer }: SidePanelProps) {
  return (
    <section
      aria-label={label}
      data-testid="side-panel"
      className="absolute z-10 flex flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-panel"
      style={{
        top: SIDE_PANEL_GAP_PX,
        bottom: SIDE_PANEL_GAP_PX,
        left: SIDE_PANEL_GAP_PX,
        width: SIDE_PANEL_WIDTH_PX,
      }}
    >
      <div className="shrink-0 pt-3">{header}</div>
      {/* Focusable so keyboard users can scroll it when nothing inside takes focus. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        tabIndex={0}
      >
        {children}
      </div>
      {footer && <div className="shrink-0 border-t border-line px-6 py-4">{footer}</div>}
    </section>
  );
}
