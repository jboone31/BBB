/**
 * Designate-bars route (design.md §Components 1d, §Server routes; Task 13).
 *
 * POST /api/games/{gameId}/bars — the Admin designates (or changes, while the
 * Game is still in its lobby) the Game's Start_Bar and/or Finish_Bar. The
 * designation write and exactly one `bars_designated` `game_event` are committed
 * together in a single transaction (`withTransaction` + `appendEvent`), mirroring
 * `demo-mutation` and the `end` route. On success it returns the appended event's
 * per-game `seq`; on a guard rejection it returns a structured "not applied"
 * error with the reason and its mapped HTTP status, having written nothing so any
 * existing designation is left unchanged (R2.3, R2.4, R2.6, R2.8).
 *
 * Server-only + service connection:
 *   - `runtime = 'nodejs'` — the `postgres` driver in `lib/db/server.ts` needs a
 *     real Postgres socket, which the Edge runtime cannot open.
 *   - The transaction uses the privileged direct-Postgres connection, which
 *     bypasses RLS for trusted server writes and is never exposed to the browser.
 *
 * Flow (all inside the transaction against the `FOR UPDATE`-locked game row):
 *   1. `requireSession` — a request with no valid Session writes nothing (R8.3 → 401).
 *   2. `assertAdmin` — only the Game's Admin may designate bars (R2.8 → 403;
 *      missing game → 404), loading the game row so its lifecycle and current
 *      designation are read in the same transaction.
 *   3. lobby-phase gate (`isLobbyPhase`) — designation is allowed only while in
 *      the lobby (R2.6 → 409); this also permits changing the designation while
 *      in the lobby (R2.5).
 *   4. Combine the request with the current designation: only the side(s) present
 *      in the body change; an omitted side keeps its existing value (R2.1/R2.2,
 *      and R2.5 change-one-side).
 *   5. Existence check — each bar id in the *resulting* designation must be a bar
 *      of this Game (R2.4 → 404).
 *   6. `validateBarDesignation` — the resulting start/finish bars must differ
 *      (R2.3 → 400; maps `finish_equals_start` → `start_finish_equal`).
 *   7. Update `games.start_bar_id` / `games.finish_bar_id`, then `appendEvent`
 *      `bars_designated` with payload `{ startBarId, finishBarId }` (R2.7, R6.1),
 *      and return the event's `seq` (R6.4).
 *
 * Any rejection returns before the update/append, so the transaction commits no
 * change and the existing designation is preserved (R2.3, R2.4, R2.6, R2.8).
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 6.1.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent, type QueryRunner } from "@/lib/events";
import { validateBarDesignation } from "@/lib/games";
import { isLobbyPhase } from "@/lib/lobby/gate";
import { LOBBY_EVENT_TYPES } from "@/lib/lobby/events";

import {
  applied,
  assertAdmin,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "../../_shared";

/** Node.js runtime: a real Postgres connection cannot be opened on Edge. */
export const runtime = "nodejs";

/** Request body accepted by the designate-bars route. */
interface DesignateBarsBody {
  /** The Start_Bar id to designate; omit to leave the current Start_Bar unchanged. */
  readonly startBarId?: unknown;
  /** The Finish_Bar id to designate; omit to leave the current Finish_Bar unchanged. */
  readonly finishBarId?: unknown;
  /**
   * A Start_Bar *name* to create-and-designate (bar discovery is deferred to
   * F2.1, so the Lobby_Client designates by name). When present, a `bars` row is
   * inserted for this game and its id is designated as the Start_Bar. Ignored
   * when `startBarId` is also present.
   */
  readonly startBarName?: unknown;
  /** A Finish_Bar *name* to create-and-designate; see {@link startBarName}. */
  readonly finishBarName?: unknown;
}

/**
 * Outcome of the in-transaction designation attempt: the appended event's `seq`
 * on success, or a rejection reason the handler maps to a structured response.
 */
type DesignateOutcome =
  | { readonly ok: true; readonly seq: number }
  | { readonly ok: false; readonly reason: LobbyErrorReason };

/**
 * Confirm a bar id belongs to the given game, inside the caller's transaction.
 * Returns true iff a `bars` row exists with this id and `game_id` (R2.4).
 *
 * Positional parameters: $1 game_id, $2 bar_id.
 */
const BAR_EXISTS_SQL = `
select 1
from bars
where game_id = $1 and id = $2
limit 1
`;

/** Update the game's start/finish bar designation (R2.1/R2.2/R2.5). $1 game_id, $2 start, $3 finish. */
const UPDATE_DESIGNATION_SQL = `
update games
set start_bar_id = $2, finish_bar_id = $3
where id = $1
`;

/**
 * Insert a named bar for the game and return its id (bar discovery deferred to
 * F2.1; the Lobby_Client designates by name). $1 game_id, $2 name.
 */
const INSERT_BAR_SQL = `
insert into bars (game_id, name)
values ($1, $2)
returning id
`;

/**
 * Read the body's bar id fields as normalized values:
 *   - a non-empty trimmed string → that id (a designation for that side),
 *   - omitted / not a string → `undefined` (leave that side unchanged).
 *
 * A blank string is treated as absent rather than a distinct "clear" signal;
 * this feature only sets/changes designations (R2.5), it does not clear them.
 */
function readBarId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** True iff the given bar id exists in the game (R2.4). */
async function barExists(
  tx: QueryRunner,
  gameId: string,
  barId: string,
): Promise<boolean> {
  const { rows } = await tx.query(BAR_EXISTS_SQL, [gameId, barId]);
  return rows.length > 0;
}

/** Read a bar *name* field: a non-empty trimmed string, or `undefined`. */
function readBarName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Insert a named bar for the game and return its new id (R2.1/R2.2). */
async function insertBar(
  tx: QueryRunner,
  gameId: string,
  name: string,
): Promise<string> {
  const { rows } = await tx.query(INSERT_BAR_SQL, [gameId, name]);
  return String(rows[0]?.id);
}

/**
 * POST /api/games/[gameId]/bars
 *
 * Header: `x-bbb-session-id: <session>` (must be the game admin).
 * Body: `{ startBarId?: string, finishBarId?: string }` — either or both sides;
 * an omitted side leaves the current designation unchanged (R2.5).
 *
 * Responses:
 *   - 200 `{ applied: true, seq }` — designation recorded; one `bars_designated`
 *         event written (R2.7, R6.4).
 *   - 401 `{ applied: false, error: "missing_session" }` — no valid session (R8.3).
 *   - 403 `{ applied: false, error: "not_admin" }` — requester is not the admin (R2.8).
 *   - 404 `{ applied: false, error: "not_found" }` — the game does not exist.
 *   - 404 `{ applied: false, error: "bar_not_found" }` — a designated bar is not
 *         a bar of this game (R2.4).
 *   - 409 `{ applied: false, error: "lobby_closed" }` — the game is not in the
 *         lobby (R2.6).
 *   - 400 `{ applied: false, error: "start_finish_equal" }` — start and finish
 *         bars would be equal (R2.3).
 *   - 500 `{ applied: false, error: "designate_failed" }` — the transaction
 *         failed and was rolled back (nothing applied; existing designation kept).
 *
 * On every rejection the handler returns before the update/append, so the
 * existing designation is unchanged (R2.3, R2.4, R2.6, R2.8).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  // --- Session identity (R8.3) --------------------------------------------
  const session = requireSession(request);
  if (!session.ok) {
    return notApplied(session.reason);
  }

  const { gameId: rawGameId } = await context.params;
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : "";
  if (!gameId) {
    return notApplied("not_found");
  }

  let body: DesignateBarsBody;
  try {
    body = (await request.json()) as DesignateBarsBody;
  } catch {
    // A malformed body carries no bar ids; treat as "no bar found to designate".
    return notApplied("bar_not_found");
  }

  const requestedStartId = readBarId(body.startBarId);
  const requestedFinishId = readBarId(body.finishBarId);
  // A name is honored only when no explicit id is given for that side.
  const requestedStartName =
    requestedStartId === undefined ? readBarName(body.startBarName) : undefined;
  const requestedFinishName =
    requestedFinishId === undefined
      ? readBarName(body.finishBarName)
      : undefined;

  // --- Atomic guard chain + designation write + one appendEvent -----------
  try {
    const outcome = await withTransaction<DesignateOutcome>(async (tx) => {
      // 1. Admin authorization against the FOR UPDATE-locked game row (R2.8).
      const admin = await assertAdmin(tx, gameId, session.sessionId);
      if (!admin.ok) {
        return { ok: false, reason: admin.reason };
      }
      const { game } = admin;

      // 2. Lobby-phase gate: designation (and changing it, R2.5) is lobby-only (R2.6).
      if (!isLobbyPhase(game.lifecycle)) {
        return { ok: false, reason: "lobby_closed" };
      }

      // 3. Resolve each side to a bar id. A side may be given as an existing id
      //    (checked below) or as a *name* to create-and-designate (F2.1 defers
      //    discovery, so the Lobby_Client designates by name). An omitted side
      //    keeps its current value (R2.1/R2.2/R2.5).
      let startBarId = requestedStartId ?? game.startBarId;
      let finishBarId = requestedFinishId ?? game.finishBarId;

      // 4a. Existence check for id-based sides (R2.4). Only the sides actually
      //     being set by id are checked; an untouched existing designation was
      //     already validated when it was recorded.
      if (requestedStartId !== undefined) {
        if (!(await barExists(tx, gameId, requestedStartId))) {
          return { ok: false, reason: "bar_not_found" };
        }
      }
      if (requestedFinishId !== undefined) {
        if (!(await barExists(tx, gameId, requestedFinishId))) {
          return { ok: false, reason: "bar_not_found" };
        }
      }

      // 4c. Pre-insert start != finish guard for id/existing sides (R2.3), so a
      //     rejected designation never leaves a freshly-inserted bar behind.
      //     Name-based sides always mint distinct new ids, so an equal
      //     designation can only arise between two already-resolved ids.
      if (
        requestedStartName === undefined &&
        requestedFinishName === undefined &&
        !validateBarDesignation({ startBarId, finishBarId }).ok
      ) {
        return { ok: false, reason: "start_finish_equal" };
      }

      // 4b. Name-based sides: create the bar row now and designate its id. Runs
      //     only after the guards above, so no bar is inserted for a request
      //     that is going to be rejected.
      if (requestedStartName !== undefined) {
        startBarId = await insertBar(tx, gameId, requestedStartName);
      }
      if (requestedFinishName !== undefined) {
        finishBarId = await insertBar(tx, gameId, requestedFinishName);
      }

      // 5. Start != finish on the resulting designation (R2.3). Reuse the pure
      //    lib/games rule; map its error to the route's reason.
      const designation = validateBarDesignation({ startBarId, finishBarId });
      if (!designation.ok) {
        return { ok: false, reason: "start_finish_equal" };
      }

      // 6. Record the designation and append exactly one event, same tx (R2.7, R6.1).
      await tx.query(UPDATE_DESIGNATION_SQL, [
        gameId,
        designation.startBarId,
        designation.finishBarId,
      ]);

      const event = await appendEvent(tx, {
        gameId,
        type: LOBBY_EVENT_TYPES.barsDesignated,
        actor: "admin",
        payload: {
          startBarId: designation.startBarId,
          finishBarId: designation.finishBarId,
        },
      });

      return { ok: true, seq: event.seq };
    });

    if (!outcome.ok) {
      // Guard rejection: nothing written, existing designation unchanged.
      return notApplied(outcome.reason);
    }
    // Success: designation + its single event committed together (R6.4).
    return applied(outcome.seq);
  } catch {
    // The transaction rolled back: no designation persisted, log unchanged
    // (R2.3/R2.4/R2.6/R2.8, R6.2/R6.3). Mirror the create route's raw 500 shape.
    return NextResponse.json(
      { applied: false, error: "designate_failed" },
      { status: 500 },
    );
  }
}
