/**
 * Writing a course as GPX 1.1: one `<trk>` with one `<trkseg>`, for exporting a drawn route (or a
 * loaded course) to a watch or another app. What it writes, `parseGpx` reads back to the same
 * points (to the precision below), and so do other GPX readers.
 */
import type { TrackPoint } from "./course.ts";

/** Decimal places written for latitude and longitude (about 1 cm). */
export const GPX_COORDINATE_DECIMALS = 7;
/** Decimal places written for elevation (1 cm). */
export const GPX_ELEVATION_DECIMALS = 2;

export interface GpxWriteOptions {
  /** The course name, written as both the file's and the track's `<name>`. */
  name?: string;
  /** The `creator` attribute. Default: `Perfect Pace`. */
  creator?: string;
}

/** Text escaped for an XML attribute or element. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" }[c]};`);
}

/** Characters XML 1.0 does not allow anywhere, even escaped. */
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

/** A number to `decimals` places, without trailing zeros or exponent notation (`-76.4795`, `12`). */
function fixed(value: number, decimals: number): string {
  const text = value.toFixed(decimals);
  const trimmed = text.includes(".") ? text.replace(/\.?0+$/, "") : text;
  return trimmed === "-0" ? "0" : trimmed;
}

/**
 * The GPX 1.1 text of a course. Elevations are written for the points that have one. Throws a
 * `RangeError` for an empty track or a point off the globe (or with a non-finite elevation).
 */
export function writeGpx(points: readonly TrackPoint[], options: GpxWriteOptions = {}): string {
  if (points.length === 0) throw new RangeError("writeGpx: a track needs at least one point");
  const name = options.name?.replace(INVALID_XML, "").trim();
  const creator = (options.creator ?? "Perfect Pace").replace(INVALID_XML, "");
  const nameTag = name ? `<name>${escapeXml(name)}</name>` : "";
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${escapeXml(creator)}" xmlns="http://www.topografix.com/GPX/1/1">`,
    ...(nameTag ? [`  <metadata>${nameTag}</metadata>`] : []),
    `  <trk>${nameTag}<trkseg>`,
  ];
  points.forEach((p, i) => {
    if (!(Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180)) {
      throw new RangeError(`writeGpx: point ${i} has an invalid position ${p.lat}, ${p.lon}`);
    }
    if (p.ele !== undefined && !Number.isFinite(p.ele)) {
      throw new RangeError(`writeGpx: point ${i} has an invalid elevation ${p.ele}`);
    }
    const position = `lat="${fixed(p.lat, GPX_COORDINATE_DECIMALS)}" lon="${fixed(p.lon, GPX_COORDINATE_DECIMALS)}"`;
    lines.push(
      p.ele === undefined
        ? `    <trkpt ${position}/>`
        : `    <trkpt ${position}><ele>${fixed(p.ele, GPX_ELEVATION_DECIMALS)}</ele></trkpt>`,
    );
  });
  lines.push("  </trkseg></trk>", "</gpx>", "");
  return lines.join("\n");
}
