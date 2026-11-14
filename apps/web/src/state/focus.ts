/**
 * The point the user is pointing at along the course (`AppState.focusDistM`), shared by the
 * elevation chart and the map. Both work on the elevation profile's resampled points.
 */
import { type ElevationProfile, type LatLon, pointAtDistance } from "@pp/core";
import { nearestIndex } from "../chart/scale.ts";
import { type CourseState, appStore, setFocusDistM } from "./app.ts";

/** The course's elevation profile (a loaded file's or a drawn route's), once it is ready. */
export function readyProfile(course: CourseState): ElevationProfile | undefined {
  if (course.status !== "loaded" && course.status !== "drawn") return undefined;
  return course.elevation?.status === "ready" ? course.elevation.profile : undefined;
}

/** Point at the course point nearest a map position (hovering the route), or clear it with null. */
export function focusNearest(at: LatLon | null): void {
  const profile = readyProfile(appStore.get().course);
  if (!at || !profile) {
    setFocusDistM(null);
    return;
  }
  const { points } = profile.course;
  const point = points[nearestIndex(points, at.lat, at.lon)];
  setFocusDistM(point ? point.distM : null);
}

/** Where the focused point is on the map, or null when nothing is focused. */
export function focusPosition(profile: ElevationProfile | undefined, distM: number | null): LatLon | null {
  if (!profile || distM === null || profile.course.points.length === 0) return null;
  const { lat, lon } = pointAtDistance(profile.course, distM);
  return { lat, lon };
}
