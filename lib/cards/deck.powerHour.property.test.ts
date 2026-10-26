import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  discardCard,
  drawForBar,
  forfeitDraw,
  keepCard,
  MAX_HAND,
  playCard,
  seedDeck,
  type CardInstanceState,
  type DeckState,
} from "./deck";

/**
 * Property 20: Power Hour draws keep every card within the hand limit.
 *
 * Validates: Requirements 17.2
 *
 * Under a Power Hour draw (`drawOverride: true`) a team keeps BOTH drawn cards:
 * - with room, both go straight to the hand and the draw resolves immediately;
 * - without room, both reveal as `keep_all` pending and the team moves them in
 *   one at a time as slots free (playing/discarding held cards), with nothing
 *   auto-discarded by keeping.
 *
 * Across any sequence of draws/keeps/plays/discards/forfeits the hand never
 * exceeds `MAX_HAND`, `keepCard` is rejected with `hand_full` when the hand is
 * full, and the draw resolves (pendingBarId null, pendingMode reset to
 * `choose_one`) exactly when no pending cards remain.
 */

function count(state: DeckState, which: CardInstanceState): number {
  return state.cards.filter((card) => card.state === which).length;
}

type Op =
  | { readonly kind: "draw"; readonly override: boolean }
  | { readonly kind: "keepPending" }
  | { readonly kind: "discardPending" }
  | { readonly kind: "discardHand" }
  | { readonly kind: "playHand" }
  | { readonly kind: "forfeit" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("draw" as const), override: fc.boolean() }),
  fc.constant({ kind: "keepPending" as const }),
  fc.constant({ kind: "discardPending" as const }),
  fc.constant({ kind: "discardHand" as const }),
  fc.constant({ kind: "playHand" as const }),
  fc.constant({ kind: "forfeit" as const }),
);

// Invariants that must hold after EVERY operation, accepted or rejected.
function assertInvariants(state: DeckState): void {
  // The hand limit is never exceeded (R17.2: prompt applied before any card
  // beyond the hand limit enters the hand).
  expect(count(state, "hand")).toBeLessThanOrEqual(MAX_HAND);

  const pendingCount = count(state, "pending");
  if (state.pendingBarId === null) {
    // A resolved draw has no pending cards and resets the mode to choose_one.
    expect(pendingCount).toBe(0);
    expect(state.pendingMode).toBe("choose_one");
  } else {
    // An open draw always has at least one pending card.
    expect(pendingCount).toBeGreaterThan(0);
  }
}

describe("Power Hour draws keep every card within the hand limit", () => {
  it("resolves exactly when nothing is pending and never discards on keep_all", () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { minLength: 1, maxLength: 40 }),
        fc.nat({ max: 30 }),
        (ops, barSeed) => {
          let state = seedDeck("team-a");
          assertInvariants(state);

          let nextBar = barSeed;

          for (const op of ops) {
            const before = state;
            const handBefore = count(before, "hand");
            const pendingBefore = count(before, "pending");
            const discardedBefore = count(before, "discarded");
            const modeBefore = before.pendingMode;

            switch (op.kind) {
              case "draw": {
                const barId = `bar-${nextBar}`;
                nextBar += 1;
                const result = drawForBar(before, barId, {
                  drawOverride: op.override,
                });
                if (result.ok) {
                  state = result.state;
                  const drawCount = result.cardIds?.length ?? 0;
                  if (
                    op.override &&
                    handBefore + drawCount <= MAX_HAND &&
                    pendingBefore === 0
                  ) {
                    // Power Hour with room: both drawn cards go straight to the
                    // hand, nothing is discarded, and the draw resolves.
                    expect(state.pendingBarId).toBeNull();
                    expect(state.pendingMode).toBe("choose_one");
                    expect(count(state, "hand")).toBe(handBefore + drawCount);
                    expect(count(state, "discarded")).toBe(discardedBefore);
                  } else {
                    // Otherwise the draw reveals its cards as pending. The mode
                    // records how the pending draw must resolve.
                    expect(state.pendingBarId).toBe(barId);
                    expect(state.pendingMode).toBe(
                      op.override ? "keep_all" : "choose_one",
                    );
                    expect(count(state, "pending")).toBe(drawCount);
                  }
                } else {
                  // A rejected draw never mutates state.
                  expect(result.state).toBe(before);
                  state = before;
                }
                break;
              }
              case "keepPending": {
                const pending = before.cards.find(
                  (card) => card.state === "pending",
                );
                if (pending === undefined) break;
                const result = keepCard(before, pending.id);
                if (result.ok) {
                  state = result.state;
                  // Keeping always moves exactly one card into the hand.
                  expect(count(state, "hand")).toBe(handBefore + 1);
                  if (modeBefore === "keep_all") {
                    // keep_all NEVER auto-discards on keep (R17.2): only the
                    // chosen card leaves pending, the rest stay pending.
                    expect(count(state, "discarded")).toBe(discardedBefore);
                    expect(count(state, "pending")).toBe(pendingBefore - 1);
                  }
                } else {
                  // The only keep rejection here is a full hand.
                  expect(result.reason).toBe("hand_full");
                  expect(count(before, "hand")).toBe(MAX_HAND);
                  expect(result.state).toBe(before);
                  state = before;
                }
                break;
              }
              case "discardPending": {
                const pending = before.cards.find(
                  (card) => card.state === "pending",
                );
                if (pending === undefined) break;
                const result = discardCard(before, pending.id);
                expect(result.ok).toBe(true);
                if (!result.ok) break;
                state = result.state;
                if (modeBefore === "keep_all") {
                  // keep_all discard removes only that card and promotes nothing.
                  expect(count(state, "hand")).toBe(handBefore);
                  expect(count(state, "pending")).toBe(pendingBefore - 1);
                }
                break;
              }
              case "discardHand": {
                const held = before.cards.find((card) => card.state === "hand");
                if (held === undefined) break;
                const result = discardCard(before, held.id);
                expect(result.ok).toBe(true);
                if (!result.ok) break;
                state = result.state;
                break;
              }
              case "playHand": {
                const held = before.cards.find((card) => card.state === "hand");
                if (held === undefined) break;
                const result = playCard(before, held.id);
                expect(result.ok).toBe(true);
                if (!result.ok) break;
                state = result.state;
                expect(count(state, "hand")).toBe(handBefore - 1);
                break;
              }
              case "forfeit": {
                const result = forfeitDraw(before);
                if (result.ok) {
                  state = result.state;
                  // Forfeit discards all pending, keeps the hand, resolves.
                  expect(count(state, "pending")).toBe(0);
                  expect(count(state, "hand")).toBe(handBefore);
                  expect(state.pendingBarId).toBeNull();
                  expect(state.pendingMode).toBe("choose_one");
                } else {
                  expect(result.reason).toBe("pending_draw");
                  expect(result.state).toBe(before);
                  state = before;
                }
                break;
              }
            }

            assertInvariants(state);
          }

          // No card is ever lost or duplicated across the whole sequence.
          const total =
            count(state, "deck") +
            count(state, "pending") +
            count(state, "hand") +
            count(state, "played") +
            count(state, "discarded");
          expect(total).toBe(state.cards.length);
        },
      ),
    );
  });

  it("a keep_all pending draw resolves only once its last pending card is kept", () => {
    fc.assert(
      fc.property(fc.nat({ max: 50 }), (seed) => {
        // Occupy one hand slot first so a Power Hour draw cannot fit both cards
        // and must reveal keep_all pending cards.
        const d1 = drawForBar(seedDeck("team-a"), `bar-${seed}-a`);
        if (!d1.ok) throw new Error("setup draw a");
        const k1 = keepCard(d1.state, d1.cardIds![0]);
        if (!k1.ok) throw new Error("setup keep a");

        const drawn = drawForBar(k1.state, `bar-${seed}-b`, {
          drawOverride: true,
        });
        if (!drawn.ok) throw new Error("power hour draw");
        expect(drawn.state.pendingMode).toBe("keep_all");
        expect(count(drawn.state, "pending")).toBe(2);

        // Hand is full (1 held + 1 kept). Keeping the second pending card is
        // rejected until a slot frees.
        const first = keepCard(drawn.state, drawn.cardIds![0]);
        if (!first.ok) throw new Error("keep first pending");
        expect(count(first.state, "hand")).toBe(MAX_HAND);
        expect(first.state.pendingBarId).toBe(`bar-${seed}-b`);

        const blocked = keepCard(first.state, drawn.cardIds![1]);
        expect(blocked).toEqual({
          ok: false,
          state: first.state,
          reason: "hand_full",
        });

        // Free a slot, then keep the last pending card: the draw resolves and
        // the mode resets, with no extra discard from the keep_all keeps.
        const held = first.state.cards.find((card) => card.state === "hand")!;
        const played = playCard(first.state, held.id);
        if (!played.ok) throw new Error("play held");
        const last = keepCard(played.state, drawn.cardIds![1]);
        if (!last.ok) throw new Error("keep last pending");
        expect(last.state.pendingBarId).toBeNull();
        expect(last.state.pendingMode).toBe("choose_one");
        expect(count(last.state, "pending")).toBe(0);
        // Only the setup choose_one draw discarded a card; keep_all kept both.
        expect(count(last.state, "discarded")).toBe(1);
      }),
    );
  });
});
