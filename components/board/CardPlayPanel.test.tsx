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

const BARS = [
  { id: "bar-1", name: "Park Tavern" },
  { id: "bar-2", name: "The Independent" },
  { id: "bar-3", name: "Finish Bar" },
];

describe("CardPlayPanel — bar targeting + eligibility (R3.4, R3.5)", () => {
  it("lists bars with claim state, grays out the finish bar, and reports the chosen bar", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a", "Alpha"),
      teamCreated(2, "team-b", "Bravo"),
    ]);
    const onConfirm = vi.fn();
    render(
      <CardPlayPanel
        card={teamCard("happy-hour")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        bars={BARS}
        claims={{ "bar-1": ["team-b"] }}
        finishBarId="bar-3"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const group = screen.getByRole("group", { name: /choose a target bar/i });
    // No team group for a bar-only card.
    expect(
      screen.queryByRole("group", { name: /choose a target team/i }),
    ).toBeNull();

    // The finish bar is disabled.
    const finish = within(group).getByRole("button", { name: /finish bar/i });
    expect((finish as HTMLButtonElement).disabled).toBe(true);

    // Claim state is shown (bar-1 is claimed by Bravo).
    expect(group.textContent).toMatch(/claimed by Bravo/i);

    // An eligible bar is selectable and reported.
    fireEvent.click(
      within(group).getByRole("button", { name: /park tavern/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).toHaveBeenCalledWith({ targetBarId: "bar-1" });
  });

  it("requires a bar before confirming a bar-targeting card", () => {
    const view = foldGameBoardEvents(GAME, [teamCreated(1, "team-a", "Alpha")]);
    const onConfirm = vi.fn();
    render(
      <CardPlayPanel
        card={teamCard("happy-hour")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        bars={BARS}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/target bar/i);
  });
});

describe("CardPlayPanel — team-and-bar ordering (R3.6)", () => {
  it("prompts for the bar first, reveals the team step only after a bar is chosen, then reports both", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a", "Alpha"),
      teamCreated(2, "team-b", "Bravo"),
      teamCreated(3, "team-c", "Charlie"),
    ]);
    const onConfirm = vi.fn();
    render(
      <CardPlayPanel
        card={teamCard("voted-off-the-island")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        bars={BARS}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    // The bar step shows first; the team step is NOT yet present (R3.6).
    expect(
      screen.getByRole("group", { name: /choose a target bar/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("group", { name: /choose a target team/i }),
    ).toBeNull();

    // Choosing a bar reveals the team step.
    fireEvent.click(screen.getByRole("button", { name: /park tavern/i }));
    const teamGroup = screen.getByRole("group", {
      name: /choose a target team/i,
    });
    expect(teamGroup).toBeTruthy();

    // Choosing a team then confirming reports both targets.
    fireEvent.click(within(teamGroup).getByRole("button", { name: /bravo/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).toHaveBeenCalledWith({
      targetBarId: "bar-1",
      targetTeamId: "team-b",
    });
  });
});
