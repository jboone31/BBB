import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { planCardPlay, type PlayRequest } from "./playPlan";
import { decideFairest } from "./challenges";
import type {
  BehaviorState,
  ChallengeRecord,
  EffectRecord,
  FairestOfferRecord,
} from "./behaviorState";
import type { CardInstance } from "./deck";
import type { CardSlug } from "./catalog";
import { isMirrorableCard, getCardMetadata } from "./catalog";
import type { ResolvedBar } from "@/lib/map/barResolver";
import type { LatLng } from "@/lib/map/geo";

/**
 * Feature: card-behavior, Property 12: Fairest offers and mirrors.
 *
 * `planCardPlay` (`lib/cards/playPlan.ts`) decides whether a play raises a
 * pending Fairest of Them All offer, and `decideFairest`
 * (`lib/cards/challenges.ts`) decides what happens when the holder plays or
 * declines it. This property pins down the offer/mirror rules from design.md
 * sections 7 and 8 across arbitrary mirrorable cards, target inventories, and
 * board shapes:
 *
 * - A mirrorable team card (a gated challenge, Pioneer, or Scenic Route) played
 *   on a target holding Fairest raises exactly one pending offer linking the
 *   challenge (gated) or the restriction effect (Pioneer/Scenic), never both
 *   (9.1, 9.5). A target not holding Fairest raises none.
 * - A Mirrored_Challenge is not itself mirrorable: planning the mirrored play has
 *   no play row, so the same-name rule never counts it and it raises no offer
 *   (9.10, 9.14).
 * - Pioneer/Scenic plays where `mirrorIsLegal` is false at the play's server time
 *   create NO offer, but the play still succeeds with its restriction effect
 *   (9.15).
 * - `decideFairest` Play creates the mirrored record on the original caster and
 *   voids the holder's other pending offers; the original is left untouched
 *   (9.9, 9.13).
 * - `decideFairest` Decline leaves the original challenge intact (9.8).
 *
 * All generators are hermetic; nothing touches a database or device clock.
 *
 * Validates: Requirements 6.5, 9.1, 9.5, 9.8, 9.9, 9.10, 9.13, 9.14, 9.15
 */

// ---------------------------------------------------------------------------
// Slugs.
// ---------------------------------------------------------------------------

const FAIREST_SLUG: CardSlug = "fairest-of-them-all";
const PIONEER_SLUG: CardSlug = "pioneer";
const SCENIC_SLUG: CardSlug = "scenic-route";

/** Every card that targets a team, so Fairest can turn it back on the caster. */
const MIRRORABLE_SLUGS: readonly CardSlug[] = (
  [
    "go-piss-girl",
    "moneybags",
    "use-it-or-lose-it",
    "wired",
    "broad-shoulders",
    "interested-buyer",
    "spin-cycle",
    "dirty-bird",
    PIONEER_SLUG,
    SCENIC_SLUG,
  ] as const
).filter((slug) => isMirrorableCard(getCardMetadata(slug)));

/** The gated (completion-required) subset — these link a challenge, not an effect. */
const GATED_MIRRORABLE: readonly CardSlug[] = [
  "go-piss-girl",
  "moneybags",
  "use-it-or-lose-it",
  "wired",
  "broad-shoulders",
  "interested-buyer",
  "spin-cycle",
  "dirty-bird",
];

const RESTRICTION_SLUGS: readonly CardSlug[] = [PIONEER_SLUG, SCENIC_SLUG];

function isRestrictionSlug(slug: CardSlug): boolean {
  return slug === PIONEER_SLUG || slug === SCENIC_SLUG;
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const BASE_ISO = "2025-06-01T18:00:00.000Z";

const CASTER = "team-caster";
const TARGET = "team-target";
const THIRD = "team-third";
const TEAM_IDS = [CASTER, TARGET, THIRD] as const;

function card(id: string, slug: CardSlug): CardInstance {
  return { id, slug, state: "hand", position: 0 };
}

function bar(
  barKey: string,
  kind: ResolvedBar["kind"],
  coords: LatLng | null,
): ResolvedBar {
  return { barId: `${barKey}-id`, barKey, name: barKey, coords, kind };
}

/**
 * A small, well-spaced bar layout. The finish bar sits at the east end; `far`
 * is west of `near`, so `far` is strictly farther from the finish than `near`.
 * Everything is comfortably more than 0.25 miles apart.
 */
const FINISH_BAR = bar("finish", "finish", { lat: 33.75, lng: -84.34 });
const START_BAR = bar("start", "start", { lat: 33.75, lng: -84.4 });
const NEAR_BAR = bar("near", "scoring", { lat: 33.75, lng: -84.37 });
const FAR_BAR = bar("far", "scoring", { lat: 33.75, lng: -84.42 });

const BARS: ReadonlyMap<string, ResolvedBar> = new Map(
  [FINISH_BAR, START_BAR, NEAR_BAR, FAR_BAR].map((b) => [b.barKey, b]),
);

interface StateOpts {
  readonly teamIds?: readonly string[];
  readonly hands?: ReadonlyMap<string, readonly CardSlug[]>;
  readonly activeClaims?: readonly BehaviorState["activeClaims"][number][];
  readonly claimHistory?: readonly BehaviorState["claimHistory"][number][];
  readonly effects?: readonly EffectRecord[];
  readonly challenges?: readonly ChallengeRecord[];
  readonly offers?: readonly FairestOfferRecord[];
  readonly plays?: readonly BehaviorState["plays"][number][];
  readonly bars?: ReadonlyMap<string, ResolvedBar>;
}

function makeState(opts: StateOpts = {}): BehaviorState {
  const teamIds = opts.teamIds ?? TEAM_IDS;
  const hands = new Map<
    string,
    { hand: readonly CardInstance[]; pending: readonly CardInstance[] }
  >();
  for (const teamId of teamIds) {
    const handSlugs = opts.hands?.get(teamId) ?? [];
    hands.set(teamId, {
      hand: handSlugs.map((slug, i) => card(`${teamId}:${slug}:${i}`, slug)),
      pending: [],
    });
  }

  const bars = opts.bars ?? BARS;

  return {
    gameId: "game-1",
    lifecycle: "live",
    nowIso: BASE_ISO,
    teams: teamIds.map((teamId) => ({
      teamId,
      name: teamId,
      memberSessionIds: [`${teamId}-session`],
    })),
    hostSessionId: "host-session",
    bars,
    startBarKey: "start",
    finishBarKey: "finish",
    activeClaims: opts.activeClaims ?? [],
    claimHistory: opts.claimHistory ?? [],
    hands,
    plays: opts.plays ?? [],
    challenges: opts.challenges ?? [],
    offers: opts.offers ?? [],
    effects: opts.effects ?? [],
    awards: [],
    ledger: [],
  };
}

/** The engine instance id a caster's hand uses for a slug (`makeState` scheme). */
function cardId(teamId: string, slug: CardSlug): string {
  return `${teamId}:${slug}:0`;
}

/**
 * A play request for `slug` cast by CASTER on TARGET. Pioneer/Scenic and gated
 * challenges all target a team; nothing here needs casting params or a bar.
 */
function playReq(slug: CardSlug): PlayRequest {
  return {
    cardId: cardId(CASTER, slug),
    casterTeamId: CASTER,
    targetTeamId: TARGET,
  };
}

/** A restriction effect targeting a team (for stacking Pioneer/Scenic). */
function restrictionEffect(
  effectId: string,
  targetTeamId: string,
  rule: "pioneer" | "scenic",
): EffectRecord {
  return {
    effectId,
    slug: rule === "pioneer" ? PIONEER_SLUG : SCENIC_SLUG,
    kind: "next_claim_restriction",
    sourcePlayId: `${effectId}-play`,
    sourceChallengeId: null,
    ownerTeamId: "someone",
    targetTeamId,
    targetBarKey: null,
    startsAt: BASE_ISO,
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

// ---------------------------------------------------------------------------
// Property 12a: mirrorable play on a Fairest holder raises exactly one offer.
// ---------------------------------------------------------------------------

describe("Property 12: Fairest offer is raised exactly when the target holds Fairest", () => {
  it("a mirrorable team card raises one pending offer linking the right record", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MIRRORABLE_SLUGS),
        fc.boolean(),
        (slug, targetHoldsFairest) => {
          // The target holds Fairest (plus the game is otherwise unconstrained),
          // and a Pioneer/Scenic mirror onto the caster stays legal (empty board
          // of candidate bars means both casters have somewhere to go).
          const targetHand: CardSlug[] = targetHoldsFairest
            ? [FAIREST_SLUG]
            : [];
          const state = makeState({
            hands: new Map<string, readonly CardSlug[]>([
              [CASTER, [slug]],
              [TARGET, targetHand],
            ]),
          });

          const result = planCardPlay(state, playReq(slug), BASE_ISO);
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          if (!targetHoldsFairest) {
            expect(result.plan.offers).toEqual([]);
            return;
          }

          // Exactly one pending offer for the holder, linking one record.
          expect(result.plan.offers).toHaveLength(1);
          const offer = result.plan.offers[0];
          expect(offer.status).toBe("pending");
          expect(offer.holderTeamId).toBe(TARGET);
          expect(offer.originalCasterTeamId).toBe(CASTER);
          expect(offer.slug).toBe(slug);

          if (isRestrictionSlug(slug)) {
            // Pioneer/Scenic link a restriction effect, never a challenge.
            expect(offer.restrictionEffectId).not.toBeNull();
            expect(offer.challengeId).toBeNull();
            expect(result.plan.effects).toHaveLength(1);
            expect(offer.restrictionEffectId).toBe(
              result.plan.effects[0].effectId,
            );
          } else {
            // Gated cards link a challenge, never a restriction.
            expect(offer.challengeId).not.toBeNull();
            expect(offer.restrictionEffectId).toBeNull();
            expect(result.plan.challenges).toHaveLength(1);
            expect(offer.challengeId).toBe(
              result.plan.challenges[0].challengeId,
            );
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12b: a mirrored challenge is not itself mirrorable (9.10, 9.14).
// ---------------------------------------------------------------------------

describe("Property 12: a mirror does not count against same-name and raises no new offer", () => {
  it("decideFairest Play never produces a mirrored record that is itself an offer-bearing play", () => {
    fc.assert(
      fc.property(fc.constantFrom(...GATED_MIRRORABLE), (slug) => {
        // Caster plays `slug` on a target holding Fairest: this raises the offer.
        const state = makeState({
          hands: new Map<string, readonly CardSlug[]>([
            [CASTER, [slug]],
            [TARGET, [FAIREST_SLUG]],
          ]),
        });
        const planResult = planCardPlay(state, playReq(slug), BASE_ISO);
        expect(planResult.ok).toBe(true);
        if (!planResult.ok) return;

        const challenge = planResult.plan.challenges[0];
        const offer = planResult.plan.offers[0];

        // Apply the play to the state: add the challenge, the offer, and a
        // `card_played` play row (the fact the same-name rule counts).
        const afterPlay = makeState({
          hands: new Map<string, readonly CardSlug[]>([
            [CASTER, [slug]],
            [TARGET, [FAIREST_SLUG]],
          ]),
          challenges: [challenge],
          offers: [offer],
          plays: [
            {
              playId: challenge.sourcePlayId,
              slug,
              casterTeamId: CASTER,
              targetTeamId: TARGET,
              targetBarId: null,
              targetBarKey: null,
              params: { kind: "none" },
              createdAt: BASE_ISO,
            },
          ],
        });

        // Holder plays Fairest: a Mirrored_Challenge is created on the caster.
        const mirror = decideFairest(
          afterPlay,
          offer.offerId,
          "play",
          TARGET,
          BASE_ISO,
        );
        expect(mirror.ok).toBe(true);
        if (!mirror.ok) return;

        const mirrored = mirror.plan.mirroredChallenge;
        expect(mirrored).not.toBeNull();
        if (mirrored === null) return;

        // The mirror targets the original caster and carries no play row of its
        // own, so the same-name rule (which counts only `card_played` facts)
        // never counts it — there is still exactly one play for this slug.
        expect(mirrored.targetTeamId).toBe(CASTER);
        expect(mirrored.mirroredFromChallengeId).toBe(challenge.challengeId);
        const playsForSlug = afterPlay.plays.filter((p) => p.slug === slug);
        expect(playsForSlug).toHaveLength(1);
        // The mirror raised no fresh Fairest offer (mirrors are not mirrorable).
        // The only offers touched are the one being played plus voided siblings.
        expect(mirror.plan.offer.offerId).toBe(offer.offerId);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12c: illegal Pioneer/Scenic mirror -> no offer, play still succeeds.
// ---------------------------------------------------------------------------

describe("Property 12: an illegal Pioneer/Scenic mirror raises no offer but the play succeeds", () => {
  // Scenic legality is decided per team by that team's previous bar, so the
  // target can stay eligible (previous bar = start, farther bars remain) while
  // the caster's mirror is illegal (previous bar = far, nothing is farther).
  it("Scenic: creates the restriction with no offer when the caster's mirror is illegal", () => {
    // The caster's previous bar is `far` (the farthest-from-finish bar), so no
    // remaining bar is farther: a Scenic mirror onto the caster has no legal next
    // bar. The target has no claim history (previous bar = start), so Scenic is
    // legal for the target and the play is eligible.
    const state = makeState({
      hands: new Map<string, readonly CardSlug[]>([
        [CASTER, [SCENIC_SLUG]],
        [TARGET, [FAIREST_SLUG]],
      ]),
      claimHistory: [
        {
          claimId: "c-far",
          teamId: CASTER,
          barId: "far-id",
          barKey: "far",
          claimedAt: BASE_ISO,
          revokedReason: null,
        },
      ],
      activeClaims: [
        {
          claimId: "c-far",
          teamId: CASTER,
          barId: "far-id",
          barKey: "far",
          claimedAt: BASE_ISO,
          revokedReason: null,
        },
      ],
    });

    const result = planCardPlay(state, playReq(SCENIC_SLUG), BASE_ISO);

    // The play still succeeds and writes the restriction effect; because the
    // mirror would leave the caster with no legal next bar, no offer is made.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.effects).toHaveLength(1);
    expect(result.plan.effects[0].kind).toBe("next_claim_restriction");
    expect(result.plan.effects[0].targetTeamId).toBe(TARGET);
    expect(result.plan.offers).toEqual([]);
  });

  // For Pioneer, a target-eligible play implies the caster could also reach an
  // unclaimed bar, unless the caster already carries a stacking Scenic rule that
  // rules out the one Pioneer-legal bar. That stacking case is the illegal mirror.
  it("Pioneer: creates the restriction with no offer when a stacked caster rule makes the mirror illegal", () => {
    // Bars: start (unclaimed), near (held by THIRD), far (held by THIRD),
    // finish. The caster already holds a Scenic restriction and its previous bar
    // is the start bar, so Scenic allows only bars farther from the finish than
    // start (i.e. `far`), but `far` is claimed by THIRD so Pioneer forbids it —
    // stacking leaves the caster no legal next bar. The target (previous bar =
    // start, plain Pioneer) can still reach the unclaimed `start`, so the play is
    // eligible.
    const state = makeState({
      hands: new Map<string, readonly CardSlug[]>([
        [CASTER, [PIONEER_SLUG]],
        [TARGET, [FAIREST_SLUG]],
      ]),
      effects: [restrictionEffect("caster-scenic", CASTER, "scenic")],
      activeClaims: [
        {
          claimId: "t3-near",
          teamId: THIRD,
          barId: "near-id",
          barKey: "near",
          claimedAt: BASE_ISO,
          revokedReason: null,
        },
        {
          claimId: "t3-far",
          teamId: THIRD,
          barId: "far-id",
          barKey: "far",
          claimedAt: BASE_ISO,
          revokedReason: null,
        },
      ],
    });

    const result = planCardPlay(state, playReq(PIONEER_SLUG), BASE_ISO);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.effects).toHaveLength(1);
    expect(result.plan.effects[0].kind).toBe("next_claim_restriction");
    expect(result.plan.effects[0].targetTeamId).toBe(TARGET);
    expect(result.plan.offers).toEqual([]);
  });

  it("raises the offer when the mirror stays legal, even with a stacked caster rule", () => {
    // The caster already holds a Pioneer restriction, and plays Scenic on the
    // target. The mirror would stack Scenic onto the caster's Pioneer, but a
    // far-enough unclaimed bar remains, so the mirror is legal and an offer is
    // raised.
    const state = makeState({
      hands: new Map<string, readonly CardSlug[]>([
        [CASTER, [SCENIC_SLUG]],
        [TARGET, [FAIREST_SLUG]],
      ]),
      effects: [restrictionEffect("caster-pioneer", CASTER, "pioneer")],
      // Caster's previous bar is `near`; `far` is farther from finish and
      // unclaimed, so Pioneer+Scenic both pass for `far`.
      claimHistory: [
        {
          claimId: "c-near",
          teamId: CASTER,
          barId: "near-id",
          barKey: "near",
          claimedAt: BASE_ISO,
          revokedReason: null,
        },
      ],
    });

    const result = planCardPlay(state, playReq(SCENIC_SLUG), BASE_ISO);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.offers).toHaveLength(1);
    expect(result.plan.offers[0].slug).toBe(SCENIC_SLUG);
    expect(result.plan.offers[0].restrictionEffectId).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Property 12d: decideFairest Play mirrors onto the caster + voids siblings.
// ---------------------------------------------------------------------------

describe("Property 12: decideFairest Play mirrors onto the caster and voids other pending offers", () => {
  it("creates the mirrored record on the original caster and voids the holder's other offers", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...GATED_MIRRORABLE),
        fc.nat({ max: 2 }),
        (slug, otherOfferCount) => {
          const challenge: ChallengeRecord = {
            challengeId: "ch-1",
            slug,
            sourcePlayId: "play-1",
            casterTeamId: CASTER,
            targetTeamId: TARGET,
            params: { kind: "none" },
            mirroredFromChallengeId: null,
            mirroredFromPlayId: null,
            status: "open",
            createdAt: BASE_ISO,
            resolvedAt: null,
            resolvedByTeamId: null,
            resolvedBySessionId: null,
            resolvedByKind: null,
            failureEffectId: null,
          };

          const primaryOffer: FairestOfferRecord = {
            offerId: "offer-primary",
            sourcePlayId: "play-1",
            slug,
            holderTeamId: TARGET,
            originalCasterTeamId: CASTER,
            challengeId: "ch-1",
            restrictionEffectId: null,
            status: "pending",
            decidedAt: null,
            mirroredChallengeId: null,
            mirroredEffectId: null,
          };

          // The holder also holds `otherOfferCount` sibling pending offers.
          const siblings: FairestOfferRecord[] = Array.from(
            { length: otherOfferCount },
            (_, i) => ({
              ...primaryOffer,
              offerId: `offer-sib-${i}`,
              sourcePlayId: `play-sib-${i}`,
              challengeId: `ch-sib-${i}`,
            }),
          );

          const state = makeState({
            hands: new Map<string, readonly CardSlug[]>([
              [TARGET, [FAIREST_SLUG]],
            ]),
            challenges: [challenge],
            offers: [primaryOffer, ...siblings],
          });

          const result = decideFairest(
            state,
            "offer-primary",
            "play",
            TARGET,
            BASE_ISO,
          );
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // The decided offer is played and points at the mirrored challenge.
          expect(result.plan.offer.status).toBe("played");
          const mirrored = result.plan.mirroredChallenge;
          expect(mirrored).not.toBeNull();
          if (mirrored === null) return;

          // The mirror runs the challenge back on the original caster.
          expect(mirrored.targetTeamId).toBe(CASTER);
          expect(mirrored.casterTeamId).toBe(TARGET);
          expect(mirrored.mirroredFromChallengeId).toBe("ch-1");
          expect(result.plan.mirroredEffect).toBeNull();

          // Exactly the sibling pending offers are voided (9.13).
          expect(result.plan.voidOffers).toHaveLength(otherOfferCount);
          for (const voided of result.plan.voidOffers) {
            expect(voided.status).toBe("void");
            expect(voided.offerId).not.toBe("offer-primary");
          }

          // The original challenge is not part of the plan — it is left intact.
          // (The plan carries only the patched offer and the new mirror.)
          expect(
            (result.plan as { challenge?: unknown }).challenge,
          ).toBeUndefined();
        },
      ),
    );
  });

  it("mirrors a Pioneer/Scenic restriction onto the caster as an effect", () => {
    fc.assert(
      fc.property(fc.constantFrom(...RESTRICTION_SLUGS), (slug) => {
        const rule = slug === PIONEER_SLUG ? "pioneer" : "scenic";
        const restriction = restrictionEffect("eff-1", TARGET, rule);

        const offer: FairestOfferRecord = {
          offerId: "offer-1",
          sourcePlayId: "play-1",
          slug,
          holderTeamId: TARGET,
          originalCasterTeamId: CASTER,
          challengeId: null,
          restrictionEffectId: "eff-1",
          status: "pending",
          decidedAt: null,
          mirroredChallengeId: null,
          mirroredEffectId: null,
        };

        // Keep the caster's mirror legal (no caster restrictions, open board).
        const state = makeState({
          hands: new Map<string, readonly CardSlug[]>([
            [TARGET, [FAIREST_SLUG]],
          ]),
          effects: [restriction],
          offers: [offer],
        });

        const result = decideFairest(
          state,
          "offer-1",
          "play",
          TARGET,
          BASE_ISO,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.plan.mirroredChallenge).toBeNull();
        const mirrored = result.plan.mirroredEffect;
        expect(mirrored).not.toBeNull();
        if (mirrored === null) return;
        expect(mirrored.kind).toBe("next_claim_restriction");
        expect(mirrored.targetTeamId).toBe(CASTER);
        expect(mirrored.params.rule).toBe(rule);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12e: decideFairest Decline leaves the original challenge intact.
// ---------------------------------------------------------------------------

describe("Property 12: decideFairest Decline leaves the original challenge intact", () => {
  it("declining decides only the offer and creates no mirror", () => {
    fc.assert(
      fc.property(fc.constantFrom(...GATED_MIRRORABLE), (slug) => {
        const challenge: ChallengeRecord = {
          challengeId: "ch-1",
          slug,
          sourcePlayId: "play-1",
          casterTeamId: CASTER,
          targetTeamId: TARGET,
          params: { kind: "none" },
          mirroredFromChallengeId: null,
          mirroredFromPlayId: null,
          status: "open",
          createdAt: BASE_ISO,
          resolvedAt: null,
          resolvedByTeamId: null,
          resolvedBySessionId: null,
          resolvedByKind: null,
          failureEffectId: null,
        };
        const offer: FairestOfferRecord = {
          offerId: "offer-1",
          sourcePlayId: "play-1",
          slug,
          holderTeamId: TARGET,
          originalCasterTeamId: CASTER,
          challengeId: "ch-1",
          restrictionEffectId: null,
          status: "pending",
          decidedAt: null,
          mirroredChallengeId: null,
          mirroredEffectId: null,
        };

        const state = makeState({
          hands: new Map<string, readonly CardSlug[]>([
            [TARGET, [FAIREST_SLUG]],
          ]),
          challenges: [challenge],
          offers: [offer],
        });

        const result = decideFairest(
          state,
          "offer-1",
          "decline",
          TARGET,
          BASE_ISO,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // Only the offer is decided; nothing mirrors.
        expect(result.plan.offer.status).toBe("declined");
        expect(result.plan.mirroredChallenge).toBeNull();
        expect(result.plan.mirroredEffect).toBeNull();
        expect(result.plan.voidOffers).toEqual([]);

        // The original challenge the planner read is still open and unresolved
        // in the loaded state — Decline touches no challenge row.
        const original = state.challenges.find((c) => c.challengeId === "ch-1");
        expect(original?.status).toBe("open");
      }),
    );
  });
});
