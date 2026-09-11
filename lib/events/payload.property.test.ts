import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  appendEvent,
  assertPayloadWithinLimit,
  isPayloadWithinLimit,
  MAX_PAYLOAD_BYTES,
  payloadSizeBytes,
  PayloadTooLargeError,
  type QueryRunner,
  type SqlRow,
} from "./index";

/**
 * Feature: web-app-foundation, Property 5: Event payload size bound
 *
 * An event `payload` is accepted iff it serializes to at most 16 KB
 * ({@link MAX_PAYLOAD_BYTES} = 16384 bytes); anything larger is rejected with a
 * {@link PayloadTooLargeError} and no event is written. This mirrors the
 * database check `pg_column_size(payload) <= 16384` in
 * `supabase/migrations/0003_game_events.sql`, but is enforced by the app up
 * front so oversize payloads are rejected before any insert is attempted.
 *
 * The property is checked at three levels around the boundary:
 *   - the pure predicate `isPayloadWithinLimit` / `assertPayloadWithinLimit`;
 *   - `appendEvent`, which must proceed to the DB (call `tx.query`) when within
 *     the limit and must throw without ever touching the DB when over it.
 *
 * Generators land the serialized payload size just under, exactly at, and just
 * over 16384 bytes by building strings of controlled byte length.
 *
 * Validates: Requirements 4.2
 */

/**
 * A fake QueryRunner that records whether `query` was called. On success it
 * returns a single row shaped like a `game_events` row so `appendEvent` can map
 * it back to a GameEvent.
 */
class RecordingQueryRunner implements QueryRunner {
  calls = 0;
  lastSql: string | null = null;
  lastParams: readonly unknown[] | undefined = undefined;

  async query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: SqlRow[] }> {
    this.calls += 1;
    this.lastSql = sql;
    this.lastParams = params;
    // Echo back a plausible inserted row so appendEvent resolves successfully.
    const row: SqlRow = {
      id: "evt-1",
      game_id: params?.[0] ?? "g1",
      seq: 1,
      event_type: params?.[1] ?? "test_event",
      actor_kind: params?.[2] ?? "system",
      actor_team_id: params?.[3] ?? null,
      payload: params?.[4] ?? "{}",
      created_at: params?.[5] ?? "2024-01-01T00:00:00.000Z",
    };
    return { rows: [row] };
  }
}

/**
 * The JSON serialization of `{ "s": "<pad>" }` has a fixed 8-byte overhead
 * (`{"s":"` = 6 bytes plus `"}` = 2 bytes) around the ASCII padding string, so a
 * payload with N padding bytes serializes to N + 8 bytes. We use single-byte
 * ASCII fill so byte length equals character length.
 */
const ENVELOPE_OVERHEAD = payloadSizeBytes({ s: "" });

/** Build a payload whose serialized size is exactly `targetBytes` (ASCII). */
function payloadOfSerializedSize(targetBytes: number): { s: string } {
  const padLength = targetBytes - ENVELOPE_OVERHEAD;
  return { s: "a".repeat(Math.max(0, padLength)) };
}

describe("Event payload size bound (Property 5)", () => {
  it("envelope overhead assumption holds", () => {
    // Sanity: payloadOfSerializedSize actually hits the requested byte size.
    for (const target of [ENVELOPE_OVERHEAD, 100, MAX_PAYLOAD_BYTES]) {
      expect(payloadSizeBytes(payloadOfSerializedSize(target))).toBe(target);
    }
  });

  it("accepts iff serialized size <= 16 KB and appends only when within limit", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Offsets that land the serialized size just under, exactly at, and just
        // over the 16384-byte boundary (also a wider spread of deltas).
        fc.integer({ min: -2048, max: 2048 }),
        async (delta) => {
          const targetBytes = MAX_PAYLOAD_BYTES + delta;
          const payload = payloadOfSerializedSize(targetBytes);
          const size = payloadSizeBytes(payload);

          const within = size <= MAX_PAYLOAD_BYTES;

          // Pure predicate agrees with the boundary.
          expect(isPayloadWithinLimit(payload)).toBe(within);

          // assertPayloadWithinLimit: returns size when within, throws when over.
          if (within) {
            expect(assertPayloadWithinLimit(payload)).toBe(size);
          } else {
            expect(() => assertPayloadWithinLimit(payload)).toThrow(
              PayloadTooLargeError,
            );
          }

          // appendEvent: within -> proceeds to tx.query; over -> throws and the
          // DB is never touched (no event written).
          const tx = new RecordingQueryRunner();
          if (within) {
            await expect(
              appendEvent(tx, {
                gameId: "g1",
                type: "test_event",
                actor: "system",
                payload,
              }),
            ).resolves.toMatchObject({ gameId: "g1", seq: 1 });
            expect(tx.calls).toBe(1);
          } else {
            await expect(
              appendEvent(tx, {
                gameId: "g1",
                type: "test_event",
                actor: "system",
                payload,
              }),
            ).rejects.toBeInstanceOf(PayloadTooLargeError);
            // Rejected before any insert: DB never called, no event written.
            expect(tx.calls).toBe(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("exact boundary: 16384 bytes accepted, 16385 bytes rejected", async () => {
    const atLimit = payloadOfSerializedSize(MAX_PAYLOAD_BYTES);
    const overLimit = payloadOfSerializedSize(MAX_PAYLOAD_BYTES + 1);

    expect(payloadSizeBytes(atLimit)).toBe(MAX_PAYLOAD_BYTES);
    expect(payloadSizeBytes(overLimit)).toBe(MAX_PAYLOAD_BYTES + 1);

    expect(isPayloadWithinLimit(atLimit)).toBe(true);
    expect(isPayloadWithinLimit(overLimit)).toBe(false);

    const txOk = new RecordingQueryRunner();
    await appendEvent(txOk, {
      gameId: "g1",
      type: "e",
      actor: "system",
      payload: atLimit,
    });
    expect(txOk.calls).toBe(1);

    const txReject = new RecordingQueryRunner();
    await expect(
      appendEvent(txReject, {
        gameId: "g1",
        type: "e",
        actor: "system",
        payload: overLimit,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(txReject.calls).toBe(0);
  });
});
