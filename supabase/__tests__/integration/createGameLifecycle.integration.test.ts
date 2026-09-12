/**
 * Task 23.1 — Create / lifecycle / Join_Code DB-backed integration tests
 * (ENVIRONMENT-DEPENDENT).
 *
 * Exercises the real create-game route (`app/api/games/route.ts`) end to end
 * against a live Postgres, proving the create half of the lobby lifecycle
 * against the actual schema + append-only `game_events` log rather than an
 * in-memory model. Three behaviors are covered, one per Requirement clause:
 *
 *   1. HAPPY PATH (R1.1, R1.6, R1.8): POSTing with a valid session header
 *      returns 201 with `{ applied: true, seq, gameId, joinCode }`, and the DB
 *      then holds exactly one `games` row in `lifecycle = 'lobby'` plus exactly
 *      one `game_created` event for that game (seq 1), with the admin session
 *      recorded verbatim and the returned Join_Code persisted on the row.
 *
 *   2. MISSING SESSION (R1.3): a POST with no `x-bbb-session-id` header is
 *      rejected with 401 and writes nothing — the global `games`/`game_events`
 *      counts are unchanged across the call.
 *
 *   3. FORCED JOIN_CODE COLLISION (R1.5, R1.7): with `generateJoinCode`
 *      monkeypatched to always return a code we have already seeded onto an
 *      existing game, every one of the `MAX_CODE_GEN_ATTEMPTS` insert attempts
 *      hits the `games.join_code` unique index, the transaction rolls back, the
 *      route returns 503 `code_generation_failed`, and NO new game and NO event
 *      persist.
 *
 * ---------------------------------------------------------------------------
 * CONVENTION (mirrors supabase/__tests__/playersTeamNullable.test.ts):
 *   - `describe.skipIf(!process.env.SUPABASE_DB_URL)` — the whole suite skips
 *     cleanly when no live DB is configured, so the default `npm test` run
 *     stays green with no live dependency.
 *   - Server-only modules (`@/lib/db/server`, the create route) are loaded
 *     LAZILY via dynamic import inside the gated block, so when the suite is
 *     skipped they are never evaluated. (Under the integration config the
 *     `server-only` guard is stubbed; see vitest.config.integration.mts.)
 *   - Runs against the LIVE database (the create route's `withTransaction`
 *     writes to the `public` schema and cannot be redirected to a throwaway
 *     schema), with every game this suite creates removed in `afterAll` — a
 *     game delete cascades to its teams/players/bars/events.
 *
 * REQUIRED ENVIRONMENT (suite SKIPS cleanly when unset):
 *   SUPABASE_DB_URL   Direct Postgres connection string. Used by
 *                     `lib/db/server.ts` for both the route under test and this
 *                     suite's setup/verification reads/cleanup.
 *
 * APPLIED-MIGRATIONS REQUIREMENT
 *   The target database MUST have migrations 0001+ applied (the `games`,
 *   `game_events` tables and the `games.join_code` unique index the retry loop
 *   depends on).
 *
 * RUN
 *   npm run test:integration
 *   # (loads .env.local; runs only supabase/__tests__/integration)
 *
 * Validates: Requirements 1.1, 1.3, 1.5, 1.6, 1.7, 1.8.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Join_Code generator mock (for the forced-collision case).
//
// The create route statically imports `generateJoinCode` from
// `@/lib/lobby/joinCode`, so an ESM `vi.spyOn` on the module namespace would not
// affect the already-bound import. Instead we `vi.mock` the module up front,
// keeping every real export via `importActual` and wrapping ONLY
// `generateJoinCode` in a delegate whose behavior a mutable override controls.
// By default it delegates to the real generator (happy path / missing-session
// cases are unaffected); the collision test flips the override to return a
// fixed, pre-seeded code so every insert attempt collides.
//
// The factory is hoisted by Vitest; it runs the first time the mocked module is
// imported (which only happens inside the gated block via the route), so a
// skipped suite never triggers it.
// ---------------------------------------------------------------------------
let joinCodeOverride: (() => string) | null = null;

vi.mock("@/lib/lobby/joinCode", async () => {
  const actual = await vi.importActual<typeof import("@/lib/lobby/joinCode")>(
    "@/lib/lobby/joinCode",
  );
  return {
    ...actual,
    generateJoinCode: (rand?: () => number): string =>
      joinCodeOverride ? joinCodeOverride() : actual.generateJoinCode(rand),
  };
});

// ---------------------------------------------------------------------------
// Env gating: skip cleanly unless a live DB is configured.
// ---------------------------------------------------------------------------
const DB_URL = process.env.SUPABASE_DB_URL?.trim();
const LIVE_DB_CONFIGURED = Boolean(DB_URL);

// ---------------------------------------------------------------------------
// Lazy server-only module handles (see header): never evaluated when skipped.
// ---------------------------------------------------------------------------
type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

type CreateRoute = typeof import("@/app/api/games/route");
let createRoute: CreateRoute | undefined;
async function route(): Promise<CreateRoute> {
  createRoute ??= await import("@/app/api/games/route");
  return createRoute;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Header carrying the per-game session id, mirroring `_shared.SESSION_HEADER`. */
const SESSION_HEADER = "x-bbb-session-id";

/** Build a POST Request for the create route, optionally with a session header. */
function makeCreateRequest(sessionId?: string): Request {
  const headers: Record<string, string> = {};
  if (sessionId !== undefined) {
    headers[SESSION_HEADER] = sessionId;
  }
  return new Request("http://localhost/api/games", {
    method: "POST",
    headers,
  });
}

/** Count all rows in a table (global) — used to prove "writes nothing". */
async function countRows(table: "games" | "game_events"): Promise<number> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `select count(*)::int as n from ${table}`,
      [],
    );
    return Number((rows[0] as { n: number }).n);
  });
}

/** Delete a game by id (cascades to teams/players/bars/events). Best-effort. */
async function deleteGame(gameId: string): Promise<void> {
  const { withTransaction } = await db();
  await withTransaction(async (tx) => {
    await tx.query(`delete from games where id = $1`, [gameId]);
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE_DB_CONFIGURED)(
  "create-game route — DB-backed create / lifecycle / Join_Code (Task 23.1)",
  () => {
    /** Ids of games this suite created, removed in afterAll. */
    const createdGameIds: string[] = [];

    afterAll(async () => {
      for (const id of createdGameIds) {
        try {
          await deleteGame(id);
        } catch {
          /* best-effort cleanup */
        }
      }
      // Reset the generator override so it never leaks to another suite.
      joinCodeOverride = null;
      if (serverDb) {
        await serverDb.closeDb();
      }
    });

    beforeAll(() => {
      joinCodeOverride = null;
    });

    it("creates a lobby game with one game_created event and returns { gameId, joinCode } (R1.1, R1.6, R1.8)", async () => {
      joinCodeOverride = null; // real generator: a fresh unique code.
      const adminSessionId = `it-admin-${randomUUID()}`;

      const { POST } = await route();
      const res = await POST(makeCreateRequest(adminSessionId));

      // --- Response: 201 with the structured applied shape (R1.8, R6.4) ---
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        applied: boolean;
        seq: number;
        gameId: string;
        joinCode: string;
      };
      expect(body.applied).toBe(true);
      expect(typeof body.gameId).toBe("string");
      expect(body.gameId.length).toBeGreaterThan(0);
      expect(typeof body.joinCode).toBe("string");
      // First event for the game → seq 1.
      expect(body.seq).toBe(1);

      createdGameIds.push(body.gameId);

      // --- Persistence: exactly one lobby game with the admin + code (R1.1) ---
      const { withTransaction } = await db();
      const persisted = await withTransaction(async (tx) => {
        const game = await tx.query(
          `select lifecycle, admin_session_id, join_code
             from games where id = $1`,
          [body.gameId],
        );
        const events = await tx.query(
          `select seq, event_type, actor_kind
             from game_events where game_id = $1 order by seq`,
          [body.gameId],
        );
        return { game: game.rows, events: events.rows };
      });

      expect(persisted.game).toHaveLength(1);
      const gameRow = persisted.game[0] as {
        lifecycle: string;
        admin_session_id: string;
        join_code: string;
      };
      expect(gameRow.lifecycle).toBe("lobby"); // R1.1
      expect(gameRow.admin_session_id).toBe(adminSessionId); // admin verbatim
      expect(gameRow.join_code).toBe(body.joinCode); // returned code persisted (R1.8)

      // --- Exactly one game_created event, in the same transaction (R1.6) ---
      expect(persisted.events).toHaveLength(1);
      const eventRow = persisted.events[0] as {
        seq: number;
        event_type: string;
        actor_kind: string;
      };
      expect(Number(eventRow.seq)).toBe(1);
      expect(eventRow.event_type).toBe("game_created");
      expect(eventRow.actor_kind).toBe("admin");
    });

    it("rejects a create with no session header (401) and writes nothing (R1.3)", async () => {
      joinCodeOverride = null;

      const gamesBefore = await countRows("games");
      const eventsBefore = await countRows("game_events");

      const { POST } = await route();
      const res = await POST(makeCreateRequest(/* no session */));

      expect(res.status).toBe(401);
      const body = (await res.json()) as { applied: boolean; error: string };
      expect(body.applied).toBe(false);
      expect(body.error).toBe("missing_session");

      // Nothing persisted: global counts unchanged (R1.3).
      const gamesAfter = await countRows("games");
      const eventsAfter = await countRows("game_events");
      expect(gamesAfter).toBe(gamesBefore);
      expect(eventsAfter).toBe(eventsBefore);
    });

    it("rolls back and returns 503 when every Join_Code attempt collides, writing nothing (R1.5, R1.7)", async () => {
      // Seed a game with a known code so every generated candidate collides on
      // the unique index. Use the real generator for this seed game only.
      joinCodeOverride = null;
      const collidingCode = `IT${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      const seedAdmin = `it-seed-${randomUUID()}`;

      const { withTransaction } = await db();
      const seedGameId = await withTransaction(async (tx) => {
        const { rows } = await tx.query(
          `insert into games (lifecycle, admin_session_id, join_code)
             values ('lobby', $1, $2) returning id`,
          [seedAdmin, collidingCode],
        );
        return String((rows[0] as { id: string }).id);
      });
      createdGameIds.push(seedGameId);

      // Now force the generator to ALWAYS return the seeded code, so all
      // MAX_CODE_GEN_ATTEMPTS inserts hit the unique-violation and the retry
      // loop exhausts.
      joinCodeOverride = () => collidingCode;

      const gamesBefore = await countRows("games");
      const eventsBefore = await countRows("game_events");

      const attemptAdmin = `it-collide-${randomUUID()}`;
      const { POST } = await route();
      const res = await POST(makeCreateRequest(attemptAdmin));

      // Restore the generator immediately so later assertions/cleanup are safe.
      joinCodeOverride = null;

      // Exhausted attempts → 503 code_generation_failed (R1.5).
      expect(res.status).toBe(503);
      const body = (await res.json()) as { applied: boolean; error: string };
      expect(body.applied).toBe(false);
      expect(body.error).toBe("code_generation_failed");

      // Nothing new persisted: the failed transaction rolled back (R1.5, R1.7).
      const gamesAfter = await countRows("games");
      const eventsAfter = await countRows("game_events");
      expect(gamesAfter).toBe(gamesBefore);
      expect(eventsAfter).toBe(eventsBefore);

      // Belt-and-suspenders: no game was created for the attempting admin.
      const stray = await withTransaction(async (tx) => {
        const { rows } = await tx.query(
          `select id from games where admin_session_id = $1`,
          [attemptAdmin],
        );
        return rows.length;
      });
      expect(stray).toBe(0);
    });
  },
);
