# GPX fixture corpus

Committed GPX files for the parser tests and the golden snapshots (one snapshot per file in this
folder; `invalid/` holds files that must be rejected). Nothing here is fetched at test time.

Provenance is one of:

- **Authentic:** a real export, copied unchanged from the original Cornell project
  ([daniel-lee-user/perfect-pace](https://github.com/daniel-lee-user/perfect-pace), `data/`, commit
  `83a5524`).
- **Synthetic dialect imitation:** written for this repo to reproduce the structure a tool exports
  (root attributes, namespaces, extensions, number formatting, point layout) over a made-up path near
  Ithaca, NY. These are not real exports: real ones need an account login, so they could not be
  downloaded here. Replace them with real exports when available, keeping the file names.
- **Hand-made:** a small file written to exercise one edge case.

## Courses

| File                          | Provenance                  | Source and what it covers                                                                                                                          |
| ----------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FH-Fox.gpx`                  | Authentic                   | Run Go app export: minified on one line, no track name, a duplicate point                                                                          |
| `Freeville-Fly-In.gpx`        | Authentic                   | Run Go app export: minified, several consecutive duplicate points                                                                                  |
| `Lakefront-Loops-5K.gpx`      | Authentic                   | Run Go app export: minified, a short 5K                                                                                                            |
| `boston.gpx`                  | Authentic                   | Garmin Connect course (via goandrace.com): Boston Marathon, the 26.2 mi golden distance check, tab and space indentation, `ns2`/`ns3` namespaces   |
| `newyork.gpx`                 | Authentic                   | Garmin Connect course (via goandrace.com): New York City Marathon                                                                                  |
| `wineglass.gpx`               | Authentic                   | Strava route export (`StravaGPX`): Wineglass Marathon, metadata with author, copyright and links, long float noise in coordinates                  |
| `dodge.gpx`                   | Authentic                   | onthegomap route export: `standalone="yes"` declaration, metadata with copyright                                                                   |
| `forest_home.gpx`             | Authentic                   | onthegomap route export                                                                                                                            |
| `scurve.gpx`                  | Authentic                   | onthegomap route export                                                                                                                            |
| `strava-activity.gpx`         | Synthetic dialect imitation | Strava activity export: `gpxtpx` heart rate and cadence extensions, per-point `<time>`, a 12-fix stop at a crossing (timestamp-only noise)         |
| `garmin-connect-activity.gpx` | Synthetic dialect imitation | Garmin Connect activity export: `ns3:TrackPointExtension`, float32 values printed in full, millisecond times, an 8-fix auto-pause stop             |
| `apple-health-route.gpx`      | Synthetic dialect imitation | Apple Health `export.zip` workout route (`creator="Apple Health Export"`, what converters read): `lon` before `lat`, unprefixed extension children |
| `ridewithgps-track.gpx`       | Synthetic dialect imitation | RideWithGPS "GPX Track" export: cue sheet as `<wpt>`s ahead of the track                                                                           |
| `ridewithgps-route.gpx`       | Synthetic dialect imitation | RideWithGPS "GPX Route" export: the same course as `<rte>`/`<rtept>`                                                                               |
| `multi-segment.gpx`           | Hand-made                   | One `<trk>` with three `<trkseg>`s plus an empty one, joined in order                                                                              |
| `multi-track.gpx`             | Hand-made                   | Two tracks and a route (the longest, the second, is the default), a one-point track that is skipped, a waypoint                                    |
| `prefixed-namespace.gpx`      | Hand-made                   | Every element prefixed (`g:trkpt`), an `<ele>` inside a foreign-namespace extension that must be ignored                                           |
| `bom-crlf-cdata.gpx`          | Hand-made                   | UTF-8 byte order mark, CRLF line endings, a doctype with an internal subset, CDATA names and values, comments, entities, single-quoted attributes  |
| `gpx-1.0.gpx`                 | Hand-made                   | GPX 1.0 as GPSBabel writes it: `<name>` directly under `<gpx>`, `<speed>` and `<course>` in points                                                 |
| `no-elevation.gpx`            | Hand-made                   | No `<ele>` on any point                                                                                                                            |
| `partial-elevation.gpx`       | Hand-made                   | `<ele>` on some points only, plus empty and unparseable values                                                                                     |
| `zero-elevation.gpx`          | Hand-made                   | Every `<ele>` is exactly 0 (a placeholder), so the course has no elevation                                                                         |
| `duplicates-and-noise.gpx`    | Hand-made                   | Stationary fixes differing only in `<time>`, exact duplicates, a time-only point, a 0,0 no-fix point, out-of-range and unparseable coordinates     |

## Invalid files (`invalid/`)

| File                      | Provenance | Expected error                                                    |
| ------------------------- | ---------- | ----------------------------------------------------------------- |
| `empty.gpx`               | Hand-made  | `empty`: zero bytes                                               |
| `not-xml.gpx`             | Hand-made  | `not-xml`: GeoJSON saved with a `.gpx` name                       |
| `binary-fit.gpx`          | Hand-made  | `not-xml`: the start of a binary FIT file                         |
| `kml.gpx`                 | Hand-made  | `not-gpx`: a KML document                                         |
| `tcx.gpx`                 | Hand-made  | `not-gpx`: a TCX document                                         |
| `html-page.gpx`           | Hand-made  | `not-gpx`: a login page saved instead of the export               |
| `metadata-only.gpx`       | Hand-made  | `no-points`: metadata and an empty track                          |
| `waypoints-only.gpx`      | Hand-made  | `no-points`: waypoints but no track or route                      |
| `invalid-coordinates.gpx` | Hand-made  | `no-points`: every point has a missing or out-of-range coordinate |
| `single-point.gpx`        | Hand-made  | `single-point`: one track point                                   |
| `standing-still.gpx`      | Hand-made  | `single-point`: three fixes at one position                       |
| `truncated.gpx`           | Hand-made  | `malformed`: the first 1500 bytes of the authentic `dodge.gpx`    |
| `mismatched-tags.gpx`     | Hand-made  | `malformed`: an `<ele>` closed by `</trkpt>`                      |
