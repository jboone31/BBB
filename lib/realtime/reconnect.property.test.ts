import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECT_DELAY_MS,
  NO_RECONNECT,
  reconnectDelay,
} from "@/lib/realtime/reconnect";

/**
 * Feature: web-app-foundation, Property 11: Reconnect schedule stays within bounds
 *
 * Recovery path (a) — transient in-app reconnect — retries a dropped connection
 * on a bounded schedule: intervals ≤ 5s ({@link MAX_RECONNECT_DELAY_MS}) and at
 * most 12 attempts ({@link MAX_RECONNECT_ATTEMPTS}), after which no further
 * attempt is scheduled and the controller goes terminal (design.md Component 5;
 * Req 6.5).
 *
 * The pure {@link reconnectDelay} schedule is the correctness-critical heart of
 * that policy. For any attempt index `i`:
 *   - a *valid* attempt (1 ≤ i ≤ 12) yields a delay in [0, 5000] — never
 *     exceeding the 5s ceiling;
 *   - an *out-of-range* attempt (i > 12, i < 1, or non-integer) yields
 *     {@link NO_RECONNECT}, signalling no attempt should be scheduled.
 *
 * Validates: Requirements 6.5
 */

describe("reconnectDelay — Reconnect schedule stays within bounds (Property 11)", () => {
  it("returns a delay within [0, MAX_RECONNECT_DELAY_MS] for every valid attempt index (1..12)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_RECONNECT_ATTEMPTS }),
        (attemptIndex) => {
          const delay = reconnectDelay(attemptIndex);

          // A real, schedulable delay: non-negative and bounded by the 5s ceiling.
          expect(delay).not.toBe(NO_RECONNECT);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(MAX_RECONNECT_DELAY_MS);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("schedules no attempt (NO_RECONNECT) once the index exceeds MAX_RECONNECT_ATTEMPTS", () => {
    fc.assert(
      fc.property(
        // Indices strictly beyond the retry budget, including far past 12.
        fc.integer({ min: MAX_RECONNECT_ATTEMPTS + 1, max: 1_000_000 }),
        (attemptIndex) => {
          expect(reconnectDelay(attemptIndex)).toBe(NO_RECONNECT);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("schedules no attempt (NO_RECONNECT) for non-positive indices (i < 1)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 0 }), (attemptIndex) => {
        expect(reconnectDelay(attemptIndex)).toBe(NO_RECONNECT);
      }),
      { numRuns: 100 },
    );
  });

  it("bounds hold across the whole integer range, including > 12 and <= 0", () => {
    // A single property spanning the entire input space: every index either
    // yields a bounded, non-negative delay (valid range) or NO_RECONNECT
    // (no attempt scheduled). Nothing ever exceeds MAX_RECONNECT_DELAY_MS.
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (attemptIndex) => {
          const delay = reconnectDelay(attemptIndex);
          const inRange =
            Number.isInteger(attemptIndex) &&
            attemptIndex >= 1 &&
            attemptIndex <= MAX_RECONNECT_ATTEMPTS;

          if (inRange) {
            expect(delay).toBeGreaterThanOrEqual(0);
            expect(delay).toBeLessThanOrEqual(MAX_RECONNECT_DELAY_MS);
          } else {
            expect(delay).toBe(NO_RECONNECT);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
