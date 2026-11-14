import { useEffect, useState } from "react";
import { loadGpxFile } from "../state/course.ts";

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

/**
 * Accept a GPX file dropped anywhere on the window, and show a full-window target while one is
 * dragged over it. Drags of anything other than files (text, links) are left alone.
 */
export function DropOverlay() {
  const [over, setOver] = useState(false);

  useEffect(() => {
    // dragenter and dragleave fire for every element crossed, so count them.
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      setOver(true);
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const overWindow = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      // Without this the browser opens the file itself on drop.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setOver(false);
      const file = event.dataTransfer?.files[0];
      if (file) void loadGpxFile(file);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overWindow);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overWindow);
      window.removeEventListener("drop", drop);
    };
  }, []);

  if (!over) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-map/70 p-6 backdrop-blur-[2px]"
      data-testid="drop-overlay"
      aria-hidden="true"
    >
      <div className="flex size-full max-h-[420px] max-w-[560px] flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-accent bg-surface/90 text-center shadow-panel">
        <span className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
          <svg
            viewBox="0 0 24 24"
            className="size-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
          </svg>
        </span>
        <p className="text-lg font-semibold text-ink">Drop your GPX file to load it</p>
        <p className="text-sm text-ink-muted">Read on this device, never uploaded.</p>
      </div>
    </div>
  );
}
