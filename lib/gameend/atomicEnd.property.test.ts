import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { appendEvent, type QueryRunner, type SqlRow } from "../events";
import { endGame } from "./transition";

/**
 * Feature: web-app-foundation, Property 6: Atomic state-change-plus-event write
 *
 * Every Game_State_Change persists its domain write AND appends exactly one
 * game_event in one transaction. If the event write fails, the whole
 * transaction rolls back: the domain state is unchanged, the event log is
 * unchanged (zero new events), and an error is surfaced to the caller. If it
 * succeeds, the log grows by exactly one event and the domain change persists.
 *
 * The real guarantee comes from `withTransaction` (lib/db/server.ts), which runs
 * the caller's domain write and `appendEvent` inside one postgres.js
 * `sql.begin(...)` transaction that COMMITs on normal return and ROLLBACKs on
 * any throw (exercised end-to-end by the integration tests, Task 18). Here we
 * property-test the pure transactional model of that rule: a fake in-memory
 * store + a `withTransaction`-like wrapper that snapshots state on begin and
 * restores it on throw, driving the REAL `appendEvent` and the REAL end
 * transition `endGame` (lib/gameend/transition.ts) through a fake QueryRunner.
 * A fast-check-controlled flag injects a failure on the event insert; every
 * modeled mutation — generic domain writes and end transitions alike — must be
 * all-or-nothing.
 *
 * Validates: Requirements 4.3, 4.4, 5.3
 */

// ---------------------------------------------------------------------------
// Fake in-memory transactional store
// ---------------------------------------------------------------------------

type Lifecycle = "lobby" | "live" | "ended";
type EndReason = "finish_bar_claimed" | "admin_ended" | "auto_timeout";

/** A stored game_events row (snake_case columns, as a real driver returns). */
interface EventRow extends SqlRow {
  id: string;
  game_id: string;
  seq: number;
  event_type: string;
  actor_kind: string;
  actor_team_id: string | null;
  payload: unknown;
  created_at: string;
}

/** The mutable domain + log state the store holds for a single game. */
interface GameState {
  lifecycle: Lifecycle;
  endReason: EndReason | null;
  /**
   * A generic domain counter mutated by non-end "domain writes", used to prove
   * an arbitrary Game_State_Change also rolls back with its event on failure.
   */
  domainCounter: number;
}

/** A structural snapshot used to assert state is unchanged on rollback. */
interface StoreSnapshot {
  game: GameState;
  events: EventRow[];
}

/**
 * A fake transactional store modeling one game plus its append-only event log.
 *
 * It exposes a {@link QueryRunner} that understands exactly the statements the
 * code under test issues:
 *   - `endGame` → the game-lock SELECT and the lifecycle UPDATE, and
 *   - `appendEvent` → the lock+next-seq+insert CTE.
 * The event insert can be injected to fail (simulating a constraint violation /
 * lost connection on the event write), which is the failure mode Property 6
 * requires to roll the whole transaction back.
 */
class FakeStore {
  private state: GameState;
  private events: EventRow[] = [];
  private nextId = 1;
  /** When true, the next event INSERT throws instead of writing. */
  failEventWrite = false;

  constructor(
    private readonly gameId: string,
    initial: GameState,
  ) {
    this.state = { ...initial };
  }

  /** Deep structural snapshot for begin/rollback and for test assertions. */
  snapshot(): StoreSnapshot {
    return {
      game: { ...this.state },
      events: this.events.map((row) => ({ ...row })),
    };
  }

  /** Restore a previously taken snapshot (transaction rollback). */
  restore(snap: StoreSnapshot): void {
    this.state = { ...snap.game };
    this.events = snap.events.map((row) => ({ ...row }));
  }

  get eventCount(): number {
    return this.events.length;
  }

  get lifecycle(): Lifecycle {
    return this.state.lifecycle;
  }

  get endReason(): EndReason | null {
    return this.state.endReason;
  }

  get domainCounter(): number {
    return this.state.domainCounter;
  }

  /** A generic domain write used by the modeled non-end mutations. */
  bumpDomainCounter(): void {
    this.state.domainCounter += 1;
  }

  /** The QueryRunner the code under test runs its statements through. */
  runner(): QueryRunner {
    return {
      query: (sql: string, params: readonly unknown[] = []) =>
        Promise.resolve(this.dispatch(sql, params)),
    };
  }

  private dispatch(
    sql: string,
    params: readonly unknown[],
  ): { rows: SqlRow[] } {
    const text = sql.trim();

    // endGame step 1: lock + read lifecycle.
    if (text.startsWith("select lifecycle")) {
      return { rows: [{ lifecycle: this.state.lifecycle }] };
    }

    // endGame step 3a: lifecycle -> 'ended' + end_reason, guarded to 'live'.
    if (text.startsWith("update games")) {
      const endReason = params[1] as EndReason;
      if (this.state.lifecycle !== "live") {
        // The in-SQL guard matched no row.
        return { rows: [] };
      }
      this.state.lifecycle = "ended";
      this.state.endReason = endReason;
      return { rows: [{ id: this.gameId }] };
    }

    // appendEvent: the lock + next-seq + insert CTE.
    if (text.startsWith("with locked")) {
      if (this.failEventWrite) {
        // Simulate the event write failing (e.g. constraint violation / lost
        // connection). The caller's transaction wrapper must roll back.
        throw new Error("injected event-write failure");
      }
      const [
        gameId,
        eventType,
        actorKind,
        actorTeamId,
        payloadJson,
        createdAt,
      ] = params as [string, string, string, string | null, string, string];
      const seq =
        this.events.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
      const row: EventRow = {
        id: `e${this.nextId++}`,
        game_id: gameId,
        seq,
        event_type: eventType,
        actor_kind: actorKind,
        actor_team_id: actorTeamId,
        payload: payloadJson,
        created_at: createdAt,
      };
      this.events.push(row);
      return { rows: [row] };
    }

    throw new Error(`FakeStore: unexpected SQL: ${text.slice(0, 40)}`);
  }
}

/**
 * A `withTransaction`-like wrapper mirroring lib/db/server.ts: snapshot the
 * store on begin, run `fn` against the store's runner, COMMIT on normal return
 * (keep mutations), and ROLLBACK (restore the snapshot) then rethrow on any
 * throw. This is the pure model of postgres.js `sql.begin(...)`.
 */
async function withTransaction<T>(
  store: FakeStore,
  fn: (tx: QueryRunner) => Promise<T>,
): Promise<T> {
  const snap = store.snapshot();
  try {
    return await fn(store.runner());
  } catch (err) {
    store.restore(snap); // ROLLBACK: domain state AND event log unchanged.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Modeled mutations
// ---------------------------------------------------------------------------

/**
 * The set of Game_State_Changes we drive: a generic domain write (bump a
 * counter + append one event) and the two `endGame` end transitions. Each does
 * a domain write AND exactly one appendEvent inside one transaction.
 */
type MutationKind = "domain_write" | "end_admin" | "end_timeout";

const GAME_ID = "game-1";

/** Run one mutation inside a transaction; returns nothing (throws on failure). */
async function runMutation(
  store: FakeStore,
  kind: MutationKind,
): Promise<{ applied: boolean }> {
  return withTransaction(store, async (tx) => {
    if (kind === "domain_write") {
      // A generic Game_State_Change: domain write + exactly one event.
      store.bumpDomainCounter();
      await appendEvent(tx, {
        gameId: GAME_ID,
        type: "domain_write",
        actor: "system",
        payload: { note: "generic state change" },
      });
      return { applied: true };
    }

    // End transition (admin-ended or auto-timeout): endGame does the lifecycle
    // write + exactly one game_ended event, or rejects without writing.
    const reason: EndReason =
      kind === "end_admin" ? "admin_ended" : "auto_timeout";
    const result = await endGame(tx, { gameId: GAME_ID, endReason: reason });
    return { applied: result.ok };
  });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const lifecycleArb: fc.Arbitrary<Lifecycle> = fc.constantFrom(
  "lobby",
  "live",
  "ended",
);

const mutationArb: fc.Arbitrary<MutationKind> = fc.constantFrom(
  "domain_write",
  "end_admin",
  "end_timeout",
);

/** A single step: which mutation to run, and whether to inject an event fail. */
const stepArb = fc.record({
  kind: mutationArb,
  injectFailure: fc.boolean(),
});

/** An initial game state; end_reason is set iff already ended. */
const initialStateArb: fc.Arbitrary<GameState> = lifecycleArb.map(
  (lifecycle) => ({
    lifecycle,
    endReason: lifecycle === "ended" ? "admin_ended" : null,
    domainCounter: 0,
  }),
);

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Atomic state-change-plus-event write (Property 6)", () => {
  it("commits domain change + exactly one event on success; rolls both back on event-write failure", async () => {
    await fc.assert(
      fc.asyncProperty(
        initialStateArb,
        fc.array(stepArb, { minLength: 1, maxLength: 40 }),
        async (initial, steps) => {
          const store = new FakeStore(GAME_ID, initial);

          for (const step of steps) {
            // Snapshot the observable state before the mutation.
            const before = store.snapshot();
            const eventsBefore = store.eventCount;

            store.failEventWrite = step.injectFailure;

            let threw = false;
            let applied = false;
            try {
              const outcome = await runMutation(store, step.kind);
              applied = outcome.applied;
            } catch {
              threw = true;
            } finally {
              store.failEventWrite = false;
            }

            const eventsAfter = store.eventCount;

            if (step.injectFailure) {
              // Whether the mutation would have appended an event depends on
              // whether it reaches the append at all. An end transition on a
              // non-live game rejects BEFORE appending, so no event write is
              // attempted and no failure is injected into the flow.
              const reachesAppend =
                step.kind === "domain_write" ||
                before.game.lifecycle === "live";

              if (reachesAppend) {
                // FAILURE PATH: the injected event-write failure must roll back
                // the whole transaction. Error surfaced, zero new events, and
                // both domain state and log unchanged (Req 4.3, 4.4).
                expect(threw).toBe(true);
                expect(eventsAfter).toBe(eventsBefore); // 0 new events
                expect(eventsAfter).toBe(before.events.length);
                expect(store.lifecycle).toBe(before.game.lifecycle);
                expect(store.endReason).toBe(before.game.endReason);
                expect(store.domainCounter).toBe(before.game.domainCounter);
              } else {
                // Guarded-out end transition: rejected without touching the log
                // or state, and no error surfaced.
                expect(threw).toBe(false);
                expect(applied).toBe(false);
                expect(eventsAfter).toBe(eventsBefore);
                expect(store.lifecycle).toBe(before.game.lifecycle);
                expect(store.endReason).toBe(before.game.endReason);
                expect(store.domainCounter).toBe(before.game.domainCounter);
              }
              continue;
            }

            // SUCCESS-ATTEMPT PATH (no injected failure).
            expect(threw).toBe(false);

            if (applied) {
              // Applied Game_State_Change: exactly +1 event and the domain
              // change persisted (Req 4.3, 5.3).
              expect(eventsAfter).toBe(eventsBefore + 1);
              if (step.kind === "domain_write") {
                expect(store.domainCounter).toBe(before.game.domainCounter + 1);
                expect(store.lifecycle).toBe(before.game.lifecycle);
              } else {
                // End transition succeeds only from 'live'.
                expect(before.game.lifecycle).toBe("live");
                expect(store.lifecycle).toBe("ended");
                expect(store.endReason).toBe(
                  step.kind === "end_admin" ? "admin_ended" : "auto_timeout",
                );
              }
            } else {
              // Not applied: only an end transition on a non-live game. Nothing
              // written, state unchanged (Req 5.4/5.5).
              expect(step.kind).not.toBe("domain_write");
              expect(before.game.lifecycle).not.toBe("live");
              expect(eventsAfter).toBe(eventsBefore);
              expect(store.lifecycle).toBe(before.game.lifecycle);
              expect(store.endReason).toBe(before.game.endReason);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("appends exactly one event and ends the game on a successful admin end", async () => {
    // Explicit success example for an end transition.
    const store = new FakeStore(GAME_ID, {
      lifecycle: "live",
      endReason: null,
      domainCounter: 0,
    });
    const before = store.eventCount;

    const outcome = await runMutation(store, "end_admin");

    expect(outcome.applied).toBe(true);
    expect(store.eventCount).toBe(before + 1);
    expect(store.lifecycle).toBe("ended");
    expect(store.endReason).toBe("admin_ended");
  });

  it("rolls back the end transition entirely when the event write fails", async () => {
    // Explicit failure example: a live game whose game_ended event fails to
    // write must remain 'live' with no new event and an error surfaced.
    const store = new FakeStore(GAME_ID, {
      lifecycle: "live",
      endReason: null,
      domainCounter: 0,
    });
    const before = store.eventCount;
    store.failEventWrite = true;

    await expect(runMutation(store, "end_timeout")).rejects.toThrow(
      /injected event-write failure/,
    );

    expect(store.eventCount).toBe(before); // 0 new events
    expect(store.lifecycle).toBe("live"); // lifecycle unchanged
    expect(store.endReason).toBeNull(); // end_reason unchanged
  });

  it("rolls back a generic domain write with its event on failure", async () => {
    const store = new FakeStore(GAME_ID, {
      lifecycle: "live",
      endReason: null,
      domainCounter: 7,
    });
    store.failEventWrite = true;

    await expect(runMutation(store, "domain_write")).rejects.toThrow(
      /injected event-write failure/,
    );

    expect(store.eventCount).toBe(0); // 0 new events
    expect(store.domainCounter).toBe(7); // domain change rolled back
  });
});
