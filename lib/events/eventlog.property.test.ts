import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  EventLog,
  type EventActor,
  type EventInput,
  type StoredEvent,
} from "./eventlog";

/**
 * Feature: web-app-foundation, Property 4: Game events are immutable and insert-only
 *
 * A committed Game_Event is immutable after creation: the log supports
 * insert-only access with no update or delete operations, and while a game has
 * not ended all its events are retained unchanged. This models the database's
 * append-only guarantee on `game_events` (no UPDATE/DELETE grants + a
 * BEFORE UPDATE/DELETE trigger that raises; see
 * `supabase/migrations/0003_game_events.sql`), which is exercised end-to-end by
 * the integration tests (Task 18).
 *
 * For a random set of committed events in a non-ended game, every update/delete
 * attempt is rejected and every stored event's fields remain byte-for-byte
 * unchanged.
 *
 * Validates: Requirements 4.1, 4.6
 */

/** A generator for event actors across all three actor kinds. */
const actorArb: fc.Arbitrary<EventActor> = fc.oneof(
  fc.record({
    kind: fc.constant("team" as const),
    teamId: fc.constantFrom("t1", "t2", "t3", "t4"),
  }),
  fc.constant({ kind: "admin" as const }),
  fc.constant({ kind: "system" as const }),
);

/** A small, JSON-like payload generator (values a real event payload holds). */
const payloadArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string({ maxLength: 8 }),
  fc.oneof(
    fc.string({ maxLength: 16 }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
  ),
  { maxKeys: 5 },
);

/** A committed-event input generator. */
const eventInputArb: fc.Arbitrary<EventInput> = fc.record({
  eventType: fc.constantFrom(
    "claim_recorded",
    "card_played",
    "score_updated",
    "game_ended",
  ),
  actor: actorArb,
  payload: payloadArb,
  createdAt: fc.integer({ min: 0, max: 4_102_444_800_000 }),
});

/**
 * A structural, stable snapshot of a stored event, used to assert that fields
 * are unchanged before vs. after mutation attempts. JSON is sufficient because
 * every field is a JSON-serializable value.
 */
function fingerprint(event: StoredEvent): string {
  return JSON.stringify({
    id: event.id,
    seq: event.seq,
    eventType: event.eventType,
    actor: event.actor,
    payload: event.payload,
    createdAt: event.createdAt,
  });
}

function fingerprintAll(log: EventLog): string[] {
  return log.snapshot().map(fingerprint);
}

describe("EventLog — Game events are immutable and insert-only (Property 4)", () => {
  it("rejects every update/delete attempt and leaves all stored events unchanged", () => {
    fc.assert(
      fc.property(
        // A set of committed events...
        fc.array(eventInputArb, { minLength: 1, maxLength: 50 }),
        // ...and a sequence of random mutation attempts. Each attempt targets an
        // id either drawn from the real ids (chosen at runtime) or a bogus id,
        // and is either an update (with arbitrary changes) or a delete.
        fc.array(
          fc.record({
            // index into the committed events (mod size) to target a real id,
            // or -1 to target a non-existent id.
            targetIndex: fc.integer({ min: -1, max: 100 }),
            op: fc.constantFrom("update" as const, "delete" as const),
            changes: fc.record(
              {
                eventType: fc.string({ maxLength: 12 }),
                createdAt: fc.integer(),
              },
              { requiredKeys: [] },
            ),
          }),
          { minLength: 0, maxLength: 100 },
        ),
        (inputs, attempts) => {
          const log = new EventLog();
          for (const input of inputs) {
            log.append(input);
          }

          const stored = log.snapshot();
          const before = fingerprintAll(log);
          const sizeBefore = log.size;

          for (const attempt of attempts) {
            // Resolve a target id: a real one (by index) or a bogus one.
            const id =
              attempt.targetIndex >= 0
                ? stored[attempt.targetIndex % stored.length].id
                : "does-not-exist";

            const outcome =
              attempt.op === "update"
                ? log.update(id, attempt.changes)
                : log.delete(id);

            // Every mutation attempt is rejected (insert-only).
            expect(outcome).toBe("rejected");
          }

          // After all attempts: same number of events, and every stored event's
          // fields are byte-for-byte unchanged (immutable, retained).
          expect(log.size).toBe(sizeBefore);
          expect(fingerprintAll(log)).toEqual(before);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("keeps a targeted event unchanged after update and delete attempts", () => {
    // Explicit example: append one event, attempt to mutate it, confirm it is
    // rejected and unchanged.
    const log = new EventLog();
    const created = log.append({
      eventType: "claim_recorded",
      actor: { kind: "team", teamId: "t1" },
      payload: { barId: "b1" },
      createdAt: 1_700_000_000_000,
    });
    const before = fingerprint(created);

    expect(log.update(created.id, { eventType: "tampered" })).toBe("rejected");
    expect(log.delete(created.id)).toBe("rejected");

    const after = log.getById(created.id);
    expect(after).toBeDefined();
    expect(fingerprint(after as StoredEvent)).toBe(before);
    expect(log.size).toBe(1);
  });

  it("rejects mutations targeting a non-existent id without altering the log", () => {
    const log = new EventLog();
    log.append({
      eventType: "score_updated",
      actor: { kind: "system" },
      payload: {},
      createdAt: 0,
    });
    const before = fingerprintAll(log);

    expect(log.update("missing", { createdAt: 42 })).toBe("rejected");
    expect(log.delete("missing")).toBe("rejected");

    expect(fingerprintAll(log)).toEqual(before);
    expect(log.size).toBe(1);
  });

  it("assigns a strictly increasing, gap-free per-game seq on append", () => {
    // Sanity check that append is the only mutating operation and produces a
    // clean sequence (the backbone the immutability guarantee protects).
    const log = new EventLog();
    for (let i = 0; i < 5; i++) {
      log.append({
        eventType: "e",
        actor: { kind: "admin" },
        payload: { i },
        createdAt: i,
      });
    }
    expect(log.snapshot().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});
