/**
 * The encoded polyline format (the one Google Maps, OSRM and Valhalla use) for compact lines in
 * share links. Each coordinate is rounded to `precision` decimal places, and each point is written
 * as its difference from the one before, so a track of nearby points costs a few characters each.
 *
 * Each signed difference is zigzag folded to an unsigned integer and written in 5-bit groups,
 * lowest first, each group a character (`group + 63`, with `0x20` set on every group but the
 * last). `toUrlSafe` maps those 64 characters onto the base64url alphabet, so an encoded line can
 * sit in a URL without any percent-encoding.
 */
import type { LatLon } from "./geo.ts";

/** The decimal places the standard format uses (about 1.1 m of latitude). */
export const DEFAULT_POLYLINE_PRECISION = 5;

/** An encoded line that cannot be read: a bad character, or a value cut off mid-way. */
export class PolylineError extends Error {
  override readonly name = "PolylineError";
}

function checkPrecision(precision: number): number {
  if (!(Number.isInteger(precision) && precision >= 0 && precision <= 7)) {
    throw new RangeError(`polyline precision must be a whole number from 0 to 7, got ${precision}`);
  }
  return 10 ** precision;
}

function writeValue(delta: number, out: string[]): void {
  // Zigzag: 0, -1, 1, -2, 2 ... become 0, 1, 2, 3, 4 ... (arithmetic, so no 32-bit overflow).
  let value = delta < 0 ? -2 * delta - 1 : 2 * delta;
  while (value >= 0x20) {
    out.push(String.fromCharCode((0x20 | (value % 0x20)) + 63));
    value = Math.floor(value / 0x20);
  }
  out.push(String.fromCharCode(value + 63));
}

/**
 * Encode points as a polyline, rounding each coordinate to `precision` decimal places. Throws a
 * `RangeError` for a precision outside 0 to 7 or a coordinate that is not finite.
 */
export function encodePolyline(points: readonly LatLon[], precision = DEFAULT_POLYLINE_PRECISION): string {
  const scale = checkPrecision(precision);
  const out: string[] = [];
  let lastLat = 0;
  let lastLon = 0;
  for (const p of points) {
    if (!(Number.isFinite(p.lat) && Number.isFinite(p.lon))) {
      throw new RangeError(`encodePolyline: invalid position ${p.lat}, ${p.lon}`);
    }
    const lat = Math.round(p.lat * scale);
    const lon = Math.round(p.lon * scale);
    writeValue(lat - lastLat, out);
    writeValue(lon - lastLon, out);
    lastLat = lat;
    lastLon = lon;
  }
  return out.join("");
}

/** Values past this would need more than 2^53 to add up, which no coordinate does. */
const MAX_GROUPS = 10;

/**
 * Decode a polyline written with `precision` decimal places. Each coordinate comes back as an
 * integer divided by `10 ** precision`, so a coordinate rounded the same way (as `roundCoordinate`
 * does at 5 places) round-trips exactly. Throws a `PolylineError` for a character outside the
 * format, a value cut off at the end, or a point missing its longitude. Positions are not range
 * checked here.
 */
export function decodePolyline(text: string, precision = DEFAULT_POLYLINE_PRECISION): LatLon[] {
  const scale = checkPrecision(precision);
  const values: number[] = [];
  let value = 0;
  let factor = 1;
  let groups = 0;
  for (let i = 0; i < text.length; i++) {
    const group = text.charCodeAt(i) - 63;
    if (group < 0 || group > 63) throw new PolylineError(`unexpected character at ${i}`);
    value += (group % 0x20) * factor;
    factor *= 0x20;
    if (++groups > MAX_GROUPS) throw new PolylineError(`value too long at ${i}`);
    if (group < 0x20) {
      values.push(value % 2 === 1 ? -(value + 1) / 2 : value / 2);
      value = 0;
      factor = 1;
      groups = 0;
    }
  }
  if (groups > 0) throw new PolylineError("cut off in the middle of a value");
  if (values.length % 2 === 1) throw new PolylineError("the last point has no longitude");
  const points: LatLon[] = [];
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < values.length; i += 2) {
    lat += values[i]!;
    lon += values[i + 1]!;
    // `+ 0` turns -0 into 0, as `roundCoordinate` does.
    points.push({ lat: lat / scale + 0, lon: lon / scale + 0 });
  }
  return points;
}

/** The base64url alphabet: every character is safe anywhere in a URL. */
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const FROM_URL_SAFE = new Map([...URL_SAFE].map((c, i) => [c, String.fromCharCode(i + 63)]));

/** A polyline with its characters (63 to 126) mapped one to one onto the base64url alphabet. */
export function toUrlSafe(polyline: string): string {
  let out = "";
  for (let i = 0; i < polyline.length; i++) {
    const c = URL_SAFE[polyline.charCodeAt(i) - 63];
    if (c === undefined) throw new PolylineError(`unexpected character at ${i}`);
    out += c;
  }
  return out;
}

/** The polyline that `toUrlSafe` mapped to `text`. Throws a `PolylineError` for a character outside base64url. */
export function fromUrlSafe(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = FROM_URL_SAFE.get(text[i]!);
    if (c === undefined) throw new PolylineError(`unexpected character at ${i}`);
    out += c;
  }
  return out;
}
