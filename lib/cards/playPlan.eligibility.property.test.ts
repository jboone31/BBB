import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { planCardPlay, type PlayRequest } from "./playPlan";
import type { BehaviorState, ClaimRow, EffectRecord } from "./behaviorState";
import type { CardInstance } from "./deck";
import { getCardMetadata, type CardSlug } from "./catalog";
import {
  selectBarTargetEligibility,
  selectTeamTargetEligibility,
  type CardTargetContext,
} from "@/lib/gameboard/cardEligibility";
import {
  initialGameBoardView,
  type BoardCardPlayView,
  type BoardTeamView,
  type GameBoardView,
} from "@/lib/gameboard/events";
import type { ClaimState } from "@/lib/map/claims";
import { type LatLng } from "@/lib/map/geo";
import type { NextClaimRule } from "@/lib/claims/legalNextBar";
import type { ResolvedBar } from "@/lib/map/barResolver";

/**
 * Feature: card-behavior, Property 15: Target eligibility parity between UI and
 * server.
 *
 * The play UI grays out ineligible targets through the shared 3.12 selectors
 * (`selectTeamTargetEligibility` / `selectBarTargetEligibility`), and
 * `planCardPlay` (`lib/cards/playPlan.ts`) gates the same play through those same
 * selectors (design.md section 9; Property 15). This property pins that the two
 * sides never disagree: for any board state, card, caster, and target,
 * `planCardPlay` rejects the targeting with `invalid_input` **iff** the matching
 * selector marks that target ineligible.
 *
 * The parity is asserted on both the verdict and the structured reason:
 *
 * - Team cards (including Pioneer / Scenic Route). The selector either accepts
 *   the target or reports one of `caster`, `already_targeted_same_card`, or
 *   `no_legal_next_bar`. `planCardPlay` must accept exactly when the selector
 *   does, and when the selector reports `no_legal_next_bar` (single rule or
 *   stacked with an existing restriction), the planner's rejection must carry
 *   `details.reason === "no_legal_next_bar"` with the **same** rule set.
 * - Bar cards. The selector enforces each card's own geographic/claim rule —
 *   finish bar (Crop Dusting, Happy Hour, Party Crasher), near-finish /
 *   no-coordinates (Cancel Culture), four claimants (Party Crasher), and start
 *   bar / not-claimed-by-all (Voted Off the Island) — plus the same-name rule.
 *   `planCardPlay` must accept exactly when the selector says the bar is
 *   eligible.
 *
 * The reference side of each assertion is the shared selector applied to the same
 * view/context the planner builds, so the planner is checked against the UI's own
 * rule rather than against itself. Every generated state is live and seeds the
 * caster's hand with the card under test so the play reaches the targeting gate.
 *
 * Validates: Requirements 10.12, 11.1, 12.1, 12.2, 13.1, 14.1, 18.1, 18.2, 18.3,
 * 22.1, 22.2, 22.5
 */

// ---------------------------------------------------------------------------
// Fixtures and builders.
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2025-06-01T18:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();
const iso = (ms: number): string => new Date(ms).toISOString();

const CASTER = "team-caster";
const TEAMS = ["team-caster", "team-b", "team-c", "team-d"] as const;

const FINISH_BAR = "bar-finish";
const START_BAR = "bar-start";

// A straight line of scoring bars increasingly far from the finish (lng walks
// away from the finish at the same latitude), plus the designated start/finish.
// Distances are chosen so Cancel Culture's 0.25-mile exclusion is crossed between
// the near and far bars.
const FINISH_COORDS: LatLng = { lat: 33.7, lng: -84.4 };
// The start bar sits essentially on top of the finish, so it is never the
// farthest bar from the finish — that keeps the Scenic "no farther bar" case
// reachable when a team's previous bar is the farthest scoring bar.
const START_COORDS: LatLng = { lat: 33.7, lng: -84.4001 };
// Scoring bars walk east (away from finish), increasing distance. `bar-near` is
// inside Cancel Culture's 0.25-mile exclusion; the others are outside it. The
// farthest bar (`bar-far`) has no bar farther from the finish.
const SCORING_BARS: { key: string; coords: LatLng }[] = [
  { key: "bar-near", coords: { lat: 33.7, lng: -84.398 } },
  { key: "bar-mid", coords: { lat: 33.7, lng: -84.39 } },
  { key: "bar-far", coords: { lat: 33.7, lng: -84.38 } },
];

const ALL_BAR_KEYS = [
  FINISH_BAR,
  START_BAR,
  ...SCORING_BARS.map((b) => b.key),
] as const;

function resolvedBar(
  key: string,
  kind: ResolvedBar["kind"],
  coords: LatLng | null,
): ResolvedBar {
  return { barKey: key, barId: `id-${key}`, name: key, kind, coords };
}

/** Every bar in the game, keyed by barKey, matching the planner's `state.bars`. */
function buildBars(): ReadonlyMap<string, ResolvedBar> {
  const bars = new Map<string, ResolvedBar>();
  bars.set(FINISH_BAR, resolvedBar(FINISH_BAR, "finish", FINISH_COORDS));
  bars.set(START_BAR, resolvedBar(START_BAR, "start", START_COORDS));
  for (const b of SCORING_BARS) {
    bars.set(b.key, resolvedBar(b.key, "scoring", b.coords));
  }
  return bars;
}

function handCard(teamId: string, slug: CardSlug): CardInstance {
  return { id: `${teamId}:${slug}`, slug, state: "hand", position: 0 };
}

/**
 * A base effect row for a Pioneer/Scenic Next_Claim_Restriction already held by a
 * team (so the stacked-rule case can be exercised). Callers override target/rule.
 */
function restrictionEffect(
  effectId: string,
  targetTeamId: string,
  rule: NextClaimRule,
): EffectRecord {
  return {
    effectId,
    slug: rule === "pioneer" ? "pioneer" : "scenic-route",
    kind: "next_claim_restriction",
    sourcePlayId: null,
    sourceChallengeId: null,
    ownerTeamId: "team-b",
    targetTeamId,
    targetBarKey: null,
    startsAt: iso(NOW_MS - 60_000),
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

interface StateOptions {
  readonly teamCount: number;
  readonly slug: CardSlug;
  readonly plays?: readonly {
    readonly slug: CardSlug;
    readonly targetTeamId: string | null;
    readonly targetBarKey: string | null;
  }[];
  readonly activeClaims?: readonly { teamId: string; barKey: string }[];
  readonly effects?: readonly EffectRecord[];
  /** Each team id -> its previous bar key, modeled as a single prior claim. */
  readonly previousBars?: ReadonlyMap<string, string>;
}

/**
 * A minimal live {@link BehaviorState} carrying the teams, bars, prior plays,
 * active claims, restriction effects, and claim history a parity case needs. The
 * caster always holds the card under test so the play reaches the targeting gate.
 */
function makeState(opts: StateOptions): BehaviorState {
  const teams = TEAMS.slice(0, opts.teamCount).map((teamId) => ({
    teamId,
    name: teamId,
    memberSessionIds: [] as string[],
  }));

  const activeClaims: ClaimRow[] = (opts.activeClaims ?? []).map((c, i) => ({
    claimId: `claim-${i}`,
    teamId: c.teamId,
    barId: `id-${c.barKey}`,
    barKey: c.barKey,
    claimedAt: iso(NOW_MS - 120_000),
    revokedReason: null,
  }));

  // Claim history encodes each team's previous bar as one prior (now-unclaimed
  // for distinctness is unnecessary) claim; left active is fine since previousBar
  // only reads barKey.
  const history: ClaimRow[] = [...activeClaims];
  if (opts.previousBars) {
    let i = activeClaims.length;
    for (const [teamId, barKey] of opts.previousBars) {
      history.push({
        claimId: `hist-${i}`,
        teamId,
        barId: `id-${barKey}`,
        barKey,
        claimedAt: iso(NOW_MS - 300_000),
        revokedReason: null,
      });
      i += 1;
    }
  }

  const hands = new Map<
    string,
    { hand: readonly CardInstance[]; pending: readonly CardInstance[] }
  >();
  hands.set(CASTER, { hand: [handCard(CASTER, opts.slug)], pending: [] });

  return {
    gameId: "game-1",
    lifecycle: "live",
    nowIso: NOW_ISO,
    teams,
    hostSessionId: "host",
    bars: buildBars(),
    startBarKey: START_BAR,
    finishBarKey: FINISH_BAR,
    activeClaims,
    claimHistory: history,
    hands,
    plays: (opts.plays ?? []).map((p, i) => ({
      playId: `play-${i}`,
      slug: p.slug,
      casterTeamId: CASTER,
      targetTeamId: p.targetTeamId,
      targetBarId: p.targetBarKey === null ? null : `id-${p.targetBarKey}`,
      targetBarKey: p.targetBarKey,
      params: { kind: "none" as const },
      createdAt: iso(NOW_MS - 60_000),
    })),
    challenges: [],
    offers: [],
    effects: opts.effects ?? [],
    awards: [],
    ledger: [],
  };
}

// ---------------------------------------------------------------------------
// Reference view/context builders — mirror the private builders in playPlan.ts so
// the selector (the UI's rule) is evaluated on the same inputs as the planner.
// ---------------------------------------------------------------------------

function buildView(state: BehaviorState): GameBoardView {
  const teams: BoardTeamView[] = state.teams.map((team) => ({
    id: team.teamId,
    name: team.name,
    color: "#000000",
  }));
  const cardPlays: BoardCardPlayView[] = state.plays.map((play, index) => ({
    seq: index + 1,
    slug: play.slug,
    castingTeamId: play.casterTeamId,
    targetTeamId: play.targetTeamId,
    targetBarId: play.targetBarKey,
  }));
  return { ...initialGameBoardView(state.gameId), teams, cardPlays };
}

function buildClaimState(state: BehaviorState): ClaimState {
  const claimState: Record<string, string[]> = {};
  for (const claim of state.activeClaims) {
    (claimState[claim.barKey] ??= []).push(claim.teamId);
  }
  return claimState;
}

function buildBarCoords(state: BehaviorState): ReadonlyMap<string, LatLng> {
  const coords = new Map<string, LatLng>();
  for (const bar of state.bars.values()) {
    if (bar.coords !== null) {
      coords.set(bar.barKey, bar.coords);
    }
  }
  return coords;
}

function buildRestrictions(
  state: BehaviorState,
): ReadonlyMap<string, readonly NextClaimRule[]> {
  const restrictions = new Map<string, NextClaimRule[]>();
  for (const effect of state.effects) {
    if (effect.kind !== "next_claim_restriction") continue;
    if (effect.targetTeamId === null) continue;
    if (effect.consumedAt !== null || effect.cancelledAt !== null) continue;
    const rule = effect.params.rule;
    if (rule !== "pioneer" && rule !== "scenic") continue;
    const list = restrictions.get(effect.targetTeamId) ?? [];
    list.push(rule);
    restrictions.set(effect.targetTeamId, list);
  }
  return restrictions;
}

function buildPreviousBars(
  state: BehaviorState,
): ReadonlyMap<string, import("./behaviorState").ResolvedBarRef> {
  const previous = new Map<string, import("./behaviorState").ResolvedBarRef>();
  const startRef = state.bars.get(START_BAR)!;
  for (const team of state.teams) {
    const candidates = state.claimHistory.filter(
      (c) => c.teamId === team.teamId && c.revokedReason !== "ordinary_unclaim",
    );
    if (candidates.length === 0) {
      previous.set(team.teamId, {
        barKey: startRef.barKey,
        kind: startRef.kind,
        coords: startRef.coords,
      });
      continue;
    }
    let latest = candidates[0];
    for (const c of candidates.slice(1)) {
      if (c.claimedAt > latest.claimedAt) latest = c;
    }
    const bar = state.bars.get(latest.barKey);
    previous.set(team.teamId, {
      barKey: latest.barKey,
      kind: "scoring",
      coords: bar?.coords ?? null,
    });
  }
  return previous;
}

function buildContext(state: BehaviorState): CardTargetContext {
  return {
    finishBarKey: state.finishBarKey,
    startBarKey: state.startBarKey,
    barCoords: buildBarCoords(state),
    claimState: buildClaimState(state),
    teamIds: state.teams.map((t) => t.teamId),
    previousBars: buildPreviousBars(state),
    restrictions: buildRestrictions(state),
  };
}

/** The validated casting params a card needs, so input validation always passes. */
function rawParamsFor(slug: CardSlug): unknown {
  const input = getCardMetadata(slug).castingInput;
  switch (input) {
    case "colors":
      return { colors: ["red", "green", "blue"] };
    case "duration_seconds":
      return { seconds: 60 };
    case "cuisine":
      return { cuisine: "italian" };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

const TEAM_CARDS = [
  "go-piss-girl",
  "moneybags",
  "use-it-or-lose-it",
  "wired",
  "art-school-dropout",
  "broad-shoulders",
  "bird-guide",
  "interested-buyer",
  "different-tastes",
  "everyones-a-critic",
  "spin-cycle",
  "dirty-bird",
] as const satisfies readonly CardSlug[];

const RESTRICTION_CARDS = ["pioneer", "scenic-route"] as const;

const BAR_CARDS = [
  "crop-dusting",
  "cancel-culture",
  "happy-hour",
  "party-crasher",
] as const satisfies readonly CardSlug[];

const teamCountArb = fc.integer({ min: 2, max: 4 });

// ---------------------------------------------------------------------------
// Properties.
// ---------------------------------------------------------------------------

describe("planCardPlay team targeting matches the shared selector (Property 15)", () => {
  it("accepts/rejects a plain team card exactly as selectTeamTargetEligibility (caster + same-name)", () => {
    fc.assert(
      fc.property(
        teamCountArb,
        fc.constantFrom(...TEAM_CARDS),
        fc.integer({ min: 0, max: 3 }),
        fc.boolean(),
        (teamCount, slug, targetIdx, priorSameName) => {
          const target = TEAMS[targetIdx % teamCount];
          const plays = priorSameName
            ? [{ slug, targetTeamId: target, targetBarKey: null }]
            : [];
          const state = makeState({ teamCount, slug, plays });

          const view = buildView(state);
          const ctx = buildContext(state);
          const selector = selectTeamTargetEligibility(
            view,
            slug,
            CASTER,
            ctx,
          ).find((e) => e.teamId === target);

          const req: PlayRequest = {
            cardId: `${CASTER}:${slug}`,
            casterTeamId: CASTER,
            targetTeamId: target,
            rawParams: rawParamsFor(slug),
          };
          const plan = planCardPlay(state, req, NOW_ISO);

          const eligible = selector?.eligible ?? false;
          expect(plan.ok).toBe(eligible);
          if (!eligible) {
            expect(plan.ok).toBe(false);
            if (!plan.ok) expect(plan.error).toBe("invalid_input");
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it("strands a Scenic target whose previous bar is the farthest, agreeing on reason and rules (single)", () => {
    // Deterministic coverage of the no_legal_next_bar branch: a Scenic target
    // whose previous bar is the farthest scoring bar has no bar farther from the
    // finish, so adding Scenic strands it. Both sides must say so, with rules
    // === ["scenic"].
    const target = "team-b";
    const state = makeState({
      teamCount: 2,
      slug: "scenic-route",
      previousBars: new Map([[target, "bar-far"]]),
    });
    const view = buildView(state);
    const ctx = buildContext(state);
    const selector = selectTeamTargetEligibility(
      view,
      "scenic-route",
      CASTER,
      ctx,
    ).find((e) => e.teamId === target);
    expect(selector?.eligible).toBe(false);
    expect(selector?.reason).toBe("no_legal_next_bar");
    expect([...(selector?.rules ?? [])]).toEqual(["scenic"]);

    const plan = planCardPlay(
      state,
      {
        cardId: `${CASTER}:scenic-route`,
        casterTeamId: CASTER,
        targetTeamId: target,
      },
      NOW_ISO,
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.error).toBe("invalid_input");
      const details = plan.details as
        { reason?: string; rules?: readonly NextClaimRule[] } | undefined;
      expect(details?.reason).toBe("no_legal_next_bar");
      expect([...(details?.rules ?? [])]).toEqual(["scenic"]);
    }
  });

  it("strands a Pioneer target when every other bar is held, agreeing on reason and rules (stacked)", () => {
    // Deterministic coverage of the stacked case: the target already holds Scenic
    // with its previous bar farthest out (no farther bar), and every scoring bar
    // is claimed by another team (Pioneer finds no unclaimed bar). Adding Pioneer
    // leaves no legal next bar; both sides report rules {scenic, pioneer}.
    const target = "team-b";
    const activeClaims = SCORING_BARS.map((b) => ({
      teamId: "team-c",
      barKey: b.key,
    }));
    const state = makeState({
      teamCount: 3,
      slug: "pioneer",
      effects: [restrictionEffect("existing-scenic", target, "scenic")],
      activeClaims,
      previousBars: new Map([[target, "bar-far"]]),
    });
    const view = buildView(state);
    const ctx = buildContext(state);
    const selector = selectTeamTargetEligibility(
      view,
      "pioneer",
      CASTER,
      ctx,
    ).find((e) => e.teamId === target);
    expect(selector?.eligible).toBe(false);
    expect(selector?.reason).toBe("no_legal_next_bar");
    expect([...(selector?.rules ?? [])].sort()).toEqual(["pioneer", "scenic"]);

    const plan = planCardPlay(
      state,
      {
        cardId: `${CASTER}:pioneer`,
        casterTeamId: CASTER,
        targetTeamId: target,
      },
      NOW_ISO,
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      const details = plan.details as
        { reason?: string; rules?: readonly NextClaimRule[] } | undefined;
      expect(details?.reason).toBe("no_legal_next_bar");
      expect([...(details?.rules ?? [])].sort()).toEqual(["pioneer", "scenic"]);
    }
  });

  it("surfaces the same no_legal_next_bar reason and rules for Pioneer/Scenic (single and stacked)", () => {
    fc.assert(
      fc.property(
        teamCountArb,
        fc.constantFrom(...RESTRICTION_CARDS),
        fc.integer({ min: 1, max: 3 }),
        // The target's previous bar. `bar-far` is the farthest from the finish,
        // so under Scenic Route no bar is farther and the target can be stranded;
        // the nearer bars leave Scenic satisfiable.
        fc.constantFrom("bar-near", "bar-mid", "bar-far"),
        // `stacked`: the target already holds the OTHER restriction, so the new
        // rule stacks on top (played ∪ existing).
        fc.boolean(),
        // `blanketClaims`: every other team claims every scoring bar, so Pioneer
        // finds no unclaimed non-finish bar for the target.
        fc.boolean(),
        (teamCount, slug, targetIdx, prevBarKey, stacked, blanketClaims) => {
          const target = TEAMS[targetIdx % teamCount];
          if (target === CASTER) return; // caster never targetable; skip

          const previousBars = new Map<string, string>([[target, prevBarKey]]);

          // Optionally pre-load the other restriction on the target to stack.
          const effects: EffectRecord[] = [];
          if (stacked) {
            const other: NextClaimRule =
              slug === "pioneer" ? "scenic" : "pioneer";
            effects.push(restrictionEffect("existing", target, other));
          }

          // Optionally have every other team claim every scoring bar, which makes
          // Pioneer unable to find an unclaimed non-finish bar for the target.
          const activeClaims: { teamId: string; barKey: string }[] = [];
          if (blanketClaims) {
            for (const other of TEAMS.slice(0, teamCount)) {
              if (other === target) continue;
              for (const b of SCORING_BARS) {
                activeClaims.push({ teamId: other, barKey: b.key });
              }
            }
          }

          const state = makeState({
            teamCount,
            slug,
            effects,
            activeClaims,
            previousBars,
          });

          const view = buildView(state);
          const ctx = buildContext(state);
          const selector = selectTeamTargetEligibility(
            view,
            slug,
            CASTER,
            ctx,
          ).find((e) => e.teamId === target);

          const req: PlayRequest = {
            cardId: `${CASTER}:${slug}`,
            casterTeamId: CASTER,
            targetTeamId: target,
          };
          const plan = planCardPlay(state, req, NOW_ISO);

          const eligible = selector?.eligible ?? false;
          expect(plan.ok).toBe(eligible);

          if (selector?.reason === "no_legal_next_bar") {
            expect(plan.ok).toBe(false);
            if (!plan.ok) {
              expect(plan.error).toBe("invalid_input");
              const details = plan.details as
                | { reason?: string; rules?: readonly NextClaimRule[] }
                | undefined;
              expect(details?.reason).toBe("no_legal_next_bar");
              // Same rule set on both sides (played ∪ existing), order-insensitive.
              expect([...(details?.rules ?? [])].sort()).toEqual(
                [...(selector.rules ?? [])].sort(),
              );
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("planCardPlay bar targeting matches the shared selector (Property 15)", () => {
  it("accepts/rejects a bar card exactly as selectBarTargetEligibility (finish/near_finish/four_claimants/same-name)", () => {
    fc.assert(
      fc.property(
        teamCountArb,
        fc.constantFrom(...BAR_CARDS),
        fc.constantFrom(...ALL_BAR_KEYS),
        fc.boolean(),
        fc.boolean(),
        (teamCount, slug, barKey, priorSameName, fourClaimants) => {
          const plays = priorSameName
            ? [{ slug, targetTeamId: null, targetBarKey: barKey }]
            : [];

          // For Party Crasher's four-claimant rule, optionally fill a bar with
          // four claimants (needs all four teams).
          const activeClaims: { teamId: string; barKey: string }[] = [];
          if (fourClaimants) {
            for (const team of TEAMS) {
              activeClaims.push({ teamId: team, barKey });
            }
          }

          const state = makeState({
            teamCount: fourClaimants ? 4 : teamCount,
            slug,
            plays,
            activeClaims,
          });

          const view = buildView(state);
          const ctx = buildContext(state);
          const [selector] = selectBarTargetEligibility(
            view,
            slug,
            [barKey],
            ctx,
          );

          const req: PlayRequest = {
            cardId: `${CASTER}:${slug}`,
            casterTeamId: CASTER,
            targetBarKey: barKey,
            rawParams: rawParamsFor(slug),
          };
          const plan = planCardPlay(state, req, NOW_ISO);

          expect(plan.ok).toBe(selector?.eligible ?? false);
          if (!(selector?.eligible ?? false)) {
            if (!plan.ok) expect(plan.error).toBe("invalid_input");
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("accepts/rejects Voted Off the Island exactly as the selector (start_bar/not_claimed_by_all)", () => {
    fc.assert(
      fc.property(
        teamCountArb,
        fc.constantFrom(...ALL_BAR_KEYS),
        // How many teams claim the target bar (0..4), so claimed-by-all flips.
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 3 }),
        (teamCount, barKey, claimerCount, targetIdx) => {
          const slug: CardSlug = "voted-off-the-island";
          const target = TEAMS[targetIdx % teamCount];
          if (target === CASTER) return;

          const claimers = TEAMS.slice(0, teamCount).slice(0, claimerCount);
          const activeClaims = claimers.map((teamId) => ({ teamId, barKey }));

          const state = makeState({ teamCount, slug, activeClaims });

          const view = buildView(state);
          const ctx = buildContext(state);
          const [barSelector] = selectBarTargetEligibility(
            view,
            slug,
            [barKey],
            ctx,
          );
          const teamSelector = selectTeamTargetEligibility(
            view,
            slug,
            CASTER,
            ctx,
          ).find((e) => e.teamId === target);

          // Voted Off targets both a team and a bar; the planner accepts only
          // when BOTH selectors say eligible (and the target actually holds a
          // claim on the bar, which claimed-by-all guarantees).
          const bothEligible =
            (barSelector?.eligible ?? false) &&
            (teamSelector?.eligible ?? false);

          const req: PlayRequest = {
            cardId: `${CASTER}:${slug}`,
            casterTeamId: CASTER,
            targetTeamId: target,
            targetBarKey: barKey,
            rawParams: rawParamsFor(slug),
          };
          const plan = planCardPlay(state, req, NOW_ISO);

          expect(plan.ok).toBe(bothEligible);
          if (!bothEligible && !plan.ok) {
            expect(plan.error).toBe("invalid_input");
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
