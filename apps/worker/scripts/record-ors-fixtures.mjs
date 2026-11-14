// Re-records the OpenRouteService fixtures in test/fixtures/ors/ from the cases in cases.json,
// using a real key: `ORS_API_KEY=... pnpm fixtures:record` (the free key at
// https://openrouteservice.org/dev/#/signup is enough; each case is one directions request).
//
// It sends exactly the request the Worker sends (src/ors.ts `orsRequestBody`); the Worker tests
// fail if the two drift apart. Review the diff of the recorded files like code before committing.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../test/fixtures/ors/", import.meta.url));
const URL_FOOT = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson";

const key = process.env.ORS_API_KEY?.trim();
if (!key) {
  console.error("ORS_API_KEY is not set. Get a free key at https://openrouteservice.org/dev/#/signup and rerun.");
  process.exit(1);
}

const only = process.argv.slice(2);
const cases = JSON.parse(readFileSync(`${DIR}cases.json`, "utf8")).filter(
  (c) => only.length === 0 || only.includes(c.name),
);

for (const c of cases) {
  const body = {
    coordinates: [
      [c.from.lon, c.from.lat],
      [c.to.lon, c.to.lat],
    ],
    instructions: false,
  };
  const response = await fetch(URL_FOOT, {
    method: "POST",
    headers: {
      authorization: key,
      "content-type": "application/json",
      accept: "application/geo+json, application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`${c.name}: HTTP ${response.status} with a non-JSON body:\n${text.slice(0, 500)}`);
    process.exit(1);
  }
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    console.error(`${c.name}: HTTP ${response.status} (bad key or quota used up): ${text.slice(0, 300)}`);
    process.exit(1);
  }
  const fixture = {
    source: "recorded",
    recordedAt: new Date().toISOString().slice(0, 10),
    case: c,
    upstream: { url: URL_FOOT, body },
    response: { status: response.status, body: json },
  };
  writeFileSync(`${DIR}${c.name}.json`, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${c.name}: HTTP ${response.status}`);
}
console.log("Now run `pnpm format` and review `git diff apps/worker/test/fixtures/ors`.");
