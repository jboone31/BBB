/**
 * Create-game route (design.md "Server routes" + "Create route: Join_Code
 * uniqueness + retry"; Task 12.1).
 *
 * `POST /api/games` creates a new Game in the `lobby` phase, records the creating
 * Session as the Game's Admin, generates a unique Join_Code, and appends exactly
 * one `game_created` event — all inside one transaction so the Game row and its
 * event commit or roll back together (R1.1, R1.2, R1.6, R6.1, R8.1).
 *
 * This mirrors the foundation's write path in `demo-mutation/route.ts`: a
 * `runtime = "nodejs"` handler wrapping `withTransaction` + `appendEvent`, and
 * the shared structured-response shape from `_shared.ts`.
 *
 * Join_Code uniqueness + retry (R1.4/R1.5): `games.join_code` carries a DB unique
 * index. The route generates a candidate (`generateJoinCode`) and attempts a
 * guarded insert (`insert ... select ... where not exists (join_code = $2)`). A
 * candidate whose code is already taken (including by `ended` games, which
 * retain their codes — R1.4's "unique across non-`ended` games" is a subset of
 * the DB's global uniqueness) yields **zero rows** instead of a unique-violation,
 * so the loop retries a fresh candidate up to `MAX_CODE_GEN_ATTEMPTS` (5) times
 * without aborting the transaction. If every attempt collides, the transaction
 * rolls back and the route returns a structured `code_generation_failed` (503)
 * with no Game and no event (R1.5). The unique index still guards the genuine
 * concurrent race (two creators picking the same free code simultaneously); that
 * rare unique-violation rolls the transaction back and surfaces as a 500.
 *
 * Why the guarded insert rather than catch-and-retry on `23505`? The whole retry
 * runs inside one Postgres transaction (`withTransaction`), and any statement
 * error — a `23505` included — aborts that transaction, so a bare
 * insert-and-catch could not simply try the next candidate. Returning no row on
 * a taken code keeps the transaction healthy across retries.
 *
 * Any other throw inside the transaction (a non-unique constraint violation, a
 * failed event append, a lost connection) rolls the whole transaction back — no
 * Game, no event (R1.7, R6.2/R6.3) — and surfaces as a 500.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 6.1, 8.1.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent } from "@/lib/events";
import { LOBBY_EVENT_TYPES } from "@/lib/lobby/events";
import { generateJoinCode, MAX_CODE_GEN_ATTEMPTS } from "@/lib/lobby/joinCode";

import { notApplied, requireSession } from "./_shared";

/** Node.js runtime: a real Postgres connection cannot be opened on Edge. */
export const runtime = "nodejs";

/**
 * Insert a new Game in the `lobby` phase with the creating session as admin and
 * the supplied candidate Join_Code, returning the new game id (R1.1, R1.2).
 *
 * `lifecycle` and `live_started_at` are left to their defaults (`lobby` / null),
 * satisfying the `games_live_started_at_when_started` check; `end_reason` stays
 * null (satisfying `games_end_reason_matches_lifecycle`). Start/finish bars are
 * designated later (Task 13).
 *
 * Positional parameters: $1 admin_session_id, $2 join_code.
 *
 * The insert is guarded with `where not exists (... join_code = $2)` so that a
 * candidate code that is already taken yields **zero rows** rather than raising a
 * unique-violation. This matters because the retry loop runs inside a single
 * Postgres transaction: any statement error (including a `23505`) aborts the
 * whole transaction, so a bare insert-and-catch could not simply retry on the
 * next candidate — the transaction would already be poisoned. Returning no row
 * on a collision lets the loop try a fresh candidate without aborting the
 * transaction. The `games.join_code` unique index still guards the genuine race
 * (two concurrent creators picking the same free code); that rare `23505`
 * rethrows and rolls the transaction back (no game, no event — R1.7).
 */
const INSERT_GAME_SQL = `
insert into games (lifecycle, admin_session_id, join_code)
select 'lobby', $1, $2
where not exists (select 1 from games where join_code = $2)
returning id
`;

/**
 * The success body for a created Game.
 *
 * Extends the shared `{ applied: true, seq }` shape (R6.4) with the Game
 * identifier and Join_Code the create route legitimately returns to the Admin
 * (R1.8), so the client can navigate to the lobby and share the code without a
 * follow-up read.
 */
interface CreateGameResult {
  readonly applied: true;
  /** The appended `game_created` event's per-game sequence number (R6.4). */
  readonly seq: number;
  /** The new Game's identifier (R1.8). */
  readonly gameId: string;
  /** The generated, unique Join_Code (R1.8). */
  readonly joinCode: string;
}

/**
 * A sentinel the transaction returns when every Join_Code generation attempt
 * collided, so the route can map it to a structured `code_generation_failed`
 * (503) response after the (empty) transaction rolls back (R1.5).
 */
const CODE_GENERATION_FAILED = "code_generation_failed" as const;

/**
 * POST /api/games
 *
 * Header: `x-bbb-session-id: <session>` (the creating Admin session).
 *
 * On success returns 201 `{ applied: true, seq, gameId, joinCode }` (R1.8, R6.4).
 * On failure returns a structured `{ applied: false, error }` (R6.5):
 *   - 401 `missing_session` — no valid session presented (R1.3, R8.3);
 *   - 503 `code_generation_failed` — 5 unique-code attempts exhausted (R1.5);
 *   - 500 — the transaction failed and rolled back (nothing persisted, R1.7).
 */
export async function POST(request: Request): Promise<NextResponse> {
  // --- Session identity (R1.3, R8.3) --------------------------------------
  const session = requireSession(request);
  if (!session.ok) {
    return notApplied(session.reason); // missing_session -> 401
  }
  const adminSessionId = session.sessionId;

  // --- Atomic create + retry + exactly one appendEvent (R1.4–R1.7, R6.1) ---
  try {
    const result = await withTransaction<
      CreateGameResult | typeof CODE_GENERATION_FAILED
    >(async (tx) => {
      // Generate a candidate and attempt the insert, retrying on a Join_Code
      // collision up to MAX_CODE_GEN_ATTEMPTS times (R1.4/R1.5).
      let gameId: string | null = null;
      let joinCode = "";
      for (let attempt = 0; attempt < MAX_CODE_GEN_ATTEMPTS; attempt++) {
        const candidate = generateJoinCode();
        // The guarded insert (see INSERT_GAME_SQL) writes a row only if the
        // candidate code is free, returning it; if the code is already taken it
        // returns ZERO rows WITHOUT raising, so the loop can retry a fresh
        // candidate without poisoning the transaction (R1.4/R1.5).
        //
        // Any error this insert *does* raise (e.g. the vanishingly rare
        // concurrent-race unique-violation, or a lost connection) aborts the
        // Postgres transaction and cannot be retried, so it propagates out of
        // `withTransaction`, rolls everything back (no game, no event — R1.7,
        // R6.3), and is turned into a 500 by the outer catch.
        const { rows } = await tx.query(INSERT_GAME_SQL, [
          adminSessionId,
          candidate,
        ]);
        const insertedId = rows[0]?.id;
        if (insertedId == null) {
          continue;
        }
        gameId = String(insertedId);
        joinCode = candidate;
        break;
      }

      if (gameId === null) {
        // All attempts collided. Returning the sentinel (rather than throwing)
        // still rolls back the transaction — nothing was inserted — while
        // letting the route map it to a 503 (R1.5).
        return CODE_GENERATION_FAILED;
      }

      // Exactly one event, in the same transaction (R1.6, R6.1). If this throws,
      // the whole transaction rolls back and the game insert above is undone
      // (R1.7, R6.2).
      const event = await appendEvent(tx, {
        gameId,
        type: LOBBY_EVENT_TYPES.gameCreated,
        actor: "admin",
        payload: { joinCode },
      });

      return { applied: true, seq: event.seq, gameId, joinCode };
    });

    if (result === CODE_GENERATION_FAILED) {
      return notApplied(CODE_GENERATION_FAILED); // -> 503
    }
    // Success: game + its single event committed together (R1.8, R6.4).
    return NextResponse.json(result, { status: 201 });
  } catch {
    // The transaction rolled back: no game, no event persisted (R1.7).
    return NextResponse.json(
      { applied: false, error: "create_failed" },
      { status: 500 },
    );
  }
}
