/**
 * Serialize a track as GPX in the dialects real tools write, for round-trip tests and the parse
 * benchmark. Coordinates and elevations are written with `String(n)`, which round-trips exactly,
 * so a parsed file must give back the very same numbers.
 */
import type { TrackPoint } from "../../src/index.ts";

export const DIALECTS = [
  "strava",
  "garmin",
  "apple-health",
  "ridewithgps-route",
  "onthegomap",
  "prefixed",
  "gpx10",
  "windows",
  "minified",
] as const;
export type Dialect = (typeof DIALECTS)[number];

export interface SerializeOptions {
  name?: string;
  /** Split a `<trk>` into this many `<trkseg>`s (ignored by route dialects). Default 1. */
  segments?: number;
}

const START_MS = Date.UTC(2024, 3, 15, 13, 50, 0);
const iso = (i: number): string => new Date(START_MS + i * 1000).toISOString().replace(".000Z", "Z");
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const GPX11 =
  'xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd"';

/** Split `points` into `count` contiguous, non-empty runs (fewer when there are fewer points). */
function split<T>(points: readonly T[], count: number): T[][] {
  const k = Math.max(1, Math.min(count, points.length));
  return Array.from({ length: k }, (_, s) =>
    points.slice(Math.floor((s * points.length) / k), Math.floor(((s + 1) * points.length) / k)),
  );
}

function trk(points: readonly TrackPoint[], opts: SerializeOptions, point: (p: TrackPoint, i: number) => string) {
  let i = 0;
  const segs = split(points, opts.segments ?? 1).map(
    (seg) => `  <trkseg>\n${seg.map((p) => point(p, i++)).join("")}  </trkseg>\n`,
  );
  return `<trk>\n${opts.name === undefined ? "" : `  <name>${esc(opts.name)}</name>\n`}${segs.join("")}</trk>\n`;
}

const ele = (p: TrackPoint, open = "<ele>", close = "</ele>"): string =>
  p.ele === undefined ? "" : `${open}${p.ele}${close}`;

const writers: Record<Dialect, (points: readonly TrackPoint[], opts: SerializeOptions) => string> = {
  strava: (points, opts) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx creator="StravaGPX" version="1.1" ${GPX11} xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">\n <metadata>\n  <time>${iso(0)}</time>\n </metadata>\n` +
    trk(
      points,
      opts,
      (p, i) =>
        `   <trkpt lat="${p.lat}" lon="${p.lon}">\n    ${ele(p)}\n    <time>${iso(i)}</time>\n    <extensions>\n     <gpxtpx:TrackPointExtension>\n      <gpxtpx:hr>${140 + (i % 20)}</gpxtpx:hr>\n      <gpxtpx:cad>${84 + (i % 5)}</gpxtpx:cad>\n     </gpxtpx:TrackPointExtension>\n    </extensions>\n   </trkpt>\n`,
    ) +
    "</gpx>\n",
  garmin: (points, opts) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx creator="Garmin Connect" version="1.1"\n  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/11.xsd"\n  xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"\n  xmlns="http://www.topografix.com/GPX/1/1"\n  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ns2="http://www.garmin.com/xmlschemas/GpxExtensions/v3">\n  <metadata>\n    <link href="connect.garmin.com">\n      <text>Garmin Connect</text>\n    </link>\n    <time>${iso(0)}</time>\n  </metadata>\n` +
    trk(
      points,
      opts,
      (p, i) =>
        `      <trkpt lat="${p.lat}" lon="${p.lon}">\n        ${ele(p)}\n        <time>${iso(i)}</time>\n        <extensions>\n          <ns3:TrackPointExtension>\n            <ns3:atemp>18.0</ns3:atemp>\n            <ns3:hr>${130 + (i % 30)}</ns3:hr>\n            <ns3:cad>${80 + (i % 9)}</ns3:cad>\n          </ns3:TrackPointExtension>\n        </extensions>\n      </trkpt>\n`,
    ) +
    "</gpx>\n",
  // Apple Health's own export writes lon before lat and unprefixed extension children.
  "apple-health": (points, opts) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Apple Health Export" ${GPX11}>\n<metadata>\n<time>${iso(0)}</time>\n</metadata>\n` +
    trk(
      points,
      opts,
      (p, i) =>
        `<trkpt lon="${p.lon}" lat="${p.lat}">${ele(p)}<time>${iso(i)}</time><extensions><speed>3.1</speed><course>${i % 360}</course><hAcc>1.9</hAcc><vAcc>1.3</vAcc></extensions></trkpt>\n`,
    ) +
    "</gpx>\n",
  "ridewithgps-route": (points, opts) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="http://ridewithgps.com/" ${GPX11}>\n  <metadata>\n    <name>${esc(opts.name ?? "Route")}</name>\n  </metadata>\n  <rte>\n${opts.name === undefined ? "" : `    <name>${esc(opts.name)}</name>\n`}` +
    points.map((p) => `    <rtept lat="${p.lat}" lon="${p.lon}">${ele(p)}</rtept>\n`).join("") +
    "  </rte>\n</gpx>\n",
  onthegomap: (points, opts) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<gpx version="1.1" creator="https://onthegomap.com" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata>\n    <name>route</name>\n  </metadata>\n  ` +
    trk(points, opts, (p) => `      <trkpt lat="${p.lat}" lon="${p.lon}">\n        ${ele(p)}\n      </trkpt>\n`) +
    "</gpx>\n",
  // Every element carries a gpx: prefix, and point attributes are written in the GPX namespace too.
  prefixed: (points, opts) =>
    `<?xml version="1.0"?>\n<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1" version="1.1" creator="prefixed">\n` +
    trk(
      points,
      opts,
      (p) => `<gpx:trkpt gpx:lat="${p.lat}" gpx:lon="${p.lon}">${ele(p, "<gpx:ele>", "</gpx:ele>")}</gpx:trkpt>\n`,
    )
      .replace(/<(\/?)(trk|trkseg|name)>/g, "<$1gpx:$2>")
      .trimEnd() +
    "\n</gpx:gpx>\n",
  gpx10: (points, opts) =>
    `<?xml version="1.0" encoding="ISO-8859-1"?>\n<gpx version="1.0" creator="GPSBabel - https://www.gpsbabel.org" xmlns="http://www.topografix.com/GPX/1/0">\n<name>converted</name>\n<time>${iso(0)}</time>\n` +
    trk(
      points,
      opts,
      (p, i) => `<trkpt lat="${p.lat}" lon="${p.lon}">${ele(p)}<time>${iso(i)}</time><speed>3.0</speed></trkpt>\n`,
    ) +
    "</gpx>\n",
  // A byte order mark, CRLF, single-quoted attributes, CDATA, comments and character references.
  windows: (points, opts) =>
    (
      `\ufeff<?xml version='1.0' encoding='UTF-8'?>\n<!-- exported on Windows -->\n<gpx version='1.1' creator='Desktop &amp; Co' xmlns='http://www.topografix.com/GPX/1/1'>\n` +
      trk(
        points,
        { ...opts, name: undefined },
        (p) => `<trkpt lat='${p.lat}' lon='${p.lon}' >${ele(p, "<ele> ", " </ele>")}<!-- fix --></trkpt>\n`,
      ).replace("<trk>\n", `<trk>\n<name><![CDATA[${opts.name ?? ""}]]></name>\n`) +
      "</gpx>\n"
    ).replace(/\n/g, "\r\n"),
  minified: (points, opts) =>
    `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Run Go" ${GPX11}>` +
    trk(points, opts, (p) => `<trkpt lat="${p.lat}" lon="${p.lon}">${ele(p)}</trkpt>`).replace(/\n\s*/g, "") +
    "</gpx>",
};

/** Serialize `points` as a GPX file in `dialect`. */
export function toGpx(dialect: Dialect, points: readonly TrackPoint[], opts: SerializeOptions = {}): string {
  return writers[dialect](points, opts);
}

/** True for dialects that write a `<rte>` rather than a `<trk>`. */
export const isRouteDialect = (dialect: Dialect): boolean => dialect === "ridewithgps-route";
