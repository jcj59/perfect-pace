/**
 * Unit conversions and time formatting. Core works in meters and seconds throughout; paces are
 * stored as seconds per meter and only converted to seconds per mile or kilometer for display.
 */

/** Display unit system for distances and paces. */
export type DistanceUnit = "mi" | "km";

/** Meters in one international mile (exact by definition). */
export const METERS_PER_MILE = 1609.344;

/** Meters in one kilometer. */
export const METERS_PER_KM = 1000;

/** Meters in one `unit`. */
export function metersPerUnit(unit: DistanceUnit): number {
  return unit === "mi" ? METERS_PER_MILE : METERS_PER_KM;
}

/** A distance in meters, expressed in `unit`. */
export function metersToUnit(meters: number, unit: DistanceUnit): number {
  return meters / metersPerUnit(unit);
}

/** A distance in `unit`, expressed in meters. */
export function unitToMeters(distance: number, unit: DistanceUnit): number {
  return distance * metersPerUnit(unit);
}

/** A pace in seconds per meter, expressed in seconds per `unit`. */
export function paceToUnit(secondsPerMeter: number, unit: DistanceUnit): number {
  return secondsPerMeter * metersPerUnit(unit);
}

/** A pace in seconds per `unit`, expressed in seconds per meter. */
export function paceFromUnit(secondsPerUnit: number, unit: DistanceUnit): number {
  return secondsPerUnit / metersPerUnit(unit);
}

function assertDuration(seconds: number, fn: string): void {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError(`${fn}: expected a finite, non-negative number of seconds, got ${seconds}`);
  }
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * A duration as `m:ss` under an hour and `h:mm:ss` from an hour up, rounded to the nearest
 * whole second (so 59.6 s is `1:00`). Examples: `7:05`, `59:59`, `1:00:00`, `26:03:07`.
 */
export function formatDuration(seconds: number): string {
  assertDuration(seconds, "formatDuration");
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/**
 * A pace given in seconds per meter, formatted per `unit` like `formatDuration`, for example
 * `7:30` (per mile). The unit label is left to the caller.
 */
export function formatPace(secondsPerMeter: number, unit: DistanceUnit): string {
  return formatDuration(paceToUnit(secondsPerMeter, unit));
}

const DURATION_PATTERN = /^(?:(\d+):([0-5]\d):([0-5]\d)|(\d+):([0-5]\d))$/;

/**
 * Parse `m:ss` or `h:mm:ss` (the output of `formatDuration`, so the two round-trip) into
 * seconds. Minutes in `m:ss` may exceed 59 (`75:00` is 4500 s). Surrounding whitespace is
 * ignored. Returns `undefined` for anything else.
 */
export function parseDuration(text: string): number | undefined {
  const match = DURATION_PATTERN.exec(text.trim());
  if (!match) return undefined;
  const [, h, m, s, mm, ss] = match;
  if (h !== undefined) return Number(h) * 3600 + Number(m) * 60 + Number(s);
  return Number(mm) * 60 + Number(ss);
}
