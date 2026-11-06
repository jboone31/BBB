import { describe, expect, it } from "vitest";

import type {
  ChallengeRecord,
  FairestOfferRecord,
} from "@/lib/cards/behaviorState";
import type { CardSlug } from "@/lib/cards/catalog";
import type { Toast } from "@/lib/cards/toasts";
import {
  initialGameBoardView,
  type GameBoardView,
  type PlayView,
  type ToastEvent,
} from "@/lib/gameboard/events";
import type { CandidateBar } from "@/lib/map/bars";

import { selectTeamTargetEligibility } from "@/lib/gameboard/cardEligibility";

import {
  buildCardTargetContext,
  buildSelectorContext,
  composeBoardToasts,
  fairestPromptToastId,
  mirrorIsLegalInView,
  parseDismissalRecord,
  withDismissed,
} from "./boardWiring";

/**
 * Unit tests for the board-page card-behavior wiring (card-behavior task 10.6):
 * pending actions attach to the right toast and survive dismissal filtering
 * (3.8, 3.9), Fairest prompts become their own toast, Boundary_Toasts merge by
 * id, the client mirror check, and the dismissal record helpers.
 */

const GAME = "game-1";
const CASTER = "team-a";
const TARGET = "team-b";
const OTHER = "team-c";

function play(id: string, slug: CardSlug, seq: number): PlayView {
  return {
    playId: id,
    slug,
    casterTeamId: CASTER,
    targetTeamId: TARGET,
    barKey: null,
    returnBarKey: null,
    params: { kind: "none" },
    seq,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

function challenge(
  id: string,
  slug: CardSlug,
  sourcePlayId: string,
): ChallengeRecord {
  return {
    challengeId: id,
    slug,
    sourcePlayId,
    casterTeamId: CASTER,
    targetTeamId: TARGET,
    params: { kind: "none" },
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

function offer(
  id: string,
  challengeId: string,
  sourcePlayId: string,
): FairestOfferRecord {
  return {
    offerId: id,
    sourcePlayId,
    slug: "wired",
    holderTeamId: TARGET,
    originalCasterTeamId: CASTER,
    challengeId,
    restrictionEffectId: null,
    status: "pending",
    decidedAt: null,
    mirroredChallengeId: null,
    mirroredEffectId: null,
  };
}

function playToastEvent(playId: string, seq: number): ToastEvent {
  return { id: `${seq}:play:${playId}`, seq, kind: "play", subjectId: playId };
}

/** A live view with one Wired play (seq 5) and its open challenge. */
function wiredView(
  extra: Partial<GameBoardView["cardBehavior"]> = {},
): GameBoardView {
  const base = initialGameBoardView(GAME);
  return {
    ...base,
    lifecycle: "live",
    teams: [
      { id: CASTER, name: "Alpha", color: "#f00" },
      { id: TARGET, name: "Bravo", color: "#0f0" },
      { id: OTHER, name: "Charlie", color: "#00f" },
    ] as GameBoardView["teams"],
    cardBehavior: {
      ...base.cardBehavior,
      plays: { p1: play("p1", "wired", 5) },
      challenges: { c1: challenge("c1", "wired", "p1") },
      toastEvents: [playToastEvent("p1", 5)],
      ...extra,
    },
    lastSeenSequence: 5,
  };
}

const NO_DISMISSAL = { floorSeq: -1, dismissed: [] as string[] };

describe("composeBoardToasts — Spin Cycle names the return bar", () => {
  /** A live view with one Spin Cycle play carrying a resolved return bar key. */
  function spinCycleView(returnBarKey: string | null): GameBoardView {
    const base = initialGameBoardView(GAME);
    const spinPlay: PlayView = {
      playId: "p1",
      slug: "spin-cycle",
      casterTeamId: CASTER,
      targetTeamId: TARGET,
      barKey: null,
      returnBarKey,
      params: { kind: "none" },
      seq: 5,
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    return {
      ...base,
      lifecycle: "live",
      teams: [
        { id: CASTER, name: "Alpha", color: "#f00" },
        { id: TARGET, name: "Bravo", color: "#0f0" },
      ] as GameBoardView["teams"],
      cardBehavior: {
        ...base.cardBehavior,
        plays: { p1: spinPlay },
        challenges: { c1: challenge("c1", "spin-cycle", "p1") },
        toastEvents: [playToastEvent("p1", 5)],
      },
      lastSeenSequence: 5,
    };
  }

  it("fills {Bar} with the candidate bar's name in the target toast", () => {
    const toasts = composeBoardToasts({
      view: spinCycleView("park-tavern"),
      viewerTeamId: TARGET,
      boundaryToasts: [],
      dismissal: NO_DISMISSAL,
    });
    const target = toasts.find((t) => t.kind === "target");
    expect(target?.body).toBe(
      "Your team must immediately return to the entrance of Park Tavern.",
    );
    // The raw placeholder must not leak through.
    expect(target?.body).not.toContain("{Bar}");
  });

  it("names the start bar when the return bar is the start bar", () => {
    const toasts = composeBoardToasts({
      view: spinCycleView("the-independent"),
      viewerTeamId: TARGET,
      boundaryToasts: [],
      dismissal: NO_DISMISSAL,
    });
    const target = toasts.find((t) => t.kind === "target");
    expect(target?.body).toContain("The Independent");
  });
});

describe("composeBoardToasts", () => {
  it("attaches Mark complete to the target team's toast and keeps it past the floor", () => {
    const toasts = composeBoardToasts({
      view: wiredView(),
      viewerTeamId: TARGET,
      boundaryToasts: [],
      // Floor above the play seq and the toast "dismissed": an action toast
      // still survives so a reload rebuilds it (3.8, 3.9).
      dismissal: { floorSeq: 10, dismissed: ["5:play:p1"] },
    });
    expect(toasts).toHaveLength(1);
    const [toast] = toasts;
    expect(toast.kind).toBe("target");
    expect(toast.headline).toBe("Alpha has played WIRED on you!");
    expect(toast.actions).toEqual([
      { kind: "mark_complete", challengeId: "c1" },
    ]);
    expect(toast.dismissable).toBe(false);
  });

  it("filters dismissed and pre-floor informational toasts", () => {
    const view = wiredView();
    const shown = composeBoardToasts({
      view,
      viewerTeamId: OTHER,
      boundaryToasts: [],
      dismissal: NO_DISMISSAL,
    });
    expect(shown.map((t) => t.kind)).toEqual(["others"]);
    expect(shown[0].actions).toEqual([]);

    expect(
      composeBoardToasts({
        view,
        viewerTeamId: OTHER,
        boundaryToasts: [],
        dismissal: { floorSeq: -1, dismissed: ["5:play:p1"] },
      }),
    ).toEqual([]);
    expect(
      composeBoardToasts({
        view,
        viewerTeamId: OTHER,
        boundaryToasts: [],
        dismissal: { floorSeq: 5, dismissed: [] },
      }),
    ).toEqual([]);
  });

  it("gives the caster no actions", () => {
    const [toast] = composeBoardToasts({
      view: wiredView(),
      viewerTeamId: CASTER,
      boundaryToasts: [],
      dismissal: NO_DISMISSAL,
    });
    expect(toast.kind).toBe("caster");
    expect(toast.actions).toEqual([]);
  });

  it("turns a pending Fairest offer into its own prompt toast and hides Mark complete", () => {
    const toasts = composeBoardToasts({
      view: wiredView({ offers: { o1: offer("o1", "c1", "p1") } }),
      viewerTeamId: TARGET,
      boundaryToasts: [],
      dismissal: NO_DISMISSAL,
    });
    const prompt = toasts.find((t) => t.id === fairestPromptToastId("o1"));
    expect(prompt).toBeDefined();
    expect(prompt?.kind).toBe("fairest_prompt");
    expect(prompt?.headline).toContain("Alpha");
    expect(prompt?.actions).toEqual([
      { kind: "fairest_play", offerId: "o1" },
      { kind: "fairest_decline", offerId: "o1" },
    ]);
    expect(prompt?.dismissable).toBe(false);
    const target = toasts.find((t) => t.kind === "target");
    expect(target?.actions).toEqual([]);
  });

  it("merges Boundary_Toasts by id without duplicates and drops dismissed ones", () => {
    const boundary: Toast = {
      id: "boundary:e1:end",
      kind: "end",
      seq: 0,
      headline: "Crop Dusting is over.",
      body: null,
      dropdown: null,
      actions: [],
      dismissable: true,
    };
    const view = wiredView();
    const toasts = composeBoardToasts({
      view,
      viewerTeamId: OTHER,
      boundaryToasts: [boundary, boundary],
      dismissal: NO_DISMISSAL,
    });
    expect(toasts.map((t) => t.id)).toEqual(["5:play:p1", "boundary:e1:end"]);

    const dismissed = composeBoardToasts({
      view,
      viewerTeamId: OTHER,
      boundaryToasts: [boundary],
      dismissal: { floorSeq: -1, dismissed: ["boundary:e1:end"] },
    });
    expect(dismissed.map((t) => t.id)).toEqual(["5:play:p1"]);
  });
});

describe("buildSelectorContext and mirrorIsLegalInView", () => {
  const BARS: CandidateBar[] = [
    { id: "bar-1", name: "Bar One", lat: 33.78, lng: -84.37 },
    { id: "bar-2", name: "Bar Two", lat: 33.77, lng: -84.36 },
  ];

  function viewWithClaims(
    claims: { barId: string; teamId: string }[],
  ): GameBoardView {
    return {
      ...wiredView(),
      activeClaims: claims.map((c, i) => ({ claimId: `cl-${i}`, ...c })),
    };
  }

  function viewWithBars(
    start: string | null,
    finish: string | null,
  ): GameBoardView {
    return { ...wiredView(), startBarKey: start, finishBarKey: finish };
  }

  it("carries the view's finish coords and start/finish keys into the contexts", () => {
    const view = viewWithBars("bar-1", "bar-2");
    const selectorCtx = buildSelectorContext(view, BARS);
    // The finish bar's coordinates are resolved from the candidate map.
    expect(selectorCtx.finishCoords).toEqual({ lat: 33.77, lng: -84.36 });

    const targetCtx = buildCardTargetContext(view, selectorCtx, 0);
    expect(targetCtx.finishBarKey).toBe("bar-2");
    expect(targetCtx.startBarKey).toBe("bar-1");
    // A team with no claim falls back to the designated start bar (not "").
    expect(targetCtx.previousBars?.get(TARGET)?.barKey).toBe("bar-1");
    expect(targetCtx.previousBars?.get(TARGET)?.kind).toBe("start");
  });

  it("leaves keys null and finish coords null when no designation is folded", () => {
    const view = viewWithBars(null, null);
    const selectorCtx = buildSelectorContext(view, BARS);
    expect(selectorCtx.finishCoords).toBeNull();
    const targetCtx = buildCardTargetContext(view, selectorCtx, 0);
    expect(targetCtx.finishBarKey).toBeNull();
    expect(targetCtx.startBarKey).toBeNull();
    // Falls back to the empty-key start ref when there is no designated start.
    expect(targetCtx.previousBars?.get(TARGET)?.barKey).toBe("");
  });

  it("uses each team's most recent claim as its previous bar", () => {
    const ctx = buildSelectorContext(
      viewWithClaims([
        { barId: "bar-1", teamId: CASTER },
        { barId: "bar-2", teamId: CASTER },
      ]),
      BARS,
    );
    expect(ctx.bars.size).toBe(2);
    expect(ctx.previousBarByTeam.get(CASTER)?.barKey).toBe("bar-2");
    expect(ctx.activeClaims).toEqual([
      { teamId: CASTER, barKey: "bar-1" },
      { teamId: CASTER, barKey: "bar-2" },
    ]);
  });

  it("buildCardTargetContext lets the picker flag a Pioneer target with no legal next bar", () => {
    const blocked = viewWithClaims([
      { barId: "bar-1", teamId: OTHER },
      { barId: "bar-2", teamId: OTHER },
    ]);
    const ctx = buildCardTargetContext(
      blocked,
      buildSelectorContext(blocked, BARS),
      0,
    );
    // Teams without a claim fall back to the start bar as their previous bar.
    expect(ctx.previousBars?.get(TARGET)?.kind).toBe("start");
    expect(ctx.claimState).toEqual({ "bar-1": [OTHER], "bar-2": [OTHER] });
    const rows = selectTeamTargetEligibility(blocked, "pioneer", CASTER, ctx);
    expect(rows.find((r) => r.teamId === TARGET)).toEqual({
      teamId: TARGET,
      eligible: false,
      reason: "no_legal_next_bar",
      rules: ["pioneer"],
    });

    const open = viewWithClaims([{ barId: "bar-1", teamId: OTHER }]);
    const openRows = selectTeamTargetEligibility(
      open,
      "pioneer",
      CASTER,
      buildCardTargetContext(open, buildSelectorContext(open, BARS), 0),
    );
    expect(openRows.find((r) => r.teamId === TARGET)?.eligible).toBe(true);
  });

  it("always allows mirroring a non-restriction card", () => {
    const view = viewWithClaims([]);
    expect(
      mirrorIsLegalInView(
        view,
        buildSelectorContext(view, BARS),
        offer("o", "c1", "p1"),
        0,
      ),
    ).toBe(true);
  });

  it("forbids a Pioneer mirror when every bar is claimed by another team", () => {
    const pioneer = { slug: "pioneer" as const, originalCasterTeamId: CASTER };
    const blocked = viewWithClaims([
      { barId: "bar-1", teamId: OTHER },
      { barId: "bar-2", teamId: OTHER },
    ]);
    expect(
      mirrorIsLegalInView(
        blocked,
        buildSelectorContext(blocked, BARS),
        pioneer,
        0,
      ),
    ).toBe(false);

    const open = viewWithClaims([{ barId: "bar-1", teamId: OTHER }]);
    expect(
      mirrorIsLegalInView(open, buildSelectorContext(open, BARS), pioneer, 0),
    ).toBe(true);
  });
});

describe("dismissal record helpers", () => {
  it("parses a valid record and rejects malformed ones", () => {
    expect(
      parseDismissalRecord(JSON.stringify({ floorSeq: 3, dismissed: ["a"] })),
    ).toEqual({ floorSeq: 3, dismissed: ["a"] });
    expect(parseDismissalRecord(null)).toBeNull();
    expect(parseDismissalRecord("not json")).toBeNull();
    expect(
      parseDismissalRecord(JSON.stringify({ floorSeq: "3", dismissed: [] })),
    ).toBeNull();
    expect(
      parseDismissalRecord(JSON.stringify({ floorSeq: 3, dismissed: [1] })),
    ).toBeNull();
  });

  it("adds a dismissed id once", () => {
    const record = { floorSeq: 2, dismissed: ["a"] };
    expect(withDismissed(record, "a")).toBe(record);
    expect(withDismissed(record, "b")).toEqual({
      floorSeq: 2,
      dismissed: ["a", "b"],
    });
  });
});
