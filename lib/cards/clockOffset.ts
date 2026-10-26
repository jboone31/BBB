/**
 * Server clock offset estimation (card-behavior spec, design section after 2;
 * Requirements 20.7, 20.9).
 *
 * A board renders timed-effect countdowns and boundary toasts against SERVER
 * time, but it only has the device clock plus the server time returned by each
 * Settle_Nudge. These two pure helpers bridge the gap:
 *
 *   - {@link measureOffset} estimates `serverTime − deviceTime` from a single
 *     request/response round trip, assuming the server read its clock at the
 *     round-trip midpoint. Its error for any actual read instant inside the
 *     round trip is at most half the round-trip duration.
 *   - {@link serverNow} converts a device timestamp to estimated server time by
 *     adding the measured offset.
 *
 * Both are framework-free so they can be property-tested in isolation.
 */

/**
 * Estimate the server clock offset in milliseconds (`serverTime − deviceTime`)
 * from one round trip. `sentAtMs` is the device clock when the request left,
 * `receivedAtMs` is the device clock when the response arrived, and
 * `serverNowIso` is the server time the response carried.
 *
 * The estimate assumes the server read its clock at the midpoint of the round
 * trip, so the device-clock instant that corresponds to the server stamp is
 * `sentAtMs + (receivedAtMs − sentAtMs) / 2`. The offset is the difference
 * between the server stamp and that midpoint (20.9).
 */
export function measureOffset(
  sentAtMs: number,
  receivedAtMs: number,
  serverNowIso: string,
): number {
  const midpointMs = sentAtMs + (receivedAtMs - sentAtMs) / 2;
  return Date.parse(serverNowIso) - midpointMs;
}

/**
 * Convert a device timestamp to estimated server time by adding the measured
 * offset (20.7).
 */
export function serverNow(deviceNowMs: number, offsetMs: number): number {
  return deviceNowMs + offsetMs;
}
