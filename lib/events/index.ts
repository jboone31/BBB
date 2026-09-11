/**
 * Event backbone for the BBB web-app foundation (design.md Component 3).
 *
 * Every `Game_State_Change` becomes exactly one row in the append-only
 * `game_events` table (see `supabase/migrations/0003_game_events.sql`). That log
 * is both the game history and the real-time propagation source. This module
 * encapsulates the single rule that governs writing to it:
 *
 *   `appendEvent(tx, { gameId, type, actor, payload })`
 *
 * executed **inside the caller's transaction**, which:
 *   1. assigns the next per-game `seq` under a per-game lock (game-row
 *      `FOR UPDATE`, or a per-game advisory lock) so the sequence is contiguous,
 *      gap-free, and duplicate-free even under concurrent writers (Req 4.5);
 *   2. rejects payloads larger than 16 KB before any insert (Req 4.2);
 *   3. stamps `created_at` as a UTC millisecond-precision timestamp (Req 4.2);
 *   4. returns the created event (Req 4.1).
 *
 * The concrete Supabase/pg client wiring is a later concern (Task 10), so this
 * module does not import a database driver. Instead it defines the *minimal*
 * interface it needs — a {@link QueryRunner} that runs parameterized SQL inside
 * the caller's already-open transaction — and the caller supplies an adapter.
 * Running through the caller's runner is what makes the seq assignment and the
 * event insert share one transaction (and roll back together on failure,
 * Req 4.3/4.4).
 *
 * The size check, the actor mapping, and the "next seq given current max" step
 * are exposed as pure functions so they can be property-tested in isolation
 * (Tasks 9.2, 9.3) without a live database.
 *
 * Requirements: 4.1, 4.2, 4.5.
 */

/**
 * Maximum serialized size of an event `payload`, in bytes (16 KB).
 *
 * Mirrors the database check `pg_column_size(payload) <= 16384` in
 * `0003_game_events.sql`. The application performs the same check *before*
 * attempting an insert so oversize payloads are rejected up front with a clear
 * error rather than surfacing as an opaque constraint violation.
 */
export const MAX_PAYLOAD_BYTES = 16 * 1024; // 16384

/**
 * The first `seq` assigned to a game's very first event.
 *
 * The `game_events_seq_positive` check requires `seq >= 1`, so per-game
 * sequences start at 1.
 */
export const FIRST_SEQ = 1;

/**
 * The actor that caused an event (Req 4.2).
 *
 * Either a team (identified by its id) or one of the two non-team principals:
 * the `admin`/host, or the `system` (e.g. the scheduled auto-timeout sweep).
 * A bare string is interpreted as a team id; the literals `"admin"` and
 * `"system"` select the non-team principals.
 */
export type EventActor =
  | { readonly kind: "team"; readonly teamId: string }
  | { readonly kind: "admin" }
  | { readonly kind: "system" }
  | "admin"
  | "system"
  | string;

/** The actor discriminator stored in the `event_actor_kind` enum column. */
export type ActorKind = "team" | "admin" | "system";

/**
 * The actor as stored on a `game_events` row: a discriminator plus the team id
 * (present only for `team` actors, null otherwise), matching the
 * `game_events_actor_kind_matches_team` check.
 */
export interface StoredActor {
  readonly actorKind: ActorKind;
  readonly actorTeamId: string | null;
}

/** Arguments to {@link appendEvent}. */
export interface AppendEventArgs {
  /** The game this event belongs to (Req 4.1: exactly one game per event). */
  readonly gameId: string;
  /** The event type, e.g. `claim_recorded`, `card_played`, `score_updated`. */
  readonly type: string;
  /** Who caused the event (Req 4.2). */
  readonly actor: EventActor;
  /** The event body; must serialize to <= {@link MAX_PAYLOAD_BYTES} (Req 4.2). */
  readonly payload: unknown;
}

/** A `game_events` row, as returned by {@link appendEvent} (Req 4.1). */
export interface GameEvent {
  readonly id: string;
  readonly gameId: string;
  readonly seq: number;
  readonly eventType: string;
  readonly actorKind: ActorKind;
  readonly actorTeamId: string | null;
  readonly payload: unknown;
  /** UTC, millisecond precision (Req 4.2). ISO-8601 string as stored. */
  readonly createdAt: string;
}

/**
 * A single row returned from a query, keyed by column name. Kept intentionally
 * loose so any concrete driver's row shape satisfies it.
 */
export type SqlRow = Record<string, unknown>;

/**
 * The minimal database capability {@link appendEvent} needs: run one
 * parameterized SQL statement, inside the caller's already-open transaction, and
 * return the resulting rows.
 *
 * This deliberately models only "run SQL in the current transaction" rather than
 * transaction management (begin/commit/rollback), because `appendEvent` must
 * execute within a transaction the *caller* owns — the same transaction that
 * writes the domain state change (Req 4.3/4.4). The caller adapts its concrete
 * pg/Supabase client (which uses `$1, $2, ...` positional parameters) to this
 * interface.
 */
export interface QueryRunner {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: SqlRow[] }>;
}

/** Raised when an event `payload` exceeds {@link MAX_PAYLOAD_BYTES} (Req 4.2). */
export class PayloadTooLargeError extends Error {
  readonly sizeBytes: number;
  readonly maxBytes: number;

  constructor(sizeBytes: number, maxBytes: number = MAX_PAYLOAD_BYTES) {
    super(
      `event payload is ${sizeBytes} bytes, which exceeds the ${maxBytes}-byte (16 KB) limit`,
    );
    this.name = "PayloadTooLargeError";
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Serialize a payload to the JSON text that will be stored in the `jsonb`
 * column, then measure its size in bytes (UTF-8).
 *
 * We measure the serialized JSON rather than the in-memory object because that
 * is what actually gets stored and what the database's `pg_column_size` check
 * bounds. `undefined` payloads serialize to an empty object (matching the
 * column default `'{}'`).
 *
 * @returns the number of UTF-8 bytes in the serialized payload.
 */
export function payloadSizeBytes(payload: unknown): number {
  const json = payload === undefined ? "{}" : JSON.stringify(payload);
  // JSON.stringify returns undefined for values like a bare `undefined`; the
  // guard above handles the top-level case, but nested unsupported values would
  // already have thrown/omitted. Fall back to "{}" defensively.
  return byteLength(json ?? "{}");
}

/** UTF-8 byte length of a string, using TextEncoder when available. */
function byteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  // Node fallback (older runtimes / non-DOM contexts).
  return Buffer.byteLength(text, "utf8");
}

/**
 * Pure size guard (Req 4.2): true iff the payload serializes to at most
 * {@link MAX_PAYLOAD_BYTES}. Exposed for property testing around the 16 KB
 * boundary (Task 9.2).
 */
export function isPayloadWithinLimit(
  payload: unknown,
  maxBytes: number = MAX_PAYLOAD_BYTES,
): boolean {
  return payloadSizeBytes(payload) <= maxBytes;
}

/**
 * Throw {@link PayloadTooLargeError} if the payload exceeds the limit; otherwise
 * return its size in bytes. Rejection happens before any insert is attempted, so
 * no event is written for an oversize payload (Req 4.2).
 */
export function assertPayloadWithinLimit(
  payload: unknown,
  maxBytes: number = MAX_PAYLOAD_BYTES,
): number {
  const size = payloadSizeBytes(payload);
  if (size > maxBytes) {
    throw new PayloadTooLargeError(size, maxBytes);
  }
  return size;
}

/**
 * Compute the next per-game `seq` given the current maximum `seq` for that game
 * (or `null` when the game has no events yet).
 *
 * This is the pure core of the sequence-assignment rule (Req 4.5): the next
 * sequence is `max(seq) + 1`, starting at {@link FIRST_SEQ} for the first event.
 * Because the caller holds a per-game lock while reading the current max and
 * inserting, and because a rolled-back insert leaves the max unchanged, applying
 * this function under that lock yields a contiguous, gap-free, duplicate-free
 * sequence even under concurrent writers. Exposed for property testing
 * (Task 9.3).
 *
 * @param currentMaxSeq the highest `seq` currently committed for the game, or
 *   `null`/`undefined` if the game has no events.
 * @throws {RangeError} if `currentMaxSeq` is not a positive integer (or null).
 */
export function nextSeq(currentMaxSeq: number | null | undefined): number {
  if (currentMaxSeq === null || currentMaxSeq === undefined) {
    return FIRST_SEQ;
  }
  if (!Number.isInteger(currentMaxSeq) || currentMaxSeq < FIRST_SEQ) {
    throw new RangeError(
      `currentMaxSeq must be null or an integer >= ${FIRST_SEQ}, got ${currentMaxSeq}`,
    );
  }
  return currentMaxSeq + 1;
}

/**
 * Normalize an {@link EventActor} into the discriminator + team-id pair stored
 * on a `game_events` row (Req 4.2), matching the
 * `game_events_actor_kind_matches_team` check: a `team` actor carries a team id,
 * while `admin`/`system` carry none.
 *
 * Accepts the object forms (`{ kind: "team", teamId }`, `{ kind: "admin" }`,
 * `{ kind: "system" }`), the string literals `"admin"`/`"system"`, and a bare
 * string treated as a team id. Exposed as a pure function for property testing.
 *
 * @throws {RangeError} if a `team` actor has an empty/missing team id.
 */
export function toStoredActor(actor: EventActor): StoredActor {
  if (typeof actor === "string") {
    if (actor === "admin" || actor === "system") {
      return { actorKind: actor, actorTeamId: null };
    }
    return requireTeam(actor);
  }

  switch (actor.kind) {
    case "admin":
    case "system":
      return { actorKind: actor.kind, actorTeamId: null };
    case "team":
      return requireTeam(actor.teamId);
    default: {
      // Exhaustiveness guard for future actor kinds.
      const never: never = actor;
      throw new RangeError(`unknown actor: ${JSON.stringify(never)}`);
    }
  }
}

function requireTeam(teamId: string): StoredActor {
  if (typeof teamId !== "string" || teamId.length === 0) {
    throw new RangeError("a team actor must have a non-empty team id");
  }
  return { actorKind: "team", actorTeamId: teamId };
}

/**
 * A UTC timestamp truncated to millisecond precision, as an ISO-8601 string
 * (Req 4.2). `Date.prototype.toISOString()` is already UTC with millisecond
 * precision, so this is the app-side counterpart to the migration's
 * `date_trunc('milliseconds', now())`.
 *
 * @param now the instant to stamp; defaults to the current time.
 */
export function utcMillisTimestamp(now: Date = new Date()): string {
  // Truncate any sub-millisecond component defensively, then render as UTC ISO.
  return new Date(Math.floor(now.getTime())).toISOString();
}

/**
 * SQL that locks the game row, reads the current max seq for the game, appends
 * the event at `max+1`, and returns the inserted row — all in one round trip so
 * the lock, read, and insert cannot be interleaved by a concurrent appender
 * (Req 4.5).
 *
 * The CTE:
 *   - `locked` takes `FOR UPDATE` on the game row, serializing appenders for the
 *     same game (concurrent appenders block here until the holder commits/rolls
 *     back).
 *   - `next` computes `coalesce(max(seq), 0) + 1` for the game.
 *   - the `insert ... select` writes the new event with that seq and the
 *     supplied fields, stamping `created_at` at UTC-ms precision.
 *
 * Positional parameters: $1 game_id, $2 event_type, $3 actor_kind,
 * $4 actor_team_id (nullable), $5 payload (jsonb), $6 created_at (timestamptz).
 */
const APPEND_EVENT_SQL = `
with locked as (
  select id from games where id = $1 for update
),
next as (
  select coalesce(max(seq), 0) + 1 as seq
  from game_events
  where game_id = $1
)
insert into game_events (game_id, seq, event_type, actor_kind, actor_team_id, payload, created_at)
select $1, next.seq, $2, $3::event_actor_kind, $4, $5::jsonb, $6::timestamptz
from next, locked
returning id, game_id, seq, event_type, actor_kind, actor_team_id, payload, created_at
`;

/**
 * Append exactly one event to a game's log, inside the caller's transaction
 * (design.md Component 3; Req 4.1, 4.2, 4.5).
 *
 * Steps:
 *   1. Reject the payload up front if it exceeds 16 KB (Req 4.2) — no insert is
 *      attempted for an oversize payload.
 *   2. Normalize the actor to `(actor_kind, actor_team_id)` (Req 4.2).
 *   3. In a single statement, take a `FOR UPDATE` lock on the game row, compute
 *      the next per-game `seq` as `max(seq)+1`, and insert the event, stamping a
 *      UTC-ms `created_at` (Req 4.5, 4.2).
 *   4. Return the created event (Req 4.1).
 *
 * Because the statement runs through the caller-supplied {@link QueryRunner} —
 * i.e. inside the caller's open transaction — the seq assignment and the insert
 * share that transaction with the caller's domain write, so all of it commits or
 * rolls back together (Req 4.3/4.4, enforced by the caller in Task 10).
 *
 * @param tx a query runner bound to the caller's open transaction.
 * @param args the event to append.
 * @returns the created {@link GameEvent}.
 * @throws {PayloadTooLargeError} if the payload exceeds {@link MAX_PAYLOAD_BYTES}.
 * @throws {Error} if the insert returns no row (e.g. the game does not exist).
 */
export async function appendEvent(
  tx: QueryRunner,
  args: AppendEventArgs,
): Promise<GameEvent> {
  const { gameId, type, actor, payload } = args;

  // 1. Size guard first: reject oversize before touching the database (Req 4.2).
  assertPayloadWithinLimit(payload);

  // 2. Actor mapping (Req 4.2).
  const { actorKind, actorTeamId } = toStoredActor(actor);

  // 3. UTC-ms timestamp (Req 4.2).
  const createdAt = utcMillisTimestamp();

  // jsonb parameter is passed as JSON text (default '{}' when undefined).
  const payloadJson = payload === undefined ? "{}" : JSON.stringify(payload);

  // 4. Lock + next-seq + insert in one statement (Req 4.5).
  const { rows } = await tx.query(APPEND_EVENT_SQL, [
    gameId,
    type,
    actorKind,
    actorTeamId,
    payloadJson,
    createdAt,
  ]);

  const row = rows[0];
  if (!row) {
    // No game row was locked (game does not exist) → nothing inserted.
    throw new Error(
      `appendEvent: no event written for game ${gameId} (game not found)`,
    );
  }

  return rowToGameEvent(row);
}

/** Map a raw DB row (snake_case columns) to a {@link GameEvent}. */
export function rowToGameEvent(row: SqlRow): GameEvent {
  return {
    id: String(row.id),
    gameId: String(row.game_id),
    seq: Number(row.seq),
    eventType: String(row.event_type),
    actorKind: row.actor_kind as ActorKind,
    actorTeamId: row.actor_team_id == null ? null : String(row.actor_team_id),
    payload: parsePayload(row.payload),
    createdAt: toIsoString(row.created_at),
  };
}

/** jsonb comes back as an object from most drivers, but tolerate a JSON string. */
function parsePayload(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** Render a driver timestamp (Date or string) as a UTC-ms ISO-8601 string. */
function toIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}
