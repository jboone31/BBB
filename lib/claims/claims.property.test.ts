import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { ClaimSet, type ClaimKey } from "./index";

/**
 * Feature: web-app-foundation, Property 3: No duplicate claim
 *
 * A claim is identified by the triple (game_id, team_id, bar_id). The first
 * attempt to record a claim for a given key is accepted; every subsequent
 * attempt for that same key is rejected, and the stored count for the key stays
 * exactly 1. This mirrors the database's `unique (game_id, team_id, bar_id)`
 * constraint (Task 7.2) that encodes the v1 "no re-claiming" rule.
 *
 * Validates: Requirements 3.9
 */

/**
 * Generate claim keys drawn from a *small* pool of ids so that random sequences
 * naturally contain repeats. A large id space would almost never collide, which
 * would fail to exercise the duplicate-rejection path.
 */
const claimKeyArb: fc.Arbitrary<ClaimKey> = fc.record({
  gameId: fc.constantFrom("g1", "g2", "g3"),
  teamId: fc.constantFrom("t1", "t2", "t3"),
  barId: fc.constantFrom("b1", "b2", "b3"),
});

/** A serialization matching the model's key identity for use as a JS map key. */
function keyString(key: ClaimKey): string {
  return `${key.gameId}\u0000${key.teamId}\u0000${key.barId}`;
}

describe("ClaimSet — No duplicate claim (Property 3)", () => {
  it("accepts the first claim, rejects repeats, and keeps each key's count at exactly 1", () => {
    fc.assert(
      fc.property(
        // A sequence of claim attempts, with intentional repeats via the small
        // id pool above.
        fc.array(claimKeyArb, { minLength: 0, maxLength: 200 }),
        (attempts) => {
          const claims = new ClaimSet();
          // Track which keys we have already seen so we know the expected
          // outcome of each attempt independently of the model.
          const seen = new Set<string>();

          for (const key of attempts) {
            const serialized = keyString(key);
            const isFirstOccurrence = !seen.has(serialized);
            seen.add(serialized);

            const outcome = claims.recordClaim(key);

            // First occurrence -> accepted; any repeat -> rejected.
            expect(outcome).toBe(isFirstOccurrence ? "accepted" : "rejected");

            // After every attempt the stored count for the key is exactly 1
            // (never 2+, no matter how many times it was attempted).
            expect(claims.countFor(key)).toBe(1);
            expect(claims.hasClaim(key)).toBe(true);
          }

          // Invariant across the whole run: every distinct key has count 1, and
          // the number of stored keys equals the number of distinct attempts.
          expect(claims.size).toBe(seen.size);
          for (const key of attempts) {
            expect(claims.countFor(key)).toBe(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects an immediate repeat of a single key while leaving its count at 1", () => {
    // Explicit example: first accepted, second and third rejected, count == 1.
    const claims = new ClaimSet();
    const key: ClaimKey = { gameId: "g1", teamId: "t1", barId: "b1" };

    expect(claims.recordClaim(key)).toBe("accepted");
    expect(claims.recordClaim(key)).toBe("rejected");
    expect(claims.recordClaim(key)).toBe("rejected");
    expect(claims.countFor(key)).toBe(1);
    expect(claims.size).toBe(1);
  });

  it("treats keys differing in any single component as distinct", () => {
    // Changing game, team, or bar alone yields an independent, acceptable claim.
    const claims = new ClaimSet();
    const base: ClaimKey = { gameId: "g1", teamId: "t1", barId: "b1" };

    expect(claims.recordClaim(base)).toBe("accepted");
    expect(claims.recordClaim({ ...base, gameId: "g2" })).toBe("accepted");
    expect(claims.recordClaim({ ...base, teamId: "t2" })).toBe("accepted");
    expect(claims.recordClaim({ ...base, barId: "b2" })).toBe("accepted");
    expect(claims.size).toBe(4);
  });
});
