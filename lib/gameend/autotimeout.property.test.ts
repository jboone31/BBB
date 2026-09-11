import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { AUTO_TIMEOUT_MS, isDueForAutoTimeout } from "./index";

/**
 * Feature: web-app-foundation, Property 8: Auto-timeout is due exactly at 12 hours
 *
 * A live game is due for auto-timeout iff at least 12 hours have elapsed since
 * it went live: `now - live_started_at >= AUTO_TIMEOUT_MS`. The boundary is
 * inclusive, so exactly 12h is due while anything strictly under 12h is not.
 * We generate `live_started_at` and `now` clustered around the 12h boundary
 * (including exactly 12h and small offsets on either side) so the property
 * exercises the tie case rather than only far-from-boundary values.
 *
 * Validates: Requirements 5.1, 5.2
 */
describe("isDueForAutoTimeout — Auto-timeout is due exactly at 12 hours (Property 8)", () => {
  it("is due iff now - liveStartedAt >= AUTO_TIMEOUT_MS", () => {
    fc.assert(
      fc.property(
        // Any plausible epoch-millisecond start time.
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        // An elapsed offset centered on the 12h boundary: values within a few
        // seconds either side of exactly 12h, plus a spread out to ±1h so the
        // property also covers clearly-before and clearly-after cases.
        fc.oneof(
          // Tight window around the boundary, in milliseconds.
          fc.integer({
            min: AUTO_TIMEOUT_MS - 5_000,
            max: AUTO_TIMEOUT_MS + 5_000,
          }),
          // Exactly on the boundary.
          fc.constant(AUTO_TIMEOUT_MS),
          // Wider spread of ±1h.
          fc.integer({
            min: AUTO_TIMEOUT_MS - 3_600_000,
            max: AUTO_TIMEOUT_MS + 3_600_000,
          }),
        ),
        (startMs, elapsedMs) => {
          const nowMs = startMs + elapsedMs;
          const expected = nowMs - startMs >= AUTO_TIMEOUT_MS;

          // Number inputs.
          expect(isDueForAutoTimeout(startMs, nowMs)).toBe(expected);
          // Date inputs behave identically (the public API accepts both).
          expect(isDueForAutoTimeout(new Date(startMs), new Date(nowMs))).toBe(
            expected,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("treats exactly 12 hours as due (inclusive boundary)", () => {
    const start = 1_700_000_000_000;
    expect(isDueForAutoTimeout(start, start + AUTO_TIMEOUT_MS)).toBe(true);
    expect(isDueForAutoTimeout(start, start + AUTO_TIMEOUT_MS - 1)).toBe(false);
  });
});
