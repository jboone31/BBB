/**
 * Host challenge-override route (card-behavior Task 11.1), on the
 * Card_Behavior_Mutation pipeline (design.md "Mutation pipeline" and the host
 * override row).
 *
 * POST /api/games/{gameId}/host/challenges/{challengeId} — the host clears an
 * open challenge or resets a resolved one. In one transaction it runs the shared
 * pipeline:
 *
 *   1. authorize + lock the game row (`assertAdmin`, which takes the game row's
 *      `FOR UPDATE` lock); a non-admin maps `not_admin` → `not_authorized`
 *      (Requirements 21.7, 21.9);
 *   2. read `clock_timestamp()` as the server `now` (after the lock, so server
 *      time agrees with lock order);
 *   3. lazily settle due effect transitions (`settleDueTransitions`, pipeline
 *      step 3, task 6.7) at that same `now`, so every boundary at or before
 *      `now` is announced with its transition events ordered before this
 *      mutation's own event;
 *   4. load the single {@link BehaviorState} snapshot (`loadBehaviorState`);
 *   5. plan the override (`hostChallengeOverride`) — pure, returns the patched
 *      challenge plus the offer voided by a `clear` and the critic failure
 *      effect cancelled by a `reset`, or a Stable_Error;
 *   6. a rejection returns here, committing only the step-3 transition events
 *      (write nothing besides them; Req 19.10);
 *   7. otherwise write the patched challenge (`writeChallenges`), the voided
 *      offer (`writeOffers`), and the cancelled effect (`writeEffects`);
 *   8. append exactly one `host_override_applied` mutation event embedding the
 *      changed challenge / offer / effect records, so the projection folds the
 *      override without a parallel client source.
 *
 * The response `seq` is the single `host_override_applied` mutation event (never
 * a transition event). Error mapping (design.md): `not_authorized` (not the
 * host), `conflict` (clear of a non-open challenge, reset of a cleared or
 * un-resettable challenge), `invalid_input` (bad body), `not_found` (no such
 * challenge). An uncaught error rolls the whole transaction back (the domain
 * rows, the mutation event, and the step-3 transition events together) and
 * responds `unavailable` (503).
 *
 * Requirements: 21.1, 21.2, 21.3, 21.7, 21.9, 19.9, 19.10.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent } from "@/lib/events";
import { GAME_BOARD_EVENT_TYPES } from "@/lib/gameboard/events";
import {
  loadBehaviorState,
  settleDueTransitions,
  writeChallenges,
  writeEffects,
  writeOffers,
} from "@/lib/cards/behaviorStore";
import { hostChallengeOverride } from "@/lib/cards/challenges";
import type { EffectRecord } from "@/lib/cards/effects";
import type { StableError } from "@/lib/cards/behaviorState";

import {
  applied,
  assertAdmin,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

export const runtime = "nodejs";

interface OverrideBody {
  /** The override action: `clear` an open challenge, or `reset` a resolved one. */
  readonly action?: unknown;
}

type OverrideOutcome =
  | { readonly ok: true; readonly seq: number }
  | {
      readonly ok: false;
      readonly reason: LobbyErrorReason;
      readonly details?: unknown;
    };

const CLOCK_NOW_SQL = `select clock_timestamp() as now`;

/**
 * Map a planner {@link StableError} onto the structured route reason (design.md
 * error-mapping table). The host-override state machine already speaks the
 * Stable_Error vocabulary, so this is an identity for the reasons it emits; any
 * stray token collapses to `invalid_input` rather than leaking.
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
    case "not_live":
      return "conflict";
    default:
      return "invalid_input";
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string; challengeId: string }> },
): Promise<NextResponse> {
  const session = requireSession(request);
  if (!session.ok) {
    return notApplied(session.reason);
  }

  const { gameId: rawGameId, challengeId: rawChallengeId } =
    await context.params;
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : "";
  if (!gameId) {
    return notApplied("not_found");
  }
  const challengeId =
    typeof rawChallengeId === "string" ? rawChallengeId.trim() : "";
  if (!challengeId) {
    return notApplied("not_found");
  }

  let body: OverrideBody;
  try {
    body = (await request.json()) as OverrideBody;
  } catch {
    return notApplied("invalid_input");
  }
  // The body carries the override action: "clear" or "reset".
  if (body.action !== "clear" && body.action !== "reset") {
    return notApplied("invalid_input");
  }
  const action: "clear" | "reset" = body.action;

  try {
    const outcome = await withTransaction<OverrideOutcome>(async (tx) => {
      // Pipeline step 1: authorize + lock the game row (`FOR UPDATE`). A
      // non-admin maps not_admin → not_authorized; a missing game collapses to
      // not_found (both without leaking existence).
      const admin = await assertAdmin(tx, gameId, session.sessionId);
      if (!admin.ok) {
        return {
          ok: false,
          reason: admin.reason === "not_admin" ? "not_authorized" : "not_found",
        };
      }

      // Pipeline step 2: server time, read after the lock.
      const { rows: clockRows } = await tx.query(CLOCK_NOW_SQL, []);
      const nowRaw = clockRows[0]?.now;
      const nowIso =
        nowRaw instanceof Date
          ? nowRaw.toISOString()
          : new Date(String(nowRaw)).toISOString();

      // Pipeline step 3: lazily settle due effect transitions at this `now`,
      // under the lock the caller already holds, before loading state (6.7).
      await settleDueTransitions(tx, gameId, nowIso);

      // Pipeline step 4: the single loaded snapshot, reflecting the settled flags.
      const state = await loadBehaviorState(tx, gameId, nowIso);

      // Pipeline step 5: plan the host override (pure).
      const planned = hostChallengeOverride(state, challengeId, action, nowIso);

      // Pipeline step 6: a rejection writes no domain rows and no mutation
      // event; the step-3 transition events still commit (19.10).
      if (!planned.ok) {
        return { ok: false, reason: reasonFor(planned.error) };
      }

      // Pipeline step 7: write the patched challenge, the offer voided by a
      // `clear`, and the critic failure effect cancelled by a `reset`.
      const { challenge, voidOffer, cancelEffectId } = planned.plan;
      await writeChallenges(tx, gameId, [challenge]);
      if (voidOffer !== null) {
        await writeOffers(tx, gameId, [voidOffer]);
      }

      // A reset of a failed Everyone's a Critic challenge cancels its failure
      // block: cancel the effect in place (`cancel_reason = 'host'`) so the
      // window no longer blocks claims, and embed the cancelled record.
      let cancelledEffect: EffectRecord | null = null;
      if (cancelEffectId !== null) {
        const effect = state.effects.find((e) => e.effectId === cancelEffectId);
        if (effect !== undefined && effect.cancelledAt === null) {
          cancelledEffect = {
            ...effect,
            cancelledAt: nowIso,
            cancelReason: "host",
          };
          await writeEffects(tx, gameId, [cancelledEffect], state.bars);
        }
      }

      // Pipeline step 8: append exactly one host_override_applied mutation event
      // embedding the challenge and any voided offer / cancelled effect, so the
      // projection folds the override without a parallel client source. The
      // event is keyed on `challengeId` for its toast (events fold).
      const event = await appendEvent(tx, {
        gameId,
        type: GAME_BOARD_EVENT_TYPES.hostOverrideApplied,
        actor: { kind: "admin" },
        payload: {
          challengeId: challenge.challengeId,
          action,
          challenges: [challenge],
          offers: voidOffer === null ? [] : [voidOffer],
          effects: cancelledEffect === null ? [] : [cancelledEffect],
        },
      });

      return { ok: true, seq: event.seq };
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
