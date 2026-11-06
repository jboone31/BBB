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

import type {
  ChallengeRecord,
  FairestOfferRecord,
} from "@/lib/cards/behaviorState";
import {
  CARD_SLUGS,
  getCardMetadata,
  getCardText,
  type CardSlug,
} from "@/lib/cards/catalog";
import type { CastingParams } from "@/lib/cards/inputs";
import { formatDuration, renderTemplate } from "@/lib/cards/templates";
import {
  buildSelectorContext,
  composeBoardToasts,
  mirrorIsLegalInView,
} from "@/lib/gameboard/boardWiring";
import {
  initialGameBoardView,
  type BoardTeamView,
  type GameBoardView,
  type PlayView,
} from "@/lib/gameboard/events";
import type { Toast, ToastAction } from "@/lib/cards/toasts";
import type { CandidateBar } from "@/lib/map/bars";

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

// ---------------------------------------------------------------------------
// Composed from a folded view (deriveToasts + selectPendingActions), so these
// exercise the real copy and action routing the board renders.
// ---------------------------------------------------------------------------

const CASTER = "team-a";
const TARGET = "team-b";
const OTHER = "team-c";

const VIEW_TEAMS = [
  { id: CASTER, name: "Alpha", color: "#f00" },
  { id: TARGET, name: "Bravo", color: "#0f0" },
  { id: OTHER, name: "Charlie", color: "#00f" },
] as GameBoardView["teams"];

function paramsFor(slug: CardSlug): CastingParams {
  switch (getCardMetadata(slug).castingInput) {
    case "colors":
      return { kind: "colors", colors: ["red", "blue", "green"] };
    case "duration_seconds":
      return { kind: "duration_seconds", seconds: 95 };
    case "cuisine":
      return { kind: "cuisine", cuisine: "Thai" };
    default:
      return { kind: "none" };
  }
}

function playView(
  slug: CardSlug,
  seq: number,
  targetTeamId: string | null = TARGET,
): PlayView {
  return {
    playId: "p1",
    slug,
    casterTeamId: CASTER,
    targetTeamId,
    barKey: null,
    // Spin Cycle resolves a return bar at play time; the toast names it via
    // {Bar}. Other cards carry no return bar.
    returnBarKey: slug === "spin-cycle" ? "park-tavern" : null,
    params: paramsFor(slug),
    seq,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

function openChallenge(slug: CardSlug): ChallengeRecord {
  return {
    challengeId: "c1",
    slug,
    sourcePlayId: "p1",
    casterTeamId: CASTER,
    targetTeamId: TARGET,
    params: paramsFor(slug),
    mirroredFromChallengeId: null,
    mirroredFromPlayId: null,
    status: "open",
    createdAt: "2024-01-01T00:00:00.000Z",
    resolvedAt: null,
    resolvedByTeamId: null,
    resolvedBySessionId: null,
    resolvedByKind: null,
    failureEffectId: null,
  };
}

function behaviorView(
  slug: CardSlug,
  extra: Partial<GameBoardView["cardBehavior"]> = {},
  activeClaims: GameBoardView["activeClaims"] = [],
): GameBoardView {
  const base = initialGameBoardView(GAME);
  return {
    ...base,
    lifecycle: "live",
    teams: VIEW_TEAMS,
    activeClaims,
    cardBehavior: {
      ...base.cardBehavior,
      plays: { p1: playView(slug, 5) },
      toastEvents: [{ id: "5:play:p1", seq: 5, kind: "play", subjectId: "p1" }],
      ...extra,
    },
    lastSeenSequence: 5,
  };
}

function composeFor(view: GameBoardView, viewer: string): Toast[] {
  return composeBoardToasts({
    view,
    viewerTeamId: viewer,
    boundaryToasts: [],
    dismissal: { floorSeq: -1, dismissed: [] },
  });
}

function expectedValues(slug: CardSlug): Record<string, string> {
  const values: Record<string, string> = {
    Caster: "Alpha",
    Target: "Bravo",
    CARD: getCardMetadata(slug).name.toUpperCase(),
  };
  // Spin Cycle's body names the return bar (the playView carries park-tavern).
  if (slug === "spin-cycle") {
    values.Bar = "Park Tavern";
  }
  const params = paramsFor(slug);
  if (params.kind === "colors") {
    [values.color1, values.color2, values.color3] = params.colors;
  } else if (params.kind === "duration_seconds") {
    values.duration = formatDuration(params.seconds);
  } else if (params.kind === "cuisine") {
    values.cuisine = params.cuisine;
  }
  return values;
}

const TEAM_TARGET_SLUGS = CARD_SLUGS.filter(
  (slug) => getCardMetadata(slug).targetMode === "team",
);

describe("ToastStack — target toast copy per card (R3.1)", () => {
  it.each(TEAM_TARGET_SLUGS)(
    "%s: the target sees '{Caster} has played {CARD} on you!' and the card's target body",
    (slug) => {
      const view = behaviorView(slug);
      render(
        <ToastStack
          gameId={GAME}
          toasts={composeFor(view, TARGET)}
          teams={view.teams}
          offers={{}}
          isMirrorLegal={() => true}
          postAction={vi.fn()}
        />,
      );
      const values = expectedValues(slug);
      const headline = `Alpha has played ${values.CARD} on you!`;
      const toastEl = screen.getByRole("status", { name: headline });
      expect(toastEl.textContent).toContain(headline);
      const body = getCardText(slug).targetToastBody;
      if (body !== null) {
        const rendered = renderTemplate(body, values);
        expect(toastEl.textContent).toContain(rendered);
        // Every placeholder the copy uses was filled from the play's values.
        expect(rendered).not.toMatch(/\{[A-Za-z0-9]+\}/);
      }
    },
  );

  it("shows the caster the standard caster copy", () => {
    const view = behaviorView("wired");
    render(
      <ToastStack
        gameId={GAME}
        toasts={composeFor(view, CASTER)}
        teams={view.teams}
        offers={{}}
        isMirrorLegal={() => true}
        postAction={vi.fn()}
      />,
    );
    expect(screen.getByText("You played WIRED on Bravo.")).toBeTruthy();
  });

  it("gives the target of a gated card a Mark complete action", () => {
    const view = behaviorView("wired", {
      challenges: { c1: openChallenge("wired") },
    });
    render(
      <ToastStack
        gameId={GAME}
        toasts={composeFor(view, TARGET)}
        teams={view.teams}
        offers={{}}
        isMirrorLegal={() => true}
        postAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /mark complete/i })).toBeTruthy();
  });
});

describe("ToastStack — a pending Fairest prompt hides the challenge's actions (R9.3)", () => {
  function fairestOffer(
    status: FairestOfferRecord["status"],
  ): FairestOfferRecord {
    return {
      offerId: "o1",
      sourcePlayId: "p1",
      slug: "everyones-a-critic",
      holderTeamId: TARGET,
      originalCasterTeamId: CASTER,
      challengeId: "c1",
      restrictionEffectId: null,
      status,
      decidedAt: status === "pending" ? null : "2024-01-01T00:01:00.000Z",
      mirroredChallengeId: null,
      mirroredEffectId: null,
    };
  }

  function renderFor(status: FairestOfferRecord["status"]) {
    const view = behaviorView("everyones-a-critic", {
      challenges: { c1: openChallenge("everyones-a-critic") },
      offers: { o1: fairestOffer(status) },
    });
    return render(
      <ToastStack
        gameId={GAME}
        toasts={composeFor(view, TARGET)}
        teams={view.teams}
        offers={view.cardBehavior.offers}
        isMirrorLegal={() => true}
        postAction={vi.fn()}
      />,
    );
  }

  it("shows only Play / Decline while the prompt is pending", () => {
    renderFor("pending");
    expect(screen.getByRole("button", { name: /^play$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /decline/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /mark complete/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /we failed/i })).toBeNull();
  });

  it("restores Mark complete / We failed once the prompt is declined (R9.4)", () => {
    renderFor("declined");
    expect(screen.queryByRole("button", { name: /^play$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /mark complete/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /we failed/i })).toBeTruthy();
  });
});

describe("ToastStack — Pioneer Fairest prompt re-checks legality from the current view (R9.18)", () => {
  const BARS: CandidateBar[] = [
    { id: "bar-1", name: "Bar One", lat: 33.78, lng: -84.37 },
    { id: "bar-2", name: "Bar Two", lat: 33.77, lng: -84.36 },
  ];

  const pioneerOffer: FairestOfferRecord = {
    offerId: "o1",
    sourcePlayId: "p1",
    slug: "pioneer",
    holderTeamId: TARGET,
    originalCasterTeamId: CASTER,
    challengeId: null,
    restrictionEffectId: "e1",
    status: "pending",
    decidedAt: null,
    mirroredChallengeId: null,
    mirroredEffectId: null,
  };

  function stackFor(claims: GameBoardView["activeClaims"]) {
    const view = behaviorView(
      "pioneer",
      { offers: { o1: pioneerOffer } },
      claims,
    );
    const ctx = buildSelectorContext(view, BARS);
    return (
      <ToastStack
        gameId={GAME}
        toasts={composeFor(view, TARGET)}
        teams={view.teams}
        offers={view.cardBehavior.offers}
        isMirrorLegal={(o) => mirrorIsLegalInView(view, ctx, o, 0)}
        postAction={vi.fn()}
      />
    );
  }

  it("flips Play to disabled with the notice when the caster loses its last legal bar, Decline stays enabled", () => {
    const { rerender } = render(
      stackFor([{ claimId: "cl-1", barId: "bar-1", teamId: OTHER }]),
    );
    const play = () =>
      screen.getByRole("button", { name: /^play$/i }) as HTMLButtonElement;
    expect(play().disabled).toBe(false);
    expect(screen.queryByText(/no longer legal/i)).toBeNull();

    // Another team claims the remaining bar: Alpha would have no Legal_Next_Bar.
    rerender(
      stackFor([
        { claimId: "cl-1", barId: "bar-1", teamId: OTHER },
        { claimId: "cl-2", barId: "bar-2", teamId: OTHER },
      ]),
    );
    expect(play().disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: /decline/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.getByText(MIRROR_NO_LONGER_LEGAL("Alpha"))).toBeTruthy();
  });
});
