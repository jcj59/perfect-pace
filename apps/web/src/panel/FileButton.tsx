import { type ReactNode, useRef } from "react";
import { useMediaQuery } from "../layout/useMediaQuery.ts";
import { loadGpxFile } from "../state/course.ts";

export interface FileButtonProps {
  children: ReactNode;
  variant?: "primary" | "secondary" | "compact";
  className?: string;
}

const VARIANTS = {
  primary:
    "h-11 gap-2 rounded-xl bg-accent px-5 text-[15px] font-semibold text-on-accent shadow-sm hover:brightness-105 active:brightness-95",
  secondary:
    "h-9 gap-1.5 rounded-lg bg-surface-raised px-3 text-[13px] font-medium text-ink ring-1 ring-line ring-inset hover:bg-line/60",
  compact:
    "h-9 gap-1.5 rounded-full bg-accent px-3.5 text-[13px] font-semibold text-on-accent shadow-sm hover:brightness-105 active:brightness-95",
};

/**
 * A button that opens the file picker and loads the chosen GPX file. Phones and tablets get no
 * `accept` filter: iOS greys out every file for an extension it has no type for, and `.gpx` is one.
 */
export function FileButton({ children, variant = "primary", className = "" }: FileButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  const finePointer = useMediaQuery("(pointer: fine)");
  return (
    <>
      <button
        type="button"
        className={`inline-flex shrink-0 cursor-pointer items-center justify-center transition focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none ${VARIANTS[variant]} ${className}`}
        onClick={() => input.current?.click()}
      >
        <UploadIcon />
        {children}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        tabIndex={-1}
        data-testid="gpx-input"
        {...(finePointer ? { accept: ".gpx,application/gpx+xml" } : {})}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Clear it, so picking the same file again still loads it.
          event.currentTarget.value = "";
          if (file) void loadGpxFile(file);
        }}
      />
    </>
  );
}

export function UploadIcon({ className = "size-[18px]" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}
