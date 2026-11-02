/**
 * Geodesic distance helpers for distance-based card rules (framework-free).
 *
 * Several v1 cards reason about physical distance: Cancel Culture locks every bar
 * within 0.25 miles of a target, and Scenic Route compares a bar's distance to the
 * finish against the team's previous bar. This module provides the pure geometry
 * those rules share, with no I/O and no Next.js dependency so it can be unit- and
 * property-tested in isolation.
 *
 * Bar coordinates come from `bars.location` (a free-text `"lat,lng"` string); when
 * that is null the bar is matched to `CANDIDATE_BARS` by key. A bar with no
 * resolvable coordinates is ineligible for distance-based targets and is never
 * blocked by a radius lock.
 */

/** A WGS-84 coordinate pair in decimal degrees. */
export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/**
 * Mean Earth radius in miles, used by the haversine formula. Matches the value
 * referenced by the Geodesic_Distance rules in the card-behavior design.
 */
export const EARTH_RADIUS_MILES = 3958.7613;

/**
 * Radius, in miles, of the Cancel Culture area lock and the finish-bar exclusion
 * zone for Cancel Culture targeting.
 */
export const CANCEL_CULTURE_RADIUS_MILES = 0.25;

const DEG_TO_RAD = Math.PI / 180;

/**
 * Great-circle distance between two coordinates in miles, via the haversine
 * formula. Returns 0 for identical points and is symmetric in its arguments.
 */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLng = (b.lng - a.lng) * DEG_TO_RAD;

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  // Clamp to [0, 1] to guard against floating-point drift above 1 for antipodal
  // points, which would make asin produce NaN.
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return EARTH_RADIUS_MILES * c;
}

/**
 * Whether two coordinates are within `miles` of each other, inclusive of the
 * boundary (`haversineMiles(a, b) <= miles`).
 */
export function withinMiles(a: LatLng, b: LatLng, miles: number): boolean {
  return haversineMiles(a, b) <= miles;
}

/**
 * Parse a `bars.location` value of the form `"lat,lng"` into a {@link LatLng}.
 *
 * Returns null when the input is null, is not two comma-separated finite numbers,
 * or carries an out-of-range latitude/longitude. This is the single place a stored
 * location string becomes coordinates, so a malformed value yields "no resolvable
 * coordinates" rather than throwing.
 */
export function parseBarLocation(text: string | null): LatLng | null {
  if (text === null) {
    return null;
  }
  const parts = text.split(",");
  if (parts.length !== 2) {
    return null;
  }
  const lat = Number(parts[0].trim());
  const lng = Number(parts[1].trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  return { lat, lng };
}
