import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 12 — Schema verification for migration 0008 (players.team_id nullable).
 *
 * Two complementary layers, mirroring `migrationsSchema.test.ts`:
 *
 *   1. STATIC CHECK (always runs, no database):
 *      Parses the committed migration SQL as text and asserts that 0008 drops
 *      the `not null` on `players.team_id` (R10.1) and that the composite FK
 *      `players_team_fk (team_id, game_id) -> teams (id, game_id)` declared in
 *      0001 is left in place — 0008 touches only the nullability, never the FK
 *      (R10.2). This runs in the default `npm test` with no live dependency.
 *
 *   2. LIVE APPLY CHECK (env-gated, skips cleanly when SUPABASE_DB_URL is unset):
 *      Applies every migration in ascending order against a throwaway schema on
 *      a real Postgres, then queries the catalog to assert:
 *        * `players.team_id` is nullable (R10.1);
 *        * the composite FK still forces a NON-NULL team to belong to the
 *          player's own game — a null team_id is accepted, but a non-null
 *          team_id whose team is in a *different* game is rejected (R10.2);
 *        * an existing player's team association survives the alter (R10.3).
 *
 * Validates: Requirements 10.1, 10.2, 10.3.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// supabase/__tests__ -> supabase -> project root
const PROJECT_ROOT = join(HERE, "..", "..");
const MIGRATIONS = join(PROJECT_ROOT, "supabase", "migrations");

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

/** Strip line (`-- ...`) comments so keyword scans ignore prose in headers. */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

// ---------------------------------------------------------------------------
// Static check — always runs, no database
// ---------------------------------------------------------------------------

describe("migration 0008 — players.team_id nullable (static, Req 10.1/10.2)", () => {
  const migration = readMigration("0008_players_team_nullable.sql");
  const core = readMigration("0001_core_game_schema.sql");

  it("drops the not-null constraint on players.team_id (R10.1)", () => {
    const code = stripSqlComments(migration).replace(/\s+/g, " ");
    expect(
      /alter\s+table\s+players\s+alter\s+column\s+team_id\s+drop\s+not\s+null/i.test(
        code,
      ),
      "0008 should drop not null on players.team_id",
    ).toBe(true);
  });

  it("is wrapped in a single begin/commit transaction", () => {
    const code = stripSqlComments(migration);
    expect([...code.matchAll(/\bbegin\s*;/gi)]).toHaveLength(1);
    expect([...code.matchAll(/\bcommit\s*;/gi)]).toHaveLength(1);
  });

  it("does not alter or drop the players_team_fk composite FK (R10.2)", () => {
    const code = stripSqlComments(migration).toLowerCase();
    // The migration only touches nullability — it must not redefine, drop, or
    // re-add the composite FK that keeps a player's team in the same game.
    expect(code.includes("players_team_fk")).toBe(false);
    expect(/drop\s+constraint/i.test(code)).toBe(false);
    expect(/add\s+constraint/i.test(code)).toBe(false);
  });

  it("relies on the composite FK from 0001 still requiring same-game teams (R10.2)", () => {
    // Sanity-check the retained FK is the composite (team_id, game_id) -> teams
    // (id, game_id) form, which is what enforces a non-null team belonging to
    // the player's own game.
    const code = stripSqlComments(core).replace(/\s+/g, " ");
    expect(
      /constraint\s+players_team_fk\s+foreign\s+key\s*\(\s*team_id\s*,\s*game_id\s*\)\s*references\s+teams\s*\(\s*id\s*,\s*game_id\s*\)/i.test(
        code,
      ),
      "0001 declares the composite players_team_fk that 0008 retains",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live apply check — env-gated, skips cleanly when SUPABASE_DB_URL is unset
// ---------------------------------------------------------------------------
//
// `lib/db/server.ts` imports `server-only`, which only resolves inside the
// Next.js bundler, so it is loaded LAZILY (dynamic import) — when this suite is
// skipped the module is never evaluated and the default `npm test` run stays
// green outside a Next build. Mirrors the gating in `migrationsSchema.test.ts`.

const DB_URL = process.env.SUPABASE_DB_URL?.trim();
const LIVE_DB_CONFIGURED = Boolean(DB_URL);

type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

/** Load every committed migration ordered by numeric prefix. */
function loadMigrationSqls(): string[] {
  const re = /^(\d+)_.+\.sql$/;
  return readdirSync(MIGRATIONS)
    .filter((f) => re.test(f))
    .sort((a, b) => Number(a.match(re)![1]) - Number(b.match(re)![1]))
    .map((f) => readMigration(f));
}

describe.skipIf(!LIVE_DB_CONFIGURED)(
  "migration 0008 applies against a live Postgres (Req 10.1/10.2/10.3)",
  () => {
    const TEST_SCHEMA = `bbb_team_nullable_${Date.now()}`;

    afterAll(async () => {
      if (!serverDb) return;
      try {
        const { withTransaction } = serverDb;
        await withTransaction(async (tx) => {
          await tx.query(`drop schema if exists ${TEST_SCHEMA} cascade`, []);
          return undefined;
        });
      } catch {
        /* best-effort cleanup */
      }
      await serverDb.closeDb();
    });

    it("makes players.team_id nullable, keeps the same-game FK, and preserves associations", async () => {
      const migrations = loadMigrationSqls();
      const { withTransaction } = await db();

      await withTransaction(async (tx) => {
        await tx.query(`drop schema if exists ${TEST_SCHEMA} cascade`, []);
        await tx.query(`create schema ${TEST_SCHEMA}`, []);
        await tx.query(`set local search_path = ${TEST_SCHEMA}, public`, []);

        for (const sql of migrations) {
          await tx.query(sql, []);
        }

        // --- R10.1: players.team_id is nullable ---
        const col = await tx.query(
          `select is_nullable
             from information_schema.columns
            where table_schema = $1
              and table_name = 'players'
              and column_name = 'team_id'`,
          [TEST_SCHEMA],
        );
        expect(col.rows).toHaveLength(1);
        expect(
          String((col.rows[0] as { is_nullable: string }).is_nullable),
        ).toBe("YES");

        // --- The composite FK players_team_fk still exists ---
        const fk = await tx.query(
          `select conname
             from pg_constraint c
             join pg_namespace n on n.oid = c.connamespace
            where n.nspname = $1
              and c.conname = 'players_team_fk'
              and c.contype = 'f'`,
          [TEST_SCHEMA],
        );
        expect(fk.rows).toHaveLength(1);

        // Seed two games, each with a team, to exercise the FK behavior.
        const gA = await tx.query(
          `insert into games (admin_session_id, join_code) values ('adminA', 'CODEAAA') returning id`,
          [],
        );
        const gB = await tx.query(
          `insert into games (admin_session_id, join_code) values ('adminB', 'CODEBBB') returning id`,
          [],
        );
        const gameA = (gA.rows[0] as { id: string }).id;
        const gameB = (gB.rows[0] as { id: string }).id;

        const tA = await tx.query(
          `insert into teams (game_id, name, color) values ($1, 'A', 'red') returning id`,
          [gameA],
        );
        const tB = await tx.query(
          `insert into teams (game_id, name, color) values ($1, 'B', 'blue') returning id`,
          [gameB],
        );
        const teamA = (tA.rows[0] as { id: string }).id;
        const teamB = (tB.rows[0] as { id: string }).id;

        // R10.1: a teamless player (team_id = null) is accepted.
        await tx.query(
          `insert into players (team_id, game_id, session_id, display_name)
             values (null, $1, 'sess-teamless', 'Teamless')`,
          [gameA],
        );

        // R10.2 (positive): a non-null team in the SAME game is accepted, and
        // the association is preserved (R10.3 — the row keeps its team_id).
        const withTeam = await tx.query(
          `insert into players (team_id, game_id, session_id, display_name)
             values ($1, $2, 'sess-teamed', 'Teamed') returning id, team_id`,
          [teamA, gameA],
        );
        expect(String((withTeam.rows[0] as { team_id: string }).team_id)).toBe(
          teamA,
        );

        // R10.2 (negative): a non-null team from a DIFFERENT game is rejected
        // by the composite FK — the team must belong to the player's own game.
        await expect(
          tx.query(
            `insert into players (team_id, game_id, session_id, display_name)
               values ($1, $2, 'sess-crossgame', 'CrossGame')`,
            [teamB, gameA],
          ),
        ).rejects.toThrow();

        return undefined;
      });
    });
  },
);
