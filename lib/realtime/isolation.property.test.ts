import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { GameEvent } from "@/lib/events";
import {
  subscribe,
  type RealtimeChannel,
  type RealtimeTransport,
} from "@/lib/realtime";
import { type SnapshotSource } from "@/lib/realtime/snapshot";

/**
 * Feature: web-app-foundation, Property 14: Per-game isolation of delivery and data access
 *
 * Two distinct facets of per-game isolation are modeled here at the pure/model
 * level (design.md Component 6 RLS model; §"Isolation (Req 6.3)"). The live
 * guarantees — a Supabase channel filtered by `game_id` and Postgres RLS keyed
 * off `bbb_is_game_member(game_id)` — are additionally exercised by the
 * environment-dependent integration tests 18.2 / 18.5. This property fixes the
 * model those live pieces implement:
 *
 *   1. **Delivery isolation (Req 6.3).** A client scoped to game G subscribes
 *      through an injectable {@link RealtimeTransport} that, like a correctly
 *      `game_id`-filtered channel, only pushes G's rows — PLUS the subscriber's
 *      own defensive `onEvent` guard that drops any event whose `gameId !== G`.
 *      Fed a mixed stream of events for distinct games A and B (client scoped
 *      to G = A), the client applies/delivers exactly A's events and never B's.
 *
 *   2. **Data-access isolation (Req 7.2).** A session scoped to game G may read
 *      or write only rows whose `game_id === G` (mirroring the RLS rule: a
 *      policy permits a row iff the session's membership matches the row's
 *      `game_id`). A cross-game read of B returns nothing (denied, and does not
 *      reveal B's rows) and a cross-game write to B is denied and leaves B's
 *      data byte-for-byte unchanged.
 *
 * Validates: Requirements 6.3, 7.2
 */

/* -------------------------------------------------------------------------- *
 * Shared generators
 * -------------------------------------------------------------------------- */

/** Build a well-formed {@link GameEvent} for a given game at a given `seq`. */
function eventAt(gameId: string, seq: number): GameEvent {
  return {
    id: `${gameId}:${seq}`,
    gameId,
    seq,
    eventType: "score_updated",
    actorKind: "system",
    actorTeamId: null,
    payload: { gameId, seq },
    createdAt: new Date(1_700_000_000_000 + seq).toISOString(),
  };
}

/** Two distinct game ids A and B. */
const distinctGamesArb: fc.Arbitrary<{ a: string; b: string }> = fc
  .tuple(fc.uuid({ version: 4 }), fc.uuid({ version: 4 }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]) => ({ a, b }));

/* -------------------------------------------------------------------------- *
 * Facet 1: Delivery isolation (Req 6.3)
 * -------------------------------------------------------------------------- */

/**
 * An in-memory transport that mirrors a correctly `game_id`-filtered Supabase
 * channel: when a client subscribes to `gameId`, it is handed a row callback,
 * and the harness later replays a stream through it. The transport itself only
 * forwards rows matching the subscribed `gameId` (the channel filter). The
 * subscriber's own `onEvent` guard is the defensive second layer.
 */
function makeFilteringTransport(): {
  transport: RealtimeTransport;
  /** Deliver a row as the channel would, applying the game_id filter. */
  deliver: (gameId: string, event: GameEvent) => void;
} {
  const sinks = new Map<string, (event: GameEvent) => void>();
  const transport: RealtimeTransport = {
    channel(
      gameId: string,
      onRow: (event: GameEvent) => void,
    ): RealtimeChannel {
      sinks.set(gameId, onRow);
      return {
        unsubscribe: () => {
          sinks.delete(gameId);
        },
      };
    },
  };
  const deliver = (gameId: string, event: GameEvent): void => {
    const sink = sinks.get(gameId);
    // Channel filter: only forward rows for the subscribed game.
    if (sink && event.gameId === gameId) {
      sink(event);
    }
  };
  return { transport, deliver };
}

/** An empty snapshot source (no persisted events) for the subscribed game. */
function emptySnapshotSource(): SnapshotSource {
  return { fetchEventsAscending: async () => [] };
}

describe("Per-game isolation — delivery (Property 14, Req 6.3)", () => {
  it("delivers exactly game G's events from a mixed A/B stream", async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctGamesArb,
        // Contiguous seq counts for each game's stream.
        fc.integer({ min: 0, max: 25 }),
        fc.integer({ min: 0, max: 25 }),
        fc.integer({ min: 0, max: 0xffff_ffff }),
        async ({ a, b }, aCount, bCount, shuffleSeed) => {
          const g = a; // client is scoped to G = A.

          const aEvents = Array.from({ length: aCount }, (_, i) =>
            eventAt(a, i + 1),
          );
          const bEvents = Array.from({ length: bCount }, (_, i) =>
            eventAt(b, i + 1),
          );

          const { transport, deliver } = makeFilteringTransport();
          const delivered: GameEvent[] = [];

          const sub = await subscribe(g, {
            transport,
            snapshotSource: emptySnapshotSource(),
            handlers: { onEvent: (e) => delivered.push(e) },
          });

          // Interleave A and B events in a deterministic random order and feed
          // each to the transport, tagging it with the game it belongs to.
          const stream: Array<{ gameId: string; event: GameEvent }> = [
            ...aEvents.map((event) => ({ gameId: a, event })),
            ...bEvents.map((event) => ({ gameId: b, event })),
          ];
          const rng = mulberry32(shuffleSeed);
          for (let i = stream.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [stream[i], stream[j]] = [stream[j], stream[i]];
          }
          for (const { gameId, event } of stream) {
            deliver(gameId, event);
          }

          await sub.close();

          // Delivered set == events with game_id == G, in ascending seq order.
          expect(delivered.every((e) => e.gameId === g)).toBe(true);
          expect(delivered.map((e) => e.seq)).toEqual(
            Array.from({ length: aCount }, (_, i) => i + 1),
          );
          // No B event ever reached the client.
          expect(delivered.some((e) => e.gameId === b)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("defensive onEvent guard drops a foreign-game event even if the channel leaks it", async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctGamesArb,
        fc.integer({ min: 1, max: 20 }),
        async ({ a, b }, count) => {
          const g = a;
          const { transport } = makeFilteringTransport();
          const delivered: GameEvent[] = [];

          const sub = await subscribe(g, {
            transport,
            snapshotSource: emptySnapshotSource(),
            handlers: { onEvent: (e) => delivered.push(e) },
          });

          // Bypass the channel filter and push foreign-game events straight into
          // onEvent (simulating a leak); the subscriber must drop them all.
          for (let seq = 1; seq <= count; seq++) {
            sub.onEvent(eventAt(b, seq));
          }
          // A genuine G event still applies.
          sub.onEvent(eventAt(g, 1));

          await sub.close();

          expect(delivered.map((e) => e.gameId)).toEqual([g]);
          expect(sub.lastSeenSequence()).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Facet 2: Data-access isolation (Req 7.2)
 * -------------------------------------------------------------------------- */

/**
 * A per-game authorization model mirroring the RLS rule
 * `bbb_is_game_member(game_id)`: a session is scoped to exactly one game, and a
 * read or write is authorized iff the target row's `game_id` matches the
 * session's scope. This is a pure stand-in for the database policy so the
 * isolation invariant can be property-tested without a live Postgres.
 */
interface GameRow {
  readonly id: string;
  readonly gameId: string;
  value: number;
}

class GameScopedStore {
  private readonly rows = new Map<string, GameRow>();

  seed(row: GameRow): void {
    this.rows.set(row.id, { ...row });
  }

  /** Membership predicate: session for `sessionGameId` may touch `rowGameId`. */
  private isMember(sessionGameId: string, rowGameId: string): boolean {
    return sessionGameId === rowGameId;
  }

  /** Authorized read: returns the row only if the session is scoped to it. */
  read(sessionGameId: string, rowId: string): GameRow | undefined {
    const row = this.rows.get(rowId);
    if (!row || !this.isMember(sessionGameId, row.gameId)) {
      // Denied — do not reveal the row (Req 7.2).
      return undefined;
    }
    return { ...row };
  }

  /**
   * Authorized write: mutates the row only if the session is scoped to it.
   * Returns whether the write was applied. A denied write leaves data unchanged.
   */
  write(sessionGameId: string, rowId: string, value: number): boolean {
    const row = this.rows.get(rowId);
    if (!row || !this.isMember(sessionGameId, row.gameId)) {
      return false; // denied, no mutation
    }
    row.value = value;
    return true;
  }

  /** A raw, policy-bypassing snapshot for test assertions only. */
  rawSnapshot(): Map<string, GameRow> {
    return new Map(Array.from(this.rows, ([id, row]) => [id, { ...row }]));
  }
}

describe("Per-game isolation — data access (Property 14, Req 7.2)", () => {
  it("a session scoped to G reads/writes only G's rows; cross-game access to B is denied and B unchanged", () => {
    fc.assert(
      fc.property(
        distinctGamesArb,
        fc.integer({ min: 1, max: 15 }), // rows in game A (= G)
        fc.integer({ min: 1, max: 15 }), // rows in game B
        fc.integer({ min: -1000, max: 1000 }), // attempted write value
        ({ a, b }, aRows, bRows, writeValue) => {
          const g = a; // session scoped to G = A.
          const store = new GameScopedStore();

          const aIds = Array.from({ length: aRows }, (_, i) => `A-row-${i}`);
          const bIds = Array.from({ length: bRows }, (_, i) => `B-row-${i}`);
          aIds.forEach((id, i) => store.seed({ id, gameId: a, value: i }));
          bIds.forEach((id, i) =>
            store.seed({ id, gameId: b, value: 1000 + i }),
          );

          const before = store.rawSnapshot();

          // Reads: G's rows are readable; B's rows are denied (undefined).
          for (const id of aIds) {
            expect(store.read(g, id)?.gameId).toBe(g);
          }
          for (const id of bIds) {
            expect(store.read(g, id)).toBeUndefined();
          }

          // Writes to G succeed; writes to B are denied.
          for (const id of aIds) {
            expect(store.write(g, id, writeValue)).toBe(true);
          }
          for (const id of bIds) {
            expect(store.write(g, id, writeValue)).toBe(false);
          }

          const after = store.rawSnapshot();

          // The authorized/read set == exactly G's rows.
          const authorizedIds = [...after.keys()].filter(
            (id) => store.read(g, id) !== undefined,
          );
          expect(new Set(authorizedIds)).toEqual(new Set(aIds));

          // B's data is byte-for-byte unchanged by the cross-game attempts.
          for (const id of bIds) {
            expect(after.get(id)).toEqual(before.get(id));
          }
          // G's rows did take the write.
          for (const id of aIds) {
            expect(after.get(id)?.value).toBe(writeValue);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Deterministic PRNG (self-contained for reproducible shuffles)
 * -------------------------------------------------------------------------- */

/** A tiny deterministic PRNG (mulberry32) yielding floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
