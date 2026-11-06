/**
 * Claim side effects (`lib/cards/claimEffects.ts`).
 *
 * Pure, framework-free module. It decides the card-driven consequences of a real
 * claim, a real unclaim, and a Happy Hour Bonus_Claim, reading a loaded
 * {@link BehaviorState} and a server time. It never touches the database, a
 * device clock, or announced flags; the route (task 7.5) applies the returned
 * plan inside the mutation transaction.
 *
 * Three planners live here (design.md section 12):
 *
 * - {@link planClaimSideEffects} — what a team's next *real* claim triggers:
 *   consume every Next_Claim_Restriction targeting the team, attach the oldest
 *   pending Insurance with a protected floor equal to the post-claim allocation,
 *   add +5 for each active Happy Hour window on the bar the team has not already
 *   been paid for, advance every Patient Investor counter (paying out +6 and
 *   consuming on the fourth distinct bar, finish bar included), and report
 *   whether a Power Hour draw override is active.
 * - {@link planUnclaimSideEffects} — reversing a claim. An `ordinary_unclaim`
 *   reverses that claim's Happy Hour bonuses (−5), uncounts the bar from unpaid
 *   counters, and releases Insurance attached to the claim. A `voted_off` removal
 *   only releases attached protection (awards and counters are left intact, 18.7).
 * - {@link planBonusClaim} — validating a Happy Hour Bonus_Claim. It consumes
 *   nothing: no restrictions, no Insurance, no counters.
 *
 * The Bonus_Claim validation reuses `evaluateClaimBlocks` from
 * `lib/claims/blocks.ts` (task 3.5) in `mode: "bonus"`, so a Bonus_Claim is
 * blocked by exactly the same temporary locks as a claim but is never blocked by
 * a next-claim restriction (Requirement 10.7).
 *
 * See design.md section 12.
 */

import type { BehaviorState, ResolvedBarRef } from "./behaviorState";
import { isEffectActive, drawOverrideActive } from "./effects";
import {
  evaluateClaimBlocks,
  previousBarFor,
  type ClaimBlock,
} from "@/lib/claims/blocks";
import type { LatLng } from "@/lib/map/geo";

// ---------------------------------------------------------------------------
// Inputs and outputs.
// ---------------------------------------------------------------------------

/**
 * The real claim a {@link planClaimSideEffects} plan is computed for: the newly
 * inserted claim row's identity, the claiming team, and the board-facing bar key.
 */
export interface NewClaim {
  readonly claimId: string;
  readonly teamId: string;
  readonly barKey: string;
}

/**
 * One distinct bar a Patient Investor counter has counted: the claim that counted
 * it and that claim's bar key. The counter stores these in `params.counted`; the
 * bar key is what makes a count "distinct", so re-claiming the same bar never
 * advances a counter twice (Requirement 16.2).
 */
export interface CountedClaim {
  readonly claimId: string;
  readonly barKey: string;
}

/**
 * The card-driven side effects of one real claim. Every list is the set of
 * durable changes the route writes in the same transaction as the claim.
 */
export interface ClaimSideEffects {
  /** `next_claim_restriction` effect ids to consume for the team (10.6). */
  readonly consumeEffects: readonly string[];
  /** The Insurance protection to attach to this claim, with its floor (15.2). */
  readonly attachProtection: {
    readonly effectId: string;
    readonly protectedPoints: number;
  } | null;
  /** The Happy Hour window to award +5 against, if any (13.3). */
  readonly happyHourAward: { readonly effectId: string } | null;
  /**
   * The Patient Investor counters to update. Each carries the counter's full new
   * `counted` list and whether this claim triggered its +6 payout and
   * consumption (16.4).
   */
  readonly counterUpdates: readonly {
    readonly effectId: string;
    readonly counted: readonly CountedClaim[];
    readonly payout: boolean;
  }[];
  /** True when a Power Hour draw override is active at the claim (17.2). */
  readonly drawOverride: boolean;
}

/** The card-driven side effects of one unclaim. */
export interface UnclaimSideEffects {
  /** Happy Hour award ids to reverse (`−5`), for `ordinary_unclaim` only (13.9). */
  readonly reverseAwards: readonly string[];
  /**
   * Patient Investor counters to roll back, with this claim's bar removed from
   * their `counted` list. Only unpaid counters are touched, and only for an
   * `ordinary_unclaim` (16.3).
   */
  readonly uncount: readonly {
    readonly effectId: string;
    readonly counted: readonly CountedClaim[];
  }[];
  /** Insurance protection ids attached to this claim to release (15.5). */
  readonly releaseProtections: readonly string[];
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/** Parse an ISO server timestamp to epoch ms, or `null` when absent/invalid. */
function parseMs(iso: string | null): number | null {
  if (iso === null) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Read a Patient Investor counter's persisted `counted` list from its params. */
export function countedFromParams(
  params: Readonly<Record<string, unknown>>,
): CountedClaim[] {
  const raw = params.counted;
  if (!Array.isArray(raw)) {
    return [];
  }
  const counted: CountedClaim[] = [];
  for (const item of raw) {
    if (
      item !== null &&
      typeof item === "object" &&
      typeof (item as { claimId?: unknown }).claimId === "string" &&
      typeof (item as { barKey?: unknown }).barKey === "string"
    ) {
      counted.push({
        claimId: (item as CountedClaim).claimId,
        barKey: (item as CountedClaim).barKey,
      });
    }
  }
  return counted;
}

/** The number of distinct claims to count before a Patient Investor pays out. */
export const PATIENT_INVESTOR_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// Claim side effects.
// ---------------------------------------------------------------------------

/**
 * Plan the card-driven side effects of one real claim by `claim.teamId` on
 * `claim.barKey` at server time `nowMs`.
 *
 * - **Restrictions:** every active `next_claim_restriction` targeting the team is
 *   consumed — the claim is the "next claim" those restrictions gate, so they are
 *   spent whether or not they blocked anything earlier (10.6, 10.7).
 * - **Insurance:** the oldest active, unattached `score_protection` owned by the
 *   team attaches to this claim, with `protectedPoints` equal to the team's
 *   allocation right after the claim (`allocationAfter`) so a later claimant
 *   cannot erode it (15.1, 15.2).
 * - **Happy Hour:** for each active `bonus_window` on the bar the team has not yet
 *   been paid an unreversed bonus for, a single +5 award is planned. A team can
 *   only ever hold one unreversed Happy Hour bonus per window (13.3, 13.6, 13.7).
 * - **Patient Investor:** each active `claim_counter` owned by the team counts
 *   this claim's bar unless the bar key is already in its `counted` list. On
 *   reaching four distinct bars it pays out +6 and is consumed in the same
 *   transaction — including when the fourth bar is the finish bar (16.2, 16.4).
 * - **Power Hour:** `drawOverride` is the union of active Power Hour windows
 *   (17.2).
 *
 * The returned plan references only effects already in `state`; nothing here is a
 * no-op guess, so the route can apply every entry directly.
 */
export function planClaimSideEffects(
  state: BehaviorState,
  claim: NewClaim,
  allocationAfter: ReadonlyMap<string, number>,
  nowMs: number,
): ClaimSideEffects {
  // Restrictions: consume every active next_claim_restriction targeting the team.
  const consumeEffects: string[] = [];
  for (const effect of state.effects) {
    if (effect.kind !== "next_claim_restriction") {
      continue;
    }
    if (effect.targetTeamId !== claim.teamId) {
      continue;
    }
    if (!isEffectActive(effect, nowMs)) {
      continue;
    }
    consumeEffects.push(effect.effectId);
  }

  // Insurance: attach the oldest active, unattached protection owned by the team.
  let attachProtection: ClaimSideEffects["attachProtection"] = null;
  let oldestProtectionMs: number | null = null;
  for (const effect of state.effects) {
    if (effect.kind !== "score_protection") {
      continue;
    }
    if (effect.ownerTeamId !== claim.teamId) {
      continue;
    }
    if (effect.attachedClaimId !== null) {
      continue;
    }
    if (!isEffectActive(effect, nowMs)) {
      continue;
    }
    const startMs = parseMs(effect.startsAt) ?? Number.POSITIVE_INFINITY;
    if (
      oldestProtectionMs === null ||
      startMs < oldestProtectionMs ||
      (startMs === oldestProtectionMs &&
        attachProtection !== null &&
        effect.effectId < attachProtection.effectId)
    ) {
      oldestProtectionMs = startMs;
      attachProtection = {
        effectId: effect.effectId,
        protectedPoints: allocationAfter.get(claim.teamId) ?? 0,
      };
    }
  }

  // Happy Hour: +5 for each active bonus_window on the bar with no unreversed
  // award for the team. A team holds at most one unreversed bonus per window, so
  // the first eligible window is awarded.
  let happyHourAward: ClaimSideEffects["happyHourAward"] = null;
  for (const effect of state.effects) {
    if (effect.kind !== "bonus_window") {
      continue;
    }
    if (effect.targetBarKey !== claim.barKey) {
      continue;
    }
    if (!isEffectActive(effect, nowMs)) {
      continue;
    }
    const alreadyAwarded = state.awards.some(
      (award) =>
        award.kind === "happy_hour_bonus" &&
        award.effectId === effect.effectId &&
        award.teamId === claim.teamId &&
        award.reversedAt === null,
    );
    if (alreadyAwarded) {
      continue;
    }
    happyHourAward = { effectId: effect.effectId };
    break;
  }

  // Patient Investor: advance every active counter owned by the team.
  const counterUpdates: {
    effectId: string;
    counted: readonly CountedClaim[];
    payout: boolean;
  }[] = [];
  for (const effect of state.effects) {
    if (effect.kind !== "claim_counter") {
      continue;
    }
    if (effect.ownerTeamId !== claim.teamId) {
      continue;
    }
    if (!isEffectActive(effect, nowMs)) {
      continue;
    }
    const counted = countedFromParams(effect.params);
    if (counted.some((c) => c.barKey === claim.barKey)) {
      // This bar already counted toward the payout; the counter does not advance.
      continue;
    }
    const nextCounted = [
      ...counted,
      { claimId: claim.claimId, barKey: claim.barKey },
    ];
    const payout = nextCounted.length >= PATIENT_INVESTOR_THRESHOLD;
    counterUpdates.push({
      effectId: effect.effectId,
      counted: nextCounted,
      payout,
    });
  }

  return {
    consumeEffects,
    attachProtection,
    happyHourAward,
    counterUpdates,
    drawOverride: drawOverrideActive(state.effects, nowMs),
  };
}

// ---------------------------------------------------------------------------
// Unclaim side effects.
// ---------------------------------------------------------------------------

/**
 * Plan the card-driven side effects of removing the claim `claimId`.
 *
 * - **Ordinary unclaim:** reverses every unreversed Happy Hour award booked
 *   against this claim (−5), removes the claim's bar from every unpaid Patient
 *   Investor counter's `counted` list, and releases any Insurance attached to the
 *   claim (13.9, 15.5, 16.3). A counter that has already paid out is left alone.
 * - **Voted Off removal:** only releases Insurance attached to the claim. Happy
 *   Hour awards and Patient Investor counts survive, because the removal is an
 *   opponent's card effect, not the team walking its own claim back (18.7).
 *
 * An unknown `claimId` yields empty lists.
 */
export function planUnclaimSideEffects(
  state: BehaviorState,
  claimId: string,
  reason: "ordinary_unclaim" | "voted_off",
): UnclaimSideEffects {
  // Insurance attached to this claim is released under either reason.
  const releaseProtections: string[] = [];
  for (const effect of state.effects) {
    if (effect.kind !== "score_protection") {
      continue;
    }
    if (effect.attachedClaimId !== claimId) {
      continue;
    }
    if (effect.cancelledAt !== null || effect.consumedAt !== null) {
      continue;
    }
    releaseProtections.push(effect.effectId);
  }

  if (reason === "voted_off") {
    return { reverseAwards: [], uncount: [], releaseProtections };
  }

  // Ordinary unclaim reverses this claim's Happy Hour bonuses.
  const reverseAwards: string[] = [];
  for (const award of state.awards) {
    if (award.kind !== "happy_hour_bonus") {
      continue;
    }
    if (award.claimId !== claimId) {
      continue;
    }
    if (award.reversedAt !== null) {
      continue;
    }
    reverseAwards.push(award.awardId);
  }

  // Ordinary unclaim uncounts this claim from unpaid Patient Investor counters.
  const uncount: { effectId: string; counted: readonly CountedClaim[] }[] = [];
  for (const effect of state.effects) {
    if (effect.kind !== "claim_counter") {
      continue;
    }
    if (effect.consumedAt !== null) {
      // A consumed counter has already paid out; its count is frozen (16.4).
      continue;
    }
    const counted = countedFromParams(effect.params);
    if (!counted.some((c) => c.claimId === claimId)) {
      continue;
    }
    uncount.push({
      effectId: effect.effectId,
      counted: counted.filter((c) => c.claimId !== claimId),
    });
  }

  return { reverseAwards, uncount, releaseProtections };
}

// ---------------------------------------------------------------------------
// Bonus claim validation.
// ---------------------------------------------------------------------------

/** The accepted plan for a Happy Hour Bonus_Claim. */
export interface BonusClaimPlan {
  /** The Happy Hour window being claimed for its +5 bonus. */
  readonly effectId: string;
  /** The team receiving the bonus. */
  readonly teamId: string;
  /** The bar the bonus is claimed on. */
  readonly barKey: string;
}

/**
 * Validate a Happy Hour Bonus_Claim by `teamId` on `barKey` at server time
 * `nowMs` (design.md section 12). A Bonus_Claim lets a team collect a Happy Hour
 * +5 on a bar it already claimed, without re-claiming or drawing (13.5). It never
 * consumes a next-claim restriction, attaches Insurance, or advances a counter.
 *
 * The checks, in order, reject with a stable error when:
 *
 * 1. the game is not live → `conflict`;
 * 2. the team has no active claim on the bar → `conflict`;
 * 3. no `bonus_window` effect targets the bar at all → `not_found`;
 * 4. the bar's window(s) are present but none is active at `nowMs` → `expired`;
 * 5. the team already holds an unreversed bonus for every active window
 *    → `already_resolved`;
 * 6. `evaluateClaimBlocks(mode: "bonus")` returns any block → `blocked` with
 *    `details.blocks`.
 *
 * On success the plan names the first active, unawarded window.
 */
export function planBonusClaim(
  state: BehaviorState,
  teamId: string,
  barKey: string,
  nowMs: number,
):
  | { readonly ok: true; readonly plan: BonusClaimPlan }
  | {
      readonly ok: false;
      readonly error:
        "conflict" | "not_found" | "expired" | "already_resolved" | "blocked";
      readonly details?: object;
    } {
  // 1. Live game only.
  if (state.lifecycle !== "live") {
    return { ok: false, error: "conflict" };
  }

  // 2. The team must hold an active claim on the bar.
  const hasActiveClaim = state.activeClaims.some(
    (claim) => claim.teamId === teamId && claim.barKey === barKey,
  );
  if (!hasActiveClaim) {
    return { ok: false, error: "conflict" };
  }

  // 3. There must be a bonus_window effect on the bar.
  const windowsOnBar = state.effects.filter(
    (effect) =>
      effect.kind === "bonus_window" && effect.targetBarKey === barKey,
  );
  if (windowsOnBar.length === 0) {
    return { ok: false, error: "not_found" };
  }

  // 4. At least one window must be active at the server time.
  const activeWindows = windowsOnBar.filter((effect) =>
    isEffectActive(effect, nowMs),
  );
  if (activeWindows.length === 0) {
    return { ok: false, error: "expired" };
  }

  // 5. There must be an active window with no unreversed award for the team.
  const claimable = activeWindows.find(
    (effect) =>
      !state.awards.some(
        (award) =>
          award.kind === "happy_hour_bonus" &&
          award.effectId === effect.effectId &&
          award.teamId === teamId &&
          award.reversedAt === null,
      ),
  );
  if (claimable === undefined) {
    return { ok: false, error: "already_resolved" };
  }

  // 6. No claim blocks in bonus mode (which skips next-claim restrictions, 10.7).
  const bar = state.bars.get(barKey);
  const barRef: ResolvedBarRef = {
    barKey,
    kind: bar?.kind ?? "scoring",
    coords: bar?.coords ?? null,
  };

  const finishBar =
    state.finishBarKey === null
      ? undefined
      : state.bars.get(state.finishBarKey);
  const finishCoords = finishBar?.coords ?? null;

  const startBarRef: ResolvedBarRef =
    state.startBarKey !== null && state.bars.has(state.startBarKey)
      ? {
          barKey: state.startBarKey,
          kind: "start",
          coords: state.bars.get(state.startBarKey)!.coords,
        }
      : { barKey: "", kind: "start", coords: null };

  const previousRef = previousBarFor(teamId, state.claimHistory, startBarRef);
  const previousBar: ResolvedBarRef =
    previousRef.coords === null && previousRef.barKey !== ""
      ? {
          ...previousRef,
          coords: state.bars.get(previousRef.barKey)?.coords ?? null,
        }
      : previousRef;

  const barCoords = new Map<string, LatLng>();
  for (const b of state.bars.values()) {
    if (b.coords !== null) {
      barCoords.set(b.barKey, b.coords);
    }
  }

  const blocks: readonly ClaimBlock[] = evaluateClaimBlocks({
    teamId,
    bar: barRef,
    finishCoords,
    challenges: state.challenges,
    effects: state.effects,
    activeClaims: state.activeClaims.map((c) => ({
      teamId: c.teamId,
      barKey: c.barKey,
    })),
    previousBar,
    barCoords,
    mode: "bonus",
    nowMs,
  });
  if (blocks.length > 0) {
    return { ok: false, error: "blocked", details: { blocks } };
  }

  return {
    ok: true,
    plan: { effectId: claimable.effectId, teamId, barKey },
  };
}
