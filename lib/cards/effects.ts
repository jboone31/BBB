/**
 * Effect windows and transitions (`lib/cards/effects.ts`).
 *
 * Pure, framework-free module. It owns the timed-Effect vocabulary for the card
 * behavior feature: the {@link EffectRecord} shape, canonical durations, the
 * window predicates (`effectPhase`, `isEffectActive`, `drawOverrideActive`), the
 * Timer_Sweep transition planner (`planEffectTransitions`), the Boundary_Toast
 * schedule (`toastBoundaries`, `nextBoundaryAfter`), and the host early-end
 * planner (`planHostEffectEnd`).
 *
 * Every window decision is made against a server time in milliseconds. Callers
 * convert the stored ISO server timestamps with `Date.parse`; the predicates
 * here never read device clocks or announced flags, so a block, bonus, or
 * eligibility decision is identical whether or not a transition event has been
 * appended (Requirement 20.3c).
 *
 * See design.md section 6.
 */

import type { CardSlug } from "./catalog";
// `StableError`/`Plan<T>` are owned by behaviorState.ts (task 3.1); import them
// here so this module shares the one canonical definition. These are type-only
// imports (erased at compile time), so the mutual reference with behaviorState.ts
// introduces no runtime cycle.
import type { StableError, Plan } from "./behaviorState";

export type { StableError, Plan };

// ---------------------------------------------------------------------------
// Effect vocabulary.
// ---------------------------------------------------------------------------

export type EffectKind =
  | "bar_lock" // Crop Dusting
  | "radius_lock" // Cancel Culture
  | "team_claim_block" // Everyone's a Critic failure
  | "next_claim_restriction" // Pioneer, Scenic Route (params.rule)
  | "score_protection" // Insurance
  | "bonus_window" // Happy Hour
  | "phantom_share" // Party Crasher
  | "claim_counter" // Patient Investor
  | "draw_override"; // Power Hour

export interface EffectRecord {
  readonly effectId: string;
  readonly slug: CardSlug;
  readonly kind: EffectKind;
  readonly sourcePlayId: string | null;
  readonly sourceChallengeId: string | null;
  readonly ownerTeamId: string | null; // caster / protected / counting team
  readonly targetTeamId: string | null; // restricted / blocked team
  readonly targetBarKey: string | null;
  readonly startsAt: string; // ISO, server time
  readonly endsAt: string | null; // null = until consumed/cancelled
  readonly params: Readonly<Record<string, unknown>>;
  readonly attachedClaimId: string | null; // Insurance after attach
  readonly attachedBarKey: string | null;
  readonly protectedPoints: number | null;
  readonly consumedAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: "host" | "game_ended" | "protection_released" | null;
  readonly startAnnounced: boolean;
  readonly endAnnounced: boolean;
}

/**
 * Canonical effect durations in milliseconds (design.md section 6). All timed
 * windows derive their end time from one of these constants.
 */
export const DURATIONS_MS = {
  cropDusting: 15 * 60_000,
  cancelCultureDelay: 15 * 60_000,
  cancelCultureLock: 15 * 60_000,
  criticBlock: 15 * 60_000,
  happyHour: 60 * 60_000,
  powerHour: 20 * 60_000,
} as const;

// ---------------------------------------------------------------------------
// Time helpers (internal).
// ---------------------------------------------------------------------------

/** Parse an ISO server timestamp to epoch ms, or `null` when absent/invalid. */
function parseMs(iso: string | null): number | null {
  if (iso === null) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// Window predicates.
// ---------------------------------------------------------------------------

export type EffectPhase = "pending" | "active" | "ended";

/**
 * Classify an effect at server time `tMs`:
 * - `pending` before its start,
 * - `active` while it is live (see {@link isEffectActive}),
 * - `ended` once it has stopped (end time, consumption, or cancellation reached).
 */
export function effectPhase(e: EffectRecord, tMs: number): EffectPhase {
  const start = parseMs(e.startsAt);
  if (start !== null && tMs < start) {
    return "pending";
  }
  if (isEffectActive(e, tMs)) {
    return "active";
  }
  return "ended";
}

/**
 * An effect is active at `tMs` iff `startsAt <= t < endsAt` (or `endsAt` null)
 * and it was not cancelled or consumed at or before `t`
 * (`cancelledAt`/`consumedAt` null or strictly after `t`).
 */
export function isEffectActive(e: EffectRecord, tMs: number): boolean {
  const start = parseMs(e.startsAt);
  if (start === null || tMs < start) {
    return false;
  }
  const end = parseMs(e.endsAt);
  if (end !== null && tMs >= end) {
    return false;
  }
  const cancelled = parseMs(e.cancelledAt);
  if (cancelled !== null && tMs >= cancelled) {
    return false;
  }
  const consumed = parseMs(e.consumedAt);
  if (consumed !== null && tMs >= consumed) {
    return false;
  }
  return true;
}

/**
 * Power Hour overlap (Requirement 17.3): the draw override is active when any
 * non-cancelled `draw_override` window is active at `tMs`. Because this is a
 * union of windows, overlapping Power Hour plays stay active until the latest
 * end.
 */
export function drawOverrideActive(
  effects: readonly EffectRecord[],
  tMs: number,
): boolean {
  return effects.some(
    (e) => e.kind === "draw_override" && isEffectActive(e, tMs),
  );
}

// ---------------------------------------------------------------------------
// Timer_Sweep transition planner.
// ---------------------------------------------------------------------------

export type EffectTransition = {
  readonly effectId: string;
  readonly kind: "activated" | "expired";
  readonly atMs: number;
};

/**
 * Plan the activation/expiry transitions that are due at `nowMs`, mirrored by
 * the SQL settle function (design.md section 6):
 *
 * - The game must be live; no transitions are planned otherwise.
 * - Activation is due when `!startAnnounced`, `startsAt <= now`, and the effect
 *   was not cancelled before `startsAt`. (Effects that start immediately are
 *   inserted with `start_announced_at = created_at`, so in practice only Cancel
 *   Culture produces an activation event.)
 * - Expiry is due when `!endAnnounced`, `endsAt <= now`, the effect was not
 *   consumed, and it was not cancelled before `endsAt`.
 * - A delayed effect's activation is ordered before its expiry.
 * - Transitions are ordered by `atMs`, then `effectId`.
 */
export function planEffectTransitions(
  effects: readonly EffectRecord[],
  nowMs: number,
  lifecycle: "lobby" | "live" | "ended",
): EffectTransition[] {
  if (lifecycle !== "live") {
    return [];
  }

  const transitions: EffectTransition[] = [];

  for (const e of effects) {
    const start = parseMs(e.startsAt);
    const cancelled = parseMs(e.cancelledAt);
    const consumed = parseMs(e.consumedAt);

    // Activation.
    if (
      !e.startAnnounced &&
      start !== null &&
      start <= nowMs &&
      !(cancelled !== null && cancelled < start)
    ) {
      transitions.push({
        effectId: e.effectId,
        kind: "activated",
        atMs: start,
      });
    }

    // Expiry.
    const end = parseMs(e.endsAt);
    if (
      !e.endAnnounced &&
      end !== null &&
      end <= nowMs &&
      consumed === null &&
      !(cancelled !== null && cancelled < end)
    ) {
      transitions.push({ effectId: e.effectId, kind: "expired", atMs: end });
    }
  }

  transitions.sort((a, b) => {
    if (a.atMs !== b.atMs) {
      return a.atMs - b.atMs;
    }
    if (a.effectId !== b.effectId) {
      return a.effectId < b.effectId ? -1 : 1;
    }
    // Same effect at the same boundary: activation before expiry.
    if (a.kind !== b.kind) {
      return a.kind === "activated" ? -1 : 1;
    }
    return 0;
  });

  return transitions;
}

// ---------------------------------------------------------------------------
// Boundary_Toast schedule.
//
// Shared by the board timer and `deriveBoundaryToasts` (projection). The board
// shows each boundary at most once per board (Requirement 20.12).
// ---------------------------------------------------------------------------

export type BoundaryKind = "start" | "end";

export interface Boundary {
  readonly effectId: string;
  readonly kind: BoundaryKind;
  readonly atMs: number;
}

/**
 * The Boundary_Toasts an effect set can produce:
 *
 * - start: Cancel Culture `radius_lock` only (its delayed start toast, 12.6).
 * - end: `bar_lock`, `radius_lock`, `bonus_window`, and `draw_override` with a
 *   non-null `endsAt` that was not cancelled or consumed at or before `endsAt`,
 *   so host and game-end cancellations produce no end toast (Requirement 20.6).
 *
 * Boundaries are returned ordered by `atMs`, then `effectId`, then start before
 * end.
 */
export function toastBoundaries(effects: readonly EffectRecord[]): Boundary[] {
  const boundaries: Boundary[] = [];

  for (const e of effects) {
    // Start toast: Cancel Culture radius_lock only.
    if (e.kind === "radius_lock") {
      const start = parseMs(e.startsAt);
      if (start !== null) {
        boundaries.push({ effectId: e.effectId, kind: "start", atMs: start });
      }
    }

    // End toast: timed locks / windows that actually reach their natural end.
    if (
      e.kind === "bar_lock" ||
      e.kind === "radius_lock" ||
      e.kind === "bonus_window" ||
      e.kind === "draw_override"
    ) {
      const end = parseMs(e.endsAt);
      if (end !== null) {
        const cancelled = parseMs(e.cancelledAt);
        const consumed = parseMs(e.consumedAt);
        const cancelledBeforeEnd = cancelled !== null && cancelled <= end;
        const consumedBeforeEnd = consumed !== null && consumed <= end;
        if (!cancelledBeforeEnd && !consumedBeforeEnd) {
          boundaries.push({ effectId: e.effectId, kind: "end", atMs: end });
        }
      }
    }
  }

  boundaries.sort((a, b) => {
    if (a.atMs !== b.atMs) {
      return a.atMs - b.atMs;
    }
    if (a.effectId !== b.effectId) {
      return a.effectId < b.effectId ? -1 : 1;
    }
    if (a.kind !== b.kind) {
      return a.kind === "start" ? -1 : 1;
    }
    return 0;
  });

  return boundaries;
}

/**
 * The first Boundary_Toast strictly after `serverNowMs`, or `null` when none
 * remain. Used by the board timer to schedule its next wake-up.
 */
export function nextBoundaryAfter(
  effects: readonly EffectRecord[],
  serverNowMs: number,
): Boundary | null {
  let next: Boundary | null = null;
  for (const b of toastBoundaries(effects)) {
    if (b.atMs > serverNowMs) {
      if (next === null || b.atMs < next.atMs) {
        next = b;
      }
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Host early end.
// ---------------------------------------------------------------------------

/**
 * The structural slice of `BehaviorState` that `planHostEffectEnd` reads. The
 * full `BehaviorState` (task 3.1) is assignable to this, so the planner takes
 * the real snapshot without a circular import while behaviorState.ts is pending.
 */
export interface HostEffectEndState {
  readonly lifecycle: "lobby" | "live" | "ended";
  readonly effects: readonly EffectRecord[];
}

/**
 * The plan for a host ending one effect early (design.md section 6,
 * Requirements 21.4-21.6):
 *
 * - `effectId`, `cancelledAt = now`, `cancelReason = "host"`.
 * - `reconcileBars`: bar keys whose share rule must be restored — the Party
 *   Crasher's bar (phantom removed) or an attached Insurance's bar (floor
 *   removed).
 * - `releaseProtections`: effect ids of Insurance protections to release
 *   (the ended effect itself when it is `score_protection`). Awards already in
 *   the ledger are left untouched (21.6).
 */
export interface HostEffectPlan {
  readonly effectId: string;
  readonly cancelledAt: string;
  readonly cancelReason: "host";
  readonly reconcileBars: readonly string[];
  readonly releaseProtections: readonly string[];
}

/**
 * Plan a host early-end for one effect. Rejects with `already_resolved` when the
 * effect is already ended (its end time has passed), consumed, or cancelled, and
 * writes nothing. An unknown effect id rejects with `not_found`.
 */
export function planHostEffectEnd(
  state: HostEffectEndState,
  effectId: string,
  now: string,
): Plan<HostEffectPlan> {
  const effect = state.effects.find((e) => e.effectId === effectId);
  if (effect === undefined) {
    return { ok: false, error: "not_found" };
  }

  const nowMs = Date.parse(now);

  // Already consumed or cancelled -> nothing to do.
  if (effect.consumedAt !== null || effect.cancelledAt !== null) {
    return { ok: false, error: "already_resolved" };
  }

  // Already ended by its natural end time -> nothing to cancel.
  const end = parseMs(effect.endsAt);
  if (end !== null && !Number.isNaN(nowMs) && end <= nowMs) {
    return { ok: false, error: "already_resolved" };
  }

  // Determine the share corrections and protection releases this end triggers.
  const reconcileBars: string[] = [];
  const releaseProtections: string[] = [];

  if (effect.kind === "phantom_share") {
    // Party Crasher: restore the normal share rule for its bar.
    if (effect.targetBarKey !== null) {
      reconcileBars.push(effect.targetBarKey);
    }
  } else if (effect.kind === "score_protection") {
    // Insurance: release the protection, then reconcile the bar it is attached
    // to (if it has already attached to a claim).
    releaseProtections.push(effect.effectId);
    const bar = effect.attachedBarKey ?? effect.targetBarKey;
    if (bar !== null) {
      reconcileBars.push(bar);
    }
  }

  return {
    ok: true,
    plan: {
      effectId: effect.effectId,
      cancelledAt: now,
      cancelReason: "host",
      reconcileBars,
      releaseProtections,
    },
  };
}
