/**
 * Card-behavior board selectors (`lib/gameboard/cardBehavior.ts`, task 9.2).
 *
 * Pure, framework-free read selectors over the time-independent
 * {@link CardBehaviorView} fold (task 9.1, `lib/gameboard/events.ts`) plus a
 * server time in milliseconds. The fold deliberately keeps no time-derived
 * state so it stays deterministic and snapshot-equivalent (design.md §Projection
 * Changes); every window, phase, block, overlay, and host decision is computed
 * here from the folded records and the `serverNowMs` the board passes in
 * (`serverNow(Date.now(), offset)`, 20.7).
 *
 * None of these functions mutate the view or the context; they only read. They
 * reuse the same pure predicates the server planners use —
 * `isEffectActive`/`effectPhase` from `lib/cards/effects`, `evaluateClaimBlocks`
 * from `lib/claims/blocks`, and the Legal_Next_Bar helpers — so the board and the
 * routes never disagree about whether an effect is live or a claim is blocked
 * (Requirements 4.5, 10.9, 11.6, 12.8, 13.4, 20.7, 21.10, 21.11).
 *
 * The board timers use `nextBoundaryAfter` from `lib/cards/effects` directly;
 * there is deliberately no separate boundary selector here (design.md §Projection
 * Changes).
 */

import type { ChallengeRecord, EffectRecord } from "@/lib/cards/behaviorState";
import {
  effectPhase,
  isEffectActive,
  type EffectPhase,
} from "@/lib/cards/effects";
import { remainingMs } from "@/lib/cards/templates";
import { CANCEL_CULTURE_RADIUS_MILES, type LatLng } from "@/lib/map/geo";
import { evaluateClaimBlocks, type ClaimBlock } from "@/lib/claims/blocks";
import type { NextClaimRule } from "@/lib/claims/legalNextBar";
import type { ResolvedBarRef } from "@/lib/cards/behaviorState";
import type { CardBehaviorView } from "@/lib/gameboard/events";

// ---------------------------------------------------------------------------
// Selector context.
// ---------------------------------------------------------------------------

/**
 * The game geometry and claim facts the board already holds (from its snapshot /
 * fold) that the time-independent {@link CardBehaviorView} does not carry: the
 * resolved bars, which bars are claimed by which team right now, and each team's
 * previous bar (via {@link ResolvedBarRef}). `selectClaimBlocksForBar` and
 * `selectMapOverlays` read it to feed the shared `evaluateClaimBlocks` and to
 * place distance-based overlays; the challenge/offer/effect/award records all
 * come from the `view`.
 */
export interface CardBehaviorSelectorContext {
  /** Every game bar (key, kind, coords), keyed by bar key. */
  readonly bars: ReadonlyMap<string, ResolvedBarRef>;
  /** The finish bar's coordinates, or null when unknown. */
  readonly finishCoords: LatLng | null;
  /** Active claims across all teams (team + bar key). */
  readonly activeClaims: readonly {
    readonly teamId: string;
    readonly barKey: string;
  }[];
  /**
   * Each team's previous bar, keyed by team id (from `previousBarFor`). Scenic
   * Route reads it; a team absent from the map is treated as having no previous
   * bar for distance purposes.
   */
  readonly previousBarByTeam: ReadonlyMap<string, ResolvedBarRef>;
}

// ---------------------------------------------------------------------------
// Open challenges.
// ---------------------------------------------------------------------------

/**
 * The open challenges that gate `teamId`'s claims: every folded challenge
 * targeting the team whose status is still `open` (Requirement 4.2, the
 * Challenge_Gate). An empty result means no challenge is holding the team up.
 * Ordered by challenge id so the list is stable across folds.
 */
export function selectOpenChallengesFor(
  view: CardBehaviorView,
  teamId: string,
): ChallengeRecord[] {
  return Object.values(view.challenges)
    .filter(
      (challenge) =>
        challenge.targetTeamId === teamId && challenge.status === "open",
    )
    .sort((a, b) => (a.challengeId < b.challengeId ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Effect phases.
// ---------------------------------------------------------------------------

/** One timed effect classified at the server time, with its remaining window. */
export interface EffectPhaseView {
  readonly effect: EffectRecord;
  readonly phase: EffectPhase;
  /** Milliseconds until `endsAt`, clamped at 0; 0 for an open-ended effect. */
  readonly remainingMs: number;
}

/**
 * Every folded effect classified at `serverNowMs`: `pending` before it starts,
 * `active` while it is live, `ended` once it has stopped (end time, consumption,
 * or cancellation). `remainingMs` counts down to `endsAt` (0 for an effect with
 * no end time). Drives the Effects_Strip countdowns (Requirement 20.7). Ordered
 * by effect id for a stable render.
 */
export function selectEffectPhases(
  view: CardBehaviorView,
  serverNowMs: number,
): EffectPhaseView[] {
  return Object.values(view.effects)
    .map((effect) => ({
      effect,
      phase: effectPhase(effect, serverNowMs),
      remainingMs:
        effect.endsAt === null ? 0 : remainingMs(effect.endsAt, serverNowMs),
    }))
    .sort((a, b) => (a.effect.effectId < b.effect.effectId ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Claim blocks for a bar.
// ---------------------------------------------------------------------------

/**
 * The reasons `teamId` may not claim `barKey` at `serverNowMs`, by wrapping the
 * shared {@link evaluateClaimBlocks} (`claim` mode) with the board's geometry.
 * An empty list means the claim is allowed. This is the board's pre-check that
 * drives `CLAIM_BLOCKED_HEADLINE` and the blocking-card list (Requirements 4.5,
 * 3.10); it reaches the identical verdict the claim route does because both call
 * `evaluateClaimBlocks` against the same server time.
 *
 * A `barKey` absent from `ctx.bars` yields no blocks (the board has no such bar
 * to claim).
 */
export function selectClaimBlocksForBar(
  view: CardBehaviorView,
  ctx: CardBehaviorSelectorContext,
  teamId: string,
  barKey: string,
  serverNowMs: number,
): ClaimBlock[] {
  const bar = ctx.bars.get(barKey);
  if (bar === undefined) {
    return [];
  }

  const previousBar: ResolvedBarRef = ctx.previousBarByTeam.get(teamId) ?? {
    barKey: "",
    kind: "start",
    coords: null,
  };

  const barCoords = new Map<string, LatLng>();
  for (const b of ctx.bars.values()) {
    if (b.coords !== null) {
      barCoords.set(b.barKey, b.coords);
    }
  }

  return evaluateClaimBlocks({
    teamId,
    bar,
    finishCoords: ctx.finishCoords,
    challenges: Object.values(view.challenges),
    effects: Object.values(view.effects),
    activeClaims: ctx.activeClaims,
    previousBar,
    barCoords,
    mode: "claim",
    nowMs: serverNowMs,
  });
}

// ---------------------------------------------------------------------------
// Map overlays.
// ---------------------------------------------------------------------------

/**
 * A single map overlay the Leaflet map renders (design.md §UI Changes,
 * `BarLeafletMap`). Every overlay carries a text `label` so color is never the
 * only signal.
 *
 * - `restriction`: a dashed outline on a bar the restricted team cannot claim
 *   next (shown only to that team, 10.9).
 * - `bar_lock`: a Crop Dusting lock badge on a bar (shown to non-owners, 11.6).
 * - `radius_lock`: a Cancel Culture circle of {@link CANCEL_CULTURE_RADIUS_MILES}
 *   centered on the target bar, `pending` (dashed/translucent) before its start
 *   and `active` once live (12.8).
 * - `bonus_window`: a Happy Hour "+5" badge on a bar.
 */
export type MapOverlay =
  | {
      readonly kind: "restriction";
      readonly effectId: string;
      readonly rule: NextClaimRule;
      readonly teamId: string;
      readonly barKey: string;
      readonly label: string;
    }
  | {
      readonly kind: "bar_lock";
      readonly effectId: string;
      readonly barKey: string;
      readonly label: string;
    }
  | {
      readonly kind: "radius_lock";
      readonly effectId: string;
      readonly barKey: string;
      readonly center: LatLng;
      readonly radiusMiles: number;
      readonly phase: "pending" | "active";
      readonly label: string;
    }
  | {
      readonly kind: "bonus_window";
      readonly effectId: string;
      readonly barKey: string;
      readonly label: string;
    };

/**
 * The overlays to draw for the viewing `teamId` at `serverNowMs`:
 *
 * - Next-claim restrictions targeting `teamId`: one `restriction` overlay per
 *   Legal_Next_Bar the restriction would forbid — i.e. each bar whose claim is
 *   blocked for the team right now — so the dashed outline matches the blocks
 *   (10.9). Restriction overlays are the viewer's own only.
 * - Crop Dusting `bar_lock`s active now, except the viewer's own lock (11.6).
 * - Cancel Culture `radius_lock`s that are pending or active, drawn as a circle
 *   on the target bar's coordinates (12.8); a lock whose center has no
 *   resolvable coordinates is skipped.
 * - Happy Hour `bonus_window`s active now (a "+5" badge).
 *
 * Ordered by effect id, then bar key, for a stable render.
 */
export function selectMapOverlays(
  view: CardBehaviorView,
  ctx: CardBehaviorSelectorContext,
  teamId: string,
  serverNowMs: number,
): MapOverlay[] {
  const overlays: MapOverlay[] = [];
  const effects = Object.values(view.effects);

  for (const effect of effects) {
    switch (effect.kind) {
      case "next_claim_restriction": {
        // Only the restricted team sees its own next-claim outline (10.9).
        if (
          effect.targetTeamId !== teamId ||
          !isEffectActive(effect, serverNowMs)
        ) {
          break;
        }
        const rule = effect.params.rule;
        if (rule !== "pioneer" && rule !== "scenic") {
          break;
        }
        // Outline every bar the team cannot claim next under this restriction,
        // reusing the shared block check so the outline matches the blocks.
        for (const bar of ctx.bars.values()) {
          if (bar.kind === "finish") {
            // Pioneer forbids the finish bar too, but the finish bar is never a
            // Legal_Next_Bar candidate on the map; skip it here.
            continue;
          }
          const blocks = selectClaimBlocksForBar(
            view,
            ctx,
            teamId,
            bar.barKey,
            serverNowMs,
          );
          const blockedByThis = blocks.some(
            (block) =>
              (block.kind === "pioneer" || block.kind === "scenic") &&
              block.effectId === effect.effectId,
          );
          if (blockedByThis) {
            overlays.push({
              kind: "restriction",
              effectId: effect.effectId,
              rule,
              teamId,
              barKey: bar.barKey,
              label:
                rule === "pioneer"
                  ? "Restricted (Pioneer): claim an unclaimed bar next"
                  : "Restricted (Scenic Route): claim farther from the finish next",
            });
          }
        }
        break;
      }

      case "bar_lock": {
        // Crop Dusting: shown to non-owners while the lock is active (11.6).
        if (
          effect.targetBarKey === null ||
          effect.ownerTeamId === teamId ||
          !isEffectActive(effect, serverNowMs)
        ) {
          break;
        }
        overlays.push({
          kind: "bar_lock",
          effectId: effect.effectId,
          barKey: effect.targetBarKey,
          label: "Locked (Crop Dusting)",
        });
        break;
      }

      case "radius_lock": {
        // Cancel Culture: drawn while pending or active (12.8).
        if (effect.targetBarKey === null) {
          break;
        }
        const phase = effectPhase(effect, serverNowMs);
        if (phase === "ended") {
          break;
        }
        const center = ctx.bars.get(effect.targetBarKey)?.coords ?? null;
        if (center === null) {
          break;
        }
        overlays.push({
          kind: "radius_lock",
          effectId: effect.effectId,
          barKey: effect.targetBarKey,
          center,
          radiusMiles: CANCEL_CULTURE_RADIUS_MILES,
          phase,
          label:
            phase === "pending"
              ? "Cancel Culture zone (pending)"
              : "Cancel Culture zone (active)",
        });
        break;
      }

      case "bonus_window": {
        // Happy Hour: "+5" badge while the window is active.
        if (
          effect.targetBarKey === null ||
          !isEffectActive(effect, serverNowMs)
        ) {
          break;
        }
        overlays.push({
          kind: "bonus_window",
          effectId: effect.effectId,
          barKey: effect.targetBarKey,
          label: "Happy Hour +5",
        });
        break;
      }

      default:
        break;
    }
  }

  overlays.sort((a, b) => {
    if (a.effectId !== b.effectId) {
      return a.effectId < b.effectId ? -1 : 1;
    }
    return a.barKey < b.barKey ? -1 : a.barKey > b.barKey ? 1 : 0;
  });

  return overlays;
}

// ---------------------------------------------------------------------------
// Bonus-claimable bars.
// ---------------------------------------------------------------------------

/**
 * The bar keys where `teamId` can take a Happy Hour Bonus_Claim at `serverNowMs`
 * (Requirement 13.4): a bar the team actively claims that has an active
 * `bonus_window` for which the team has no unreversed `happy_hour_bonus` award.
 * The board shows a "Claim bonus" action on these bars.
 *
 * This mirrors `planBonusClaim`'s window/award checks from the view; the server
 * still re-checks blocks and the active claim at write time, so this is a
 * best-effort surface, not the final authority. Sorted bar keys.
 */
export function selectBonusClaimable(
  view: CardBehaviorView,
  teamId: string,
  serverNowMs: number,
): string[] {
  // The view carries no claim rows, so the active-claim requirement is enforced
  // by the route; here a bar is surfaced when it has an active bonus_window the
  // team has not already taken (no unreversed happy_hour_bonus award for it).
  const bars = new Set<string>();

  for (const effect of Object.values(view.effects)) {
    if (
      effect.kind !== "bonus_window" ||
      effect.targetBarKey === null ||
      !isEffectActive(effect, serverNowMs)
    ) {
      continue;
    }
    const hasUnreversedAward = Object.values(view.awards).some(
      (award) =>
        award.kind === "happy_hour_bonus" &&
        award.effectId === effect.effectId &&
        award.teamId === teamId &&
        award.reversedAt === null,
    );
    if (!hasUnreversedAward) {
      bars.add(effect.targetBarKey);
    }
  }

  return [...bars].sort();
}

// ---------------------------------------------------------------------------
// Host items.
// ---------------------------------------------------------------------------

/**
 * One host-override row in the Host_Card_Panel (Requirement 21.10, 21.11): a
 * challenge with its valid Clear / Reset actions, or a pending/active effect
 * with an End-early action. Each carries a human label and the ids the host
 * route needs.
 */
export type HostItem =
  | {
      readonly kind: "challenge";
      readonly challengeId: string;
      readonly slug: ChallengeRecord["slug"];
      readonly status: ChallengeRecord["status"];
      readonly casterTeamId: string;
      readonly targetTeamId: string;
      readonly actions: readonly ("clear" | "reset")[];
      readonly label: string;
    }
  | {
      readonly kind: "effect";
      readonly effectId: string;
      readonly slug: EffectRecord["slug"];
      readonly effectKind: EffectRecord["kind"];
      readonly phase: EffectPhase;
      /** Present for a next-claim restriction: the restricted team. */
      readonly targetTeamId: string | null;
      readonly rule: NextClaimRule | null;
      readonly actions: readonly "end"[];
      readonly label: string;
    };

/**
 * Every host-overridable item at `serverNowMs` (Requirement 21.10): each folded
 * challenge with its valid actions, and every pending or active effect with an
 * End-early action, including each unconsumed Pioneer or Scenic Route restriction
 * labeled with its team (21.11). An ended, consumed, or cancelled effect is
 * omitted — there is nothing left to end. Challenges are listed first (by id),
 * then effects (by id).
 *
 * Valid challenge actions mirror `hostChallengeOverride`:
 * - `open` → `clear`,
 * - `completed` / `failed` → `reset`,
 * - `cleared_by_host` → none (terminal).
 */
export function selectHostItems(
  view: CardBehaviorView,
  serverNowMs: number,
): HostItem[] {
  const items: HostItem[] = [];

  const challenges = Object.values(view.challenges).sort((a, b) =>
    a.challengeId < b.challengeId ? -1 : 1,
  );
  for (const challenge of challenges) {
    const actions: ("clear" | "reset")[] =
      challenge.status === "open"
        ? ["clear"]
        : challenge.status === "completed" || challenge.status === "failed"
          ? ["reset"]
          : [];
    items.push({
      kind: "challenge",
      challengeId: challenge.challengeId,
      slug: challenge.slug,
      status: challenge.status,
      casterTeamId: challenge.casterTeamId,
      targetTeamId: challenge.targetTeamId,
      actions,
      label: hostChallengeLabel(challenge),
    });
  }

  const effects = Object.values(view.effects).sort((a, b) =>
    a.effectId < b.effectId ? -1 : 1,
  );
  for (const effect of effects) {
    const phase = effectPhase(effect, serverNowMs);
    // Only pending or active effects can be ended early (21.11); an ended,
    // consumed, or cancelled effect has nothing to end.
    if (phase === "ended") {
      continue;
    }
    const rule =
      effect.kind === "next_claim_restriction" &&
      (effect.params.rule === "pioneer" || effect.params.rule === "scenic")
        ? (effect.params.rule as NextClaimRule)
        : null;
    items.push({
      kind: "effect",
      effectId: effect.effectId,
      slug: effect.slug,
      effectKind: effect.kind,
      phase,
      targetTeamId: effect.targetTeamId,
      rule,
      actions: ["end"],
      label: hostEffectLabel(effect, rule),
    });
  }

  return items;
}

/** A short host-panel label for a challenge: card, target, and status. */
function hostChallengeLabel(challenge: ChallengeRecord): string {
  return `${challenge.slug} on ${challenge.targetTeamId} (${challenge.status})`;
}

/**
 * A short host-panel label for an effect. A next-claim restriction is labeled
 * with its rule and restricted team so the host can see which team it holds up
 * (21.11); other effects are labeled by kind.
 */
function hostEffectLabel(
  effect: EffectRecord,
  rule: NextClaimRule | null,
): string {
  if (rule !== null) {
    const ruleName = rule === "pioneer" ? "Pioneer" : "Scenic Route";
    return `${ruleName} restriction on ${effect.targetTeamId ?? "?"}`;
  }
  return `${effect.slug} (${effect.kind})`;
}
