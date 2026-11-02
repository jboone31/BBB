import { describe, expect, it } from "vitest";

import type { GameEvent } from "@/lib/events";

import {
  applyGameBoardEvent,
  foldGameBoardEvents,
  GAME_BOARD_EVENT_TYPES,
  initialGameBoardView,
} from "./events";

/**
 * Unit coverage for the card-behavior projection slice (design.md §Projection
 * Changes, task 9.1). The exhaustive idempotence / isolation / snapshot-split
 * property lives in task 9.3 (`events.cardBehavior.property.test.ts`); these are
 * focused examples pinning the fold's contract: embedded records upsert by id,
 * score entries and claim removals fold through the existing helpers, transition
 * events flip announced flags and push no toast, the Fairest decision routes its
 * `cards` section through the inventory fold, and `game_ended` cancels every
 * uncancelled effect with reason `game_ended`.
 */

const GAME_ID = "game-card-behavior";

function event(
  seq: number,
  eventType: string,
  payload: Record<string, unknown>,
): GameEvent {
  return {
    id: `${GAME_ID}-${seq}`,
    gameId: GAME_ID,
    seq,
    eventType,
    actorKind: "system",
    actorTeamId: null,
    payload,
    createdAt: new Date(seq * 1000).toISOString(),
  };
}

function effectRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    effectId: "effect-1",
    slug: "cancel-culture",
    kind: "radius_lock",
    sourcePlayId: "play-1",
    sourceChallengeId: null,
    ownerTeamId: "team-a",
    targetTeamId: null,
    targetBarKey: "bar-1",
    startsAt: new Date(10_000).toISOString(),
    endsAt: new Date(20_000).toISOString(),
    params: { radiusMiles: 0.25 },
    attachedClaimId: null,
    attachedBarKey: null,
    protectedPoints: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    startAnnounced: false,
    endAnnounced: false,
    ...overrides,
  };
}

function challengeRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    challengeId: "challenge-1",
    slug: "go-piss-girl",
    sourcePlayId: "play-1",
    casterTeamId: "team-a",
    targetTeamId: "team-b",
    params: { kind: "none" },
    mirroredFromChallengeId: null,
    mirroredFromPlayId: null,
    status: "open",
    createdAt: new Date(1_000).toISOString(),
    resolvedAt: null,
    resolvedByTeamId: null,
    resolvedBySessionId: null,
    resolvedByKind: null,
    failureEffectId: null,
    ...overrides,
  };
}

describe("card-behavior fold — embedded records upsert by id", () => {
  it("records a card_played PlayView, a play toast, and an embedded challenge", () => {
    const view = foldGameBoardEvents(GAME_ID, [
      event(1, GAME_BOARD_EVENT_TYPES.cardPlayed, {
        playId: "play-1",
        slug: "go-piss-girl",
        castingTeamId: "team-a",
        targetTeamId: "team-b",
        cards: [
          {
            cardId: "card-1",
            teamId: "team-a",
            slug: "go-piss-girl",
            state: "played",
          },
        ],
        challenges: [challengeRecord()],
      }),
    ]);

    expect(view.cardBehavior.plays["play-1"]).toMatchObject({
      playId: "play-1",
      slug: "go-piss-girl",
      casterTeamId: "team-a",
      targetTeamId: "team-b",
      seq: 1,
    });
    expect(view.cardBehavior.challenges["challenge-1"]?.status).toBe("open");
    expect(view.cardBehavior.toastEvents).toEqual([
      { id: "1:play:play-1", seq: 1, kind: "play", subjectId: "play-1" },
    ]);
  });

  it("replaces an earlier record with a later-seq upsert for the same id", () => {
    const view = foldGameBoardEvents(GAME_ID, [
      event(1, GAME_BOARD_EVENT_TYPES.cardPlayed, {
        playId: "play-1",
        slug: "go-piss-girl",
        castingTeamId: "team-a",
        targetTeamId: "team-b",
        challenges: [challengeRecord()],
      }),
      event(2, GAME_BOARD_EVENT_TYPES.challengeResolved, {
        challengeId: "challenge-1",
        challenges: [
          challengeRecord({
            status: "completed",
            resolvedByKind: "team",
            resolvedByTeamId: "team-b",
          }),
        ],
      }),
    ]);

    expect(view.cardBehavior.challenges["challenge-1"]?.status).toBe(
      "completed",
    );
    expect(view.cardBehavior.toastEvents).toEqual([
      { id: "1:play:play-1", seq: 1, kind: "play", subjectId: "play-1" },
      {
        id: "2:challenge_resolved:challenge-1",
        seq: 2,
        kind: "challenge_resolved",
        subjectId: "challenge-1",
      },
    ]);
  });

  it("accepts offers under either `offers` or `fairestOffers`", () => {
    const offer = {
      offerId: "offer-1",
      sourcePlayId: "play-1",
      slug: "pioneer",
      holderTeamId: "team-b",
      originalCasterTeamId: "team-a",
      challengeId: null,
      restrictionEffectId: "effect-9",
      status: "pending",
      decidedAt: null,
      mirroredChallengeId: null,
      mirroredEffectId: null,
    };
    const underFairest = foldGameBoardEvents(GAME_ID, [
      event(1, GAME_BOARD_EVENT_TYPES.cardPlayed, {
        playId: "play-1",
        slug: "pioneer",
        castingTeamId: "team-a",
        targetTeamId: "team-b",
        fairestOffers: [offer],
      }),
    ]);
    const underOffers = foldGameBoardEvents(GAME_ID, [
      event(1, GAME_BOARD_EVENT_TYPES.cardPlayed, {
        playId: "play-1",
        slug: "pioneer",
        castingTeamId: "team-a",
        targetTeamId: "team-b",
        offers: [offer],
      }),
    ]);

    expect(underFairest.cardBehavior.offers["offer-1"]?.status).toBe("pending");
    expect(underOffers.cardBehavior.offers["offer-1"]?.status).toBe("pending");
  });

  it("folds embedded scoreEntries and removedClaims through the existing helpers", () => {
    const view = foldGameBoardEvents(GAME_ID, [
      event(1, GAME_BOARD_EVENT_TYPES.claimRecorded, {
        claimId: "claim-1",
        teamId: "team-a",
        barId: "bar-1",
      }),
      event(2, GAME_BOARD_EVENT_TYPES.cardPlayed, {
        playId: "play-1",
        slug: "voted-off-the-island",
        castingTeamId: "team-a",
        targetTeamId: "team-b",
        removedClaims: [{ claimId: "claim-1" }],
        scoreEntries: [
          {
            entryId: "ledger-1",
            teamId: "team-a",
            category: "bar_share_correction",
            points: -6,
            sourceClaimId: "claim-2",
          },
        ],
      }),
    ]);

    expect(view.activeClaims).toEqual([]);
    expect(view.scoreEntries).toEqual([
      {
        entryId: "ledger-1",
        teamId: "team-a",
        category: "bar_share_correction",
        points: -6,
        sourceId: "claim-2",
      },
    ]);
  });
});

describe("card-behavior fold — effect transitions and lifecycle", () => {
  it("sets startAnnounced / endAnnounced and pushes no toast event", () => {
    const base = foldGameBoardEvents(GAME_ID, [
      event(1, GAME_BOARD_EVENT_TYPES.cardPlayed, {
        playId: "play-1",
        slug: "cancel-culture",
        castingTeamId: "team-a",
        targetBarKey: "bar-1",
        effects: [effectRecord()],
      }),
    ]);
    expect(base.cardBehavior.effects["effect-1"]?.startAnnounced).toBe(false);

    const activated = applyGameBoardEvent(
      base,
      event(2, GAME_BOARD_EVENT_TYPES.effectActivated, {
        effectId: "effect-1",
        effects: [effectRecord({ startAnnounced: true })],
      }),
    );
    expect(activated.cardBehavior.effects["effect-1"]?.startAnnounced).toBe(
      true,
    );
    expect(activated.cardBehavior.effects["effect-1"]?.endAnnounced).toBe(
      false,
    );

    const expired = applyGameBoardEvent(
      activated,
      event(3, GAME_BOARD_EVENT_TYPES.effectExpired, {
        effectId: "effect-1",
        effects: [effectRecord({ startAnnounced: true, endAnnounced: true })],
      }),
    );
    expect(expired.cardBehavior.effects["effect-1"]?.endAnnounced).toBe(true);
    // Transition events never contribute a toast descriptor: only the original
    // card_played toast remains across both the activation and the expiry.
    expect(expired.cardBehavior.toastEvents).toEqual([
      { id: "1:play:play-1", seq: 1, kind: "play", subjectId: "play-1" },
    ]);
  });

  it("game_ended cancels every uncancelled effect with reason game_ended", () => {
    const view = foldGameBoardEvents(GAME_ID, [
      event(1, GAME_BOARD_EVENT_TYPES.cardPlayed, {
        playId: "play-1",
        slug: "cancel-culture",
        castingTeamId: "team-a",
        targetBarKey: "bar-1",
        effects: [
          effectRecord({ effectId: "effect-live" }),
          effectRecord({
            effectId: "effect-done",
            cancelledAt: new Date(5_000).toISOString(),
            cancelReason: "host",
          }),
        ],
      }),
      event(2, GAME_BOARD_EVENT_TYPES.gameEnded, { endedAt: "ignored" }),
    ]);

    const ended = new Date(2_000).toISOString();
    expect(view.lifecycle).toBe("ended");
    expect(view.cardBehavior.effects["effect-live"]).toMatchObject({
      cancelledAt: ended,
      cancelReason: "game_ended",
    });
    // An already-cancelled effect keeps its original cancellation.
    expect(view.cardBehavior.effects["effect-done"]).toMatchObject({
      cancelReason: "host",
      cancelledAt: new Date(5_000).toISOString(),
    });
  });
});

describe("card-behavior fold — Fairest and payout toasts", () => {
  it("routes fairest_decided through the inventory fold and pushes one toast", () => {
    const view = foldGameBoardEvents(GAME_ID, [
      event(1, GAME_BOARD_EVENT_TYPES.fairestDecided, {
        offerId: "offer-1",
        cards: [
          {
            cardId: "fairest-1",
            teamId: "team-b",
            slug: "fairest-of-them-all",
            state: "played",
          },
        ],
        offers: [
          {
            offerId: "offer-1",
            sourcePlayId: "play-1",
            slug: "go-piss-girl",
            holderTeamId: "team-b",
            originalCasterTeamId: "team-a",
            challengeId: "challenge-1",
            restrictionEffectId: null,
            status: "played",
            decidedAt: new Date(1_000).toISOString(),
            mirroredChallengeId: "challenge-2",
            mirroredEffectId: null,
          },
        ],
      }),
    ]);

    expect(view.cards).toEqual([
      {
        cardId: "fairest-1",
        teamId: "team-b",
        slug: "fairest-of-them-all",
        state: "played",
      },
    ]);
    expect(view.cardBehavior.offers["offer-1"]?.status).toBe("played");
    expect(view.cardBehavior.toastEvents).toEqual([
      {
        id: "1:fairest_decided:offer-1",
        seq: 1,
        kind: "fairest_decided",
        subjectId: "offer-1",
      },
    ]);
  });

  it("pushes a payout toast only for a patient_investor_award score entry", () => {
    const view = foldGameBoardEvents(GAME_ID, [
      event(1, GAME_BOARD_EVENT_TYPES.scoreAwarded, {
        entryId: "ledger-1",
        teamId: "team-a",
        category: "bar_share",
        points: 12,
      }),
      event(2, GAME_BOARD_EVENT_TYPES.scoreAwarded, {
        entryId: "ledger-2",
        teamId: "team-a",
        category: "patient_investor_award",
        points: 6,
      }),
    ]);

    expect(view.cardBehavior.toastEvents).toEqual([
      {
        id: "2:payout:ledger-2",
        seq: 2,
        kind: "payout",
        subjectId: "ledger-2",
      },
    ]);
  });
});

describe("card-behavior fold — idempotence", () => {
  it("re-delivering an event adds no duplicate toast or record", () => {
    const played = event(1, GAME_BOARD_EVENT_TYPES.cardPlayed, {
      playId: "play-1",
      slug: "go-piss-girl",
      castingTeamId: "team-a",
      targetTeamId: "team-b",
      challenges: [challengeRecord()],
    });
    const once = applyGameBoardEvent(initialGameBoardView(GAME_ID), played);
    const twice = applyGameBoardEvent(once, played);

    // Below-watermark re-delivery is a no-op (same reference).
    expect(twice).toBe(once);
    expect(Object.keys(once.cardBehavior.challenges)).toEqual(["challenge-1"]);
    expect(once.cardBehavior.toastEvents).toHaveLength(1);
  });
});
