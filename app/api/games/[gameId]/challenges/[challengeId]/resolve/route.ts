/**
 * Challenge-resolution route (card-behavior Task 7.8), on the Card_Behavior_Mutation
 * pipeline (design.md "Mutation pipeline" and the
 * "POST /challenges/{challengeId}/resolve" row).
 *
 * POST /api/games/{gameId}/challenges/{challengeId}/resolve — the target team
 * marks a gated challenge completed, or fails an Everyone's a Critic challenge.
 * In one transaction it runs the shared pipeline:
 *
 *   1. authorize + lock the game row (`resolveCardActor`), resolving the acting
 *      team from the session (member of a live game with a team);
 *   2. read `clock_timestamp()` as the server `now` (after the lock, so server
 *      time agrees with lock order);
 *   3. lazily settle due effect transitions (`settleDueTransitions`, pipeline
 *      step 3) at that same `now`, so every boundary at or before `now` is
 *      announced with its transition events ordered before this mutation's own
 *      event;
 *   4. load the single {@link BehaviorState} snapshot (`loadBehaviorState`);
 *   5. resolve the challenge (`resolveChallenge`) — pure, returns the patched
 *      challenge plus an optional critic `team_claim_block` effect, or a
 *      Stable_Error;
 *   6. a rejection returns here, committing only the step-3 transition events;
 *   7. otherwise write the patched challenge (`writeChallenges`) and, on a
 *      fail, the new critic block effect (`writeEffects`);
 *   8. append exactly one `challenge_resolved` mutation event embedding the
 *      challenge and any critic block effect.
 *
 * The response `seq` is the single `challenge_resolved` mutation event (never a
 * transition event). Error mapping (design.md): the planner already speaks the
 * Stable_Error vocabulary — `not_authorized` (actor not on the target team),
 * `already_resolved` (challenge not open), `conflict` (a live Fairest offer, or
 * a fail on a non-critic / complete on UIOLI), `invalid_input` (bad body),
 * `not_found` (no such challenge). An uncaught error rolls the whole transaction
 * back (the challenge/effect rows, the mutation event, and the step-3 transition
 * events together) and responds `unavailable` (503).
 *
 * Requirements: 4.4, 4.6, 5.2, 5.3, 5.4, 5.5, 7.2, 7.4, 19.6, 19.9, 19.10.
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
} from "@/lib/cards/behaviorStore";
import { resolveChallenge, type ResolveRequest } from "@/lib/cards/challenges";
import type { StableError } from "@/lib/cards/behaviorState";

import {
  applied,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

import { resolveCardActor } from "../../../cards/_shared";

export const runtime = "nodejs";

interface ResolveBody {
  /** The resolution outcome: `completed` marks the challenge done, `failed` fails it. */
  readonly outcome?: unknown;
}

type ResolveOutcome =
  | { readonly ok: true; readonly seq: number }
  | {
      readonly ok: false;
      readonly reason: LobbyErrorReason;
      readonly details?: unknown;
    };

const CLOCK_NOW_SQL = `select clock_timestamp() as now`;

/**
 * Map a planner {@link StableError} onto the structured route reason (design.md
 * error-mapping table). The challenge state machine already speaks the
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

  let body: ResolveBody;
  try {
    body = (await request.json()) as ResolveBody;
  } catch {
    return notApplied("invalid_input");
  }
  // The body carries the action: "completed" → complete, "failed" → fail.
  let kind: ResolveRequest["kind"];
  if (body.outcome === "completed") {
    kind = "complete";
  } else if (body.outcome === "failed") {
    kind = "fail";
  } else {
    return notApplied("invalid_input");
  }

  try {
    const outcome = await withTransaction<ResolveOutcome>(async (tx) => {
      // Pipeline step 1: authorize + lock the game row, resolving the actor's
      // team from the session (member of a live game with a team).
      const actor = await resolveCardActor(tx, gameId, session.sessionId);
      if (!actor.ok) {
        return { ok: false, reason: reasonFor(actor.reason) };
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

      // Pipeline step 5: resolve the challenge (pure).
      const req: ResolveRequest = { kind, actorTeamId };
      const resolved = resolveChallenge(state, challengeId, req, nowIso);

      // Pipeline step 6: a rejection writes no domain rows and no mutation
      // event; the step-3 transition events still commit.
      if (!resolved.ok) {
        return { ok: false, reason: reasonFor(resolved.error) };
      }

      // Pipeline step 7: write the patched challenge and, on a fail, the new
      // Everyone's a Critic `team_claim_block` effect.
      const { challenge, newEffect } = resolved.plan;
      await writeChallenges(tx, gameId, [challenge]);
      if (newEffect !== null) {
        await writeEffects(tx, gameId, [newEffect], state.bars);
      }

      // Pipeline step 8: append exactly one challenge_resolved mutation event
      // embedding the challenge and any critic block effect, so the projection
      // folds the resolution without a parallel client source.
      const event = await appendEvent(tx, {
        gameId,
        type: GAME_BOARD_EVENT_TYPES.challengeResolved,
        actor: { kind: "team", teamId: actorTeamId },
        payload: {
          challengeId: challenge.challengeId,
          outcome: challenge.status,
          challenges: [challenge],
          effects: newEffect === null ? [] : [newEffect],
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
