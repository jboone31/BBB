/**
 * Card-play route (card-behavior Task 7.1), reworked onto the Card_Behavior_Mutation
 * pipeline (design.md "Mutation pipeline" and the "Card-play route" row).
 *
 * POST /api/games/{gameId}/cards/play — the requesting team plays a card from its
 * hand. In one transaction it runs the shared pipeline:
 *
 *   1. authorize + lock the game row (`resolveCardActor`), resolving the caster's
 *      team;
 *   2. read `clock_timestamp()` as the server `now` (after the lock, so server
 *      time agrees with lock order);
 *   3. lazily settle due effect transitions (`settleDueTransitions`, pipeline
 *      step 3) at that same `now`, so the loaded snapshot reflects the flipped
 *      announcement flags and every boundary at or before `now` is announced
 *      with its transition events ordered before this mutation's own events;
 *      then materialize the target bar (`resolveGameBar`) when the card targets
 *      a bar, so a candidate bar nobody has claimed yet exists in the snapshot;
 *   4. load the single {@link BehaviorState} snapshot (`loadBehaviorState`);
 *   5. plan the play (`planCardPlay`) — pure, returns a {@link PlayPlan} or a
 *      Stable_Error;
 *   6. a rejection returns here, committing only the step-3 transition events;
 *   7. otherwise write the plan's durable rows — the `card_plays` record, the
 *      caster's deck transition for the played card, challenges, Fairest offers,
 *      effects, claim revocations + released protections (Voted Off), and the
 *      reconciled ledger entries;
 *   8. append the `card_played` mutation event carrying the embedded records,
 *      plus one `claim_removed` event for a Voted Off removal.
 *
 * The response `seq` is the last **mutation** event (never a transition event).
 * Error mapping (design.md): `invalid_card` / `target_ineligible` →
 * `invalid_input`; `not_live` → `conflict`; a card not in hand → `conflict`; a
 * Pioneer/Scenic target with no Legal_Next_Bar → `invalid_input` with
 * `details.reason = "no_legal_next_bar"` and the `rules`. An uncaught error rolls
 * the whole transaction back (domain rows, the mutation event, and the step-3
 * transition events together) and responds `unavailable` (503).
 *
 * Requirements: 4.1, 4.3, 6.4, 6.5, 9.11, 10.10, 18.4, 19.2, 19.7, 19.8, 19.9,
 * 22.2, 22.3, 22.5.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent, type QueryRunner } from "@/lib/events";
import { GAME_BOARD_EVENT_TYPES } from "@/lib/gameboard/events";
import {
  instanceRowId,
  applyDeckRowsOnly,
  followUpPayload,
} from "@/lib/cards/persistence";
import { playCard } from "@/lib/cards/deck";
import {
  loadBehaviorState,
  settleDueTransitions,
  writeChallenges,
  writeOffers,
  writeEffects,
  reconcileBarsInTx,
  applyInventoryFollowUp,
  type BehaviorState,
} from "@/lib/cards/behaviorStore";
import { settleInventoryChange } from "@/lib/cards/challenges";
import type { InventoryFollowUp } from "@/lib/cards/behaviorState";
import {
  planCardPlay,
  type PlayPlan,
  type PlayRequest,
} from "@/lib/cards/playPlan";
import type { StableError } from "@/lib/cards/behaviorState";
import { resolveGameBar } from "@/lib/map/barResolver";

import {
  applied,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

import { resolveCardActor } from "../_shared";

export const runtime = "nodejs";

interface PlayBody {
  /** The held card id to play (engine id `${teamId}:${slug}`). */
  readonly cardId?: unknown;
  /** The target team id, when the card targets a team. */
  readonly targetTeamId?: unknown;
  /** The target bar key, when the card targets a bar. */
  readonly targetBarId?: unknown;
  /** Raw casting input (colors / duration / cuisine), validated by the planner. */
  readonly params?: unknown;
}

type PlayOutcome =
  | { readonly ok: true; readonly seq: number }
  | {
      readonly ok: false;
      readonly reason: LobbyErrorReason;
      readonly details?: unknown;
    };

const CLOCK_NOW_SQL = `select clock_timestamp() as now`;

const INSERT_PLAY_SQL = `
insert into card_plays
  (id, game_id, card_instance_id, casting_team_id, target_team_id, slug,
   target_bar_id, target_bar_key, params)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb)
on conflict (id) do update
  set target_team_id = excluded.target_team_id,
      slug = excluded.slug,
      target_bar_id = excluded.target_bar_id,
      target_bar_key = excluded.target_bar_key,
      params = excluded.params
`;

const REVOKE_CLAIM_VOTED_OFF_SQL = `
update claims
set revoked_at = now(), revoked_reason = 'voted_off'
where id = $1 and game_id = $2 and revoked_at is null
returning id
`;

const RELEASE_PROTECTION_SQL = `
update card_effects
set cancelled_at = now(), cancel_reason = 'protection_released'
where id = $1 and game_id = $2 and cancelled_at is null and consumed_at is null
`;

/** Read a trimmed non-empty string from an unknown body value, else undefined. */
function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Map a planner {@link StableError} onto the structured route reason (design.md
 * error-mapping table). `invalid_card` / `target_ineligible` never originate
 * from the planner (it already speaks the Stable_Error vocabulary), but they are
 * handled here for completeness so any stray engine token collapses to
 * `invalid_input` rather than leaking.
 */
function reasonFor(error: StableError | string): LobbyErrorReason {
  switch (error) {
    case "not_authorized":
    case "invalid_input":
    case "conflict":
    case "blocked":
    case "expired":
    case "already_resolved":
    case "not_found":
    case "unavailable":
      return error;
    // Legacy engine tokens that predate the Stable_Error vocabulary.
    case "invalid_card":
    case "target_ineligible":
      return "invalid_input";
    case "not_live":
      return "conflict";
    default:
      return "invalid_input";
  }
}

/**
 * The `card_plays.id` this play writes. The planner mints its challenge / offer /
 * effect records against a deterministic source-play id; the route must persist
 * the `card_plays` row under that same id so the composite foreign keys resolve.
 * The id is read back from whichever embedded record carries it; a play that
 * produces none (e.g. Voted Off the Island) needs no referencing row, so a fresh
 * deterministic fallback keyed on the stable play identity is used instead.
 */
function sourcePlayIdOf(plan: PlayPlan, fallback: string): string {
  return (
    plan.challenges[0]?.sourcePlayId ??
    plan.offers[0]?.sourcePlayId ??
    plan.effects.find((effect) => effect.sourcePlayId !== null)?.sourcePlayId ??
    fallback
  );
}

/**
 * Write the accepted {@link PlayPlan}'s durable rows and append its events,
 * inside the caller's open mutation transaction. Returns the last **mutation**
 * event's seq (`card_played`, or the trailing `claim_removed` for Voted Off).
 */
async function writePlanAndAppend(
  tx: QueryRunner,
  args: {
    readonly state: BehaviorState;
    readonly gameId: string;
    readonly casterTeamId: string;
    readonly cardId: string;
    readonly plan: PlayPlan;
    readonly req: PlayRequest;
  },
): Promise<PlayOutcome> {
  const { state, gameId, casterTeamId, cardId, plan, req } = args;

  // The deterministic source-play id the planner threaded through its records.
  const fallbackPlayId = instanceRowId(gameId, casterTeamId, plan.slug);
  const sourcePlayId = sourcePlayIdOf(plan, fallbackPlayId);

  // 1. Persist the authoritative card_plays row (slug, targets, params). The
  //    played instance row is the deterministic (game, team, slug) id the deck
  //    persistence upserts, so the FK resolves to the card being played.
  const cardInstanceId = instanceRowId(gameId, casterTeamId, plan.slug);
  const targetBarId =
    plan.targetBar === null
      ? null
      : (state.bars.get(plan.targetBar.barKey)?.barId ?? null);
  await tx.query(INSERT_PLAY_SQL, [
    sourcePlayId,
    gameId,
    cardInstanceId,
    casterTeamId,
    req.targetTeamId ?? null,
    plan.slug,
    targetBarId,
    plan.targetBar?.barKey ?? null,
    JSON.stringify(plan.params ?? { kind: "none" }),
  ]);

  // 2. The caster's deck transition for the played card (removes it from hand).
  //    Row diff only: the changed cards and any inventory follow-up ride on the
  //    single canonical card_played event below, so the play appends one
  //    card_played rather than a separate inventory event plus the canonical one.
  const played = await applyDeckRowsOnly(tx, {
    ctx: { gameId, teamId: casterTeamId },
    kind: "play",
    transition: (deck) => playCard(deck, cardId),
  });
  if (!played.ok) {
    // The planner already validated the card is in hand; a rejection here means
    // the loaded deck disagreed with the snapshot. Surface it as a conflict
    // rather than a partial write (the transaction rolls back).
    return { ok: false, reason: "conflict" };
  }

  // 2b. Inventory follow-up from the play's hand change: playing the last held
  //     card empties the hand, which must complete any open Use It or Lose It
  //     challenge targeting the caster (R8.5) and void a pending Fairest offer
  //     the caster no longer backs (R9.12). The planner's own follow-up is
  //     empty for a play (emptyPlan), so this is where a play-driven completion
  //     is derived. It is applied durably AND embedded on the event below so the
  //     server rows and the board fold agree. The `now` arg is unused by the
  //     settle, so the empty string is a harmless placeholder.
  const followUp: InventoryFollowUp = settleInventoryChange(
    state,
    casterTeamId,
    played.state,
    "",
  );
  await applyInventoryFollowUp(tx, gameId, followUp);

  // 3. Challenges, Fairest offers, effects.
  await writeChallenges(tx, gameId, plan.challenges);
  await writeOffers(tx, gameId, plan.offers);
  await writeEffects(tx, gameId, plan.effects, state.bars);

  // 4. Claim revocations (Voted Off) + released protections.
  const removedClaims: { readonly claimId: string }[] = [];
  for (const revoke of plan.revokeClaims) {
    const { rows } = await tx.query(REVOKE_CLAIM_VOTED_OFF_SQL, [
      revoke.claimId,
      gameId,
    ]);
    if (rows.length === 1) {
      removedClaims.push({ claimId: revoke.claimId });
    }
  }
  for (const effectId of plan.releaseProtections) {
    await tx.query(RELEASE_PROTECTION_SQL, [effectId, gameId]);
  }

  // 5. Reconciled ledger entries (Party Crasher phantom, Voted Off removal).
  //    The reconcile reads active claims from the loaded snapshot; a Voted Off
  //    removal happened in this transaction, so drop the revoked claim from the
  //    snapshot the reconcile sees.
  const reconcileState: BehaviorState =
    removedClaims.length === 0
      ? state
      : {
          ...state,
          activeClaims: state.activeClaims.filter(
            (claim) =>
              !plan.revokeClaims.some(
                (revoke) => revoke.claimId === claim.claimId,
              ),
          ),
        };
  const scoreEntries =
    plan.reconcileBars.length === 0
      ? []
      : await reconcileBarsInTx(tx, reconcileState, plan.reconcileBars, {
          phantom: phantomBarKeys(plan),
        });

  // 6. Append the canonical card_played mutation event with the embedded
  //    records so the projection folds challenges / offers / effects / ledger
  //    without a parallel client source.
  const playEvent = await appendEvent(tx, {
    gameId,
    type: GAME_BOARD_EVENT_TYPES.cardPlayed,
    actor: { kind: "team", teamId: casterTeamId },
    payload: {
      playId: sourcePlayId,
      castingTeamId: casterTeamId,
      teamId: casterTeamId,
      cards: played.records,
      ...followUpPayload(followUp),
      slug: plan.slug,
      targetTeamId: req.targetTeamId ?? null,
      targetBarKey: plan.targetBar?.barKey ?? null,
      // Spin Cycle's resolved return bar (the target's most recent claim / the
      // start bar), so the toast can name it. Null for every other card.
      returnBarKey: plan.returnBarKey,
      params: plan.params,
      challenges: plan.challenges,
      offers: plan.offers,
      effects: plan.effects,
      scoreEntries,
    },
  });
  let lastSeq = playEvent.seq;

  // 7. One claim_removed mutation event for a Voted Off removal (18.4).
  for (const removed of removedClaims) {
    const removedEvent = await appendEvent(tx, {
      gameId,
      type: GAME_BOARD_EVENT_TYPES.claimRemoved,
      actor: { kind: "team", teamId: casterTeamId },
      payload: {
        claimId: removed.claimId,
        barKey: plan.targetBar?.barKey ?? null,
        reason: "voted_off",
      },
    });
    lastSeq = removedEvent.seq;
  }

  return { ok: true, seq: lastSeq };
}

/** The bar keys carrying an active Party Crasher phantom share after this play. */
function phantomBarKeys(plan: PlayPlan): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const effect of plan.effects) {
    if (effect.kind === "phantom_share" && effect.targetBarKey !== null) {
      keys.add(effect.targetBarKey);
    }
  }
  return keys;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  const session = requireSession(request);
  if (!session.ok) {
    return notApplied(session.reason);
  }

  const { gameId: rawGameId } = await context.params;
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : "";
  if (!gameId) {
    return notApplied("not_found");
  }

  let body: PlayBody;
  try {
    body = (await request.json()) as PlayBody;
  } catch {
    return notApplied("invalid_input");
  }
  const cardId = readString(body.cardId);
  if (cardId === undefined) {
    return notApplied("invalid_input");
  }
  const targetTeamId = readString(body.targetTeamId);
  const targetBarKey = readString(body.targetBarId);

  try {
    const outcome = await withTransaction<PlayOutcome>(async (tx) => {
      // Pipeline step 1: authorize + lock the game row, resolving the caster.
      const actor = await resolveCardActor(tx, gameId, session.sessionId);
      if (!actor.ok) {
        // The actor reason is already a structured LobbyErrorReason with the
        // right HTTP status (not_member → 403, not_found → 404, no_team → 403);
        // only `not_live` needs remapping onto the Stable_Error `conflict`.
        return {
          ok: false,
          reason: actor.reason === "not_live" ? "conflict" : actor.reason,
        };
      }
      const casterTeamId = actor.teamId;

      // Pipeline step 2: server time, read after the lock.
      const { rows: clockRows } = await tx.query(CLOCK_NOW_SQL, []);
      const nowRaw = clockRows[0]?.now;
      const nowIso =
        nowRaw instanceof Date
          ? nowRaw.toISOString()
          : new Date(String(nowRaw)).toISOString();

      // Pipeline step 3: lazily settle due effect transitions at this `now`,
      // under the lock the caller already holds, before loading state.
      await settleDueTransitions(tx, gameId, nowIso);

      // Pipeline step 3b: materialize the target bar on first touch. A bar-target
      // card (Happy Hour, Party Crasher, Cancel Culture, Voted Off) may name a
      // candidate bar nobody has claimed yet, so no `bars` row exists. The claim
      // route does the same resolve; without it the bar is absent from
      // `loadBehaviorState`'s snapshot and `planCardPlay` rejects an otherwise
      // legal play with `invalid_input`. `resolveGameBar` only materializes a
      // known candidate key, so an unknown key still misses and the planner
      // rejects it as before.
      if (targetBarKey !== undefined) {
        await resolveGameBar(tx, gameId, targetBarKey);
      }

      // Pipeline step 4: the single loaded snapshot, reflecting the settled flags.
      const state = await loadBehaviorState(tx, gameId, nowIso);

      // Pipeline step 5: plan the play (pure).
      const req: PlayRequest = {
        cardId,
        casterTeamId,
        targetTeamId,
        targetBarKey,
        rawParams: body.params,
      };
      const plan = planCardPlay(state, req, nowIso);

      // Pipeline step 6: a rejection writes no domain rows and no mutation
      // event; the step-3 transition events still commit.
      if (!plan.ok) {
        return {
          ok: false,
          reason: reasonFor(plan.error),
          details: plan.details,
        };
      }

      // Pipeline steps 7-8: write the plan and append its events.
      return writePlanAndAppend(tx, {
        state,
        gameId,
        casterTeamId,
        cardId,
        plan: plan.plan,
        req,
      });
    });

    if (!outcome.ok) {
      return notApplied(outcome.reason, outcome.details);
    }
    return applied(outcome.seq);
  } catch {
    // An uncaught error rolls back the domain rows, the mutation event, and the
    // step-3 transition events together; the next settle re-derives them.
    return notApplied("unavailable");
  }
}
