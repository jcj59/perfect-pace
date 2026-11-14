import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { SheetSnap } from "../state/app.ts";
import { SHEET_PEEK_PX, nextSnap, releaseSnap, snapHeights, stepSnap } from "./sheet.ts";

export interface BottomSheetProps {
  label: string;
  snap: SheetSnap;
  onSnapChange: (snap: SheetSnap) => void;
  /** Always visible, also at `peek`; dragging it moves the sheet. Keep it `SHEET_PEEK_PX` tall with the handle. */
  header: ReactNode;
  children: ReactNode;
}

const HANDLE_LABEL: Record<SheetSnap, string> = {
  peek: "Expand panel",
  half: "Expand panel to full height",
  full: "Collapse panel",
};
/** Pointer travel (px) below which a press on the header counts as a tap, not a drag. */
const TAP_SLOP_PX = 6;

interface Drag {
  pointerId: number;
  startY: number;
  startHeight: number;
  lastY: number;
  lastT: number;
  velocity: number;
  moved: boolean;
}

/**
 * The phone panel: a sheet over a full-bleed map that rests at `peek`, `half` or `full`. Drag the
 * header (or fling it), tap the handle to step through the snaps, or use the arrow keys on it.
 */
export function BottomSheet({ label, snap, onSnapChange, header, children }: BottomSheetProps) {
  const root = useRef<HTMLElement>(null);
  const drag = useRef<Drag | null>(null);
  const [containerPx, setContainerPx] = useState(() => window.innerHeight);
  const [dragHeight, setDragHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const parent = root.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(([entry]) => entry && setContainerPx(entry.contentRect.height));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const heights = snapHeights(containerPx);
  const visible = dragHeight ?? heights[snap];

  // Follow the pointer on the window, so a fast drag that leaves the header in one step still
  // counts, without pointer capture (which would swallow a tap's click on the handle).
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0 || drag.current) return;
    const from = { snap, heights };
    const clamp = (h: number) => Math.min(from.heights.full, Math.max(from.heights.peek, h));
    const d: Drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: from.heights[from.snap],
      lastY: event.clientY,
      lastT: event.timeStamp,
      velocity: 0,
      moved: false,
    };
    drag.current = d;

    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== d.pointerId) return;
      if (!d.moved && Math.abs(e.clientY - d.startY) < TAP_SLOP_PX) return;
      d.moved = true;
      const dt = (e.timeStamp - d.lastT) / 1000;
      // Upward is positive. Smooth the velocity so one jittery sample does not decide a fling.
      if (dt > 0) d.velocity = 0.6 * ((d.lastY - e.clientY) / dt) + 0.4 * d.velocity;
      d.lastY = e.clientY;
      d.lastT = e.timeStamp;
      setDragHeight(clamp(d.startHeight + d.startY - e.clientY));
    };
    const end = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== d.pointerId) return;
      stop();
      if (!d.moved) return; // a tap: the handle's click handles it
      // A pause before release cancels the fling.
      const velocity = e.timeStamp - d.lastT > 80 ? 0 : d.velocity;
      const height = clamp(d.startHeight + d.startY - e.clientY);
      setDragHeight(null);
      onSnapChange(e.type === "pointercancel" ? from.snap : releaseSnap(height, velocity, from.heights));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      drag.current = null;
      stopDrag.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    stopDrag.current = stop;
  }

  function onHandleKeyDown(event: KeyboardEvent) {
    const step = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    onSnapChange(stepSnap(snap, step));
  }

  return (
    <section
      ref={root}
      aria-label={label}
      data-testid="sheet"
      data-snap={snap}
      data-dragging={dragHeight !== null || undefined}
      className="absolute inset-x-0 bottom-0 z-10 flex flex-col rounded-t-3xl border-t border-line bg-surface shadow-panel transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-dragging:transition-none data-dragging:select-none motion-reduce:transition-none"
      style={{ height: heights.full, transform: `translateY(${heights.full - visible}px)` }}
    >
      <div
        className="shrink-0 cursor-grab touch-none select-none active:cursor-grabbing"
        style={{ height: SHEET_PEEK_PX }}
        onPointerDown={onPointerDown}
      >
        <button
          type="button"
          className="group flex h-5 w-full items-end justify-center focus-visible:outline-none"
          aria-label={HANDLE_LABEL[snap]}
          aria-expanded={snap !== "peek"}
          data-testid="sheet-handle"
          onClick={() => onSnapChange(nextSnap(snap))}
          onKeyDown={onHandleKeyDown}
        >
          <span className="h-1.5 w-10 rounded-full bg-line transition-colors group-hover:bg-ink-subtle group-focus-visible:bg-accent group-focus-visible:ring-4 group-focus-visible:ring-accent-soft" />
        </button>
        {header}
      </div>
      <div
        className="min-h-0 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        tabIndex={0}
        style={{ height: heights[snap] - SHEET_PEEK_PX }}
        inert={snap === "peek"}
        data-testid="sheet-content"
      >
        {children}
      </div>
    </section>
  );
}
