/**
 * Task 23.3 — Atomic-result-shape and realtime/RLS integration tests
 * (ENVIRONMENT-DEPENDENT, DB-backed).
 *
 * This suite covers the lobby feature's write/propagation contract end to end
 * against a real Postgres + Supabase Realtime, following the env-gated
 * convention established by `supabase/__tests__/playersTeamNullable.test.ts`:
 * `describe.skipIf(...)`, lazy dynamic import of server-only modules, and
 * best-effort cleanup in `afterAll`. With no env configured (the default
 * `npm test` run) every block skips cleanly, so the offline suite stays green.
 *
 * Two independently-gated concerns live here:
 *
 * ---------------------------------------------------------------------------
 * A. STRUCTURED RESULT SHAPE (gated on SUPABASE_DB_URL alone)
 * ---------------------------------------------------------------------------
 * Drives a real lobby route handler (`POST /api/games/{gameId}/teams`) over the
 * trusted direct-Postgres connection and asserts the design's structured result
 * contract:
 *   - a SUCCESSFUL mutation returns `{ applied: true, seq }` where `seq` is the
 *     appended `game_event`'s per-game sequence number, and the event is
 *     actually persisted (R6.4);
 *   - a REJECTED mutation returns `{ applied: false, error }` (the `reason`) and
 *     persists NOTHING — no domain row, no `game_event` (R6.5).
 * The route module and `lib/db/server` import `server-only` (resolves only in a
 * Next bundle), so both are loaded lazily and are never evaluated when skipped.
 *
 * ---------------------------------------------------------------------------
 * B. REALTIME DELIVERY (R7.1) + PER-GAME RLS ISOLATION (R7.4)
 * ---------------------------------------------------------------------------
 * Gated additionally on the live Supabase env (URL + anon + service key). Using
 * the project's own realtime path — `subscribe()` from `lib/realtime` wired to
 * the Supabase browser adapter (`lib/realtime/supabaseBrowser`) through a real
 * member-authenticated session (`_session.ts`) so RLS permits delivery — it
 * asserts:
 *   - a committed lobby `game_event` reaches a separately-subscribed member
 *     client within 5 seconds (R7.1);
 *   - a subscriber for game A never receives game B's events (per-game
 *     isolation, R7.4), with two representative writes into B.
 *
 * REQUIRED ENVIRONMENT
 *   Block A: SUPABASE_DB_URL (direct Postgres connection).
 *   Block B: additionally NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *            SUPABASE_SERVICE_ROLE_KEY, and `game_events` in the
 *            `supabase_realtime` publication (see scripts/enable-realtime.mjs).
 *
 * RUN
 *   npm run test:integration -- \
 *     supabase/__tests__/integration/lobbyAtomicResult.integration.test.ts
 *
 * Validates: Requirements 6.4, 6.5, 7.1, 7.4.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import type { GameEvent, QueryRunner } from "@/lib/events";
import { subscribe, type RealtimeSubscription } from "@/lib/realtime";
import {
  supabaseRealtimeTransport,
  supabaseSnapshotSource,
} from "@/lib/realtime/supabaseBrowser";

import { createMemberSession, type MemberSession } from "./_session";

/** The Real_Time_Channel delivery budget from R7.1: 5 seconds. */
const DELIVERY_BUDGET_MS = 5_000;
/** Extra window to confirm no game-B event leaks in after A's arrives (R7.4). */
const LEAK_WATCH_MS = 1_500;
/** The session header every lobby route reads. */
const SESSION_HEADER = "x-bbb-session-id";

// ---------------------------------------------------------------------------
// Lazy server-only modules (evaluated only when a gated suite actually runs).
// ---------------------------------------------------------------------------
//
// `lib/db/server.ts` and the route module import `server-only`, which resolves
// only inside the Next.js bundler. Loading them lazily keeps the default
// (skipped) `npm test` run green outside a Next build — matching the gating in
// `playersTeamNullable.test.ts` and `route.property.test.ts`.

type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

type TeamsRoute = typeof import("@/app/api/games/[gameId]/teams/route");
let teamsRoute: TeamsRoute | undefined;
async function createTeamRoute(): Promise<TeamsRoute> {
  teamsRoute ??= await import("@/app/api/games/[gameId]/teams/route");
  return teamsRoute;
}

// ---------------------------------------------------------------------------
// Env gating.
// ---------------------------------------------------------------------------

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const DB_CONFIGURED = nonEmpty(process.env.SUPABASE_DB_URL);
const LIVE_ENV_CONFIGURED =
  nonEmpty(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  nonEmpty(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) &&
  nonEmpty(process.env.SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `predicate` until true or `timeoutMs` elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  stepMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(stepMs);
  }
  return predicate();
}

/** Build a `POST /api/games/{gameId}/teams` request with a session + JSON body. */
function createTeamRequest(sessionId: string, name: string): Request {
  return new Request("http://localhost/api/games/g/teams", {
    method: "POST",
    headers: {
      [SESSION_HEADER]: sessionId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
}

/** The Next route context whose `params` resolves to the game id under test. */
function routeContext(gameId: string): {
  params: Promise<{ gameId: string }>;
} {
  return { params: Promise.resolve({ gameId }) };
}

/**
 * Seed a game with a member player over the trusted (RLS-bypassing) connection.
 * Returns the game id and the member's session id (a game member for whom the
 * create-team route is authorized).
 */
async function seedGameWithMember(): Promise<{
  gameId: string;
  memberSessionId: string;
}> {
  const adminSessionId = `it-admin-${randomUUID()}`;
  const memberSessionId = `it-member-${randomUUID()}`;
  const joinCode = `it-${randomUUID()}`;
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const game = await tx.query(
      `insert into games (admin_session_id, join_code)
       values ($1, $2) returning id`,
      [adminSessionId, joinCode],
    );
    const gameId = String(game.rows[0]?.id);
    const team = await tx.query(
      `insert into teams (game_id, name, color)
       values ($1, $2, $3) returning id`,
      [gameId, "Seed Team", "#010203"],
    );
    const teamId = String(team.rows[0]?.id);
    await tx.query(
      `insert into players (team_id, game_id, session_id, display_name)
       values ($1, $2, $3, $4)`,
      [teamId, gameId, memberSessionId, "Seed Member"],
    );
    return { gameId, memberSessionId };
  });
}

/** Count teams and events for a game (privileged read; verifies persistence). */
async function countState(
  gameId: string,
): Promise<{ teams: number; events: number }> {
  const { withTransaction } = await db();
  return withTransaction(async (tx: QueryRunner) => {
    const teams = await tx.query(`select id from teams where game_id = $1`, [
      gameId,
    ]);
    const events = await tx.query(
      `select id from game_events where game_id = $1`,
      [gameId],
    );
    return { teams: teams.rows.length, events: events.rows.length };
  });
}

/** Best-effort cascade delete of a game. */
async function deleteGame(gameId: string): Promise<void> {
  const { withTransaction } = await db();
  await withTransaction(async (tx) => {
    await tx.query(`delete from games where id = $1`, [gameId]);
    return undefined;
  });
}

// ===========================================================================
// Block A — structured result shape (gated on SUPABASE_DB_URL alone).
// ===========================================================================

describe.skipIf(!DB_CONFIGURED)(
  "Lobby route structured result shape (Task 23.3, Req 6.4/6.5)",
  () => {
    const createdGameIds: string[] = [];

    afterAll(async () => {
      if (!serverDb) return;
      for (const gameId of createdGameIds) {
        try {
          await deleteGame(gameId);
        } catch {
          /* best-effort */
        }
      }
      await serverDb.closeDb();
    });

    it("returns { applied: true, seq } and persists the event on a successful mutation (R6.4)", async () => {
      const { POST } = await createTeamRoute();
      const { gameId, memberSessionId } = await seedGameWithMember();
      createdGameIds.push(gameId);

      const before = await countState(gameId);

      const response = await POST(
        createTeamRequest(memberSessionId, "Result Shape Team"),
        routeContext(gameId),
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        applied: boolean;
        seq?: unknown;
        error?: unknown;
      };
      // Success shape: applied true + a numeric per-game sequence (R6.4).
      expect(body.applied).toBe(true);
      expect(typeof body.seq).toBe("number");
      expect(Number.isInteger(body.seq as number)).toBe(true);

      // The event (and the team) are actually persisted.
      const after = await countState(gameId);
      expect(after.teams).toBe(before.teams + 1);
      expect(after.events).toBe(before.events + 1);

      // The returned seq matches the appended event's persisted seq.
      const { withTransaction } = await db();
      const persistedSeq = await withTransaction(async (tx) => {
        const { rows } = await tx.query(
          `select seq from game_events where game_id = $1
             and event_type = 'team_created' order by seq desc limit 1`,
          [gameId],
        );
        return Number(rows[0]?.seq);
      });
      expect(persistedSeq).toBe(body.seq);
    });

    it("returns { applied: false, error } and persists nothing on a rejected mutation (R6.5)", async () => {
      const { POST } = await createTeamRoute();
      const { gameId } = await seedGameWithMember();
      createdGameIds.push(gameId);

      const before = await countState(gameId);

      // A session that is NOT a member of this game — the route rejects it as
      // `not_member` (403) and must write nothing.
      const strangerSession = `it-stranger-${randomUUID()}`;
      const response = await POST(
        createTeamRequest(strangerSession, "Should Not Persist"),
        routeContext(gameId),
      );

      expect(response.status).toBe(403);
      const body = (await response.json()) as {
        applied: boolean;
        error?: unknown;
        seq?: unknown;
      };
      // Rejection shape: applied false + a reason, no seq (R6.5).
      expect(body.applied).toBe(false);
      expect(typeof body.error).toBe("string");
      expect(body.error).toBe("not_member");
      expect(body.seq).toBeUndefined();

      // Nothing persisted: team and event counts are unchanged.
      const after = await countState(gameId);
      expect(after.teams).toBe(before.teams);
      expect(after.events).toBe(before.events);
    });
  },
);

// ===========================================================================
// Block B — realtime delivery (R7.1) + per-game RLS isolation (R7.4).
// ===========================================================================

/** Append one lobby event to a game over the trusted DB connection. */
async function appendLobbyEvent(
  gameId: string,
  type: string,
  payload: unknown,
): Promise<GameEvent> {
  const { withTransaction } = await db();
  const { appendEvent } = await import("@/lib/events");
  return withTransaction((tx) =>
    appendEvent(tx, { gameId, type, actor: "admin", payload }),
  );
}

/** Create a bare game over the trusted connection; returns its id. */
async function createBareGame(): Promise<string> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `insert into games (admin_session_id, join_code)
       values ($1, $2) returning id`,
      [`it-${randomUUID()}`, `it-${randomUUID()}`],
    );
    return String(rows[0]?.id);
  });
}

describe.skipIf(!(DB_CONFIGURED && LIVE_ENV_CONFIGURED))(
  "Lobby realtime delivery + per-game isolation (Task 23.3, Req 7.1/7.4)",
  () => {
    // Game A is administered by a real member so its member-authenticated
    // client can subscribe under RLS; game B is an unrelated game.
    let session: MemberSession;
    let gameA: string;
    let gameB: string;
    let subscription: RealtimeSubscription | undefined;

    beforeAll(async () => {
      session = await createMemberSession();
      gameA = session.gameId;
      gameB = await createBareGame();
    }, 30_000);

    afterAll(async () => {
      await subscription?.close().catch(() => undefined);
      try {
        await session?.cleanup();
      } catch {
        /* best-effort */
      }
      try {
        if (gameB) await deleteGame(gameB);
      } catch {
        /* best-effort */
      }
      try {
        await session?.memberClient.removeAllChannels();
      } catch {
        /* best-effort */
      }
      if (serverDb) {
        await serverDb.closeDb();
      }
    }, 30_000);

    it(
      "delivers a committed lobby event to a subscribed client within 5s and never leaks game B's events",
      async () => {
        const received: GameEvent[] = [];

        // Subscribe to game A via the real adapter path; the postgres_changes
        // channel is filtered to game_id=eq.A and reads run under RLS.
        subscription = await subscribe(gameA, {
          transport: supabaseRealtimeTransport(session.memberClient),
          snapshotSource: supabaseSnapshotSource(session.memberClient),
          handlers: {
            onEvent: (event) => {
              received.push(event);
            },
          },
        });

        // Let the realtime socket finish joining before we write.
        await delay(1_000);

        // Persist one committed lobby event into A, and — for isolation — two
        // representative events into B.
        const committedAtMs = Date.now();
        const eventA = await appendLobbyEvent(gameA, "team_created", {
          marker: "A1",
        });
        await appendLobbyEvent(gameB, "team_created", { marker: "B1" });
        await appendLobbyEvent(gameB, "player_joined", { marker: "B2" });

        // R7.1: A's event reaches the subscribed client within the 5s budget.
        const gotA = await waitFor(
          () => received.some((e) => e.seq === eventA.seq),
          DELIVERY_BUDGET_MS,
        );
        expect(
          gotA,
          `expected game A's event within ${DELIVERY_BUDGET_MS}ms; received ` +
            `${received.length} event(s)`,
        ).toBe(true);

        const delivered = received.find(
          (e) => e.seq === eventA.seq,
        ) as GameEvent;
        expect(delivered.gameId).toBe(gameA);
        expect(delivered.eventType).toBe("team_created");
        // Commit-to-receive latency is within the R7.1 budget.
        const latencyMs = Date.now() - committedAtMs;
        expect(latencyMs).toBeLessThan(DELIVERY_BUDGET_MS);

        // Watch a little longer to catch any late-arriving game-B leak.
        await delay(LEAK_WATCH_MS);

        // R7.4: every delivered event belongs to game A; no game-B event ever
        // reached the A-subscribed client (per-game isolation).
        expect(received.every((e) => e.gameId === gameA)).toBe(true);
        expect(received.some((e) => e.gameId === gameB)).toBe(false);
      },
      DELIVERY_BUDGET_MS + LEAK_WATCH_MS + 20_000,
    );
  },
);
