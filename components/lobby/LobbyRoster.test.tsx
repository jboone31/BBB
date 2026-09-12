// @vitest-environment jsdom
//
// Component render tests for the lobby roster + live update (Task 22.2).
//
// These cover the read-only roster surface the Lobby_Client shows every session
// while a Game is in the Lobby, and the live-update behavior that keeps it in
// sync as lobby events arrive:
//
//   Requirement 9.3 — WHILE a Game is in the Lobby, THE Lobby_Client SHALL
//     display the Game's Join_Code.
//   Requirement 9.4 — WHILE a Game is in the Lobby, THE Lobby_Client SHALL
//     display the current Teams, each Team's color, and the Players on each Team.
//   Requirement 9.5 — WHEN a lobby Game_Event that changes Teams or Players is
//     applied, THE Lobby_Client SHALL update the displayed Teams and Players.
//
// APPROACH — component + reducer, no page/mocks:
//   `LobbyRoster` is purely presentational: the owning page
//   (`app/games/[gameId]/lobby/page.tsx`) folds the `game_events` log into a
//   `LobbyView` with `applyLobbyEvent` and passes the relevant slices as props.
//   So R9.5 is faithfully reproduced WITHOUT rendering the page (and its
//   next/navigation + Supabase realtime deps): we hold a real `LobbyView`,
//   render its slices, apply a real lobby `GameEvent` through `applyLobbyEvent`
//   exactly as the page's `foldEvent` does, then re-render with the post-apply
//   view and assert the DOM reflects the change. This tests the actual
//   props-in / render-out contract the page relies on, using the same reducer.
//
//   `@vitest-environment jsdom` opts THIS FILE into a DOM (the project default is
//   `node`, see vitest.config.mts), matching app/page.viewport.test.tsx. Plain
//   DOM assertions (no jest-dom matchers) keep the dependency surface minimal.

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { GameEvent } from "@/lib/events";
import {
  applyLobbyEvent,
  initialLobbyView,
  LOBBY_EVENT_TYPES,
  type LobbyView,
} from "@/lib/lobby/events";

import LobbyRoster from "./LobbyRoster";

const GAME_ID = "game-abc";

/**
 * jsdom normalizes an inline `background` color to functional `rgb(r, g, b)`
 * form (e.g. `#e11d48` -> `rgb(225, 29, 72)`), so tests compare against that
 * normalized form rather than the raw hex.
 */
function rgb(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}

// Normalized forms of the team colors used in the fixtures.
const RED_RGB = rgb(225, 29, 72); // #e11d48
const BLUE_RGB = rgb(37, 99, 235); // #2563eb
const GREEN_RGB = rgb(22, 163, 74); // #16a34a

/** Render the roster from the slices of a LobbyView, exactly as the page does. */
function renderRoster(view: LobbyView) {
  return render(
    <LobbyRoster
      gameId={GAME_ID}
      joinCode={view.joinCode}
      teams={view.teams}
      players={view.players}
    />,
  );
}

/**
 * Build a lobby `GameEvent`. `seq` defaults so each successive call in a test
 * advances past the reducer's idempotence watermark; callers that need ordering
 * control pass an explicit `seq`.
 */
function lobbyEvent(
  seq: number,
  eventType: string,
  payload: unknown,
): GameEvent {
  return {
    id: `evt-${seq}`,
    gameId: GAME_ID,
    seq,
    eventType,
    actorKind: "admin",
    actorTeamId: null,
    payload,
    createdAt: new Date(seq).toISOString(),
  };
}

/**
 * A representative populated lobby view: a Join_Code, two colored teams (one with
 * two players, one with one), and a teamless player. Built by folding real lobby
 * events so the fixture matches what the page would actually hold.
 */
function populatedView(): LobbyView {
  const events: GameEvent[] = [
    lobbyEvent(1, LOBBY_EVENT_TYPES.gameCreated, { joinCode: "ABCD12" }),
    lobbyEvent(2, LOBBY_EVENT_TYPES.teamCreated, {
      teamId: "team-red",
      name: "Red Team",
      color: "#e11d48",
    }),
    lobbyEvent(3, LOBBY_EVENT_TYPES.teamCreated, {
      teamId: "team-blue",
      name: "Blue Team",
      color: "#2563eb",
    }),
    lobbyEvent(4, LOBBY_EVENT_TYPES.playerJoined, {
      playerId: "p-alice",
      displayName: "Alice",
    }),
    lobbyEvent(5, LOBBY_EVENT_TYPES.playerJoined, {
      playerId: "p-bob",
      displayName: "Bob",
    }),
    lobbyEvent(6, LOBBY_EVENT_TYPES.playerJoined, {
      playerId: "p-carol",
      displayName: "Carol",
    }),
    lobbyEvent(7, LOBBY_EVENT_TYPES.teamChanged, {
      playerId: "p-alice",
      fromTeamId: null,
      toTeamId: "team-red",
    }),
    lobbyEvent(8, LOBBY_EVENT_TYPES.teamChanged, {
      playerId: "p-bob",
      fromTeamId: null,
      toTeamId: "team-red",
    }),
    lobbyEvent(9, LOBBY_EVENT_TYPES.teamChanged, {
      playerId: "p-carol",
      fromTeamId: null,
      toTeamId: "team-blue",
    }),
  ];
  // Carol stays teamless below; drop her team_changed to keep her in the bucket.
  return events
    .filter((e) => e.seq !== 9)
    .reduce(applyLobbyEvent, initialLobbyView(GAME_ID));
}

afterEach(() => {
  cleanup();
});

describe("LobbyRoster renders the lobby (Requirements 9.3, 9.4)", () => {
  it("displays the Game's Join_Code (R9.3)", () => {
    const view = populatedView();
    renderRoster(view);

    // The code from the game_created event is shown verbatim.
    expect(screen.getByText("ABCD12")).not.toBeNull();
  });

  it("shows a placeholder rather than crashing before the code is known (R9.3)", () => {
    // Before game_created is folded in, joinCode is null; the roster still
    // renders (the page shows the roster immediately on mount).
    renderRoster(initialLobbyView(GAME_ID));
    expect(screen.getByRole("heading", { name: /^lobby$/i })).not.toBeNull();
    // No throw, and no stray team/player content.
    expect(screen.getByText(/no teams yet/i)).not.toBeNull();
  });

  it("displays each Team with its color and its players (R9.4)", () => {
    const view = populatedView();
    const { container } = renderRoster(view);

    // Both team names render.
    const red = screen.getByRole("heading", { name: "Red Team" });
    const blue = screen.getByRole("heading", { name: "Blue Team" });
    expect(red).not.toBeNull();
    expect(blue).not.toBeNull();

    // Each team's assigned color is rendered as a swatch background. The colors
    // come straight from the team_created payloads and must be distinct (R4.4).
    const swatchColors = Array.from(
      container.querySelectorAll<HTMLElement>('span[aria-hidden="true"]'),
    ).map((el) => el.style.background);
    expect(swatchColors).toContain(RED_RGB);
    expect(swatchColors).toContain(BLUE_RGB);
    // The two colors are distinct, as team creation guarantees (R4.4).
    expect(RED_RGB).not.toBe(BLUE_RGB);

    // Players appear under their team. Scope each assertion to the enclosing
    // team card (the <li> that contains the team heading) so we prove the
    // player is shown ON that team, not merely somewhere on the page.
    const redCard = red.closest("li") as HTMLElement;
    expect(redCard).not.toBeNull();
    expect(within(redCard).getByText("Alice")).not.toBeNull();
    expect(within(redCard).getByText("Bob")).not.toBeNull();

    // The teamless player (Carol) is shown in the "Not on a team" bucket, not
    // under a team (valid lobby state, R3.9).
    expect(screen.getByText(/not on a team/i)).not.toBeNull();
    expect(screen.getByText("Carol")).not.toBeNull();
    expect(within(redCard).queryByText("Carol")).toBeNull();
  });
});

describe("LobbyRoster updates when a lobby event is applied (Requirement 9.5)", () => {
  it("shows a newly created Team after a team_created event is applied", () => {
    let view = populatedView();
    const { rerender } = renderRoster(view);

    // Precondition: the new team is not present yet.
    expect(screen.queryByRole("heading", { name: "Green Team" })).toBeNull();

    // Apply a real team_created event the way the page's foldEvent does, then
    // re-render with the post-apply view.
    view = applyLobbyEvent(
      view,
      lobbyEvent(10, LOBBY_EVENT_TYPES.teamCreated, {
        teamId: "team-green",
        name: "Green Team",
        color: "#16a34a",
      }),
    );
    rerender(
      <LobbyRoster
        gameId={GAME_ID}
        joinCode={view.joinCode}
        teams={view.teams}
        players={view.players}
      />,
    );

    // The roster now reflects the new team and its color.
    const green = screen.getByRole("heading", { name: "Green Team" });
    expect(green).not.toBeNull();
    const greenCard = green.closest("li") as HTMLElement;
    const swatch = greenCard.querySelector<HTMLElement>(
      'span[aria-hidden="true"]',
    );
    expect(swatch?.style.background).toBe(GREEN_RGB);
  });

  it("shows a newly joined Player after a player_joined event is applied", () => {
    let view = populatedView();
    const { rerender } = renderRoster(view);

    expect(screen.queryByText("Dave")).toBeNull();

    view = applyLobbyEvent(
      view,
      lobbyEvent(10, LOBBY_EVENT_TYPES.playerJoined, {
        playerId: "p-dave",
        displayName: "Dave",
      }),
    );
    rerender(
      <LobbyRoster
        gameId={GAME_ID}
        joinCode={view.joinCode}
        teams={view.teams}
        players={view.players}
      />,
    );

    // A joined-but-teamless player shows in the "Not on a team" bucket (R3.9).
    expect(screen.getByText("Dave")).not.toBeNull();
    const bucketHeading = screen.getByRole("heading", {
      name: /not on a team/i,
    });
    const bucket = bucketHeading.parentElement as HTMLElement;
    expect(within(bucket).getByText("Dave")).not.toBeNull();
  });

  it("moves a Player between Teams after a team_changed event is applied", () => {
    let view = populatedView();
    const { rerender } = renderRoster(view);

    // Precondition: Carol is teamless, not on Blue Team.
    const blueBefore = screen
      .getByRole("heading", { name: "Blue Team" })
      .closest("li") as HTMLElement;
    expect(within(blueBefore).queryByText("Carol")).toBeNull();

    // Apply team_changed moving Carol onto Blue Team.
    view = applyLobbyEvent(
      view,
      lobbyEvent(10, LOBBY_EVENT_TYPES.teamChanged, {
        playerId: "p-carol",
        fromTeamId: null,
        toTeamId: "team-blue",
      }),
    );
    rerender(
      <LobbyRoster
        gameId={GAME_ID}
        joinCode={view.joinCode}
        teams={view.teams}
        players={view.players}
      />,
    );

    // Carol is now shown under Blue Team and no longer in the teamless bucket.
    const blueAfter = screen
      .getByRole("heading", { name: "Blue Team" })
      .closest("li") as HTMLElement;
    expect(within(blueAfter).getByText("Carol")).not.toBeNull();
    expect(screen.queryByText(/not on a team/i)).toBeNull();
  });
});
