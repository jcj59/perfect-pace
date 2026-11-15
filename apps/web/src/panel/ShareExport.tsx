import { type ElevationProfile, type SharedCourse } from "@pp/core";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../draw/icons.tsx";
import { courseGpx, courseName, downloadText, exportCsv, fileSlug } from "../plan/export.ts";
import { type CourseState, useAppState } from "../state/app.ts";
import { useDrawState } from "../state/draw.ts";
import { usePlanView } from "../state/plan.ts";
import { type PreparedShare, prepareShare, shareUrl, whenIdle } from "../state/session.ts";
import { BUTTON_BASE, BUTTON_VARIANTS } from "./FileButton.tsx";

type Shown = Extract<CourseState, { status: "loaded" } | { status: "drawn" }>;

/** How long "Copied" stays on the button. */
const COPIED_MS = 2500;

const LINK = (
  <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
);
const CHECK = <path d="m5 12.5 4.5 4.5L19 7.5" />;
const DOWNLOAD = <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />;
const TABLE = <path d="M4 5h16v14H4zM4 10h16M4 15h16M10 10v9" />;
const PRINT = (
  <path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2M7 14h10v6H7z" />
);

/**
 * The course a link carries, ready to share (an uploaded one simplified in the worker): undefined
 * while it is worked out, null when it is too large for a link. Once per course.
 */
function usePreparedShare(course: Shown): PreparedShare | null | undefined {
  const route = useDrawState((s) => s.history.present);
  const file = course.status === "loaded" ? course.file : null;
  const track = course.status === "loaded" ? course.track : 0;
  const name = course.status === "loaded" ? courseName(course) : undefined;
  const [prepared, setPrepared] = useState<{ key: unknown; value: PreparedShare | null } | null>(null);
  const key = course.status === "drawn" ? route : file?.tracks[track];
  useEffect(() => {
    let shared: SharedCourse | undefined;
    if (course.status === "drawn") shared = route.waypoints.length >= 2 ? { kind: "drawn", route } : undefined;
    else {
      const points = file?.tracks[track]?.course.points;
      shared = points ? { kind: "track", points } : undefined;
    }
    if (!shared) return;
    const controller = new AbortController();
    // Once the main thread is idle: a new course's map and plan come first.
    const cancel = whenIdle(() => {
      prepareShare(shared, name, { signal: controller.signal }).then(
        (value) => {
          if (!controller.signal.aborted) setPrepared({ key, value: value ?? null });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          console.error("Could not prepare the share link", error);
          setPrepared({ key, value: null });
        },
      );
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [course.status, route, file, track, name, key]);
  return prepared && prepared.key === key ? prepared.value : undefined;
}

/**
 * Share and export for the course on screen: copy a link that opens the same course and plan,
 * download the course as GPX and the plan as CSV, and print a pace band. Each says what it holds,
 * including what a link leaves out.
 */
export function ShareExport({ course, profile }: { course: Shown; profile: ElevationProfile }) {
  const units = useAppState((s) => s.units);
  const goalTimeS = useAppState((s) => s.goalTimeS);
  const paceChanges = useAppState((s) => s.paceChanges);
  const minSegmentM = useAppState((s) => s.minSegmentM);
  const planType = useAppState((s) => s.planType);
  const splitM = useAppState((s) => s.splitM);
  const breakpointsM = useAppState((s) => s.breakpointsM);
  const view = useAppState((s) => s.tableView);
  const planProfile = usePlanView((v) => v.profile);
  const viewPlan = usePlanView((v) => v.plan);
  const plan = planProfile === profile ? viewPlan : null;
  const prepared = usePreparedShare(course);
  const name = courseName(course);

  const gpxNote =
    course.status === "drawn"
      ? "The route you drew, with elevation from terrain data."
      : course.copy
        ? "This simplified copy, with elevation from terrain data."
        : "This track as loaded, with the file's own elevation.";

  const downloadGpx = () => {
    const gpx = courseGpx(course, profile);
    if (gpx) downloadText(gpx.fileName, gpx.text, "application/gpx+xml");
  };
  const downloadCsv = () => {
    if (!plan) return;
    const suffix = view === "splits" ? `${units === "mi" ? "mile" : "km"}-splits` : "pacing-plan";
    downloadText(`${fileSlug(name)}-${suffix}.csv`, exportCsv(plan, units, view), "text/csv;charset=utf-8");
  };

  return (
    <section aria-labelledby="share-heading" className="mt-8" data-testid="share-export">
      <h3 id="share-heading" className="text-xs font-semibold tracking-[0.08em] text-ink-subtle uppercase">
        Share and export
      </h3>
      <div className="mt-3 rounded-2xl bg-surface-raised px-4 py-4 ring-1 ring-line ring-inset">
        {prepared === undefined ? null : prepared === null ? (
          <p className="text-[13px] leading-snug text-ink-muted" data-testid="share-too-large">
            <span className="font-medium text-ink">This course is too detailed to fit in a link. </span>
            Download its GPX below and send the file instead.
          </p>
        ) : (
          <CopyLink
            url={() =>
              shareUrl(prepared, {
                goalTimeS,
                planType,
                paceChanges,
                minSegmentM,
                splitM,
                breakpointsM,
                unit: units,
              })
            }
            note={
              prepared.track ? (
                <>
                  The link holds a simplified copy of this course, within{" "}
                  {Math.max(0.1, Math.ceil(prepared.track.lengthError * 1000) / 10).toFixed(1)}% of its distance, and
                  these settings. Where it opens, elevation comes from terrain data, so the plan there can differ
                  slightly.
                </>
              ) : (
                "The link holds your route's points and these settings. Paths are routed again where it opens."
              )
            }
          />
        )}
        <div className={`${prepared === undefined ? "" : "mt-4 border-t border-line pt-3"} -mx-1 space-y-1`}>
          <ExportButton icon={DOWNLOAD} title="Download GPX" note={gpxNote} onClick={downloadGpx} testId="export-gpx" />
          {plan && (
            <>
              <ExportButton
                icon={TABLE}
                title="Download plan as CSV"
                note={
                  view === "splits"
                    ? `Every ${units === "mi" ? "mile" : "kilometer"}'s pace, split and elapsed time, for a spreadsheet.`
                    : "Every segment's pace and time, for a spreadsheet."
                }
                onClick={downloadCsv}
                testId="export-csv"
              />
              <ExportButton
                icon={PRINT}
                title="Print pace band"
                note={
                  view === "splits"
                    ? `Your time at every ${units === "mi" ? "mile" : "kilometer"}, to wear on race day.`
                    : "Each segment's pace and your time at its end, to wear on race day."
                }
                onClick={() => window.print()}
                testId="print-band"
              />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** The Copy link button, its feedback, and a field to copy from by hand when the clipboard is refused. */
function CopyLink({ url, note }: { url: () => string; note: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (manual) field.current?.select();
  }, [manual]);

  const copy = async () => {
    const link = url();
    try {
      await navigator.clipboard.writeText(link);
      setManual(null);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setCopied(false);
      setManual(link);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink">Share this plan</p>
        <button
          type="button"
          onClick={() => void copy()}
          aria-describedby={noteId}
          className={`${BUTTON_BASE} ${BUTTON_VARIANTS.secondary} min-w-[108px] ${copied ? "text-accent" : ""}`}
          data-testid="copy-link"
          data-copied={copied || undefined}
        >
          <Icon className="size-4">{copied ? CHECK : LINK}</Icon>
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <p id={noteId} className="mt-2 text-[13px] leading-snug text-ink-muted" data-testid="share-note">
        {note}
      </p>
      <p role="status" className="sr-only">
        {copied ? "Link copied to the clipboard." : ""}
      </p>
      {manual && (
        <div className="mt-3">
          <label htmlFor={`${noteId}-field`} className="text-[13px] text-ink-muted">
            The clipboard is not available here. Copy the link from this field:
          </label>
          <input
            id={`${noteId}-field`}
            ref={field}
            readOnly
            value={manual}
            onFocus={(e) => e.target.select()}
            className="mt-1.5 h-9 w-full rounded-lg bg-surface px-3 text-[13px] text-ink ring-1 ring-line ring-inset focus:ring-2 focus:ring-accent focus:outline-none"
            data-testid="share-url"
          />
        </div>
      )}
    </div>
  );
}

function ExportButton({
  icon,
  title,
  note,
  onClick,
  testId,
}: {
  icon: ReactNode;
  title: string;
  note: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-start gap-3 rounded-xl px-1 py-2 text-left transition-colors hover:bg-line/50 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent"
      data-testid={testId}
    >
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-ink-muted ring-1 ring-line ring-inset">
        <Icon className="size-4">{icon}</Icon>
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="block text-[13px] leading-snug text-ink-muted">{note}</span>
      </span>
    </button>
  );
}
