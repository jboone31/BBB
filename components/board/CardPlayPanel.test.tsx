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

import type { ResolvedBarRef } from "@/lib/cards/behaviorState";
import { getCardText } from "@/lib/cards/catalog";
import type { GameEvent } from "@/lib/events";
import type { CardTargetContext } from "@/lib/gameboard/cardEligibility";
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
    expect(onConfirm).toHaveBeenCalledWith({
      targetTeamId: "team-b",
      params: { kind: "none" },
    });
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
    expect(onConfirm).toHaveBeenCalledWith({
      targetTeamId: "team-c",
      params: { kind: "none" },
    });
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
    expect(onConfirm).toHaveBeenCalledWith({ params: { kind: "none" } });
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
    expect(onConfirm).toHaveBeenCalledWith({
      targetBarId: "bar-1",
      params: { kind: "none" },
    });
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
      params: { kind: "none" },
    });
  });
});

describe("CardPlayPanel — casting input step (card-behavior R6.1-R6.3)", () => {
  it("colors: requires exactly three ROYGBIV picks and sends them as params", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a", "Alpha"),
      teamCreated(2, "team-b", "Bravo"),
    ]);
    const onConfirm = vi.fn();
    render(
      <CardPlayPanel
        card={teamCard("art-school-dropout")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const group = screen.getByRole("group", { name: /choose three colors/i });
    // With fewer than three colors, confirming warns and does not call onConfirm.
    fireEvent.click(within(group).getByRole("button", { name: /^red$/i }));
    fireEvent.click(within(group).getByRole("button", { name: /^blue$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/three colors/i);

    // A third color unlocks confirm; order is preserved, lowercased.
    fireEvent.click(within(group).getByRole("button", { name: /^green$/i }));
    // Still needs a team target before confirming (team challenge).
    fireEvent.click(
      within(
        screen.getByRole("group", { name: /choose a target team/i }),
      ).getByRole("button", { name: /bravo/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).toHaveBeenCalledWith({
      targetTeamId: "team-b",
      params: { kind: "colors", colors: ["red", "blue", "green"] },
    });
  });

  it("cuisine: sends a trimmed cuisine string as params", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a", "Alpha"),
      teamCreated(2, "team-b", "Bravo"),
    ]);
    const onConfirm = vi.fn();
    render(
      <CardPlayPanel
        card={teamCard("different-tastes")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByLabelText(/enter the cuisine/i);
    expect(input.getAttribute("maxlength")).toBe("60");
    fireEvent.change(input, { target: { value: " Italian " } });
    fireEvent.click(
      within(
        screen.getByRole("group", { name: /choose a target team/i }),
      ).getByRole("button", { name: /bravo/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).toHaveBeenCalledWith({
      targetTeamId: "team-b",
      params: { kind: "cuisine", cuisine: "Italian" },
    });
  });

  it("duration: shows m:ss, rejects over 5:00, and sends seconds as params", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a", "Alpha"),
      teamCreated(2, "team-b", "Bravo"),
    ]);
    const onConfirm = vi.fn();
    render(
      <CardPlayPanel
        card={teamCard("bird-guide")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const group = screen.getByRole("group", { name: /enter a duration/i });
    const minutes = within(group).getByLabelText(/minutes/i);
    const seconds = within(group).getByLabelText(/seconds/i);
    fireEvent.click(
      within(
        screen.getByRole("group", { name: /choose a target team/i }),
      ).getByRole("button", { name: /bravo/i }),
    );

    // 5:30 is over the 5:00 cap: confirming warns and does not play.
    fireEvent.change(minutes, { target: { value: "5" } });
    fireEvent.change(seconds, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/0:00 and 5:00/);

    // 2:05 is valid, shown as m:ss, and sent as 125 seconds.
    fireEvent.change(minutes, { target: { value: "2" } });
    fireEvent.change(seconds, { target: { value: "5" } });
    expect(group.textContent).toContain("2:05");
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).toHaveBeenCalledWith({
      targetTeamId: "team-b",
      params: { kind: "duration_seconds", seconds: 125 },
    });
  });

  it("cuisine: rejects a blank cuisine", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a", "Alpha"),
      teamCreated(2, "team-b", "Bravo"),
    ]);
    const onConfirm = vi.fn();
    render(
      <CardPlayPanel
        card={teamCard("different-tastes")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/enter the cuisine/i), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/enter a cuisine/i);
  });

  it("places the Requires text before the Confirm button in the play flow (R6.6)", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a", "Alpha"),
      teamCreated(2, "team-b", "Bravo"),
    ]);
    render(
      <CardPlayPanel
        card={teamCard("art-school-dropout")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const requires = screen.getByText(/requires:/i);
    expect(requires.textContent).toContain(
      getCardText("art-school-dropout").requires,
    );
    const confirm = screen.getByRole("button", { name: /^confirm$/i });
    expect(
      requires.compareDocumentPosition(confirm) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the card's Requires text above Confirm", () => {
    const view = foldGameBoardEvents(GAME, [teamCreated(1, "team-a", "Alpha")]);
    render(
      <CardPlayPanel
        card={teamCard("crop-dusting")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        bars={BARS}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/requires:/i).textContent).toMatch(
      /inside the bar you target/i,
    );
  });
});

describe("CardPlayPanel — Pioneer no_legal_next_bar row (R10.12, R22.5)", () => {
  function teamCardFor(slug: string, team: string): BoardCardView {
    return { cardId: `${team}:${slug}`, teamId: team, slug, state: "hand" };
  }

  // Two scoring bars, both claimed by Charlie: under Pioneer, Bravo's next bar
  // must be unclaimed by another team, so Bravo has no Legal_Next_Bar.
  function blockedContext(
    restrictions: ReadonlyMap<
      string,
      readonly ("pioneer" | "scenic")[]
    > = new Map(),
  ): CardTargetContext {
    const start: ResolvedBarRef = { barKey: "", kind: "start", coords: null };
    return {
      finishBarKey: null,
      barCoords: new Map([
        ["bar-1", { lat: 33.78, lng: -84.37 }],
        ["bar-2", { lat: 33.77, lng: -84.36 }],
      ]),
      claimState: { "bar-1": ["team-c"], "bar-2": ["team-c"] },
      teamIds: ["team-a", "team-b", "team-c"],
      previousBars: new Map([
        ["team-a", start],
        ["team-b", start],
        ["team-c", start],
      ]),
      restrictions,
    };
  }

  function pioneerView() {
    return foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a", "Alpha"),
      teamCreated(2, "team-b", "Bravo"),
      teamCreated(3, "team-c", "Charlie"),
    ]);
  }

  it("grays a team with no legal next bar, labels why, and keeps it keyboard-focusable", () => {
    const view = pioneerView();
    const onConfirm = vi.fn();
    render(
      <CardPlayPanel
        card={teamCardFor("pioneer", "team-a")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        targetContext={blockedContext()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const group = screen.getByRole("group", { name: /choose a target team/i });
    const bravo = within(group).getByRole("button", { name: /bravo/i });
    // Grayed via aria-disabled but NOT natively disabled, so it stays focusable.
    expect(bravo.getAttribute("aria-disabled")).toBe("true");
    expect((bravo as HTMLButtonElement).disabled).toBe(false);
    expect(bravo.textContent).toMatch(/no legal next bar for this team/i);
    expect(bravo.textContent).toMatch(/under pioneer/i);
    bravo.focus();
    expect(document.activeElement).toBe(bravo);

    // Selecting it is a no-op; confirming warns instead of playing.
    fireEvent.click(bravo);
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/eligible target/i);
  });

  it("lists the existing restriction alongside the played rule (Scenic onto a Pioneer'd team)", () => {
    const view = pioneerView();
    render(
      <CardPlayPanel
        card={teamCardFor("scenic-route", "team-a")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        targetContext={blockedContext(new Map([["team-b", ["pioneer"]]]))}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const group = screen.getByRole("group", { name: /choose a target team/i });
    const bravo = within(group).getByRole("button", { name: /bravo/i });
    expect(bravo.getAttribute("aria-disabled")).toBe("true");
    expect(bravo.textContent).toMatch(/no legal next bar for this team/i);
    expect(bravo.textContent).toMatch(/under pioneer/i);
    expect(bravo.textContent).toMatch(/under scenic route/i);
  });

  it("leaves every team eligible when the bare finish-bar context is used", () => {
    const view = pioneerView();
    render(
      <CardPlayPanel
        card={teamCardFor("pioneer", "team-a")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const group = screen.getByRole("group", { name: /choose a target team/i });
    const bravo = within(group).getByRole("button", { name: /bravo/i });
    expect(bravo.getAttribute("aria-disabled")).toBe("false");
  });

  it("surfaces a server no_legal_next_bar rejection inline near the picker", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a", "Alpha"),
      teamCreated(2, "team-b", "Bravo"),
    ]);
    render(
      <CardPlayPanel
        card={teamCardFor("pioneer", "team-a")}
        view={view}
        teams={view.teams}
        castingTeamId="team-a"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        serverError={{ reason: "no_legal_next_bar", rules: ["pioneer"] }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/no legal next bar for this team/i);
    expect(alert.textContent).toMatch(/under pioneer/i);
  });
});
