/**
 * Settle_Nudge route (card-behavior Task 12.2; design.md "Timer settlement" and
 * the `POST /effects/settle` row of the route table).
 *
 * POST /api/games/{gameId}/effects/settle — a member-driven nudge that runs the
 * idempotent Timer_Sweep for one game. There is no database scheduler: the
 * settle function fires only when a board nudges it here, when a
 * Card_Behavior_Mutation settles lazily (pipeline step 3), or via the optional
 * Cron_Route. A connected board calls this on mount, on reconnect, and around
 * each known effect boundary, so delayed activations (Cancel Culture) and
 * expirations (Crop Dusting, Happy Hour, Power Hour, …) are announced in near
 * real time even when no player is mutating state.
 *
 * Request flow:
 *
 *   1. {@link requireSession} reads `x-bbb-session-id`; a blank/missing header
 *      is rejected `missing_session` (401), writing nothing (Req 8.3).
 *   2. {@link assertMember} authorizes the session as the game's admin or a
 *      joined player **before any settle call**; a non-member is rejected
 *      `not_member` (403), writing nothing (Req 8.4/8.5, 20.8). The membership
 *      check runs inside this route's own transaction against the `FOR UPDATE`-
 *      locked game row, so the authorization decision and the settle it gates
 *      see the same serialized game state.
 *   3. In that same transaction the route calls
 *      `select bbb_settle_card_effects($1, true)` with `$1 = gameId` and `p_now`
 *      left NULL, so the function reads the server clock itself after taking the
 *      lock and appends only the transition events whose boundary is due at that
 *      instant (Req 20.3b, 20.4). `p_wait = true` because this transaction
 *      already holds the game lock, making the function's re-lock a re-entrant
 *      no-op. The function returns the integer count of transition events it
 *      appended.
 *   4. The route reads `clock_timestamp()` in the same transaction as
 *      `serverNow` (the client uses it for its Server_Clock_Offset, Req 20.5b),
 *      and `max(seq)` over the game's events as `seq` — the last appended
 *      transition event's seq, or the current high-water seq when this call
 *      appended nothing (Req 20.5c).
 *
 * Response `{ applied: true, seq, result: { appended, serverNow } }` (200). This
 * route does not use the shared {@link applied} helper even though it returns
 * `applied: true` + `seq`: `applied()` builds the `{ applied, seq, result }`
 * envelope too, but this route's success body is straightforward to construct
 * directly and keeps the settle-specific `result` shape (`appended`,
 * `serverNow`) co-located with its documentation. Any thrown error (the settle
 * SQL, a lost connection) rolls the whole transaction back — the settle's
 * transition events included — and responds `unavailable` (503) via
 * {@link notApplied} (Req 20.9).
 *
 * Requirements: 20.3b, 20.4, 20.5b, 20.5c, 20.8, 20.9.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";

import {
  assertMember,
  notApplied,
  requireSession,
} from "@/app/api/games/_shared";

/** Node.js runtime: a real Postgres transaction cannot be opened on Edge. */
export const runtime = "nodejs";

/**
 * Run the idempotent settle for one game at the server time the function reads
 * after taking the lock (`p_now` NULL). `p_wait = true` because this transaction
 * already holds the game lock. Returns the count of transition events appended.
 */
const SETTLE_SQL = `select bbb_settle_card_effects($1, true) as appended`;

/** The server clock, read in the same transaction for the Server_Clock_Offset. */
const SERVER_NOW_SQL = `select clock_timestamp() as server_now`;

/** The game's current high-water event seq (the last appended transition's seq
 * when this call appended any; null when the game has no events at all). */
const MAX_SEQ_SQL = `select max(seq) as seq from game_events where game_id = $1`;

/** Normalize a Postgres timestamptz (Date or string) to an ISO string. */
function toIso(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  const { gameId } = await context.params;

  // Session identity (Req 8.3): a blank/missing header writes nothing.
  const session = requireSession(request);
  if (!session.ok) {
    return notApplied(session.reason);
  }

  try {
    const result = await withTransaction(async (tx) => {
      // Authorize BEFORE any settle, against the FOR UPDATE-locked game row
      // (Req 8.4/8.5, 20.8). A non-member settles nothing.
      const member = await assertMember(tx, gameId, session.sessionId);
      if (!member) {
        return { ok: false as const };
      }

      // Idempotent Timer_Sweep at the server time the function reads (Req 20.4).
      const settleRows = await tx.query(SETTLE_SQL, [gameId]);
      const appended = Number(settleRows.rows[0]?.appended ?? 0);

      // Server clock for the client's Server_Clock_Offset (Req 20.5b).
      const nowRows = await tx.query(SERVER_NOW_SQL, []);
      const serverNow = toIso(nowRows.rows[0]?.server_now);

      // The last appended transition seq / current high-water seq (Req 20.5c).
      const seqRows = await tx.query(MAX_SEQ_SQL, [gameId]);
      const rawSeq = seqRows.rows[0]?.seq;
      const seq = rawSeq == null ? 0 : Number(rawSeq);

      return { ok: true as const, seq, appended, serverNow };
    });

    if (!result.ok) {
      return notApplied("not_member");
    }

    // Built directly rather than via applied(): keeps the settle-specific
    // result shape ({ appended, serverNow }) documented alongside this route.
    return NextResponse.json(
      {
        applied: true,
        seq: result.seq,
        result: { appended: result.appended, serverNow: result.serverNow },
      },
      { status: 200 },
    );
  } catch {
    // A thrown error rolled the transaction back (settle transitions included);
    // report it as a transient failure (Req 20.9).
    return notApplied("unavailable");
  }
}
