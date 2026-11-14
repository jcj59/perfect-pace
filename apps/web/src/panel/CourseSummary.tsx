import { type DistanceUnit, type ElevationProfile, type GpxFile, courseLengthM } from "@pp/core";
import type { ReactNode } from "react";
import { type CourseState, useAppState } from "../state/app.ts";
import { retryElevation, selectTrack, trackTitle } from "../state/course.ts";
import { FileButton } from "./FileButton.tsx";
import { UnitsSwitch } from "./UnitsSwitch.tsx";
import { type Quantity, formatDistance, formatElevation, quantityText } from "./format.ts";

type Loaded = Extract<CourseState, { status: "loaded" }>;

/** The loaded course: its name, the track picker for multi-track files, and its stats. */
export function CourseSummary({ course }: { course: Loaded }) {
  const units = useAppState((s) => s.units);
  const { file, fileName, track: index, elevation } = course;
  const track = file.tracks[index];
  if (!track) return null;
  const title = trackTitle(file, index, fileName);

  return (
    <div className="px-6 pt-2 pb-6" data-testid="course-summary">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-[0.08em] text-accent uppercase">Your course</p>
          <h2
            className="mt-1 text-2xl leading-tight font-semibold tracking-tight text-balance break-words text-ink"
            data-testid="course-title"
          >
            {title}
          </h2>
          <p className="mt-1 truncate text-sm text-ink-muted" title={fileName}>
            {fileName}
          </p>
        </div>
        <FileButton variant="secondary" className="mt-1">
          Replace
        </FileButton>
      </div>

      {file.tracks.length > 1 && <TrackPicker file={file} fileName={fileName} selected={index} units={units} />}

      <div className="mt-6 flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-[0.08em] text-ink-subtle uppercase">Course stats</h3>
        <UnitsSwitch />
      </div>
      <Stats lengthM={courseLengthM(track.course)} elevation={elevation} units={units} />
    </div>
  );
}

function TrackPicker({
  file,
  fileName,
  selected,
  units,
}: {
  file: GpxFile;
  fileName: string;
  selected: number;
  units: DistanceUnit;
}) {
  return (
    <fieldset className="mt-5">
      <legend className="text-sm font-medium text-ink">
        This file has {file.tracks.length} {file.tracks.every((t) => t.kind === "route") ? "routes" : "courses"}
      </legend>
      <p className="mt-0.5 text-sm text-ink-muted">Showing the longest. Pick another to switch.</p>
      <div className="mt-3 space-y-2">
        {file.tracks.map((t, i) => (
          <label
            key={i}
            className="flex cursor-pointer items-center gap-3 rounded-xl bg-surface-raised px-3.5 py-3 ring-1 ring-line transition-colors ring-inset hover:ring-ink-subtle/50 has-checked:bg-accent-soft has-checked:ring-2 has-checked:ring-accent has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent"
          >
            <input
              type="radio"
              name="track"
              value={i}
              checked={i === selected}
              onChange={() => selectTrack(i)}
              className="size-4 shrink-0 accent-(--pp-accent)"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium text-ink">{trackTitle(file, i, fileName)}</span>
              <span className="block text-xs text-ink-muted">{t.kind === "route" ? "Route" : "Track"}</span>
            </span>
            <span className="text-sm font-semibold text-ink tabular-nums">
              {quantityText(formatDistance(courseLengthM(t.course), units))}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Stats({
  lengthM,
  elevation,
  units,
}: {
  lengthM: number;
  elevation: Loaded["elevation"];
  units: DistanceUnit;
}) {
  const profile = elevation.status === "ready" ? elevation.profile : undefined;
  const ele = (pick: (p: ElevationProfile) => number) => (profile ? formatElevation(pick(profile), units) : undefined);
  return (
    <div className="mt-3" aria-busy={elevation.status === "loading"}>
      <dl className="grid grid-cols-2 gap-2.5">
        <div className="col-span-2 rounded-2xl bg-surface-raised px-4 py-3.5 ring-1 ring-line ring-inset">
          <dt className="text-sm text-ink-muted">Distance</dt>
          <dd className="mt-0.5" data-testid="stat-distance">
            <Value quantity={formatDistance(lengthM, units)} large />
          </dd>
        </div>
        <Stat
          label="Elevation gain"
          icon={<path d="M4 17 10 11l3 3 7-7M15 7h5v5" />}
          value={ele((p) => p.stats.gainM)}
          testId="stat-gain"
        />
        <Stat
          label="Elevation loss"
          icon={<path d="M4 7l6 6 3-3 7 7M15 17h5v-5" />}
          value={ele((p) => p.stats.lossM)}
          testId="stat-loss"
        />
        <Stat
          label="Lowest point"
          icon={<path d="M12 5v14M6 13l6 6 6-6" />}
          value={ele((p) => p.stats.minM)}
          testId="stat-min"
        />
        <Stat
          label="Highest point"
          icon={<path d="M12 19V5M6 11l6-6 6 6" />}
          value={ele((p) => p.stats.maxM)}
          testId="stat-max"
        />
      </dl>
      <ElevationNote elevation={elevation} />
    </div>
  );
}

function Stat({
  label,
  icon,
  value,
  testId,
}: {
  label: string;
  icon: ReactNode;
  value: Quantity | undefined;
  testId: string;
}) {
  return (
    <div className="rounded-2xl bg-surface-raised px-4 py-3 ring-1 ring-line ring-inset">
      <dt className="flex items-center gap-1.5 text-[13px] text-ink-muted">
        <svg
          viewBox="0 0 24 24"
          className="size-3.5 shrink-0 text-ink-subtle"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {icon}
        </svg>
        {label}
      </dt>
      <dd className="mt-1 h-7" data-testid={testId}>
        {value ? (
          <Value quantity={value} />
        ) : (
          <span className="mt-1.5 block h-4 w-16 animate-pulse rounded bg-line motion-reduce:animate-none">
            <span className="sr-only">Not available</span>
          </span>
        )}
      </dd>
    </div>
  );
}

function Value({ quantity, large = false }: { quantity: Quantity; large?: boolean }) {
  return (
    <span className="text-ink tabular-nums">
      <span className={large ? "text-[34px] leading-none font-semibold tracking-tight" : "text-xl font-semibold"}>
        {quantity.value}
      </span>
      <span className={`ml-1 font-medium text-ink-muted ${large ? "text-lg" : "text-sm"}`}>{quantity.unit}</span>
    </span>
  );
}

const DEM_REASONS: Record<string, string> = {
  missing: "This file has no elevation, so it comes from terrain data for the area.",
  sparse: "This file has elevation for too little of the course, so it comes from terrain data for the area.",
  flat: "This file's elevation is a flat placeholder, so it comes from terrain data for the area.",
  spiky: "This file's elevation is too noisy to trust, so it comes from terrain data for the area.",
};

function ElevationNote({ elevation }: { elevation: Loaded["elevation"] }) {
  if (elevation.status === "loading") {
    return (
      <p className="mt-3 text-[13px] text-ink-muted" role="status">
        Working out the elevation profile...
      </p>
    );
  }
  if (elevation.status === "error") {
    return (
      <div
        role="alert"
        className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-danger-soft px-3.5 py-3"
        data-testid="elevation-error"
      >
        <p className="text-[13px] leading-snug text-ink">{elevation.message}</p>
        <button
          type="button"
          onClick={retryElevation}
          className="h-8 shrink-0 cursor-pointer rounded-lg bg-surface px-3 text-[13px] font-medium text-ink ring-1 ring-line ring-inset hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          Try again
        </button>
      </div>
    );
  }
  const { source, gpsIssue } = elevation.profile;
  const text =
    source === "gps"
      ? "Elevation from the file's GPS data, smoothed to remove noise."
      : source === "gps+dem"
        ? "Elevation from the file's GPS data, with its gaps filled from terrain data."
        : (DEM_REASONS[gpsIssue ?? "missing"] ?? DEM_REASONS["missing"]);
  return (
    <p className="mt-3 flex gap-2 text-[13px] leading-snug text-ink-muted" data-testid="elevation-source">
      <svg
        viewBox="0 0 24 24"
        className="mt-px size-4 shrink-0 text-ink-subtle"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
      {text}
    </p>
  );
}
