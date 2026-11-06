import { describe, expect, it } from "vitest";

import { planCardPlay, type PlayRequest } from "./playPlan";
import type { BehaviorState, ClaimRow } from "./behaviorState";
import type { ResolvedBar } from "@/lib/map/barResolver";

/**
 * Spin Cycle resolves the target team's return bar at play time — its most
 * recently claimed bar, excluding ordinary unclaims (a voted_off claim still
 * counts), and the start bar when it has no qualifying claim (18.x). The plan
 * records that bar's key so the toast can name it.
 */

const NOW = "2024-01-01T12:00:00.000Z";
const CASTER = "team-caster";
const TARGET = "team-target";
const START = "start-bar";
const BAR_A = "park-tavern";
const BAR_B = "the-independent";

function bar(barKey: string, kind: ResolvedBar["kind"]): ResolvedBar {
  return {
    barId: `id-${barKey}`,
    barKey,
    name: barKey,
    coords: { lat: 33.78, lng: -84.37 },
    kind,
  };
}

function claim(
  claimId: string,
  teamId: string,
  barKey: string,
  claimedAt: string,
  revokedReason: ClaimRow["revokedReason"] = null,
): ClaimRow {
  return {
    claimId,
    teamId,
    barId: `id-${barKey}`,
    barKey,
    claimedAt,
    revokedReason,
  };
}

function state(history: readonly ClaimRow[]): BehaviorState {
  const bars = new Map<string, ResolvedBar>([
    [START, bar(START, "start")],
    [BAR_A, bar(BAR_A, "scoring")],
    [BAR_B, bar(BAR_B, "scoring")],
  ]);
  return {
    gameId: "game-1",
    lifecycle: "live",
    nowIso: NOW,
    teams: [
      { teamId: CASTER, name: "Caster", memberSessionIds: ["s-c"] },
      { teamId: TARGET, name: "Target", memberSessionIds: ["s-t"] },
    ],
    hostSessionId: "host",
    bars,
    startBarKey: START,
    finishBarKey: null,
    activeClaims: history.filter((c) => c.revokedReason === null),
    claimHistory: history,
    hands: new Map([
      [
        CASTER,
        {
          hand: [
            {
              id: `${CASTER}:spin-cycle`,
              slug: "spin-cycle" as const,
              state: "hand" as const,
              position: 0,
            },
          ],
          pending: [],
        },
      ],
    ]),
    plays: [],
    challenges: [],
    offers: [],
    effects: [],
    awards: [],
    ledger: [],
  };
}

function req(): PlayRequest {
  return {
    cardId: `${CASTER}:spin-cycle`,
    casterTeamId: CASTER,
    targetTeamId: TARGET,
    targetBarKey: undefined,
    rawParams: { kind: "none" },
  };
}

describe("planCardPlay — Spin Cycle return bar", () => {
  it("records the target team's most recently claimed bar", () => {
    const result = planCardPlay(
      state([
        claim("c1", TARGET, BAR_A, "2024-01-01T11:00:00.000Z"),
        claim("c2", TARGET, BAR_B, "2024-01-01T11:30:00.000Z"),
      ]),
      req(),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.returnBarKey).toBe(BAR_B);
  });

  it("counts a voted_off claim but not an ordinary unclaim", () => {
    const result = planCardPlay(
      state([
        // Most recent by time, but ordinary-unclaimed → does not count.
        claim(
          "c2",
          TARGET,
          BAR_B,
          "2024-01-01T11:30:00.000Z",
          "ordinary_unclaim",
        ),
        // Older, voted_off → still counts, and is the latest qualifying claim.
        claim("c1", TARGET, BAR_A, "2024-01-01T11:00:00.000Z", "voted_off"),
      ]),
      req(),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.returnBarKey).toBe(BAR_A);
  });

  it("falls back to the start bar when the target has no qualifying claim", () => {
    const result = planCardPlay(state([]), req(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.returnBarKey).toBe(START);
  });
});
