// @vitest-environment jsdom
//
// Card_Play_Panel component tests (brawl-deck-architecture Task 8; R3.1, R3.2,
// R3.3). The panel lists target teams, grays out + disables ineligible ones
// (own team excluded; same-card-already-targeted disabled), and reports the
// chosen target to onConfirm.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GameEvent } from "@/lib/events";
import { foldGameBoardEvents } from "@/lib/gameboard/events";
import type { BoardCardView } from "@/lib/gameboard/events";

import CardPlayPanel from "./CardPlayPanel";

afterEach(cleanup);

const GAME = "game-1";

function teamCreated(seq: number, id: string, name: string): GameEvent {
  return {
    id: `e-${seq}`,
    gameId: GAME,
    seq,
    eventType: "team_created",
    actorKind: "admin",
    actorTeamId: null,
    payload: { teamId: id, name, color: "#336699" },
    createdAt: new Date(seq).toISOString(),
  };
}

function cardPlayed(
  seq: number,
  slug: string,
  caster: string,
  target: string,
): GameEvent {
  return {
    id: `e-${seq}`,
    gameId: GAME,
    seq,
    eventType: "card_played",
    actorKind: "team",
    actorTeamId: caster,
    payload: { castingTeamId: caster, slug, targetTeamId: target },
    createdAt: new Date(seq).toISOString(),
  };
}

function teamCard(slug: string): BoardCardView {
  return { cardId: `team-a:${slug}`, teamId: "team-a", slug, state: "hand" };
}

describe("CardPlayPanel — team targeting + eligibility (R3.2, R3.3)", () => {
  it("lists other teams, excludes own team, and reports the chosen target", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a", "Alpha"),
      teamCreated(2, "team-b", "Bravo"),
      teamCreated(3, "team-c", "Charlie"),
    ]);
    const onConfirm = vi.fn();
    render(
      <CardPlayPanel
        card={teamCard("go-piss-girl")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const group = screen.getByRole("group", { name: /choose a target team/i });
    // Own team (Alpha) is excluded; Bravo and Charlie are offered.
    expect(within(group).queryByText("Alpha")).toBeNull();
    const bravo = within(group).getByRole("button", { name: /bravo/i });
    expect((bravo as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(bravo);
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).toHaveBeenCalledWith({ targetTeamId: "team-b" });
  });

  it("grays out and disables a team already targeted by the same card (R3.3)", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a", "Alpha"),
      teamCreated(2, "team-b", "Bravo"),
      teamCreated(3, "team-c", "Charlie"),
      // Alpha already played go-piss-girl on Bravo.
      cardPlayed(4, "go-piss-girl", "team-a", "team-b"),
    ]);
    const onConfirm = vi.fn();
    render(
      <CardPlayPanel
        card={teamCard("go-piss-girl")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const group = screen.getByRole("group", { name: /choose a target team/i });
    const bravo = within(group).getByRole("button", { name: /bravo/i });
    expect((bravo as HTMLButtonElement).disabled).toBe(true);
    expect(bravo.getAttribute("aria-disabled")).toBe("true");

    // Clicking the disabled team selects nothing; confirming warns.
    fireEvent.click(bravo);
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/eligible target/i);

    // Charlie (not yet targeted) is still selectable.
    fireEvent.click(within(group).getByRole("button", { name: /charlie/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).toHaveBeenCalledWith({ targetTeamId: "team-c" });
  });

  it("requires a target before confirming a team-targeting card", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a", "Alpha"),
      teamCreated(2, "team-b", "Bravo"),
    ]);
    const onConfirm = vi.fn();
    render(
      <CardPlayPanel
        card={teamCard("go-piss-girl")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("confirms a no-target card without a target team", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a", "Alpha"),
      teamCreated(2, "team-b", "Bravo"),
    ]);
    const onConfirm = vi.fn();
    render(
      <CardPlayPanel
        card={teamCard("power-hour")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    // No target group for a no-target card.
    expect(
      screen.queryByRole("group", { name: /choose a target team/i }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).toHaveBeenCalledWith({});
  });
});
