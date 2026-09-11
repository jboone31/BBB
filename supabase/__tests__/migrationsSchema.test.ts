import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 19.3 — Migrations-apply and schema smoke check.
 *
 * Two complementary layers of coverage for the committed migration set
 * (Req 3.14: the Data_Schema is created and modified through committed migration
 * files applied in ascending order against the Backend_Platform):
 *
 *   1. STATIC SMOKE CHECK (always runs, no database):
 *      Parses the committed `supabase/migrations/*.sql` files as text and asserts
 *      that they are present, numbered in ascending order with no gaps, each
 *      wrapped in a begin/commit transaction, and that the UNION of their
 *      `create table` / `create type` statements declares the expected tables and
 *      enums. It also asserts a handful of representative constraints are present
 *      (unique (game_id, seq) on game_events, unique (game_id, team_id, bar_id) on
 *      claims, the payload <= 16 KB check). This gives schema coverage without a
 *      live database, so the default `npm test` run always exercises it.
 *
 *   2. LIVE APPLY CHECK (env-gated, skips cleanly when absent):
 *      When SUPABASE_DB_URL points at a real Postgres, applies every migration in
 *      ascending order inside one transaction against a throwaway schema, then
 *      queries the catalog to assert the expected tables, enums, and key
 *      constraints actually exist. Gated with `describe.skipIf(!SUPABASE_DB_URL)`
 *      so it is a no-op in the default suite (no live dependency).
 *
 * Validates: Requirements 3.14.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// supabase/__tests__ -> supabase -> project root
const PROJECT_ROOT = join(HERE, "..", "..");
const MIGRATIONS_DIR = join(PROJECT_ROOT, "supabase", "migrations");

// ---------------------------------------------------------------------------
// Expected schema surface (source of truth for both the static and live checks)
// ---------------------------------------------------------------------------

/** Tables the migration set must declare across all files. */
const EXPECTED_TABLES = [
  "games",
  "teams",
  "players",
  "bars",
  "claims",
  "card_definitions",
  "card_instances",
  "card_plays",
  "game_events",
] as const;

/** Enum types the migration set must declare across all files. */
const EXPECTED_ENUMS = [
  "game_lifecycle",
  "game_end_reason",
  "card_type",
  "card_instance_state",
  "event_actor_kind",
] as const;

// ---------------------------------------------------------------------------
// Migration file loading + parsing helpers (static check)
// ---------------------------------------------------------------------------

interface MigrationFile {
  readonly file: string;
  /** Leading numeric prefix, e.g. 0001 -> 1. */
  readonly seq: number;
  readonly sql: string;
}

const MIGRATION_NAME_RE = /^(\d+)_.+\.sql$/;

/**
 * Load every committed migration, ordered by its numeric prefix. Only files
 * matching `NNNN_name.sql` are considered migrations.
 */
function loadMigrations(): MigrationFile[] {
  const entries = readdirSync(MIGRATIONS_DIR)
    .filter((f) => MIGRATION_NAME_RE.test(f))
    .map((file) => {
      const match = file.match(MIGRATION_NAME_RE);
      const seq = Number(match?.[1]);
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      return { file, seq, sql };
    });
  entries.sort((a, b) => a.seq - b.seq);
  return entries;
}

/** Strip line (`-- ...`) comments so keyword scans ignore prose in headers. */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/**
 * Extract every table name declared with `create table <name>` in a SQL string.
 * Tolerates an optional `if not exists` and schema-qualified names.
 */
function parseCreatedTables(sql: string): string[] {
  const code = stripSqlComments(sql);
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][\w.]*)/gi;
  return [...code.matchAll(re)].map((m) => stripSchema(m[1]));
}

/**
 * Extract every enum type name declared with `create type <name> as enum`.
 */
function parseCreatedEnums(sql: string): string[] {
  const code = stripSqlComments(sql);
  const re = /create\s+type\s+([A-Za-z_][\w.]*)\s+as\s+enum/gi;
  return [...code.matchAll(re)].map((m) => stripSchema(m[1]));
}

function stripSchema(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

// ---------------------------------------------------------------------------
// Static smoke check — always runs, no database
// ---------------------------------------------------------------------------

describe("migration files — static schema smoke check (Req 3.14)", () => {
  const migrations = loadMigrations();

  it("includes the committed migration set (at least the 7 foundation migrations)", () => {
    expect(migrations.length).toBeGreaterThanOrEqual(7);
    // The known foundation set (0001..0007) must all be present by name.
    const names = migrations.map((m) => m.file);
    expect(names).toEqual(
      expect.arrayContaining([
        "0001_core_game_schema.sql",
        "0002_claims.sql",
        "0003_game_events.sql",
        "0004_cards.sql",
        "0005_seed_card_catalog.sql",
        "0006_rls_policies.sql",
        "0007_auto_timeout_sweep.sql",
      ]),
    );
  });

  it("numbers migrations in ascending order with no gaps, starting at 1", () => {
    const seqs = migrations.map((m) => m.seq);

    // Ascending and unique.
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    expect(new Set(seqs).size).toBe(seqs.length);

    // Contiguous 1..N (no gaps).
    expect(seqs[0]).toBe(1);
    expect(seqs[seqs.length - 1]).toBe(seqs.length);
    seqs.forEach((seq, idx) => {
      expect(seq).toBe(idx + 1);
    });
  });

  it("wraps every migration in a begin/commit transaction", () => {
    // The transaction wrapper is a top-level `begin;` / `commit;` STATEMENT
    // (semicolon-terminated). This deliberately ignores PL/pgSQL block
    // delimiters (`begin ... end;` inside function bodies, as in 0003/0007),
    // which are not statement terminators, so nested blocks do not inflate the
    // count.
    const beginStmt = /\bbegin\s*;/gi;
    const commitStmt = /\bcommit\s*;/gi;

    for (const m of migrations) {
      const code = stripSqlComments(m.sql);
      const begins = [...code.matchAll(beginStmt)];
      const commits = [...code.matchAll(commitStmt)];

      expect(
        begins.length,
        `${m.file} should open a transaction (begin;)`,
      ).toBe(1);
      expect(
        commits.length,
        `${m.file} should close a transaction (commit;)`,
      ).toBe(1);

      // The transaction opens before it closes, and it opens at the very start
      // of the file's executable SQL (the first statement).
      expect(
        (begins[0].index ?? Infinity) < (commits[0].index ?? -1),
        `${m.file}: begin must precede commit`,
      ).toBe(true);
      expect(
        code.slice(0, begins[0].index).trim(),
        `${m.file}: begin must be the first statement`,
      ).toBe("");
    }
  });

  it("declares every expected table across the union of migrations", () => {
    const declared = new Set(
      migrations.flatMap((m) => parseCreatedTables(m.sql)),
    );
    for (const table of EXPECTED_TABLES) {
      expect(declared.has(table), `missing create table "${table}"`).toBe(true);
    }
  });

  it("declares every expected enum across the union of migrations", () => {
    const declared = new Set(
      migrations.flatMap((m) => parseCreatedEnums(m.sql)),
    );
    for (const enumName of EXPECTED_ENUMS) {
      expect(declared.has(enumName), `missing create type "${enumName}"`).toBe(
        true,
      );
    }
  });

  it("declares the representative key constraints", () => {
    const union = stripSqlComments(
      migrations.map((m) => m.sql).join("\n"),
    ).replace(/\s+/g, " ");

    // game_events: unique (game_id, seq).
    expect(
      /unique\s*\(\s*game_id\s*,\s*seq\s*\)/i.test(union),
      "game_events unique (game_id, seq)",
    ).toBe(true);

    // claims: unique (game_id, team_id, bar_id).
    expect(
      /unique\s*\(\s*game_id\s*,\s*team_id\s*,\s*bar_id\s*\)/i.test(union),
      "claims unique (game_id, team_id, bar_id)",
    ).toBe(true);

    // game_events: payload <= 16 KB check (16384 bytes).
    expect(
      /pg_column_size\s*\(\s*payload\s*\)\s*<=\s*16384/i.test(union),
      "game_events payload <= 16 KB check",
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
// green outside a Next build. This mirrors the gating in the integration tests
// under `supabase/__tests__/integration/`.

const DB_URL = process.env.SUPABASE_DB_URL?.trim();
const LIVE_DB_CONFIGURED = Boolean(DB_URL);

type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

describe.skipIf(!LIVE_DB_CONFIGURED)(
  "migrations apply against a live Postgres (Req 3.14)",
  () => {
    // Unique throwaway schema so the apply/inspect never touches real data and
    // is cleaned up afterward. Only alphanumerics -> safe to interpolate.
    const TEST_SCHEMA = `bbb_mig_smoke_${Date.now()}`;

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

    it("applies all migrations in order and creates the expected tables, enums, and constraints", async () => {
      const migrations = loadMigrations();
      const { withTransaction } = await db();

      await withTransaction(async (tx) => {
        // Isolate the apply in a throwaway schema. `set local search_path`
        // scopes unqualified object creation to it, and public is kept on the
        // path so extensions/helpers (pgcrypto, auth guards) still resolve.
        await tx.query(`drop schema if exists ${TEST_SCHEMA} cascade`, []);
        await tx.query(`create schema ${TEST_SCHEMA}`, []);
        await tx.query(`set local search_path = ${TEST_SCHEMA}, public`, []);

        // Apply each migration body in ascending order. The files already carry
        // begin/commit; inside this outer transaction those are treated as no-op
        // savepoints by postgres, so the statements simply run in sequence.
        for (const migration of migrations) {
          await tx.query(migration.sql, []);
        }

        // --- Tables exist in the test schema ---
        const tables = await tx.query(
          `select table_name
             from information_schema.tables
            where table_schema = $1`,
          [TEST_SCHEMA],
        );
        const tableNames = new Set(
          tables.rows.map((r) =>
            String((r as { table_name: string }).table_name),
          ),
        );
        for (const expected of EXPECTED_TABLES) {
          expect(tableNames.has(expected), `table ${expected}`).toBe(true);
        }

        // --- Enums exist in the test schema ---
        const enums = await tx.query(
          `select t.typname
             from pg_type t
             join pg_namespace n on n.oid = t.typnamespace
            where n.nspname = $1
              and t.typtype = 'e'`,
          [TEST_SCHEMA],
        );
        const enumNames = new Set(
          enums.rows.map((r) => String((r as { typname: string }).typname)),
        );
        for (const expected of EXPECTED_ENUMS) {
          expect(enumNames.has(expected), `enum ${expected}`).toBe(true);
        }

        // --- Representative constraints exist ---
        const constraints = await tx.query(
          `select conname
             from pg_constraint c
             join pg_namespace n on n.oid = c.connamespace
            where n.nspname = $1`,
          [TEST_SCHEMA],
        );
        const constraintNames = new Set(
          constraints.rows.map((r) =>
            String((r as { conname: string }).conname),
          ),
        );
        // Named constraints from the migrations.
        expect(
          constraintNames.has("game_events_game_seq_unique"),
          "game_events unique (game_id, seq)",
        ).toBe(true);
        expect(
          constraintNames.has("claims_game_team_bar_unique"),
          "claims unique (game_id, team_id, bar_id)",
        ).toBe(true);
        expect(
          constraintNames.has("game_events_payload_max_16kb"),
          "game_events payload <= 16 KB check",
        ).toBe(true);

        return undefined;
      });
    });
  },
);
