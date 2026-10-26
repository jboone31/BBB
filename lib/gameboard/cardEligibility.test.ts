/**
 * Card-targeting eligibility selector tests (brawl-deck-architecture Task 8;
 * R3.2, R3.3).
 *
 * The selectors derive, from a folded GameBoardView, which teams a card may be
 * targeted at: the caster's own team is never eligible, and a team already
 * targeted by a card of the SAME NAME is ineligible (the v1 same-name-once rule).
 */

import { describe, expect, it } from "vitest";

import type { GameEvent } from "@/lib/events";
import type { ResolvedBarRef } from "@/lib/cards/behaviorState";
import type { NextClaimRule } from "@/lib/claims/legalNextBar";
import type { LatLng } from "@/lib/map/geo";
import { foldGameBoardEvents, initialGameBoardView } from "./events";
import {
  isBarTargetEligible,
  isTeamTargetEligible,
  selectBarTargetEligibility,
  selectBarsTargetedByCard,
  selectTeamTargetEligibility,
  selectTeamsTargetedByCard,
  type CardTargetContext,
} from "./cardEligibility";

const GAME = "game-1";

function teamCreated(seq: number, teamId: string): GameEvent {
  return {
    id: `e-${seq}`,
    gameId: GAME,
    seq,
    eventType: "team_created",
    actorKind: "admin",
    actorTeamId: null,
    payload: { teamId, name: teamId.toUpperCase(), color: "#111111" },
    createdAt: new Date(seq).toISOString(),
  };
}

function cardPlayed(
  seq: number,
  slug: string,
  castingTeamId: string,
  targetTeamId: string | null,
  targetBarId: string | null = null,
): GameEvent {
  return {
    id: `e-${seq}`,
    gameId: GAME,
    seq,
    eventType: "card_played",
    actorKind: "team",
    actorTeamId: castingTeamId,
    payload: {
      teamId: castingTeamId,
      castingTeamId,
      slug,
      targetTeamId,
      targetBarId,
      cards: [
        {
          cardId: `${castingTeamId}:${slug}`,
          teamId: castingTeamId,
          slug,
          state: "played",
        },
      ],
    },
    createdAt: new Date(seq).toISOString(),
  };
}

function baseView() {
  return foldGameBoardEvents(GAME, [
    teamCreated(1, "team-a"),
    teamCreated(2, "team-b"),
    teamCreated(3, "team-c"),
  ]);
}

describe("selectTeamsTargetedByCard (R3.3)", () => {
  it("is empty when no play of that card has occurred", () => {
    expect(selectTeamsTargetedByCard(baseView(), "go-piss-girl").size).toBe(0);
  });

  it("collects every team targeted by a prior play of the same slug", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a"),
      teamCreated(2, "team-b"),
      teamCreated(3, "team-c"),
      cardPlayed(4, "go-piss-girl", "team-a", "team-b"),
      // A different card targeting team-c must not count for go-piss-girl.
      cardPlayed(5, "wired", "team-a", "team-c"),
    ]);
    const targeted = selectTeamsTargetedByCard(view, "go-piss-girl");
    expect([...targeted]).toEqual(["team-b"]);
  });
});

describe("isTeamTargetEligible (R3.2, R3.3)", () => {
  it("rejects the caster's own team", () => {
    expect(
      isTeamTargetEligible(baseView(), "go-piss-girl", "team-a", "team-a"),
    ).toBe(false);
  });

  it("accepts a fresh target and rejects one already hit by the same card", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a"),
      teamCreated(2, "team-b"),
      teamCreated(3, "team-c"),
      cardPlayed(4, "go-piss-girl", "team-a", "team-b"),
    ]);
    // team-b already hit by go-piss-girl -> ineligible.
    expect(isTeamTargetEligible(view, "go-piss-girl", "team-a", "team-b")).toBe(
      false,
    );
    // team-c not yet hit -> eligible.
    expect(isTeamTargetEligible(view, "go-piss-girl", "team-a", "team-c")).toBe(
      true,
    );
    // A different card may still target team-b.
    expect(isTeamTargetEligible(view, "wired", "team-a", "team-b")).toBe(true);
  });
});

describe("selectTeamTargetEligibility (R3.2, R3.3)", () => {
  it("marks own team caster and already-targeted teams already_targeted_same_card", () => {
    const view = foldGameBoardEvents(GAME, [
      teamCreated(1, "team-a"),
      teamCreated(2, "team-b"),
      teamCreated(3, "team-c"),
      cardPlayed(4, "go-piss-girl", "team-a", "team-b"),
    ]);
    const rows = selectTeamTargetEligibility(view, "go-piss-girl", "team-a");
    const byId = new Map(rows.map((r) => [r.teamId, r]));
    expect(byId.get("team-a")).toMatchObject({
      eligible: false,
      reason: "caster",
    });
    expect(byId.get("team-b")).toMatchObject({
      eligible: false,
      reason: "already_targeted_same_card",
    });
    expect(byId.get("team-c")).toMatchObject({
      eligible: true,
      reason: null,
    });
  });

  it("returns an empty list for a view with no teams", () => {
    expect(
      selectTeamTargetEligibility(
        initialGameBoardView(GAME),
        "go-piss-girl",
        "team-a",
      ),
    ).toEqual([]);
  });
});

describe("bar targeting selectors (R3.4, R3.5)", () => {
  const BARS = ["bar-1", "bar-2", "bar-3"];

  it("collects bars already targeted by the same card", () => {
    const view = foldGameBoardEvents(GAME, [
      cardPlayed(1, "happy-hour", "team-a", null, "bar-1"),
      // A different card targeting bar-2 must not count for happy-hour.
      cardPlayed(2, "crop-dusting", "team-a", null, "bar-2"),
    ]);
    expect([...selectBarsTargetedByCard(view, "happy-hour")]).toEqual([
      "bar-1",
    ]);
  });

  it("rejects the finish bar and an already-same-card-targeted bar", () => {
    const view = foldGameBoardEvents(GAME, [
      cardPlayed(1, "happy-hour", "team-a", null, "bar-1"),
    ]);
    // Finish bar is ineligible.
    expect(isBarTargetEligible(view, "happy-hour", "bar-3", "bar-3")).toBe(
      false,
    );
    // Already targeted by happy-hour.
    expect(isBarTargetEligible(view, "happy-hour", "bar-1", null)).toBe(false);
    // Fresh bar is eligible.
    expect(isBarTargetEligible(view, "happy-hour", "bar-2", null)).toBe(true);
    // A different card may still target bar-1.
    expect(isBarTargetEligible(view, "crop-dusting", "bar-1", null)).toBe(true);
  });

  it("marks finish_bar and already_targeted_same_card reasons per bar", () => {
    const view = foldGameBoardEvents(GAME, [
      cardPlayed(1, "happy-hour", "team-a", null, "bar-1"),
    ]);
    const rows = selectBarTargetEligibility(view, "happy-hour", BARS, "bar-3");
    const byId = new Map(rows.map((r) => [r.barId, r]));
    expect(byId.get("bar-1")).toMatchObject({
      eligible: false,
      reason: "already_targeted_same_card",
    });
    expect(byId.get("bar-2")).toMatchObject({ eligible: true, reason: null });
    expect(byId.get("bar-3")).toMatchObject({
      eligible: false,
      reason: "finish_bar",
    });
  });
});

// ---------------------------------------------------------------------------
// Extended bar/team rules (card-behavior Task 3.12; design.md section 9).
// ---------------------------------------------------------------------------

/** Move `lat` north by roughly `miles` (1 deg lat ~ 69 miles). */
function north(base: LatLng, miles: number): LatLng {
  return { lat: base.lat + miles / 69, lng: base.lng };
}

const FINISH: LatLng = { lat: 33.75, lng: -84.37 };

describe("selectBarTargetEligibility - Cancel Culture distance rules (18.1-18.3)", () => {
  function ctx(): CardTargetContext {
    const barCoords = new Map<string, LatLng>([
      ["finish", FINISH],
      ["near", north(FINISH, 0.1)], // within 0.25 mi
      ["far", north(FINISH, 1)], // beyond 0.25 mi
      // "nocoords" intentionally absent from the map
    ]);
    return { finishBarKey: "finish", barCoords };
  }

  it("rejects a bar within 0.25 miles of the finish as near_finish", () => {
    const rows = selectBarTargetEligibility(
      initialGameBoardView(GAME),
      "cancel-culture",
      ["near", "far", "nocoords"],
      ctx(),
    );
    const byId = new Map(rows.map((r) => [r.barId, r]));
    expect(byId.get("near")).toMatchObject({
      eligible: false,
      reason: "near_finish",
    });
    expect(byId.get("far")).toMatchObject({ eligible: true, reason: null });
    expect(byId.get("nocoords")).toMatchObject({
      eligible: false,
      reason: "no_coordinates",
    });
  });

  it("reports no_coordinates when the finish bar has no coordinates", () => {
    const barCoords = new Map<string, LatLng>([["far", north(FINISH, 1)]]);
    const rows = selectBarTargetEligibility(
      initialGameBoardView(GAME),
      "cancel-culture",
      ["far"],
      { finishBarKey: "finish", barCoords },
    );
    expect(rows[0]).toMatchObject({
      eligible: false,
      reason: "no_coordinates",
    });
  });
});

describe("selectBarTargetEligibility - Party Crasher four_claimants (14.1)", () => {
  it("rejects a bar already claimed by four teams and accepts fewer", () => {
    const ctx: CardTargetContext = {
      finishBarKey: "finish",
      claimState: {
        "bar-full": ["t1", "t2", "t3", "t4"],
        "bar-three": ["t1", "t2", "t3"],
      },
    };
    const rows = selectBarTargetEligibility(
      initialGameBoardView(GAME),
      "party-crasher",
      ["bar-full", "bar-three", "bar-empty"],
      ctx,
    );
    const byId = new Map(rows.map((r) => [r.barId, r]));
    expect(byId.get("bar-full")).toMatchObject({
      eligible: false,
      reason: "four_claimants",
    });
    expect(byId.get("bar-three")).toMatchObject({
      eligible: true,
      reason: null,
    });
    expect(byId.get("bar-empty")).toMatchObject({
      eligible: true,
      reason: null,
    });
  });

  it("still rejects the finish bar for Party Crasher", () => {
    const rows = selectBarTargetEligibility(
      initialGameBoardView(GAME),
      "party-crasher",
      ["finish"],
      { finishBarKey: "finish", claimState: {} },
    );
    expect(rows[0]).toMatchObject({ eligible: false, reason: "finish_bar" });
  });
});

describe("selectBarTargetEligibility - Voted Off start_bar / not_claimed_by_all (22.1)", () => {
  const ctx: CardTargetContext = {
    finishBarKey: "finish",
    startBarKey: "start",
    teamIds: ["t1", "t2", "t3"],
    claimState: {
      "bar-all": ["t1", "t2", "t3"],
      "bar-some": ["t1", "t2"],
      start: ["t1", "t2", "t3"],
    },
  };

  it("accepts a bar every team claims", () => {
    const rows = selectBarTargetEligibility(
      initialGameBoardView(GAME),
      "voted-off-the-island",
      ["bar-all"],
      ctx,
    );
    expect(rows[0]).toMatchObject({ eligible: true, reason: null });
  });

  it("rejects a bar not claimed by every team", () => {
    const rows = selectBarTargetEligibility(
      initialGameBoardView(GAME),
      "voted-off-the-island",
      ["bar-some"],
      ctx,
    );
    expect(rows[0]).toMatchObject({
      eligible: false,
      reason: "not_claimed_by_all",
    });
  });

  it("rejects the start bar even when every team claims it", () => {
    const rows = selectBarTargetEligibility(
      initialGameBoardView(GAME),
      "voted-off-the-island",
      ["start"],
      ctx,
    );
    expect(rows[0]).toMatchObject({ eligible: false, reason: "start_bar" });
  });
});

describe("selectTeamTargetEligibility - Pioneer/Scenic no_legal_next_bar (10.10-10.12, 22.5)", () => {
  const bars: ResolvedBarRef[] = [
    { barKey: "start", kind: "start", coords: FINISH },
    { barKey: "finish", kind: "finish", coords: FINISH },
    { barKey: "bar-x", kind: "scoring", coords: north(FINISH, 1) },
  ];
  const barCoords = new Map<string, LatLng>(
    bars.map((b) => [b.barKey, b.coords!]),
  );

  function baseCtx(
    claimState: Record<string, readonly string[]>,
    restrictions?: ReadonlyMap<string, readonly NextClaimRule[]>,
  ): CardTargetContext {
    const previousBars = new Map<string, ResolvedBarRef>([
      ["team-b", { barKey: "start", kind: "start", coords: FINISH }],
      ["team-c", { barKey: "start", kind: "start", coords: FINISH }],
    ]);
    return {
      finishBarKey: "finish",
      startBarKey: "start",
      barCoords,
      claimState,
      teamIds: ["team-a", "team-b", "team-c"],
      previousBars,
      restrictions,
    };
  }

  it("marks a Pioneer target ineligible when every non-finish bar is claimed by others", () => {
    // Every non-finish bar (start + bar-x) is claimed by team-a, so Pioneer
    // leaves team-b with no unclaimed, non-finish bar to go to.
    const ctx = baseCtx({ start: ["team-a"], "bar-x": ["team-a"] });
    const rows = selectTeamTargetEligibility(
      baseView(),
      "pioneer",
      "team-a",
      ctx,
    );
    const byId = new Map(rows.map((r) => [r.teamId, r]));
    expect(byId.get("team-b")).toMatchObject({
      eligible: false,
      reason: "no_legal_next_bar",
      rules: ["pioneer"],
    });
  });

  it("marks a Pioneer target eligible when an unclaimed non-finish bar remains", () => {
    const ctx = baseCtx({});
    const rows = selectTeamTargetEligibility(
      baseView(),
      "pioneer",
      "team-a",
      ctx,
    );
    const byId = new Map(rows.map((r) => [r.teamId, r]));
    expect(byId.get("team-b")).toMatchObject({ eligible: true, reason: null });
  });

  it("does not apply the Legal_Next_Bar rule to non-restriction cards", () => {
    const ctx = baseCtx({ "bar-x": ["team-a"] });
    const rows = selectTeamTargetEligibility(
      baseView(),
      "go-piss-girl",
      "team-a",
      ctx,
    );
    const byId = new Map(rows.map((r) => [r.teamId, r]));
    expect(byId.get("team-b")).toMatchObject({ eligible: true, reason: null });
  });

  it("falls back to eligible when the context lacks Legal_Next_Bar facts", () => {
    // Legacy call with a bare finish-bar key: no previousBars/barCoords.
    const rows = selectTeamTargetEligibility(
      baseView(),
      "pioneer",
      "team-a",
      "finish",
    );
    const byId = new Map(rows.map((r) => [r.teamId, r]));
    expect(byId.get("team-b")).toMatchObject({ eligible: true, reason: null });
  });
});
