import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { PANEL_DEFAULT_WIDTH_PX, type PanelWidthRange, keyedPanelWidth } from "./panelWidth.ts";

/** The panel's gap from the window edges, in CSS pixels. */
export const SIDE_PANEL_GAP_PX = 16;
/** The resize handle's hit area: this far into the panel from its right edge, and its width. */
const HANDLE_INSET_PX = 4;
const HANDLE_WIDTH_PX = 14;
const PANEL_ID = "course-panel";
/** The panel's top, bottom and left: clear of a landscape phone's notch and home indicator (zero elsewhere). */
const TOP = `max(${SIDE_PANEL_GAP_PX}px, env(safe-area-inset-top))`;
const BOTTOM = `max(${SIDE_PANEL_GAP_PX}px, env(safe-area-inset-bottom))`;
const LEFT = `max(${SIDE_PANEL_GAP_PX}px, env(safe-area-inset-left))`;

export interface SidePanelProps {
  label: string;
  header: ReactNode;
  /** Scrolls when it does not fit. */
  children: ReactNode;
  /** Pinned under the scrolling content. */
  footer?: ReactNode;
  /** The width shown, in CSS pixels. */
  width: number;
  /** The widths the handle can resize it to. */
  range: PanelWidthRange;
  /** Show a width while the handle is dragged (null to drop it), without settling there. */
  onPreview: (widthPx: number | null) => void;
  /** Settle at a width: a drag's end, a key on the handle or a double-click (back to the default). */
  onCommit: (widthPx: number) => void;
}

/**
 * The desktop panel: a card floating over the map's left edge, full height, resized from its right
 * edge. It is a size container, so what it holds can fit itself to a narrow panel (`@max-[360px]:`).
 */
export function SidePanel({ label, header, children, footer, width, range, onPreview, onCommit }: SidePanelProps) {
  return (
    <>
      <section
        id={PANEL_ID}
        aria-label={label}
        data-testid="side-panel"
        className="@container absolute z-10 flex flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-panel"
        style={{ top: TOP, bottom: BOTTOM, left: LEFT, width }}
      >
        <div className="shrink-0 pt-3">{header}</div>
        {/* Focusable so keyboard users can scroll it when nothing inside takes focus. */}
        <div
          className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          tabIndex={0}
          data-testid="side-panel-content"
        >
          {children}
        </div>
        {footer && <div className="shrink-0 border-t border-line px-6 py-4">{footer}</div>}
      </section>
      <ResizeHandle width={width} range={range} onPreview={onPreview} onCommit={onCommit} />
    </>
  );
}

interface Drag {
  pointerId: number;
  startX: number;
  startWidth: number;
  widthPx: number;
}

/**
 * The handle on the panel's right edge: drag it (the pointer is captured, so the drag carries on
 * over the map), double-click it for the default width, or focus it and use the arrow keys, Home
 * and End. A grip shows on hover, on focus and while dragging.
 */
function ResizeHandle({ width, range, onPreview, onCommit }: Omit<SidePanelProps, "label" | "header" | "children">) {
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);

  // While dragging, the whole page shows the resize cursor and no text gets selected.
  useEffect(() => {
    if (!dragging) return;
    const root = document.documentElement;
    root.classList.add("pp-resizing");
    return () => root.classList.remove("pp-resizing");
  }, [dragging]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, widthPx: width };
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    d.widthPx = d.startWidth + event.clientX - d.startX;
    onPreview(d.widthPx);
  }

  /** The end of a drag: settle where it was let go, or (cancelled by the browser) where it started. */
  function end(event: PointerEvent<HTMLDivElement>, keep: boolean) {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (keep && d.widthPx !== d.startWidth) onCommit(d.widthPx);
    else onPreview(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = keyedPanelWidth(event.key, width, range);
    if (next === null) return;
    event.preventDefault();
    onCommit(next);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-controls={PANEL_ID}
      aria-valuenow={width}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      tabIndex={0}
      data-testid="panel-resize-handle"
      data-dragging={dragging || undefined}
      className="group absolute z-20 cursor-col-resize touch-none select-none focus-visible:outline-none"
      style={{
        top: TOP,
        bottom: BOTTOM,
        left: `calc(${LEFT} + ${width - HANDLE_INSET_PX}px)`,
        width: HANDLE_WIDTH_PX,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => end(event, true)}
      onPointerCancel={(event) => end(event, false)}
      onLostPointerCapture={(event) => end(event, true)}
      onDoubleClick={() => onCommit(PANEL_DEFAULT_WIDTH_PX)}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden="true"
        data-testid="panel-resize-grip"
        className="pointer-events-none absolute top-1/2 h-11 w-1 -translate-y-1/2 rounded-full bg-ink-subtle opacity-0 shadow-sm transition-[opacity,background-color] duration-150 group-hover:opacity-100 group-focus-visible:bg-accent group-focus-visible:opacity-100 group-focus-visible:ring-2 group-focus-visible:ring-accent/40 group-data-dragging:bg-accent group-data-dragging:opacity-100"
        style={{ left: HANDLE_INSET_PX + 3 }}
      />
    </div>
  );
}
