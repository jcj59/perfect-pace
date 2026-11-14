# OpenRouteService fixtures

Responses from the ORS directions endpoint (`POST /v2/directions/foot-walking/geojson`) that the
Worker tests replay instead of calling the network. Each file is one case from `cases.json`:

| Field        | Meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| `source`     | `recorded` (from the real API) or `synthetic` (written by hand)      |
| `recordedAt` | The date it was recorded, or `null` when synthetic                   |
| `case`       | The case from `cases.json`: name, description, `from`, `to`          |
| `upstream`   | The URL and JSON body the Worker must send (the tests check it does) |
| `response`   | The HTTP status and JSON body ORS answered with                      |

| File                  | Covers                                                       |
| --------------------- | ------------------------------------------------------------ |
| `central-park.json`   | A successful short walk (200, a LineString and a distance)   |
| `ithaca-falls.json`   | A second successful walk, with switchbacks                   |
| `atlantic-ocean.json` | No routable point near the coordinates (404, ORS error 2010) |

## The current files are synthetic

**Every fixture here is `source: "synthetic"`.** They were written by hand, without an API key, in
the exact response shape the ORS documentation gives (a `FeatureCollection` with one `Feature`,
`properties.summary.distance` in meters, `metadata.query` echoing the request, and errors as
`{ "error": { "code", "message" }, "info" }`). The geometries are hand-drawn polylines near the
real paths, and their distances are the haversine lengths of those polylines. They are not real
routes. Replace them with recorded ones as soon as there is a key:

```sh
ORS_API_KEY=... pnpm fixtures:record          # all cases, or name some: ... fixtures:record central-park
pnpm format
git diff apps/worker/test/fixtures/ors        # review it like code
```

Get a free key at <https://openrouteservice.org/dev/#/signup> (each case costs one request of the
2,000 a day). The recorder writes `source: "recorded"` and the date. To add a case, append it to
`cases.json` and record it; the Worker tests replay every fixture file.

Upstream failures that cannot be recorded on demand (429 quota, 401/403 bad key, 5xx, timeouts,
malformed bodies) are built inline in `../../route.test.ts` from the documented shapes.
