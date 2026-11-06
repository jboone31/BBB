import { describe, expect, it } from "vitest";

import type { GameEvent } from "@/lib/events";

import {
  applyGameBoardEvent,
  GAME_BOARD_EVENT_TYPES,
  initialGameBoardView,
  type GameBoardView,
} from "./events";

/**
 * The board fold applies a `completeChallenges` / `voidOffers` inventory
 * follow-up (id arrays on an inventory / play event) by flipping the folded
 * challenge / offer status. A completed UIOLI challenge (`status: "completed"`)
 * stops gating the board's claim pre-check; a voided Fairest offer
 * (`status: "void"`) stops prompting. This is the client half of the QA fix
 * "Use It or Lose It still blocks claims after the hand is empty".
 */

const GAME = "11111111-1111-4111-8111-111111111111";
const TEAM_A = "22222222-2222-4222-8222-222222222222";
const TEAM_B = "33333333-3333-4333-8333-333333333333";

let seq = 0;

function event(eventType: string, payload: Record<string, unknown>): GameEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    gameId: GAME,
    seq,
    eventType,
    actorKind: "team",
    actorTeamId: TEAM_A,
    payload,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

/** A view with one open UIOLI challenge targeting team A, folded from a play. */
function viewWithOpenUioli(): GameBoardView {
  seq = 0;
  const base = initialGameBoardView(GAME);
  return applyGameBoardEvent(
    base,
    event(GAME_BOARD_EVENT_TYPES.cardPlayed, {
      teamId: TEAM_B,
      slug: "use-it-or-lose-it",
      challenges: [
        {
          challengeId: "chal-uioli",
          slug: "use-it-or-lose-it",
          sourcePlayId: "play-1",
          casterTeamId: TEAM_B,
          targetTeamId: TEAM_A,
          params: { kind: "none" },
          mirroredFromChallengeId: null,
          mirroredFromPlayId: null,
          status: "open",
          createdAt: "2024-01-01T00:00:00.000Z",
          resolvedAt: null,
          resolvedByTeamId: null,
          resolvedBySessionId: null,
          resolvedByKind: null,
          failureEffectId: null,
        },
      ],
    }),
  );
}

describe("applyGameBoardEvent — inventory follow-up fold", () => {
  it("flips an open challenge to completed from completeChallenges", () => {
    const open = viewWithOpenUioli();
    expect(open.cardBehavior.challenges["chal-uioli"].status).toBe("open");

    const after = applyGameBoardEvent(
      open,
      event(GAME_BOARD_EVENT_TYPES.cardDiscarded, {
        teamId: TEAM_A,
        cards: [],
        completeChallenges: ["chal-uioli"],
      }),
    );
    expect(after.cardBehavior.challenges["chal-uioli"].status).toBe(
      "completed",
    );
  });

  it("voids a pending offer from voidOffers", () => {
    seq = 10;
    const base = initialGameBoardView(GAME);
    const withOffer = applyGameBoardEvent(
      base,
      event(GAME_BOARD_EVENT_TYPES.cardPlayed, {
        teamId: TEAM_A,
        slug: "pioneer",
        offers: [
          {
            offerId: "offer-1",
            sourcePlayId: "play-1",
            slug: "pioneer",
            holderTeamId: TEAM_A,
            originalCasterTeamId: TEAM_B,
            challengeId: null,
            restrictionEffectId: "eff-1",
            status: "pending",
            decidedAt: null,
            mirroredChallengeId: null,
            mirroredEffectId: null,
          },
        ],
      }),
    );
    expect(withOffer.cardBehavior.offers["offer-1"].status).toBe("pending");

    const after = applyGameBoardEvent(
      withOffer,
      event(GAME_BOARD_EVENT_TYPES.cardDiscarded, {
        teamId: TEAM_A,
        cards: [],
        voidOffers: ["offer-1"],
      }),
    );
    expect(after.cardBehavior.offers["offer-1"].status).toBe("void");
  });

  it("ignores ids that name no folded record", () => {
    const open = viewWithOpenUioli();
    const after = applyGameBoardEvent(
      open,
      event(GAME_BOARD_EVENT_TYPES.cardDiscarded, {
        teamId: TEAM_A,
        cards: [],
        completeChallenges: ["chal-unknown"],
        voidOffers: ["offer-unknown"],
      }),
    );
    // The open challenge is untouched; the unknown ids simply do not apply.
    expect(after.cardBehavior.challenges["chal-uioli"].status).toBe("open");
  });
});
