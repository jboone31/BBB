import { describe, expect, it } from "vitest";

import type { GameEvent } from "@/lib/events";

import { foldGameBoardEvents, GAME_BOARD_EVENT_TYPES } from "./events";

const gameId = "game-membership";

function event(seq: number, eventType: string, payload: unknown): GameEvent {
  return {
    id: `${gameId}-event-${seq}`,
    gameId,
    seq,
    eventType,
    actorKind: "system",
    actorTeamId: null,
    payload,
    createdAt: new Date(seq).toISOString(),
  };
}

describe("Game_Board membership projection", () => {
  it("folds joins, assignments, and departures into one canonical roster", () => {
    const view = foldGameBoardEvents(gameId, [
      event(1, GAME_BOARD_EVENT_TYPES.teamCreated, {
        teamId: "red",
        name: "Red",
        color: "#f00",
      }),
      event(2, GAME_BOARD_EVENT_TYPES.teamCreated, {
        teamId: "blue",
        name: "Blue",
        color: "#00f",
      }),
      event(3, GAME_BOARD_EVENT_TYPES.playerJoined, {
        playerId: "p1",
        displayName: "Alex",
      }),
      event(4, GAME_BOARD_EVENT_TYPES.teamChanged, {
        playerId: "p1",
        fromTeamId: null,
        toTeamId: "red",
      }),
      event(5, GAME_BOARD_EVENT_TYPES.playerJoined, {
        playerId: "p2",
        displayName: "Sam",
      }),
      event(6, GAME_BOARD_EVENT_TYPES.teamChanged, {
        playerId: "p2",
        fromTeamId: null,
        toTeamId: "blue",
      }),
      event(7, GAME_BOARD_EVENT_TYPES.playerLeft, { playerId: "p1" }),
    ]);

    expect(view.players).toEqual([
      { id: "p2", displayName: "Sam", teamId: "blue" },
    ]);
  });

  it("ignores duplicate joins and assignments to unavailable teams", () => {
    const view = foldGameBoardEvents(gameId, [
      event(1, GAME_BOARD_EVENT_TYPES.teamCreated, {
        teamId: "red",
        name: "Red",
        color: "#f00",
      }),
      event(2, GAME_BOARD_EVENT_TYPES.playerJoined, {
        playerId: "p1",
        displayName: "Alex",
      }),
      event(3, GAME_BOARD_EVENT_TYPES.playerJoined, {
        playerId: "p1",
        displayName: "Other name",
      }),
      event(4, GAME_BOARD_EVENT_TYPES.teamChanged, {
        playerId: "p1",
        fromTeamId: null,
        toTeamId: "missing",
      }),
    ]);

    expect(view.players).toEqual([
      { id: "p1", displayName: "Alex", teamId: null },
    ]);
  });
});
