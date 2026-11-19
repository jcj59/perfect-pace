import { useEffect, useId, useMemo, useState } from "react";
import { startPwa } from "../pwa/pwa.ts";
import { Link } from "../router.tsx";
import { useApplyTheme, useTheme } from "../theme.ts";
import {
  RACE_SERIES,
  type Race,
  type RaceSeries,
  SERIES_LABELS,
  distanceLabel,
  filterRaces,
  groupRaces,
  monthName,
  raceCatalog,
  racePlace,
} from "./catalog.ts";

const TITLE = "Races · Perfect Pace";

/** The race library (B13): search and filter famous races, and open one's course in the planner. */
export default function RacesPage() {
  useApplyTheme(useTheme());
  useEffect(() => startPwa(), []);
  useEffect(() => {
    const previous = document.title;
    document.title = TITLE;
    return () => {
      document.title = previous;
    };
  }, []);

  const [query, setQuery] = useState("");
  const [series, setSeries] = useState<RaceSeries | null>(null);
  const races = raceCatalog();
  const groups = useMemo(() => groupRaces(filterRaces(races, query, series), series), [races, query, series]);
  const count = groups.reduce((n, g) => n + g.races.length, 0);
  const searchId = useId();

  return (
    <div className="h-dvh overflow-y-auto bg-map text-ink" data-testid="races-page">
      <main className="mx-auto w-full max-w-2xl px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-8">
        <nav aria-label="Back to the planner">
          <Link
            to="/"
            className="-ml-2 inline-flex h-10 items-center gap-2 rounded-xl pr-3 pl-2 text-[15px] font-semibold text-ink hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            data-testid="races-back"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-5 text-ink-muted"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
            <span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                className="size-[18px]"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M2.5 18 6 16.5l4-7.5 3.5 4 3-5.5 5 6.5" />
              </svg>
            </span>
            Perfect Pace
          </Link>
        </nav>

        <h1 className="mt-6 text-3xl leading-tight font-semibold tracking-tight text-balance">Race library</h1>
        <p className="mt-2 max-w-prose text-[15px] leading-relaxed text-pretty text-ink-muted">
          Famous races and the month they are usually run. Courses are being added: until a race has one, load its GPX
          file or draw it on the map.
        </p>

        <div className="mt-6">
          <label htmlFor={searchId} className="sr-only">
            Search races
          </label>
          <div className="relative">
            <svg
              viewBox="0 0 24 24"
              className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-ink-subtle"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search by race or city"
              autoComplete="off"
              enterKeyHint="search"
              data-testid="race-search"
              className="h-12 w-full rounded-xl border border-line bg-surface pr-4 pl-11 text-base text-ink shadow-sm placeholder:text-ink-subtle focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none"
            />
          </div>
        </div>

        <div
          role="group"
          aria-label="Filter races"
          className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0"
        >
          <Chip pressed={series === null} onClick={() => setSeries(null)} testId="all">
            All races
          </Chip>
          {RACE_SERIES.map((s) => (
            <Chip key={s} pressed={series === s} onClick={() => setSeries(series === s ? null : s)} testId={s}>
              {SERIES_LABELS[s]}
            </Chip>
          ))}
        </div>

        <p className="sr-only" role="status" data-testid="race-count">
          {count === 1 ? "1 race" : `${count} races`}
        </p>

        {groups.length === 0 ? (
          <div
            className="mt-8 rounded-2xl bg-surface px-6 py-10 text-center ring-1 ring-line"
            data-testid="races-empty"
          >
            <p className="text-[15px] font-medium text-ink">No races match “{query.trim()}”</p>
            <p className="mt-1 text-sm text-ink-muted">Try a race name or a city.</p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setSeries(null);
              }}
              className="mt-4 inline-flex h-9 cursor-pointer items-center rounded-lg bg-surface-raised px-3 text-[13px] font-medium text-ink ring-1 ring-line ring-inset hover:bg-line/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              Show all races
            </button>
          </div>
        ) : (
          groups.map((group) => (
            <section
              key={group.series}
              aria-labelledby={`races-${group.series}`}
              className="mt-8"
              data-testid="race-group"
              data-series={group.series}
            >
              <h2
                id={`races-${group.series}`}
                className="flex items-baseline gap-2 px-1 text-xs font-semibold tracking-[0.08em] text-ink-subtle uppercase"
              >
                {SERIES_LABELS[group.series]}
                <span className="font-medium tracking-normal tabular-nums">{group.races.length}</span>
              </h2>
              <ul className="mt-2.5 divide-y divide-line overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
                {group.races.map((race) => (
                  <RaceRow key={race.slug} race={race} />
                ))}
              </ul>
            </section>
          ))
        )}
      </main>
    </div>
  );
}

function Chip({
  pressed,
  onClick,
  testId,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  testId: string;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      data-testid="race-chip"
      data-series={testId}
      className={`h-9 shrink-0 cursor-pointer rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-map focus-visible:outline-none ${
        pressed ? "bg-ink text-surface" : "bg-surface text-ink ring-1 ring-line ring-inset hover:bg-surface-raised"
      }`}
    >
      {children}
    </button>
  );
}

/** One race: name, place and usual month, distance, and its course (or that it is coming soon). */
function RaceRow({ race }: { race: Race }) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] leading-snug font-medium text-ink">{race.name}</p>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-muted">
          {racePlace(race)}
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, usually in </span>
          {monthName(race.usualMonth)}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-right">
        <span className="text-[13px] font-semibold text-ink tabular-nums" data-testid="race-distance">
          {distanceLabel(race.distanceM)}
        </span>
        {race.gpx ? (
          <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-accent">
            Open course
            <svg
              viewBox="0 0 24 24"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          </span>
        ) : (
          <span
            className="rounded-full bg-surface-raised px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap text-ink-subtle ring-1 ring-line ring-inset"
            data-testid="race-badge"
          >
            Course coming soon
          </span>
        )}
      </div>
    </>
  );
  const rowClass = "flex items-start gap-4 px-4 py-3.5 sm:px-5";
  return (
    <li data-testid="race-row" data-slug={race.slug} data-has-course={race.gpx ? "true" : "false"}>
      {race.gpx ? (
        <Link
          to={`/?race=${encodeURIComponent(race.slug)}`}
          className={`${rowClass} hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent`}
        >
          {body}
        </Link>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
    </li>
  );
}
