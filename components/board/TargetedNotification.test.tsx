// @vitest-environment jsdom
//
// Interaction / example tests for the Targeted_Notification surface
// (Task 9.4; Requirements 7.4, 7.5, 7.6).
//
// Targeted_Notification is the inline, non-modal banner a Player on the target
// Team sees when another Team plays a targeting card. The page folds a
// `wireframe_card_played` event into a TargetedNotice and renders it through this
// presentational component, wiring `onDismiss` to its pure `dismissTargetedNotice`
// transition. These example tests pin the presentational contract:
//
//   R7.4 — the notification presents a placeholder label stating the card's
//          effect and any claiming restriction are provided by a later feature.
//   R7.5 — dismissing the notification reports the notice's producing-event `seq`
//          to `onDismiss` so the page removes exactly that notice from view.
//   R7.6 — the notification is inline and non-modal: it does not block navigation
//          or Regions. Because it participates in normal document flow (not a
//          full-screen overlay / no aria-modal), a co-rendered Region nav control
//          remains present and operable.
//
// APPROACH — render the real component, drive it with @testing-library/user-event,
// and spy on the single impure edge (`onDismiss`). `@vitest-environment jsdom`
// opts this file into a DOM (the project default is `node`).

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BoardTeamView, TargetedNotice } from "@/lib/gameboard/events";

import TargetedNotification from "./TargetedNotification";

const CASTING_TEAM: BoardTeamView = {
  id: "team-caster",
  name: "Blue Crew",
  color: "#11e",
};
const TEAMS: readonly BoardTeamView[] = [
  CASTING_TEAM,
  { id: "team-own", name: "Red Hots", color: "#e11" },
];

const NOTICE: TargetedNotice = {
  seq: 42,
  castingTeamId: CASTING_TEAM.id,
  targetTeamId: "team-own",
  cardId: "card-1",
};

function notification(): HTMLElement {
  return screen.getByRole("alert", { name: /targeted card notification/i });
}

function dismissButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /dismiss notification/i,
  }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Targeted_Notification identifies the caster and its later-feature label (R7.4)", () => {
  it("names the casting Team and shows the later-feature placeholder label", () => {
    render(
      <TargetedNotification notice={NOTICE} teams={TEAMS} onDismiss={vi.fn()} />,
    );

    const banner = notification();
    // Identifies the casting Team by name (R7.3 parity).
    expect(banner.textContent).toMatch(/blue crew/i);
    // States that the effect and any claiming restriction are a later feature.
    expect(banner.textContent).toMatch(/later feature/i);
    expect(banner.textContent).toMatch(/effect/i);
  });

  it("falls back to the casting Team id when the Team is not in the roster", () => {
    render(
      <TargetedNotification notice={NOTICE} teams={[]} onDismiss={vi.fn()} />,
    );

    // With no roster to resolve the name, the notice still identifies the caster.
    expect(notification().textContent).toContain(CASTING_TEAM.id);
  });
});

describe("Dismissing removes the notice (R7.5)", () => {
  it("reports the notice's producing-event seq to onDismiss", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <TargetedNotification notice={NOTICE} teams={TEAMS} onDismiss={onDismiss} />,
    );

    await user.click(dismissButton());

    // The page wires this to dismissTargetedNotice(view, seq); the seq is the
    // notice's stable identity, so exactly that notice is removed.
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(NOTICE.seq);
  });
});

describe("Notification does not block navigation or Regions (R7.6)", () => {
  it("is non-modal and leaves a co-rendered Region nav control operable", async () => {
    const user = userEvent.setup();
    const onNav = vi.fn();
    render(
      <div>
        <nav aria-label="Regions">
          <button type="button" onClick={onNav}>
            Bars
          </button>
        </nav>
        <TargetedNotification notice={NOTICE} teams={TEAMS} onDismiss={vi.fn()} />
      </div>,
    );

    const banner = notification();
    // It stays inline in the document flow — never a modal overlay.
    expect(banner.getAttribute("aria-modal")).toBeNull();

    // A co-rendered Region nav control remains present and operable while the
    // notification is shown.
    const navButton = screen.getByRole("button", { name: /^bars$/i });
    await user.click(navButton);
    expect(onNav).toHaveBeenCalledTimes(1);
  });
});
