import { describe, expect, it } from "vitest";

import type { GameEvent } from "@/lib/events";

import {
  applyGameBoardEvent,
  GAME_BOARD_EVENT_TYPES,
  initialGameBoardView,
  type GameBoardView,
} from "./events";

/**
 * The board folds each team's pending-draw resolution mode from the inventory
 * events so the Cards_Region can show accurate keep text: a Power Hour
 * `keep_all` reveal keeps every card (discards nothing), an ordinary
 * `choose_one` reveal discards the rest. This is the client half of the QA fix
 * "Power Hour draw ... info says keeping one discards the other (it doesn't)".
 */

const GAME = "11111111-1111-4111-8111-111111111111";
const TEAM_A = "22222222-2222-4222-8222-222222222222";
const TEAM_B = "33333333-3333-4333-8333-333333333333";

let seq = 0;

function drawn(teamId: string, pendingMode: string): GameEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    gameId: GAME,
    seq,
    eventType: GAME_BOARD_EVENT_TYPES.cardsDrawn,
    actorKind: "team",
    actorTeamId: teamId,
    payload: { teamId, cards: [], pendingMode },
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

function view(): GameBoardView {
  seq = 0;
  return initialGameBoardView(GAME);
}

describe("applyGameBoardEvent — pending-draw mode fold", () => {
  it("records a keep_all draw as the acting team's pending mode", () => {
    const after = applyGameBoardEvent(view(), drawn(TEAM_A, "keep_all"));
    expect(after.pendingModeByTeam[TEAM_A]).toBe("keep_all");
  });

  it("records an ordinary draw as choose_one", () => {
    const after = applyGameBoardEvent(view(), drawn(TEAM_A, "choose_one"));
    expect(after.pendingModeByTeam[TEAM_A]).toBe("choose_one");
  });

  it("keeps each team's mode separate", () => {
    let v = applyGameBoardEvent(view(), drawn(TEAM_A, "keep_all"));
    v = applyGameBoardEvent(v, drawn(TEAM_B, "choose_one"));
    expect(v.pendingModeByTeam[TEAM_A]).toBe("keep_all");
    expect(v.pendingModeByTeam[TEAM_B]).toBe("choose_one");
  });

  it("updates a team's mode when a later transition resolves the draw", () => {
    // A Power Hour draw sets keep_all; once the draw resolves the engine resets
    // the team to choose_one, carried on the resolving inventory event.
    let v = applyGameBoardEvent(view(), drawn(TEAM_A, "keep_all"));
    expect(v.pendingModeByTeam[TEAM_A]).toBe("keep_all");
    v = applyGameBoardEvent(v, {
      id: "evt-keep",
      gameId: GAME,
      seq: 50,
      eventType: GAME_BOARD_EVENT_TYPES.cardKept,
      actorKind: "team",
      actorTeamId: TEAM_A,
      payload: { teamId: TEAM_A, cards: [], pendingMode: "choose_one" },
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    expect(v.pendingModeByTeam[TEAM_A]).toBe("choose_one");
  });
});
