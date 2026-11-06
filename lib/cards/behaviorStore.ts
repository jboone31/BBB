/**
 * Server persistence for the card-behavior engine (`lib/cards/behaviorStore.ts`).
 *
 * This is the transactional bridge between the pure planners
 * (`effects.ts`, `challenges.ts`, and the claim/play side-effect planners) and
 * the durable rows added in `supabase/migrations/0013_card_behavior.sql`
 * (`card_challenges`, `card_effects`, `fairest_offers`, `card_effect_awards`,
 * plus the enriched `card_plays` and the `score_ledger_entries.source_effect_id`
 * link). It owns three responsibilities, all inside the caller's open
 * transaction (design.md section 15):
 *
 *   1. {@link loadBehaviorState} assembles the single {@link BehaviorState}
 *      snapshot every planner reads: lifecycle, teams, host, bars, claims,
 *      hands, plays, challenges, offers, effects, awards, and the score ledger.
 *      The mutation pipeline calls it at step 4, after the lazy Timer_Sweep has
 *      flipped the announcement flags, so the snapshot reflects the current
 *      window state.
 *   2. The write helpers ({@link writeChallenges}, {@link writeOffers},
 *      {@link writeEffects}, {@link appendLedger}) persist a plan's rows with
 *      `insert ... on conflict (id) do update`, so re-running the same plan in a
 *      transaction is idempotent. Effects that start immediately are inserted
 *      with `start_announced_at = created_at` so the Timer_Sweep only ever
 *      announces a delayed activation (Cancel Culture).
 *   3. {@link reconcileBarsInTx} re-derives each bar's target share allocation
 *      (phantom + Insurance floors) through `computeBarAllocation` /
 *      `reconcileBar` and appends the minimal ledger diff;
 *      {@link endGameEffects} cancels every live effect with
 *      `cancel_reason = 'game_ended'` for the finish-bar / auto-timeout paths.
 *
 * The behavior-state types are re-exported so a caller has a single import.
 *
 * Requirements: 4.1, 19.4, 19.7, 20.1, 20.6.
 */

import type { QueryRunner } from "@/lib/events";
import { resolveGameBar, type ResolvedBar } from "@/lib/map/barResolver";
import {
  computeBarAllocation,
  currentBarHoldings,
  reconcileBar,
  type LedgerEntry,
  type LedgerCategory,
} from "@/lib/scoring/allocation";
import type { ClaimScoringBarKind } from "@/lib/scoring";

import type { CardSlug } from "./catalog";
import type { CardInstance, CardInstanceState } from "./deck";
import type { CastingParams } from "./inputs";
import type { EffectRecord, EffectKind } from "./effects";
import type {
  BehaviorState,
  ChallengeRecord,
  ChallengeStatus,
  FairestOfferRecord,
  FairestOfferStatus,
  AwardRecord,
  ClaimRow,
  PlayRow,
  InventoryFollowUp,
} from "./behaviorState";

// Re-export the behavior-state vocabulary so callers have a single import for
// the loaded-snapshot types alongside the persistence helpers (design.md 15).
export type {
  BehaviorState,
  ChallengeRecord,
  ChallengeStatus,
  FairestOfferRecord,
  FairestOfferStatus,
  AwardRecord,
  ClaimRow,
  PlayRow,
  EffectRecord,
  EffectKind,
} from "./behaviorState";

// ---------------------------------------------------------------------------
// Write vocabulary (design.md section 15).
// ---------------------------------------------------------------------------

/**
 * One row to append to the score ledger. `category` is the ledger category the
 * entry belongs to; `sourceClaimId` / `sourceEffectId` attribute the entry to
 * the claim or effect that produced it (a card-driven bonus names its effect so
 * the projection can reconcile and reverse it). `metadata` is merged into the
 * row's jsonb column.
 */
export interface LedgerWrite {
  readonly teamId: string;
  readonly barId: string | null;
  readonly category: LedgerCategory;
  readonly points: number;
  readonly sourceClaimId?: string | null;
  readonly sourceEffectId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A persisted `score_ledger_entries` row in the shape callers embed in events. */
export interface ScoreEntryRecord {
  readonly entryId: string;
  readonly teamId: string;
  readonly barId: string | null;
  readonly category: LedgerCategory;
  readonly points: number;
  readonly sourceClaimId: string | null;
  readonly sourceEffectId: string | null;
}

/**
 * Per-bar allocation overrides applied by {@link reconcileBarsInTx}. `phantom`
 * names the bar keys that currently carry an active Party Crasher phantom share;
 * `protectedFloors` maps a bar key to the per-team Insurance floors attached to
 * it. Both default to empty, so a plain reconcile with no overrides reproduces
 * the ordinary equal split.
 */
export interface AllocationOverrides {
  /** Bar keys with an active Party Crasher phantom share. */
  readonly phantom?: ReadonlySet<string>;
  /** Bar key -> (team id -> protected floor points) from attached Insurance. */
  readonly protectedFloors?: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

// ---------------------------------------------------------------------------
// Load SQL.
// ---------------------------------------------------------------------------

const GAME_SQL = `
select lifecycle, admin_session_id, start_bar_id, finish_bar_id
from games
where id = $1
`;

const TEAMS_SQL = `
select t.id as team_id,
       t.name as name,
       coalesce(
         array_agg(p.session_id order by p.created_at, p.id)
           filter (where p.session_id is not null),
         '{}'
       ) as member_session_ids
from teams t
left join players p on p.team_id = t.id and p.game_id = t.game_id
where t.game_id = $1
group by t.id, t.name
order by t.created_at, t.id
`;

const BARS_SQL = `
select id, name, location
from bars
where game_id = $1
`;

const CLAIMS_SQL = `
select c.id as claim_id,
       c.team_id,
       c.bar_id,
       b.name as bar_name,
       c.claimed_at,
       c.revoked_at,
       c.revoked_reason
from claims c
join bars b on b.id = c.bar_id and b.game_id = c.game_id
where c.game_id = $1
order by c.claimed_at, c.id
`;

const INSTANCES_SQL = `
select ci.owner_team_id,
       cd.slug,
       ci.deck_state,
       ci.draw_position
from card_instances ci
join card_definitions cd on cd.id = ci.definition_id
where ci.game_id = $1
order by ci.owner_team_id, ci.draw_position
`;

const PLAYS_SQL = `
select cp.id as play_id,
       cp.slug,
       cp.casting_team_id as caster_team_id,
       cp.target_team_id,
       cp.target_bar_id,
       cp.target_bar_key,
       cp.params,
       cp.played_at as created_at
from card_plays cp
where cp.game_id = $1
order by cp.played_at, cp.id
`;

const CHALLENGES_SQL = `
select id,
       slug,
       source_play_id,
       caster_team_id,
       target_team_id,
       params,
       mirrored_from_challenge_id,
       mirrored_from_play_id,
       status,
       created_at,
       resolved_at,
       resolved_by_team_id,
       resolved_by_session_id,
       resolved_by_kind,
       failure_effect_id
from card_challenges
where game_id = $1
order by created_at, id
`;

const OFFERS_SQL = `
select id,
       source_play_id,
       slug,
       holder_team_id,
       original_caster_team_id,
       challenge_id,
       restriction_effect_id,
       status,
       decided_at,
       mirrored_challenge_id,
       mirrored_effect_id
from fairest_offers
where game_id = $1
order by created_at, id
`;

const EFFECTS_SQL = `
select e.id,
       e.slug,
       e.kind,
       e.source_play_id,
       e.source_challenge_id,
       e.owner_team_id,
       e.target_team_id,
       e.target_bar_id,
       e.target_bar_key,
       e.starts_at,
       e.ends_at,
       e.params,
       e.attached_claim_id,
       e.attached_bar_id,
       ab.name as attached_bar_name,
       e.protected_points,
       e.consumed_at,
       e.cancelled_at,
       e.cancel_reason,
       e.start_announced_at,
       e.end_announced_at
from card_effects e
left join bars ab on ab.id = e.attached_bar_id and ab.game_id = e.game_id
where e.game_id = $1
order by e.created_at, e.id
`;

const AWARDS_SQL = `
select id,
       effect_id,
       team_id,
       kind,
       claim_id,
       ledger_entry_id,
       reversed_at,
       reversal_ledger_entry_id,
       created_at
from card_effect_awards
where game_id = $1
order by created_at, id
`;

const LEDGER_SQL = `
select id, team_id, bar_id, category, points, source_claim_id, source_effect_id
from score_ledger_entries
where game_id = $1
order by created_at, id
`;

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function str(value: unknown): string {
  return String(value);
}

function strOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** A Postgres text[] column comes back as an array; tolerate a brace string. */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    const trimmed = value.replace(/^\{|\}$/g, "").trim();
    if (trimmed.length === 0) return [];
    return trimmed.split(",").map((v) => v.replace(/^"|"$/g, ""));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Load.
// ---------------------------------------------------------------------------

/**
 * Assemble the loaded {@link BehaviorState} snapshot every pure planner takes,
 * inside the caller's transaction (design.md section 15). Called at pipeline
 * step 4, after the lazy Timer_Sweep has settled, so the effect announcement
 * flags reflect the current window state.
 *
 * All slices are read for the whole game; the planners filter by team/bar as
 * needed. `nowIso` is the server time read after the game lock, stored verbatim
 * on the snapshot so every window decision uses the same instant.
 *
 * @param tx a query runner bound to the caller's open transaction.
 * @param gameId the game to load.
 * @param nowIso the server time (ISO) the plan will be evaluated at.
 */
export async function loadBehaviorState(
  tx: QueryRunner,
  gameId: string,
  nowIso: string,
): Promise<BehaviorState> {
  const { rows: gameRows } = await tx.query(GAME_SQL, [gameId]);
  const gameRow = gameRows[0];
  if (gameRow === undefined) {
    throw new Error(`loadBehaviorState: game ${gameId} not found`);
  }

  const lifecycle = gameRow.lifecycle as BehaviorState["lifecycle"];
  const hostSessionId = str(gameRow.admin_session_id);
  const startBarId = strOrNull(gameRow.start_bar_id);
  const finishBarId = strOrNull(gameRow.finish_bar_id);

  // Bars: resolve every persisted bar through the shared resolver so each one
  // carries the same board-facing key, coordinates, and kind the planners read.
  const { rows: barRows } = await tx.query(BARS_SQL, [gameId]);
  const bars = new Map<string, ResolvedBar>();
  const barKeyById = new Map<string, string>();
  for (const row of barRows) {
    const resolved = await resolveGameBar(tx, gameId, str(row.id));
    if (resolved !== null) {
      bars.set(resolved.barKey, resolved);
      barKeyById.set(resolved.barId, resolved.barKey);
    }
  }
  const startBarKey =
    startBarId === null ? null : (barKeyById.get(startBarId) ?? null);
  const finishBarKey =
    finishBarId === null ? null : (barKeyById.get(finishBarId) ?? null);

  // Teams and their member sessions.
  const { rows: teamRows } = await tx.query(TEAMS_SQL, [gameId]);
  const teams = teamRows.map((row) => ({
    teamId: str(row.team_id),
    name: str(row.name),
    memberSessionIds: asStringArray(row.member_session_ids),
  }));

  // Claims: split into the currently active set and the full history.
  const { rows: claimRows } = await tx.query(CLAIMS_SQL, [gameId]);
  const claimHistory: ClaimRow[] = claimRows.map((row) => {
    const barId = str(row.bar_id);
    return {
      claimId: str(row.claim_id),
      teamId: str(row.team_id),
      barId,
      barKey: barKeyById.get(barId) ?? barId,
      claimedAt: iso(row.claimed_at),
      revokedReason: (row.revoked_reason ?? null) as ClaimRow["revokedReason"],
    };
  });
  const activeClaims = claimHistory.filter(
    (_, idx) => claimRows[idx].revoked_at == null,
  );

  // Hands: group persisted instances by team into hand + pending.
  const { rows: instanceRows } = await tx.query(INSTANCES_SQL, [gameId]);
  const hands = new Map<
    string,
    { hand: readonly CardInstance[]; pending: readonly CardInstance[] }
  >();
  const handBuilders = new Map<
    string,
    { hand: CardInstance[]; pending: CardInstance[] }
  >();
  for (const row of instanceRows) {
    const teamId = str(row.owner_team_id);
    const deckState = (row.deck_state ?? "deck") as CardInstanceState;
    if (deckState !== "hand" && deckState !== "pending") continue;
    let builder = handBuilders.get(teamId);
    if (builder === undefined) {
      builder = { hand: [], pending: [] };
      handBuilders.set(teamId, builder);
    }
    const slug = str(row.slug) as CardSlug;
    const card: CardInstance = {
      id: `${teamId}:${slug}`,
      slug,
      state: deckState,
      position: row.draw_position == null ? 0 : Number(row.draw_position),
    };
    if (deckState === "hand") builder.hand.push(card);
    else builder.pending.push(card);
  }
  for (const [teamId, builder] of handBuilders) {
    hands.set(teamId, { hand: builder.hand, pending: builder.pending });
  }

  // Plays, challenges, offers, effects, awards, ledger.
  const { rows: playRows } = await tx.query(PLAYS_SQL, [gameId]);
  const plays: PlayRow[] = playRows.map(readPlayRow);

  const { rows: challengeRows } = await tx.query(CHALLENGES_SQL, [gameId]);
  const challenges: ChallengeRecord[] = challengeRows.map(readChallengeRow);

  const { rows: offerRows } = await tx.query(OFFERS_SQL, [gameId]);
  const offers: FairestOfferRecord[] = offerRows.map(readOfferRow);

  const { rows: effectRows } = await tx.query(EFFECTS_SQL, [gameId]);
  const effects: EffectRecord[] = effectRows.map((row) =>
    readEffectRow(row, barKeyById),
  );

  const { rows: awardRows } = await tx.query(AWARDS_SQL, [gameId]);
  const awards: AwardRecord[] = awardRows.map(readAwardRow);

  const { rows: ledgerRows } = await tx.query(LEDGER_SQL, [gameId]);
  const ledger: LedgerEntry[] = ledgerRows.map((row) => ({
    teamId: str(row.team_id),
    barId: strOrNull(row.bar_id) ?? "",
    category: str(row.category) as LedgerCategory,
    points: Number(row.points),
  }));

  return {
    gameId,
    lifecycle,
    nowIso,
    teams,
    hostSessionId,
    bars,
    startBarKey,
    finishBarKey,
    activeClaims,
    claimHistory,
    hands,
    plays,
    challenges,
    offers,
    effects,
    awards,
    ledger,
  };
}

function readPlayRow(row: Record<string, unknown>): PlayRow {
  return {
    playId: str(row.play_id),
    slug: str(row.slug) as CardSlug,
    casterTeamId: str(row.caster_team_id),
    targetTeamId: strOrNull(row.target_team_id),
    targetBarId: strOrNull(row.target_bar_id),
    targetBarKey: strOrNull(row.target_bar_key),
    params: asObject(row.params) as CastingParams,
    createdAt: iso(row.created_at),
  };
}

function readChallengeRow(row: Record<string, unknown>): ChallengeRecord {
  return {
    challengeId: str(row.id),
    slug: str(row.slug) as CardSlug,
    sourcePlayId: str(row.source_play_id),
    casterTeamId: str(row.caster_team_id),
    targetTeamId: str(row.target_team_id),
    params: asObject(row.params) as CastingParams,
    mirroredFromChallengeId: strOrNull(row.mirrored_from_challenge_id),
    mirroredFromPlayId: strOrNull(row.mirrored_from_play_id),
    status: str(row.status) as ChallengeStatus,
    createdAt: iso(row.created_at),
    resolvedAt: isoOrNull(row.resolved_at),
    resolvedByTeamId: strOrNull(row.resolved_by_team_id),
    resolvedBySessionId: strOrNull(row.resolved_by_session_id),
    resolvedByKind: (row.resolved_by_kind ??
      null) as ChallengeRecord["resolvedByKind"],
    failureEffectId: strOrNull(row.failure_effect_id),
  };
}

function readOfferRow(row: Record<string, unknown>): FairestOfferRecord {
  return {
    offerId: str(row.id),
    sourcePlayId: str(row.source_play_id),
    slug: str(row.slug) as CardSlug,
    holderTeamId: str(row.holder_team_id),
    originalCasterTeamId: str(row.original_caster_team_id),
    challengeId: strOrNull(row.challenge_id),
    restrictionEffectId: strOrNull(row.restriction_effect_id),
    status: str(row.status) as FairestOfferStatus,
    decidedAt: isoOrNull(row.decided_at),
    mirroredChallengeId: strOrNull(row.mirrored_challenge_id),
    mirroredEffectId: strOrNull(row.mirrored_effect_id),
  };
}

function readEffectRow(
  row: Record<string, unknown>,
  barKeyById: ReadonlyMap<string, string>,
): EffectRecord {
  const attachedBarId = strOrNull(row.attached_bar_id);
  const attachedBarKey =
    attachedBarId === null ? null : (barKeyById.get(attachedBarId) ?? null);
  return {
    effectId: str(row.id),
    slug: str(row.slug) as CardSlug,
    kind: str(row.kind) as EffectKind,
    sourcePlayId: strOrNull(row.source_play_id),
    sourceChallengeId: strOrNull(row.source_challenge_id),
    ownerTeamId: strOrNull(row.owner_team_id),
    targetTeamId: strOrNull(row.target_team_id),
    targetBarKey: strOrNull(row.target_bar_key),
    startsAt: iso(row.starts_at),
    endsAt: isoOrNull(row.ends_at),
    params: asObject(row.params),
    attachedClaimId: strOrNull(row.attached_claim_id),
    attachedBarKey,
    protectedPoints:
      row.protected_points == null ? null : Number(row.protected_points),
    consumedAt: isoOrNull(row.consumed_at),
    cancelledAt: isoOrNull(row.cancelled_at),
    cancelReason: (row.cancel_reason ?? null) as EffectRecord["cancelReason"],
    startAnnounced: row.start_announced_at != null,
    endAnnounced: row.end_announced_at != null,
  };
}

function readAwardRow(row: Record<string, unknown>): AwardRecord {
  return {
    awardId: str(row.id),
    effectId: str(row.effect_id),
    teamId: str(row.team_id),
    kind: str(row.kind) as AwardRecord["kind"],
    claimId: strOrNull(row.claim_id),
    ledgerEntryId: str(row.ledger_entry_id),
    reversedAt: isoOrNull(row.reversed_at),
    reversalLedgerEntryId: strOrNull(row.reversal_ledger_entry_id),
    createdAt: iso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Write: challenges.
// ---------------------------------------------------------------------------

const UPSERT_CHALLENGE_SQL = `
insert into card_challenges
  (id, game_id, source_play_id, slug, caster_team_id, target_team_id, params,
   mirrored_from_challenge_id, mirrored_from_play_id, status, created_at,
   resolved_at, resolved_by_kind, resolved_by_team_id, resolved_by_session_id,
   failure_effect_id)
values
  ($1, $2, $3, $4, $5, $6, $7::text::jsonb,
   $8, $9, $10, $11::timestamptz,
   $12::timestamptz, $13, $14, $15,
   $16)
on conflict (id) do update
  set status = excluded.status,
      params = excluded.params,
      resolved_at = excluded.resolved_at,
      resolved_by_kind = excluded.resolved_by_kind,
      resolved_by_team_id = excluded.resolved_by_team_id,
      resolved_by_session_id = excluded.resolved_by_session_id,
      failure_effect_id = excluded.failure_effect_id
`;

/**
 * Persist challenge rows idempotently (design.md section 15). Each row is
 * inserted on first write and its resolution fields updated on re-run, so a
 * plan applied twice in a transaction converges to the same state. `gameId` is
 * taken from the challenge's source via the caller; here it is carried on the
 * row, so the write reads it from the record itself.
 */
export async function writeChallenges(
  tx: QueryRunner,
  gameId: string,
  rows: readonly ChallengeRecord[],
): Promise<void> {
  for (const r of rows) {
    await tx.query(UPSERT_CHALLENGE_SQL, [
      r.challengeId,
      gameId,
      r.sourcePlayId,
      r.slug,
      r.casterTeamId,
      r.targetTeamId,
      JSON.stringify(r.params ?? {}),
      r.mirroredFromChallengeId,
      r.mirroredFromPlayId,
      r.status,
      r.createdAt,
      r.resolvedAt,
      r.resolvedByKind,
      r.resolvedByTeamId,
      r.resolvedBySessionId,
      r.failureEffectId,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Write: offers.
// ---------------------------------------------------------------------------

const UPSERT_OFFER_SQL = `
insert into fairest_offers
  (id, game_id, source_play_id, slug, holder_team_id, original_caster_team_id,
   challenge_id, restriction_effect_id, status, created_at,
   decided_at, mirrored_challenge_id, mirrored_effect_id)
values
  ($1, $2, $3, $4, $5, $6,
   $7, $8, $9, $10::timestamptz,
   $11::timestamptz, $12, $13)
on conflict (id) do update
  set status = excluded.status,
      decided_at = excluded.decided_at,
      mirrored_challenge_id = excluded.mirrored_challenge_id,
      mirrored_effect_id = excluded.mirrored_effect_id
`;

/**
 * Persist Fairest-of-Them-All offer rows idempotently (design.md section 15).
 * The decision fields (status, mirrored subject) are updated on re-run; the
 * subject columns (`challenge_id` / `restriction_effect_id`) are fixed at
 * creation and never change. `createdAt` falls back to `decidedAt` or the
 * current instant when the record carries no explicit creation time.
 */
export async function writeOffers(
  tx: QueryRunner,
  gameId: string,
  rows: readonly FairestOfferRecord[],
): Promise<void> {
  const nowIso = new Date().toISOString();
  for (const r of rows) {
    await tx.query(UPSERT_OFFER_SQL, [
      r.offerId,
      gameId,
      r.sourcePlayId,
      r.slug,
      r.holderTeamId,
      r.originalCasterTeamId,
      r.challengeId,
      r.restrictionEffectId,
      r.status,
      r.decidedAt ?? nowIso,
      r.decidedAt,
      r.mirroredChallengeId,
      r.mirroredEffectId,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Write: inventory follow-up (UIOLI completion + Fairest offer voids).
// ---------------------------------------------------------------------------

/**
 * Complete a Use It or Lose It challenge as `resolvedByKind: "system"`. The
 * update is scoped to an `open` row so a re-run (or a race that already resolved
 * it another way) is a no-op, keeping the whole transition idempotent.
 * Positional parameters: $1 challengeId, $2 gameId.
 */
const COMPLETE_UIOLI_CHALLENGE_SQL = `
update card_challenges
set status = 'completed', resolved_at = now(), resolved_by_kind = 'system'
where id = $1 and game_id = $2 and status = 'open'
`;

/**
 * Void a pending Fairest offer (the holder no longer holds Fairest of Them All).
 * Scoped to a `pending` row so a re-run is a no-op. $1 offerId, $2 gameId.
 */
const VOID_FAIREST_OFFER_SQL = `
update fairest_offers
set status = 'void', decided_at = now()
where id = $1 and game_id = $2 and status = 'pending'
`;

/**
 * Apply an {@link InventoryFollowUp} in the caller's transaction: complete each
 * open UIOLI challenge and void each pending Fairest offer it names (design.md
 * sections 7 and 15; Requirements 8.5, 9.12). This is the durable counterpart to
 * {@link followUpPayload}, which only carries the ids on the event — without it
 * the `card_challenges` row stays `open` and the claim gate
 * (`evaluateClaimBlocks`) keeps blocking claims after the team's hand empties.
 * Each statement is status-scoped, so applying the same follow-up twice is a
 * no-op.
 */
export async function applyInventoryFollowUp(
  tx: QueryRunner,
  gameId: string,
  followUp: InventoryFollowUp | undefined,
): Promise<void> {
  if (followUp === undefined) {
    return;
  }
  for (const challengeId of followUp.completeChallenges) {
    await tx.query(COMPLETE_UIOLI_CHALLENGE_SQL, [challengeId, gameId]);
  }
  for (const offerId of followUp.voidOffers) {
    await tx.query(VOID_FAIREST_OFFER_SQL, [offerId, gameId]);
  }
}

// ---------------------------------------------------------------------------
// Write: effects.
// ---------------------------------------------------------------------------

const UPSERT_EFFECT_SQL = `
insert into card_effects
  (id, game_id, source_play_id, source_challenge_id, slug, kind,
   owner_team_id, target_team_id, target_bar_id, target_bar_key,
   starts_at, ends_at, params, attached_claim_id, attached_bar_id,
   protected_points, consumed_at, consumed_by_claim_id, cancelled_at,
   cancel_reason, start_announced_at, end_announced_at, created_at)
values
  ($1, $2, $3, $4, $5, $6,
   $7, $8, $9, $10,
   $11::timestamptz, $12::timestamptz, $13::text::jsonb, $14, $15,
   $16, $17::timestamptz, $18, $19::timestamptz,
   $20, $21::timestamptz, $22::timestamptz, statement_timestamp())
on conflict (id) do update
  set ends_at = excluded.ends_at,
      params = excluded.params,
      attached_claim_id = excluded.attached_claim_id,
      attached_bar_id = excluded.attached_bar_id,
      protected_points = excluded.protected_points,
      consumed_at = excluded.consumed_at,
      consumed_by_claim_id = excluded.consumed_by_claim_id,
      cancelled_at = excluded.cancelled_at,
      cancel_reason = excluded.cancel_reason,
      start_announced_at = excluded.start_announced_at,
      end_announced_at = excluded.end_announced_at
`;

/**
 * Persist effect rows idempotently (design.md section 15, Requirement 20.1).
 *
 * An effect that starts immediately (its `startAnnounced` flag is already set
 * on the record, i.e. the planner marked it as needing no delayed activation
 * toast) is inserted with `start_announced_at = created_at`, so the Timer_Sweep
 * only ever announces a delayed activation (Cancel Culture's `radius_lock`).
 * Lifecycle fields (end/consume/cancel + announcement flags) are updated on
 * re-run so a plan applied twice converges.
 *
 * Effects carry a board-facing `targetBarKey` / `attachedBarKey`; the bar FK
 * columns are resolved from the state's bar map so the row's `target_bar_id` /
 * `attached_bar_id` stay consistent with the key.
 */
export async function writeEffects(
  tx: QueryRunner,
  gameId: string,
  rows: readonly EffectRecord[],
  bars: ReadonlyMap<string, ResolvedBar>,
): Promise<void> {
  // `created_at` is stamped by the database clock in UPSERT_EFFECT_SQL, matching
  // the server timestamps on claims and challenges in the same transaction. This
  // app-clock instant is only the announcement fallback for a record that
  // carries no explicit start/end time.
  const createdAt = new Date().toISOString();
  for (const r of rows) {
    const targetBarId =
      r.targetBarKey === null
        ? null
        : (bars.get(r.targetBarKey)?.barId ?? null);
    const attachedBarId =
      r.attachedBarKey === null
        ? null
        : (bars.get(r.attachedBarKey)?.barId ?? null);
    // An immediate-start effect is stamped announced at creation; a delayed one
    // (startAnnounced false, in practice only Cancel Culture) is left null for
    // the Timer_Sweep to announce when its start boundary is due (20.1).
    const startAnnouncedAt = r.startAnnounced
      ? (r.startsAt ?? createdAt)
      : null;
    const endAnnouncedAt = r.endAnnounced ? (r.endsAt ?? createdAt) : null;
    await tx.query(UPSERT_EFFECT_SQL, [
      r.effectId,
      gameId,
      r.sourcePlayId,
      r.sourceChallengeId,
      r.slug,
      r.kind,
      r.ownerTeamId,
      r.targetTeamId,
      targetBarId,
      r.targetBarKey,
      r.startsAt,
      r.endsAt,
      JSON.stringify(r.params ?? {}),
      r.attachedClaimId,
      attachedBarId,
      r.protectedPoints,
      r.consumedAt,
      r.consumedAt === null ? null : (r.attachedClaimId ?? null),
      r.cancelledAt,
      r.cancelReason,
      startAnnouncedAt,
      endAnnouncedAt,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Append ledger.
// ---------------------------------------------------------------------------

const INSERT_LEDGER_SQL = `
insert into score_ledger_entries
  (game_id, team_id, bar_id, source_claim_id, source_effect_id, category, points, metadata)
values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb)
returning id
`;

/**
 * Append score-ledger entries, attributing each to its source claim and/or
 * effect (design.md section 15). Card-driven entries name their
 * `source_effect_id` so the projection can reconcile and reverse them; share
 * entries name the `source_claim_id`. Returns the persisted rows in the shape
 * callers embed in their `scoreEntries` event payload.
 *
 * Ledger entries have server-generated ids (no `on conflict` key to match), so
 * this helper is not idempotent on its own — callers compute the minimal set of
 * adjustments (see {@link reconcileBarsInTx}) before appending.
 */
export async function appendLedger(
  tx: QueryRunner,
  gameId: string,
  adjustments: readonly LedgerWrite[],
): Promise<ScoreEntryRecord[]> {
  const records: ScoreEntryRecord[] = [];
  for (const a of adjustments) {
    const metadata = {
      ...(a.sourceClaimId != null ? { sourceClaimId: a.sourceClaimId } : {}),
      ...(a.sourceEffectId != null ? { sourceEffectId: a.sourceEffectId } : {}),
      ...(a.metadata ?? {}),
    };
    const { rows } = await tx.query(INSERT_LEDGER_SQL, [
      gameId,
      a.teamId,
      a.barId,
      a.sourceClaimId ?? null,
      a.sourceEffectId ?? null,
      a.category,
      a.points,
      JSON.stringify(metadata),
    ]);
    records.push({
      entryId: str(rows[0]?.id),
      teamId: a.teamId,
      barId: a.barId,
      category: a.category,
      points: a.points,
      sourceClaimId: a.sourceClaimId ?? null,
      sourceEffectId: a.sourceEffectId ?? null,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Reconcile bars.
// ---------------------------------------------------------------------------

function scoringKindOf(
  barKey: string,
  state: BehaviorState,
): ClaimScoringBarKind {
  if (state.startBarKey === barKey) return "start";
  if (state.finishBarKey === barKey) return "finish";
  return "scoring";
}

/**
 * Re-derive the target share allocation for each named bar and append the
 * minimal signed ledger diff that moves the current holdings to the target
 * (design.md section 15).
 *
 * For each bar key, the active claimant team ids are read from the loaded
 * `activeClaims`, the Party Crasher phantom and the per-team Insurance floors
 * come from `overrides`, and `computeBarAllocation` + `reconcileBar` produce the
 * diff against `currentBarHoldings`. Only nonzero diffs are appended, each as a
 * `bar_share` / `bar_share_correction` entry attributed to the claiming team's
 * active claim on the bar. Immutable award entries are never touched.
 *
 * @returns the persisted ledger entries, in the order they were appended.
 */
export async function reconcileBarsInTx(
  tx: QueryRunner,
  state: BehaviorState,
  barKeys: readonly string[],
  overrides: AllocationOverrides,
): Promise<ScoreEntryRecord[]> {
  const phantom = overrides.phantom ?? new Set<string>();
  const floorsByBar =
    overrides.protectedFloors ?? new Map<string, ReadonlyMap<string, number>>();

  const writes: LedgerWrite[] = [];

  for (const barKey of barKeys) {
    const resolved = state.bars.get(barKey);
    const barId = resolved?.barId ?? barKey;
    const barKind = scoringKindOf(barKey, state);

    // Active claimants of this bar, keyed by claim so the ledger entry can be
    // attributed to the team's live claim.
    const claimsOnBar = state.activeClaims.filter(
      (c) => c.barKey === barKey || c.barId === barId,
    );
    const claimantTeamIds = [...new Set(claimsOnBar.map((c) => c.teamId))];
    const claimIdByTeam = new Map<string, string>();
    for (const claim of claimsOnBar) {
      if (!claimIdByTeam.has(claim.teamId)) {
        claimIdByTeam.set(claim.teamId, claim.claimId);
      }
    }

    const protectedFloors =
      floorsByBar.get(barKey) ?? new Map<string, number>();

    const target = computeBarAllocation({
      barKind,
      claimantTeamIds,
      phantom: phantom.has(barKey),
      protectedFloors,
    });

    const holdings = currentBarHoldings(state.ledger, barId);
    const priorTeams = new Set(holdings.keys());
    const adjustments = reconcileBar(
      holdings,
      target,
      (teamId) => !priorTeams.has(teamId),
    );

    for (const adj of adjustments) {
      writes.push({
        teamId: adj.teamId,
        barId,
        category: adj.category,
        points: adj.points,
        sourceClaimId: claimIdByTeam.get(adj.teamId) ?? null,
      });
    }
  }

  return appendLedger(tx, state.gameId, writes);
}

// ---------------------------------------------------------------------------
// End-of-game effect cancellation.
// ---------------------------------------------------------------------------

const END_GAME_EFFECTS_SQL = `
update card_effects
set cancelled_at = now(), cancel_reason = 'game_ended'
where game_id = $1
  and cancelled_at is null
  and consumed_at is null
`;

/**
 * Cancel every live (not yet consumed or cancelled) effect for a game with
 * `cancel_reason = 'game_ended'` (design.md section 15, Requirement 20.6). The
 * finish-bar claim and the auto-timeout sweep call this before the single
 * `game_ended` append so no timed window outlives the game. A cancelled window
 * produces no end toast, matching the Boundary_Toast rules in `effects.ts`.
 */
export async function endGameEffects(
  tx: QueryRunner,
  gameId: string,
): Promise<void> {
  await tx.query(END_GAME_EFFECTS_SQL, [gameId]);
}

// ---------------------------------------------------------------------------
// Lazy timer settlement (design.md "Mutation pipeline" step 3).
// ---------------------------------------------------------------------------

/** SQL that runs the idempotent settle function for one game, at the mutation's
 * own `now`. `p_wait = true` because the caller already holds the game lock
 * (the function's `for update` re-lock is a re-entrant no-op), and `p_now`
 * pins settlement to the same instant the plan is evaluated at, so every
 * boundary at or before `now` is announced with its transition events ordered
 * before the mutation's own events. The function returns the number of
 * transition events it appended. */
const SETTLE_DUE_TRANSITIONS_SQL = `
select bbb_settle_card_effects($1, true, $2::timestamptz) as appended
`;

/** SQL that reads the highest `seq` among the game's transition events
 * (`effect_activated` / `effect_expired`). After the settle this is the seq of
 * the last transition event the settle may have appended; it is `null` when the
 * game has no transition events at all. */
const LAST_TRANSITION_SEQ_SQL = `
select max(seq) as last_seq
from game_events
where game_id = $1
  and event_type in ('effect_activated', 'effect_expired')
`;

/** The outcome of a lazy settle: how many transition events were appended by
 * this call, and the seq of the last transition event in the game's log (or
 * `null` when the game has none). */
export interface SettleOutcome {
  /** Number of `effect_activated` / `effect_expired` events this call appended. */
  readonly appended: number;
  /** The highest seq among the game's transition events, or `null` if none. */
  readonly lastTransitionSeq: number | null;
}

/**
 * Run the lazy Timer_Sweep inside the caller's mutation transaction (design.md
 * "Mutation pipeline" step 3; Requirements 19.5, 19.9, 19.10, 20.3b, 20.3c,
 * 20.4).
 *
 * This is pipeline step 3: it runs after the route has authorized (locking the
 * `games` row `for update`) and read `clock_timestamp()` as `nowIso`, and before
 * {@link loadBehaviorState}, so the loaded snapshot already reflects the
 * announcement flags this settle flips. It calls
 * `bbb_settle_card_effects(gameId, true, now)`:
 *
 *   - `p_wait = true` because the caller already holds the game lock, so the
 *     function's re-lock is a re-entrant no-op (never `skip locked`).
 *   - `p_now = nowIso` pins settlement to the mutation's own instant, so any
 *     boundary at or before `now` is announced and its transition events are
 *     ordered before the mutation's own events (20.3b). The function is a no-op
 *     for a game that is not live, so a non-live mutation settles nothing.
 *
 * The transition events this appends (`effect_activated` / `effect_expired`) are
 * excluded from a route's exactly-one mutation-event count and from its "write
 * nothing" rejection guarantee (19.10): a rejected mutation still commits these
 * transition events and their flag flips, while a thrown error rolls them back
 * together with the mutation's domain rows (the next settle re-derives them).
 *
 * @param tx a query runner bound to the caller's open mutation transaction.
 * @param gameId the game being mutated (already locked by the caller).
 * @param nowIso the server time (ISO) read after the lock, shared with the plan.
 * @returns the {@link SettleOutcome}: the appended count and the last transition
 *   seq (so the caller can distinguish transition seqs from mutation seqs).
 */
export async function settleDueTransitions(
  tx: QueryRunner,
  gameId: string,
  nowIso: string,
): Promise<SettleOutcome> {
  const { rows: settleRows } = await tx.query(SETTLE_DUE_TRANSITIONS_SQL, [
    gameId,
    nowIso,
  ]);
  const appended = Number(settleRows[0]?.appended ?? 0);

  const { rows: seqRows } = await tx.query(LAST_TRANSITION_SEQ_SQL, [gameId]);
  const lastSeq = seqRows[0]?.last_seq;
  const lastTransitionSeq = lastSeq == null ? null : Number(lastSeq);

  return { appended, lastTransitionSeq };
}
