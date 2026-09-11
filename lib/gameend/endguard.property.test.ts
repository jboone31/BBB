import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  applyEnd,
  canEndGame,
  type EndReason,
  type GameEndState,
  type GameLifecycle,
} from "./index";

/**
 * Feature: web-app-foundation, Property 9: End transition is guarded by lifecycle and end_reason is immutable
 *
 * An end transition is permitted only from the `live` lifecycle. Attempting to
 * end a `lobby` game or re-end an already-`ended` game is rejected and leaves
 * the lifecycle unchanged. Once a game has ended and an `end_reason` is set, a
 * subsequent end attempt never changes that recorded reason.
 *
 * Validates: Requirements 5.4, 5.5
 */

const lifecycleArb: fc.Arbitrary<GameLifecycle> = fc.constantFrom(
  "lobby",
  "live",
  "ended",
);

const endReasonArb: fc.Arbitrary<EndReason> = fc.constantFrom(
  "finish_bar_claimed",
  "admin_ended",
  "auto_timeout",
);

/** An end_reason as it might already be recorded on a game (or absent). */
const existingEndReasonArb: fc.Arbitrary<EndReason | null | undefined> =
  fc.oneof(endReasonArb, fc.constant(null), fc.constant(undefined));

describe("applyEnd — End guard and immutable end_reason (Property 9)", () => {
  it("permits an end transition iff the game is live", () => {
    fc.assert(
      fc.property(
        lifecycleArb,
        existingEndReasonArb,
        endReasonArb,
        (lifecycle, existingReason, attemptedReason) => {
          const current: GameEndState = {
            lifecycle,
            endReason: existingReason,
          };
          const result = applyEnd(current, attemptedReason);

          // Permission is governed solely by the lifecycle guard.
          expect(result.ok).toBe(lifecycle === "live");
          expect(canEndGame(lifecycle)).toBe(lifecycle === "live");

          if (result.ok) {
            // A successful end lands in `ended` with the attempted reason.
            expect(result.lifecycle).toBe("ended");
            expect(result.endReason).toBe(attemptedReason);
          } else {
            // Rejection leaves the lifecycle and any recorded reason untouched.
            expect(result.reason).toBe("not_live");
            expect(result.current.lifecycle).toBe(lifecycle);
            expect(result.current.endReason).toBe(existingReason);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects ending a lobby or ended game and leaves the lifecycle unchanged", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<GameLifecycle>("lobby", "ended"),
        existingEndReasonArb,
        endReasonArb,
        (lifecycle, existingReason, attemptedReason) => {
          const current: GameEndState = {
            lifecycle,
            endReason: existingReason,
          };
          const result = applyEnd(current, attemptedReason);

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.reason).toBe("not_live");
            expect(result.current.lifecycle).toBe(lifecycle);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("never changes end_reason once a game has ended, no matter how many re-ends are attempted", () => {
    fc.assert(
      fc.property(
        endReasonArb,
        fc.array(endReasonArb, { minLength: 1, maxLength: 10 }),
        (originalReason, reattempts) => {
          // A game that already ended carries its original recorded reason.
          let state: GameEndState = {
            lifecycle: "ended",
            endReason: originalReason,
          };

          for (const attemptedReason of reattempts) {
            const result = applyEnd(state, attemptedReason);

            // Every re-end is rejected...
            expect(result.ok).toBe(false);
            if (!result.ok) {
              // ...and the recorded reason is preserved unchanged.
              expect(result.current.lifecycle).toBe("ended");
              expect(result.current.endReason).toBe(originalReason);
              state = result.current;
            }
          }

          // After all attempts, the reason is still the original.
          expect(state.endReason).toBe(originalReason);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("makes end_reason immutable across a first successful end then a re-end", () => {
    fc.assert(
      fc.property(endReasonArb, endReasonArb, (firstReason, secondReason) => {
        // Start live and perform the first, successful end.
        const first = applyEnd(
          { lifecycle: "live", endReason: null },
          firstReason,
        );
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(first.endReason).toBe(firstReason);

        // A second end attempt against the now-ended game is rejected and the
        // originally recorded reason is never overwritten by the second reason.
        const ended: GameEndState = {
          lifecycle: first.lifecycle,
          endReason: first.endReason,
        };
        const second = applyEnd(ended, secondReason);
        expect(second.ok).toBe(false);
        if (!second.ok) {
          expect(second.current.endReason).toBe(firstReason);
        }
      }),
      { numRuns: 100 },
    );
  });
});
