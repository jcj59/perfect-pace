/**
 * Opening a race from the library: `/?race=<slug>` downloads the race's GPX file and loads it
 * through the same path as a file the user picked (`loadGpxFile`), then marks the course as that
 * race's, so its usual month, start time and time zone are in `AppState.race`.
 */
import { type Race, raceBySlug } from "../races/catalog.ts";
import { appStore, setCourse, setLinkError, setRace, setSheet } from "./app.ts";
import { loadGpxFile } from "./course.ts";

/** The file name a race's course loads under (shown while it reads, and in exports). */
export const raceFileName = (race: Race): string => `${race.name}.gpx`;

function showLinkError(message: string): void {
  setLinkError(message);
  // On a phone, bring the message up out of the sheet's peek.
  if (appStore.get().sheet === "peek") setSheet("half");
}

/**
 * Open the race `slug`. Returns false, with a message in the panel, when it is not in the library
 * or has no course yet; otherwise starts loading it and returns true (a failed download leaves a
 * message too).
 */
export function openRace(slug: string): boolean {
  const race = raceBySlug(slug);
  if (!race) {
    showLinkError("That race is not in the race library. Browse the races for one that is.");
    return false;
  }
  if (!race.gpx) {
    showLinkError(`The ${race.name} course is coming soon. Until then, load a GPX file or draw the route.`);
    return false;
  }
  void loadRace(race, race.gpx);
  return true;
}

async function loadRace(race: Race, url: string): Promise<void> {
  const fileName = raceFileName(race);
  const reading = { status: "reading", fileName } as const;
  setCourse(reading, true);
  let file: File;
  try {
    const response = await fetch(url);
    // A missing file gets the app's HTML from the Worker's single-page fallback.
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || type.includes("text/html")) throw new Error(`${response.status} ${type}`);
    file = new File([await response.blob()], fileName, { type: "application/gpx+xml" });
  } catch (error) {
    console.error("Could not download the course for", race.slug, error);
    if (appStore.get().course !== reading) return;
    setCourse({ status: "empty" }, true);
    showLinkError(`The ${race.name} course could not be downloaded. Check your connection and try again.`);
    return;
  }
  // Anything the person did meanwhile (loading a file, drawing) wins.
  if (appStore.get().course !== reading) return;
  await loadGpxFile(file);
  const course = appStore.get().course;
  if (course.status === "loaded" && course.fileName === fileName) setRace(race);
}

/** Mark a course restored from the saved session as race `slug`'s again. */
export function restoreRace(slug: string, fileName: string): void {
  const race = raceBySlug(slug);
  const course = appStore.get().course;
  if (race && course.status === "loaded" && course.fileName === fileName) setRace(race);
}
