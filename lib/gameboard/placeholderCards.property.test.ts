import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  placeholderHand,
  type PlaceholderCard,
} from "./placeholderCards";

/**
 * Feature: in-game-landing-wireframe, Property 7: Placeholder hand size is
 * bounded.
 *
 * For any Player id, `placeholderHand` returns between 1 and 8 placeholder
 * cards (inclusive), each with a distinct id (design.md §Property 7).
 *
 * The generator is documented as deterministic — seeded by `playerId`, so a
 * given Player always sees the same hand across renders (design.md §Components
 * 2). This suite asserts that documented determinism alongside the bounded-size
 * and distinct-id guarantees.
 *
 * Validates: Requirements 5.2
 */

/** The inclusive lower bound on hand size (R5.2). */
const MIN_HAND_SIZE = 1;
/** The inclusive upper bound on hand size (R5.2). */
const MAX_HAND_SIZE = 8;

/** A generator of arbitrary non-empty Player ids (the seed for the hand). */
const playerIdArb = fc.string({ minLength: 1, maxLength: 64 });

describe("placeholderHand — bounded hand size and distinct ids (Property 7)", () => {
  it("returns between 1 and 8 cards (inclusive), each with a distinct id, for any Player id", () => {
    fc.assert(
      fc.property(playerIdArb, (playerId) => {
        const hand = placeholderHand(playerId);

        // Bounded size: always within [1, 8] inclusive.
        expect(hand.length).toBeGreaterThanOrEqual(MIN_HAND_SIZE);
        expect(hand.length).toBeLessThanOrEqual(MAX_HAND_SIZE);

        // Distinct ids: no two cards in the hand share an id.
        const ids = hand.map((card: PlaceholderCard) => card.id);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(hand.length);
      }),
      { numRuns: 100 },
    );
  });

  it("is deterministic: the same Player id yields an equal hand across calls", () => {
    fc.assert(
      fc.property(playerIdArb, (playerId) => {
        const first = placeholderHand(playerId);
        const second = placeholderHand(playerId);

        // Same seed ⇒ structurally equal hand every time.
        expect(second).toEqual(first);
      }),
      { numRuns: 100 },
    );
  });
});
