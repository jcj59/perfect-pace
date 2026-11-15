# Share links, exports and the saved session

How a plan leaves the app (B6 in [mvp-plan.md](mvp-plan.md)). Nothing is stored on a server: a
share link carries the whole plan, and the saved session lives in the browser's local storage.

## Share links

**Copy link** in the panel's Share and export card copies a link like

```
https://perfect-pace.hf-worker.workers.dev/#v=1&c=d.3ps.<points>&g=10800&k=6&s=402.336&u=mi
```

The fragment (never sent to the server) is a versioned list of fields, written and read by
`packages/core/src/share.ts`:

| Field | Meaning                                                                                   |
| ----- | ----------------------------------------------------------------------------------------- |
| `v`   | Format version, now `1`. Newer versions ask the reader to reload; older ones are refused. |
| `c`   | The course: `d.<modes>.<waypoints>` for a drawn route, `t.<points>` for an uploaded one.  |
| `g`   | Goal time in seconds. Left out while the goal is the suggested one.                       |
| `k`   | Pace changes (0 to 10).                                                                   |
| `s`   | Shortest segment in meters (0 for no minimum).                                            |
| `u`   | Units, `mi` or `km`. They apply to that visit only, not to the reader's saved preference. |
| `n`   | The course name, percent-encoded (uploaded courses only).                                 |

Points are an [encoded polyline](https://developers.google.com/maps/documentation/utilities/polylinealgorithm)
at 5 decimal places (about 1 m), with its 64 characters mapped onto the base64url alphabet so the
link never needs percent-encoding (`packages/core/src/polyline.ts`). Leg modes are run-length
encoded: `p` for paths, `s` for straight, each after its count when more than 1.

- **Drawn routes** carry their waypoints and leg modes exactly. Where the link opens, the legs
  that follow paths are routed again through `/api/route` (straight legs need no network), so the
  plan is the same as long as the routing service answers the same way. If a leg cannot be routed
  there, drawing mode opens with its error and the straight-line offer.
- **Uploaded courses** carry a simplified copy of the track: the finest Douglas-Peucker tolerance of
  1, 2, 3, 5, 8, 12 or 20 m that fits, as long as the simplified length stays **within 0.5% of the
  course's distance** (the card states the actual figure). The copy has no elevation, so where the
  link opens **elevation comes from terrain data**, and the plan there can differ slightly from the
  one made with the file's own GPS elevation. The panel says so in both places.
- **Size limit:** links are kept to **8,000 characters**, well inside what browsers, chat apps and
  email carry intact. A course that will not fit (too many waypoints, or a track too long or
  detailed to simplify within the 0.5% bound) gets a note instead of the Copy link button,
  pointing to the GPX download.
- **Damaged or unknown links** (cut off, edited, or from another version) never half-load: the
  panel says the link could not be opened and why, and the saved session loads instead.

## Exports

- **GPX** (`packages/core/src/gpx-write.ts`): GPX 1.1, one track. A drawn route gets elevation from
  terrain data; a loaded course is written as loaded, with the file's own elevation. Every export
  reads back through our own parser to the same points (a core round-trip test).
- **CSV:** one row per segment (start, end, distance, pace, grade, time, elapsed, reason), then a
  Finish row. Times are rounded so they add up to the goal, as in the panel's table.
- **Pace band:** Print opens the browser's print dialog with only the pace band on the page: the
  clock time at every mile or kilometer, each split, the segment colors and where the pace changes,
  then the segments with their reasons. Long courses flow into several strips of up to 30 rows.

## Saved session

The last course and plan inputs are kept in local storage (`pp:session`, plus `pp:session-gpx`
for a loaded file's text) and come back on the next visit. A loaded file comes back exactly, from
its own text. A file too large for storage is kept as a simplified copy instead (shown as such,
with elevation from terrain data). Storage that is missing, full or blocked is ignored: the app
works the same, it just starts empty.
