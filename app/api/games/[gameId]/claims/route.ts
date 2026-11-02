/**
 * Durable bar claim mutation route (card-behavior Task 7.5), reworked onto the
 * Card_Behavior_Mutation pipeline (design.md "Mutation pipeline" and the three
 * `POST /claims` rows of the route table).
 *
 * POST /api/games/{gameId}/claims — a team claims or unclaims a bar. In one
 * transaction it runs the shared pipeline:
 *
 *   1. authorize + lock the game row (`assertMember` + the game-state read),
 *      resolving the caster's team from the session;
 *   2. read `clock_timestamp()` as the server `now` (after the lock, so server
 *      time agrees with lock order);
 *   3. lazily settle due effect transitions (`settleDueTransitions`, pipeline
 *      step 3) at that same `now`, before loading state, so the loaded snapshot
 *      reflects the flipped announcement flags and every boundary at or before
 *      `now` is announced with its transition events ordered before this
 *      mutation's own events;
 *   4. load the single {@link BehaviorState} snapshot (`loadBehaviorState`);
 *   5. resolve the bar (`resolveGameBar`), materializing a candidate bar on
 *      first touch.
 *
 * For `action: "claim"` it then, after attestation, evaluates `evaluateClaimBlocks`
 * in `claim` mode against the server `now` (a non-empty block list rejects with
 * `blocked` and `details.blocks`), inserts the claim, plans the card-driven side
 * effects (`planClaimSideEffects` — consume next-claim restrictions, attach the
 * oldest pending Insurance, Happy Hour +5 awards, Patient Investor counting,
 * Power Hour draw override), reconciles the bar with the Party Crasher phantom
 * and Insurance floors, appends the award ledger entries, writes the effect
 * updates, ends the game with `endGameEffects` on a finish-bar claim, and draws
 * the top two cards honoring the draw override. It keeps the existing event
 * types (`claim_recorded`, `score_awarded` / `score_modifier_applied`,
 * `cards_drawn`, `game_ended`) and embeds the changed effects and awards in
 * `claim_recorded`.
 *
 * For `action: "unclaim"` it plans `planUnclaimSideEffects` (reverse this claim's
 * Happy Hour awards, uncount unpaid Patient Investor counters, release attached
 * Insurance for an ordinary unclaim; a Voted Off removal only releases
 * protection), reconciles the bar, and keeps the `claim_removed` event with the
 * changed effects and awards embedded.
 *
 * For `action: "bonus"` (Happy Hour Bonus_Claim) it runs the pure
 * `planBonusClaim` validator (live game, an active claim on the bar, an active
 * unawarded `bonus_window`, no `evaluateClaimBlocks(mode: "bonus")` block),
 * writes the +5 ledger entry and a `card_effect_awards` row with a null
 * `claim_id`, and appends exactly one `happy_hour_bonus_claimed` event embedding
 * the award and the `scoreEntries`. This path creates no claim and draws no
 * cards (13.5).
 *
 * The response `seq` is the last **mutation** event (never a transition event).
 * An uncaught error rolls the whole transaction back (domain rows, the mutation
 * events, and the step-3 transition events together) and responds `unavailable`
 * (503).
 *
 * Requirements: 4.2, 4.3, 7.3, 10.2, 10.4, 10.6, 10.7, 11.3, 12.4, 13.3, 13.5,
 * 13.6, 13.7, 13.9, 14.2, 14.3, 14.4, 14.5, 14.6, 15.1, 15.2, 15.4, 15.5, 16.2,
 * 16.3, 16.4, 16.5, 16.7, 17.2, 18.7, 19.5, 19.6, 19.7, 19.8, 19.9, 19.10,
 * 20.3c.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent, type QueryRunner } from "@/lib/events";
import { GAME_BOARD_EVENT_TYPES } from "@/lib/gameboard/events";
import { evaluateClaimEligibility, type ClaimEligibility } from "@/lib/claims";
import { applyDeckTransition } from "@/lib/cards/persistence";
import { drawForBar } from "@/lib/cards/deck";
import { computeBarAllocation } from "@/lib/scoring/allocation";
import { isEffectActive } from "@/lib/cards/effects";
import {
  loadBehaviorState,
  settleDueTransitions,
  reconcileBarsInTx,
  appendLedger,
  endGameEffects,
  type BehaviorState,
  type ScoreEntryRecord,
  type EffectRecord,
} from "@/lib/cards/behaviorStore";
import {
  planBonusClaim,
  planClaimSideEffects,
  planUnclaimSideEffects,
  type ClaimSideEffects,
  type UnclaimSideEffects,
} from "@/lib/cards/claimEffects";
import {
  evaluateClaimBlocks,
  previousBarFor,
  type ClaimBlock,
} from "@/lib/claims/blocks";
import { resolveGameBar, type ResolvedBar } from "@/lib/map/barResolver";
import type { ResolvedBarRef } from "@/lib/cards/behaviorState";
import type { ClaimScoringBarKind } from "@/lib/scoring";
import type { LatLng } from "@/lib/map/geo";

import {
  assertMember,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

export const runtime = "nodejs";

interface ClaimsBody {
  readonly action?: unknown;
  readonly barId?: unknown;
  readonly allMembersPresent?: unknown;
  readonly finishedDrinkCount?: unknown;
}

/**
 * The claim actions this route dispatches: an ordinary claim, an unclaim, and
 * the Happy Hour Bonus_Claim.
 */
type ClaimAction = "claim" | "unclaim" | "bonus";

type ClaimOutcome =
  | { readonly ok: true; readonly seq: number; readonly claimId: string }
  | {
      readonly ok: false;
      readonly reason: LobbyErrorReason;
      readonly details?: unknown;
    };

const CLOCK_NOW_SQL = `select clock_timestamp() as now`;

const PLAYER_SQL = `
select team_id
from players
where game_id = $1 and session_id = $2
limit 1
`;

const TEAM_MEMBER_COUNT_SQL = `
select count(*)::int as member_count
from players
where game_id = $1 and team_id = $2
`;

const ACTIVE_CLAIMS_SQL = `
select id, team_id
from claims
where game_id = $1 and bar_id = $2 and revoked_at is null
order by claimed_at, id
for update
`;

const INSERT_CLAIM_SQL = `
insert into claims (game_id, team_id, bar_id)
values ($1, $2, $3)
returning id
`;

const REVOKE_CLAIM_SQL = `
update claims
set revoked_at = now(), revoked_reason = 'ordinary_unclaim'
where id = $1 and game_id = $2 and revoked_at is null
returning id
`;

/** Consume a set of next-claim restriction effects as this claim's "next claim". */
const CONSUME_EFFECTS_SQL = `
update card_effects
set consumed_at = now(), consumed_by_claim_id = $3
where game_id = $1 and id = any($2::uuid[]) and consumed_at is null
`;

/** Attach the chosen Insurance protection to this claim with its protected floor. */
const ATTACH_PROTECTION_SQL = `
update card_effects
set attached_claim_id = $3, protected_points = $4
where game_id = $1 and id = $2 and consumed_at is null and cancelled_at is null
`;

/** Release an Insurance protection attached to an unclaimed claim. */
const RELEASE_PROTECTION_SQL = `
update card_effects
set cancelled_at = now(), cancel_reason = 'protection_released'
where game_id = $1 and id = $2 and cancelled_at is null and consumed_at is null
`;

/** Advance a Patient Investor counter's counted list, paying out + consuming at 4. */
const UPDATE_COUNTER_SQL = `
update card_effects
set params = $3::text::jsonb,
    consumed_at = case when $4 then now() else consumed_at end,
    consumed_by_claim_id = case when $4 then $5 else consumed_by_claim_id end
where game_id = $1 and id = $2
`;

/** Insert a card-effect award pointing at the ledger entry that applied it. */
const INSERT_AWARD_SQL = `
insert into card_effect_awards
  (game_id, effect_id, team_id, kind, claim_id, ledger_entry_id, created_at)
values ($1, $2, $3, $4, $5, $6, now())
returning id
`;

/** Mark a card-effect award reversed, naming the reversal ledger entry. */
const REVERSE_AWARD_SQL = `
update card_effect_awards
set reversed_at = now(), reversal_ledger_entry_id = $3
where game_id = $1 and id = $2 and reversed_at is null
`;

const END_FINISH_GAME_SQL = `
update games
set lifecycle = 'ended', end_reason = 'finish_bar_claimed'
where id = $1 and lifecycle = 'live'
returning id
`;

function readAction(value: unknown): ClaimAction | undefined {
  return value === "claim" || value === "unclaim" || value === "bonus"
    ? value
    : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readAttestation(
  body: ClaimsBody,
):
  | { readonly allMembersPresent: boolean; readonly finishedDrinkCount: number }
  | undefined {
  if (
    typeof body.allMembersPresent !== "boolean" ||
    typeof body.finishedDrinkCount !== "number" ||
    !Number.isInteger(body.finishedDrinkCount) ||
    body.finishedDrinkCount < 0
  ) {
    return undefined;
  }
  return {
    allMembersPresent: body.allMembersPresent,
    finishedDrinkCount: body.finishedDrinkCount,
  };
}

/** The server `now` read after the lock, as an ISO string. */
async function serverNowIso(tx: QueryRunner): Promise<string> {
  const { rows } = await tx.query(CLOCK_NOW_SQL, []);
  const raw = rows[0]?.now;
  return raw instanceof Date
    ? raw.toISOString()
    : new Date(String(raw)).toISOString();
}

/** Classify a resolved bar for scoring. */
function scoringKind(bar: ResolvedBar): ClaimScoringBarKind {
  return bar.kind;
}

/** The bar keys carrying an active Party Crasher phantom share at `nowMs`. */
function phantomBarKeys(
  state: BehaviorState,
  nowMs: number,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const effect of state.effects) {
    if (
      effect.kind === "phantom_share" &&
      effect.targetBarKey !== null &&
      isEffectActive(effect, nowMs)
    ) {
      keys.add(effect.targetBarKey);
    }
  }
  return keys;
}

/**
 * The per-bar Insurance floors from every active, attached `score_protection`
 * effect, keyed by the bar the attached claim sits on. `extra` lets the caller
 * fold in a protection that is being attached in this same transaction (its row
 * is not yet in the loaded snapshot).
 */
function protectedFloorsByBar(
  state: BehaviorState,
  nowMs: number,
  extra?: {
    readonly claimId: string;
    readonly barKey: string;
    readonly teamId: string;
    readonly protectedPoints: number;
  },
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const byBar = new Map<string, Map<string, number>>();
  const barKeyOfClaim = new Map<string, string>();
  for (const claim of state.activeClaims) {
    barKeyOfClaim.set(claim.claimId, claim.barKey);
  }
  if (extra !== undefined) {
    barKeyOfClaim.set(extra.claimId, extra.barKey);
  }

  const add = (barKey: string, teamId: string, points: number): void => {
    let floors = byBar.get(barKey);
    if (floors === undefined) {
      floors = new Map<string, number>();
      byBar.set(barKey, floors);
    }
    floors.set(teamId, Math.max(floors.get(teamId) ?? 0, points));
  };

  for (const effect of state.effects) {
    if (
      effect.kind !== "score_protection" ||
      effect.attachedClaimId === null ||
      effect.ownerTeamId === null ||
      effect.protectedPoints === null ||
      !isEffectActive(effect, nowMs)
    ) {
      continue;
    }
    const barKey = barKeyOfClaim.get(effect.attachedClaimId);
    if (barKey === undefined) continue;
    add(barKey, effect.ownerTeamId, effect.protectedPoints);
  }

  if (extra !== undefined) {
    add(extra.barKey, extra.teamId, extra.protectedPoints);
  }
  return byBar;
}

/**
 * Build the {@link ResolvedBarRef} for the team's previous bar (for Scenic
 * Route), resolving coordinates from the loaded bar map where the claim history
 * row did not carry them.
 */
function previousBarRef(state: BehaviorState, teamId: string): ResolvedBarRef {
  const startRef: ResolvedBarRef =
    state.startBarKey !== null && state.bars.has(state.startBarKey)
      ? {
          barKey: state.startBarKey,
          kind: "start",
          coords: state.bars.get(state.startBarKey)!.coords,
        }
      : { barKey: "", kind: "start", coords: null };

  const previous = previousBarFor(teamId, state.claimHistory, startRef);
  if (previous.coords === null && previous.barKey !== "") {
    return {
      ...previous,
      coords: state.bars.get(previous.barKey)?.coords ?? null,
    };
  }
  return previous;
}

/**
 * Evaluate claim blocks for a real claim (design.md section 10). Returns the
 * complete, non-short-circuiting block list, empty when the claim is allowed.
 */
function claimBlocksFor(
  state: BehaviorState,
  teamId: string,
  bar: ResolvedBar,
  nowMs: number,
): readonly ClaimBlock[] {
  const finishBar =
    state.finishBarKey === null
      ? undefined
      : state.bars.get(state.finishBarKey);
  const finishCoords = finishBar?.coords ?? null;

  const barCoords = new Map<string, LatLng>();
  for (const b of state.bars.values()) {
    if (b.coords !== null) {
      barCoords.set(b.barKey, b.coords);
    }
  }

  const barRef: ResolvedBarRef = {
    barKey: bar.barKey,
    kind: bar.kind,
    coords: bar.coords,
  };

  return evaluateClaimBlocks({
    teamId,
    bar: barRef,
    finishCoords,
    challenges: state.challenges,
    effects: state.effects,
    activeClaims: state.activeClaims.map((c) => ({
      teamId: c.teamId,
      barKey: c.barKey,
    })),
    previousBar: previousBarRef(state, teamId),
    barCoords,
    mode: "claim",
    nowMs,
  });
}

/**
 * Append one `score_awarded` / `score_modifier_applied` event per reconciled
 * share ledger entry, matching the pre-existing event-per-entry shape so the
 * projection folds each entry on its own seq. Returns the last appended seq (0
 * when there were no entries).
 */
async function appendScoreEvents(
  tx: QueryRunner,
  gameId: string,
  barId: string,
  entries: readonly ScoreEntryRecord[],
): Promise<number> {
  let lastSeq = 0;
  for (const entry of entries) {
    const event = await appendEvent(tx, {
      gameId,
      type:
        entry.category === "bar_share_correction"
          ? GAME_BOARD_EVENT_TYPES.scoreModifierApplied
          : GAME_BOARD_EVENT_TYPES.scoreAwarded,
      actor: { kind: "team", teamId: entry.teamId },
      payload: {
        entryId: entry.entryId,
        teamId: entry.teamId,
        barId,
        sourceClaimId: entry.sourceClaimId,
        category: entry.category,
        points: entry.points,
      },
    });
    lastSeq = event.seq;
  }
  return lastSeq;
}

/**
 * Apply a {@link ClaimSideEffects} plan's durable writes (consume restrictions,
 * attach Insurance, Happy Hour +5 awards, Patient Investor counter updates and
 * +6 payouts). Returns the effect rows and award ledger entries to embed in
 * `claim_recorded`.
 */
async function writeClaimSideEffects(
  tx: QueryRunner,
  args: {
    readonly state: BehaviorState;
    readonly gameId: string;
    readonly claimId: string;
    readonly teamId: string;
    readonly barId: string;
    readonly side: ClaimSideEffects;
  },
): Promise<{
  readonly effects: EffectRecord[];
  readonly awards: AwardEmbed[];
  readonly scoreEntries: ScoreEntryRecord[];
}> {
  const { state, gameId, claimId, teamId, barId, side } = args;
  const effects: EffectRecord[] = [];
  const awards: AwardEmbed[] = [];
  const scoreEntries: ScoreEntryRecord[] = [];

  const effectById = new Map<string, EffectRecord>();
  for (const effect of state.effects) {
    effectById.set(effect.effectId, effect);
  }

  // Consume next-claim restrictions (10.6).
  if (side.consumeEffects.length > 0) {
    await tx.query(CONSUME_EFFECTS_SQL, [gameId, side.consumeEffects, claimId]);
    for (const effectId of side.consumeEffects) {
      const base = effectById.get(effectId);
      if (base !== undefined) {
        effects.push({ ...base, consumedAt: state.nowIso });
      }
    }
  }

  // Attach the oldest pending Insurance to this claim (15.2).
  if (side.attachProtection !== null) {
    await tx.query(ATTACH_PROTECTION_SQL, [
      gameId,
      side.attachProtection.effectId,
      claimId,
      side.attachProtection.protectedPoints,
    ]);
    const base = effectById.get(side.attachProtection.effectId);
    if (base !== undefined) {
      effects.push({
        ...base,
        attachedClaimId: claimId,
        protectedPoints: side.attachProtection.protectedPoints,
      });
    }
  }

  // Happy Hour +5 award for an active window on the bar (13.3).
  if (side.happyHourAward !== null) {
    const [ledger] = await appendLedger(tx, gameId, [
      {
        teamId,
        barId,
        category: "happy_hour_bonus",
        points: 5,
        sourceClaimId: claimId,
        sourceEffectId: side.happyHourAward.effectId,
      },
    ]);
    const { rows } = await tx.query(INSERT_AWARD_SQL, [
      gameId,
      side.happyHourAward.effectId,
      teamId,
      "happy_hour_bonus",
      claimId,
      ledger.entryId,
    ]);
    scoreEntries.push(ledger);
    awards.push({
      awardId: String(rows[0]?.id),
      effectId: side.happyHourAward.effectId,
      teamId,
      kind: "happy_hour_bonus",
      claimId,
      ledgerEntryId: ledger.entryId,
      reversedAt: null,
      reversalLedgerEntryId: null,
    });
  }

  // Patient Investor counting: advance each counter, pay out + consume at 4 (16.4).
  for (const update of side.counterUpdates) {
    const base = effectById.get(update.effectId);
    const nextParams = {
      ...(base?.params ?? {}),
      counted: update.counted,
    };
    await tx.query(UPDATE_COUNTER_SQL, [
      gameId,
      update.effectId,
      JSON.stringify(nextParams),
      update.payout,
      claimId,
    ]);
    if (base !== undefined) {
      effects.push({
        ...base,
        params: nextParams,
        consumedAt: update.payout ? state.nowIso : base.consumedAt,
      });
    }
    if (update.payout) {
      const [ledger] = await appendLedger(tx, gameId, [
        {
          teamId,
          barId,
          category: "patient_investor_award",
          points: 6,
          sourceClaimId: claimId,
          sourceEffectId: update.effectId,
        },
      ]);
      const { rows } = await tx.query(INSERT_AWARD_SQL, [
        gameId,
        update.effectId,
        teamId,
        "patient_investor_award",
        claimId,
        ledger.entryId,
      ]);
      scoreEntries.push(ledger);
      awards.push({
        awardId: String(rows[0]?.id),
        effectId: update.effectId,
        teamId,
        kind: "patient_investor_award",
        claimId,
        ledgerEntryId: ledger.entryId,
        reversedAt: null,
        reversalLedgerEntryId: null,
      });
    }
  }

  return { effects, awards, scoreEntries };
}

/**
 * Apply an {@link UnclaimSideEffects} plan's durable writes (reverse Happy Hour
 * awards, uncount Patient Investor counters, release attached Insurance). Returns
 * the effect rows and award rows to embed in `claim_removed`, plus the reversal
 * ledger entries.
 */
async function writeUnclaimSideEffects(
  tx: QueryRunner,
  args: {
    readonly state: BehaviorState;
    readonly gameId: string;
    readonly barId: string;
    readonly side: UnclaimSideEffects;
  },
): Promise<{
  readonly effects: EffectRecord[];
  readonly awards: AwardEmbed[];
  readonly scoreEntries: ScoreEntryRecord[];
}> {
  const { state, gameId, barId, side } = args;
  const effects: EffectRecord[] = [];
  const awards: AwardEmbed[] = [];
  const scoreEntries: ScoreEntryRecord[] = [];

  const effectById = new Map<string, EffectRecord>();
  for (const effect of state.effects) {
    effectById.set(effect.effectId, effect);
  }
  const awardById = new Map(state.awards.map((a) => [a.awardId, a]));

  // Reverse this claim's Happy Hour awards (−5) (13.9).
  for (const awardId of side.reverseAwards) {
    const award = awardById.get(awardId);
    if (award === undefined) continue;
    const [ledger] = await appendLedger(tx, gameId, [
      {
        teamId: award.teamId,
        barId,
        category: "happy_hour_bonus_reversal",
        points: -5,
        sourceClaimId: award.claimId,
        sourceEffectId: award.effectId,
      },
    ]);
    await tx.query(REVERSE_AWARD_SQL, [gameId, awardId, ledger.entryId]);
    scoreEntries.push(ledger);
    awards.push({
      awardId,
      effectId: award.effectId,
      teamId: award.teamId,
      kind: award.kind,
      claimId: award.claimId,
      ledgerEntryId: award.ledgerEntryId,
      reversedAt: state.nowIso,
      reversalLedgerEntryId: ledger.entryId,
    });
  }

  // Uncount this claim from unpaid Patient Investor counters (16.3).
  for (const update of side.uncount) {
    const base = effectById.get(update.effectId);
    const nextParams = {
      ...(base?.params ?? {}),
      counted: update.counted,
    };
    await tx.query(UPDATE_COUNTER_SQL, [
      gameId,
      update.effectId,
      JSON.stringify(nextParams),
      false,
      null,
    ]);
    if (base !== undefined) {
      effects.push({ ...base, params: nextParams });
    }
  }

  // Release Insurance attached to this claim (15.5).
  for (const effectId of side.releaseProtections) {
    await tx.query(RELEASE_PROTECTION_SQL, [gameId, effectId]);
    const base = effectById.get(effectId);
    if (base !== undefined) {
      effects.push({
        ...base,
        cancelledAt: state.nowIso,
        cancelReason: "protection_released",
      });
    }
  }

  return { effects, awards, scoreEntries };
}

/** The embedded award record shape folded by the projection (`awardId` key). */
interface AwardEmbed {
  readonly awardId: string;
  readonly effectId: string;
  readonly teamId: string;
  readonly kind: "happy_hour_bonus" | "patient_investor_award";
  readonly claimId: string | null;
  readonly ledgerEntryId: string;
  readonly reversedAt: string | null;
  readonly reversalLedgerEntryId: string | null;
}

/**
 * Draw the top two cards for a team's claim of a non-finish bar, honoring the
 * Power Hour draw override (17.2). The pure deck engine owns the rules: it
 * rejects a duplicate-bar draw, an unresolved pending draw, and an exhausted
 * deck, and keeps both cards when the override is active. A rejection here is
 * expected and benign — it means "this claim draws nothing" — so it is swallowed
 * and the claim still commits.
 *
 * @returns the appended `cards_drawn` event seq, or 0 when no draw happened.
 */
async function drawOnClaim(
  tx: QueryRunner,
  args: {
    readonly gameId: string;
    readonly teamId: string;
    readonly barId: string;
    readonly drawOverride: boolean;
  },
): Promise<number> {
  const result = await applyDeckTransition(tx, {
    ctx: { gameId: args.gameId, teamId: args.teamId },
    kind: "draw",
    transition: (state) =>
      drawForBar(state, args.barId, { drawOverride: args.drawOverride }),
    barId: args.barId,
  });
  return result.ok ? result.seq : 0;
}

/**
 * Compute the team's post-claim target allocation on the bar (phantom + existing
 * Insurance floors), so `planClaimSideEffects` can set a newly attached
 * Insurance floor to the real allocation the claim earns (15.2).
 */
function allocationAfterClaim(
  state: BehaviorState,
  bar: ResolvedBar,
  teamId: string,
  previousTeamIds: readonly string[],
  nowMs: number,
): ReadonlyMap<string, number> {
  const claimantTeamIds = [...previousTeamIds, teamId];
  const floorsByBar = protectedFloorsByBar(state, nowMs);
  const protectedFloors =
    floorsByBar.get(bar.barKey) ?? new Map<string, number>();
  return computeBarAllocation({
    barKind: scoringKind(bar),
    claimantTeamIds,
    phantom: phantomBarKeys(state, nowMs).has(bar.barKey),
    protectedFloors,
  });
}

/** Handle `action: "claim"`. */
async function handleClaim(
  tx: QueryRunner,
  args: {
    readonly state: BehaviorState;
    readonly gameId: string;
    readonly teamId: string;
    readonly bar: ResolvedBar;
    readonly nowMs: number;
    readonly attestation: {
      readonly allMembersPresent: boolean;
      readonly finishedDrinkCount: number;
    };
  },
): Promise<ClaimOutcome> {
  const { state, gameId, teamId, bar, nowMs, attestation } = args;

  const { rows: activeRows } = await tx.query(ACTIVE_CLAIMS_SQL, [
    gameId,
    bar.barId,
  ]);
  const previousTeamIds = activeRows.map((row) => String(row.team_id));

  if (previousTeamIds.includes(teamId)) {
    return { ok: false, reason: "claim_duplicate" };
  }

  // Attestation eligibility (half-the-team rule).
  const { rows: memberRows } = await tx.query(TEAM_MEMBER_COUNT_SQL, [
    gameId,
    teamId,
  ]);
  const teamMemberCount = Number(memberRows[0]?.member_count ?? 0);
  const eligibility: ClaimEligibility = evaluateClaimEligibility({
    teamMemberCount,
    finishedDrinkCount: attestation.finishedDrinkCount,
    allMembersPresent: attestation.allMembersPresent,
  });
  if (!eligibility.eligible) {
    return { ok: false, reason: "claim_ineligible" };
  }

  // Claim blocks (challenge gate, critic, Crop Dusting, Cancel Culture, Pioneer,
  // Scenic Route) against server now (4.2, 4.3, 7.3, 10.2, 10.4, 11.3, 12.4).
  const blocks = claimBlocksFor(state, teamId, bar, nowMs);
  if (blocks.length > 0) {
    return { ok: false, reason: "blocked", details: { blocks } };
  }

  // Insert the claim.
  const { rows: claimRows } = await tx.query(INSERT_CLAIM_SQL, [
    gameId,
    teamId,
    bar.barId,
  ]);
  const claimId = String(claimRows[0]?.id);

  // Plan the card-driven side effects, with the real post-claim allocation so a
  // newly attached Insurance floor equals the points this claim earns.
  const allocationAfter = allocationAfterClaim(
    state,
    bar,
    teamId,
    previousTeamIds,
    nowMs,
  );
  const side = planClaimSideEffects(
    state,
    { claimId, teamId, barKey: bar.barKey },
    allocationAfter,
    nowMs,
  );

  // Apply the side-effect writes (restrictions, Insurance, Happy Hour, counters).
  const sideWrites = await writeClaimSideEffects(tx, {
    state,
    gameId,
    claimId,
    teamId,
    barId: bar.barId,
    side,
  });

  // Reconcile the bar's share holdings with the phantom and Insurance floors.
  // The newly inserted claim is not in the loaded snapshot, so fold it in; the
  // newly attached protection is folded into the floors too.
  const barsWithResolved = new Map(state.bars);
  barsWithResolved.set(bar.barKey, bar);
  const reconcileState: BehaviorState = {
    ...state,
    bars: barsWithResolved,
    activeClaims: [
      ...state.activeClaims,
      {
        claimId,
        teamId,
        barId: bar.barId,
        barKey: bar.barKey,
        claimedAt: state.nowIso,
        revokedReason: null,
      },
    ],
  };
  const floors = protectedFloorsByBar(
    state,
    nowMs,
    side.attachProtection === null
      ? undefined
      : {
          claimId,
          barKey: bar.barKey,
          teamId,
          protectedPoints: side.attachProtection.protectedPoints,
        },
  );
  const shareEntries = await reconcileBarsInTx(
    tx,
    reconcileState,
    [bar.barKey],
    {
      phantom: phantomBarKeys(state, nowMs),
      protectedFloors: floors,
    },
  );

  // The canonical claim_recorded event, embedding the changed effects and awards
  // so the projection folds them without a parallel client source.
  const claimEvent = await appendEvent(tx, {
    gameId,
    type: GAME_BOARD_EVENT_TYPES.claimRecorded,
    actor: { kind: "team", teamId },
    payload: {
      claimId,
      teamId,
      barId: bar.barKey,
      activeTeamIds: [...previousTeamIds, teamId],
      effects: sideWrites.effects,
      awards: sideWrites.awards,
    },
  });
  let lastSeq = claimEvent.seq;

  // Share + award ledger events, each on its own seq.
  const shareSeq = await appendScoreEvents(
    tx,
    gameId,
    bar.barKey,
    shareEntries,
  );
  if (shareSeq !== 0) lastSeq = shareSeq;
  const awardSeq = await appendScoreEvents(
    tx,
    gameId,
    bar.barKey,
    sideWrites.scoreEntries,
  );
  if (awardSeq !== 0) lastSeq = awardSeq;

  if (scoringKind(bar) === "finish") {
    // The finish bar ends the game immediately and must NOT draw. Cancel every
    // live effect before the single game_ended append (20.6).
    const { rows: endedRows } = await tx.query(END_FINISH_GAME_SQL, [gameId]);
    if (endedRows.length !== 1) {
      throw new Error("claim finish: game was no longer live");
    }
    await endGameEffects(tx, gameId);
    const endedEvent = await appendEvent(tx, {
      gameId,
      type: GAME_BOARD_EVENT_TYPES.gameEnded,
      actor: { kind: "team", teamId },
      payload: {
        endReason: "finish_bar_claimed",
        finishBarId: bar.barKey,
        claimingTeamId: teamId,
      },
    });
    return { ok: true, seq: endedEvent.seq, claimId };
  }

  // Every non-finish claim draws the top two cards, honoring the Power Hour
  // draw override, within this same transaction.
  const drawSeq = await drawOnClaim(tx, {
    gameId,
    teamId,
    barId: bar.barId,
    drawOverride: side.drawOverride,
  });
  if (drawSeq !== 0) lastSeq = drawSeq;

  return { ok: true, seq: lastSeq, claimId };
}

/** Handle `action: "unclaim"`. */
async function handleUnclaim(
  tx: QueryRunner,
  args: {
    readonly state: BehaviorState;
    readonly gameId: string;
    readonly teamId: string;
    readonly bar: ResolvedBar;
    readonly nowMs: number;
  },
): Promise<ClaimOutcome> {
  const { state, gameId, teamId, bar, nowMs } = args;

  const { rows: activeRows } = await tx.query(ACTIVE_CLAIMS_SQL, [
    gameId,
    bar.barId,
  ]);
  const active = activeRows.find((row) => String(row.team_id) === teamId);
  if (!active) {
    return { ok: false, reason: "claim_not_active" };
  }
  if (scoringKind(bar) === "finish") {
    return { ok: false, reason: "not_live" };
  }
  const claimId = String(active.id);

  const { rows: revokedRows } = await tx.query(REVOKE_CLAIM_SQL, [
    claimId,
    gameId,
  ]);
  if (revokedRows.length !== 1) {
    return { ok: false, reason: "claim_not_active" };
  }

  // Plan + apply the unclaim side effects (reverse Happy Hour awards, uncount
  // counters, release attached Insurance for an ordinary unclaim).
  const side = planUnclaimSideEffects(state, claimId, "ordinary_unclaim");
  const sideWrites = await writeUnclaimSideEffects(tx, {
    state,
    gameId,
    barId: bar.barId,
    side,
  });

  // Reconcile the bar with the revoked claim dropped from the snapshot, folding
  // in the remaining protections.
  const barsWithResolved = new Map(state.bars);
  barsWithResolved.set(bar.barKey, bar);
  const reconcileState: BehaviorState = {
    ...state,
    bars: barsWithResolved,
    activeClaims: state.activeClaims.filter((c) => c.claimId !== claimId),
  };
  const floors = protectedFloorsByBar(reconcileState, nowMs);
  const shareEntries = await reconcileBarsInTx(
    tx,
    reconcileState,
    [bar.barKey],
    {
      phantom: phantomBarKeys(state, nowMs),
      protectedFloors: floors,
    },
  );

  const claimEvent = await appendEvent(tx, {
    gameId,
    type: GAME_BOARD_EVENT_TYPES.claimRemoved,
    actor: { kind: "team", teamId },
    payload: {
      claimId,
      teamId,
      barId: bar.barKey,
      reason: "ordinary_unclaim",
      effects: sideWrites.effects,
      awards: sideWrites.awards,
    },
  });
  let lastSeq = claimEvent.seq;

  const shareSeq = await appendScoreEvents(
    tx,
    gameId,
    bar.barKey,
    shareEntries,
  );
  if (shareSeq !== 0) lastSeq = shareSeq;
  const reversalSeq = await appendScoreEvents(
    tx,
    gameId,
    bar.barKey,
    sideWrites.scoreEntries,
  );
  if (reversalSeq !== 0) lastSeq = reversalSeq;

  return { ok: true, seq: lastSeq, claimId };
}

/**
 * Handle `action: "bonus"` — the Happy Hour Bonus_Claim (design.md "POST
 * /claims action: bonus"; Req 13.5–13.7). The pure {@link planBonusClaim}
 * validates the move against the loaded snapshot and server `now`: it requires a
 * live game, an active claim by the team on the bar, an active unawarded
 * `bonus_window` on the bar, and no `evaluateClaimBlocks(mode: "bonus")` block —
 * rejecting with a Stable_Error reason (`conflict` / `not_found` / `expired` /
 * `already_resolved` / `blocked`) that the route passes straight through, as the
 * claim/unclaim paths do.
 *
 * On an accepted plan it writes the +5 Happy Hour bonus: one ledger entry (the
 * `happy_hour_bonus` category, attributed to the window effect, with no source
 * claim) and one `card_effect_awards` row (`claim_id` null — a Bonus_Claim does
 * not create a claim). It then appends exactly one `happy_hour_bonus_claimed`
 * mutation event embedding the award and the `scoreEntries`, so the projection
 * folds the +5 and the award without a parallel client source. This path creates
 * no claim and draws no cards (13.5).
 */
async function handleBonus(
  tx: QueryRunner,
  args: {
    readonly state: BehaviorState;
    readonly gameId: string;
    readonly teamId: string;
    readonly bar: ResolvedBar;
    readonly nowMs: number;
  },
): Promise<ClaimOutcome> {
  const { state, gameId, teamId, bar, nowMs } = args;

  const planned = planBonusClaim(state, teamId, bar.barKey, nowMs);
  if (!planned.ok) {
    return { ok: false, reason: planned.error, details: planned.details };
  }
  const { effectId } = planned.plan;

  // Write the +5 ledger entry, attributed to the window effect with no source
  // claim (a Bonus_Claim creates no claim).
  const [ledger] = await appendLedger(tx, gameId, [
    {
      teamId,
      barId: bar.barId,
      category: "happy_hour_bonus",
      points: 5,
      sourceClaimId: null,
      sourceEffectId: effectId,
    },
  ]);

  // Record the award (claim_id null for a Bonus_Claim).
  const { rows } = await tx.query(INSERT_AWARD_SQL, [
    gameId,
    effectId,
    teamId,
    "happy_hour_bonus",
    null,
    ledger.entryId,
  ]);
  const award: AwardEmbed = {
    awardId: String(rows[0]?.id),
    effectId,
    teamId,
    kind: "happy_hour_bonus",
    claimId: null,
    ledgerEntryId: ledger.entryId,
    reversedAt: null,
    reversalLedgerEntryId: null,
  };

  // Exactly one mutation event, embedding the award and the ledger entry so the
  // projection folds the +5 and the award. No claim, no draw.
  const bonusEvent = await appendEvent(tx, {
    gameId,
    type: GAME_BOARD_EVENT_TYPES.happyHourBonusClaimed,
    actor: { kind: "team", teamId },
    payload: {
      barKey: bar.barKey,
      teamId,
      effectId,
      awards: [award],
      scoreEntries: [ledger],
    },
  });

  return { ok: true, seq: bonusEvent.seq, claimId: ledger.entryId };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  const session = requireSession(request);
  if (!session.ok) return notApplied(session.reason);

  const gameId = (await context.params).gameId.trim();
  if (!gameId) return notApplied("invalid_claim");

  let body: ClaimsBody;
  try {
    body = (await request.json()) as ClaimsBody;
  } catch {
    return notApplied("invalid_claim");
  }

  const action = readAction(body.action);
  const barId = readString(body.barId);
  if (!action || !barId) return notApplied("invalid_claim");

  const attestation = action === "claim" ? readAttestation(body) : undefined;
  if (action === "claim" && !attestation) {
    return notApplied("invalid_claim");
  }

  try {
    const outcome = await withTransaction<ClaimOutcome>(async (tx) => {
      // Pipeline step 1: authorize + lock the game row.
      if (!(await assertMember(tx, gameId, session.sessionId))) {
        return { ok: false, reason: "not_member" };
      }

      // Pipeline step 2: server time, read after the lock.
      const nowIso = await serverNowIso(tx);
      const nowMs = Date.parse(nowIso);

      // Pipeline step 3: lazily settle due effect transitions before loading.
      await settleDueTransitions(tx, gameId, nowIso);

      // Pipeline step 4: the single loaded snapshot.
      const state = await loadBehaviorState(tx, gameId, nowIso);
      if (state.lifecycle !== "live") {
        return { ok: false, reason: "not_live" };
      }

      // Resolve the acting team.
      const { rows: playerRows } = await tx.query(PLAYER_SQL, [
        gameId,
        session.sessionId,
      ]);
      const teamId = playerRows[0]?.team_id;
      if (teamId == null) return { ok: false, reason: "no_team" };
      const resolvedTeamId = String(teamId);

      // Pipeline step 5: resolve the bar (materialize a candidate on first touch).
      const bar = await resolveGameBar(tx, gameId, barId);
      if (bar === null) return { ok: false, reason: "not_found" };

      if (action === "claim") {
        return handleClaim(tx, {
          state,
          gameId,
          teamId: resolvedTeamId,
          bar,
          nowMs,
          attestation: attestation!,
        });
      }
      if (action === "bonus") {
        return handleBonus(tx, {
          state,
          gameId,
          teamId: resolvedTeamId,
          bar,
          nowMs,
        });
      }
      return handleUnclaim(tx, {
        state,
        gameId,
        teamId: resolvedTeamId,
        bar,
        nowMs,
      });
    });

    if (!outcome.ok) return notApplied(outcome.reason, outcome.details);
    return NextResponse.json(
      { applied: true, seq: outcome.seq, result: { claimId: outcome.claimId } },
      { status: 200 },
    );
  } catch {
    // An uncaught error rolls back the domain rows, the mutation events, and the
    // step-3 transition events together; the next settle re-derives them.
    return notApplied("unavailable");
  }
}
