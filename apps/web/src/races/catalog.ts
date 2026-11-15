/**
 * The race library (B13): famous races with the facts a plan needs before race day. The data is
 * `catalog.json`, seeded from `docs/race-catalog.md` with every fact checked against the race's
 * own website. A race's course (`gpx`) is added later with `pnpm races:add`.
 */
import catalog from "./catalog.json";

/** The groups the page lists races under, and filters them by, in display order. */
export const RACE_SERIES = [
  "world-marathon-majors",
  "us-marathons",
  "half-marathons",
  "10-mile-to-15k",
  "10k-and-shorter",
] as const;
export type RaceSeries = (typeof RACE_SERIES)[number];

export const SERIES_LABELS: Record<RaceSeries, string> = {
  "world-marathon-majors": "World Marathon Majors",
  "us-marathons": "US marathons",
  "half-marathons": "Half marathons",
  "10-mile-to-15k": "10 mi to 15K",
  "10k-and-shorter": "10K and shorter",
};

export interface Race {
  /** Unique, URL-safe: `/?race=<slug>` and `/races/<slug>.gpx`. */
  slug: string;
  name: string;
  city: string;
  /** State, province or region (a US state's postal code). */
  region: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** The race distance in meters (one of `DISTANCE_LABELS`). */
  distanceM: number;
  /** The month the race is usually held, 1 to 12. */
  usualMonth: number;
  /** IANA time zone of the start. */
  timezone: string;
  /** Local start of the main field (its first wave), `HH:MM`. */
  startTimeLocal: string;
  website: string;
  /** The groups the race belongs to; the first is the one it is listed under. */
  series: RaceSeries[];
  /** The course's path (`/races/<slug>.gpx`), or null until it is added. */
  gpx: string | null;
  /** The month (`YYYY-MM`) every fact was last checked on the race's website, or null if any could not be. */
  verified: string | null;
  /** The facts that could not be confirmed on the race's website (present only when `verified` is null). */
  unverified?: (keyof Race)[];
}

/** Every distance a race may have, with how the page shows it. Keys are meters to 0.1 m. */
export const DISTANCE_LABELS: ReadonlyMap<number, string> = new Map([
  [42195, "Marathon"],
  [21097.5, "Half"],
  [16093.4, "10 mi"],
  [15000, "15K"],
  [12000, "12K"],
  [11265.4, "7 mi"],
  [10000, "10K"],
  [8000, "8K"],
  [7623.5, "4.737 mi"],
  [5000, "5K"],
  [1609.3, "1 mi"],
]);

export function distanceLabel(distanceM: number): string {
  return DISTANCE_LABELS.get(distanceM) ?? `${Math.round(distanceM / 100) / 10} km`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function monthName(month: number): string {
  return MONTHS[month - 1] ?? "";
}

let countryNames: Intl.DisplayNames | undefined;

/** Where the race is, as the page shows it: `Boston, MA` in the US, `Tokyo, Japan` elsewhere. */
export function racePlace(race: Pick<Race, "city" | "region" | "country">): string {
  if (race.country === "US") return `${race.city}, ${race.region}`;
  try {
    countryNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return `${race.city}, ${countryNames.of(race.country) ?? race.country}`;
  } catch {
    return `${race.city}, ${race.country}`;
  }
}

/**
 * The catalog. E2E tests can replace it before the app loads by setting
 * `window.__PP_RACE_CATALOG__` (an init script), so they can load a fixture course while the
 * shipped catalog has none.
 */
export function raceCatalog(): readonly Race[] {
  const override = (globalThis as { __PP_RACE_CATALOG__?: Race[] }).__PP_RACE_CATALOG__;
  return Array.isArray(override) ? override : (catalog as Race[]);
}

export function raceBySlug(slug: string): Race | undefined {
  return raceCatalog().find((r) => r.slug === slug);
}

/** Lowercase, without accents or punctuation, so `st george` finds `St. George` and `baa` finds `B.A.A.`. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The races whose name or place has every word of `query`, in `series` when one is given. */
export function filterRaces(races: readonly Race[], query: string, series: RaceSeries | null): Race[] {
  const words = normalize(query).split(" ").filter(Boolean);
  return races.filter((race) => {
    if (series && !race.series.includes(series)) return false;
    if (words.length === 0) return true;
    const text = normalize(`${race.name} ${race.city} ${race.region} ${racePlace(race)}`);
    return words.every((w) => text.includes(w));
  });
}

export interface RaceGroup {
  series: RaceSeries;
  races: Race[];
}

/**
 * Races grouped for the list, in series order, each group by usual month then name. With a
 * series picked, everything is in that one group; otherwise each race is in its first series.
 */
export function groupRaces(races: readonly Race[], series: RaceSeries | null): RaceGroup[] {
  const sorted = [...races].sort((a, b) => a.usualMonth - b.usualMonth || a.name.localeCompare(b.name));
  return RACE_SERIES.filter((s) => !series || s === series)
    .map((s) => ({ series: s, races: sorted.filter((r) => (series ? true : r.series[0] === s)) }))
    .filter((g) => g.races.length > 0);
}
