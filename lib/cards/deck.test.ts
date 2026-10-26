import { describe, expect, it } from "vitest";

import {
  discardCard,
  drawForBar,
  forfeitDraw,
  keepCard,
  playCard,
  seedDeck,
} from "./deck";

describe("card deck transitions", () => {
  it("seeds one instance of every catalog card", () => {
    const state = seedDeck("team-a");
    expect(state.cards).toHaveLength(23);
    expect(new Set(state.cards.map((card) => card.slug)).size).toBe(23);
    expect(new Set(state.cards.map((card) => card.id)).size).toBe(23);
  });

  it("draws two cards, keeps one, and discards the other", () => {
    const drawn = drawForBar(seedDeck("team-a"), "bar-a");
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    expect(drawn.cardIds).toHaveLength(2);
    expect(drawn.state.pendingBarId).toBe("bar-a");

    const kept = keepCard(drawn.state, drawn.cardIds![0]);
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(
      kept.state.cards.filter((card) => card.state === "hand"),
    ).toHaveLength(1);
    expect(
      kept.state.cards.filter((card) => card.state === "discarded"),
    ).toHaveLength(1);
    expect(kept.state.pendingBarId).toBeNull();
  });

  it("resolves a pending draw when one pending card is discarded", () => {
    const drawn = drawForBar(seedDeck("team-a"), "bar-a");
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;

    const discarded = discardCard(drawn.state, drawn.cardIds![0]);
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(discarded.state.pendingBarId).toBeNull();
    expect(
      discarded.state.cards.filter((card) => card.state === "hand"),
    ).toHaveLength(1);
    expect(
      discarded.state.cards.filter((card) => card.state === "pending"),
    ).toHaveLength(0);
  });

  it("rejects finish bars and duplicate bar draws without changing state", () => {
    const initial = seedDeck("team-a");
    const finish = drawForBar(initial, "finish", { finishBar: true });
    expect(finish).toEqual({ ok: false, state: initial, reason: "finish_bar" });

    const first = drawForBar(initial, "bar-a");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const duplicate = drawForBar(first.state, "bar-a");
    expect(duplicate).toEqual({
      ok: false,
      state: first.state,
      reason: "duplicate_bar_draw",
    });
  });

  it("enforces the two-card hand limit and supports play/discard", () => {
    let state = seedDeck("team-a");
    const first = drawForBar(state, "bar-a");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const keptFirst = keepCard(first.state, first.cardIds![0]);
    expect(keptFirst.ok).toBe(true);
    if (!keptFirst.ok) return;
    state = keptFirst.state;

    const second = drawForBar(state, "bar-b");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const keptSecond = keepCard(second.state, second.cardIds![0]);
    expect(keptSecond.ok).toBe(true);
    if (!keptSecond.ok) return;
    state = keptSecond.state;

    // A draw with a full hand now REVEALS two pending cards (R2.4): the draw is
    // recorded, but keeping is blocked until a slot is freed or the draw is
    // forfeited. (Previously this silently rejected with hand_full and dropped
    // the draw entirely.)
    const fullHandDraw = drawForBar(state, "bar-c");
    expect(fullHandDraw.ok).toBe(true);
    if (!fullHandDraw.ok) return;
    expect(fullHandDraw.state.pendingBarId).toBe("bar-c");
    expect(
      fullHandDraw.state.cards.filter((card) => card.state === "pending"),
    ).toHaveLength(2);

    // Keeping while the hand is full is rejected without mutating state.
    const blockedKeep = keepCard(fullHandDraw.state, fullHandDraw.cardIds![0]);
    expect(blockedKeep).toEqual({
      ok: false,
      state: fullHandDraw.state,
      reason: "hand_full",
    });
    state = fullHandDraw.state;

    const played = playCard(
      state,
      state.cards.find((card) => card.state === "hand")!.id,
    );
    expect(played.ok).toBe(true);
    if (!played.ok) return;
    expect(
      played.state.cards.filter((card) => card.state === "hand"),
    ).toHaveLength(1);

    const discarded = discardCard(
      played.state,
      played.state.cards.find((card) => card.state === "hand")!.id,
    );
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(
      discarded.state.cards.filter((card) => card.state === "hand"),
    ).toHaveLength(0);
  });

  it("forfeits a pending draw: discards both drawn cards, keeps the bar recorded", () => {
    // Fill the hand to two, then draw with a full hand so two cards are pending.
    let state = seedDeck("team-a");
    const d1 = drawForBar(state, "bar-a");
    if (!d1.ok) throw new Error("draw a");
    const k1 = keepCard(d1.state, d1.cardIds![0]);
    if (!k1.ok) throw new Error("keep a");
    const d2 = drawForBar(k1.state, "bar-b");
    if (!d2.ok) throw new Error("draw b");
    const k2 = keepCard(d2.state, d2.cardIds![0]);
    if (!k2.ok) throw new Error("keep b");
    state = k2.state;

    const drawn = drawForBar(state, "bar-c");
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    expect(
      drawn.state.cards.filter((card) => card.state === "pending"),
    ).toHaveLength(2);

    const forfeited = forfeitDraw(drawn.state);
    expect(forfeited.ok).toBe(true);
    if (!forfeited.ok) return;
    // Both drawn cards are discarded, the hand is untouched (still two), and the
    // pending draw is cleared. The bar stays recorded (no re-draw).
    expect(
      forfeited.state.cards.filter((card) => card.state === "pending"),
    ).toHaveLength(0);
    expect(
      forfeited.state.cards.filter((card) => card.state === "hand"),
    ).toHaveLength(2);
    expect(forfeited.state.pendingBarId).toBeNull();
    expect(forfeited.state.drawnBarIds).toContain("bar-c");
  });

  it("rejects a forfeit when there is no pending draw", () => {
    const state = seedDeck("team-a");
    expect(forfeitDraw(state)).toEqual({
      ok: false,
      state,
      reason: "pending_draw",
    });
  });

  it("discarding one pending card under a full hand leaves the draw pending", () => {
    // Full hand, then a draw reveals two pending cards.
    let state = seedDeck("team-a");
    const d1 = drawForBar(state, "bar-a");
    if (!d1.ok) throw new Error("draw a");
    const k1 = keepCard(d1.state, d1.cardIds![0]);
    if (!k1.ok) throw new Error("keep a");
    const d2 = drawForBar(k1.state, "bar-b");
    if (!d2.ok) throw new Error("draw b");
    const k2 = keepCard(d2.state, d2.cardIds![0]);
    if (!k2.ok) throw new Error("keep b");
    const drawn = drawForBar(k2.state, "bar-c");
    if (!drawn.ok) throw new Error("draw c");
    state = drawn.state;

    // Discarding one pending card does NOT promote the other into the full hand;
    // the draw stays open with one pending card remaining.
    const discarded = discardCard(state, drawn.cardIds![0]);
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(
      discarded.state.cards.filter((card) => card.state === "hand"),
    ).toHaveLength(2);
    expect(
      discarded.state.cards.filter((card) => card.state === "pending"),
    ).toHaveLength(1);
    expect(discarded.state.pendingBarId).toBe("bar-c");
  });

  it("keeps both cards straight to hand on a drawOverride draw with room", () => {
    const drawn = drawForBar(seedDeck("team-a"), "bar-a", {
      drawOverride: true,
    });
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    // With an empty hand there is room for both, so they go straight in and the
    // draw resolves immediately with no pending choice (R17.2).
    expect(drawn.state.pendingBarId).toBeNull();
    expect(drawn.state.pendingMode).toBe("choose_one");
    expect(
      drawn.state.cards.filter((card) => card.state === "hand"),
    ).toHaveLength(2);
  });

  it("reveals keep_all pending cards when a drawOverride draw has no room", () => {
    // Fill the hand to one so only one of the two drawn cards fits.
    const d1 = drawForBar(seedDeck("team-a"), "bar-a");
    if (!d1.ok) throw new Error("draw a");
    const k1 = keepCard(d1.state, d1.cardIds![0]);
    if (!k1.ok) throw new Error("keep a");

    const drawn = drawForBar(k1.state, "bar-b", { drawOverride: true });
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    // Both reveal as pending under keep_all: nothing is auto-discarded, the team
    // keeps each one after freeing a slot.
    expect(drawn.state.pendingBarId).toBe("bar-b");
    expect(drawn.state.pendingMode).toBe("keep_all");
    expect(
      drawn.state.cards.filter((card) => card.state === "pending"),
    ).toHaveLength(2);
  });

  it("keep_all keep moves only the chosen card and leaves the rest pending", () => {
    // Start from an empty hand and reveal two keep_all pending cards via a
    // Power Hour draw. With room for both, they would go straight in, so we
    // first occupy one hand slot with a normal draw, then Power Hour draws.
    const d1 = drawForBar(seedDeck("team-a"), "bar-a");
    if (!d1.ok) throw new Error("draw a");
    const k1 = keepCard(d1.state, d1.cardIds![0]);
    if (!k1.ok) throw new Error("keep a");
    const drawn = drawForBar(k1.state, "bar-b", { drawOverride: true });
    if (!drawn.ok) throw new Error("draw b");
    // Hand holds one card; both Power Hour cards reveal as keep_all pending.
    expect(
      drawn.state.cards.filter((card) => card.state === "hand"),
    ).toHaveLength(1);
    expect(
      drawn.state.cards.filter((card) => card.state === "pending"),
    ).toHaveLength(2);

    // There is room (hand = 1 < MAX_HAND), so keeping one pending card moves
    // ONLY that card into the hand and leaves the other pending. Nothing is
    // auto-discarded by keeping under keep_all (R17.2).
    const firstKeep = keepCard(drawn.state, drawn.cardIds![0]);
    expect(firstKeep.ok).toBe(true);
    if (!firstKeep.ok) return;
    expect(
      firstKeep.state.cards.filter((card) => card.state === "hand"),
    ).toHaveLength(2);
    expect(
      firstKeep.state.cards.filter((card) => card.state === "pending"),
    ).toHaveLength(1);
    expect(
      firstKeep.state.cards.filter((card) => card.state === "discarded"),
    ).toHaveLength(1); // the sole discard comes from the choose_one setup draw
    expect(firstKeep.state.pendingBarId).toBe("bar-b");
    expect(firstKeep.state.pendingMode).toBe("keep_all");

    // Now the hand is full (2), so keeping the last pending card is rejected
    // with hand_full until a slot frees up.
    const blocked = keepCard(firstKeep.state, drawn.cardIds![1]);
    expect(blocked).toEqual({
      ok: false,
      state: firstKeep.state,
      reason: "hand_full",
    });

    // Free a slot by playing a held card, then keep the remaining pending card:
    // only that card moves, nothing new is discarded, and the draw resolves.
    const held = firstKeep.state.cards.find((card) => card.state === "hand")!;
    const played = playCard(firstKeep.state, held.id);
    if (!played.ok) throw new Error("play held");
    const kept = keepCard(played.state, drawn.cardIds![1]);
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(
      kept.state.cards.filter((card) => card.state === "hand"),
    ).toHaveLength(2);
    expect(
      kept.state.cards.filter((card) => card.state === "pending"),
    ).toHaveLength(0);
    // Still only the single setup discard — keep_all keeps never discard.
    expect(
      kept.state.cards.filter((card) => card.state === "discarded"),
    ).toHaveLength(1);
    // Last pending card kept, so the draw resolves and the mode resets.
    expect(kept.state.pendingBarId).toBeNull();
    expect(kept.state.pendingMode).toBe("choose_one");
  });

  it("keep_all discard removes only that card without promoting the rest", () => {
    const d1 = drawForBar(seedDeck("team-a"), "bar-a");
    if (!d1.ok) throw new Error("draw a");
    const k1 = keepCard(d1.state, d1.cardIds![0]);
    if (!k1.ok) throw new Error("keep a");
    const drawn = drawForBar(k1.state, "bar-b", { drawOverride: true });
    if (!drawn.ok) throw new Error("draw b");

    // The choose_one setup draw (bar-a) already discarded its non-kept card, so
    // one discard exists before we touch the keep_all pending cards.
    expect(
      drawn.state.cards.filter((card) => card.state === "discarded"),
    ).toHaveLength(1);

    // Discarding one pending card never promotes the other into the hand under
    // keep_all; the draw stays open with one pending card remaining. Only the
    // discarded card changes state — the held card and the other pending card
    // are untouched (R17.2).
    const discarded = discardCard(drawn.state, drawn.cardIds![0]);
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(
      discarded.state.cards.filter((card) => card.state === "hand"),
    ).toHaveLength(1);
    expect(
      discarded.state.cards.filter((card) => card.state === "pending"),
    ).toHaveLength(1);
    // Two discards now: the setup discard plus the one we just discarded.
    expect(
      discarded.state.cards.filter((card) => card.state === "discarded"),
    ).toHaveLength(2);
    expect(discarded.state.pendingBarId).toBe("bar-b");
    expect(discarded.state.pendingMode).toBe("keep_all");

    // Discarding the last pending card resolves the draw and resets the mode.
    const lastPending = discarded.state.cards.find(
      (card) => card.state === "pending",
    )!;
    const cleared = discardCard(discarded.state, lastPending.id);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.state.pendingBarId).toBeNull();
    expect(cleared.state.pendingMode).toBe("choose_one");
  });

  it("forfeit discards all keep_all pending cards and resets the mode", () => {
    const d1 = drawForBar(seedDeck("team-a"), "bar-a");
    if (!d1.ok) throw new Error("draw a");
    const k1 = keepCard(d1.state, d1.cardIds![0]);
    if (!k1.ok) throw new Error("keep a");
    const drawn = drawForBar(k1.state, "bar-b", { drawOverride: true });
    if (!drawn.ok) throw new Error("draw b");

    const forfeited = forfeitDraw(drawn.state);
    expect(forfeited.ok).toBe(true);
    if (!forfeited.ok) return;
    expect(
      forfeited.state.cards.filter((card) => card.state === "pending"),
    ).toHaveLength(0);
    expect(
      forfeited.state.cards.filter((card) => card.state === "hand"),
    ).toHaveLength(1);
    expect(forfeited.state.pendingBarId).toBeNull();
    expect(forfeited.state.pendingMode).toBe("choose_one");
    expect(forfeited.state.drawnBarIds).toContain("bar-b");
  });
});
