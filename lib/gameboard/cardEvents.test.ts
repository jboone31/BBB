import { describe, expect, it } from "vitest";

import type { GameEvent } from "@/lib/events";

import {
  foldGameBoardEvents,
  GAME_BOARD_EVENT_TYPES,
  initialGameBoardView,
  applyGameBoardEvent,
  selectClaimedBarCounts,
  selectClaimState,
  selectScoreTotals,
} from "./events";

const GAME_ID = "game-card-events";

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
    createdAt: new Date(seq).toISOString(),
  };
}

describe("canonical card events", () => {
  it("exposes stable event names for every Phase 1 domain family", () => {
    expect(Object.values(GAME_BOARD_EVENT_TYPES)).toEqual(
      expect.arrayContaining([
        "deck_seeded",
        "cards_drawn",
        "card_kept",
        "card_discarded",
        "card_played",
        "challenge_issued",
        "challenge_confirmed",
        "challenge_rejected",
        "effect_created",
        "effect_activated",
        "effect_expired",
        "claim_blocked",
        "claim_recorded",
        "claim_removed",
        "score_awarded",
        "score_modifier_applied",
        "notification_created",
      ]),
    );
  });

  it("reconstructs inventory and active domain state from a replay", () => {
    const events = [
      event(1, GAME_BOARD_EVENT_TYPES.deckSeeded, {
        cards: [
          { cardId: "card-1", teamId: "team-a", slug: "wired", state: "deck" },
          {
            cardId: "card-2",
            teamId: "team-a",
            slug: "power-hour",
            state: "deck",
          },
        ],
      }),
      event(2, GAME_BOARD_EVENT_TYPES.cardsDrawn, {
        cards: [{ cardId: "card-1", teamId: "team-a", slug: "wired" }],
      }),
      event(3, GAME_BOARD_EVENT_TYPES.cardKept, {
        cardId: "card-1",
        teamId: "team-a",
        slug: "wired",
      }),
      event(4, GAME_BOARD_EVENT_TYPES.challengeIssued, {
        challengeId: "challenge-1",
        sourcePlayId: "play-1",
        casterTeamId: "team-a",
        targetTeamId: "team-b",
        blocksClaims: true,
      }),
      event(5, GAME_BOARD_EVENT_TYPES.effectCreated, {
        effectId: "effect-1",
        sourcePlayId: "play-1",
        effectType: "team_claim_block",
        targetTeamId: "team-b",
      }),
      event(6, GAME_BOARD_EVENT_TYPES.notificationCreated, {
        notificationId: "notification-1",
        sourcePlayId: "play-1",
        audience: "target",
        teamId: "team-b",
        display: { title: "Challenge" },
      }),
      event(7, GAME_BOARD_EVENT_TYPES.scoreAwarded, {
        entryId: "score-1",
        teamId: "team-a",
        category: "bonus",
        points: 5,
        sourceId: "play-1",
      }),
    ];

    const view = foldGameBoardEvents(GAME_ID, events);
    expect(view.cards).toEqual([
      { cardId: "card-2", teamId: "team-a", slug: "power-hour", state: "deck" },
      { cardId: "card-1", teamId: "team-a", slug: "wired", state: "hand" },
    ]);
    expect(view.activeChallenges).toHaveLength(1);
    expect(view.activeEffects).toHaveLength(1);
    expect(view.activeRestrictions).toHaveLength(1);
    expect(view.notifications).toHaveLength(1);
    expect(view.scoreEntries).toHaveLength(1);
  });

  it("removes resolved challenges and expired effects", () => {
    const issued = event(1, GAME_BOARD_EVENT_TYPES.challengeIssued, {
      challengeId: "challenge-1",
      sourcePlayId: "play-1",
      casterTeamId: "team-a",
      targetTeamId: "team-b",
    });
    const effect = event(2, GAME_BOARD_EVENT_TYPES.effectCreated, {
      effectId: "effect-1",
      sourcePlayId: "play-1",
      effectType: "bar_claim_block",
    });
    const resolved = event(3, GAME_BOARD_EVENT_TYPES.challengeConfirmed, {
      challengeId: "challenge-1",
    });
    const expired = event(4, GAME_BOARD_EVENT_TYPES.effectExpired, {
      effectId: "effect-1",
    });

    const view = foldGameBoardEvents(GAME_ID, [
      issued,
      effect,
      resolved,
      expired,
    ]);
    expect(view.activeChallenges).toEqual([]);
    expect(view.activeEffects).toEqual([]);
    expect(view.activeRestrictions).toEqual([]);
  });

  it("ignores duplicate sequences while preserving the same view reference", () => {
    const seeded = event(1, GAME_BOARD_EVENT_TYPES.scoreAwarded, {
      entryId: "score-1",
      teamId: "team-a",
      category: "base",
      points: 3,
    });
    const view = applyGameBoardEvent(initialGameBoardView(GAME_ID), seeded);
    expect(applyGameBoardEvent(view, seeded)).toBe(view);
  });

  it("folds active claims through removal and later reclaim transitions", () => {
    const firstClaim = event(1, GAME_BOARD_EVENT_TYPES.claimRecorded, {
      claimId: "claim-1",
      teamId: "team-a",
      barId: "bar-1",
      activeTeamIds: ["team-a"],
    });
    const secondTeamClaim = event(2, GAME_BOARD_EVENT_TYPES.claimRecorded, {
      claimId: "claim-2",
      teamId: "team-b",
      barId: "bar-1",
      activeTeamIds: ["team-a", "team-b"],
    });
    const removeFirst = event(3, GAME_BOARD_EVENT_TYPES.claimRemoved, {
      claimId: "claim-1",
      teamId: "team-a",
      barId: "bar-1",
    });
    const reclaim = event(4, GAME_BOARD_EVENT_TYPES.claimRecorded, {
      claimId: "claim-3",
      teamId: "team-a",
      barId: "bar-1",
      activeTeamIds: ["team-b", "team-a"],
    });

    const view = foldGameBoardEvents("game-card-events", [
      reclaim,
      secondTeamClaim,
      removeFirst,
      firstClaim,
    ]);

    expect(view.activeClaims).toEqual([
      { claimId: "claim-2", teamId: "team-b", barId: "bar-1" },
      { claimId: "claim-3", teamId: "team-a", barId: "bar-1" },
    ]);
    expect(selectClaimState(view)).toEqual({
      "bar-1": ["team-b", "team-a"],
    });
    expect(selectClaimedBarCounts(view)).toEqual({
      "team-b": 1,
      "team-a": 1,
    });
  });

  it("folds score corrections once and derives signed team totals", () => {
    const award = event(1, GAME_BOARD_EVENT_TYPES.scoreAwarded, {
      entryId: "ledger-1",
      teamId: "team-a",
      barId: "bar-1",
      sourceClaimId: "claim-1",
      category: "bar_share",
      points: 12,
    });
    const correction = event(2, GAME_BOARD_EVENT_TYPES.scoreModifierApplied, {
      entryId: "ledger-2",
      teamId: "team-a",
      barId: "bar-1",
      sourceClaimId: "claim-2",
      category: "bar_share_correction",
      points: -6,
    });
    const otherTeam = event(3, GAME_BOARD_EVENT_TYPES.scoreAwarded, {
      entryId: "ledger-3",
      teamId: "team-b",
      barId: "bar-1",
      sourceClaimId: "claim-2",
      category: "bar_share",
      points: 6,
    });

    const view = foldGameBoardEvents("game-card-events", [
      otherTeam,
      award,
      correction,
      correction,
    ]);

    expect(view.scoreEntries).toHaveLength(3);
    expect(view.scoreEntries[1]?.sourceId).toBe("claim-2");
    expect(selectScoreTotals(view)).toEqual({ "team-a": 6, "team-b": 6 });
  });
});
