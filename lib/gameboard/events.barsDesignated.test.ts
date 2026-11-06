import { describe, expect, it } from "vitest";

import type { GameEvent } from "@/lib/events";

import {
  applyGameBoardEvent,
  GAME_BOARD_EVENT_TYPES,
  initialGameBoardView,
} from "./events";

/**
 * The Game_Board fold of `bars_designated` records the board-facing start /
 * finish bar keys (candidate slugs) the bars route resolves alongside the raw
 * bar uuids. These keys feed the card-target eligibility selectors so the board
 * can exclude the start bar (Voted Off the Island) and the finish bar (every bar
 * card) and evaluate the Cancel Culture radius against the finish coordinates.
 */

const GAME = "11111111-1111-4111-8111-111111111111";

function barsDesignated(
  seq: number,
  payload: Record<string, unknown>,
): GameEvent {
  return {
    id: `evt-${seq}`,
    gameId: GAME,
    seq,
    eventType: GAME_BOARD_EVENT_TYPES.barsDesignated,
    actorKind: "admin",
    actorTeamId: null,
    payload,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("applyGameBoardEvent — bars_designated", () => {
  it("records the board-facing start and finish bar keys from the payload", () => {
    const view = applyGameBoardEvent(
      initialGameBoardView(GAME),
      barsDesignated(1, {
        startBarId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        finishBarId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        startBarKey: "park-tavern",
        finishBarKey: "delbar",
      }),
    );
    expect(view.startBarKey).toBe("park-tavern");
    expect(view.finishBarKey).toBe("delbar");
  });

  it("ignores the raw uuids and leaves keys null when the event carries none", () => {
    // A legacy event (pre-fix) carries only the uuids; the board keys bars by
    // candidate slug, so without the keys the designation is unknown to it.
    const view = applyGameBoardEvent(
      initialGameBoardView(GAME),
      barsDesignated(1, {
        startBarId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        finishBarId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }),
    );
    expect(view.startBarKey).toBeNull();
    expect(view.finishBarKey).toBeNull();
  });

  it("changes only the side the payload carries, keeping the other", () => {
    const first = applyGameBoardEvent(
      initialGameBoardView(GAME),
      barsDesignated(1, { startBarKey: "park-tavern", finishBarKey: "delbar" }),
    );
    // Re-designate only the start bar: the finish key must survive.
    const second = applyGameBoardEvent(
      first,
      barsDesignated(2, { startBarKey: "the-independent" }),
    );
    expect(second.startBarKey).toBe("the-independent");
    expect(second.finishBarKey).toBe("delbar");
  });
});
