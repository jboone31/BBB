/**
 * Legal next bars (`lib/claims/legalNextBar.ts`).
 *
 * Pure, framework-free module. It is the single definition of Legal_Next_Bar —
 * "this team still has somewhere to go under its next-claim restrictions" — so
 * `planCardPlay`, the eligibility selectors, `decideFairest`, the Pioneer/Scenic
 * picker, the Fairest prompt, and `evaluateClaimBlocks`' restriction checks all
 * agree. A bar is a Legal_Next_Bar for a team and a set of Next_Claim_Restrictions
 * when it is not the finish bar, is not actively claimed by that team, and
 * satisfies every restriction in the set (design.md section 9a; Requirements
 * 9.15-9.17, 10.5, 10.10-10.12, 21.11, 22.5).
 *
 * Pioneer is satisfied by a bar when no other team holds an active claim on it.
 * Scenic Route is satisfied when the bar, the finish bar, and the team's previous
 * bar all have known coordinates and the bar's Geodesic_Distance to the finish is
 * strictly greater than the previous bar's. The restriction set is treated as a
 * set: duplicate rules add nothing, and stacking Pioneer with Scenic Route
 * requires one bar satisfying both.
 *
 * Temporary locks (Crop Dusting, Cancel Culture, critic blocks) and the
 * Challenge_Gate are ignored here; they are claim-time blocks, not next-claim
 * legality. The guard is evaluated at play time and at Fairest Play time only; a
 * team can still become stuck later (the Host ends the restriction effect to
 * unstick it, Requirement 21.11).
 *
 * `previousBarFor` lives here (so `blocks.ts` can re-export it without a circular
 * import) and defines a team's previous bar as the bar of its most recent claim
 * not reversed by an ordinary unclaim, and the start bar when no such claim
 * exists (Requirement 10.5).
 */

import type {
  ResolvedBarRef,
  BehaviorState,
  FairestOfferRecord,
} from "@/lib/cards/behaviorState";
import { isEffectActive } from "@/lib/cards/effects";
import { haversineMiles, type LatLng } from "@/lib/map/geo";

// ---------------------------------------------------------------------------
// Rule vocabulary.
// ---------------------------------------------------------------------------

/**
 * A next-claim restriction rule. Mirrors an Effect's `params.rule`: Pioneer
 * ("claim an unclaimed, non-finish bar") and Scenic Route ("claim farther from
 * the finish than your previous bar").
 */
export type NextClaimRule = "pioneer" | "scenic";

/** The input a Legal_Next_Bar evaluation reads. All fields are server facts. */
export interface LegalNextBarInput {
  /** The team the restrictions apply to. */
  readonly teamId: string;
  /** Existing restrictions plus any candidate; treated as a set. */
  readonly rules: readonly NextClaimRule[];
  /** Every game bar (key, kind, coords). */
  readonly bars: readonly ResolvedBarRef[];
  /** The finish bar's coordinates, or null when unknown. */
  readonly finishCoords: LatLng | null;
  /** The active claims across all teams (team + bar key). */
  readonly activeClaims: readonly {
    readonly teamId: string;
    readonly barKey: string;
  }[];
  /** The team's previous bar, from {@link previousBarFor}. */
  readonly previousBar: ResolvedBarRef;
}

// ---------------------------------------------------------------------------
// Per-rule check.
// ---------------------------------------------------------------------------

/**
 * Whether `bar` satisfies a single next-claim `rule` for the team in `input`.
 * Also called by `evaluateClaimBlocks` so restriction blocks and Legal_Next_Bar
 * never disagree.
 *
 * - **pioneer:** no team other than `input.teamId` holds an active claim on the
 *   bar (the finish-bar part of Pioneer is handled by the `kind !== "finish"`
 *   gate in {@link selectLegalNextBars} and the dedicated finish-bar block in
 *   `evaluateClaimBlocks`).
 * - **scenic:** the bar, the finish, and the previous bar all have known
 *   coordinates, and `haversine(bar, finish) > haversine(previousBar, finish)`.
 *   A bar with no coordinates (or an unknown finish/previous bar) never
 *   satisfies Scenic Route.
 */
export function barSatisfiesRule(
  rule: NextClaimRule,
  bar: ResolvedBarRef,
  input: LegalNextBarInput,
): boolean {
  if (rule === "pioneer") {
    return !input.activeClaims.some(
      (claim) => claim.barKey === bar.barKey && claim.teamId !== input.teamId,
    );
  }

  // scenic
  const barCoords = bar.coords;
  const finishCoords = input.finishCoords;
  const previousCoords = input.previousBar.coords;
  if (barCoords === null || finishCoords === null || previousCoords === null) {
    return false;
  }
  return (
    haversineMiles(barCoords, finishCoords) >
    haversineMiles(previousCoords, finishCoords)
  );
}

// ---------------------------------------------------------------------------
// Legal next bars.
// ---------------------------------------------------------------------------

/**
 * The sorted keys of every bar that is a Legal_Next_Bar for `input`: a bar is
 * legal when it is not the finish bar, is not actively claimed by `input.teamId`,
 * and satisfies every rule in `input.rules` (duplicates ignored). Temporary locks
 * and the Challenge_Gate are deliberately not consulted; the start bar is an
 * ordinary candidate, excluded only once the team has claimed it (or by Scenic
 * Route when it is the previous bar).
 */
export function selectLegalNextBars(input: LegalNextBarInput): string[] {
  // Dedupe the rules so stacking the same rule is no stricter than one.
  const rules = [...new Set(input.rules)];

  const teamHoldsBar = new Set(
    input.activeClaims
      .filter((claim) => claim.teamId === input.teamId)
      .map((claim) => claim.barKey),
  );

  const legal: string[] = [];
  for (const bar of input.bars) {
    if (bar.kind === "finish") {
      continue;
    }
    if (teamHoldsBar.has(bar.barKey)) {
      continue;
    }
    if (rules.every((rule) => barSatisfiesRule(rule, bar, input))) {
      legal.push(bar.barKey);
    }
  }

  legal.sort();
  return legal;
}

/** Whether `input` has at least one Legal_Next_Bar. */
export function hasLegalNextBar(input: LegalNextBarInput): boolean {
  return selectLegalNextBars(input).length > 0;
}

// ---------------------------------------------------------------------------
// Previous bar.
// ---------------------------------------------------------------------------

/**
 * A team's previous bar: the bar of its most recent claim not reversed by an
 * ordinary unclaim, and the start bar when no such claim exists (Requirement
 * 10.5). A `voted_off` revocation does not disqualify the claim from being the
 * previous bar — only `ordinary_unclaim` does. "Most recent" is by `claimedAt`,
 * with `claimId` (when present) breaking ties deterministically.
 */
export function previousBarFor(
  teamId: string,
  claimHistory: readonly {
    readonly teamId: string;
    readonly barKey: string;
    readonly claimedAt: string;
    readonly revokedReason: string | null;
    readonly claimId?: string;
  }[],
  startBar: ResolvedBarRef,
): ResolvedBarRef {
  const candidates = claimHistory.filter(
    (claim) =>
      claim.teamId === teamId && claim.revokedReason !== "ordinary_unclaim",
  );

  if (candidates.length === 0) {
    return startBar;
  }

  let latest = candidates[0];
  for (const claim of candidates.slice(1)) {
    if (claim.claimedAt > latest.claimedAt) {
      latest = claim;
    } else if (claim.claimedAt === latest.claimedAt) {
      // Deterministic tie-break on claimId when both are present.
      const a = claim.claimId ?? "";
      const b = latest.claimId ?? "";
      if (a > b) {
        latest = claim;
      }
    }
  }

  return {
    barKey: latest.barKey,
    // The previous bar's kind is not consulted by any rule; mark it `scoring`.
    kind: "scoring",
    coords: coordsForBarKey(latest.barKey, startBar),
  };
}

/**
 * Resolve the previous bar's coordinates. The start bar is the only
 * {@link ResolvedBarRef} `previousBarFor` is handed directly; for any other key
 * the caller passes a `claimHistory` row that carries no coordinates, so the
 * previous bar's distance can only be computed when the caller supplies a bar map.
 *
 * `previousBarFor` is intentionally minimal: it returns the start bar's
 * coordinates when the previous bar *is* the start bar, and null otherwise. The
 * routes and selectors that need Scenic distance build the `previousBar`
 * {@link ResolvedBarRef} from the resolved bar set before calling the Legal_Next_Bar
 * helpers, so a null here simply means "look up coordinates in the bar set".
 */
function coordsForBarKey(
  barKey: string,
  startBar: ResolvedBarRef,
): LatLng | null {
  return barKey === startBar.barKey ? startBar.coords : null;
}

// ---------------------------------------------------------------------------
// Fairest mirror legality.
// ---------------------------------------------------------------------------

/** Map a card slug to its next-claim rule, or null for non-restriction cards. */
function ruleForSlug(slug: string): NextClaimRule | null {
  if (slug === "pioneer") {
    return "pioneer";
  }
  if (slug === "scenic-route") {
    return "scenic";
  }
  return null;
}

/**
 * The active next-claim rules a team holds in `state`: the `params.rule` of every
 * active `next_claim_restriction` effect targeting the team. "Active" excludes
 * consumed and cancelled effects (host-ended and game-ended cancellations
 * included), because {@link isEffectActive} rejects any effect with a
 * `cancelledAt`/`consumedAt` at or before the given time.
 */
function activeRulesForTeam(
  state: BehaviorState,
  teamId: string,
  nowMs: number,
): NextClaimRule[] {
  const rules: NextClaimRule[] = [];
  for (const effect of state.effects) {
    if (effect.kind !== "next_claim_restriction") {
      continue;
    }
    if (effect.targetTeamId !== teamId) {
      continue;
    }
    if (!isEffectActive(effect, nowMs)) {
      continue;
    }
    const rule = effect.params.rule;
    if (rule === "pioneer" || rule === "scenic") {
      rules.push(rule);
    }
  }
  return rules;
}

/** Build the Legal_Next_Bar input for a team from a loaded {@link BehaviorState}. */
function legalInputForTeam(
  state: BehaviorState,
  teamId: string,
  rules: readonly NextClaimRule[],
): LegalNextBarInput {
  const bars: ResolvedBarRef[] = [];
  for (const bar of state.bars.values()) {
    bars.push({ barKey: bar.barKey, kind: bar.kind, coords: bar.coords });
  }

  const finishBar =
    state.finishBarKey === null
      ? undefined
      : state.bars.get(state.finishBarKey);
  const finishCoords = finishBar?.coords ?? null;

  const startBar: ResolvedBarRef =
    state.startBarKey !== null && state.bars.has(state.startBarKey)
      ? (() => {
          const b = state.bars.get(state.startBarKey)!;
          return { barKey: b.barKey, kind: b.kind, coords: b.coords };
        })()
      : { barKey: "", kind: "start", coords: null };

  const previousBarRef = previousBarFor(teamId, state.claimHistory, startBar);
  // When the previous bar is not the start bar, resolve its coordinates from the
  // full bar set so Scenic distance can be computed.
  const previousBar: ResolvedBarRef =
    previousBarRef.coords === null && previousBarRef.barKey !== ""
      ? {
          ...previousBarRef,
          coords: state.bars.get(previousBarRef.barKey)?.coords ?? null,
        }
      : previousBarRef;

  const activeClaims = state.activeClaims.map((claim) => ({
    teamId: claim.teamId,
    barKey: claim.barKey,
  }));

  return { teamId, rules, bars, finishCoords, activeClaims, previousBar };
}

/**
 * Whether mirroring `offer` back onto its original caster is legal in `state` at
 * `now` (design.md section 9a; Requirements 9.15-9.17). Non-restriction cards are
 * always mirrorable, so this returns `true` for every slug other than Pioneer and
 * Scenic Route. For those two it returns whether the original caster would still
 * have a Legal_Next_Bar once the mirrored restriction is added to the caster's
 * own active restrictions.
 */
export function mirrorIsLegal(
  state: BehaviorState,
  offer: Pick<FairestOfferRecord, "slug" | "originalCasterTeamId">,
  now: string,
): boolean {
  const rule = ruleForSlug(offer.slug);
  if (rule === null) {
    return true;
  }

  const nowMs = Date.parse(now);
  const casterRules = activeRulesForTeam(
    state,
    offer.originalCasterTeamId,
    nowMs,
  );
  const combined = [...casterRules, rule];

  return hasLegalNextBar(
    legalInputForTeam(state, offer.originalCasterTeamId, combined),
  );
}
