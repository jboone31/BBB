// @vitest-environment jsdom
//
// Cards_Region component tests (brawl-deck-architecture Task 6; R1.1, R1.2,
// R2.1, R2.3, R2.4).
//
// The component renders the current team's REAL cards from the folded projection
// and reports keep/discard/play intent to callbacks. These tests assert:
//   - a pending draw surfaces the two drawn cards by their catalog name, each
//     with a Keep control, and keeping reports exactly that card (keeping one
//     discards the other — enforced server-side);
//   - the held hand renders with Play + Discard controls;
//   - a full hand while a draw is pending prompts the player to play/discard
//     first and disables the Keep controls (R2.4);
//   - admin-not-player sees no hand.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getCardMetadata, getCardText } from "@/lib/cards/catalog";
import type { BoardCardView } from "@/lib/gameboard/events";

import CardsRegion from "./CardsRegion";

afterEach(cleanup);

const TEAM = "team-a";

function card(slug: string, state: BoardCardView["state"]): BoardCardView {
  return { cardId: `${TEAM}:${slug}`, teamId: TEAM, slug, state };
}

function renderRegion(
  overrides: Partial<React.ComponentProps<typeof CardsRegion>> = {},
) {
  const onKeepCard = vi.fn();
  const onDiscardCard = vi.fn();
  const onPlayCard = vi.fn();
  render(
    <CardsRegion
      cards={[]}
      adminNotPlayer={false}
      onKeepCard={onKeepCard}
      onDiscardCard={onDiscardCard}
      onPlayCard={onPlayCard}
      {...overrides}
    />,
  );
  return { onKeepCard, onDiscardCard, onPlayCard };
}

describe("CardsRegion — pending draw choice (R1.1, R1.2)", () => {
  it("shows the two drawn cards by catalog name, each with a Keep control", () => {
    renderRegion({
      cards: [card("go-piss-girl", "pending"), card("moneybags", "pending")],
    });

    const group = screen.getByRole("group", { name: /choose a card to keep/i });
    const nameA = getCardMetadata("go-piss-girl").name;
    const nameB = getCardMetadata("moneybags").name;
    expect(within(group).getByText(nameA)).toBeTruthy();
    expect(within(group).getByText(nameB)).toBeTruthy();
    expect(
      within(group).getByRole("button", {
        name: new RegExp(`keep ${nameA}`, "i"),
      }),
    ).toBeTruthy();
    expect(
      within(group).getByRole("button", {
        name: new RegExp(`keep ${nameB}`, "i"),
      }),
    ).toBeTruthy();
  });

  it("keeping a card reports exactly that card (server discards the other)", () => {
    const { onKeepCard } = renderRegion({
      cards: [card("go-piss-girl", "pending"), card("moneybags", "pending")],
    });
    const nameA = getCardMetadata("go-piss-girl").name;
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`keep ${nameA}`, "i") }),
    );
    expect(onKeepCard).toHaveBeenCalledTimes(1);
    expect(onKeepCard.mock.calls[0][0].cardId).toBe(`${TEAM}:go-piss-girl`);
  });
});

describe("CardsRegion — held hand (R2.1, R2.3)", () => {
  it("renders held cards with Play and Discard controls", () => {
    const { onPlayCard, onDiscardCard } = renderRegion({
      cards: [card("wired", "hand")],
    });
    const name = getCardMetadata("wired").name;
    const hand = screen.getByRole("list", { name: /your hand/i });
    expect(within(hand).getByText(name)).toBeTruthy();

    fireEvent.click(
      within(hand).getByRole("button", {
        name: new RegExp(`play ${name}`, "i"),
      }),
    );
    expect(onPlayCard).toHaveBeenCalledTimes(1);

    fireEvent.click(
      within(hand).getByRole("button", {
        name: new RegExp(`discard ${name}`, "i"),
      }),
    );
    expect(onDiscardCard).toHaveBeenCalledTimes(1);
  });

  it("shows an empty-hand hint when the team holds no cards", () => {
    renderRegion({ cards: [] });
    expect(screen.getByText(/no cards in hand/i)).toBeTruthy();
  });
});

describe("CardsRegion — hand inspection and card detail (R2.2)", () => {
  it("selecting a held card reveals its name, description, and target requirement", () => {
    // voted-off-the-island is team_and_bar: it carries a target requirement.
    renderRegion({ cards: [card("voted-off-the-island", "hand")] });
    const name = getCardMetadata("voted-off-the-island").name;
    const text = getCardText("voted-off-the-island");

    // The detail is collapsed by default.
    expect(screen.queryByText(text.description)).toBeNull();

    // Selecting the card name expands its detail panel.
    const toggle = screen.getByRole("button", {
      name: new RegExp(`${name} details`, "i"),
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const detail = screen.getByRole("group", {
      name: new RegExp(`${name} details`, "i"),
    });
    expect(detail.textContent).toContain(text.description);
    // The target-team challenge is shown under "Target must:".
    expect(text.targetRequirement).not.toBeNull();
    expect(detail.textContent).toMatch(/Target must:/i);
  });

  it("shows the casting requirement under 'To play:' for a card that needs a casting input", () => {
    // art-school-dropout has a casting input, so it carries a casting requirement.
    renderRegion({ cards: [card("art-school-dropout", "hand")] });
    const name = getCardMetadata("art-school-dropout").name;
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`${name} details`, "i") }),
    );
    const detail = screen.getByRole("group", {
      name: new RegExp(`${name} details`, "i"),
    });
    expect(detail.textContent).toMatch(/To play:/i);
  });

  it("shows an 'applies on its own' note for a card with no requirements", () => {
    renderRegion({ cards: [card("insurance", "hand")] });
    const name = getCardMetadata("insurance").name;
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`${name} details`, "i") }),
    );
    expect(screen.getByText(/applies on its own/i)).toBeTruthy();
  });

  it("collapses the detail when the card is selected again", () => {
    renderRegion({ cards: [card("wired", "hand")] });
    const name = getCardMetadata("wired").name;
    const toggle = screen.getByRole("button", {
      name: new RegExp(`${name} details`, "i"),
    });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(getCardText("wired").description)).toBeNull();
  });
});

describe("CardsRegion — hand full while a draw is pending (R2.4)", () => {
  it("prompts to play/discard first and disables the Keep controls", () => {
    renderRegion({
      cards: [
        card("wired", "hand"),
        card("moneybags", "hand"),
        card("go-piss-girl", "pending"),
      ],
    });

    // Explicit hand-full prompt.
    expect(screen.getByRole("alert").textContent).toMatch(/hand is full/i);

    // The Keep control is present but disabled until a slot is freed.
    const pendingName = getCardMetadata("go-piss-girl").name;
    const keep = screen.getByRole("button", {
      name: new RegExp(`keep ${pendingName}`, "i"),
    });
    expect((keep as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("CardsRegion — admin-not-player (R5.4)", () => {
  it("renders an explanation and no hand or controls", () => {
    renderRegion({ adminNotPlayer: true, cards: [card("wired", "hand")] });
    expect(screen.getByText(/a hand belongs to players/i)).toBeTruthy();
    expect(screen.queryByRole("list", { name: /your hand/i })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
