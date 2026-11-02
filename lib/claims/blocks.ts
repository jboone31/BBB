/**
 * Claim blocks (`lib/claims/blocks.ts`).
 *
 * Pure, framework-free module. It is the single place that decides why a team
 * may not claim a given bar right now. `evaluateClaimBlocks` collects *every*
 * reason (it never short-circuits) so a rejection can list all blocking cards
 * with the end Clock_Time of each timed block (design.md section 10;
 * Requirements 4.2, 4.3, 7.3, 10.2, 10.4, 10.5, 10.7, 11.3, 12.4, 19.1, 19.3,
 * 20.3c, 21.11).
 *
 * The checks run in the order fixed by Requirement 19.1:
 *
 *   1. Challenge gate — one `challenge` block per `open` challenge targeting the
 *      team (4.2).
 *   2. Critic block — one `critic_block` per active Everyone's a Critic failure
 *      block on the team (7.3).
 *   3. Crop Dusting — one `bar_lock` per active lock on the bar, except the lock
 *      the team owns (owner exempt, 11.3).
 *   4. Cancel Culture — one `radius_lock` per active lock whose center is within
 *      the inclusive 0.25-mile radius of the bar; a bar with no coordinates, or a
 *      lock with no coordinates, is never blocked (12.4).
 *   5. In `claim` mode only (never `bonus`, 10.7): Pioneer (`finish_bar`,
 *      `claimed_by_other`) and Scenic Route (`not_farther`, `no_coordinates`)
 *      next-claim restrictions.
 *
 * Every window decision is made against the server `nowMs` passed in, never
 * against an effect's announced flags, so the blocks hold identically whether or
 * not a transition event has been appended (Requirement 20.3c). Only
 * uncancelled, unconsumed restrictions apply, so a host-ended restriction stops
 * blocking (Requirement 21.11) — `isEffectActive` already rejects any effect
 * cancelled or consumed at or before `nowMs`.
 *
 * Pioneer `claimed_by_other` and Scenic `not_farther` are decided with
 * `barSatisfiesRule` from `lib/claims/legalNextBar.ts` (Component 9a) so
 * restriction blocks and Legal_Next_Bar never disagree. `previousBarFor` lives
 * in that module (to avoid a circular import) and is re-exported here.
 */

import type { CardSlug } from "@/lib/cards/catalog";
import type {
  ChallengeRecord,
  EffectRecord,
  ResolvedBarRef,
} from "@/lib/cards/behaviorState";
import { isEffectActive } from "@/lib/cards/effects";
import {
  CANCEL_CULTURE_RADIUS_MILES,
  withinMiles,
  type LatLng,
} from "@/lib/map/geo";
import {
  barSatisfiesRule,
  previousBarFor,
  type LegalNextBarInput,
  type NextClaimRule,
} from "@/lib/claims/legalNextBar";

// Re-export `previousBarFor` so callers can get it from the blocks module
// (its definition lives in legalNextBar.ts to avoid a circular import).
export { previousBarFor };

// ---------------------------------------------------------------------------
// Block vocabulary.
// ---------------------------------------------------------------------------

/**
 * A single reason a claim is blocked. Timed blocks carry the blocking effect's
 * end time (`endsAt`, ISO server time) so the UI can show an end Clock_Time; the
 * challenge gate and the next-claim restrictions carry no end time because they
 * clear by resolution, not by the clock.
 */
export type ClaimBlock =
  | {
      readonly kind: "challenge";
      readonly slug: CardSlug;
      readonly challengeId: string;
    }
  | {
      readonly kind: "critic_block";
      readonly slug: "everyones-a-critic";
      readonly effectId: string;
      readonly endsAt: string;
    }
  | {
      readonly kind: "bar_lock";
      readonly slug: "crop-dusting";
      readonly effectId: string;
      readonly endsAt: string;
    }
  | {
      readonly kind: "radius_lock";
      readonly slug: "cancel-culture";
      readonly effectId: string;
      readonly endsAt: string;
    }
  | {
      readonly kind: "pioneer";
      readonly slug: "pioneer";
      readonly effectId: string;
      readonly reason: "finish_bar" | "claimed_by_other";
    }
  | {
      readonly kind: "scenic";
      readonly slug: "scenic-route";
      readonly effectId: string;
      readonly reason: "not_farther" | "no_coordinates";
    };

/**
 * The server facts `evaluateClaimBlocks` reads. `mode` is `"claim"` for an
 * ordinary claim (next-claim restrictions apply) or `"bonus"` for a Happy Hour
 * Bonus_Claim (restrictions skipped, 10.7). `barCoords` resolves Cancel Culture
 * lock centers by bar key; `finishCoords` and `previousBar` feed Scenic Route.
 */
export interface ClaimBlockInput {
  readonly teamId: string;
  readonly bar: ResolvedBarRef; // key, kind, coords
  readonly finishCoords: LatLng | null;
  readonly challenges: readonly ChallengeRecord[];
  readonly effects: readonly EffectRecord[];
  readonly activeClaims: readonly {
    readonly teamId: string;
    readonly barKey: string;
  }[];
  readonly previousBar: ResolvedBarRef; // from previousBarFor
  readonly barCoords: ReadonlyMap<string, LatLng>;
  readonly mode: "claim" | "bonus"; // bonus skips next-claim restrictions (10.7)
  readonly nowMs: number;
}

// ---------------------------------------------------------------------------
// Evaluation.
// ---------------------------------------------------------------------------

/**
 * Collect every reason the team may not claim `input.bar` at `input.nowMs`. The
 * list is empty iff the claim is allowed. Blocks are appended in the Requirement
 * 19.1 order (challenge gate, critic block, Crop Dusting, Cancel Culture, then —
 * in `claim` mode only — Pioneer and Scenic Route); nothing short-circuits, so
 * all applicable blocks are reported.
 */
export function evaluateClaimBlocks(input: ClaimBlockInput): ClaimBlock[] {
  const { teamId, bar, effects, nowMs, mode } = input;
  const blocks: ClaimBlock[] = [];

  // 1. Challenge gate: one block per open challenge targeting the team (4.2).
  for (const challenge of input.challenges) {
    if (challenge.targetTeamId === teamId && challenge.status === "open") {
      blocks.push({
        kind: "challenge",
        slug: challenge.slug,
        challengeId: challenge.challengeId,
      });
    }
  }

  // 2. Critic block: one per active Everyone's a Critic failure block on the
  //    team (7.3).
  for (const effect of effects) {
    if (
      effect.kind === "team_claim_block" &&
      effect.targetTeamId === teamId &&
      effect.endsAt !== null &&
      isEffectActive(effect, nowMs)
    ) {
      blocks.push({
        kind: "critic_block",
        slug: "everyones-a-critic",
        effectId: effect.effectId,
        endsAt: effect.endsAt,
      });
    }
  }

  // 3. Crop Dusting: one per active lock on this bar, owner exempt (11.3).
  for (const effect of effects) {
    if (
      effect.kind === "bar_lock" &&
      effect.targetBarKey === bar.barKey &&
      effect.ownerTeamId !== teamId &&
      effect.endsAt !== null &&
      isEffectActive(effect, nowMs)
    ) {
      blocks.push({
        kind: "bar_lock",
        slug: "crop-dusting",
        effectId: effect.effectId,
        endsAt: effect.endsAt,
      });
    }
  }

  // 4. Cancel Culture: one per active lock whose center is within the inclusive
  //    0.25-mile radius of this bar (12.4). A bar with no coordinates, or a lock
  //    whose center has no resolvable coordinates, is never blocked.
  if (bar.coords !== null) {
    for (const effect of effects) {
      if (
        effect.kind !== "radius_lock" ||
        effect.endsAt === null ||
        !isEffectActive(effect, nowMs)
      ) {
        continue;
      }
      const center =
        effect.targetBarKey === null
          ? undefined
          : input.barCoords.get(effect.targetBarKey);
      if (center === undefined) {
        continue;
      }
      if (withinMiles(bar.coords, center, CANCEL_CULTURE_RADIUS_MILES)) {
        blocks.push({
          kind: "radius_lock",
          slug: "cancel-culture",
          effectId: effect.effectId,
          endsAt: effect.endsAt,
        });
      }
    }
  }

  // 5. Next-claim restrictions (Pioneer, Scenic Route): claim mode only (10.7).
  if (mode === "claim") {
    const legalInput: LegalNextBarInput = {
      teamId,
      rules: [],
      bars: [bar],
      finishCoords: input.finishCoords,
      activeClaims: input.activeClaims,
      previousBar: input.previousBar,
    };

    for (const effect of effects) {
      if (
        effect.kind !== "next_claim_restriction" ||
        effect.targetTeamId !== teamId ||
        !isEffectActive(effect, nowMs)
      ) {
        continue;
      }
      const rule = effect.params.rule as NextClaimRule | undefined;

      if (rule === "pioneer") {
        if (bar.kind === "finish") {
          blocks.push({
            kind: "pioneer",
            slug: "pioneer",
            effectId: effect.effectId,
            reason: "finish_bar",
          });
        } else if (!barSatisfiesRule("pioneer", bar, legalInput)) {
          blocks.push({
            kind: "pioneer",
            slug: "pioneer",
            effectId: effect.effectId,
            reason: "claimed_by_other",
          });
        }
      } else if (rule === "scenic") {
        if (!barSatisfiesRule("scenic", bar, legalInput)) {
          // Distinguish "missing coordinates" from "not farther": Scenic needs
          // the bar, finish, and previous-bar coordinates all known.
          const reason: "not_farther" | "no_coordinates" =
            bar.coords === null ||
            input.finishCoords === null ||
            input.previousBar.coords === null
              ? "no_coordinates"
              : "not_farther";
          blocks.push({
            kind: "scenic",
            slug: "scenic-route",
            effectId: effect.effectId,
            reason,
          });
        }
      }
    }
  }

  return blocks;
}
