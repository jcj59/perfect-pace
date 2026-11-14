import { DrawButton } from "../draw/DrawButton.tsx";
import { DRAW, Icon } from "../draw/icons.tsx";
import { UploadCard } from "./UploadCard.tsx";

const STEPS = [
  {
    title: "Add your course",
    body: "Load a GPX file from your watch, Strava or the race website, or draw the route on the map, each leg following the paths.",
  },
  {
    title: "Set your goal",
    body: "Choose a finish time and how many pace changes you are happy to remember.",
  },
  {
    title: "Run the plan",
    body: "Get a pace for every segment, with the climb or descent behind each change.",
  },
];

export interface EmptyStateProps {
  /** Show the upload card. Off while an error card above it offers the same button. The draw card always shows. */
  upload?: boolean;
}

/** What the panel shows before there is a course. */
export function EmptyState({ upload = true }: EmptyStateProps) {
  return (
    <div className="px-6 pt-2 pb-6" data-testid="empty-state">
      <ProfileIllustration />
      <h2 className="mt-6 text-2xl leading-tight font-semibold tracking-tight text-balance text-ink">
        Run every hill at the right effort.
      </h2>
      <p className="mt-3 text-[15px] leading-relaxed text-pretty text-ink-muted">
        Perfect Pace turns a course and a goal time into a pacing plan that eases off on the climbs, makes the time back
        on the descents, and keeps the pace changes to as few as you like.
      </p>
      <div className="mt-6 space-y-3">
        {upload && <UploadCard />}
        <DrawCard />
      </div>
      <h3 className="mt-7 text-xs font-semibold tracking-[0.08em] text-ink-subtle uppercase">How it works</h3>
      <ol className="mt-3 space-y-4">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-3.5">
            <span
              className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent tabular-nums"
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <div className="pt-0.5">
              <p className="text-[15px] leading-snug font-medium text-ink">{step.title}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The other way in: draw the course on the map. */
function DrawCard() {
  return (
    <div
      data-testid="draw-card"
      className="flex gap-3.5 rounded-2xl bg-surface-raised px-4 py-4 ring-1 ring-line ring-inset"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
        <Icon className="size-5">{DRAW}</Icon>
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] font-semibold text-ink">Or draw it on the map</h3>
        <p className="mt-0.5 text-[13px] leading-snug text-pretty text-ink-muted">
          Place the points and each leg follows the paths between them.
        </p>
        <DrawButton variant="secondary" className="mt-3">
          Draw route
        </DrawButton>
      </div>
    </div>
  );
}

/** A course profile split into three paced segments: steady, slower up the climb, quicker down. */
function ProfileIllustration() {
  const profile = "M0 92 C30 90 60 95 104 88 C130 84 150 52 196 34 C222 28 236 40 256 56 C278 72 296 80 320 78";
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface-raised">
      <svg viewBox="0 0 320 120" className="block h-auto w-full text-accent" aria-hidden="true">
        <defs>
          <linearGradient id="pp-profile-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${profile} L320 120 L0 120 Z`} fill="url(#pp-profile-fill)" />
        <path d={profile} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        {[104, 196].map((x) => (
          <line
            key={x}
            x1={x}
            x2={x}
            y1="22"
            y2="120"
            className="stroke-ink-subtle"
            strokeOpacity="0.45"
            strokeDasharray="3 4"
          />
        ))}
        {[
          { x: 52, pace: "8:05" },
          { x: 150, pace: "8:52" },
          { x: 258, pace: "7:41" },
        ].map(({ x, pace }) => (
          <g key={pace} transform={`translate(${x} 18)`}>
            <rect x="-24" y="-11" width="48" height="22" rx="11" className="fill-surface stroke-line" />
            <text
              textAnchor="middle"
              dominantBaseline="central"
              className="fill-ink text-[11px] font-semibold tabular-nums"
            >
              {pace}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
