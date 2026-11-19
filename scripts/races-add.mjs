/**
 * `pnpm races:add <slug> <file.gpx>`: add a race's course to the race library (B13).
 *
 * Parses the file (an export from Strava or the race website), takes its longest track, simplifies
 * it to within 2 m of the original line (keeping elevation), checks that it measures within 1.5% of
 * the race's distance in the catalog, then writes `apps/web/public/races/<slug>.gpx` and sets the
 * race's `gpx` in `apps/web/src/races/catalog.json`. Pass `--force` to accept a distance outside
 * the tolerance (say, a course known to be long), which the catalog test will then flag.
 *
 * Runs with `scripts/ts-hooks.mjs`, which compiles `@pp/core`'s TypeScript as it loads.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCourse, courseLengthM, parseGpx, simplify, writeGpx } from "../packages/core/src/index.ts";

/** How far the simplified line may stray from the original, meters. */
const RACE_SIMPLIFY_TOLERANCE_M = 2;
/** How far a course's measured length may be from the race distance, as a fraction. */
const RACE_DISTANCE_TOLERANCE = 0.015;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = join(ROOT, "apps/web/src/races/catalog.json");
const PUBLIC = join(ROOT, "apps/web/public/races");

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`races:add: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const [slug, file] = args.filter((a) => a !== "--force");
if (!slug || !file) fail("usage: pnpm races:add <slug> <file.gpx> [--force]");

/** @type {{ slug: string, name: string, distanceM: number, gpx: string | null }[]} */
const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
const race = catalog.find((r) => r.slug === slug);
if (!race) fail(`no race "${slug}" in the catalog. Slugs: ${catalog.map((r) => r.slug).join(", ")}`);

let text;
try {
  text = readFileSync(file, "utf8");
} catch (error) {
  fail(`cannot read ${file}: ${error.message}`);
}

let parsed;
try {
  parsed = parseGpx(text);
} catch (error) {
  fail(`${file} is not a usable GPX file: ${error.message}`);
}
const track = parsed.tracks[parsed.defaultTrack];
if (!track) fail(`${file} has no track`);
const points = simplify(track.course.points, RACE_SIMPLIFY_TOLERANCE_M).map(({ lat, lon, ele }) =>
  ele === undefined ? { lat, lon } : { lat, lon, ele },
);
const lengthM = courseLengthM(buildCourse(points));
const off = (lengthM - race.distanceM) / race.distanceM;
const summary = `${(lengthM / 1000).toFixed(3)} km against ${(race.distanceM / 1000).toFixed(3)} km (${(off * 100).toFixed(2)}%)`;
if (Math.abs(off) > RACE_DISTANCE_TOLERANCE && !force) {
  fail(
    `the course measures ${summary}, more than ${RACE_DISTANCE_TOLERANCE * 100}% off. Check the file, or pass --force.`,
  );
}

mkdirSync(PUBLIC, { recursive: true });
const out = join(PUBLIC, `${slug}.gpx`);
writeFileSync(out, writeGpx(points, { name: race.name }));
race.gpx = `/races/${slug}.gpx`;
writeFileSync(CATALOG, `${JSON.stringify(catalog, null, 2)}\n`);
// Formatted as the repo formats JSON, so the diff is just the one line.
execFileSync(join(ROOT, "node_modules/.bin/prettier"), ["--write", CATALOG], { stdio: "ignore" });
console.log(
  `races:add: ${race.name}: ${track.course.points.length} points simplified to ${points.length}, ${summary}.\n` +
    `Wrote ${relative(ROOT, out)} and set its gpx in ${relative(ROOT, CATALOG)}.`,
);
