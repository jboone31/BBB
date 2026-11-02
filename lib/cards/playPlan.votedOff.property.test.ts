import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { planCardPlay, type PlayRequest } from "./playPlan";
import type { BehaviorState, ClaimRow, EffectRecord } from "./behaviorState";
import type { CardInstance } from "./deck";
import type { ResolvedBar } from "@/lib/map/barResolver";

/**
 * Feature: card-behavior, Property 21: Voted Off the Island removes one claim
 * without gating.
 *
 * The Voted Off resolver in {@link planCardPlay} (`lib/cards/playPlan.ts`, task
 * 3.13) is the only rule for playing Voted Off the Island. This property pins its
 * contract across arbitrary eligible worlds — 2 to 4 teams, any of them the
 * target, and any mix of Insurance protections attached to the revoked claim or
 * to other claims:
 *
 * - The play revokes **exactly one** claim: the target team's active claim on the
 *   target bar, with reason `voted_off` (18.4). No other team's claim is touched.
 * - It releases **every** active Insurance (`score_protection`) attached to that
 *   revoked claim, and only those (18.4 / 18.7).
 * - It reconciles the target bar so remaining claimants re-split its share.
 * - It opens **no** challenge and raises **no** Fairest offer — the target is not
 *   gated (18.5), so it is free to claim again (18.6, modeled by the revocation
 *   not emitting any block or restriction against a future claim).
 *
 * Eligibility is real: the 3.12 selector only allows Voted Off against a
 * non-start, non-finish bar that *every* team in the game actively holds, so the
 * generator builds exactly that world and the play is always accepted. The
 * expected revoked claim and released protections are computed independently from
 * the generated rows, so the resolver is checked against the rule, not itself.
 *
 * Validates: Requirements 18.4, 18.5, 18.6
 */

// ---------------------------------------------------------------------------
// Fixtures and builders.
// ---------------------------------------------------------------------------

const BASE_MS = Date.parse("2025-06-01T18:00:00.000Z");
const NOW_MS = BASE_MS + 30 * 60_000;
const NOW_ISO = new Date(NOW_MS).toISOString();
const iso = (ms: number): string => new Date(ms).toISOString();

const VOTED_OFF_SLUG = "voted-off-the-island";
const TARGET_BAR = "bar-shared";
const START_BAR = "bar-start";
const FINISH_BAR = "bar-finish";

/** All candidate team ids; a run uses a prefix of 2 to 4 of these. */
const ALL_TEAMS = ["team-a", "team-b", "team-c", "team-d"] as const;

/** A scoring bar with resolvable coordinates, keyed by `barKey`. */
function scoringBar(barKey: string): ResolvedBar {
  return {
    barKey,
    barId: `id-${barKey}`,
    name: barKey,
    kind: "scoring",
    coords: { lat: 33.75, lng: -84.37 },
  };
}

/** A base effect row; callers override the fields the test cares about. */
function effect(overrides: Partial<EffectRecord>): EffectRecord {
  return {
    effectId: "eff",
    slug: "insurance",
    kind: "score_protection",
    sourcePlayId: null,
    sourceChallengeId: null,
    ownerTeamId: null,
    targetTeamId: null,
    targetBarKey: null,
    startsAt: iso(BASE_MS),
    endsAt: null,
    params: {},
    attachedClaimId: null,
    attachedBarKey: null,
    protectedPoints: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    startAnnounced: true,
    endAnnounced: false,
    ...overrides,
  };
}

/** The claim id a team holds on the shared target bar. */
const claimId = (teamId: string): string => `claim-${teamId}`;

/**
 * Build a live {@link BehaviorState} where every team in `teams` actively holds
 * the shared target bar (so Voted Off is eligible) and the caster holds the
 * Voted Off card in hand. `effects` carries the Insurance protections under test.
 */
function makeState(
  teams: readonly string[],
  casterTeamId: string,
  effects: readonly EffectRecord[],
): BehaviorState {
  const bars = new Map<string, ResolvedBar>([
    [TARGET_BAR, scoringBar(TARGET_BAR)],
    [START_BAR, { ...scoringBar(START_BAR), kind: "start" }],
    [FINISH_BAR, { ...scoringBar(FINISH_BAR), kind: "finish" }],
  ]);

  // Every team claims the shared bar, so the 3.12 selector marks it eligible.
  const activeClaims: ClaimRow[] = teams.map((teamId) => ({
    claimId: claimId(teamId),
    teamId,
    barId: `id-${TARGET_BAR}`,
    barKey: TARGET_BAR,
    claimedAt: iso(BASE_MS + 60_000),
    revokedReason: null,
  }));

  const hand: CardInstance[] = [
    {
      id: `${casterTeamId}:${VOTED_OFF_SLUG}`,
      slug: VOTED_OFF_SLUG,
      state: "hand",
      position: 0,
    },
  ];

  return {
    gameId: "game-1",
    lifecycle: "live",
    nowIso: NOW_ISO,
    teams: teams.map((teamId) => ({
      teamId,
      name: teamId,
      memberSessionIds: [],
    })),
    hostSessionId: "host",
    bars,
    startBarKey: START_BAR,
    finishBarKey: FINISH_BAR,
    activeClaims,
    claimHistory: activeClaims,
    hands: new Map([[casterTeamId, { hand, pending: [] }]]),
    plays: [],
    challenges: [],
    offers: [],
    effects,
    awards: [],
    ledger: [],
  };
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/** 2 to 4 distinct teams, in a fixed prefix order. */
const teamsArb: fc.Arbitrary<readonly string[]> = fc
  .integer({ min: 2, max: 4 })
  .map((n) => ALL_TEAMS.slice(0, n));

/**
 * An Insurance protection in one of several states. `attachedTo` chooses which
 * team's claim it protects (or none); `state` chooses whether it is still active.
 * Only an active protection attached to the *revoked* claim should be released.
 */
const protectionArb = (
  index: number,
  teams: readonly string[],
): fc.Arbitrary<EffectRecord> =>
  fc
    .record({
      attachedTo: fc.constantFrom<string | null>(null, ...teams),
      state: fc.constantFrom("active", "cancelled", "consumed"),
    })
    .map(({ attachedTo, state }) =>
      effect({
        effectId: `ins-${index}`,
        slug: "insurance",
        kind: "score_protection",
        attachedClaimId: attachedTo === null ? null : claimId(attachedTo),
        cancelledAt: state === "cancelled" ? iso(NOW_MS - 60_000) : null,
        consumedAt: state === "consumed" ? iso(NOW_MS - 60_000) : null,
      }),
    );

// ---------------------------------------------------------------------------
// Reference computation (independent of the resolver).
// ---------------------------------------------------------------------------

/**
 * The protection ids the rule says a Voted Off play on `target` should release:
 * every active Insurance attached to the target's revoked claim on the bar.
 */
function expectedReleased(
  effects: readonly EffectRecord[],
  target: string,
): Set<string> {
  const revoked = claimId(target);
  const ids = new Set<string>();
  for (const e of effects) {
    if (
      e.kind === "score_protection" &&
      e.attachedClaimId === revoked &&
      e.cancelledAt === null &&
      e.consumedAt === null
    ) {
      ids.add(e.effectId);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Property.
// ---------------------------------------------------------------------------

describe("planCardPlay — Voted Off the Island removes one claim without gating (Property 21)", () => {
  it("revokes exactly the target's claim as voted_off, releases its Insurance, reconciles, and gates nobody (18.4, 18.5, 18.6)", () => {
    fc.assert(
      fc.property(
        teamsArb.chain((teams) =>
          fc.record({
            teams: fc.constant(teams),
            // Caster and target are two distinct teams (Voted Off excludes self).
            casterIndex: fc.integer({ min: 0, max: teams.length - 1 }),
            targetOffset: fc.integer({ min: 1, max: teams.length - 1 }),
            effects: fc.array(
              fc.nat(3).chain((i) => protectionArb(i, teams)),
              { maxLength: 5 },
            ),
          }),
        ),
        ({ teams, casterIndex, targetOffset, effects }) => {
          const caster = teams[casterIndex];
          const target = teams[(casterIndex + targetOffset) % teams.length];
          // Give each generated effect a unique id regardless of collisions.
          const uniqueEffects = effects.map((e, i) => ({
            ...e,
            effectId: `${e.effectId}-${i}`,
          }));

          const state = makeState(teams, caster, uniqueEffects);
          const req: PlayRequest = {
            cardId: `${caster}:${VOTED_OFF_SLUG}`,
            casterTeamId: caster,
            targetTeamId: target,
            targetBarKey: TARGET_BAR,
          };

          const result = planCardPlay(state, req, NOW_ISO);

          // The world is eligible (every team holds the non-start/finish bar), so
          // the play is always accepted.
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const plan = result.plan;

          // 18.4: exactly one claim revoked — the target's — with reason voted_off.
          expect(plan.revokeClaims).toEqual([
            { claimId: claimId(target), reason: "voted_off" },
          ]);

          // 18.4 / 18.7: releases exactly the active Insurance on the revoked claim.
          expect(new Set(plan.releaseProtections)).toEqual(
            expectedReleased(uniqueEffects, target),
          );
          expect(plan.releaseProtections.length).toBe(
            new Set(plan.releaseProtections).size,
          );

          // The target bar is reconciled so survivors re-split the share.
          expect(plan.reconcileBars).toEqual([TARGET_BAR]);

          // 18.5 / 18.6: no challenge, no offer, no next-claim restriction — the
          // target is not gated and nothing blocks a future re-claim.
          expect(plan.challenges).toEqual([]);
          expect(plan.offers).toEqual([]);
          expect(plan.effects).toEqual([]);
        },
      ),
      { numRuns: 500 },
    );
  });
});
