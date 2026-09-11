/**
 * Demonstration server mutation route (design.md Component 2; Task 10.1).
 *
 * This is the foundation's proof of the write path: a **server-only** route that,
 * for one authenticated game-scoped request, performs a domain write **and**
 * appends **exactly one** `game_event` **inside a single transaction**, then
 * returns the new event's `seq` on success or a structured "not applied" error on
 * failure (Req 4.3). If the event write fails, the whole transaction rolls back so
 * the domain change does not persist and the log is unchanged (Req 4.4).
 *
 * Feature mutations (claim, card play, game-end) arrive later; this single route
 * is enough to demonstrate the backbone end-to-end.
 *
 * Server-only + service connection:
 *   - `runtime = 'nodejs'` — needs the Node runtime for a real Postgres socket
 *     connection (the `postgres` driver in `lib/db/server.ts`); the Edge runtime
 *     cannot open one.
 *   - The transaction runs over the privileged direct-Postgres connection
 *     (`SUPABASE_DB_URL`), which bypasses RLS for trusted server writes and is
 *     never exposed to the browser (`lib/db/server.ts` is `server-only`).
 *
 * Auth (lightweight, consistent with the session-based Identity_Model, Req 1.7):
 *   the request must carry a `gameId` (body) and an `x-bbb-session-id` header. The
 *   route confirms that session is a member of the game (a joined player or the
 *   game admin) before writing. This mirrors the RLS membership rule
 *   (`bbb_is_game_member`) at the application layer; because the server uses the
 *   trusted connection, we enforce membership here rather than relying on RLS. For
 *   the demo we assume server trust once membership is confirmed.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent, PayloadTooLargeError } from "@/lib/events";

/** Node.js runtime: a real Postgres connection cannot be opened on Edge. */
export const runtime = "nodejs";

/** The event type emitted by the demonstration mutation. */
const DEMO_EVENT_TYPE = "demo_state_change";

/** Header carrying the per-game session id (session-based Identity_Model). */
const SESSION_HEADER = "x-bbb-session-id";

/** Request body accepted by the demo mutation. */
interface DemoMutationBody {
  /** The game this mutation is scoped to (Req 4.1: exactly one game per event). */
  readonly gameId?: unknown;
  /** Optional human-readable note recorded on the demo domain row + event payload. */
  readonly note?: unknown;
}

/** Structured "not applied" failure shape (Req 4.3). */
interface NotAppliedError {
  readonly applied: false;
  readonly error: string;
}

/** Success shape: the mutation was applied and produced one event at `seq`. */
interface AppliedResult {
  readonly applied: true;
  /** The new event's per-game sequence number. */
  readonly seq: number;
  /** The id of the demo domain row written alongside the event. */
  readonly barId: string;
}

/** Build a structured not-applied JSON response with the given status. */
function notApplied(error: string, status: number): NextResponse {
  const body: NotAppliedError = { applied: false, error };
  return NextResponse.json(body, { status });
}

/**
 * Confirm the session belongs to the game (a joined player or the game admin),
 * inside the caller's transaction so the check and the writes are consistent.
 * Mirrors the RLS `bbb_is_game_member` predicate at the app layer.
 */
const MEMBERSHIP_SQL = `
select 1
from games g
where g.id = $1
  and (
    g.admin_session_id = $2
    or exists (
      select 1 from players p
      where p.game_id = g.id and p.session_id = $2
    )
  )
limit 1
`;

/** The demonstration domain write: insert a bar into the game (a real, RLS-scoped row). */
const INSERT_DEMO_BAR_SQL = `
insert into bars (game_id, name)
values ($1, $2)
returning id
`;

/**
 * POST /api/demo-mutation
 *
 * Body: `{ gameId: string, note?: string }`; header `x-bbb-session-id: <session>`.
 *
 * On success returns 201 `{ applied: true, seq, barId }`. On failure returns a
 * structured `{ applied: false, error }` with an appropriate status:
 *   - 400 malformed body,
 *   - 401 missing session,
 *   - 403 session is not a member of the game,
 *   - 413 event payload too large,
 *   - 500 the transaction failed and was rolled back (nothing applied).
 */
export async function POST(request: Request): Promise<NextResponse> {
  // --- Parse + validate the request ---------------------------------------
  const sessionId = request.headers.get(SESSION_HEADER)?.trim();
  if (!sessionId) {
    return notApplied(`missing ${SESSION_HEADER} header`, 401);
  }

  let body: DemoMutationBody;
  try {
    body = (await request.json()) as DemoMutationBody;
  } catch {
    return notApplied("request body must be valid JSON", 400);
  }

  const gameId = typeof body.gameId === "string" ? body.gameId.trim() : "";
  if (!gameId) {
    return notApplied("gameId is required", 400);
  }
  const note = typeof body.note === "string" ? body.note : "demo state change";

  // --- Atomic domain write + exactly one appendEvent (Req 4.3/4.4) ---------
  try {
    const result = await withTransaction<AppliedResult | "not_member">(
      async (tx) => {
        // Game-scoped auth: confirm membership in the same transaction.
        const { rows: memberRows } = await tx.query(MEMBERSHIP_SQL, [
          gameId,
          sessionId,
        ]);
        if (memberRows.length === 0) {
          return "not_member";
        }

        // 1. Domain write: a real row in a game-scoped table.
        const { rows: barRows } = await tx.query(INSERT_DEMO_BAR_SQL, [
          gameId,
          `Demo bar (${note})`,
        ]);
        const barId = String(barRows[0]?.id);

        // 2. EXACTLY ONE event, in the same transaction. If this throws (size,
        //    constraint, connectivity), the whole transaction rolls back: the
        //    bar insert above is undone and the log is unchanged (Req 4.4).
        const event = await appendEvent(tx, {
          gameId,
          type: DEMO_EVENT_TYPE,
          actor: "admin",
          payload: { note, barId },
        });

        return { applied: true, seq: event.seq, barId };
      },
    );

    if (result === "not_member") {
      return notApplied("session is not a member of this game", 403);
    }
    // Success: state change + its single event committed together (Req 4.3).
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    // The transaction rolled back: no domain change persisted, log unchanged.
    if (err instanceof PayloadTooLargeError) {
      return notApplied(err.message, 413);
    }
    const message =
      err instanceof Error ? err.message : "mutation could not be applied";
    return notApplied(message, 500);
  }
}
