import { describe, expect, it } from "vitest";

import type { GameEvent } from "@/lib/events";
import type { ResolvedBarRef } from "@/lib/cards/behaviorState";

import { foldGameBoardEvents, GAME_BOARD_EVENT_TYPES } from "./events";
import {
  selectMapOverlays,
  type CardBehaviorSelectorContext,
} from "./cardBehavior";

/**
 * Party Crasher surfaces a `phantom_share` map overlay (rendered as a black band
 * in the bar's pin) while the effect is active, shown to every team. This is the
 * selector half of the QA fix "Party Crasher should show a black fill on the
 * affected bar".
 */

const GAME = "game-overlays";
const BAR = "park-tavern";

function event(
  seq: number,
  eventType: string,
  payload: Record<string, unknown>,
): GameEvent {
  return {
    id: `${GAME}-${seq}`,
    gameId: GAME,
    seq,
    eventType,
    actorKind: "team",
    actorTeamId: "team-a",
    payload,
    createdAt: new Date(seq * 1000).toISOString(),
  };
}

function phantomEffect(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    effectId: "eff-phantom",
    slug: "party-crasher",
    kind: "phantom_share",
    sourcePlayId: "play-1",
    sourceChallengeId: null,
    ownerTeamId: "team-a",
    targetTeamId: null,
    targetBarKey: BAR,
    startsAt: new Date(1_000).toISOString(),
    endsAt: null, // a phantom share never ends on its own
    params: {},
    attachedClaimId: null,
    attachedBarKey: null,
    protectedPoints: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    startAnnounced: true,
    endAnnounced: false,
    ...overrides,
  };
}

function ctx(): CardBehaviorSelectorContext {
  const bars = new Map<string, ResolvedBarRef>([
    [
      BAR,
      { barKey: BAR, kind: "scoring", coords: { lat: 33.78, lng: -84.37 } },
    ],
  ]);
  return {
    bars,
    finishCoords: null,
    activeClaims: [],
    previousBarByTeam: new Map(),
  };
}

describe("selectMapOverlays — Party Crasher phantom share", () => {
  it("emits a phantom_share overlay on the target bar while active, for any team", () => {
    const view = foldGameBoardEvents(GAME, [
      event(1, GAME_BOARD_EVENT_TYPES.cardPlayed, {
        playId: "play-1",
        slug: "party-crasher",
        effects: [phantomEffect()],
      }),
    ]);

    for (const teamId of ["team-a", "team-b"]) {
      const overlays = selectMapOverlays(
        view.cardBehavior,
        ctx(),
        teamId,
        10_000,
      );
      const phantom = overlays.find((o) => o.kind === "phantom_share");
      expect(phantom).toBeDefined();
      expect(phantom?.barKey).toBe(BAR);
      expect(phantom?.label).toMatch(/party crasher/i);
    }
  });

  it("does not emit a phantom overlay once the effect is cancelled", () => {
    const view = foldGameBoardEvents(GAME, [
      event(1, GAME_BOARD_EVENT_TYPES.cardPlayed, {
        playId: "play-1",
        slug: "party-crasher",
        effects: [
          phantomEffect({ cancelledAt: new Date(5_000).toISOString() }),
        ],
      }),
    ]);
    const overlays = selectMapOverlays(
      view.cardBehavior,
      ctx(),
      "team-a",
      10_000,
    );
    expect(overlays.some((o) => o.kind === "phantom_share")).toBe(false);
  });
});
