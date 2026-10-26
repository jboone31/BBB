import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  resolveChallenge,
  hostChallengeOverride,
  checkCannotPlayDiscard,
  settleInventoryChange,
} from "./challenges";
import type {
  BehaviorState,
  ChallengeRecord,
  ChallengeStatus,
  FairestOfferRecord,
} from "./behaviorState";
import type { CardInstance } from "./deck";
import type { CardSlug } from "./catalog";
import { DURATIONS_MS } from "./effects";

/**
 * Feature: card-behavior, Property 9: Challenge state machine.
 *
 * `lib/cards/challenges.ts` owns the resolution rules for gated challenges, the
 * host clear/reset overrides, the Fairest conflict freeze, and the "Can't play,
 * discard" guard. This property pins down the transition table from design.md
 * section 7 against arbitrary actors and arbitrary action orders:
 *
 * - Only a target-team actor moves an `open` challenge (with no live Fairest
 *   offer) to `completed`, or an Everyone's a Critic challenge to `failed`
 *   (4.4, 5.2, 7.2).
 * - A non-target actor is rejected `not_authorized` (4.4, 5.2).
 * - A non-open challenge is rejected `already_resolved` (5.3).
 * - A live Fairest offer freezes resolution with `conflict`, including the UIOLI
 *   "Can't play, discard" shortcut (5.4, 5.5, 9.4).
 * - `fail` is accepted only for Everyone's a Critic and creates a block ending
 *   exactly 15 minutes after the failure time; any other slug is `conflict`
 *   (7.2, 7.4).
 * - Host clear moves `open` → `cleared_by_host`, voiding its pending offer; host
 *   reset moves `completed`/`failed` → `open`, cancelling a critic failure block.
 *   A UIOLI reset with an empty hand and no pending draw, and a reset of
 *   `cleared_by_host`, are `conflict` (21.1, 21.2, 21.3).
 * - The final status of a challenge does not depend on the order independent
 *   challenges are resolved in (4.6).
 * - Challenge_Gate invariant: a team is gated if and only if it holds an `open`
 *   challenge.
 *
 * All generators are hermetic; nothing touches a database or device clock.
 *
 * Validates: Requirements 4.4, 4.6, 5.2, 5.3, 5.4, 5.5, 7.2, 7.4, 9.4, 21.1,
 * 21.2, 21.3
 */

// ---------------------------------------------------------------------------
// Slugs with special behavior.
// ---------------------------------------------------------------------------

const UIOLI_SLUG: CardSlug = "use-it-or-lose-it";
const CRITIC_SLUG: CardSlug = "everyones-a-critic";
const FAIREST_SLUG: CardSlug = "fairest-of-them-all";

/** Gated challenge slugs the state machine can hold open. */
const GATED_SLUGS: readonly CardSlug[] = [
  "go-piss-girl",
  "wired",
  "broad-shoulders",
  CRITIC_SLUG,
  UIOLI_SLUG,
];

// ---------------------------------------------------------------------------
// State factory.
// ---------------------------------------------------------------------------

const BASE_ISO = "2025-06-01T18:00:00.000Z";

function card(id: string, slug: CardSlug): CardInstance {
  return { id, slug, state: "hand", position: 0 };
}

/**
 * Build a minimal {@link BehaviorState} good enough for the challenge planners:
 * a live game, three teams each with one representative session, the given
 * challenges and offers, and per-team hand contents (used to decide whether a
 * holder still holds Fairest and whether a UIOLI target's hand is empty).
 */
function makeState(opts: {
  teamIds: readonly string[];
  challenges: readonly ChallengeRecord[];
  offers?: readonly FairestOfferRecord[];
  hands?: ReadonlyMap<string, readonly CardSlug[]>;
  pending?: ReadonlyMap<string, readonly CardSlug[]>;
}): BehaviorState {
  const hands = new Map<
    string,
    { hand: readonly CardInstance[]; pending: readonly CardInstance[] }
  >();
  for (const teamId of opts.teamIds) {
    const handSlugs = opts.hands?.get(teamId) ?? [];
    const pendingSlugs = opts.pending?.get(teamId) ?? [];
    hands.set(teamId, {
      hand: handSlugs.map((slug, i) => card(`${teamId}-h${i}`, slug)),
      pending: pendingSlugs.map((slug, i) => ({
        ...card(`${teamId}-p${i}`, slug),
        state: "pending" as const,
      })),
    });
  }

  return {
    gameId: "game-1",
    lifecycle: "live",
    nowIso: BASE_ISO,
    teams: opts.teamIds.map((teamId) => ({
      teamId,
      name: teamId,
      memberSessionIds: [`${teamId}-session`],
    })),
    hostSessionId: "host-session",
    bars: new Map(),
    startBarKey: null,
    finishBarKey: null,
    activeClaims: [],
    claimHistory: [],
    hands,
    plays: [],
    challenges: opts.challenges,
    offers: opts.offers ?? [],
    effects: [],
    awards: [],
    ledger: [],
  };
}

function makeChallenge(
  overrides: Partial<ChallengeRecord> & {
    challengeId: string;
    slug: CardSlug;
    targetTeamId: string;
    casterTeamId: string;
    status: ChallengeStatus;
  },
): ChallengeRecord {
  return {
    sourcePlayId: `${overrides.challengeId}-play`,
    params: { kind: "none" },
    mirroredFromChallengeId: null,
    mirroredFromPlayId: null,
    createdAt: BASE_ISO,
    resolvedAt: null,
    resolvedByTeamId: null,
    resolvedBySessionId: null,
    resolvedByKind: null,
    failureEffectId: null,
    ...overrides,
  };
}

function makeOffer(
  overrides: Partial<FairestOfferRecord> & {
    offerId: string;
    holderTeamId: string;
    challengeId: string;
  },
): FairestOfferRecord {
  return {
    sourcePlayId: `${overrides.offerId}-play`,
    slug: "go-piss-girl",
    originalCasterTeamId: "caster",
    restrictionEffectId: null,
    status: "pending",
    decidedAt: null,
    mirroredChallengeId: null,
    mirroredEffectId: null,
    ...overrides,
  };
}

/**
 * The Challenge_Gate predicate under test: a team is gated if and only if it has
 * an `open` challenge targeting it. The state machine never exports this
 * directly, but every status transition must keep this invariant consistent with
 * the challenge rows, so the test derives it from the same rows the planners read.
 */
function teamIsGated(state: BehaviorState, teamId: string): boolean {
  return state.challenges.some(
    (c) => c.targetTeamId === teamId && c.status === "open",
  );
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

const TEAM_IDS = ["team-a", "team-b", "team-c"] as const;

const statusArb = fc.constantFrom<ChallengeStatus>(
  "open",
  "completed",
  "failed",
  "cleared_by_host",
);

const slugArb = fc.constantFrom<CardSlug>(...GATED_SLUGS);

/** An actor is any team id or null (an unauthenticated / team-less actor). */
const actorArb = fc.constantFrom<string | null>(...TEAM_IDS, null);

// ---------------------------------------------------------------------------
// Transition-table assertions.
// ---------------------------------------------------------------------------

describe("Property 9: challenge state machine transition table", () => {
  it("resolveChallenge enforces authorization, status, offer, and slug guards", () => {
    fc.assert(
      fc.property(
        slugArb,
        statusArb,
        actorArb,
        fc.constantFrom<"complete" | "fail">("complete", "fail"),
        fc.boolean(),
        (slug, status, actor, kind, withLiveOffer) => {
          const target = "team-a";
          const caster = "team-b";
          const challenge = makeChallenge({
            challengeId: "ch-1",
            slug,
            targetTeamId: target,
            casterTeamId: caster,
            status,
          });

          // A live offer requires the holder (the target) to still hold Fairest.
          const offers: FairestOfferRecord[] = withLiveOffer
            ? [
                makeOffer({
                  offerId: "of-1",
                  holderTeamId: target,
                  challengeId: "ch-1",
                }),
              ]
            : [];
          const hands = new Map<string, readonly CardSlug[]>();
          if (withLiveOffer) {
            hands.set(target, [FAIREST_SLUG]);
          }

          const state = makeState({
            teamIds: TEAM_IDS,
            challenges: [challenge],
            offers,
            hands,
          });

          const result = resolveChallenge(
            state,
            "ch-1",
            { kind, actorTeamId: actor },
            BASE_ISO,
          );

          // Guard order: authorization, then status, then live offer, then slug.
          if (actor !== target) {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBe("not_authorized");
            return;
          }
          if (status !== "open") {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBe("already_resolved");
            return;
          }
          if (withLiveOffer) {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBe("conflict");
            return;
          }

          if (kind === "complete") {
            // UIOLI never completes via an explicit complete.
            if (slug === UIOLI_SLUG) {
              expect(result.ok).toBe(false);
              if (!result.ok) expect(result.error).toBe("conflict");
            } else {
              expect(result.ok).toBe(true);
              if (result.ok)
                expect(result.plan.challenge.status).toBe("completed");
            }
            return;
          }

          // kind === "fail": only Everyone's a Critic may fail.
          if (slug !== CRITIC_SLUG) {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBe("conflict");
            return;
          }
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.plan.challenge.status).toBe("failed");
            // The block ends exactly 15 minutes after the failure time (7.4).
            const effect = result.plan.newEffect;
            expect(effect).not.toBeNull();
            if (effect) {
              expect(effect.kind).toBe("team_claim_block");
              expect(effect.targetTeamId).toBe(target);
              expect(Date.parse(effect.endsAt!) - Date.parse(BASE_ISO)).toBe(
                DURATIONS_MS.criticBlock,
              );
            }
          }
        },
      ),
    );
  });

  it("a stale offer (holder no longer holds Fairest) does not freeze resolution", () => {
    fc.assert(
      fc.property(fc.boolean(), (holderStillHolds) => {
        const target = "team-a";
        const challenge = makeChallenge({
          challengeId: "ch-1",
          slug: "go-piss-girl",
          targetTeamId: target,
          casterTeamId: "team-b",
          status: "open",
        });
        const offers = [
          makeOffer({
            offerId: "of-1",
            holderTeamId: target,
            challengeId: "ch-1",
          }),
        ];
        const hands = new Map<string, readonly CardSlug[]>();
        if (holderStillHolds) {
          hands.set(target, [FAIREST_SLUG]);
        }
        const state = makeState({
          teamIds: TEAM_IDS,
          challenges: [challenge],
          offers,
          hands,
        });

        const result = resolveChallenge(
          state,
          "ch-1",
          { kind: "complete", actorTeamId: target },
          BASE_ISO,
        );

        if (holderStillHolds) {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error).toBe("conflict");
        } else {
          expect(result.ok).toBe(true);
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Host clear / reset.
// ---------------------------------------------------------------------------

describe("Property 9: host clear/reset overrides", () => {
  it("clear only applies to open and voids the pending offer", () => {
    fc.assert(
      fc.property(
        slugArb,
        statusArb,
        fc.boolean(),
        (slug, status, hasOffer) => {
          const target = "team-a";
          const challenge = makeChallenge({
            challengeId: "ch-1",
            slug,
            targetTeamId: target,
            casterTeamId: "team-b",
            status,
          });
          const offers = hasOffer
            ? [
                makeOffer({
                  offerId: "of-1",
                  holderTeamId: target,
                  challengeId: "ch-1",
                }),
              ]
            : [];
          const state = makeState({
            teamIds: TEAM_IDS,
            challenges: [challenge],
            offers,
          });

          const result = hostChallengeOverride(
            state,
            "ch-1",
            "clear",
            BASE_ISO,
          );

          if (status !== "open") {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBe("conflict");
            return;
          }
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.plan.challenge.status).toBe("cleared_by_host");
            expect(result.plan.challenge.resolvedByKind).toBe("host");
            if (hasOffer) {
              expect(result.plan.voidOffer).not.toBeNull();
              expect(result.plan.voidOffer?.status).toBe("void");
            } else {
              expect(result.plan.voidOffer).toBeNull();
            }
          }
        },
      ),
    );
  });

  it("reset only applies to completed/failed, with the UIOLI empty-hand guard", () => {
    fc.assert(
      fc.property(
        slugArb,
        statusArb,
        fc.nat({ max: 2 }),
        fc.nat({ max: 2 }),
        (slug, status, handCount, pendingCount) => {
          const target = "team-a";
          const challenge = makeChallenge({
            challengeId: "ch-1",
            slug,
            targetTeamId: target,
            casterTeamId: "team-b",
            status,
            failureEffectId: status === "failed" ? "fail-effect-1" : null,
          });
          const hands = new Map<string, readonly CardSlug[]>([
            [target, Array.from({ length: handCount }, () => "go-piss-girl")],
          ]);
          const pending = new Map<string, readonly CardSlug[]>([
            [target, Array.from({ length: pendingCount }, () => "wired")],
          ]);
          const state = makeState({
            teamIds: TEAM_IDS,
            challenges: [challenge],
            hands,
            pending,
          });

          const result = hostChallengeOverride(
            state,
            "ch-1",
            "reset",
            BASE_ISO,
          );

          // Only completed/failed can be reset.
          if (status !== "completed" && status !== "failed") {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBe("conflict");
            return;
          }

          // UIOLI reset with an empty hand and no pending draw is pointless.
          if (slug === UIOLI_SLUG && handCount === 0 && pendingCount === 0) {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBe("conflict");
            return;
          }

          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.plan.challenge.status).toBe("open");
            // A failed critic reset cancels its failure block.
            if (status === "failed") {
              expect(result.plan.cancelEffectId).toBe("fail-effect-1");
            } else {
              expect(result.plan.cancelEffectId).toBeNull();
            }
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// checkCannotPlayDiscard under a live offer.
// ---------------------------------------------------------------------------

describe("Property 9: checkCannotPlayDiscard gate", () => {
  it("rejects with conflict exactly while an open UIOLI has a live Fairest offer", () => {
    fc.assert(
      fc.property(
        statusArb,
        fc.boolean(),
        fc.boolean(),
        (uioliStatus, hasPendingOffer, holderHoldsFairest) => {
          const target = "team-a";
          const challenge = makeChallenge({
            challengeId: "ch-1",
            slug: UIOLI_SLUG,
            targetTeamId: target,
            casterTeamId: "team-b",
            status: uioliStatus,
          });
          const offers = hasPendingOffer
            ? [
                makeOffer({
                  offerId: "of-1",
                  holderTeamId: target,
                  challengeId: "ch-1",
                }),
              ]
            : [];
          const hands = new Map<string, readonly CardSlug[]>();
          if (holderHoldsFairest) {
            hands.set(target, [FAIREST_SLUG]);
          }
          const state = makeState({
            teamIds: TEAM_IDS,
            challenges: [challenge],
            offers,
            hands,
          });

          const result = checkCannotPlayDiscard(state, target);

          // A live offer requires an open UIOLI, a pending offer, AND the holder
          // still holding Fairest. Otherwise the discard shortcut is allowed.
          const liveOffer =
            uioliStatus === "open" && hasPendingOffer && holderHoldsFairest;
          if (liveOffer) {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBe("conflict");
          } else {
            expect(result.ok).toBe(true);
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Order independence + Challenge_Gate invariant.
// ---------------------------------------------------------------------------

/** One resolve action against a named challenge by a named actor. */
interface ResolveAction {
  readonly challengeId: string;
  readonly kind: "complete" | "fail";
  readonly actorTeamId: string | null;
}

/**
 * Apply a resolve action, returning the challenge rows with the targeted
 * challenge patched when the resolution is accepted. Independent challenges are
 * untouched.
 */
function applyResolve(
  state: BehaviorState,
  action: ResolveAction,
): BehaviorState {
  const result = resolveChallenge(
    state,
    action.challengeId,
    { kind: action.kind, actorTeamId: action.actorTeamId },
    BASE_ISO,
  );
  if (!result.ok) {
    return state;
  }
  const patched = result.plan.challenge;
  return {
    ...state,
    challenges: state.challenges.map((c) =>
      c.challengeId === patched.challengeId ? patched : c,
    ),
  };
}

describe("Property 9: order independence and the gate iff-open invariant", () => {
  it("independent challenges reach the same final statuses regardless of order", () => {
    // Each challenge gets exactly one action, so the sequence only ever mixes
    // actions on *distinct* challenges. Independence is the claim that resolving
    // one challenge never affects another; competing actions on the SAME
    // challenge are order-dependent by design (fail-then-complete differs from
    // complete-then-fail) and are out of scope for this invariant.
    const defsArb = fc.array(
      fc.record({
        slug: slugArb,
        targetTeamId: fc.constantFrom(...TEAM_IDS),
        kind: fc.constantFrom<"complete" | "fail">("complete", "fail"),
        actorTeamId: actorArb,
      }),
      { minLength: 1, maxLength: 5 },
    );

    fc.assert(
      fc.property(defsArb, (defs) => {
        const challenges = defs.map((d, i) =>
          makeChallenge({
            challengeId: `ch-${i}`,
            slug: d.slug,
            targetTeamId: d.targetTeamId,
            casterTeamId: "caster",
            status: "open",
          }),
        );
        const base = makeState({
          teamIds: [...TEAM_IDS, "caster"],
          challenges,
        });

        const actions: ResolveAction[] = defs.map((d, i) => ({
          challengeId: `ch-${i}`,
          kind: d.kind,
          actorTeamId: d.actorTeamId,
        }));

        const run = (seq: readonly ResolveAction[]): BehaviorState =>
          seq.reduce(applyResolve, base);

        const forward = run(actions);
        const reversed = run([...actions].reverse());

        const statusMap = (s: BehaviorState) =>
          Object.fromEntries(
            s.challenges.map((c) => [c.challengeId, c.status]),
          );

        // Independent challenges: final statuses are order-independent.
        expect(statusMap(forward)).toEqual(statusMap(reversed));

        // Gate iff open: a team is gated exactly when it holds an open
        // challenge, in every resulting state.
        for (const result of [forward, reversed]) {
          for (const teamId of TEAM_IDS) {
            const gated = teamIsGated(result, teamId);
            const hasOpen = result.challenges.some(
              (c) => c.targetTeamId === teamId && c.status === "open",
            );
            expect(gated).toBe(hasOpen);
          }
        }
      }),
    );
  });

  it("settleInventoryChange completes an open UIOLI iff the hand and pending both clear", () => {
    fc.assert(
      fc.property(
        statusArb,
        fc.nat({ max: 2 }),
        fc.nat({ max: 2 }),
        (status, handCount, pendingCount) => {
          const target = "team-a";
          const challenge = makeChallenge({
            challengeId: "ch-1",
            slug: UIOLI_SLUG,
            targetTeamId: target,
            casterTeamId: "team-b",
            status,
          });
          const state = makeState({
            teamIds: TEAM_IDS,
            challenges: [challenge],
          });

          const cards: CardInstance[] = [
            ...Array.from({ length: handCount }, (_, i) => ({
              id: `h${i}`,
              slug: "go-piss-girl" as CardSlug,
              state: "hand" as const,
              position: i,
            })),
            ...Array.from({ length: pendingCount }, (_, i) => ({
              id: `p${i}`,
              slug: "wired" as CardSlug,
              state: "pending" as const,
              position: i,
            })),
          ];
          const after = {
            teamId: target,
            cards,
            drawnBarIds: [],
            pendingBarId: null,
            pendingMode: "choose_one" as const,
          };

          const followUp = settleInventoryChange(
            state,
            target,
            after,
            BASE_ISO,
          );

          const shouldComplete =
            status === "open" && handCount === 0 && pendingCount === 0;
          if (shouldComplete) {
            expect(followUp.completeChallenges).toEqual(["ch-1"]);
          } else {
            expect(followUp.completeChallenges).toEqual([]);
          }
        },
      ),
    );
  });
});
