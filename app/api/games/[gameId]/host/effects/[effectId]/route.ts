/**
 * Host effect early-end route (card-behavior Task 11.2), on the
 * Card_Behavior_Mutation pipeline (design.md "Mutation pipeline" and the
 * "POST /host/effects/{effectId}" row).
 *
 * POST /api/games/{gameId}/host/effects/{effectId} — the game's Admin ends one
 * live effect early. In one transaction it runs the shared pipeline:
 *
 *   1. authorize + lock the game row (`assertAdmin`; `not_admin` → the
 *      `not_authorized` Stable_Error so the forbidden response never leaks
 *      which effect exists);
 *   2. read `clock_timestamp()` as the server `now` (after the lock, so server
 *      time agrees with lock order);
 *   3. lazily settle due effect transitions (`settleDueTransitions`, pipeline
 *      step 3) at that same `now`, so every boundary at or before `now` is
 *      announced with its transition events ordered before this mutation's own
 *      event;
 *   4. load the single {@link BehaviorState} snapshot (`loadBehaviorState`);
 *   5. plan the early-end (`planHostEffectEnd`) — pure, returns the cancelled
 *      effect, the bars to reconcile, and the Insurance protections to release,
 *      or a Stable_Error (`not_found`, `already_resolved`);
 *   6. a rejection returns here, committing only the step-3 transition events;
 *   7. otherwise cancel the effect (`cancel_reason = 'host'`), release any
 *      attached Insurance, and reconcile the affected bars without the ended
 *      effect's phantom / protection floor — awards already in the ledger are
 *      left untouched (21.6);
 *   8. append exactly one `host_override_applied` mutation event embedding the
 *      cancelled effect (plus any released protection) and the reconciliation
 *      score entries.
 *
 * A Pioneer / Scenic Route `next_claim_restriction` carries no phantom or floor,
 * so ending it reconciles nothing and writes no score entries; cancelling the
 * row is enough for `evaluateClaimBlocks` and `hasLegalNextBar` to stop applying
 * it (21.11), since both read only uncancelled restrictions.
 *
 * The response `seq` is the single `host_override_applied` mutation event (never
 * a transition event). An uncaught error rolls the whole transaction back (the
 * effect/ledger rows, the mutation event, and the step-3 transition events
 * together) and responds `unavailable` (503).
 *
 * Requirements: 21.4, 21.5, 21.6, 21.7, 21.9, 21.11, 19.9, 19.10.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent } from "@/lib/events";
import { GAME_BOARD_EVENT_TYPES } from "@/lib/gameboard/events";
import {
  loadBehaviorState,
  reconcileBarsInTx,
  settleDueTransitions,
  type BehaviorState,
  type EffectRecord,
  type ScoreEntryRecord,
} from "@/lib/cards/behaviorStore";
import {
  isEffectActive,
  planHostEffectEnd,
  type StableError,
} from "@/lib/cards/effects";

import {
  applied,
  assertAdmin,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

export const runtime = "nodejs";

interface EndBody {
  /** The host action. Only `"end"` is accepted; anything else is `invalid_input`. */
  readonly action?: unknown;
}

type EndOutcome =
  | { readonly ok: true; readonly seq: number }
  | {
      readonly ok: false;
      readonly reason: LobbyErrorReason;
      readonly details?: unknown;
    };

const CLOCK_NOW_SQL = `select clock_timestamp() as now`;

/** Cancel one effect as a host early-end (`cancel_reason = 'host'`). Scoped to
 * the live effect so re-running the plan in a transaction is idempotent. */
const HOST_END_EFFECT_SQL = `
update card_effects
set cancelled_at = now(), cancel_reason = 'host'
where game_id = $1 and id = $2 and cancelled_at is null and consumed_at is null
`;

/** Release one attached Insurance protection (`cancel_reason =
 * 'protection_released'`), mirroring the claim / Voted Off release path. */
const RELEASE_PROTECTION_SQL = `
update card_effects
set cancelled_at = now(), cancel_reason = 'protection_released'
where game_id = $1 and id = $2 and cancelled_at is null and consumed_at is null
`;

/**
 * Map a planner {@link StableError} onto the structured route reason. The host
 * effect-end planner speaks the Stable_Error vocabulary (`not_found`,
 * `already_resolved`), so this is an identity for the reasons it emits; any
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

/**
 * The Party Crasher phantom bar keys that are still active *after* the ended
 * effect is cancelled, so a reconcile of its bar drops this phantom while any
 * other phantom on a co-located bar is preserved. The effect list passed in has
 * the ended effect already marked cancelled at `now`, so `isEffectActive`
 * excludes it.
 */
function phantomBarKeys(
  effects: readonly EffectRecord[],
  nowMs: number,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const effect of effects) {
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
 * The per-bar Insurance floors from every still-active attached
 * `score_protection` effect *after* the ended effect is released, keyed by the
 * bar the attached claim sits on. The ended protection is already marked
 * cancelled in the effect list, so it drops out and its floor is removed on
 * reconcile; other teams' protections on the same bar are preserved.
 */
function protectedFloorsByBar(
  state: BehaviorState,
  effects: readonly EffectRecord[],
  nowMs: number,
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const byBar = new Map<string, Map<string, number>>();
  const barKeyOfClaim = new Map<string, string>();
  for (const claim of state.activeClaims) {
    barKeyOfClaim.set(claim.claimId, claim.barKey);
  }

  for (const effect of effects) {
    if (
      effect.kind !== "score_protection" ||
      effect.attachedClaimId === null ||
      effect.ownerTeamId === null ||
      effect.protectedPoints === null ||
      !isEffectActive(effect, nowMs)
    ) {
      continue;
    }
    const barKey =
      effect.attachedBarKey ?? barKeyOfClaim.get(effect.attachedClaimId);
    if (barKey === undefined || barKey === null) continue;
    let floors = byBar.get(barKey);
    if (floors === undefined) {
      floors = new Map<string, number>();
      byBar.set(barKey, floors);
    }
    floors.set(
      effect.ownerTeamId,
      Math.max(floors.get(effect.ownerTeamId) ?? 0, effect.protectedPoints),
    );
  }

  return byBar;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string; effectId: string }> },
): Promise<NextResponse> {
  const session = requireSession(request);
  if (!session.ok) {
    return notApplied(session.reason);
  }

  const { gameId: rawGameId, effectId: rawEffectId } = await context.params;
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : "";
  if (!gameId) {
    return notApplied("not_found");
  }
  const effectId = typeof rawEffectId === "string" ? rawEffectId.trim() : "";
  if (!effectId) {
    return notApplied("not_found");
  }

  let body: EndBody;
  try {
    body = (await request.json()) as EndBody;
  } catch {
    return notApplied("invalid_input");
  }
  if (body.action !== "end") {
    return notApplied("invalid_input");
  }

  try {
    const outcome = await withTransaction<EndOutcome>(async (tx) => {
      // Pipeline step 1: authorize + lock the game row. A non-admin is reported
      // as not_authorized so the forbidden response never leaks effect existence.
      const admin = await assertAdmin(tx, gameId, session.sessionId);
      if (!admin.ok) {
        return {
          ok: false,
          reason:
            admin.reason === "not_admin" ? "not_authorized" : admin.reason,
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
      // under the lock the caller already holds, before loading state.
      await settleDueTransitions(tx, gameId, nowIso);

      // Pipeline step 4: the single loaded snapshot, reflecting the settled flags.
      const state = await loadBehaviorState(tx, gameId, nowIso);

      // Pipeline step 5: plan the early-end (pure).
      const planned = planHostEffectEnd(state, effectId, nowIso);

      // Pipeline step 6: a rejection writes no domain rows and no mutation
      // event; the step-3 transition events still commit.
      if (!planned.ok) {
        return { ok: false, reason: reasonFor(planned.error) };
      }
      const plan = planned.plan;

      // Pipeline step 7a: cancel the effect (cancel_reason = 'host').
      const ended = state.effects.find((e) => e.effectId === plan.effectId);
      await tx.query(HOST_END_EFFECT_SQL, [gameId, plan.effectId]);

      const embeddedEffects: EffectRecord[] = [];
      if (ended !== undefined) {
        embeddedEffects.push({
          ...ended,
          cancelledAt: plan.cancelledAt,
          cancelReason: plan.cancelReason,
        });
      }

      // Pipeline step 7b: release any attached Insurance protection (the ended
      // effect itself when it is a `score_protection`), mirroring the claim /
      // Voted Off release path.
      for (const releaseId of plan.releaseProtections) {
        if (releaseId === plan.effectId) continue; // already cancelled above
        await tx.query(RELEASE_PROTECTION_SQL, [gameId, releaseId]);
        const base = state.effects.find((e) => e.effectId === releaseId);
        if (base !== undefined) {
          embeddedEffects.push({
            ...base,
            cancelledAt: plan.cancelledAt,
            cancelReason: "protection_released",
          });
        }
      }

      // Pipeline step 7c: reconcile each affected bar *without* the ended
      // effect's phantom / protection floor. Build the override set from an
      // effect list in which the ended effect (and any released protection) is
      // already marked cancelled, so `isEffectActive` excludes them while every
      // other active phantom / floor on the same bar is preserved. Awards in the
      // ledger are never touched (21.6).
      let scoreEntries: ScoreEntryRecord[] = [];
      if (plan.reconcileBars.length > 0) {
        const cancelledIds = new Set<string>([
          plan.effectId,
          ...plan.releaseProtections,
        ]);
        const nowMs = Date.parse(plan.cancelledAt);
        const afterEnd = state.effects.map((e) =>
          cancelledIds.has(e.effectId)
            ? {
                ...e,
                cancelledAt: plan.cancelledAt,
                cancelReason: "host" as const,
              }
            : e,
        );
        scoreEntries = await reconcileBarsInTx(tx, state, plan.reconcileBars, {
          phantom: phantomBarKeys(afterEnd, nowMs),
          protectedFloors: protectedFloorsByBar(state, afterEnd, nowMs),
        });
      }

      // Pipeline step 8: append exactly one host_override_applied mutation event
      // embedding the ended effect (plus any released protection) and the
      // reconciliation score entries, so the projection folds the override
      // without a parallel client source.
      const event = await appendEvent(tx, {
        gameId,
        type: GAME_BOARD_EVENT_TYPES.hostOverrideApplied,
        actor: { kind: "admin" },
        payload: {
          effectId: plan.effectId,
          action: "end",
          effects: embeddedEffects,
          scoreEntries,
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
