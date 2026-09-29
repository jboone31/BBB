import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CARD_SLUGS } from "./catalog";
import { drawForBar, keepCard, seedDeck } from "./deck";

describe("card deck invariants", () => {
  it("preserves one instance per catalog slug for arbitrary team ids", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (teamId) => {
        const state = seedDeck(teamId);
        expect(state.cards.map((card) => card.slug)).toEqual([...CARD_SLUGS]);
        expect(new Set(state.cards.map((card) => card.id)).size).toBe(
          state.cards.length,
        );
      }),
    );
  });

  it("never creates more than two cards in hand across repeated draws", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 12 }),
        (barIds) => {
          let state = seedDeck("team-a");
          const uniqueBars = [...new Set(barIds)];
          for (const barId of uniqueBars) {
            const drawn = drawForBar(state, barId);
            if (!drawn.ok) continue;
            state = drawn.state;
            const kept = keepCard(state, drawn.cardIds![0]);
            if (kept.ok) state = kept.state;
            expect(
              state.cards.filter((card) => card.state === "hand").length,
            ).toBeLessThanOrEqual(2);
          }
        },
      ),
    );
  });

  it("repeated requests for the same resolved bar are rejected without mutation", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (barId) => {
        const first = drawForBar(seedDeck("team-a"), barId);
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const kept = keepCard(first.state, first.cardIds![0]);
        expect(kept.ok).toBe(true);
        if (!kept.ok) return;
        const repeated = drawForBar(kept.state, barId);
        expect(repeated).toEqual({
          ok: false,
          state: kept.state,
          reason: "duplicate_bar_draw",
        });
      }),
    );
  });
});
