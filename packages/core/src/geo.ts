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

/**
 * The initial great-circle bearing from `a` to `b`, in degrees clockwise from true north, in
 * `[0, 360)`: 0 is north, 90 east, 180 south, 270 west. Over the short hops of a track this is the
 * direction of travel. 0 when the points coincide (no direction).
 */
export function initialBearingDeg(a: LatLon, b: LatLon): number {
  const phi1 = a.lat * RAD;
  const phi2 = b.lat * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  if (y === 0 && x === 0) return 0;
  const deg = Math.atan2(y, x) / RAD;
  return deg < 0 ? deg + 360 : deg >= 360 ? deg - 360 : deg;
}
