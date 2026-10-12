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
import { foldGameBoardEvents, initialGameBoardView } from "./events";
import {
  isTeamTargetEligible,
  selectTeamTargetEligibility,
  selectTeamsTargetedByCard,
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
  it("marks own team own_team and already-targeted teams already_targeted_same_card", () => {
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
      reason: "own_team",
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
