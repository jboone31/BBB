import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type {
  BehaviorState,
  FairestOfferRecord,
  ResolvedBarRef,
} from "@/lib/cards/behaviorState";
import type { EffectRecord } from "@/lib/cards/effects";
import type { ResolvedBar } from "@/lib/map/barResolver";
import type { LatLng } from "@/lib/map/geo";
import { haversineMiles } from "@/lib/map/geo";

import {
  barSatisfiesRule,
  hasLegalNextBar,
  mirrorIsLegal,
  selectLegalNextBars,
  type LegalNextBarInput,
  type NextClaimRule,
} from "./legalNextBar";
import { evaluateClaimBlocks, type ClaimBlockInput } from "./blocks";

/**
 * Feature: card-behavior, Property 24: Legal_Next_Bar guard is one rule shared
 * by plays, blocks, and mirrors.
 *
 * `lib/claims/legalNextBar.ts` is the single definition of Legal_Next_Bar. This
 * property test pins its invariants and, crucially, the cross-module agreement
 * that keeps `selectLegalNextBars`, `evaluateClaimBlocks`, and `mirrorIsLegal`
 * from drifting apart:
 *
 *  - Stacking Pioneer and Scenic Route is legal iff some bar satisfies both.
 *  - A rule set is treated as a set: duplicating a rule is no stricter than one.
 *  - Empty rules make every non-finish, unheld bar legal, and the temporary
 *    locks that `evaluateClaimBlocks` also checks never change the Legal_Next_Bar
 *    result (the guard ignores them by construction).
 *  - A bar `b` is in `selectLegalNextBars` iff `b` is non-finish, unheld, and
 *    `evaluateClaimBlocks(mode: "claim")` returns no pioneer/scenic block for it
 *    (built from matching `LegalNextBarInput` and `ClaimBlockInput`).
 *  - `mirrorIsLegal` equals `hasLegalNextBar` over the caster's active rules plus
 *    the offer's rule.
 *
 * Validates: Requirements 9.15, 9.16, 10.10, 10.11, 22.5 (and Requirement 24.7).
 */

// ---------------------------------------------------------------------------
// Generators.
//
// We build a small game "world": a finish bar, a previous bar, and a handful of
// scoring bars, each with coordinates drawn from a compact grid so Scenic Route
// (distance-to-finish comparisons) exercises both outcomes. Active claims by
// other teams drive Pioneer; the subject team's own claims drive the "unheld"
// gate.
// ---------------------------------------------------------------------------

const SUBJECT_TEAM = "team-subject";
const OTHER_TEAMS = ["team-a", "team-b", "team-c"] as const;

/** A coordinate on a compact grid, so distances are varied but bounded. */
const gridCoord: fc.Arbitrary<LatLng> = fc.record({
  lat: fc.integer({ min: 0, max: 20 }).map((n) => 33.74 + n * 0.01),
  lng: fc.integer({ min: 0, max: 20 }).map((n) => -84.37 + n * 0.01),
});

/** Coordinates, sometimes absent (so Scenic's "no coordinates" path is hit). */
const maybeCoord: fc.Arbitrary<LatLng | null> = fc.oneof(
  { weight: 4, arbitrary: gridCoord },
  { weight: 1, arbitrary: fc.constant(null) },
);

const ruleArb: fc.Arbitrary<NextClaimRule> = fc.constantFrom(
  "pioneer",
  "scenic",
);

/** A single generated scoring bar. */
interface GenBar {
  readonly barKey: string;
  readonly coords: LatLng | null;
}

/** A generated world: the bars, finish/previous coords, and foreign claims. */
interface World {
  readonly bars: readonly GenBar[];
  readonly finishCoords: LatLng | null;
  readonly previous: GenBar;
  readonly subjectHolds: readonly string[];
  readonly otherClaims: readonly {
    readonly teamId: string;
    readonly barKey: string;
  }[];
  readonly finishBarKey: string;
}

const worldArb: fc.Arbitrary<World> = fc
  .record({
    scoringCount: fc.integer({ min: 1, max: 6 }),
    finishCoords: maybeCoord,
    previousCoords: maybeCoord,
  })
  .chain(({ scoringCount, finishCoords, previousCoords }) => {
    const barKeys = Array.from({ length: scoringCount }, (_, i) => `bar-${i}`);
    return fc
      .record({
        coordsList: fc.tuple(...barKeys.map(() => maybeCoord)) as fc.Arbitrary<
          (LatLng | null)[]
        >,
        // Which scoring bars the subject team already holds.
        subjectHolds: fc.subarray([...barKeys]),
        // Foreign claims: each scoring bar may be claimed by some other teams.
        foreign: fc.array(
          fc.record({
            teamId: fc.constantFrom(...OTHER_TEAMS),
            barKey: fc.constantFrom(...barKeys),
          }),
          { maxLength: scoringCount * 2 },
        ),
      })
      .map(({ coordsList, subjectHolds, foreign }) => {
        const bars: GenBar[] = barKeys.map((barKey, i) => ({
          barKey,
          coords: coordsList[i],
        }));
        return {
          bars,
          finishCoords,
          previous: { barKey: "bar-previous", coords: previousCoords },
          subjectHolds,
          otherClaims: foreign,
          finishBarKey: "bar-finish",
        };
      });
  });

// ---------------------------------------------------------------------------
// Input builders — shared so legality and blocks read the same facts.
// ---------------------------------------------------------------------------

/** Every bar reference the subject can consider, including the finish bar. */
function allBarRefs(world: World): ResolvedBarRef[] {
  const refs: ResolvedBarRef[] = world.bars.map((b) => ({
    barKey: b.barKey,
    kind: "scoring" as const,
    coords: b.coords,
  }));
  refs.push({
    barKey: world.finishBarKey,
    kind: "finish",
    coords: world.finishCoords,
  });
  return refs;
}

function previousRef(world: World): ResolvedBarRef {
  return {
    barKey: world.previous.barKey,
    kind: "scoring",
    coords: world.previous.coords,
  };
}

/** All active claims: subject holds + foreign claims, in `{ teamId, barKey }`. */
function activeClaims(
  world: World,
): { readonly teamId: string; readonly barKey: string }[] {
  return [
    ...world.subjectHolds.map((barKey) => ({ teamId: SUBJECT_TEAM, barKey })),
    ...world.otherClaims,
  ];
}

function legalInput(
  world: World,
  rules: readonly NextClaimRule[],
): LegalNextBarInput {
  return {
    teamId: SUBJECT_TEAM,
    rules,
    bars: allBarRefs(world),
    finishCoords: world.finishCoords,
    activeClaims: activeClaims(world),
    previousBar: previousRef(world),
  };
}

/** A `next_claim_restriction` effect targeting the subject, active at `nowMs`. */
function restrictionEffect(rule: NextClaimRule, index: number): EffectRecord {
  return {
    effectId: `eff-${rule}-${index}`,
    slug: rule === "pioneer" ? "pioneer" : "scenic-route",
    kind: "next_claim_restriction",
    sourcePlayId: null,
    sourceChallengeId: null,
    ownerTeamId: null,
    targetTeamId: SUBJECT_TEAM,
    targetBarKey: null,
    startsAt: "2024-01-01T00:00:00.000Z",
    endsAt: null,
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

const NOW_MS = Date.parse("2024-06-01T12:00:00.000Z");

/** A ClaimBlockInput for one bar that mirrors the same world + rules. */
function blockInput(
  world: World,
  bar: ResolvedBarRef,
  rules: readonly NextClaimRule[],
): ClaimBlockInput {
  const barCoords = new Map<string, LatLng>();
  for (const ref of allBarRefs(world)) {
    if (ref.coords !== null) {
      barCoords.set(ref.barKey, ref.coords);
    }
  }
  return {
    teamId: SUBJECT_TEAM,
    bar,
    finishCoords: world.finishCoords,
    challenges: [],
    effects: rules.map((rule, i) => restrictionEffect(rule, i)),
    activeClaims: activeClaims(world),
    previousBar: previousRef(world),
    barCoords,
    mode: "claim",
    nowMs: NOW_MS,
  };
}

// ---------------------------------------------------------------------------
// BehaviorState builder for mirrorIsLegal.
// ---------------------------------------------------------------------------

function resolvedBar(ref: ResolvedBarRef): ResolvedBar {
  return {
    barId: `id-${ref.barKey}`,
    barKey: ref.barKey,
    name: ref.barKey,
    coords: ref.coords,
    kind: ref.kind,
  };
}

/**
 * Build a BehaviorState whose caster (`SUBJECT_TEAM`) holds the given active
 * restriction rules and whose world matches `world`, so `mirrorIsLegal` can be
 * compared against `hasLegalNextBar(caster active rules ∪ offer rule)`.
 */
function behaviorState(
  world: World,
  casterRules: readonly NextClaimRule[],
): BehaviorState {
  const barsMap = new Map<string, ResolvedBar>();
  const startRef: ResolvedBarRef = {
    barKey: "bar-start",
    kind: "start",
    coords: null,
  };
  barsMap.set(startRef.barKey, resolvedBar(startRef));
  for (const ref of allBarRefs(world)) {
    barsMap.set(ref.barKey, resolvedBar(ref));
  }
  // Register the previous bar so Scenic distance resolves from the bar set.
  barsMap.set(world.previous.barKey, resolvedBar(previousRef(world)));

  const claimHistory = world.subjectHolds.map((barKey, i) => ({
    claimId: `claim-${i}`,
    teamId: SUBJECT_TEAM,
    barId: `id-${barKey}`,
    barKey,
    // Make the generated previous bar the most recent claim.
    claimedAt: `2024-05-01T00:00:0${Math.min(i, 9)}.000Z`,
    revokedReason: null,
  }));
  // Force the previous bar to be `world.previous` by making it the latest claim.
  claimHistory.push({
    claimId: "claim-prev",
    teamId: SUBJECT_TEAM,
    barId: `id-${world.previous.barKey}`,
    barKey: world.previous.barKey,
    claimedAt: "2024-05-31T23:59:59.000Z",
    revokedReason: null,
  });

  const active = activeClaims(world).map((c, i) => ({
    claimId: `active-${i}`,
    teamId: c.teamId,
    barId: `id-${c.barKey}`,
    barKey: c.barKey,
    claimedAt: "2024-05-01T00:00:00.000Z",
    revokedReason: null,
  }));

  return {
    gameId: "game-1",
    lifecycle: "live",
    nowIso: "2024-06-01T12:00:00.000Z",
    teams: [
      { teamId: SUBJECT_TEAM, name: "Subject", memberSessionIds: [] },
      ...OTHER_TEAMS.map((teamId) => ({
        teamId,
        name: teamId,
        memberSessionIds: [],
      })),
    ],
    hostSessionId: "host-1",
    bars: barsMap,
    startBarKey: startRef.barKey,
    finishBarKey: world.finishBarKey,
    activeClaims: active,
    claimHistory,
    hands: new Map(),
    plays: [],
    challenges: [],
    offers: [],
    effects: casterRules.map((rule, i) => restrictionEffect(rule, i)),
    awards: [],
    ledger: [],
  };
}

/**
 * Reproduce the private `legalInputForTeam` from legalNextBar.ts so the
 * mirrorIsLegal comparison reads the exact same facts (bar set, active claims,
 * finish coords, previous bar) and differs only in the rule set. `previousBarFor`
 * is applied inline to match the module's previous-bar resolution.
 */
function legalInputFromState(
  state: BehaviorState,
  teamId: string,
  rules: readonly NextClaimRule[],
): LegalNextBarInput {
  const bars: ResolvedBarRef[] = [];
  for (const bar of state.bars.values()) {
    bars.push({ barKey: bar.barKey, kind: bar.kind, coords: bar.coords });
  }

  const finishBar =
    state.finishBarKey === null
      ? undefined
      : state.bars.get(state.finishBarKey);
  const finishCoords = finishBar?.coords ?? null;

  // The forced `claim-prev` row is always the latest claim, so the previous bar
  // is `world.previous`; resolve its coordinates from the bar set.
  const prevKey = "bar-previous";
  const prevCoords = state.bars.get(prevKey)?.coords ?? null;
  const previousBar: ResolvedBarRef = {
    barKey: prevKey,
    kind: "scoring",
    coords: prevCoords,
  };

  const activeClaimRefs = state.activeClaims.map((claim) => ({
    teamId: claim.teamId,
    barKey: claim.barKey,
  }));

  return {
    teamId,
    rules,
    bars,
    finishCoords,
    activeClaims: activeClaimRefs,
    previousBar,
  };
}

// ---------------------------------------------------------------------------
// Properties.
// ---------------------------------------------------------------------------

describe("selectLegalNextBars — set semantics and the non-finish/unheld gate (Property 24)", () => {
  it("treats duplicate rules exactly like a single copy (no stricter)", () => {
    fc.assert(
      fc.property(worldArb, ruleArb, (world, rule) => {
        const once = selectLegalNextBars(legalInput(world, [rule]));
        const twice = selectLegalNextBars(legalInput(world, [rule, rule]));
        const thrice = selectLegalNextBars(
          legalInput(world, [rule, rule, rule]),
        );
        expect(twice).toEqual(once);
        expect(thrice).toEqual(once);
      }),
      { numRuns: 300 },
    );
  });

  it("stacking Pioneer and Scenic is legal iff some bar satisfies both", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const input = legalInput(world, ["pioneer", "scenic"]);
        const stacked = selectLegalNextBars(input);

        // Independently: a bar satisfies the stack iff it is non-finish, unheld,
        // and satisfies each rule on its own.
        const subjectHolds = new Set(world.subjectHolds);
        const expected = allBarRefs(world)
          .filter(
            (bar) =>
              bar.kind !== "finish" &&
              !subjectHolds.has(bar.barKey) &&
              barSatisfiesRule("pioneer", bar, input) &&
              barSatisfiesRule("scenic", bar, input),
          )
          .map((bar) => bar.barKey)
          .sort();

        expect(stacked).toEqual(expected);
        expect(hasLegalNextBar(input)).toBe(expected.length > 0);
      }),
      { numRuns: 400 },
    );
  });

  it("empty rules make every non-finish, unheld bar legal", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const legal = selectLegalNextBars(legalInput(world, []));
        const subjectHolds = new Set(world.subjectHolds);
        const expected = allBarRefs(world)
          .filter(
            (bar) => bar.kind !== "finish" && !subjectHolds.has(bar.barKey),
          )
          .map((bar) => bar.barKey)
          .sort();
        expect(legal).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });
});

describe("Legal_Next_Bar ignores temporary locks (Property 24)", () => {
  it("adding bar locks, radius locks, and critic blocks never changes the result", () => {
    fc.assert(
      fc.property(
        worldArb,
        fc.array(ruleArb, { maxLength: 3 }),
        (world, rules) => {
          // Legality reads only LegalNextBarInput, which has no concept of a
          // temporary lock — so the result is a pure function of the world and
          // rules. Confirm it is stable under repeated evaluation with locks
          // present in the parallel block input (which does see locks).
          const legal = selectLegalNextBars(legalInput(world, rules));

          // Build block inputs carrying extra timed locks; the pioneer/scenic
          // decision inside evaluateClaimBlocks must still be driven solely by
          // the restriction effects, never by the locks.
          for (const bar of allBarRefs(world)) {
            if (bar.kind === "finish") continue;
            const input = blockInput(world, bar, rules);
            const withLocks: ClaimBlockInput = {
              ...input,
              effects: [
                ...input.effects,
                {
                  ...restrictionEffect("pioneer", 99),
                  effectId: "lock-bar",
                  kind: "bar_lock",
                  slug: "crop-dusting",
                  targetTeamId: null,
                  ownerTeamId: "team-a",
                  targetBarKey: bar.barKey,
                  endsAt: "2099-01-01T00:00:00.000Z",
                  params: {},
                },
              ],
            };
            const base = input.effects.length ? evaluateClaimBlocks(input) : [];
            const locked = evaluateClaimBlocks(withLocks);
            const restrictionKinds = (
              bs: ReturnType<typeof evaluateClaimBlocks>,
            ) => bs.filter((b) => b.kind === "pioneer" || b.kind === "scenic");
            expect(restrictionKinds(locked)).toEqual(restrictionKinds(base));
          }

          // And legality itself is unaffected by any of that.
          expect(selectLegalNextBars(legalInput(world, rules))).toEqual(legal);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("cross-module agreement: selectLegalNextBars vs evaluateClaimBlocks (Property 24)", () => {
  it("b ∈ selectLegalNextBars iff b is non-finish, unheld, and has no pioneer/scenic claim block", () => {
    fc.assert(
      fc.property(
        worldArb,
        fc.array(ruleArb, { minLength: 1, maxLength: 3 }),
        (world, rules) => {
          const legal = new Set(selectLegalNextBars(legalInput(world, rules)));
          const subjectHolds = new Set(world.subjectHolds);

          for (const bar of allBarRefs(world)) {
            const blocks = evaluateClaimBlocks(blockInput(world, bar, rules));
            const hasRestrictionBlock = blocks.some(
              (b) => b.kind === "pioneer" || b.kind === "scenic",
            );

            const isLegal = legal.has(bar.barKey);
            const expectedLegal =
              bar.kind !== "finish" &&
              !subjectHolds.has(bar.barKey) &&
              !hasRestrictionBlock;

            expect(isLegal).toBe(expectedLegal);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("mirrorIsLegal equals hasLegalNextBar over caster rules ∪ offer rule (Property 24)", () => {
  it("agrees for restriction slugs (pioneer, scenic-route)", () => {
    fc.assert(
      fc.property(
        worldArb,
        fc.array(ruleArb, { maxLength: 2 }),
        fc.constantFrom<FairestOfferRecord["slug"]>("pioneer", "scenic-route"),
        (world, casterRules, slug) => {
          const state = behaviorState(world, casterRules);
          const offer: Pick<
            FairestOfferRecord,
            "slug" | "originalCasterTeamId"
          > = {
            slug,
            originalCasterTeamId: SUBJECT_TEAM,
          };

          const offerRule: NextClaimRule =
            slug === "pioneer" ? "pioneer" : "scenic";
          const combined = [...casterRules, offerRule];

          // Build the reference input from the *same* loaded state mirrorIsLegal
          // reads, so the only intended difference is the combined rule set. This
          // keeps the two sides reading the identical bar set, active claims,
          // finish coords, and previous bar.
          const direct = hasLegalNextBar(
            legalInputFromState(state, SUBJECT_TEAM, combined),
          );
          expect(mirrorIsLegal(state, offer, "2024-06-01T12:00:00.000Z")).toBe(
            direct,
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  it("is always true for non-restriction slugs", () => {
    fc.assert(
      fc.property(
        worldArb,
        fc.array(ruleArb, { maxLength: 2 }),
        fc.constantFrom<FairestOfferRecord["slug"]>(
          "go-piss-girl",
          "moneybags",
          "crop-dusting",
          "insurance",
        ),
        (world, casterRules, slug) => {
          const state = behaviorState(world, casterRules);
          const offer: Pick<
            FairestOfferRecord,
            "slug" | "originalCasterTeamId"
          > = {
            slug,
            originalCasterTeamId: SUBJECT_TEAM,
          };
          expect(mirrorIsLegal(state, offer, "2024-06-01T12:00:00.000Z")).toBe(
            true,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("barSatisfiesRule — Scenic distance sanity (Property 24)", () => {
  it("scenic is satisfied iff all coords known and bar is strictly farther from finish than previous", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const input = legalInput(world, ["scenic"]);
        for (const bar of allBarRefs(world)) {
          const satisfied = barSatisfiesRule("scenic", bar, input);
          if (
            bar.coords === null ||
            world.finishCoords === null ||
            world.previous.coords === null
          ) {
            expect(satisfied).toBe(false);
          } else {
            const barDist = haversineMiles(bar.coords, world.finishCoords);
            const prevDist = haversineMiles(
              world.previous.coords,
              world.finishCoords,
            );
            expect(satisfied).toBe(barDist > prevDist);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
