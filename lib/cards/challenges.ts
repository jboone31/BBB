/**
 * Challenge state machine (`lib/cards/challenges.ts`).
 *
 * Pure, framework-free module. It owns the resolution rules for every gated
 * challenge, the Fairest of Them All offer/mirror decision, the host clear/reset
 * overrides, and the Use It or Lose It auto-completion and offer-voiding that ride
 * on a caster's inventory change. Every function takes a loaded
 * {@link BehaviorState} plus a server time and returns a {@link Plan} the
 * persistence layer writes; nothing here touches the database or a device clock.
 *
 * The state machine (design.md section 7):
 *
 * | From | Action | Guard | To | Side effects |
 * | --- | --- | --- | --- | --- |
 * | open | complete | actor on target team, no pending offer, slug ≠ UIOLI | completed | none |
 * | open | fail | slug = everyone's-a-critic, actor on target team, no pending offer | failed | `team_claim_block` for target, `[now, now+15m)` |
 * | open | (inventory) | slug = UIOLI, hand = 0 and pending = 0 | completed (`system`) | embedded in the inventory event |
 * | open | host clear | host | cleared_by_host | voids the pending offer on this challenge |
 * | completed / failed | host reset | host; UIOLI also needs a non-empty hand or a pending draw | open | failed critic: cancel `failureEffectId` |
 * | any other | complete / fail | | | `already_resolved` |
 * | any | complete / fail | actor not on target team | | `not_authorized` |
 * | open with pending offer | complete / fail | | | `conflict` |
 * | open UIOLI with pending offer | "Can't play, discard" | | | `conflict` (5.5) |
 *
 * A "pending offer" means a {@link FairestOfferRecord} with status `pending`
 * whose holder still holds Fairest of Them All in hand. The holder check reads the
 * loaded inventory, so a stale offer never blocks resolution.
 *
 * See design.md section 7; Requirements 4.4, 4.6, 5.2-5.5, 7.2, 7.4, 8.5, 8.7,
 * 9.3-9.5, 9.8-9.10, 9.12, 9.13, 9.16, 9.17, 21.1-21.3.
 */

import type { CardSlug } from "./catalog";
import type { DeckState } from "./deck";
import type { EffectRecord } from "./effects";
import { DURATIONS_MS } from "./effects";
import { mirrorIsLegal } from "@/lib/claims/legalNextBar";
import type {
  BehaviorState,
  ChallengeRecord,
  FairestOfferRecord,
  InventoryFollowUp,
  Plan,
} from "./behaviorState";

// Re-export the type-only vocabulary so callers have a single import for the
// challenge-state types (design.md section 7; task 3.1).
export type {
  BehaviorState,
  ChallengeRecord,
  ChallengeStatus,
  FairestOfferRecord,
  FairestOfferStatus,
  InventoryFollowUp,
  Plan,
  StableError,
} from "./behaviorState";

// ---------------------------------------------------------------------------
// Slugs with special behavior in the state machine.
// ---------------------------------------------------------------------------

const UIOLI_SLUG: CardSlug = "use-it-or-lose-it";
const CRITIC_SLUG: CardSlug = "everyones-a-critic";
const FAIREST_SLUG: CardSlug = "fairest-of-them-all";
const PIONEER_SLUG: CardSlug = "pioneer";
const SCENIC_SLUG: CardSlug = "scenic-route";

/** The Pioneer/Scenic Route next-claim-restriction slugs that mirror as effects. */
function isRestrictionSlug(slug: CardSlug): boolean {
  return slug === PIONEER_SLUG || slug === SCENIC_SLUG;
}

// ---------------------------------------------------------------------------
// Request / plan payloads.
// ---------------------------------------------------------------------------

/** A challenge resolution request: the target team completes or fails a challenge. */
export type ResolveRequest =
  | { readonly kind: "complete"; readonly actorTeamId: string | null }
  | { readonly kind: "fail"; readonly actorTeamId: string | null };

/**
 * The plan for resolving one challenge. `challenge` is the patched record to
 * upsert (`status`, resolution provenance, and — for a failed critic — the new
 * `failureEffectId`). `newEffect` is the Everyone's a Critic `team_claim_block`
 * created on a `fail`, or null for a plain `complete`.
 */
export interface ChallengeResolutionPlan {
  readonly challenge: ChallengeRecord;
  readonly newEffect: EffectRecord | null;
}

/**
 * The plan for a Fairest decision. For a `decline` only `offer` is set. For a
 * `play`: `offer` is the decided offer (`played`, pointing at the mirrored
 * record), `voidOffers` lists the holder's other pending offers that are voided,
 * and exactly one of `mirroredChallenge` / `mirroredEffect` carries the record
 * created on the original caster. The original challenge/restriction is left
 * untouched, so it is not part of the plan.
 */
export interface FairestPlan {
  readonly offer: FairestOfferRecord;
  readonly mirroredChallenge: ChallengeRecord | null;
  readonly mirroredEffect: EffectRecord | null;
  readonly voidOffers: readonly FairestOfferRecord[];
}

/**
 * The plan for a host clear/reset. `challenge` is the patched record. `voidOffer`
 * is the pending offer voided by a `clear`, or null. `cancelEffectId` is the
 * critic `failureEffectId` cancelled by a `reset` of a failed Everyone's a Critic
 * challenge, or null.
 */
export interface HostChallengePlan {
  readonly challenge: ChallengeRecord;
  readonly voidOffer: FairestOfferRecord | null;
  readonly cancelEffectId: string | null;
}

// ---------------------------------------------------------------------------
// Pending-offer helper.
// ---------------------------------------------------------------------------

/**
 * Whether `teamId` still holds Fairest of Them All in hand in the loaded
 * inventory. Pending (undrawn) cards do not count — only the hand holds a
 * playable Fairest.
 */
function holdsFairest(state: BehaviorState, teamId: string): boolean {
  const inventory = state.hands.get(teamId);
  if (inventory === undefined) {
    return false;
  }
  return inventory.hand.some((card) => card.slug === FAIREST_SLUG);
}

/**
 * The live Fairest offer attached to `challengeId`, or null. An offer is live
 * when its status is `pending` and its holder still holds Fairest in hand; a
 * stale offer (holder no longer holding Fairest) never counts.
 */
function liveOfferForChallenge(
  state: BehaviorState,
  challengeId: string,
): FairestOfferRecord | null {
  for (const offer of state.offers) {
    if (offer.challengeId !== challengeId) {
      continue;
    }
    if (offer.status !== "pending") {
      continue;
    }
    if (holdsFairest(state, offer.holderTeamId)) {
      return offer;
    }
  }
  return null;
}

/** The pending offer on `challengeId` regardless of holder inventory (for host clear). */
function pendingOfferForChallenge(
  state: BehaviorState,
  challengeId: string,
): FairestOfferRecord | null {
  return (
    state.offers.find(
      (offer) =>
        offer.challengeId === challengeId && offer.status === "pending",
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// resolveChallenge.
// ---------------------------------------------------------------------------

/**
 * Resolve a challenge per the transition table. Only a member of the target team
 * may complete a challenge (or fail an Everyone's a Critic challenge); the
 * challenge must be `open`; and no live Fairest offer may be outstanding. A
 * `fail` is accepted only for Everyone's a Critic and creates a `team_claim_block`
 * effect on the target team for `[now, now+15m)`. The resolution provenance
 * (session, team, time, kind) is recorded on the returned record.
 */
export function resolveChallenge(
  state: BehaviorState,
  challengeId: string,
  req: ResolveRequest,
  now: string,
): Plan<ChallengeResolutionPlan> {
  const challenge = state.challenges.find((c) => c.challengeId === challengeId);
  if (challenge === undefined) {
    return { ok: false, error: "not_found" };
  }

  // Actor must be on the target team. (4.4, 5.2)
  if (!actorOnTeam(state, req.actorTeamId, challenge.targetTeamId)) {
    return { ok: false, error: "not_authorized" };
  }

  // Only an open challenge can be resolved. (5.3)
  if (challenge.status !== "open") {
    return { ok: false, error: "already_resolved" };
  }

  // A live Fairest offer freezes resolution. (9.4)
  if (liveOfferForChallenge(state, challengeId) !== null) {
    return { ok: false, error: "conflict" };
  }

  const sessionId = sessionForTeam(state, req.actorTeamId);

  if (req.kind === "complete") {
    // UIOLI never completes by an explicit "complete" action; it auto-completes
    // through the inventory settle only. (8.5)
    if (challenge.slug === UIOLI_SLUG) {
      return { ok: false, error: "conflict" };
    }
    return {
      ok: true,
      plan: {
        challenge: {
          ...challenge,
          status: "completed",
          resolvedAt: now,
          resolvedByTeamId: challenge.targetTeamId,
          resolvedBySessionId: sessionId,
          resolvedByKind: "team",
        },
        newEffect: null,
      },
    };
  }

  // req.kind === "fail": only Everyone's a Critic may fail. (7.2)
  if (challenge.slug !== CRITIC_SLUG) {
    return { ok: false, error: "conflict" };
  }

  const nowMs = Date.parse(now);
  const endIso = new Date(nowMs + DURATIONS_MS.criticBlock).toISOString();
  const failureEffectId = deterministicUuid(
    `critic-block:${challenge.challengeId}`,
  );

  const newEffect: EffectRecord = {
    effectId: failureEffectId,
    slug: CRITIC_SLUG,
    kind: "team_claim_block",
    sourcePlayId: challenge.sourcePlayId,
    sourceChallengeId: challenge.challengeId,
    ownerTeamId: challenge.casterTeamId,
    targetTeamId: challenge.targetTeamId,
    targetBarKey: null,
    startsAt: now,
    endsAt: endIso,
    params: {},
    attachedClaimId: null,
    attachedBarKey: null,
    protectedPoints: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    startAnnounced: true,
    endAnnounced: false,
  };

  return {
    ok: true,
    plan: {
      challenge: {
        ...challenge,
        status: "failed",
        resolvedAt: now,
        resolvedByTeamId: challenge.targetTeamId,
        resolvedBySessionId: sessionId,
        resolvedByKind: "team",
        failureEffectId,
      },
      newEffect,
    },
  };
}

// ---------------------------------------------------------------------------
// decideFairest.
// ---------------------------------------------------------------------------

/**
 * Decide a Fairest of Them All offer. Only the offer's holder may decide it, and
 * the offer must be `pending`.
 *
 * - `decline`: the offer becomes `declined`; nothing else changes.
 * - `play`: the holder must still hold Fairest in hand (else `conflict`). For a
 *   Pioneer or Scenic Route offer, `mirrorIsLegal(state, offer, now)` is re-run at
 *   the decision's `now`; when false the play is rejected with `invalid_input`,
 *   details `{ reason: "no_legal_next_bar", rules }`, nothing is written, and the
 *   offer stays `pending` so Decline remains available (9.16, 9.17). Otherwise a
 *   Mirrored_Challenge or mirrored `next_claim_restriction` is created on the
 *   original caster with the same slug and params, the holder's other pending
 *   offers are voided (9.13), and the original challenge/restriction is left
 *   untouched (9.8). A mirrored UIOLI challenge is created `completed` when the
 *   caster's hand and pending draw are already empty.
 */
export function decideFairest(
  state: BehaviorState,
  offerId: string,
  decision: "play" | "decline",
  actorTeamId: string | null,
  now: string,
): Plan<FairestPlan> {
  const offer = state.offers.find((o) => o.offerId === offerId);
  if (offer === undefined) {
    return { ok: false, error: "not_found" };
  }

  // Only the holder may decide the offer. (9.3)
  if (!actorOnTeam(state, actorTeamId, offer.holderTeamId)) {
    return { ok: false, error: "not_authorized" };
  }

  // A decided offer cannot be decided again.
  if (offer.status !== "pending") {
    return { ok: false, error: "already_resolved" };
  }

  if (decision === "decline") {
    return {
      ok: true,
      plan: {
        offer: { ...offer, status: "declined", decidedAt: now },
        mirroredChallenge: null,
        mirroredEffect: null,
        voidOffers: [],
      },
    };
  }

  // decision === "play": the holder must still hold Fairest in hand. (9.5)
  if (!holdsFairest(state, offer.holderTeamId)) {
    return { ok: false, error: "conflict" };
  }

  // Pioneer / Scenic Route: re-check that mirroring still leaves the original
  // caster a Legal_Next_Bar at the decision's now. (9.16, 9.17)
  if (isRestrictionSlug(offer.slug)) {
    if (!mirrorIsLegal(state, offer, now)) {
      return {
        ok: false,
        error: "invalid_input",
        details: {
          reason: "no_legal_next_bar",
          rules: rulesForOffer(state, offer),
        },
      };
    }
  }

  // Void the holder's other pending offers. (9.13)
  const voidOffers = state.offers
    .filter(
      (o) =>
        o.offerId !== offer.offerId &&
        o.holderTeamId === offer.holderTeamId &&
        o.status === "pending",
    )
    .map((o) => ({ ...o, status: "void" as const, decidedAt: now }));

  if (isRestrictionSlug(offer.slug)) {
    // Mirror a Pioneer / Scenic Route restriction onto the original caster.
    const mirroredEffectId = deterministicUuid(
      `mirror-effect:${offer.offerId}`,
    );
    const rule = offer.slug === PIONEER_SLUG ? "pioneer" : "scenic";
    const sourceEffect = offer.restrictionEffectId
      ? state.effects.find((e) => e.effectId === offer.restrictionEffectId)
      : undefined;

    const mirroredEffect: EffectRecord = {
      effectId: mirroredEffectId,
      slug: offer.slug,
      kind: "next_claim_restriction",
      sourcePlayId: offer.sourcePlayId,
      sourceChallengeId: null,
      ownerTeamId: offer.holderTeamId,
      targetTeamId: offer.originalCasterTeamId,
      targetBarKey: null,
      startsAt: now,
      endsAt: null,
      params: sourceEffect ? { ...sourceEffect.params, rule } : { rule },
      attachedClaimId: null,
      attachedBarKey: null,
      protectedPoints: null,
      consumedAt: null,
      cancelledAt: null,
      cancelReason: null,
      startAnnounced: true,
      endAnnounced: false,
    };

    return {
      ok: true,
      plan: {
        offer: {
          ...offer,
          status: "played",
          decidedAt: now,
          mirroredEffectId,
        },
        mirroredChallenge: null,
        mirroredEffect,
        voidOffers,
      },
    };
  }

  // Mirror a gated team challenge back onto the original caster.
  const mirroredChallengeId = deterministicUuid(
    `mirror-challenge:${offer.offerId}`,
  );
  const sourceChallenge = offer.challengeId
    ? state.challenges.find((c) => c.challengeId === offer.challengeId)
    : undefined;
  const params = sourceChallenge?.params ?? { kind: "none" as const };

  // A mirrored UIOLI completes immediately when the caster's hand and pending
  // draw are already empty.
  let status: ChallengeRecordStatus = "open";
  let resolvedAt: string | null = null;
  let resolvedByKind: ChallengeRecord["resolvedByKind"] = null;
  if (offer.slug === UIOLI_SLUG) {
    const casterInventory = state.hands.get(offer.originalCasterTeamId);
    const handCount = casterInventory?.hand.length ?? 0;
    const pendingCount = casterInventory?.pending.length ?? 0;
    if (useItOrLoseItShouldComplete(handCount, pendingCount)) {
      status = "completed";
      resolvedAt = now;
      resolvedByKind = "system";
    }
  }

  const mirroredChallenge: ChallengeRecord = {
    challengeId: mirroredChallengeId,
    slug: offer.slug,
    sourcePlayId: offer.sourcePlayId,
    casterTeamId: offer.holderTeamId,
    targetTeamId: offer.originalCasterTeamId,
    params,
    mirroredFromChallengeId: offer.challengeId,
    mirroredFromPlayId: offer.sourcePlayId,
    status,
    createdAt: now,
    resolvedAt,
    resolvedByTeamId: null,
    resolvedBySessionId: null,
    resolvedByKind,
    failureEffectId: null,
  };

  return {
    ok: true,
    plan: {
      offer: {
        ...offer,
        status: "played",
        decidedAt: now,
        mirroredChallengeId,
      },
      mirroredChallenge,
      mirroredEffect: null,
      voidOffers,
    },
  };
}

// ---------------------------------------------------------------------------
// hostChallengeOverride.
// ---------------------------------------------------------------------------

/**
 * A host clear/reset override (design.md section 7; Requirements 21.1-21.3).
 *
 * - `clear`: an `open` challenge moves to `cleared_by_host`, voiding its pending
 *   offer.
 * - `reset`: a `completed`/`failed` challenge moves back to `open`, cancelling a
 *   failed Everyone's a Critic challenge's `failureEffectId`. Resetting a UIOLI
 *   challenge whose target already has an empty hand and no pending draw is
 *   rejected with `conflict` (it could never complete again), as is resetting a
 *   `cleared_by_host` challenge.
 */
export function hostChallengeOverride(
  state: BehaviorState,
  challengeId: string,
  action: "clear" | "reset",
  now: string,
): Plan<HostChallengePlan> {
  const challenge = state.challenges.find((c) => c.challengeId === challengeId);
  if (challenge === undefined) {
    return { ok: false, error: "not_found" };
  }

  if (action === "clear") {
    // Only an open challenge can be cleared.
    if (challenge.status !== "open") {
      return { ok: false, error: "conflict" };
    }
    const voidOffer = pendingOfferForChallenge(state, challengeId);
    return {
      ok: true,
      plan: {
        challenge: {
          ...challenge,
          status: "cleared_by_host",
          resolvedAt: now,
          resolvedByTeamId: null,
          resolvedBySessionId: null,
          resolvedByKind: "host",
        },
        voidOffer:
          voidOffer === null
            ? null
            : { ...voidOffer, status: "void", decidedAt: now },
        cancelEffectId: null,
      },
    };
  }

  // action === "reset": only completed / failed can be reset. cleared_by_host
  // cannot be reset.
  if (challenge.status !== "completed" && challenge.status !== "failed") {
    return { ok: false, error: "conflict" };
  }

  // A UIOLI reset is pointless (and rejected) when the target's hand is empty
  // with no pending draw: the challenge could never complete again.
  if (challenge.slug === UIOLI_SLUG) {
    const inventory = state.hands.get(challenge.targetTeamId);
    const handCount = inventory?.hand.length ?? 0;
    const pendingCount = inventory?.pending.length ?? 0;
    if (handCount === 0 && pendingCount === 0) {
      return { ok: false, error: "conflict" };
    }
  }

  // A failed Everyone's a Critic reset cancels its failure block.
  const cancelEffectId =
    challenge.status === "failed" ? challenge.failureEffectId : null;

  return {
    ok: true,
    plan: {
      challenge: {
        ...challenge,
        status: "open",
        resolvedAt: null,
        resolvedByTeamId: null,
        resolvedBySessionId: null,
        resolvedByKind: null,
        failureEffectId: null,
      },
      voidOffer: null,
      cancelEffectId,
    },
  };
}

// ---------------------------------------------------------------------------
// Use It or Lose It completion + inventory settle.
// ---------------------------------------------------------------------------

/**
 * Whether a Use It or Lose It challenge should complete: true exactly when the
 * target team's hand and pending draw are both empty (Requirement 8.5).
 */
export function useItOrLoseItShouldComplete(
  hand: number,
  pending: number,
): boolean {
  return hand === 0 && pending === 0;
}

/**
 * Settle the follow-up records that ride on `teamId`'s deck transition to the
 * `after` {@link DeckState} (design.md sections 7 and 15):
 *
 * - **UIOLI auto-completion:** every `open` Use It or Lose It challenge targeting
 *   the team completes (`resolvedByKind: "system"`) once the team's hand and
 *   pending draw are both empty.
 * - **Voided offers:** every `pending` Fairest offer the team holds is voided when
 *   the team no longer holds Fairest of Them All in hand after the transition
 *   (Requirement 9.12).
 *
 * The caller merges the returned ids into the single inventory event so they
 * commit atomically with the hand change.
 */
export function settleInventoryChange(
  state: BehaviorState,
  teamId: string,
  after: DeckState,
  _now: string,
): InventoryFollowUp {
  const handCount = after.cards.filter((c) => c.state === "hand").length;
  const pendingCount = after.cards.filter((c) => c.state === "pending").length;
  const stillHoldsFairest = after.cards.some(
    (c) => c.state === "hand" && c.slug === FAIREST_SLUG,
  );

  const completeChallenges: string[] = [];
  if (useItOrLoseItShouldComplete(handCount, pendingCount)) {
    for (const challenge of state.challenges) {
      if (
        challenge.slug === UIOLI_SLUG &&
        challenge.targetTeamId === teamId &&
        challenge.status === "open"
      ) {
        completeChallenges.push(challenge.challengeId);
      }
    }
  }

  const voidOffers: string[] = [];
  if (!stillHoldsFairest) {
    for (const offer of state.offers) {
      if (offer.holderTeamId === teamId && offer.status === "pending") {
        voidOffers.push(offer.offerId);
      }
    }
  }

  return { completeChallenges, voidOffers };
}

// ---------------------------------------------------------------------------
// checkCannotPlayDiscard.
// ---------------------------------------------------------------------------

/**
 * Guard the "Can't play, discard" shortcut (`/cards/discard`,
 * `reason: "cannot_play"`). It is rejected with `conflict` while the team's open
 * Use It or Lose It challenge has a pending Fairest offer, because the Fairest
 * decision must resolve first (Requirement 5.5). Otherwise it is accepted.
 */
export function checkCannotPlayDiscard(
  state: BehaviorState,
  teamId: string,
): Plan<null> {
  for (const challenge of state.challenges) {
    if (
      challenge.slug !== UIOLI_SLUG ||
      challenge.targetTeamId !== teamId ||
      challenge.status !== "open"
    ) {
      continue;
    }
    if (liveOfferForChallenge(state, challenge.challengeId) !== null) {
      return { ok: false, error: "conflict" };
    }
  }
  return { ok: true, plan: null };
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

type ChallengeRecordStatus = ChallengeRecord["status"];

/** Whether `actorTeamId` is the given team (a non-null, matching team id). */
function actorOnTeam(
  state: BehaviorState,
  actorTeamId: string | null,
  teamId: string,
): boolean {
  return actorTeamId !== null && actorTeamId === teamId;
}

/**
 * A representative session id for the acting team, used only to record
 * resolution provenance. The routes authorize the session; the planner records
 * the team's first known member session when one is available, else null.
 */
function sessionForTeam(
  state: BehaviorState,
  teamId: string | null,
): string | null {
  if (teamId === null) {
    return null;
  }
  const team = state.teams.find((t) => t.teamId === teamId);
  return team?.memberSessionIds[0] ?? null;
}

/** The next-claim rules involved in a restriction offer, for a reject's details. */
function rulesForOffer(
  state: BehaviorState,
  offer: FairestOfferRecord,
): string[] {
  const rule = offer.slug === PIONEER_SLUG ? "pioneer" : "scenic";
  const casterRules: string[] = [];
  for (const effect of state.effects) {
    if (
      effect.kind === "next_claim_restriction" &&
      effect.targetTeamId === offer.originalCasterTeamId
    ) {
      const r = effect.params.rule;
      if (r === "pioneer" || r === "scenic") {
        casterRules.push(r);
      }
    }
  }
  return [...new Set([...casterRules, rule])];
}

/**
 * Derive a stable UUID (v4-shaped) from a name string. Mirrors the derivation in
 * `persistence.ts`: a small FNV-1a hash expanded to 16 bytes so the same name
 * always yields the same id, making mirrored-record ids reproducible across
 * repeated planning of the same decision without a database round-trip.
 */
function deterministicUuid(name: string): string {
  const bytes = new Uint8Array(16);
  let h = 0x811c9dc5;
  for (let i = 0; i < 16; i += 1) {
    for (let j = 0; j < name.length; j += 1) {
      h ^= name.charCodeAt(j) + i * 131;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    bytes[i] = h & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
