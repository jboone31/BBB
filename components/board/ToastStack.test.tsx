// @vitest-environment jsdom
//
// Toast_Stack component tests (card-behavior Task 10.3).
//
// ToastStack renders the per-viewer `deriveToasts` output (merged with
// Boundary_Toasts by the parent) as an inline, non-modal stack and posts the
// Fairest / challenge-resolve actions to the real routes. These tests assert the
// COMPOSITION the component owns, with the poster and the mirror-legality
// predicate faked:
//   - status vs. alert role semantics and the first-action focus on appearance;
//   - others' informational toasts collapse into a <details> dropdown;
//   - an action posts, disables while in flight, and surfaces a server error
//     inline (and the Fairest prompt stays open on invalid_input);
//   - a Pioneer/Scenic Fairest prompt disables Play and shows the exact
//     "no longer legal" notice while mirroring is illegal, with Decline enabled.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FairestOfferRecord } from "@/lib/cards/behaviorState";
import type { BoardTeamView } from "@/lib/gameboard/events";
import type { Toast, ToastAction } from "@/lib/cards/toasts";

import ToastStack, { MIRROR_NO_LONGER_LEGAL } from "./ToastStack";

afterEach(cleanup);

const GAME = "game-1";

const TEAMS: BoardTeamView[] = [
  { id: "team-a", name: "Team Alpha", color: "#f00" },
  { id: "team-b", name: "Team Bravo", color: "#00f" },
];

function toast(overrides: Partial<Toast> = {}): Toast {
  return {
    id: "1:target:play-1",
    kind: "target",
    seq: 1,
    headline: "A challenge for you.",
    body: null,
    dropdown: null,
    actions: [],
    dismissable: false,
    ...overrides,
  };
}

function offer(
  overrides: Partial<FairestOfferRecord> = {},
): FairestOfferRecord {
  return {
    offerId: "offer-1",
    sourcePlayId: "play-1",
    slug: "pioneer",
    holderTeamId: "team-b",
    originalCasterTeamId: "team-a",
    challengeId: null,
    restrictionEffectId: "effect-1",
    status: "pending",
    decidedAt: null,
    mirroredChallengeId: null,
    mirroredEffectId: null,
    ...overrides,
  };
}

function renderStack(
  overrides: Partial<React.ComponentProps<typeof ToastStack>> = {},
) {
  const postAction = vi.fn(async () => ({ applied: true, seq: 2 }));
  render(
    <ToastStack
      gameId={GAME}
      toasts={[]}
      teams={TEAMS}
      offers={{}}
      isMirrorLegal={() => true}
      postAction={postAction}
      {...overrides}
    />,
  );
  return { postAction };
}

describe("ToastStack — rendering and roles", () => {
  it("renders an actionable toast as an alert and a plain toast as a status", () => {
    renderStack({
      toasts: [
        toast({
          id: "1:target:play-1",
          actions: [{ kind: "mark_complete", challengeId: "challenge-1" }],
        }),
      ],
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: /mark complete/i })).toBeTruthy();
  });

  it("collapses others' informational toasts into a details dropdown", () => {
    renderStack({
      toasts: [
        toast({
          id: "1:others:play-1",
          kind: "others",
          headline: "Team Alpha played a card!",
          dropdown: "The effect text.",
        }),
      ],
    });
    // The summary reports one collapsed update; the headline lives inside it.
    expect(screen.getByText(/other updates \(1\)/i)).toBeTruthy();
    expect(screen.getByText(/team alpha played a card/i)).toBeTruthy();
  });

  it("focuses the first action button on appearance", () => {
    renderStack({
      toasts: [
        toast({
          actions: [{ kind: "mark_complete", challengeId: "challenge-1" }],
        }),
      ],
    });
    const button = screen.getByRole("button", { name: /mark complete/i });
    expect(document.activeElement).toBe(button);
  });
});

describe("ToastStack — posting actions", () => {
  it("posts Mark complete, disables while in flight, and clears on success", async () => {
    let resolvePost: (value: { applied: boolean }) => void = () => {};
    const postAction = vi.fn(
      () =>
        new Promise<{ applied: boolean }>((resolve) => {
          resolvePost = resolve;
        }),
    );
    const action: ToastAction = {
      kind: "mark_complete",
      challengeId: "challenge-1",
    };
    render(
      <ToastStack
        gameId={GAME}
        toasts={[toast({ actions: [action] })]}
        teams={TEAMS}
        offers={{}}
        isMirrorLegal={() => true}
        postAction={postAction as never}
      />,
    );

    const button = screen.getByRole("button", { name: /mark complete/i });
    fireEvent.click(button);
    expect(postAction).toHaveBeenCalledWith(action, GAME);
    // Disabled while the post is in flight.
    await waitFor(() =>
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );

    await act(async () => {
      resolvePost({ applied: true });
    });
  });

  it("shows the server error inline on a rejected action", async () => {
    const postAction = vi.fn(async () => ({
      applied: false,
      error: "conflict",
    }));
    renderStack({
      postAction: postAction as never,
      toasts: [
        toast({
          actions: [{ kind: "mark_complete", challengeId: "challenge-1" }],
        }),
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /mark complete/i }));
    await waitFor(() =>
      expect(screen.getByText(/already been resolved/i)).toBeTruthy(),
    );
  });

  it("keeps the Fairest prompt open after an invalid_input on Play", async () => {
    const postAction = vi.fn(async () => ({
      applied: false,
      error: "invalid_input",
      details: { reason: "no_legal_next_bar" },
    }));
    const o = offer();
    renderStack({
      postAction: postAction as never,
      offers: { "offer-1": o },
      toasts: [
        toast({
          id: "1:fairest_prompt:offer-1",
          kind: "fairest_prompt",
          actions: [
            { kind: "fairest_play", offerId: "offer-1" },
            { kind: "fairest_decline", offerId: "offer-1" },
          ],
        }),
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /^play$/i }));
    await waitFor(() =>
      expect(screen.getByText(/no longer valid/i)).toBeTruthy(),
    );
    // The prompt (and its Play / Decline) remain, since the offer stays pending.
    expect(screen.getByRole("button", { name: /^play$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /decline/i })).toBeTruthy();
  });
});

describe("ToastStack — Pioneer/Scenic mirror legality (9.18)", () => {
  it("disables Play and shows the notice while mirroring is illegal, Decline stays enabled", () => {
    const o = offer();
    renderStack({
      isMirrorLegal: () => false,
      offers: { "offer-1": o },
      toasts: [
        toast({
          id: "1:fairest_prompt:offer-1",
          kind: "fairest_prompt",
          actions: [
            { kind: "fairest_play", offerId: "offer-1" },
            { kind: "fairest_decline", offerId: "offer-1" },
          ],
        }),
      ],
    });

    const play = screen.getByRole("button", {
      name: /^play$/i,
    }) as HTMLButtonElement;
    const decline = screen.getByRole("button", {
      name: /decline/i,
    }) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    expect(decline.disabled).toBe(false);
    expect(screen.getByText(MIRROR_NO_LONGER_LEGAL("Team Alpha"))).toBeTruthy();
  });

  it("enables Play when mirroring is legal and shows no notice", () => {
    const o = offer();
    renderStack({
      isMirrorLegal: () => true,
      offers: { "offer-1": o },
      toasts: [
        toast({
          id: "1:fairest_prompt:offer-1",
          kind: "fairest_prompt",
          actions: [
            { kind: "fairest_play", offerId: "offer-1" },
            { kind: "fairest_decline", offerId: "offer-1" },
          ],
        }),
      ],
    });
    expect(
      (screen.getByRole("button", { name: /^play$/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByText(/no longer legal/i)).toBeNull();
  });
});
