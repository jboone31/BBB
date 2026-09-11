import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { canStartGame, MAX_TEAMS, MIN_TEAMS } from "./index";

/**
 * Feature: web-app-foundation, Property 2: Team-count bound per game
 *
 * A game may transition to `live` only with a valid team count. The start guard
 * `canStartGame(n)` accepts iff `MIN_TEAMS <= n <= MAX_TEAMS` (2..4) and rejects
 * everything else — notably 0, 1, 5, and 6 — so a game never starts with too few
 * (no opponents) or too many teams.
 *
 * Validates: Requirements 3.6
 */

describe("canStartGame — Team-count bound per game (Property 2)", () => {
  it("accepts a team count iff 2 <= n <= 4, across a broad integer range and edge values", () => {
    fc.assert(
      fc.property(
        // A broad integer range plus the specific edge values the task calls
        // out (0, 1, 5, 6) so the boundary on both sides is always exercised.
        fc.oneof(
          fc.integer({ min: -1000, max: 1000 }),
          fc.constantFrom(0, 1, 5, 6),
        ),
        (n) => {
          const expected = n >= MIN_TEAMS && n <= MAX_TEAMS;
          expect(canStartGame(n)).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts exactly 2, 3, and 4 and rejects the immediate out-of-bound values", () => {
    // Explicit edge coverage for the task's named values.
    expect(canStartGame(0)).toBe(false);
    expect(canStartGame(1)).toBe(false);
    expect(canStartGame(2)).toBe(true);
    expect(canStartGame(3)).toBe(true);
    expect(canStartGame(4)).toBe(true);
    expect(canStartGame(5)).toBe(false);
    expect(canStartGame(6)).toBe(false);
  });
});
