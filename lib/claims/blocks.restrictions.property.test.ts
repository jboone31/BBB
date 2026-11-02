import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  evaluateClaimBlocks,
  previousBarFor,
  type ClaimBlock,
  type ClaimBlockInput,
} from "./blocks";
import type {
  ClaimRow,
  EffectRecord,
  ResolvedBarRef,
} from "@/lib/cards/behaviorState";
import { haversineMiles, type LatLng } from "@/lib/map/geo";

/**
 * Feature: card-behavior, Property 7: Next-claim restriction semantics.
 *
 * Pioneer and Scenic Route are the two next-claim restrictions
 * `evaluateClaimBlocks` checks in `claim` mode. This property pins their exact
 * blocking semantics and the previous-bar resolution they lean on, independently
 * of the full block-ordering contract (Property 6) and the Legal_Next_Bar
 * cross-module agreement (Property 24):
 *
 * - **Pioneer (10.2):** blocks the finish bar (`finish_bar`) and exactly the
 *   bars with an active claim held by another team (`claimed_by_other`); a bar
 *   the restricted team holds itself, or that no one holds, is never Pioneer-
 *   blocked.
 * - **Scenic Route (10.4):** blocks exactly the bars whose Geodesic_Distance to
 *   the finish is less than or equal to the previous bar's distance to the
 *   finish (i.e. not strictly farther, `not_farther`), and blocks with
 *   `no_coordinates` whenever the bar, finish, or previous-bar coordinates are
 *   unknown. A bar strictly farther than the previous bar, with all coordinates
 *   known, is never Scenic-blocked.
 * - **previousBarFor (10.5):** the previous bar is the team's most recent claim
 *   (by `claimedAt`) not reversed by an ordinary unclaim; a `voted_off`
 *   revocation does not disqualify a claim, and the start bar is used when no
 *   qualifying claim exists.
 *
 * Validates: Requirements 10.2, 10.4, 10.5
 */

// ---------------------------------------------------------------------------
// Coordinate anchors + timeline.
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2025-06-01T18:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const SUBJECT = "team-subject";
const OTHER_TEAMS = ["team-a", "team-b", "team-c"] as const;

/**
 * A compact coordinate grid so Scenic Route distance comparisons produce a mix
 * of "strictly farther" and "not farther" outcomes.
 */
const gridCoord: fc.Arbitrary<LatLng> = fc.record({
  lat: fc.integer({ min: 0, max: 15 }).map((n) => 33.74 + n * 0.01),
  lng: fc.integer({ min: 0, max: 15 }).map((n) => -84.37 + n * 0.01),
});

/** Coordinates, sometimes absent, so Scenic's `no_coordinates` path is hit. */
const maybeCoord: fc.Arbitrary<LatLng | null> = fc.oneof(
  { weight: 4, arbitrary: gridCoord },
  { weight: 1, arbitrary: fc.constant(null) },
);

// ---------------------------------------------------------------------------
// Effect builder: an active next-claim restriction targeting the subject team.
// ---------------------------------------------------------------------------

function restrictionEffect(
  rule: "pioneer" | "scenic",
  index: number,
): EffectRecord {
  return {
    effectId: `restr-${rule}-${index}`,
    slug: rule === "pioneer" ? "pioneer" : "scenic-route",
    kind: "next_claim_restriction",
    sourcePlayId: null,
    sourceChallengeId: null,
    ownerTeamId: null,
    targetTeamId: SUBJECT,
    targetBarKey: null,
    startsAt: iso(NOW_MS - 60_000),
    endsAt: null, // restrictions clear by consumption, not clock
    params: { rule },
    attachedClaimId: null,
    attachedBarKey: null,
    protectedPoints: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    startAnnounced: true,
    endAnnounced: false,
  };
}

// ---------------------------------------------------------------------------
// Pioneer semantics (10.2).
// ---------------------------------------------------------------------------

/** A probe world: a candidate bar + a set of active claims across teams. */
interface PioneerWorld {
  readonly bar: ResolvedBarRef;
  readonly activeClaims: readonly {
    readonly teamId: string;
    readonly barKey: string;
  }[];
}

const pioneerWorldArb: fc.Arbitrary<PioneerWorld> = fc
  .record({
    barKey: fc.constantFrom("bar-a", "bar-b", "bar-c", "finish"),
    coords: maybeCoord,
    claims: fc.array(
      fc.record({
        teamId: fc.constantFrom(SUBJECT, ...OTHER_TEAMS),
        barKey: fc.constantFrom("bar-a", "bar-b", "bar-c", "finish"),
      }),
      { maxLength: 8 },
    ),
  })
  .map(({ barKey, coords, claims }) => ({
    bar: {
      barKey,
      kind: barKey === "finish" ? ("finish" as const) : ("scoring" as const),
      coords,
    },
    activeClaims: claims,
  }));

function pioneerInput(world: PioneerWorld): ClaimBlockInput {
  return {
    teamId: SUBJECT,
    bar: world.bar,
    finishCoords: null,
    challenges: [],
    effects: [restrictionEffect("pioneer", 0)],
    activeClaims: world.activeClaims,
    previousBar: { barKey: "bar-start", kind: "start", coords: null },
    barCoords: new Map(),
    mode: "claim",
    nowMs: NOW_MS,
  };
}

function pioneerBlocks(
  blocks: ClaimBlock[],
): Extract<ClaimBlock, { kind: "pioneer" }>[] {
  return blocks.filter(
    (b): b is Extract<ClaimBlock, { kind: "pioneer" }> => b.kind === "pioneer",
  );
}

describe("Pioneer restriction semantics (Property 7)", () => {
  it("blocks the finish bar and exactly the bars claimed by another team", () => {
    fc.assert(
      fc.property(pioneerWorldArb, (world) => {
        const blocks = pioneerBlocks(evaluateClaimBlocks(pioneerInput(world)));

        if (world.bar.kind === "finish") {
          expect(blocks).toHaveLength(1);
          expect(blocks[0].reason).toBe("finish_bar");
          return;
        }

        const claimedByOther = world.activeClaims.some(
          (c) => c.barKey === world.bar.barKey && c.teamId !== SUBJECT,
        );
        if (claimedByOther) {
          expect(blocks).toHaveLength(1);
          expect(blocks[0].reason).toBe("claimed_by_other");
        } else {
          expect(blocks).toHaveLength(0);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("never blocks a bar the restricted team holds itself (self-claim is not blocking)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("bar-a", "bar-b", "bar-c"),
        fc.array(fc.constantFrom(...OTHER_TEAMS), { maxLength: 3 }),
        (barKey, otherHolders) => {
          // The subject holds the bar; some other teams may also hold it.
          const activeClaims = [
            { teamId: SUBJECT, barKey },
            ...otherHolders.map((teamId) => ({ teamId, barKey })),
          ];
          const world: PioneerWorld = {
            bar: { barKey, kind: "scoring", coords: null },
            activeClaims,
          };
          const blocks = pioneerBlocks(
            evaluateClaimBlocks(pioneerInput(world)),
          );
          // Pioneer only cares about *other* teams; a block appears iff another
          // team also holds the bar.
          expect(blocks.length > 0).toBe(otherHolders.length > 0);
          if (blocks.length > 0) {
            expect(blocks[0].reason).toBe("claimed_by_other");
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

// ---------------------------------------------------------------------------
// Scenic Route semantics (10.4).
// ---------------------------------------------------------------------------

interface ScenicWorld {
  readonly bar: ResolvedBarRef;
  readonly finishCoords: LatLng | null;
  readonly previousBar: ResolvedBarRef;
}

const scenicWorldArb: fc.Arbitrary<ScenicWorld> = fc
  .record({
    barCoords: maybeCoord,
    finishCoords: maybeCoord,
    previousCoords: maybeCoord,
  })
  .map(({ barCoords, finishCoords, previousCoords }) => ({
    bar: {
      barKey: "bar-candidate",
      kind: "scoring" as const,
      coords: barCoords,
    },
    finishCoords,
    previousBar: {
      barKey: "bar-previous",
      kind: "scoring" as const,
      coords: previousCoords,
    },
  }));

function scenicInput(world: ScenicWorld): ClaimBlockInput {
  return {
    teamId: SUBJECT,
    bar: world.bar,
    finishCoords: world.finishCoords,
    challenges: [],
    effects: [restrictionEffect("scenic", 0)],
    activeClaims: [],
    previousBar: world.previousBar,
    barCoords: new Map(),
    mode: "claim",
    nowMs: NOW_MS,
  };
}

function scenicBlocks(
  blocks: ClaimBlock[],
): Extract<ClaimBlock, { kind: "scenic" }>[] {
  return blocks.filter(
    (b): b is Extract<ClaimBlock, { kind: "scenic" }> => b.kind === "scenic",
  );
}

describe("Scenic Route restriction semantics (Property 7)", () => {
  it("blocks exactly the bars not strictly farther from the finish than the previous bar", () => {
    fc.assert(
      fc.property(scenicWorldArb, (world) => {
        const blocks = scenicBlocks(evaluateClaimBlocks(scenicInput(world)));

        const coordsMissing =
          world.bar.coords === null ||
          world.finishCoords === null ||
          world.previousBar.coords === null;

        if (coordsMissing) {
          expect(blocks).toHaveLength(1);
          expect(blocks[0].reason).toBe("no_coordinates");
          return;
        }

        const barDist = haversineMiles(world.bar.coords!, world.finishCoords!);
        const prevDist = haversineMiles(
          world.previousBar.coords!,
          world.finishCoords!,
        );

        // Scenic Route requires strictly farther; <= previous distance is blocked.
        if (barDist > prevDist) {
          expect(blocks).toHaveLength(0);
        } else {
          expect(blocks).toHaveLength(1);
          expect(blocks[0].reason).toBe("not_farther");
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("blocks a bar exactly at the previous bar's distance (inclusive <=)", () => {
    // Same coordinates as the previous bar → equal distance → blocked.
    const coord: LatLng = { lat: 33.75, lng: -84.36 };
    const world: ScenicWorld = {
      bar: { barKey: "bar-candidate", kind: "scoring", coords: coord },
      finishCoords: { lat: 33.76, lng: -84.35 },
      previousBar: { barKey: "bar-previous", kind: "scoring", coords: coord },
    };
    const blocks = scenicBlocks(evaluateClaimBlocks(scenicInput(world)));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].reason).toBe("not_farther");
  });
});

// ---------------------------------------------------------------------------
// previousBarFor semantics (10.5).
// ---------------------------------------------------------------------------

const START_BAR: ResolvedBarRef = {
  barKey: "bar-start",
  kind: "start",
  coords: null,
};

/** A claim-history row generator for the subject team and some foreign teams. */
const claimRowArb: fc.Arbitrary<ClaimRow> = fc
  .record({
    teamId: fc.constantFrom(SUBJECT, ...OTHER_TEAMS),
    barKey: fc.constantFrom("bar-a", "bar-b", "bar-c", "bar-d"),
    // Distinct, ordered timestamps so "most recent" is unambiguous.
    minute: fc.integer({ min: 0, max: 59 }),
    revokedReason: fc.constantFrom<ClaimRow["revokedReason"]>(
      null,
      "ordinary_unclaim",
      "voted_off",
    ),
  })
  .map(({ teamId, barKey, minute, revokedReason }): ClaimRow => ({
    claimId: `claim-${teamId}-${barKey}-${minute}`,
    teamId,
    barId: `id-${barKey}`,
    barKey,
    claimedAt: iso(NOW_MS + minute * 60_000),
    revokedReason,
  }));

describe("previousBarFor semantics (Property 7)", () => {
  it("returns the most recent subject claim not reversed by an ordinary unclaim, else the start bar", () => {
    fc.assert(
      fc.property(fc.array(claimRowArb, { maxLength: 10 }), (history) => {
        // De-duplicate claimedAt collisions among subject claims so the
        // reference "most recent" pick is deterministic.
        const seen = new Set<string>();
        const uniqueHistory = history.filter((row) => {
          const key = `${row.teamId}@${row.claimedAt}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const result = previousBarFor(SUBJECT, uniqueHistory, START_BAR);

        // Reference: subject's claims not reversed by ordinary_unclaim, latest
        // by claimedAt; start bar when none.
        const eligible = uniqueHistory.filter(
          (row) =>
            row.teamId === SUBJECT && row.revokedReason !== "ordinary_unclaim",
        );
        if (eligible.length === 0) {
          expect(result.barKey).toBe(START_BAR.barKey);
          return;
        }
        let latest = eligible[0];
        for (const row of eligible.slice(1)) {
          if (row.claimedAt > latest.claimedAt) {
            latest = row;
          }
        }
        expect(result.barKey).toBe(latest.barKey);
      }),
      { numRuns: 800 },
    );
  });

  it("a voted_off revocation still qualifies as the previous bar", () => {
    const history: ClaimRow[] = [
      {
        claimId: "c1",
        teamId: SUBJECT,
        barId: "id-bar-a",
        barKey: "bar-a",
        claimedAt: iso(NOW_MS),
        revokedReason: "voted_off",
      },
    ];
    expect(previousBarFor(SUBJECT, history, START_BAR).barKey).toBe("bar-a");
  });

  it("an ordinary_unclaim is excluded, falling back to an earlier valid claim", () => {
    const history: ClaimRow[] = [
      {
        claimId: "c1",
        teamId: SUBJECT,
        barId: "id-bar-a",
        barKey: "bar-a",
        claimedAt: iso(NOW_MS),
        revokedReason: null,
      },
      {
        claimId: "c2",
        teamId: SUBJECT,
        barId: "id-bar-b",
        barKey: "bar-b",
        claimedAt: iso(NOW_MS + 60_000),
        revokedReason: "ordinary_unclaim",
      },
    ];
    // bar-b is the latest claim but was ordinary-unclaimed, so bar-a wins.
    expect(previousBarFor(SUBJECT, history, START_BAR).barKey).toBe("bar-a");
  });

  it("falls back to the start bar when the subject has no qualifying claim", () => {
    const history: ClaimRow[] = [
      {
        claimId: "c1",
        teamId: "team-a",
        barId: "id-bar-a",
        barKey: "bar-a",
        claimedAt: iso(NOW_MS),
        revokedReason: null,
      },
      {
        claimId: "c2",
        teamId: SUBJECT,
        barId: "id-bar-b",
        barKey: "bar-b",
        claimedAt: iso(NOW_MS + 60_000),
        revokedReason: "ordinary_unclaim",
      },
    ];
    expect(previousBarFor(SUBJECT, history, START_BAR).barKey).toBe(
      START_BAR.barKey,
    );
  });
});
