/**
 * Fairest-of-Them-All decision route (card-behavior Task 7.10), on the
 * Card_Behavior_Mutation pipeline (design.md "Mutation pipeline" and the
 * "Fairest decision route" row).
 *
 * POST /api/games/{gameId}/fairest-offers/{offerId} — the offer's holder decides
 * a pending Fairest offer, playing (mirroring the original challenge/restriction
 * back onto its caster) or declining it. In one transaction it runs the shared
 * pipeline:
 *
 *   1. authorize + lock the game row (`resolveCardActor`), resolving the
 *      requester's team — the planner then enforces holder-only authorization;
 *   2. read `clock_timestamp()` as the server `now` (after the lock, so server
 *      time agrees with lock order);
 *   3. lazily settle due effect transitions (`settleDueTransitions`, pipeline
 *      step 3) at that same `now`, so the loaded snapshot reflects flipped
 *      announcement flags and every boundary at or before `now` is announced
 *      with its transition events ordered before this mutation's own event;
 *   4. load the single {@link BehaviorState} snapshot (`loadBehaviorState`);
 *   5. plan the decision (`decideFairest`) — pure, returns a {@link FairestPlan}
 *      or a Stable_Error;
 *   6. a rejection returns here, committing only the step-3 transition events;
 *   7. otherwise write the plan's durable rows — on a Play, move the holder's
 *      Fairest card from hand to `played` (row diff only, no separate inventory
 *      event), write the decided offer plus every voided offer, and write the
 *      mirrored challenge or the mirrored next-claim-restriction effect; on a
 *      Decline, write the declined offer;
 *   8. append exactly one `fairest_decided` mutation event embedding the moved
 *      Fairest card (`cards`), the mirrored challenge or effect, and every
 *      changed offer, so the fold moves the card and upserts the records without
 *      a parallel client source.
 *
 * Error mapping (design.md): `not_authorized` (not the holder), `already_resolved`
 * (a decided offer), `conflict` (Fairest no longer in hand), `not_found` (no such
 * offer), and — for a Pioneer/Scenic Play whose mirror became illegal at the
 * decision's `now` — `invalid_input` with `details.reason = "no_legal_next_bar"`
 * and the `rules`; nothing is written and the offer stays `pending` so Decline
 * remains available (9.16, 9.17). An uncaught error rolls the whole transaction
 * back (domain rows, the mutation event, and the step-3 transition events
 * together) and responds `unavailable` (503).
 *
 * Requirements: 9.4, 9.5, 9.8, 9.9, 9.13, 9.16, 9.17, 19.6, 19.9, 19.10.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent, type QueryRunner } from "@/lib/events";
import { GAME_BOARD_EVENT_TYPES } from "@/lib/gameboard/events";
import { engineCardId, applyDeckRowsOnly } from "@/lib/cards/persistence";
import { playCard } from "@/lib/cards/deck";
import type { CardSlug } from "@/lib/cards/catalog";
import {
  loadBehaviorState,
  settleDueTransitions,
  writeChallenges,
  writeOffers,
  writeEffects,
  type BehaviorState,
} from "@/lib/cards/behaviorStore";
import { decideFairest, type FairestPlan } from "@/lib/cards/challenges";
import type { StableError } from "@/lib/cards/behaviorState";

import {
  applied,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

import { resolveCardActor } from "../../cards/_shared";

export const runtime = "nodejs";

/** The catalog slug for the card whose hand→played move a Play records. */
const FAIREST_SLUG: CardSlug = "fairest-of-them-all";

interface DecideBody {
  /** The decision: play the Fairest mirror, or decline it. */
  readonly decision?: unknown;
}

type DecideOutcome =
  | { readonly ok: true; readonly seq: number }
  | {
      readonly ok: false;
      readonly reason: LobbyErrorReason;
      readonly details?: unknown;
    };

const CLOCK_NOW_SQL = `select clock_timestamp() as now`;

/**
 * Map a planner {@link StableError} onto the structured route reason. The
 * planner already speaks the Stable_Error vocabulary, which is a subset of
 * {@link LobbyErrorReason}; any stray token collapses to `invalid_input` rather
 * than leaking a 500.
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
    default:
      return "invalid_input";
  }
}

/**
 * Write the accepted {@link FairestPlan}'s durable rows and append its single
 * `fairest_decided` event, inside the caller's open mutation transaction.
 *
 * A Play moves the holder's Fairest card from hand to `played` as a row-only
 * deck diff (no separate inventory event), writes the decided offer, every
 * voided offer, and the mirrored challenge or effect, then embeds the moved card
 * records plus every changed record in the one `fairest_decided` event. A Decline
 * writes only the declined offer and embeds it.
 */
async function writePlanAndAppend(
  tx: QueryRunner,
  args: {
    readonly state: BehaviorState;
    readonly gameId: string;
    readonly plan: FairestPlan;
  },
): Promise<DecideOutcome> {
  const { state, gameId, plan } = args;
  const isPlay = plan.offer.status === "played";

  // 1. The decided offer plus every voided offer (9.13). writeOffers upserts by
  //    id, so a re-run converges.
  const offers = [plan.offer, ...plan.voidOffers];

  // 2. On a Play, move the holder's Fairest card to `played`. Row diff only —
  //    the moved records ride on the single fairest_decided event below, not a
  //    separate card_played, so the fold still sees exactly one mutation event.
  let cardRecords: readonly {
    readonly cardId: string;
    readonly teamId: string;
    readonly slug: string;
    readonly state: string;
  }[] = [];
  if (isPlay) {
    const fairestCardId = engineCardId(plan.offer.holderTeamId, FAIREST_SLUG);
    const moved = await applyDeckRowsOnly(tx, {
      ctx: { gameId, teamId: plan.offer.holderTeamId },
      kind: "play",
      transition: (deck) => playCard(deck, fairestCardId),
    });
    if (!moved.ok) {
      // The planner validated Fairest is in hand; a rejection here means the
      // loaded deck disagreed with the snapshot. Surface it as a conflict
      // rather than a partial write (the transaction rolls back).
      return { ok: false, reason: "conflict" };
    }
    cardRecords = moved.records;
  }

  // 3. Persist the offers and the mirrored subject (exactly one of challenge /
  //    effect on a Play; neither on a Decline).
  await writeOffers(tx, gameId, offers);
  if (plan.mirroredChallenge !== null) {
    await writeChallenges(tx, gameId, [plan.mirroredChallenge]);
  }
  if (plan.mirroredEffect !== null) {
    await writeEffects(tx, gameId, [plan.mirroredEffect], state.bars);
  }

  // 4. Exactly one fairest_decided mutation event: the toast keys on offerId,
  //    applyCardInventoryEvent folds the `cards` section (Fairest → played), and
  //    applyRecordSections upserts the embedded offers / challenge / effect.
  const event = await appendEvent(tx, {
    gameId,
    type: GAME_BOARD_EVENT_TYPES.fairestDecided,
    actor: { kind: "team", teamId: plan.offer.holderTeamId },
    payload: {
      offerId: plan.offer.offerId,
      decision: isPlay ? "play" : "decline",
      holderTeamId: plan.offer.holderTeamId,
      cards: cardRecords,
      offers,
      challenges:
        plan.mirroredChallenge === null ? [] : [plan.mirroredChallenge],
      effects: plan.mirroredEffect === null ? [] : [plan.mirroredEffect],
    },
  });

  return { ok: true, seq: event.seq };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string; offerId: string }> },
): Promise<NextResponse> {
  const session = requireSession(request);
  if (!session.ok) {
    return notApplied(session.reason);
  }

  const { gameId: rawGameId, offerId: rawOfferId } = await context.params;
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : "";
  const offerId = typeof rawOfferId === "string" ? rawOfferId.trim() : "";
  if (!gameId || !offerId) {
    return notApplied("not_found");
  }

  let body: DecideBody;
  try {
    body = (await request.json()) as DecideBody;
  } catch {
    return notApplied("invalid_input");
  }
  const decision =
    body.decision === "play" || body.decision === "decline"
      ? body.decision
      : undefined;
  if (decision === undefined) {
    return notApplied("invalid_input");
  }

  try {
    const outcome = await withTransaction<DecideOutcome>(async (tx) => {
      // Pipeline step 1: authorize + lock the game row, resolving the actor's
      // team. The planner enforces holder-only authorization against this team.
      const actor = await resolveCardActor(tx, gameId, session.sessionId);
      if (!actor.ok) {
        return { ok: false, reason: actor.reason };
      }
      const actorTeamId = actor.teamId;

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

      // Pipeline step 4: the single loaded snapshot, reflecting the settled flags.
      const state = await loadBehaviorState(tx, gameId, nowIso);

      // Pipeline step 5: plan the decision (pure).
      const plan = decideFairest(state, offerId, decision, actorTeamId, nowIso);

      // Pipeline step 6: a rejection writes no domain rows and no mutation
      // event; the step-3 transition events still commit. A Pioneer/Scenic Play
      // whose mirror became illegal lands here with details carrying the rules.
      if (!plan.ok) {
        return {
          ok: false,
          reason: reasonFor(plan.error),
          details: plan.details,
        };
      }

      // Pipeline steps 7-8: write the plan and append its one event.
      return writePlanAndAppend(tx, { state, gameId, plan: plan.plan });
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
