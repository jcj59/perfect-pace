/** Spherical geometry on WGS84 latitude and longitude, in degrees. */

/** A position in degrees: latitude in [-90, 90], longitude in [-180, 180]. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** Mean Earth radius in meters (IUGG), used by `haversineM`. */
export const EARTH_RADIUS_M = 6_371_008.8;

const RAD = Math.PI / 180;

/**
 * Great-circle distance in meters between `a` and `b` (haversine formula on a sphere of radius
 * `EARTH_RADIUS_M`). Within about 0.5% of the ellipsoidal distance, and stable for the very short
 * hops between consecutive track points.
 */
export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * The point a fraction `t` of the way from `a` to `b`, interpolating latitude and longitude
 * linearly. Longitude takes the short way across the antimeridian. Meant for the short segments
 * of a track, where this is indistinguishable from the great-circle path.
 */
export function lerpLatLon(a: LatLon, b: LatLon, t: number): LatLon {
  let dLon = b.lon - a.lon;
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  let lon = a.lon + dLon * t;
  if (lon > 180) lon -= 360;
  else if (lon < -180) lon += 360;
  return { lat: a.lat + (b.lat - a.lat) * t, lon };
}
