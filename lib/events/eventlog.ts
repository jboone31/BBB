/**
 * Pure model of the append-only, insert-only `game_events` log for the Beltline
 * Bar Brawl v1 ruleset.
 *
 * The database enforces append-only semantics on the `game_events` table (see
 * `supabase/migrations/0003_game_events.sql`): no role is granted UPDATE or
 * DELETE, and a `BEFORE UPDATE OR DELETE` trigger always raises. This encodes
 * the requirement that a Game_Event is immutable after creation and supports
 * insert-only access with no update or delete operations, and that while a game
 * has not ended all its events are retained unchanged (Requirements 4.1, 4.6).
 *
 * This module is a framework-free, deterministic model of that constraint so it
 * can be property-tested in isolation. The real database trigger/REVOKE is
 * exercised separately by the integration tests (Task 18). The model is
 * intentionally minimal: it appends committed events and reports whether each
 * mutation attempt (update/delete) is rejected, while guaranteeing the stored
 * events are never modified.
 *
 * NOTE: the event backbone's live append behavior (transactional sequence
 * assignment under a per-game lock) is implemented separately in
 * `lib/events/index.ts` (Task 9.1). This file models only the immutability /
 * insert-only guarantee and deliberately lives in its own module to avoid
 * colliding with that concurrently-authored file.
 */

/** An event's actor: a team (by id), the admin/host, or the system. */
export type EventActor =
  | { readonly kind: "team"; readonly teamId: string }
  | { readonly kind: "admin" }
  | { readonly kind: "system" };

/** The immutable contents of a committed Game_Event (excluding its id/seq). */
export interface EventInput {
  readonly eventType: string;
  readonly actor: EventActor;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Creation timestamp, UTC epoch milliseconds. */
  readonly createdAt: number;
}

/**
 * A committed Game_Event as stored in the log. `id` and `seq` are assigned on
 * append; every other field mirrors the {@link EventInput} it was created from.
 * All fields are `readonly` to reflect that a committed event is immutable.
 */
export interface StoredEvent {
  readonly id: string;
  readonly seq: number;
  readonly eventType: string;
  readonly actor: EventActor;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

/** The outcome of attempting a mutation (update/delete) against the log. */
export type MutationOutcome = "rejected";

/** Deep-freeze a value so accidental in-place mutation of stored data throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Structurally clone the actor so stored events never alias caller data. */
function cloneActor(actor: EventActor): EventActor {
  switch (actor.kind) {
    case "team":
      return { kind: "team", teamId: actor.teamId };
    case "admin":
      return { kind: "admin" };
    case "system":
      return { kind: "system" };
  }
}

/**
 * A pure, in-memory model of the append-only `game_events` log for a single
 * non-ended game.
 *
 * `append` records a new committed event (the only permitted mutation).
 * `update` and `delete` model the two forbidden operations: both are always
 * rejected and leave every stored event byte-for-byte unchanged, mirroring the
 * database's insert-only guarantee (Requirements 4.1, 4.6).
 */
export class EventLog {
  private readonly events: StoredEvent[] = [];
  private nextSeq = 1;
  private nextId = 1;

  /**
   * Append a new committed event to the log.
   *
   * Assigns the next per-game `seq` (strictly increasing from 1) and a unique
   * id. The stored event is a deep-frozen copy so later caller mutations of the
   * input cannot alter the log. This is the ONLY operation that changes the log.
   *
   * @returns the created {@link StoredEvent}.
   */
  append(input: EventInput): StoredEvent {
    const stored: StoredEvent = {
      id: `e${this.nextId++}`,
      seq: this.nextSeq++,
      eventType: input.eventType,
      actor: cloneActor(input.actor),
      payload: { ...input.payload },
      createdAt: input.createdAt,
    };
    deepFreeze(stored);
    this.events.push(stored);
    return stored;
  }

  /**
   * Attempt to update a stored event by id.
   *
   * Always rejected: the log is insert-only, so no field of any committed event
   * can ever change. The stored events are left unchanged regardless of whether
   * the id exists (Requirement 4.1).
   *
   * @returns `"rejected"` always.
   */
  update(id: string, changes: Partial<EventInput>): MutationOutcome {
    // The parameters describe an update that is never applied: no field of a
    // committed event can change. They are intentionally not acted upon.
    void id;
    void changes;
    return "rejected";
  }

  /**
   * Attempt to delete a stored event by id.
   *
   * Always rejected: the log is insert-only and, while the game has not ended,
   * all events are retained without deletion. The stored events are left
   * unchanged regardless of whether the id exists (Requirements 4.1, 4.6).
   *
   * @returns `"rejected"` always.
   */
  delete(id: string): MutationOutcome {
    // The id describes an event that is never removed: while a game has not
    // ended, all events are retained. Intentionally not acted upon.
    void id;
    return "rejected";
  }

  /** The event with the given id, or `undefined` if none. */
  getById(id: string): StoredEvent | undefined {
    return this.events.find((event) => event.id === id);
  }

  /** A read-only snapshot of all stored events in append (seq) order. */
  snapshot(): readonly StoredEvent[] {
    return this.events.slice();
  }

  /** The number of events currently stored. */
  get size(): number {
    return this.events.length;
  }
}
