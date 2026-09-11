/**
 * Task 18.5 — RLS cross-game denial (ENVIRONMENT-DEPENDENT integration test).
 *
 * Proves the live counterpart of Property 14's data-access half (see
 * `lib/realtime/isolation.property.test.ts`): a session scoped to game A is
 * denied read AND write on game B's rows by Row-Level Security in the real
 * database, and game B's data is left unchanged (Req 7.2). This exercises the
 * policies defined in `supabase/migrations/0006_rls_policies.sql` against a live
 * Postgres instance rather than an in-memory model.
 *
 * -------------------------------------------------------------------------
 * How it works, end to end (all over the direct `SUPABASE_DB_URL` connection):
 * -------------------------------------------------------------------------
 *   1. SETUP (privileged / RLS-bypassing owner role): create two distinct
 *      games A and B, and for each a team + a player row. The player's
 *      `session_id` is what the RLS membership check (`bbb_is_game_member`) keys
 *      off. `withTransaction` (lib/db/server.ts) connects as the migration/owner
 *      role, which is not subject to RLS, so setup and privileged verification
 *      reads always succeed.
 *
 *   2. SCOPE A SESSION TO GAME A: inside a transaction we adopt the RLS-subject
 *      role and the game-A session using the migration's GUC fallback:
 *          set local role anon;                        -- always subject to RLS
 *          set local bbb.session_id = '<A's player session>';
 *      `bbb_current_session_id()` reads `bbb.session_id` (its documented fallback
 *      when no Supabase JWT is present), and `bbb_is_game_member(game_id)` then
 *      returns true only for game A. This faithfully simulates a browser/anon
 *      session that has joined game A.
 *
 *   3. CROSS-GAME READS ARE DENIED: as that A-scoped session, selecting game B's
 *      rows (games, teams, players, bars, game_events) returns ZERO rows — RLS
 *      filters them out entirely (a denied read surfaces as "no rows", not an
 *      error). A control read of game A's own rows returns them, proving the
 *      session is not simply blind to everything.
 *
 *   4. CROSS-GAME WRITES ARE DENIED: as that A-scoped session, attempting to
 *      UPDATE / DELETE game B's rows affects ZERO rows (the USING clause hides
 *      them), and attempting to INSERT a new row into game B (a game_id the
 *      session is not a member of) is rejected by the WITH CHECK clause and
 *      raises. Either way, nothing in game B changes.
 *
 *   5. B IS UNCHANGED: a privileged (owner-role) read of game B's rows taken
 *      before and after the A-scoped attempts is byte-for-byte identical,
 *      confirming the denied operations had no effect (Req 7.2).
 *
 * Why the GUC path (not a real Supabase JWT)? The migration documents
 * `bbb.session_id` as the supported fallback for "a bare Postgres (or a trusted
 * server route that wants to impersonate a session with `set local`)". Driving
 * RLS this way keeps the test self-contained over the direct DB connection with
 * no auth/JWT minting, while exercising the exact policy predicates
 * (`bbb_is_game_member`) that guard every game-scoped table.
 *
 * ---------------------------------------------------------------------------
 * REQUIRED ENVIRONMENT (test SKIPS cleanly when any is unset)
 * ---------------------------------------------------------------------------
 *   SUPABASE_DB_URL               Direct Postgres connection string (the
 *                                 project's connection-pooler / session URL).
 *                                 Used for BOTH privileged setup and the
 *                                 `set local role anon` scoped attempts. The
 *                                 role this connects as MUST NOT have BYPASSRLS
 *                                 for the `set local role anon` step to be
 *                                 meaningful (the default postgres/owner role is
 *                                 fine — it owns the tables and is used only for
 *                                 setup; the scoped block downgrades to `anon`).
 *   NEXT_PUBLIC_SUPABASE_URL      Supabase project URL. Not strictly used by the
 *                                 DB-only assertions, but required per task 18.5
 *                                 gating so this file only runs against a fully
 *                                 configured live environment.
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY Supabase anon key. Same rationale as above.
 *
 * APPLIED-MIGRATIONS REQUIREMENT
 *   The target database MUST have migrations 0001–0006 applied, in particular
 *   `0006_rls_policies.sql` (the RLS model under test: `bbb_current_session_id`
 *   via `request.jwt.claims` sub or the `bbb.session_id` GUC, `bbb_is_game_member`,
 *   and the per-game policies). Without RLS enabled the cross-game reads would
 *   return rows and this test would (correctly) fail.
 *
 * RUN INSTRUCTIONS
 *   # against a local Supabase stack (supabase start) or a hosted project:
 *   SUPABASE_DB_URL=postgres://postgres:...@127.0.0.1:5432/postgres \
 *   NEXT_PUBLIC_SUPABASE_URL=... \
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *   npm test -- supabase/__tests__/integration/rlsCrossGame.integration.test.ts
 *
 * With none of these set, `npm test` skips this file (describe.skipIf), so the
 * default suite stays green with no live dependency.
 *
 * Validates: Requirements 7.2.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import type { QueryRunner } from "@/lib/events";

// NOTE: `lib/db/server.ts` imports `server-only`, which only resolves inside the
// Next.js bundler. It is therefore loaded LAZILY (dynamic import, below) so that
// when this suite is skipped (no live env) the module is never evaluated and the
// default `npm test` run stays green outside a Next build.
type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

// ---------------------------------------------------------------------------
// Env gating: skip cleanly unless a live instance is configured.
// ---------------------------------------------------------------------------

const DB_URL = process.env.SUPABASE_DB_URL?.trim();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

const LIVE_ENV_CONFIGURED = Boolean(DB_URL && SUPABASE_URL && ANON_KEY);

// ---------------------------------------------------------------------------
// Fixture shape: one game with a member session, a team, a bar, and one event.
// ---------------------------------------------------------------------------

interface GameFixture {
  readonly gameId: string;
  /** A players.session_id that is a member of this game (drives RLS membership). */
  readonly sessionId: string;
  readonly teamId: string;
  readonly barId: string;
  /** id of a game_events row belonging to this game. */
  readonly eventId: string;
}

/**
 * Create a fully populated game over the privileged (RLS-bypassing) connection:
 * a games row, a team, a player (whose session_id becomes the RLS membership
 * key), a bar, and a single game_events row. Returns the ids needed to target
 * this game's rows from a differently-scoped session.
 */
async function createGameFixture(): Promise<GameFixture> {
  const adminSessionId = `it-admin-${randomUUID()}`;
  const memberSessionId = `it-member-${randomUUID()}`;
  const joinCode = `it-${randomUUID()}`;

  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const game = await tx.query(
      `insert into games (admin_session_id, join_code)
       values ($1, $2)
       returning id`,
      [adminSessionId, joinCode],
    );
    const gameId = String(game.rows[0]?.id);

    const team = await tx.query(
      `insert into teams (game_id, name, color)
       values ($1, $2, $3)
       returning id`,
      [gameId, "RLS Fixture Team", "#123456"],
    );
    const teamId = String(team.rows[0]?.id);

    // The player's session_id is the membership key the RLS policies read.
    await tx.query(
      `insert into players (team_id, game_id, session_id, display_name)
       values ($1, $2, $3, $4)`,
      [teamId, gameId, memberSessionId, "RLS Fixture Player"],
    );

    const bar = await tx.query(
      `insert into bars (game_id, name)
       values ($1, $2)
       returning id`,
      [gameId, "RLS Fixture Bar"],
    );
    const barId = String(bar.rows[0]?.id);

    const event = await tx.query(
      `insert into game_events (game_id, seq, event_type, actor_kind, payload)
       values ($1, 1, 'rls_fixture', 'system', $2::jsonb)
       returning id`,
      [gameId, JSON.stringify({ marker: "fixture" })],
    );
    const eventId = String(event.rows[0]?.id);

    return { gameId, sessionId: memberSessionId, teamId, barId, eventId };
  });
}

/** Delete a game (cascades to teams/players/bars/events) — best-effort cleanup. */
async function deleteGame(gameId: string): Promise<void> {
  const { withTransaction } = await db();
  await withTransaction(async (tx) => {
    await tx.query(`delete from games where id = $1`, [gameId]);
    return undefined;
  });
}

/**
 * Run `fn` in a transaction scoped to `sessionId` as the RLS-subject `anon`
 * role, using the migration's `bbb.session_id` GUC fallback. `set local`
 * confines both the role and the GUC to this transaction, so the connection is
 * clean afterwards. The role is downgraded to `anon` so RLS is actually
 * enforced (the owner/service role would bypass it).
 */
async function asGameSession<T>(
  sessionId: string,
  fn: (tx: QueryRunner) => Promise<T>,
): Promise<T> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    await tx.query(`set local role anon`, []);
    // set_config(name, value, is_local=true) parameterizes the GUC value safely.
    await tx.query(`select set_config('bbb.session_id', $1, true)`, [
      sessionId,
    ]);
    return fn(tx);
  });
}

/**
 * Privileged snapshot of everything that identifies game B's rows, used to prove
 * B is unchanged across the A-scoped denial attempts. Runs as the owner role
 * (RLS-bypassing), so it always sees B in full.
 */
interface GameSnapshot {
  readonly game: unknown;
  readonly team: unknown;
  readonly player: unknown;
  readonly bar: unknown;
  readonly event: unknown;
  readonly eventCount: number;
}

async function snapshotGame(gameId: string): Promise<GameSnapshot> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const game = await tx.query(`select * from games where id = $1`, [gameId]);
    const team = await tx.query(`select * from teams where game_id = $1`, [
      gameId,
    ]);
    const player = await tx.query(`select * from players where game_id = $1`, [
      gameId,
    ]);
    const bar = await tx.query(`select * from bars where game_id = $1`, [
      gameId,
    ]);
    const event = await tx.query(
      `select * from game_events where game_id = $1 order by seq`,
      [gameId],
    );
    return {
      game: game.rows[0] ?? null,
      team: team.rows[0] ?? null,
      player: player.rows[0] ?? null,
      bar: bar.rows[0] ?? null,
      event: event.rows[0] ?? null,
      eventCount: event.rows.length,
    };
  });
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE_ENV_CONFIGURED)(
  "RLS cross-game denial (Task 18.5, Req 7.2)",
  () => {
    let gameA: GameFixture;
    let gameB: GameFixture;

    beforeAll(async () => {
      gameA = await createGameFixture();
      gameB = await createGameFixture();
    });

    afterAll(async () => {
      // Best-effort cleanup; ignore failures so teardown never masks results.
      try {
        if (gameA?.gameId) await deleteGame(gameA.gameId);
      } catch {
        /* ignore */
      }
      try {
        if (gameB?.gameId) await deleteGame(gameB.gameId);
      } catch {
        /* ignore */
      }
      if (serverDb) {
        await serverDb.closeDb();
      }
    });

    it("denies a game-A session all reads of game B's rows (control: A is visible)", async () => {
      const rowCounts = await asGameSession(gameA.sessionId, async (tx) => {
        // Sanity: bbb_current_session_id resolves to A's session via the GUC.
        const sid = await tx.query(
          `select bbb_current_session_id() as sid`,
          [],
        );
        expect(String(sid.rows[0]?.sid)).toBe(gameA.sessionId);

        // Cross-game reads of B: every game-scoped table returns ZERO rows.
        const bGames = await tx.query(`select id from games where id = $1`, [
          gameB.gameId,
        ]);
        const bTeams = await tx.query(
          `select id from teams where game_id = $1`,
          [gameB.gameId],
        );
        const bPlayers = await tx.query(
          `select id from players where game_id = $1`,
          [gameB.gameId],
        );
        const bBars = await tx.query(`select id from bars where game_id = $1`, [
          gameB.gameId,
        ]);
        const bEvents = await tx.query(
          `select id from game_events where game_id = $1`,
          [gameB.gameId],
        );

        // Control: the same session CAN read its own game A rows.
        const aGames = await tx.query(`select id from games where id = $1`, [
          gameA.gameId,
        ]);
        const aEvents = await tx.query(
          `select id from game_events where game_id = $1`,
          [gameA.gameId],
        );

        return {
          bGames: bGames.rows.length,
          bTeams: bTeams.rows.length,
          bPlayers: bPlayers.rows.length,
          bBars: bBars.rows.length,
          bEvents: bEvents.rows.length,
          aGames: aGames.rows.length,
          aEvents: aEvents.rows.length,
        };
      });

      // Denied cross-game reads surface as "no rows".
      expect(rowCounts.bGames).toBe(0);
      expect(rowCounts.bTeams).toBe(0);
      expect(rowCounts.bPlayers).toBe(0);
      expect(rowCounts.bBars).toBe(0);
      expect(rowCounts.bEvents).toBe(0);

      // Control proves the session is scoped, not blind: it sees game A.
      expect(rowCounts.aGames).toBe(1);
      expect(rowCounts.aEvents).toBe(1);
    });

    it("denies a game-A session all writes to game B's rows, leaving B unchanged", async () => {
      const before = await snapshotGame(gameB.gameId);

      // --- RLS-only tables: UPDATE / DELETE are hidden by the USING clause =>
      // they affect zero rows (no error). game_events is deliberately NOT in this
      // batch: it is append-only and has UPDATE/DELETE REVOKEd from anon (0003),
      // so a cross-game write there raises `permission denied` rather than
      // affecting zero rows. Running it here would abort this whole transaction
      // and contaminate the other assertions, so it is checked separately below.
      const affected = await asGameSession(gameA.sessionId, async (tx) => {
        // UPDATE B's team name — RLS hides the row, so no rows are updated.
        const upTeam = await tx.query(
          `update teams set name = 'HACKED' where id = $1 returning id`,
          [gameB.teamId],
        );
        // UPDATE B's bar name.
        const upBar = await tx.query(
          `update bars set name = 'HACKED' where id = $1 returning id`,
          [gameB.barId],
        );
        // UPDATE B's game (lifecycle) — also blocked.
        const upGame = await tx.query(
          `update games set admin_session_id = 'HACKED' where id = $1 returning id`,
          [gameB.gameId],
        );
        // DELETE B's bar.
        const delBar = await tx.query(
          `delete from bars where id = $1 returning id`,
          [gameB.barId],
        );

        return {
          upTeam: upTeam.rows.length,
          upBar: upBar.rows.length,
          upGame: upGame.rows.length,
          delBar: delBar.rows.length,
        };
      });

      // Every UPDATE/DELETE against B's RLS-only tables affected zero rows
      // (RLS USING clause hid the row).
      expect(affected.upTeam).toBe(0);
      expect(affected.upBar).toBe(0);
      expect(affected.upGame).toBe(0);
      expect(affected.delBar).toBe(0);

      // --- game_events cross-game write: DENIED at the privilege layer. ---
      // Unlike the RLS-only tables above, game_events has UPDATE/DELETE REVOKEd
      // from anon (0003, append-only enforcement), so a cross-game DELETE raises
      // `permission denied` instead of quietly affecting zero rows. Run it in its
      // OWN transaction so the rejection cannot contaminate the assertions above,
      // and confirm it is rejected. B's event therefore survives, keeping the
      // snapshot comparison below valid.
      await expect(
        asGameSession(gameA.sessionId, (tx) =>
          tx.query(`delete from game_events where id = $1`, [gameB.eventId]),
        ),
      ).rejects.toThrow();

      // --- INSERT into B: rejected by the WITH CHECK clause => raises. ---
      await expect(
        asGameSession(gameA.sessionId, async (tx) => {
          await tx.query(`insert into bars (game_id, name) values ($1, $2)`, [
            gameB.gameId,
            "INJECTED",
          ]);
          return undefined;
        }),
      ).rejects.toThrow();

      // --- B is byte-for-byte unchanged after all denied attempts. ---
      const after = await snapshotGame(gameB.gameId);
      expect(after).toEqual(before);
      expect(after.eventCount).toBe(before.eventCount);
    });
  },
);
