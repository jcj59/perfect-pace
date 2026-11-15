# Perfect Pace: MVP Plan

Perfect Pace is a rebuild of the Cornell CS 5999 project (`daniel-lee-user/perfect-pace`) as a personal project. Given a course (an uploaded GPX file or a route drawn on the map) and a goal time, it produces an elevation-aware pacing plan with a small number of pace changes. It has a clean, minimal, mobile-first UI.

## Decisions so far

- **Local-first.** All course processing and plan computation runs in the browser, in `@pp/core` (pure TypeScript, run in a Web Worker). The backend is a thin Cloudflare Worker.
- **Routing:** hosted OpenRouteService (foot profile) behind a Worker proxy that holds the API key, behind a `RoutingProvider` interface so it can be swapped for self-hosted Valhalla later.
- **Pacing scope:** the same as the original project. Goal time plus a number of pace changes gives a piecewise-constant pace plan. Extensions are listed at the end and are out of scope.
- **No accounts.** Sharing is through URLs, and persistence uses local storage.
- **Mobile:** a responsive PWA first, structured so that a Capacitor wrapper (or React Native using `@pp/core`) is possible later.
- **Phase 2 (added 2026-11-15):** weather comes from Open-Meteo, called from the browser behind a `WeatherProvider` interface. User problem reports become GitHub issues through a Worker endpoint. Conditions (weather, surface, altitude) enter as pace factors that multiply the ideal pace, scaffolded with neutral multipliers before any model is chosen.

## Algorithm summary (why there is no LP solver)

- **The goal.** Given resampled course points with ideal (grade-adjusted) paces `o_i` and lengths `w_i`, choose at most `K` contiguous pieces with one constant pace each, minimizing `sum_i w_i (p_i - o_i)^2`.
- **Why the time constraint takes care of itself.** For a fixed partition, the optimal pace of each piece is the length-weighted mean of `o` over that piece. The ideal paces already sum to the goal time, so these piece means do too. The time constraint is satisfied automatically.
- **The algorithm.** What remains is segmented least squares, solved exactly by dynamic programming in `O(K n^2)` using prefix sums of `w`, `w*o` and `w*o^2`. Each piece cost takes `O(1)`. One run yields the optimal plan and its error for every `k <= K`.
- **Ideal pace model (v1).** The Jack Daniels rule from the original code: +12 s/mi per 1% uphill and -7 s/mi per 1% downhill, applied to a base pace solved so that total time equals the goal. It is pluggable and shown to the user as a stated assumption.
- **Minimum piece length.** An optional constraint, for example 0.2 mi, that keeps the plan from producing silly 30 m segments. It costs nothing extra in the DP.

## MVP scope: deliverables and behaviors

Each behavior lists its acceptance criteria and how it is tested. "E2E" means Playwright driving the real built app (real Worker via `wrangler dev`, real map, real Web Worker) at both desktop and phone viewports.

### B1. Load a course from a GPX file
- Load by drag-and-drop or file picker on desktop, and the file picker on a phone.
- Handles:
  - `<trk>` with multiple `<trkseg>` (joined in order)
  - `<rte>`/`<rtept>`
  - multiple tracks (the user picks one, defaulting to the longest)
  - namespaced or prefixed tags, a BOM, CDATA, and CRLF line endings
  - missing, partial or zero `<ele>`
  - duplicate consecutive points and timestamp-only noise
- A 50k-point file parses and renders in under 1 s on a mid-range laptop.
- Invalid files show a specific, human-readable error (not XML, no track points, a single point, and so on), never a crash.
- **Tests:**
  - core unit tests over a fixture corpus: the 9 GPX files from the original repo, plus real exports from Strava, Garmin Connect, Apple Health (via a converter), RideWithGPS and onthegomap, plus hand-made edge cases
  - seeded randomized tests (generate a course, serialize it in several GPX dialects, parse it, and assert the points match)
  - golden distances (Boston about 26.2 mi within 0.5%)
  - E2E: upload each corpus file and assert that the map shows a route and the stats panel shows its distance
  - E2E: upload broken files and assert the error copy

### B2. Draw a course by clicking on the map
- **Waypoint editing:**
  - click or tap to add a waypoint; each leg snaps to paths through the routing proxy
  - drag waypoints, and drag the midpoint of a leg to insert one
  - tap a waypoint to delete it
  - undo/redo, and clear
- **Per-leg mode toggle:** snap to paths, or a straight line (freehand).
- **Shortcuts:** "Close loop" and "Out and back".
- Distance updates live. Moving a waypoint re-routes only its two neighboring legs.
- If routing fails, show a non-blocking error and offer a straight-line fallback for that leg.
- **Tests:**
  - core unit tests for leg stitching and the edit history (pure reducer)
  - Worker integration tests (Miniflare) with recorded ORS responses
  - E2E: click 4 points, assert the leg count and distance, drag a waypoint and assert only 2 route requests fire, undo/redo, close loop
  - E2E at the phone viewport with touch events
  - one live smoke test against real ORS, run nightly and not on every PR, to save quota

### B3. Trustworthy elevation profile
- Points are resampled to a fixed spacing (default 10 m).
- **Elevation source policy:**
  - use GPS elevation when it is present and sane
  - otherwise fill or replace it from the DEM (AWS Terrarium tiles)
  - drawn routes always use the DEM
- Distance-based smoothing, grades clamped to +/-30%, and total gain/loss computed with a hysteresis threshold.
- Shown: distance, gain, loss, minimum/maximum elevation.
- **Tests:**
  - synthetic profiles (a known hill plus injected noise and spikes) recover gain within tolerance
  - a no-elevation GPX gets filled from a fixture DEM tile provider
  - golden gain for known courses within a stated tolerance
  - E2E: a GPX without elevation still shows a profile

### B4. Pacing plan
- **Inputs:** goal time (h:mm:ss), number of pace changes (a slider), units (mi/km), minimum segment length.
- **Output:** a segment table with start-end distance, pace, average grade, and a short reason (for example, "climb: +3.8% over 0.6 mi").
- The total predicted time equals the goal within 1 s.
- A small "error vs number of pace changes" curve shows the diminishing returns, which makes the plan explainable.
- Recompute after changing any input takes under 50 ms for a marathon at 10 m spacing (about 4,200 points), measured in the worker.
- **Tests:**
  - DP vs brute force on small `n`, exhaustive and randomized
  - invariants: total time equals the goal, piece count <= K, error is non-increasing in K, and every piece respects the minimum length
  - a benchmark test with a time budget
  - a sanity comparison against the original repo's `results/` output for the same courses (direction of the pace shifts, not exact values, since the old objective was unweighted)
  - E2E: upload Boston, set 3:00:00 and 6 changes, assert the table times sum to 3:00:00 and the segments render on the map and chart

### B5. Linked map and chart
- Plan segments are colored consistently on the map line and the elevation chart.
- Hovering, or scrubbing by touch, on the chart moves a marker on the map. Hovering on the route line highlights that point on the chart.
- Selecting a table row highlights its segment on both.
- **Tests:** E2E hover and scrub asserts the marker position. Screenshots go in PR descriptions.

### B6. Export, share, persist
- Export the drawn route as GPX (it round-trips through our own parser), export the plan as CSV, and offer a printable pace band (print CSS).
- **Share link:** the URL hash encodes the course plus plan inputs. Drawn routes are encoded as waypoints plus leg modes. Uploaded courses use a simplified, polyline-encoded track.
- The last course and settings restore from local storage.
- **Tests:**
  - core round-trip tests (export, then parse, then compare)
  - URL encode/decode round trip
  - E2E: build a plan, copy the link, open it in a fresh context, and assert the same plan
  - E2E: reload and assert the state restores

### B7. Mobile and PWA
- Usable at 375 px wide: a full-bleed map with a bottom sheet (peek, half, full) and no horizontal scroll.
- Installable (manifest plus service worker). It works offline for uploaded GPX courses with cached app shell and DEM tiles; drawing a route needs a network connection.
- Light and dark themes.
- **Tests:**
  - Playwright projects for iPhone and Pixel emulation running the whole E2E suite
  - a Lighthouse CI check (PWA installable, accessibility >= 95)
  - a manual check on a real phone before calling the MVP done

### Non-goals for the MVP
Accounts or a saved-route library, effort/fatigue models, native apps, FIT/TCX import, Strava integration, and self-hosted tiles or routing.

## Phase 2 scope: end goals and behaviors

Added 2026-11-15, after PR 13 was in flight. These land before the acceptance pass (PR 14 now runs last, see the PR plan), so the acceptance audit covers B1 to B14. Each behavior states the **end goal** (where the feature is headed, including parts not built yet) and then what this phase delivers.

### B8. Plan explanation behind an info button
- **End goal:** the plan view shows only the plan. The explanation (pace model, flat-ground pace, how segments are averaged, and later which condition factors are active) is one tap away and never takes permanent panel space.
- **This phase:**
  - the always-visible "How the plan works" note (`Assumption` in `PacingPlan.tsx`) is removed
  - a small (i) button beside the "Pacing plan" heading opens a popover with that same text
  - the popover is a real disclosure: `aria-expanded`, Esc and outside click close it, focus moves into it and returns to the button, and it fits inside the phone sheet without horizontal scroll
- **Tests:** E2E opens and closes it by mouse, keyboard and touch at all three viewports; axe on the open state; visual baselines for the plan view (now shorter) and the open popover.

### B9. Resizable side panel
- **End goal:** on desktop the user sizes the panel to taste (a wide panel for the table, a narrow one for the map), and the app remembers it.
- **This phase:**
  - a drag handle on the panel's right edge, with a resize cursor and a visible grip on hover and focus
  - width clamped to 320 px minimum and `min(720 px, 60% of the window)` maximum; double-click resets to the default 384 px
  - keyboard: the handle is a focusable `role="separator"` with `aria-valuenow/min/max`; arrow keys move 16 px, Home and End jump to min and max
  - the width persists per device (`pp:panelWidth`) and is re-clamped when the window shrinks
  - the map's camera padding follows the panel, applied when a drag ends (not every frame), so a loaded course stays framed clear of the panel; the chart and table reflow live
  - phones keep the bottom sheet with its snap points; the handle does not render there
- **Tests:** E2E drags the handle and asserts the width, the clamps, the reset, keyboard resizing and restore after reload; a test that the course stays clear of the panel after a resize; visual baselines at a wide and a narrow width.

### B10. Remember the last map view
- **End goal:** opening the site on a device puts the map back where the user last looked, so a returning user is never dropped onto a whole-US view.
- **This phase:**
  - the camera (center, zoom) is saved to local storage (`pp:camera`, versioned like the session) on `moveend`, debounced
  - start-up framing precedence: a share link frames its course; otherwise the saved camera; otherwise a restored session course is fit as today; otherwise the default US bounds
  - a corrupt or out-of-range saved camera is ignored, never an error
- **Tests:** E2E pans and zooms, reloads, and asserts the center and zoom within a tolerance at desktop and phone; a share link wins over the saved camera; a corrupt value falls back to the default; unit tests for the precedence function.

### B11. Plan types and split views
- **End goal:** the user picks how the plan is shaped, as the original app allowed ("Hill Detection", "Per Mile", "Per Kilometer", "No Segments", "Custom Segments", plus its Segments vs Miles/Kilometers table toggle), and every type shares the same ideal-pace model so they are directly comparable.
- **This phase, plan types** (a segmented control above the plan inputs):
  - **Optimal** (today's DP with K pace changes and a shortest segment, the default)
  - **Even pace:** one segment
  - **Splits:** a segment per split, with split length 1 mi, 1 km, or a custom distance (for example 5 km or 0.5 mi); the last split is the remainder
  - **Custom:** the user places breakpoints by clicking or tapping the elevation chart, drags them to move, or types distances in a list; breakpoints snap to the resample spacing
- **Why this is cheap:** Even, Splits and Custom are all fixed partitions. For any fixed partition the best constant pace of a piece is the length-weighted mean of the ideal pace over it (the same fact the DP relies on), so they reuse the DP's prefix sums, and their times also sum to the goal automatically. Core gains `planForPartition(course, breakpoints, inputs)`; `computePlan` dispatches on the plan type.
- **Table view toggle:** "Segments | Splits". Splits view shows any plan type as per-mile or per-km rows (pace, split time, elapsed time), which is what most runners want on a pace band. The CSV export and pace band follow the chosen view.
- **Share link:** the format moves to `v=2` and carries the plan type, split length and custom breakpoints. `v=1` links still decode (as Optimal). `docs/sharing.md` is updated.
- **Tests:** core invariants for every type (total equals the goal within 1 s, pieces match the partition, Even equals Optimal at K=0), golden snapshots extended with each type for the fixed courses, E2E per type including placing and dragging custom breakpoints by mouse and touch, a `v=1` link test, and visual baselines.

### B12. Report a problem
- **End goal:** any user can report a bug or idea from inside the app in a few seconds, and the report arrives with enough context to reproduce it, without anyone needing an account.
- **This phase:**
  - a "Report a problem" entry in the panel header menu (desktop) and sheet header (phone) opens a dialog: kind (bug or idea), description (required), optional email
  - **"Include diagnostics"** (on by default, previewable): app version (git SHA), browser, viewport, units, theme, plan inputs, and the last 20 uncaught errors and unhandled rejections from a small in-memory ring buffer
  - **"Include my course"** (off by default, since a course can reveal where someone lives): attaches a share link to the current state so the report reproduces in one click
  - `POST /api/report` on the Worker validates the payload (size cap, schema), checks a Cloudflare Turnstile token, rate limits (5 per IP per hour), and opens a GitHub issue in `jcj59/perfect-pace` labeled `user-report` plus `bug` or `idea`, using a fine-grained token secret `GITHUB_REPORT_TOKEN` (Issues read/write on this repo only)
  - the dialog confirms with "Thanks, report sent" and keeps the text if sending fails so nothing is lost
- **User to-dos:** create the fine-grained token and a Turnstile widget (both free), and set `GITHUB_REPORT_TOKEN` and `TURNSTILE_SECRET` as repo and Worker secrets.
- **Tests:** Miniflare integration with a mocked GitHub API and Turnstile (success, invalid payload, rate limited, upstream failure); E2E submits the dialog against the stubbed Worker at all viewports and asserts the issue body (diagnostics present, course only when opted in); axe on the dialog; visual baselines.

### B13. Race library
- **End goal:** the user picks a famous race and its course loads instantly with the race's date and start time filled in (which feeds weather, B14). Covers the eight Abbott World Marathon Majors, the major US marathons, and the major US road races at other distances.
- **This phase:**
  - a `/races` page (the Worker already serves the SPA fallback; a ~30-line pathname router, no router dependency) reachable from the empty state ("Browse races") and the panel header
  - search by name or city, filter chips (World Marathon Majors, US marathons, Half marathons, 10 mi to 15K, 10K and shorter), grouped list; each row shows name, city, distance and usual month
  - every race shows a "Course coming soon" badge until its GPX exists; rows with a course link to `/?race=<slug>`, which loads `/races/<slug>.gpx` through the normal upload path
  - data in `apps/web/src/races/catalog.json`: `slug`, `name`, `city`, `region`, `country`, `distanceM`, `usualMonth`, `timezone` (IANA), `startTimeLocal` (main wave, `HH:MM`), `website`, `series` tags, `gpx` (null for now), `verified` (month the facts were last checked). The list to seed is in `docs/race-catalog.md`; the implementer verifies each fact against the race's website and does not guess
  - a `pnpm races:add <slug> <file.gpx>` script for adding the GPX files later (exported from Strava): it parses, simplifies, checks the distance, writes `apps/web/public/races/<slug>.gpx` and sets `gpx` in the catalog
- **Tests:** catalog unit tests (unique slugs, valid timezone and time, known distance, ISO country); a test that every catalog entry with a GPX parses and measures within 1.5% of `distanceM` (vacuous until GPX files land, then it guards each one); E2E search, filter, and loading a race via a fixture GPX entry; visual baselines for the page.

### B14. Race conditions: weather, surface and altitude (scaffolding)
- **End goal:** the plan accounts for the conditions on race day. The weather the runner will meet at each point (temperature, dew point, wind relative to their direction of travel, at the time they will be there), the running surface underfoot, and the altitude all adjust the ideal pace, and the panel shows how much each one costs.
- **Approach:** every condition becomes a **pace factor** that multiplies the ideal pace per point. The ideal pace becomes `o_i = (b + g_i) * m_i`, where `g_i` is the grade adjustment and `m_i` is the product of the factor multipliers. Total time is still linear in the base pace `b`, so `b` stays a closed-form solve and the DP and every plan type are untouched.
- **Time-dependent factors:** weather depends on when the runner reaches each point, which depends on the plan. Arrival times come from the current plan, weather is sampled at those times, the plan is recomputed, and this repeats until arrival times move less than 30 s (expected 2 to 3 rounds, since conditions shift pace by a few percent).
- **This phase builds the data and the plumbing, not the models.** Factors ship with neutral multipliers (exactly 1), so plans and golden snapshots do not change. Conditions data is shown to the user; the "effect on plan" readouts stay hidden until real models land. Choosing the models is a separate design step (PR 25).
- **Race start:** date and local start time inputs (prefilled from the race library), in the course's local timezone.
- **Weather:**
  - a `WeatherProvider` interface in core with an Open-Meteo implementation (free, no key, CORS-enabled, called from the browser; `timezone=auto` gives the course's timezone)
  - up to 16 days out it uses the hourly forecast; further out it uses climatology (the same calendar window, plus or minus 7 days, over the last 15 years from the historical archive, as median and 10th to 90th percentiles); past dates use the archive's actual weather
  - sampled at points every 5 km along the course (deduplicated to the weather grid) and interpolated in time to each point's arrival time
  - wind is split into head/tail and cross components using the course bearing at each point
  - shown as a conditions card (start and finish temperature and dew point, wind) and a weather strip under the elevation chart
- **Surface:**
  - classes: paved, compacted gravel, loose gravel or dirt, grass, sand, track, unknown (treated as paved)
  - drawn routes take OSM surface from ORS `extra_info: ["surface", "waytype"]`, passed through `/api/route`
  - uploaded courses are matched against the `transportation` layer of the OpenFreeMap vector tiles the map already uses (nearest way within 15 m; that layer carries paved or unpaved plus the way class), decoded by a small dependency-free MVT reader in core
  - the user can override the surface for any range of the chart, and overrides go in the share link
  - shown as a surface band under the chart and a breakdown ("92% paved, 8% gravel")
- **Altitude:** uses the absolute elevation already computed; the user can enter the altitude they live and train at; shown as the course's average and maximum altitude.
- **Tests:** core tests for the factor pipeline (neutral factors leave every golden snapshot byte-identical, a synthetic non-neutral factor still makes the plan hit the goal, the arrival-time iteration converges); recorded Open-Meteo fixtures for forecast, climatology and archive; MVT reader tests on fixture tiles; ORS fixtures re-recorded with `extra_info`; E2E for the conditions inputs, weather strip, surface band and override; visual baselines.

## Stack

- **Monorepo:** pnpm + Turborepo, TypeScript strict.
- **`packages/core`:** pure TypeScript with no DOM and no runtime dependencies. It contains the GPX parser, geometry, elevation, pace model, DP and serialization, and it runs in the browser, Web Workers, Node and React Native.
- **`apps/web`:** React, Vite, Tailwind and MapLibre GL, with a hand-rolled SVG chart and a small state store.
- **Basemap:** OpenFreeMap (free, no key) with a customized minimal style. Self-hosted PMTiles is a later option.
- **`apps/worker`:** a Cloudflare Worker serving the static assets plus `/api/route`, which proxies ORS with Cache API caching and basic rate limiting.
- **Testing:** Vitest (core, Worker via Miniflare), Playwright (E2E), Lighthouse CI.
- **CI:** GitHub Actions, with a preview deploy per PR.

## Testing and CI strategy

The goal is that no change to `main` can silently alter existing behavior. Either a check fails, or the PR diff shows exactly what changed and someone approved it.

### Test layers

| Layer | Tool | What it covers | Where it runs |
|---|---|---|---|
| Unit and property | Vitest | `@pp/core`: parsing, geometry, elevation, pace model, DP, serialization, edit reducer | Every PR |
| Golden snapshots | Vitest | Frozen outputs for every fixture course (see below) | Every PR |
| Worker integration | Vitest + Miniflare | `/api/route` against recorded ORS responses, caching, rate limits, error mapping | Every PR |
| Performance budgets | Vitest bench + Playwright `performance` marks | Parse under 1 s for 50k points, plan recompute under 50 ms | Every PR (a budget failure fails CI) |
| E2E | Playwright | Every B1 to B7 behavior, desktop plus iPhone and Pixel projects, run against the PR's preview deploy | Every PR |
| Visual regression | Playwright `toHaveScreenshot` | Key screens (empty state, uploaded course, plan, drawing mode, error state) in light and dark, desktop and phone | Every PR |
| Accessibility and PWA | Lighthouse CI, axe in Playwright | Installable, accessibility >= 95, no axe violations on key screens | Every PR (added in PR 13) |
| Live smoke | Playwright | Real ORS routing, real DEM tiles, production URL | Nightly, and after each production deploy |

### Golden regression snapshots
- Every course in the fixture corpus gets a committed snapshot under `packages/core/test/golden/<course>.json`. Each snapshot records:
  - parsed point count and total distance
  - elevation gain, loss, minimum and maximum
  - a downsampled grade profile
  - the full plan (breakpoints, paces, reasons) for a fixed set of inputs: goal time, K values of 1, 3, 6 and 10, and both unit systems
- Numbers are rounded to stated precision (1 m distance, 0.1 m elevation, 0.1 s/mi pace) so snapshots don't churn on floating-point noise.
- Any change to an algorithm shows up as a snapshot diff in the PR. To update snapshots you run `pnpm golden:update`, and the PR description must explain why the outputs changed. CI fails if a snapshot is stale or missing.
- One file, `golden-summary.md`, is generated from the snapshots so the diff is readable at a glance (per-course distance, gain and plan paces).

### Fixtures
- `packages/core/test/fixtures/gpx/`: the GPX corpus, each file with a short README line saying where it came from and what edge case it covers.
- `packages/core/test/fixtures/dem/`: Terrarium tiles covering the fixture courses, so elevation tests never hit the network.
- `apps/worker/test/fixtures/ors/`: recorded ORS responses. `pnpm fixtures:record` re-records them with a real key. Recorded files are committed and reviewed like code.
- Fixtures are never fetched at test time. The only tests allowed to touch the network are the nightly live smoke tests.

### CI pipeline (GitHub Actions)
- **On every PR:** install with pnpm and Turborepo caching, then lint, format check, typecheck, unit and golden tests, Worker integration tests, build, and deploy a Cloudflare preview. After that, run the Playwright E2E and visual suites against the preview URL, then Lighthouse (from PR 13). Playwright traces, videos and screenshot diffs are uploaded as artifacts when a test fails.
- **Coverage:** `@pp/core` enforces a floor of 90% lines and branches, and CI fails below it. The UI relies on E2E tests, not coverage numbers.
- **On merge to `main`:** deploy to production, then run the live smoke suite against the production URL. If the smoke suite fails, roll back automatically to the previous Worker version with `wrangler rollback`, and open an issue.
- **Nightly:** the live smoke suite (real ORS, real DEM, production), plus the full E2E suite on WebKit and Firefox in addition to Chromium.
- **Required checks:** branch protection on `main` requires every per-PR job to pass, plus an up-to-date branch. No direct pushes. If the repo uses the no-mistakes gate, ship through it.

### Policies
- **Flaky tests:** no blanket retries. Playwright gets one retry in CI, and a test that passes only on retry is reported as flaky. A flaky test is either fixed or moved to a `quarantine` tag (which still runs but doesn't block), with an issue linked, within the same week.
- **Visual baselines** are generated in CI's Linux container (via `pnpm visual:update` in Docker) so they match across machines. Updating them requires a reason in the PR, like golden snapshots.
- **Every bug fix** starts with a failing E2E or golden test that reproduces the bug.
- **Dependencies:** Renovate groups weekly updates into one PR that runs the full suite. Minor and patch updates auto-merge if green. Major updates need review.

## PR-by-PR plan

Each PR is shippable on its own, includes its tests, and (if it touches UI) has before/after screenshots in its description. Every PR that adds a behavior also adds its golden snapshots and visual baselines.

### PR 1: Monorepo scaffold, test infrastructure and CI
This PR builds all of the testing and CI machinery before any features exist, so later PRs only add tests.
- pnpm/Turborepo workspace, TS configs, ESLint/Prettier
- `apps/web` placeholder page, `apps/worker` serving it plus `/api/health`
- Vitest wired up for `core` and `worker` (Miniflare), with the coverage floor
- The golden snapshot harness (`pnpm golden:update`, the stale-snapshot check, `golden-summary.md` generation), proven with one trivial snapshot
- Playwright with desktop, iPhone and Pixel projects, `toHaveScreenshot` baselines, axe checks, trace and screenshot-diff artifacts on failure, and the Dockerized baseline update script
- The performance budget harness (bench with thresholds that fail CI)
- GitHub Actions workflows: per-PR (everything above, against a Cloudflare preview deploy), merge to `main` (production deploy, smoke test, auto-rollback), nightly (live smoke plus cross-browser E2E)
- Branch protection with required checks, a Renovate config, and `CONTRIBUTING.md` documenting the test layers, the snapshot and baseline update flow, and the flaky-test policy
- **Done when:**
  - CI is green and the preview URL serves the page
  - a Playwright smoke test and a visual baseline pass against the deployed preview
  - a deliberately broken commit (a failing unit test, a stale snapshot, a visual diff, a blown perf budget) fails CI for each case. Check this on a throwaway branch and record the result in the PR description.
  - a forced production smoke failure triggers rollback in a dry run

### PR 2: Core geometry and course model
- `Course` type (points with lat, lon, ele?, cumulative distance), haversine distance, fixed-spacing resampling with interpolation, unit conversions, pace formatting
- **Tests:** resampling preserves total distance within 0.1%, conversions round-trip, plus property tests on random tracks.

### PR 3: GPX parser
- A purpose-built, dependency-free GPX tokenizer (DOMParser is unavailable in Web Workers and React Native) covering everything listed under B1
- Typed errors, plus `simplify` (Douglas-Peucker) for later use
- The fixture corpus lands here.
- **Tests:** the B1 core tests, a parse-time benchmark for the 50k-point file, and the first golden snapshots (point count and distance per course).

### PR 4: Elevation pipeline
- A pure smoothing/grade/gain module
- `ElevationProvider` interface with a Terrarium tile implementation (fetch, decode via OffscreenCanvas, bilinear sample, LRU tile cache) and a fixture provider for tests
- The source policy from B3
- **Tests:** the B3 core tests, the DEM fixture tiles, and golden snapshots extended with gain, loss and the grade profile.

### PR 5: Pace model and exact segmenter
- Daniels pace model behind a `PaceModel` interface
- Prefix-sum DP with a K sweep and minimum length, plus reason generation
- The `computePlan(course, inputs) -> Plan` entry point
- **Tests:** the B4 core tests, including brute-force equivalence and the benchmark budget, and golden snapshots extended with full plans for the fixed input set.

### PR 6: App shell, map and worker bridge
- Layout: a desktop side panel and a mobile bottom sheet
- MapLibre with a minimal custom style, plus light/dark mode
- App state store and a typed `postMessage` wrapper around the core Web Worker
- The empty state invites the user to upload a GPX or start drawing.
- **Tests:** E2E layout at both viewports (no horizontal scroll, sheet snaps), visual baselines for the empty state in light and dark.

### PR 7: GPX upload end to end
- Dropzone and picker, parse plus elevation processing in the worker, route on the map with fit-bounds, stats panel, error states, track picker for multi-track files
- **Tests:** the B1 E2E tests across the corpus, visual baselines for a loaded course and the error state.

### PR 8: Elevation profile chart
- A responsive SVG chart with distance/elevation axes in the selected units, plus hover and touch scrub synced to a map marker
- **Tests:** the B3 E2E test (no-elevation file), the hover/scrub E2E tests from B5, screenshots.

### PR 9: Pacing plan UI
- Goal time input, pace-change slider with the error curve, units toggle, minimum segment length
- Segment table with reasons, segment colors on the map and chart, row selection highlighting
- Recompute is debounced in the worker.
- **Tests:** the B4 and B5 E2E tests, the recompute latency assertion via `performance` marks, and visual baselines for the plan view.

### PR 10: Routing proxy
- `/api/route` taking `{from, to}`, returning a GeoJSON line, with the ORS key as a Worker secret
- Cache API keyed by rounded coordinates, per-IP rate limiting, normalized errors
- `RoutingProvider` interface in core.
- **Tests:** Miniflare integration with recorded responses (plus the `pnpm fixtures:record` script), and the live routing test added to the nightly workflow.

### PR 11: Route drawing
- Waypoint editing as a pure reducer in core (add, move, insert, delete, per-leg mode, close loop, out and back) with undo/redo
- Map interaction for mouse and touch, incremental leg routing, live distance, DEM elevation for drawn routes, straight-line fallback on routing failure
- **Tests:** the B2 tests, and visual baselines for drawing mode.

### PR 12: Export, share and persist
- GPX/CSV export, printable pace band, URL hash encoding, and local storage restore
- **Tests:** the B6 tests.

### PR 13: PWA and polish
- Manifest, icons, service worker (app shell plus a bounded DEM tile cache), offline messaging, accessibility pass (keyboard, focus, contrast, labels), Lighthouse CI
- **Tests:** the B7 automated checks. Lighthouse CI and axe checks become required checks on `main`.

### Phase 2 PRs (B8 to B14)

These run after PR 13 and before PR 14, in this order. PRs 15 to 17 are small and independent; PR 18 onward builds on them.

### PR 15: Plan explanation behind an info button
- Replace the `Assumption` note with an (i) button and popover beside the "Pacing plan" heading (B8).
- **Tests:** the B8 tests.

### PR 16: Resizable side panel
- Drag and keyboard resize handle, clamps, reset, persistence, camera padding on drag end (B9).
- **Tests:** the B9 tests.

### PR 17: Remember the last map view
- Save the camera on `moveend`; the start-up framing precedence function (B10).
- **Tests:** the B10 tests.

### PR 18: Plan types and split views
- `planForPartition` and plan-type dispatch in core; Even, Splits and Custom; custom breakpoint editing on the chart; the Segments/Splits table toggle; export and pace band follow the view; share link `v=2` (B11).
- **Tests:** the B11 tests, golden snapshots for every type.

### PR 19: Report a problem
- The dialog, the error ring buffer, `POST /api/report` with Turnstile, rate limiting and GitHub issue creation (B12).
- **Tests:** the B12 tests. Until the user adds the secrets, the endpoint returns `not_configured` and the dialog says reporting is unavailable.

### PR 20: Race library
- The `/races` page and router, `catalog.json` seeded from `docs/race-catalog.md` with each fact verified, `?race=<slug>` loading, and the `pnpm races:add` script. No GPX files yet (B13).
- **Tests:** the B13 tests.

### PR 21: Pace factor pipeline
- Core only: the `PaceFactor` interface, `o_i = (b + g_i) * m_i` with the closed-form base pace, the arrival-time iteration for time-dependent factors, a per-factor time breakdown, and neutral weather, surface and altitude factors registered (B14 approach).
- **Tests:** golden snapshots byte-identical, synthetic-factor and convergence tests, the recompute budget (under 50 ms per round) still holds.

### PR 22: Race start and weather
- Date and start time inputs (prefilled from `?race=`), the Open-Meteo `WeatherProvider` (forecast, climatology, archive), sampling along the course at arrival times, head/cross wind, the conditions card and weather strip. The start time joins the share link.
- **Tests:** the B14 weather tests with recorded fixtures; a nightly live smoke test against Open-Meteo.

### PR 23: Running surface
- Surface classes, ORS `extra_info` through `/api/route` (with fixtures re-recorded), the MVT reader and tile matching for uploaded courses, the surface band, breakdown and range override (in the share link).
- **Tests:** the B14 surface tests.

### PR 24: Altitude
- The home altitude input and the course altitude stats in the conditions card, wired to the neutral altitude factor.
- **Tests:** the B14 altitude tests.

### PR 25: Pacing models design doc
- `docs/pacing-models.md`, for the user to review before any model is coded. For each factor (heat and humidity, wind, surface, altitude) it lays out candidate models from the literature with their sources, what inputs they need, how they combine (multiplicative vs additive), and how to validate them against real race results. It also covers whether the app needs a second mode that predicts finish time from flat-road fitness, since with a fixed goal time the factors only redistribute effort across the course.
- The PRs that implement the chosen models are planned after this doc is agreed.

### PR 14: MVP acceptance pass (runs last)
- Run the full suite on both viewport projects against the production deploy, do a manual check on a real phone, fix whatever falls out, and write the README (what it does, the algorithm, how to run it).
- Audit the safety net: every B1 to B14 criterion maps to at least one named test that runs on every PR (a table in the README), the nightly and post-deploy workflows have run green for several days in a row, and no tests are left in quarantine.
- **Done when:** every B1 to B14 criterion passes and the audit is clean.

### Dependency order
PRs 2 to 5 (core) can proceed in parallel with PR 6 once PR 1 lands. PR 7 needs PRs 3, 4 and 6. PR 8 needs PR 7. PR 9 needs PRs 5 and 8. PR 11 needs PRs 10 and 7. PRs 15 to 17 need only PR 13. PR 18 needs PR 15 (it reworks the same plan header). PRs 19 and 20 are independent of each other. PR 21 needs PR 18 (factors apply to every plan type). PR 22 needs PRs 20 and 21. PRs 23 and 24 need PR 21 and the conditions card from PR 22. PR 25 needs PRs 22 to 24. PR 14 runs after PR 25.

## Future extensions (post-MVP)

- **Better objectives:**
  - effort-based plans: minimize time for a fixed total effort, using a metabolic cost-of-running vs grade curve such as Minetti's
  - fatigue and negative-split modeling
  - an Optimal variant whose pace changes may happen only at mile/km markers
  - the condition models themselves (heat, wind, surface, altitude), planned once PR 25 is agreed
  - a personalized grade response fit from the user's own activity history
- **Data:** the GPX files for the race library (B13), FIT/TCX import, Strava import, better DEMs where available.
- **Infra:** self-hosted Valhalla routing and PMTiles basemap, short share links stored in D1.
- **Product:** accounts and a saved-route library, a Capacitor app with GPS "live pacing" and watch workout export.
