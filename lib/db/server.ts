/**
 * Server-only, transaction-capable database helper (design.md Component 2).
 *
 * `server-only` at the top of this module makes it a build-time error to import
 * it into any client component or browser bundle. Everything here uses the
 * privileged direct-Postgres connection string ({@link SERVER_DB_URL_VAR}) and
 * must never reach the client.
 *
 * Why a dedicated Postgres driver (not the Supabase JS client)? Task 10 requires
 * that a `Game_State_Change` and its single `game_event` are written **inside one
 * transaction** so they commit or roll back together (Req 4.3/4.4). The Supabase
 * REST/JS client issues independent HTTP requests with no shared transaction, so
 * it cannot provide that guarantee. The `postgres` (postgres.js) driver opens a
 * real Postgres connection and exposes `sql.begin(...)` for genuine transactions.
 *
 * This module exposes exactly what the event backbone (`lib/events`) and the
 * server routes need:
 *   - {@link withTransaction} — run a caller function inside one transaction,
 *     handing it a {@link QueryRunner} (the minimal `query(sql, params)` shape
 *     `appendEvent` consumes). Commit on normal return; roll back on any throw.
 *   - {@link getSql} — the lazily-created singleton client, for the rare
 *     non-transactional read.
 *   - {@link closeDb} — teardown for tests / graceful shutdown.
 *
 * Atomicity/rollback: postgres.js sends `BEGIN` when the `sql.begin` callback
 * starts and `COMMIT` when it resolves; if the callback throws (including a
 * failed `appendEvent` insert), it sends `ROLLBACK`, so no domain change persists
 * and the event log is unchanged (Req 4.4).
 */
import "server-only";

import postgres from "postgres";

import { requireServerDbUrl } from "@/lib/env";
import type { QueryRunner, SqlRow } from "@/lib/events";

/**
 * A `postgres.js` client/transaction handle. postgres.js is primarily a tagged-
 * template API; the piece we adapt is `sql.unsafe(query, params) -> Result[]`,
 * which runs a parameterized statement (with `$1, $2, ...` placeholders) and
 * resolves to an array of rows. We keep the type surface minimal and local so we
 * do not couple the rest of the codebase to the driver's types.
 */
type PgSql = postgres.Sql<Record<string, never>>;
type PgTransaction = postgres.TransactionSql<Record<string, never>>;

/**
 * The singleton client. postgres.js manages a connection pool internally, so one
 * instance is reused across requests (important on serverless, where a new
 * instance per invocation would exhaust connections).
 */
let sqlSingleton: PgSql | null = null;

/**
 * Return the lazily-created postgres.js client, creating it on first use from
 * {@link SERVER_DB_URL_VAR}. Throws {@link MissingDbUrlError} if that variable is
 * unset — this is the on-demand validation described in `lib/env` (the URL stays
 * out of the required startup set so DB-free deployments still boot).
 */
export function getSql(): PgSql {
  if (sqlSingleton === null) {
    const connectionString = requireServerDbUrl();
    sqlSingleton = postgres(connectionString, {
      // Server routes are the only writers; a small pool is enough for the
      // foundation and keeps serverless connection counts bounded.
      max: 5,
      // Keep types predictable for the QueryRunner adapter below.
      prepare: false,
    }) as PgSql;
  }
  return sqlSingleton;
}

/**
 * Wrap a postgres.js transaction handle as the {@link QueryRunner} that
 * `appendEvent` (and any domain write) expects: a single
 * `query(sql, params) -> { rows }` method that runs the statement **on this
 * transaction's connection**, so every call shares the same transaction.
 *
 * postgres.js `unsafe(query, params)` returns the rows array directly; we wrap it
 * in `{ rows }` to match {@link QueryRunner}. `unsafe` is used because the backbone
 * builds `$1, $2, ...` positional SQL strings; values are still passed as bound
 * parameters (not string-interpolated), so this is parameterized and not an
 * injection vector.
 */
function asQueryRunner(tx: PgTransaction): QueryRunner {
  return {
    async query(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<{ rows: SqlRow[] }> {
      const rows = (await tx.unsafe(
        sql,
        params as postgres.ParameterOrJSON<never>[],
      )) as unknown as SqlRow[];
      return { rows };
    },
  };
}

/**
 * Run `fn` inside a single database transaction and return its result.
 *
 * The callback receives a {@link QueryRunner} bound to the transaction's
 * connection. Every statement it runs — the domain write **and** the single
 * `appendEvent` — executes in that one transaction:
 *   - if `fn` returns normally, the transaction commits (state change + event
 *     both persist);
 *   - if `fn` throws (a failed event insert, a constraint violation, a lost
 *     connection), postgres.js issues `ROLLBACK`, so the domain change does not
 *     persist and the event log is unchanged (Req 4.3/4.4). The error propagates
 *     to the caller.
 *
 * @param fn work to perform inside the transaction, given a transaction-scoped
 *   {@link QueryRunner}.
 * @returns whatever `fn` resolves to.
 */
export async function withTransaction<T>(
  fn: (tx: QueryRunner) => Promise<T>,
): Promise<T> {
  const sql = getSql();
  // sql.begin resolves with the callback's return value and rolls back on throw.
  return sql.begin((tx) =>
    fn(asQueryRunner(tx as PgTransaction)),
  ) as Promise<T>;
}

/**
 * Close the database connection(s). Intended for test teardown and graceful
 * shutdown; after this, the next {@link getSql}/{@link withTransaction} recreates
 * the client.
 */
export async function closeDb(): Promise<void> {
  if (sqlSingleton !== null) {
    const sql = sqlSingleton;
    sqlSingleton = null;
    await sql.end({ timeout: 5 });
  }
}
