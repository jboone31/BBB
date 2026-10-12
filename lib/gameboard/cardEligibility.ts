/**
 * Pure card-targeting eligibility selectors (brawl-deck-architecture Task 8).
 *
 * These derive, from the folded {@link GameBoardView}, which targets a card may
 * (not) be played against. They are framework-free and side-effect-free so they
 * are unit-/property-testable in isolation and can be used identically by the
 * play UI (to gray out ineligible targets, R3.2/R3.3) and by the server play
 * route (to enforce the same rule, R3.3). The event log — folded into
 * `cardPlays` — is the single source of truth; nothing here reads live state.
 *
 * The v1 rule this encodes: with multiple teams in play, no team may be targeted
 * by a challenge card of the SAME NAME more than once (see `game-rules.md`). The
 * caster's own team is never a valid target of a team-targeting card.
 */

import type { CardSlug } from "@/lib/cards/catalog";
import type { BoardTeamView, GameBoardView } from "@/lib/gameboard/events";

/** Why a team is ineligible as a target for a given card. */
export type TeamIneligibilityReason = "own_team" | "already_targeted_same_card";

/** A team's targeting eligibility for a specific card. */
export interface TeamTargetEligibility {
  readonly teamId: string;
  readonly eligible: boolean;
  /** The reason it is ineligible, or null when eligible. */
  readonly reason: TeamIneligibilityReason | null;
}

/**
 * The set of team ids already targeted by a prior play of `slug` (R3.3). A team
 * in this set may not be targeted by another card of the same name.
 *
 * @param view the folded board view.
 * @param slug the card whose prior targets to collect.
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
 * Whether `targetTeamId` may be targeted by `slug`, cast by `castingTeamId`
 * (R3.2/R3.3). Ineligible if it is the caster's own team or has already been
 * targeted by a card of the same name.
 */
export function isTeamTargetEligible(
  view: GameBoardView,
  slug: CardSlug,
  castingTeamId: string,
  targetTeamId: string,
): boolean {
  if (targetTeamId === castingTeamId) {
    return false;
  }
  return !selectTeamsTargetedByCard(view, slug).has(targetTeamId);
}

/**
 * Compute every team's targeting eligibility for `slug` cast by `castingTeamId`
 * (R3.2/R3.3). The caller (play UI or route) uses this to disable/gray out the
 * ineligible teams; the own team is marked ineligible with reason `own_team` and
 * is typically omitted from the target list entirely.
 *
 * @param view the folded board view.
 * @param slug the card being played.
 * @param castingTeamId the team casting the card.
 * @param teams the teams to evaluate (defaults to `view.teams`).
 */
export function selectTeamTargetEligibility(
  view: GameBoardView,
  slug: CardSlug,
  castingTeamId: string,
  teams: readonly BoardTeamView[] = view.teams,
): TeamTargetEligibility[] {
  const alreadyTargeted = selectTeamsTargetedByCard(view, slug);
  return teams.map((team) => {
    let reason: TeamIneligibilityReason | null = null;
    if (team.id === castingTeamId) {
      reason = "own_team";
    } else if (alreadyTargeted.has(team.id)) {
      reason = "already_targeted_same_card";
    }
    return { teamId: team.id, eligible: reason === null, reason };
  });
}

// ---------------------------------------------------------------------------
// Bar targeting (R3.4, R3.5)
// ---------------------------------------------------------------------------

/** Why a bar is ineligible as a target for a given card. */
export type BarIneligibilityReason =
  "finish_bar" | "already_targeted_same_card";

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
 * Whether `barId` may be targeted by `slug` (R3.4/R3.5). Ineligible if it is the
 * finish bar or has already been targeted by a card of the same name.
 *
 * `finishBarId` is supplied by the caller because the (candidate-slug) finish
 * bar identity is not carried by the folded view; pass `null` when unknown.
 * Per-card geographic rules (e.g. Cancel Culture's 0.25-mile radius) are a later
 * per-card effort and are not enforced here.
 */
export function isBarTargetEligible(
  view: GameBoardView,
  slug: CardSlug,
  barId: string,
  finishBarId: string | null,
): boolean {
  if (finishBarId !== null && barId === finishBarId) {
    return false;
  }
  return !selectBarsTargetedByCard(view, slug).has(barId);
}

/**
 * Compute every bar's targeting eligibility for `slug` (R3.4/R3.5), for the
 * given bar ids. The caller (map UI or route) uses this to gray out / disable
 * ineligible bars.
 *
 * @param view the folded board view.
 * @param slug the card being played.
 * @param barIds the candidate bar ids to evaluate.
 * @param finishBarId the finish bar id to exclude, or null when unknown.
 */
export function selectBarTargetEligibility(
  view: GameBoardView,
  slug: CardSlug,
  barIds: readonly string[],
  finishBarId: string | null,
): BarTargetEligibility[] {
  const alreadyTargeted = selectBarsTargetedByCard(view, slug);
  return barIds.map((barId) => {
    let reason: BarIneligibilityReason | null = null;
    if (finishBarId !== null && barId === finishBarId) {
      reason = "finish_bar";
    } else if (alreadyTargeted.has(barId)) {
      reason = "already_targeted_same_card";
    }
    return { barId, eligible: reason === null, reason };
  });
}
