// @vitest-environment jsdom
//
// Interaction / example tests for the Card_Play_Wireframe surface
// (Task 9.4; Requirements 6.1, 6.3, 6.4, 6.5, 6.6, 6.7).
//
// Card_Play_Wireframe is the placeholder play-a-card flow. It is *presented on
// play* (R6.1 — the Cards_Region renders it when a Player activates a card's play
// control) and owns only the transient in-flight selection/acknowledgement
// state, delegating the real work to `onConfirm` / `onCancel`. These example
// tests pin the presentational contract the board page relies on:
//
//   R6.1 — presenting the wireframe renders the play dialog for the card.
//   R6.3 — a non-targeting card omits target selection and shows confirm directly.
//   R6.4 — selecting a target reveals a confirmation naming the selected Team.
//   R6.5 — confirming a targeting card with no target selected shows "target
//          required" and does NOT complete the play (onConfirm is not called).
//   R6.6 — confirming shows a wireframe acknowledgement and enforces nothing;
//          for a targeting card the chosen targetTeamId is handed to onConfirm.
//   R6.7 — cancel dismisses via onCancel and leaves the Region unchanged
//          (onConfirm is not called).
//
// APPROACH — render the real component, drive it with @testing-library/user-event
// (real click semantics), and spy on the two impure edges (`onConfirm` /
// `onCancel`). No router/fetch needed: this component delegates the real POST to
// the page. `@vitest-environment jsdom` opts this file into a DOM (the project
// default is `node`).

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BoardTeamView } from "@/lib/gameboard/events";
import type { PlaceholderCard } from "@/lib/gameboard/placeholderCards";

import CardPlayWireframe from "./CardPlayWireframe";

/** A small fixed roster: the caller's own Team plus two other Teams. */
const OWN_TEAM: BoardTeamView = { id: "team-own", name: "Red Hots", color: "#e11" };
const OTHER_A: BoardTeamView = { id: "team-a", name: "Blue Crew", color: "#11e" };
const OTHER_B: BoardTeamView = { id: "team-b", name: "Green Machine", color: "#1a1" };
const TEAMS: readonly BoardTeamView[] = [OWN_TEAM, OTHER_A, OTHER_B];

const TARGETING_CARD: PlaceholderCard = {
  id: "card-targeting",
  label: "Detour",
  targetsTeam: true,
};
const NON_TARGETING_CARD: PlaceholderCard = {
  id: "card-nontargeting",
  label: "Head Start",
  targetsTeam: false,
};

/** The wireframe dialog (root role="dialog", aria-label="Play card"). */
function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: /play card/i });
}

function confirmButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^confirm$/i }) as HTMLButtonElement;
}

function cancelButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^cancel$/i }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Card_Play_Wireframe presents the play dialog (R6.1)", () => {
  it("renders the play dialog naming the card when presented", () => {
    render(
      <CardPlayWireframe
        card={TARGETING_CARD}
        teams={TEAMS}
        ownTeamId={OWN_TEAM.id}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const region = dialog();
    expect(region).not.toBeNull();
    // The dialog names the card being played.
    expect(region.textContent).toMatch(/detour/i);
  });
});

describe("Non-targeting card omits target selection and shows confirm (R6.3)", () => {
  it("shows the confirm control directly with no target group", () => {
    render(
      <CardPlayWireframe
        card={NON_TARGETING_CARD}
        teams={TEAMS}
        ownTeamId={OWN_TEAM.id}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // No target-selection group is rendered for a non-targeting card.
    expect(
      screen.queryByRole("group", { name: /choose a target team/i }),
    ).toBeNull();
    // The confirm control is present and directly operable.
    expect(confirmButton()).not.toBeNull();
  });

  it("confirming a non-targeting card completes with no target (R6.6)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <CardPlayWireframe
        card={NON_TARGETING_CARD}
        teams={TEAMS}
        ownTeamId={OWN_TEAM.id}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    await user.click(confirmButton());

    // onConfirm is called exactly once with no target team id (undefined).
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(undefined);
    // A wireframe acknowledgement is shown (role="status") that enforces nothing.
    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(/wireframe|enforces no|placeholder/i);
  });
});

describe("Selecting a target shows a naming confirmation (R6.4)", () => {
  it("lists the other Teams and names the one selected", async () => {
    const user = userEvent.setup();
    render(
      <CardPlayWireframe
        card={TARGETING_CARD}
        teams={TEAMS}
        ownTeamId={OWN_TEAM.id}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const group = screen.getByRole("group", { name: /choose a target team/i });
    // The own Team is excluded; the two other Teams are offered as options.
    expect(within(group).queryByRole("button", { name: /red hots/i })).toBeNull();
    const blue = within(group).getByRole("button", { name: /blue crew/i });
    within(group).getByRole("button", { name: /green machine/i });

    // Before selection there is no naming confirmation.
    expect(screen.queryByRole("status")).toBeNull();

    await user.click(blue);

    // A confirmation names the selected Team.
    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(/blue crew/i);
  });
});

describe("Confirm without a target shows 'target required' (R6.5)", () => {
  it("shows an alert and does not complete the play", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <CardPlayWireframe
        card={TARGETING_CARD}
        teams={TEAMS}
        ownTeamId={OWN_TEAM.id}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    // No alert before confirming.
    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(confirmButton());

    // A "target required" indication appears…
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/target is required|target required/i);
    // …and the play is NOT completed.
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("Confirming a targeting card completes with the target (R6.6)", () => {
  it("hands the chosen targetTeamId to onConfirm and shows an acknowledgement", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <CardPlayWireframe
        card={TARGETING_CARD}
        teams={TEAMS}
        ownTeamId={OWN_TEAM.id}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const group = screen.getByRole("group", { name: /choose a target team/i });
    await user.click(within(group).getByRole("button", { name: /green machine/i }));
    await user.click(confirmButton());

    // The chosen target Team id is delivered to the page for the POST.
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(OTHER_B.id);
    // A wireframe acknowledgement is shown; the component enforces nothing.
    const statuses = screen.getAllByRole("status");
    const ack = statuses.find((el) =>
      /wireframe|enforces no|placeholder/i.test(el.textContent ?? ""),
    );
    expect(ack).toBeTruthy();
  });
});

describe("Cancel dismisses and leaves the Region unchanged (R6.7)", () => {
  it("calls onCancel and never calls onConfirm", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CardPlayWireframe
        card={TARGETING_CARD}
        teams={TEAMS}
        ownTeamId={OWN_TEAM.id}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.click(cancelButton());

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
