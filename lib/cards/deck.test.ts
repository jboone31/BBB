import { describe, expect, it } from "vitest";

import {
  activatePowerHour,
  discardCard,
  drawForBar,
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

    const blocked = drawForBar(state, "bar-c");
    expect(blocked).toEqual({ ok: false, state, reason: "hand_full" });

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

  it("keeps both cards during an active Power Hour", () => {
    const initial = activatePowerHour(seedDeck("team-a"), 1_000);
    const drawn = drawForBar(initial, "bar-a", { now: 1_001 });
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    expect(drawn.state.pendingBarId).toBeNull();
    expect(
      drawn.state.cards.filter((card) => card.state === "hand"),
    ).toHaveLength(2);
  });
});
