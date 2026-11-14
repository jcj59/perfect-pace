import { DESKTOP_QUERY, useMediaQuery } from "../layout/useMediaQuery.ts";
import { useAppState } from "../state/app.ts";
import { FileButton } from "./FileButton.tsx";

/** The way in: pick a GPX file (or, with a mouse, drop one anywhere on the window). */
export function UploadCard() {
  const course = useAppState((s) => s.course);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const reading = course.status === "reading";

  return (
    <section
      aria-labelledby="upload-title"
      aria-busy={reading}
      data-testid="upload-card"
      className="rounded-2xl border-[1.5px] border-dashed border-ink-subtle/40 bg-surface-raised px-5 py-5 text-center"
    >
      {reading ? (
        <div className="flex min-h-[154px] flex-col items-center justify-center gap-3" role="status">
          <span
            className="size-8 animate-spin rounded-full border-[3px] border-accent-soft border-t-accent motion-reduce:animate-none"
            aria-hidden="true"
          />
          <p className="text-[15px] font-medium text-ink" id="upload-title">
            Reading <span className="break-all">{course.fileName}</span>
          </p>
        </div>
      ) : (
        <>
          <h3 id="upload-title" className="text-[15px] font-semibold text-ink">
            Load your course
          </h3>
          <p className="mx-auto mt-1 max-w-[18rem] text-sm leading-relaxed text-pretty text-ink-muted">
            {desktop
              ? "Drop a GPX file anywhere on this window, or choose one."
              : "Choose the GPX file from your watch app, Strava or the race website."}
          </p>
          <FileButton className="mt-4">Choose a GPX file</FileButton>
          <p className="mt-3 text-xs text-ink-subtle">Read on this device, never uploaded.</p>
        </>
      )}
    </section>
  );
}
