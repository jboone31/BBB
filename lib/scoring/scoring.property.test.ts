import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  computeShares,
  FINISH_BAR_SOLO_AWARD,
  MAX_CLAIMING_TEAMS,
  MIN_CLAIMING_TEAMS,
  NON_FINISH_BAR_TOTAL_POINTS,
} from "./index";

/**
 * Feature: web-app-foundation, Property 1: Non-finish bar 12-point split
 *
 * A non-finish scoring bar is worth exactly 12 points, split equally among the
 * teams currently claiming it (1->12, 2->6, 3->4, 4->3), so every claimer's
 * shares sum to exactly 12. The finish bar instead awards a solo 12 to its
 * single claiming team.
 *
 * Validates: Requirements 3.13
 */

/** The exact per-team share table the v1 ruleset mandates for k claimers. */
const EXPECTED_SHARES: Record<number, number> = {
  1: 12,
  2: 6,
  3: 4,
  4: 3,
};

describe("computeShares — Non-finish bar 12-point split (Property 1)", () => {
  it("returns the exact table value for every supported claimer count", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MIN_CLAIMING_TEAMS, max: MAX_CLAIMING_TEAMS }),
        (k) => {
          const share = computeShares(k);

          // Exact table value.
          expect(share).toBe(EXPECTED_SHARES[k]);

          // Shares across all k claimers sum to exactly 12.
          expect(share * k).toBe(NON_FINISH_BAR_TOTAL_POINTS);

          // Split is a whole number for every supported count.
          expect(Number.isInteger(share)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("awards the finish bar exactly 12 to a single claimer", () => {
    // The finish bar is never split: one claimer, full 12, and the constant
    // matches the non-finish total for a solo claim.
    expect(FINISH_BAR_SOLO_AWARD).toBe(12);
    expect(FINISH_BAR_SOLO_AWARD).toBe(NON_FINISH_BAR_TOTAL_POINTS);
    expect(computeShares(1)).toBe(FINISH_BAR_SOLO_AWARD);
  });
});
