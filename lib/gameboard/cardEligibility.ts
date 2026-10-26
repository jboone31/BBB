/**
 * Pure card-targeting eligibility selectors (brawl-deck-architecture Task 8,
 * extended by card-behavior Task 3.12; design.md section 9).
 *
 * These derive, from the folded {@link GameBoardView} plus a {@link CardTargetContext}
 * of durable facts, which targets a card may (not) be played against. They are
 * framework-free and side-effect-free so they are unit-/property-testable in
 * isolation and are used identically by the play UI (to gray out ineligible
 * targets, R3.2/R3.3) and by `planCardPlay` (to enforce the same rule, R3.3). The
 * event log — folded into `cardPlays` — plus the context's durable rows are the
 * single source of truth; nothing here reads live state.
 *
 * The v1 rules this encodes:
 *   - With multiple teams in play, no team may be targeted by a challenge card of
 *     the SAME NAME more than once (`game-rules.md`), counting only `card_played`
 *     facts so Mirrored_Challenges never count against it (9.14).
 *   - The caster's own team is never a valid target of a team-targeting card.
 *   - Pioneer and Scenic Route may not target a team that would be left with no
 *     Legal_Next_Bar once the played rule is added (10.10-10.12, 22.5).
 *   - Bar-targeting cards enforce their per-card geographic/claim rules: finish
 *     bar (Crop Dusting, Happy Hour, Party Crasher), near-finish / no-coordinates
 *     (Cancel Culture), four claimants (Party Crasher), and start-bar /
 *     not-claimed-by-all (Voted Off the Island), plus the existing same-name bar
 *     rule (11.1, 12.1, 12.2, 13.1, 14.1, 18.1-18.3).
 *
 * Backward compatibility: the pre-Task-3.12 call sites passed a bare
 * `finishBarId: string | null` as the final argument. The selectors accept either
 * that (a minimal context is synthesised) or a full {@link CardTargetContext}, so
 * no existing caller breaks while the richer behaviour is added.
 */

import type { CardSlug } from "@/lib/cards/catalog";
import type { ResolvedBarRef } from "@/lib/cards/behaviorState";
import { hasLegalNextBar, type NextClaimRule } from "@/lib/claims/legalNextBar";
import type { BoardTeamView, GameBoardView } from "@/lib/gameboard/events";
import type { ClaimState } from "@/lib/map/claims";
import {
  CANCEL_CULTURE_RADIUS_MILES,
  haversineMiles,
  type LatLng,
} from "@/lib/map/geo";

// ---------------------------------------------------------------------------
// Shared targeting context.
// ---------------------------------------------------------------------------

/**
 * The durable facts the selectors need beyond the folded {@link GameBoardView}.
 *
 * `planCardPlay` builds this from in-transaction rows; the play panel builds it
 * from the same board state the map renders, so UI and server agree (design.md
 * section 9). Every field is optional so a legacy caller can omit the parts it
 * does not have and still get the same-name + finish-bar rules.
 */
export interface CardTargetContext {
  /** The finish bar key, excluded from bar targeting, or null when unknown. */
  readonly finishBarKey: string | null;
  /** The start bar key, excluded from Voted Off targeting, or null when unknown. */
  readonly startBarKey?: string | null;
  /** Bar key -> coordinates, for the distance-based bar rules. */
  readonly barCoords?: ReadonlyMap<string, LatLng>;
  /** Bar key -> active claimant team ids, for the claim-based bar rules. */
  readonly claimState?: ClaimState;
  /** Every team id in the game (used by the claimed-by-all rule). */
  readonly teamIds?: readonly string[];
  /** Team id -> its previous bar, for Scenic Route's Legal_Next_Bar check. */
  readonly previousBars?: ReadonlyMap<string, ResolvedBarRef>;
  /**
   * Team id -> its unconsumed, uncancelled `next_claim_restriction` rules, for
   * the Pioneer/Scenic Legal_Next_Bar check.
   */
  readonly restrictions?: ReadonlyMap<string, readonly NextClaimRule[]>;
}

/**
 * The final argument of the selectors: either a full {@link CardTargetContext} or
 * the legacy bare finish-bar key (or null). Normalised by {@link toContext}.
 */
export type TargetContextArg = CardTargetContext | string | null;

function toContext(arg: TargetContextArg): CardTargetContext {
  if (arg === null || typeof arg === "string") {
    return { finishBarKey: arg };
  }
  return arg;
}

/** The next-claim rule a slug imposes, or null for a non-restriction card. */
function ruleForSlug(slug: CardSlug): NextClaimRule | null {
  if (slug === "pioneer") {
    return "pioneer";
  }
  if (slug === "scenic-route") {
    return "scenic";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Team targeting (R3.2, R3.3; 10.10-10.12, 22.5).
// ---------------------------------------------------------------------------

/** Why a team is ineligible as a target for a given card. */
export type TeamIneligibilityReason =
  "caster" | "already_targeted_same_card" | "no_legal_next_bar";

/** A team's targeting eligibility for a specific card. */
export interface TeamTargetEligibility {
  readonly teamId: string;
  readonly eligible: boolean;
  /** The reason it is ineligible, or null when eligible. */
  readonly reason: TeamIneligibilityReason | null;
  /** For `no_legal_next_bar`, the restriction rules involved (played ∪ existing). */
  readonly rules?: readonly NextClaimRule[];
}

/**
 * The set of team ids already targeted by a prior play of `slug` (R3.3), counting
 * only `card_played` facts so Mirrored_Challenges never count against the rule
 * (9.14). A team in this set may not be targeted by another card of the same name.
 */
export function selectTeamsTargetedByCard(
  view: GameBoardView,
  slug: CardSlug,
): ReadonlySet<string> {
  const targeted = new Set<string>();
  for (const play of view.cardPlays) {
    if (play.slug === slug && play.targetTeamId !== null) {
      targeted.add(play.targetTeamId);
    }
  }
  return targeted;
}

/**
 * Whether adding `slug`'s restriction to `teamId`'s existing restrictions would
 * leave it with no Legal_Next_Bar (10.10-10.12, 22.5). Returns the rules involved
 * alongside the verdict so the caller can surface them. For a non-restriction
 * card, or when the context lacks the data to evaluate legality, the team is not
 * blocked on this ground.
 */
function noLegalNextBar(
  slug: CardSlug,
  teamId: string,
  ctx: CardTargetContext,
): { blocked: boolean; rules: readonly NextClaimRule[] } {
  const rule = ruleForSlug(slug);
  if (rule === null) {
    return { blocked: false, rules: [] };
  }

  const previousBar = ctx.previousBars?.get(teamId);
  // Without the durable facts to run the Legal_Next_Bar check (the play panel may
  // not carry them), fall back to "not blocked" rather than guessing.
  if (
    previousBar === undefined ||
    ctx.barCoords === undefined ||
    ctx.claimState === undefined
  ) {
    return { blocked: false, rules: [] };
  }

  const existing = ctx.restrictions?.get(teamId) ?? [];
  const rules = [...existing, rule];

  const bars: ResolvedBarRef[] = [];
  const kindOf = (key: string): ResolvedBarRef["kind"] =>
    key === ctx.finishBarKey
      ? "finish"
      : key === (ctx.startBarKey ?? null)
        ? "start"
        : "scoring";
  for (const [barKey, coords] of ctx.barCoords) {
    bars.push({ barKey, kind: kindOf(barKey), coords });
  }

  const finishCoords =
    ctx.finishBarKey === null
      ? null
      : (ctx.barCoords.get(ctx.finishBarKey) ?? null);

  const activeClaims: { teamId: string; barKey: string }[] = [];
  for (const [barKey, claimers] of Object.entries(ctx.claimState)) {
    for (const claimer of claimers) {
      activeClaims.push({ teamId: claimer, barKey });
    }
  }

  const legal = hasLegalNextBar({
    teamId,
    rules,
    bars,
    finishCoords,
    activeClaims,
    previousBar,
  });

  return { blocked: !legal, rules };
}

/**
 * Whether `targetTeamId` may be targeted by `slug`, cast by `castingTeamId`
 * (R3.2/R3.3). Ineligible if it is the caster's own team, has already been
 * targeted by a card of the same name, or (for Pioneer/Scenic Route) would be
 * left with no Legal_Next_Bar. `ctx` may be omitted for the plain same-name
 * check.
 */
export function isTeamTargetEligible(
  view: GameBoardView,
  slug: CardSlug,
  castingTeamId: string,
  targetTeamId: string,
  ctx?: CardTargetContext,
): boolean {
  if (targetTeamId === castingTeamId) {
    return false;
  }
  if (selectTeamsTargetedByCard(view, slug).has(targetTeamId)) {
    return false;
  }
  if (ctx !== undefined && noLegalNextBar(slug, targetTeamId, ctx).blocked) {
    return false;
  }
  return true;
}

/**
 * Compute every team's targeting eligibility for `slug` cast by `castingTeamId`
 * (R3.2/R3.3; 10.10-10.12). The caller (play UI or route) uses this to disable/
 * gray out the ineligible teams; the caster's own team is marked ineligible with
 * reason `caster` and is typically omitted from the target list entirely.
 *
 * The final argument is a {@link CardTargetContext} (new) or a bare finish-bar
 * key / null (legacy). The optional `teams` list defaults to `view.teams`.
 */
export function selectTeamTargetEligibility(
  view: GameBoardView,
  slug: CardSlug,
  castingTeamId: string,
  ctxArg: TargetContextArg = null,
  teams: readonly BoardTeamView[] = view.teams,
): TeamTargetEligibility[] {
  const ctx = toContext(ctxArg);
  const alreadyTargeted = selectTeamsTargetedByCard(view, slug);
  return teams.map((team) => {
    if (team.id === castingTeamId) {
      return { teamId: team.id, eligible: false, reason: "caster" };
    }
    if (alreadyTargeted.has(team.id)) {
      return {
        teamId: team.id,
        eligible: false,
        reason: "already_targeted_same_card",
      };
    }
    const legal = noLegalNextBar(slug, team.id, ctx);
    if (legal.blocked) {
      return {
        teamId: team.id,
        eligible: false,
        reason: "no_legal_next_bar",
        rules: legal.rules,
      };
    }
    return { teamId: team.id, eligible: true, reason: null };
  });
}

// ---------------------------------------------------------------------------
// Bar targeting (R3.4, R3.5; 11.1, 12.1, 12.2, 13.1, 14.1, 18.1-18.3).
// ---------------------------------------------------------------------------

/** Why a bar is ineligible as a target for a given card. */
export type BarIneligibilityReason =
  | "finish_bar"
  | "start_bar"
  | "already_targeted_same_card"
  | "near_finish"
  | "no_coordinates"
  | "four_claimants"
  | "not_claimed_by_all";

/** A bar's targeting eligibility for a specific card. */
export interface BarTargetEligibility {
  readonly barId: string;
  readonly eligible: boolean;
  readonly reason: BarIneligibilityReason | null;
}

/**
 * The set of bar ids already targeted by a prior play of `slug` (R3.5). A bar in
 * this set may not be targeted by another card of the same name.
 */
export function selectBarsTargetedByCard(
  view: GameBoardView,
  slug: CardSlug,
): ReadonlySet<string> {
  const targeted = new Set<string>();
  for (const play of view.cardPlays) {
    if (play.slug === slug && play.targetBarId !== null) {
      targeted.add(play.targetBarId);
    }
  }
  return targeted;
}

/**
 * The per-card bar rule for `slug`, evaluated against `barId` and the context.
 * Returns the ineligibility reason or null when the card's own bar rules permit
 * the bar. The finish-bar and same-name rules are applied by the caller around
 * this; this handles the card-specific geographic/claim constraints.
 */
function barCardReason(
  slug: CardSlug,
  barId: string,
  ctx: CardTargetContext,
): BarIneligibilityReason | null {
  const claimers = ctx.claimState?.[barId] ?? [];

  switch (slug) {
    case "cancel-culture": {
      // Cancel Culture: the bar must have known coordinates and lie strictly more
      // than 0.25 miles from the finish bar (18.1-18.3).
      const coords = ctx.barCoords?.get(barId);
      const finishCoords =
        ctx.finishBarKey === null
          ? undefined
          : ctx.barCoords?.get(ctx.finishBarKey);
      if (coords === undefined || finishCoords === undefined) {
        return "no_coordinates";
      }
      if (haversineMiles(coords, finishCoords) <= CANCEL_CULTURE_RADIUS_MILES) {
        return "near_finish";
      }
      return null;
    }
    case "party-crasher": {
      // Party Crasher targets a non-finish bar with fewer than four claiming
      // teams (14.1). Without claim facts (a legacy caller), this constraint is
      // not evaluated and the finish/same-name rules still apply.
      if (ctx.claimState === undefined) {
        return null;
      }
      if (claimers.length >= 4) {
        return "four_claimants";
      }
      return null;
    }
    case "voted-off-the-island": {
      // Voted Off the Island targets a non-start bar every team in the game holds
      // an active claim on (22.1 / design section 9). Without the claim/team
      // facts (a legacy caller), the claim-based constraints are not evaluated.
      if (
        (ctx.startBarKey ?? null) !== null &&
        barId === (ctx.startBarKey ?? null)
      ) {
        return "start_bar";
      }
      if (ctx.claimState === undefined || ctx.teamIds === undefined) {
        return null;
      }
      const teamIds = ctx.teamIds;
      const claimerSet = new Set(claimers);
      const claimedByAll =
        teamIds.length > 0 && teamIds.every((teamId) => claimerSet.has(teamId));
      if (!claimedByAll) {
        return "not_claimed_by_all";
      }
      return null;
    }
    default:
      // Crop Dusting, Happy Hour, and any other bar card rely on the finish-bar
      // and same-name rules applied by the caller; no extra constraint here.
      return null;
  }
}

/**
 * Whether `barId` may be targeted by `slug` (R3.4/R3.5), honouring the finish-bar
 * rule, the same-name rule, and the card's own per-bar constraints. The final
 * argument is a {@link CardTargetContext} (new) or a bare finish-bar key / null
 * (legacy).
 */
export function isBarTargetEligible(
  view: GameBoardView,
  slug: CardSlug,
  barId: string,
  ctxArg: TargetContextArg,
): boolean {
  const ctx = toContext(ctxArg);
  if (ctx.finishBarKey !== null && barId === ctx.finishBarKey) {
    return false;
  }
  if (selectBarsTargetedByCard(view, slug).has(barId)) {
    return false;
  }
  return barCardReason(slug, barId, ctx) === null;
}

/**
 * Compute every bar's targeting eligibility for `slug` (R3.4/R3.5), for the given
 * bar ids. The caller (map UI or route) uses this to gray out / disable
 * ineligible bars.
 *
 * Reasons in precedence order: finish bar, the card's own constraint (near
 * finish, no coordinates, four claimants, start bar, not claimed by all), then
 * the same-name rule. The final argument is a {@link CardTargetContext} (new) or
 * a bare finish-bar key / null (legacy).
 */
export function selectBarTargetEligibility(
  view: GameBoardView,
  slug: CardSlug,
  barIds: readonly string[],
  ctxArg: TargetContextArg,
): BarTargetEligibility[] {
  const ctx = toContext(ctxArg);
  const alreadyTargeted = selectBarsTargetedByCard(view, slug);
  return barIds.map((barId) => {
    let reason: BarIneligibilityReason | null = null;
    if (ctx.finishBarKey !== null && barId === ctx.finishBarKey) {
      reason = "finish_bar";
    } else {
      reason = barCardReason(slug, barId, ctx);
      if (reason === null && alreadyTargeted.has(barId)) {
        reason = "already_targeted_same_card";
      }
    }
    return { barId, eligible: reason === null, reason };
  });
}
