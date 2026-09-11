/**
 * Server-side auto-timeout sweep entrypoint (design.md "Auto-timeout trigger
 * mechanism", scheduled sweep — recommended; Task 10.3).
 *
 * This is the application-side counterpart to the pure SQL sweep in
 * `supabase/migrations/0007_auto_timeout_sweep.sql`. Both implement the SAME
 * authoritative trigger for Requirement 5.2 ("12h after `live_started_at`, a
 * live game auto-ends") and both drive the SAME atomic end transition
 * (Req 5.3). You need only one to be active; this one exists so the timeout can
 * be triggered from Node (a Supabase scheduled Edge Function, a Vercel Cron
 * job, or any external scheduler hitting `POST /api/cron/auto-timeout`) when
 * pg_cron is not used.
 *
 * How it reuses the atomic end transition:
 *   `runAutoTimeoutSweep` selects the currently-due live games (those with
 *   `live_started_at` older than 12h relative to `now`, via `isDueForAutoTimeout`
 *   / `AUTO_TIMEOUT_MS`), then for EACH due game opens its own transaction and
 *   calls `endGame(tx, { gameId, endReason: 'auto_timeout' })` — the exact same
 *   guarded, atomic `ended` + `end_reason` write plus one `game_event` that the
 *   admin-end path uses (Task 10.2). One transaction per game means one game's
 *   failure rolls back only that game and the sweep continues with the rest.
 *
 * Why per-game transactions (not one big transaction): a sweep may touch many
 * games; ending them independently keeps each end atomic on its own (Req 5.3)
 * and prevents a single bad game (e.g. a transient lock conflict) from aborting
 * the entire run. `endGame` is itself guarded by `canEndGame`, so a game that
 * was ended by another path between selection and the transaction is simply a
 * no-op end (rejected, leaving lifecycle/end_reason unchanged, Req 5.4/5.5).
 *
 * Dependency injection: data access is injected (`listDueLiveGames`,
 * `withTransaction`, `endGame`) so this module typechecks and unit-tests with no
 * live database and does not hard-depend on the concrete Postgres wiring. The
 * cron route supplies the real implementations (`lib/db/server.ts`
 * `withTransaction`, `lib/gameend/transition.ts` `endGame`).
 *
 * Requirements: 5.2, 5.3.
 */
import type { QueryRunner } from "@/lib/events";

import { AUTO_TIMEOUT_MS, isDueForAutoTimeout } from "./index";
import type { EndReason } from "./index";

/** The `end_reason` every game this sweep ends is recorded with (Req 5.2). */
export const AUTO_TIMEOUT_END_REASON: EndReason = "auto_timeout";

/**
 * A live game that is a candidate for auto-timeout: its id and the moment it
 * went `live`. The sweep re-checks `live_started_at` against `now` with
 * {@link isDueForAutoTimeout} before ending, so a loader that over-selects (e.g.
 * returns all live games) is still correct — only genuinely-due games are ended.
 */
export interface DueLiveGame {
  readonly gameId: string;
  /** UTC time the game went `live` (Date or epoch ms). */
  readonly liveStartedAt: Date | number;
}

/**
 * The `endGame` transition (Task 10.2, `lib/gameend/transition.ts`): performs the
 * atomic `ended` + `end_reason` write plus exactly one `game_event`, inside the
 * caller-supplied transaction, guarded by `canEndGame`. Declared structurally
 * here so this module compiles independently of that sibling file; the cron
 * route passes the real import.
 */
export type EndGameFn = (
  tx: QueryRunner,
  args: { readonly gameId: string; readonly endReason: EndReason },
) => Promise<unknown>;

/**
 * Run one unit of work inside a single database transaction, handing it a
 * transaction-scoped {@link QueryRunner}. Matches `withTransaction` from
 * `lib/db/server.ts`; injected so the sweep needs no DB to typecheck/test.
 */
export type WithTransactionFn = <T>(
  fn: (tx: QueryRunner) => Promise<T>,
) => Promise<T>;

/** Dependencies for {@link runAutoTimeoutSweep}. All are injectable. */
export interface AutoTimeoutSweepDeps {
  /**
   * Load the live games to consider ending. Should return live games with a
   * non-null `live_started_at`; may over-select (the sweep re-checks the 12h
   * window per game). Given `now` so a loader can push the window predicate down
   * to the database if it wishes.
   */
  readonly listDueLiveGames: (now: Date) => Promise<readonly DueLiveGame[]>;
  /** Runs a function inside one transaction (see {@link WithTransactionFn}). */
  readonly withTransaction: WithTransactionFn;
  /** The atomic end transition to reuse per game (see {@link EndGameFn}). */
  readonly endGame: EndGameFn;
  /**
   * The instant to evaluate the 12h window against. Defaults to `new Date()`.
   * Injectable so tests can pin "now" around the boundary.
   */
  readonly now?: Date;
}

/** The id of one game the sweep failed to end, with the error message. */
export interface SweepFailure {
  readonly gameId: string;
  readonly error: string;
}

/** Outcome of a sweep run (Req 5.2/5.3): what was considered, ended, and failed. */
export interface AutoTimeoutSweepResult {
  /** The instant the window was evaluated against. */
  readonly now: Date;
  /** How many due live games were selected for ending. */
  readonly dueCount: number;
  /** The ids of games successfully ended (each via its own atomic transition). */
  readonly endedGameIds: readonly string[];
  /** Per-game failures; the sweep continues past a failing game (does not throw). */
  readonly failures: readonly SweepFailure[];
}

/**
 * Select every currently-due live game and end each one via the shared atomic
 * end transition, recording `end_reason = 'auto_timeout'` (Req 5.2, 5.3).
 *
 * Steps:
 *   1. Load candidate live games and keep only those where
 *      `now - live_started_at >= AUTO_TIMEOUT_MS` ({@link isDueForAutoTimeout}).
 *   2. For each due game, open its own transaction and call
 *      `endGame(tx, { gameId, endReason: 'auto_timeout' })`, so the `ended` +
 *      `end_reason` write and the single `game_event` commit together (or roll
 *      back together) for that game.
 *   3. Collect ended ids; if one game throws, record the failure and continue —
 *      one game never aborts the whole sweep.
 *
 * The function never throws for a per-game failure; it returns a
 * {@link AutoTimeoutSweepResult} summarizing the run so a route/scheduler can log
 * it. (A failure in the loader itself does propagate, since nothing could be
 * swept.)
 */
export async function runAutoTimeoutSweep(
  deps: AutoTimeoutSweepDeps,
): Promise<AutoTimeoutSweepResult> {
  const now = deps.now ?? new Date();

  const candidates = await deps.listDueLiveGames(now);
  const due = candidates.filter((game) =>
    isDueForAutoTimeout(game.liveStartedAt, now),
  );

  const endedGameIds: string[] = [];
  const failures: SweepFailure[] = [];

  for (const game of due) {
    try {
      // Reuse the exact atomic end transition per game (Task 10.2). Each game
      // gets its own transaction so one failure rolls back only that game.
      await deps.withTransaction((tx) =>
        deps.endGame(tx, {
          gameId: game.gameId,
          endReason: AUTO_TIMEOUT_END_REASON,
        }),
      );
      endedGameIds.push(game.gameId);
    } catch (err) {
      failures.push({
        gameId: game.gameId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    now,
    dueCount: due.length,
    endedGameIds,
    failures,
  };
}

/**
 * SQL that loads live games eligible for auto-timeout: those in `live` with a
 * `live_started_at` at or past the 12h window relative to the bound `now`
 * ($1). Pushing the window into the query keeps the candidate set small; the
 * sweep still re-checks each with {@link isDueForAutoTimeout} for a single source
 * of truth on the boundary.
 *
 * `AUTO_TIMEOUT_MS` milliseconds is expressed as a Postgres interval built from
 * the parameter so the value stays defined once in TypeScript.
 */
export const LIST_DUE_LIVE_GAMES_SQL = `
select id, live_started_at
from games
where lifecycle = 'live'
  and live_started_at is not null
  and live_started_at <= ($1::timestamptz - ($2::double precision * interval '1 millisecond'))
`;

/**
 * Build a {@link AutoTimeoutSweepDeps["listDueLiveGames"]} backed by a
 * transaction runner: a short read-only transaction that runs
 * {@link LIST_DUE_LIVE_GAMES_SQL} and maps rows to {@link DueLiveGame}. Factored
 * out so the cron route can compose it with the real `withTransaction` while
 * tests inject a plain in-memory loader.
 */
export function createDbDueLiveGamesLoader(
  withTransaction: WithTransactionFn,
): (now: Date) => Promise<readonly DueLiveGame[]> {
  return async (now: Date) =>
    withTransaction(async (tx) => {
      const { rows } = await tx.query(LIST_DUE_LIVE_GAMES_SQL, [
        now.toISOString(),
        AUTO_TIMEOUT_MS,
      ]);
      return rows.map((row) => ({
        gameId: String(row.id),
        liveStartedAt: new Date(String(row.live_started_at)),
      }));
    });
}
