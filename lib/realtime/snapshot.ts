/**
 * Snapshot loader for the realtime subscription client (design.md Component 5).
 *
 * When a client subscribes to a game it needs an initial view of the world: the
 * state that results from every event already persisted for that game. Rather
 * than maintain a second, separately-computed "current state" table, the
 * foundation derives the snapshot by folding the append-only `game_events` log
 * (see `supabase/migrations/0003_game_events.sql`) in ascending `seq` order.
 * That fold is the whole point of the events backbone: the log is the single
 * ordered source of truth, so the snapshot is exactly
 *
 *   reduce(applyEvent, {initial state}, events with seq <= N, ascending by seq)
 *
 * This is the guarantee Property 10 checks (Task 13.4): the snapshot delivered on
 * subscription equals the fold of all events with `seq <= N` (Req 6.4).
 *
 * The module is split into two layers so the correctness core can be property-
 * tested without a live database:
 *
 *   1. A **pure** layer — {@link applyEvent} (a single-event reducer) and
 *      {@link foldEvents} (the ordered fold over a set of events) — that computes
 *      a {@link GameStateSnapshot} from events with no I/O.
 *   2. A thin **data-access** layer — {@link loadSnapshot} — that fetches a
 *      game's events (ordered by `seq` ascending) through an injectable
 *      {@link SnapshotSource} and hands them to {@link foldEvents}.
 *
 * Keeping the fetch behind {@link SnapshotSource} (which the existing
 * {@link QueryRunner} satisfies) means this file typechecks and is testable
 * without any Supabase/Postgres client wired up; the concrete client is supplied
 * by the caller (Task 13.2 / the server snapshot route).
 *
 * NOTE: `lib/realtime/index.ts` (subscribe/onEvent, Task 13.2) is authored
 * separately; this file intentionally stands alone and does not create or import
 * that index.
 *
 * Requirements: 6.4.
 */

import { rowToGameEvent, type GameEvent, type QueryRunner } from "@/lib/events";

/**
 * The initial-state snapshot a client applies before processing any live events
 * (design.md Component 5; Req 6.4).
 *
 * The foundation does not yet model feature state (claims, scores, hands); those
 * arrive as later features extend {@link applyEvent}. What the snapshot must
 * capture now — and what the realtime client actually needs — is:
 *
 *   - `gameId`: the game this snapshot describes.
 *   - `lastSeenSequence`: the highest `seq` folded in, i.e. `N`. This seeds the
 *     client's `Last_Seen_Sequence` (Req 6.6) so subsequent live events and
 *     catch-up fetches pick up exactly where the snapshot left off. `0` means no
 *     events have been persisted yet (per-game `seq` starts at 1).
 *   - `eventCount`: how many events were folded, a cheap integrity signal for
 *     the fold (with a gap-free sequence, `eventCount === lastSeenSequence`).
 *   - `appliedSeqs`: the `seq` values folded in, ascending. This is the
 *     observable record the fold produced and is what Property 10 compares
 *     against `events with seq <= N`.
 *
 * The shape is intentionally small and forward-compatible: feature state is added
 * as new fields and new `applyEvent` cases, not by redesigning the snapshot.
 */
export interface GameStateSnapshot {
  /** The game this snapshot describes. */
  readonly gameId: string;
  /**
   * The highest `seq` folded into this snapshot (`N`), or {@link NO_EVENTS_SEQ}
   * (0) when the game has no events yet. Seeds `Last_Seen_Sequence` (Req 6.6).
   */
  readonly lastSeenSequence: number;
  /** How many events were folded into this snapshot. */
  readonly eventCount: number;
  /** The `seq` values folded in, in ascending order. */
  readonly appliedSeqs: readonly number[];
}

/**
 * The `lastSeenSequence` of a snapshot with no events folded in. Per-game `seq`
 * starts at 1 (see `FIRST_SEQ` in `lib/events`), so 0 unambiguously means
 * "nothing applied yet".
 */
export const NO_EVENTS_SEQ = 0;

/**
 * The starting state for a game before any event is applied (Req 6.4: the fold
 * is "applying every event ... to the initial state").
 *
 * @param gameId the game the (empty) snapshot describes.
 * @returns a fresh snapshot with no events folded in.
 */
export function initialSnapshot(gameId: string): GameStateSnapshot {
  return {
    gameId,
    lastSeenSequence: NO_EVENTS_SEQ,
    eventCount: 0,
    appliedSeqs: [],
  };
}

/**
 * Pure single-event reducer: fold one event into the running snapshot (design.md
 * Component 5; Req 6.4).
 *
 * This is the atom the whole snapshot is built from — `foldEvents` is just
 * `reduce(applyEvent, initial, events)`. It is deliberately pure and total: it
 * returns a new snapshot and never mutates its input, so folding is
 * order-deterministic and safe to re-run (e.g. on reconnect/resume).
 *
 * The event must belong to the snapshot's game and advance the sequence. A stale
 * or out-of-order event (`seq <= lastSeenSequence`) is ignored and the state is
 * returned unchanged — this makes the reducer idempotent against duplicate
 * deliveries, which the realtime transport can produce (Req 6.9 handling lives in
 * the subscriber, but the reducer must not double-apply). An event from another
 * game is rejected outright, since a snapshot is single-game (Req 6.3 isolation).
 *
 * As feature state is added later, new `event_type`s get their own handling here;
 * for the foundation, applying an event advances `lastSeenSequence`, records the
 * `seq`, and bumps the count.
 *
 * @param state the running snapshot to fold into.
 * @param event the next event to apply.
 * @returns the resulting snapshot (a new object; `state` is never mutated).
 * @throws {RangeError} if `event.gameId` does not match `state.gameId`.
 */
export function applyEvent(
  state: GameStateSnapshot,
  event: GameEvent,
): GameStateSnapshot {
  if (event.gameId !== state.gameId) {
    throw new RangeError(
      `applyEvent: event for game ${event.gameId} cannot be applied to a snapshot for game ${state.gameId}`,
    );
  }

  // Ignore stale/duplicate events: a snapshot only moves forward in seq. This
  // keeps the reducer idempotent so re-delivered events do not double-count.
  if (event.seq <= state.lastSeenSequence) {
    return state;
  }

  return {
    gameId: state.gameId,
    lastSeenSequence: event.seq,
    eventCount: state.eventCount + 1,
    appliedSeqs: [...state.appliedSeqs, event.seq],
  };
}

/**
 * Fold a set of a game's events into a snapshot by applying them in ascending
 * `seq` order (design.md Component 5; Req 6.4).
 *
 * This is the pure core Property 10 targets: for any event log up to sequence
 * `N`, `foldEvents(events with seq <= N)` equals the snapshot delivered on
 * subscription. The function does not assume the input is pre-sorted — it sorts a
 * copy by `seq` ascending first — so callers can pass events in any arrival order
 * and still get the canonical fold. Duplicate `seq` values are de-duplicated by
 * {@link applyEvent}'s stale-event guard, so a repeated event is folded once.
 *
 * All events must belong to `gameId`; a foreign-game event is a programming error
 * and surfaces via {@link applyEvent}'s guard.
 *
 * @param gameId the game whose events are being folded.
 * @param events the events to fold (any order; only `seq <= N` should be passed
 *   by the caller to reflect "state up to N").
 * @returns the folded {@link GameStateSnapshot}.
 */
export function foldEvents(
  gameId: string,
  events: readonly GameEvent[],
): GameStateSnapshot {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  return ordered.reduce(applyEvent, initialSnapshot(gameId));
}

/**
 * The minimal data-access capability {@link loadSnapshot} needs: fetch a game's
 * persisted events, ordered by `seq` ascending.
 *
 * Modeling only "fetch this game's events in order" (rather than a full client)
 * keeps the snapshot loader decoupled from Supabase/Postgres so it typechecks and
 * is testable without a live backend. Two ways to satisfy it:
 *
 *   - Implement {@link fetchEventsAscending} directly (e.g. over the Supabase JS
 *     client) — handy for a browser subscriber that reads through RLS.
 *   - Pass any {@link QueryRunner} (the same interface `lib/events` uses) to
 *     {@link snapshotSourceFromQueryRunner}, which builds a {@link SnapshotSource}
 *     that runs the ordered `select` — handy on the server, sharing the existing
 *     db layer.
 */
export interface SnapshotSource {
  /**
   * Return every persisted event for `gameId`, ordered by `seq` ascending.
   * Implementations should apply the ordering in the query; {@link foldEvents}
   * re-sorts defensively but callers should not rely on that to hide an
   * unordered source.
   */
  fetchEventsAscending(gameId: string): Promise<GameEvent[]>;
}

/**
 * SQL that selects a game's events ordered by `seq` ascending — the read side of
 * the events backbone (see the `game_events_game_seq_idx` index in
 * `0003_game_events.sql`, which serves exactly this scan).
 *
 * Positional parameter: $1 game_id.
 */
const SELECT_EVENTS_ASC_SQL = `
select id, game_id, seq, event_type, actor_kind, actor_team_id, payload, created_at
from game_events
where game_id = $1
order by seq asc
`;

/**
 * Adapt a {@link QueryRunner} (the interface `lib/events` already defines) into a
 * {@link SnapshotSource} that fetches a game's events ordered by `seq` ascending.
 *
 * This is the server-side wiring: reuse the same `query(sql, params)` boundary
 * the event backbone uses, so the snapshot loader needs no new database
 * dependency. Rows are mapped to {@link GameEvent} via `rowToGameEvent`, the same
 * mapper `appendEvent` uses, keeping the row shape in one place.
 *
 * @param runner a query runner (a live connection, a transaction, or a test
 *   stub) that runs parameterized SQL.
 * @returns a {@link SnapshotSource} backed by `runner`.
 */
export function snapshotSourceFromQueryRunner(
  runner: QueryRunner,
): SnapshotSource {
  return {
    async fetchEventsAscending(gameId: string): Promise<GameEvent[]> {
      const { rows } = await runner.query(SELECT_EVENTS_ASC_SQL, [gameId]);
      return rows.map(rowToGameEvent);
    },
  };
}

/**
 * Load the initial state snapshot for a game (design.md Component 5; Req 6.4).
 *
 * Fetches every event persisted for `gameId` — ordered by `seq` ascending — and
 * folds them into a {@link GameStateSnapshot} via {@link foldEvents}. The result
 * reflects exactly the events with `seq <= N`, where `N` is the highest persisted
 * `seq` at fetch time, i.e. the snapshot the subscriber applies before processing
 * live events.
 *
 * The data-access boundary is injectable: pass either a {@link SnapshotSource}
 * directly, or a {@link QueryRunner}, which is wrapped via
 * {@link snapshotSourceFromQueryRunner}. This keeps `loadSnapshot` usable from
 * both the browser (Supabase client) and the server (db query runner), and lets
 * tests supply an in-memory source with no live Supabase.
 *
 * @param gameId the game to snapshot.
 * @param source how to fetch the game's events: a {@link SnapshotSource} or a
 *   {@link QueryRunner}.
 * @returns the folded {@link GameStateSnapshot} reflecting all persisted events.
 */
export async function loadSnapshot(
  gameId: string,
  source: SnapshotSource | QueryRunner,
): Promise<GameStateSnapshot> {
  const snapshotSource = isSnapshotSource(source)
    ? source
    : snapshotSourceFromQueryRunner(source);
  const events = await snapshotSource.fetchEventsAscending(gameId);
  return foldEvents(gameId, events);
}

/**
 * Narrow a {@link SnapshotSource} | {@link QueryRunner} union: a value is a
 * {@link SnapshotSource} iff it exposes `fetchEventsAscending`.
 */
function isSnapshotSource(
  source: SnapshotSource | QueryRunner,
): source is SnapshotSource {
  return typeof (source as SnapshotSource).fetchEventsAscending === "function";
}
