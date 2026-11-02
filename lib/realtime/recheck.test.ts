import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GameEvent } from "@/lib/events";
import type { CancelScheduled, Scheduler } from "@/lib/realtime/reconnect";
import {
  nextRecheckAt,
  RECHECK_INTERVAL_MS,
  RecheckController,
  type RecheckDeps,
  type RecheckState,
} from "@/lib/realtime/recheck";

/**
 * Hermetic unit tests for the recheck-behind-Realtime controller (Task 9.10;
 * design.md "Recheck behind Realtime"; Req 23.6, 23.7, 23.8).
 *
 * The pure {@link nextRecheckAt} decision is exercised directly. The stateful
 * {@link RecheckController} is driven with an injected fake {@link Scheduler}
 * (one pending timer, fired on demand) and a fake server-time clock, so the whole
 * quiet-timer / fetch / re-arm loop runs deterministically with **no real
 * timers** and no live connection.
 */

const GAME_ID = "game-under-test";

/** Build a minimal but well-formed {@link GameEvent} at a given `seq`/time. */
function eventAt(seq: number, createdAtMs: number): GameEvent {
  return {
    id: `${GAME_ID}:${seq}`,
    gameId: GAME_ID,
    seq,
    eventType: "score_updated",
    actorKind: "system",
    actorTeamId: null,
    payload: { seq },
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

/* -------------------------------------------------------------------------- *
 * A fake scheduler: records the single pending timer and its requested delay,
 * fires it on demand, and tracks cancellation — the reconnect.ts test seam.
 * -------------------------------------------------------------------------- */

interface FakeScheduler {
  readonly scheduler: Scheduler;
  /** The delay requested for the currently-pending timer, or null if none. */
  pendingDelay: number | null;
  /** How many timers have ever been scheduled. */
  scheduleCount: number;
  /** How many pending timers have been cancelled. */
  cancelCount: number;
  /** Fire the pending timer (no-op if none is pending). */
  fire(): void;
  /** Whether a timer is currently armed. */
  isArmed(): boolean;
}

function makeFakeScheduler(): FakeScheduler {
  let pending: (() => void) | null = null;

  const fake: FakeScheduler = {
    pendingDelay: null,
    scheduleCount: 0,
    cancelCount: 0,
    scheduler(callback: () => void, delayMs: number): CancelScheduled {
      pending = callback;
      fake.pendingDelay = delayMs;
      fake.scheduleCount += 1;
      return () => {
        if (pending === callback) {
          pending = null;
          fake.pendingDelay = null;
          fake.cancelCount += 1;
        }
      };
    },
    fire(): void {
      const cb = pending;
      if (cb) {
        pending = null;
        fake.pendingDelay = null;
        cb();
      }
    },
    isArmed(): boolean {
      return pending !== null;
    },
  };

  return fake;
}

/* -------------------------------------------------------------------------- *
 * A fake server-time clock the test advances explicitly.
 * -------------------------------------------------------------------------- */

interface FakeClock {
  readonly now: () => number;
  set(ms: number): void;
  advance(ms: number): void;
}

function makeFakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  return {
    now: () => current,
    set(ms: number): void {
      current = ms;
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

/* -------------------------------------------------------------------------- *
 * A fake projection + fetch harness for controller tests.
 * -------------------------------------------------------------------------- */

interface Harness {
  readonly controller: RecheckController;
  readonly scheduler: FakeScheduler;
  readonly clock: FakeClock;
  /** Sets the watermark the controller reads via lastSeq(). */
  setLastSeq(seq: number): void;
  /** Sets whether the game is live. */
  setLive(live: boolean): void;
  /** Every batch handed to fetchEventsAfter's caller, in call order. */
  readonly appliedBatches: GameEvent[][];
  /** The (gameId, afterSeq) args of each fetch, in call order. */
  readonly fetchArgs: Array<{ gameId: string; afterSeq: number }>;
}

interface HarnessOptions {
  live?: boolean;
  lastSeq?: number;
  /** Resolve each fetch with these events; defaults to resolving []. */
  fetch?: (gameId: string, afterSeq: number) => Promise<GameEvent[]>;
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const scheduler = makeFakeScheduler();
  const clock = makeFakeClock();
  let live = opts.live ?? true;
  let lastSeq = opts.lastSeq ?? 0;

  const appliedBatches: GameEvent[][] = [];
  const fetchArgs: Array<{ gameId: string; afterSeq: number }> = [];

  const fetchEventsAfter: RecheckDeps["fetchEventsAfter"] = async (
    gameId,
    afterSeq,
  ) => {
    fetchArgs.push({ gameId, afterSeq });
    return opts.fetch ? opts.fetch(gameId, afterSeq) : [];
  };

  const deps: RecheckDeps = {
    fetchEventsAfter,
    apply: (events) => {
      appliedBatches.push([...events]);
    },
    lastSeq: () => lastSeq,
    isLive: () => live,
    scheduler: scheduler.scheduler,
    now: clock.now,
  };

  return {
    controller: new RecheckController(GAME_ID, deps),
    scheduler,
    clock,
    setLastSeq: (seq) => {
      lastSeq = seq;
    },
    setLive: (value) => {
      live = value;
    },
    appliedBatches,
    fetchArgs,
  };
}

/** Let any pending microtasks (awaited fetch/apply) settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/* ========================================================================== *
 * Pure decision: nextRecheckAt
 * ========================================================================== */

describe("nextRecheckAt — pure scheduling decision", () => {
  const base: RecheckState = {
    isLive: true,
    lastAppliedCreatedAtMs: null,
    lastFireMs: null,
    hasSeqGap: false,
  };

  it("returns null when the game is not live", () => {
    expect(
      nextRecheckAt({
        ...base,
        isLive: false,
        lastAppliedCreatedAtMs: 10,
        lastFireMs: 20,
      }),
    ).toBeNull();
  });

  it('returns "now" when a seq gap is pending (and live)', () => {
    expect(nextRecheckAt({ ...base, hasSeqGap: true })).toBe("now");
  });

  it('prioritizes a seq gap ("now") over any quiet deadline', () => {
    expect(
      nextRecheckAt({
        ...base,
        hasSeqGap: true,
        lastAppliedCreatedAtMs: 1_000,
        lastFireMs: 2_000,
      }),
    ).toBe("now");
  });

  it("uses lastAppliedCreatedAtMs + 15s when it is the later basis", () => {
    expect(
      nextRecheckAt({
        ...base,
        lastAppliedCreatedAtMs: 5_000,
        lastFireMs: 1_000,
      }),
    ).toBe(5_000 + RECHECK_INTERVAL_MS);
  });

  it("uses lastFireMs + 15s when it is the later basis", () => {
    expect(
      nextRecheckAt({
        ...base,
        lastAppliedCreatedAtMs: 1_000,
        lastFireMs: 8_000,
      }),
    ).toBe(8_000 + RECHECK_INTERVAL_MS);
  });

  it("takes the max of the two bases when only one is present", () => {
    expect(nextRecheckAt({ ...base, lastAppliedCreatedAtMs: 3_000 })).toBe(
      3_000 + RECHECK_INTERVAL_MS,
    );
    expect(nextRecheckAt({ ...base, lastFireMs: 4_000 })).toBe(
      4_000 + RECHECK_INTERVAL_MS,
    );
  });

  it("returns null when live but there is no basis to arm", () => {
    expect(nextRecheckAt(base)).toBeNull();
  });
});

/* ========================================================================== *
 * Controller: start / quiet fire / fetch + apply
 * ========================================================================== */

describe("RecheckController — start and quiet fire", () => {
  it("arms on start, seeding the quiet window one interval out from now", () => {
    const h = makeHarness({ live: true });
    h.controller.start();

    expect(h.scheduler.isArmed()).toBe(true);
    // Seeded lastFireMs = now; deadline = now + 15s; delay = 15s.
    expect(h.scheduler.pendingDelay).toBe(RECHECK_INTERVAL_MS);
  });

  it("does not arm when the game is not live", () => {
    const h = makeHarness({ live: false });
    h.controller.start();

    expect(h.scheduler.isArmed()).toBe(false);
    expect(h.scheduler.scheduleCount).toBe(0);
  });

  it("fires one Recheck_Interval later when quiet: fetches after lastSeq and applies", async () => {
    const applied = [eventAt(6, 1_700_000_050_000)];
    const h = makeHarness({
      live: true,
      lastSeq: 5,
      fetch: async () => applied,
    });

    h.controller.start();
    expect(h.scheduler.pendingDelay).toBe(RECHECK_INTERVAL_MS);

    // Quiet interval elapses; the timer fires.
    h.clock.advance(RECHECK_INTERVAL_MS);
    h.scheduler.fire();
    await flush();

    // Fetched everything past the watermark and applied it.
    expect(h.fetchArgs).toEqual([{ gameId: GAME_ID, afterSeq: 5 }]);
    expect(h.appliedBatches).toEqual([applied]);

    // Re-armed after the fire for the next quiet window.
    expect(h.scheduler.isArmed()).toBe(true);
    expect(h.scheduler.pendingDelay).toBe(RECHECK_INTERVAL_MS);
  });
});

/* ========================================================================== *
 * Controller: noteEvent restarts the quiet window on contiguous progress
 * ========================================================================== */

describe("RecheckController — noteEvent and the quiet window", () => {
  it("restarts the quiet window from a contiguously applied event's created_at", () => {
    const h = makeHarness({ live: true, lastSeq: 0 });
    h.controller.start();

    const startDelay = h.scheduler.pendingDelay;
    expect(startDelay).toBe(RECHECK_INTERVAL_MS);

    // 5s later a contiguous event (seq advanced the frontier to 1) is applied.
    h.clock.advance(5_000);
    h.setLastSeq(1);
    const createdAtMs = h.clock.now(); // event committed "now" in server time
    h.controller.noteEvent(eventAt(1, createdAtMs));

    // The quiet deadline now runs from the event's created_at: a fresh 15s,
    // not merely the 10s remaining on the original start window.
    expect(h.scheduler.pendingDelay).toBe(RECHECK_INTERVAL_MS);
  });

  it("does not fire until a full interval of quiet passes after the last event", async () => {
    const h = makeHarness({ live: true, lastSeq: 0 });
    h.controller.start();

    // Apply a contiguous event at t+5s.
    h.clock.advance(5_000);
    h.setLastSeq(1);
    h.controller.noteEvent(eventAt(1, h.clock.now()));

    // Advance only part of the window and fire — but the scheduler fires the
    // callback the controller armed; delay reflects the fresh window.
    expect(h.scheduler.pendingDelay).toBe(RECHECK_INTERVAL_MS);

    // Full window passes; fire triggers the fetch.
    h.clock.advance(RECHECK_INTERVAL_MS);
    h.scheduler.fire();
    await flush();

    expect(h.fetchArgs).toEqual([{ gameId: GAME_ID, afterSeq: 1 }]);
  });

  it("ignores stale/duplicate events below the frontier (no immediate fetch)", async () => {
    const h = makeHarness({ live: true, lastSeq: 5 });
    h.controller.start();

    // A duplicate for an already-applied seq: frontier is 5, event.seq 3 < 5.
    h.controller.noteEvent(eventAt(3, h.clock.now()));
    await flush();

    // No seq-gap fetch; still a quiet timer armed.
    expect(h.fetchArgs).toHaveLength(0);
    expect(h.scheduler.isArmed()).toBe(true);
  });

  it("is a no-op before start / after stop", () => {
    const h = makeHarness({ live: true, lastSeq: 0 });

    // Before start: noteEvent does nothing.
    h.controller.noteEvent(eventAt(1, h.clock.now()));
    expect(h.scheduler.isArmed()).toBe(false);

    h.controller.start();
    h.controller.stop();
    h.setLastSeq(5);
    h.controller.noteEvent(eventAt(6, h.clock.now()));
    // Stopped: nothing re-armed by noteEvent.
    expect(h.scheduler.isArmed()).toBe(false);
  });
});

/* ========================================================================== *
 * Controller: a seq gap triggers an immediate fetch
 * ========================================================================== */

describe("RecheckController — seq gap triggers an immediate fetch", () => {
  it("fetches at once (no 15s wait) when an event arrives ahead of the frontier", async () => {
    const h = makeHarness({ live: true, lastSeq: 2 });
    h.controller.start();
    expect(h.scheduler.pendingDelay).toBe(RECHECK_INTERVAL_MS);

    // An event arrives at seq 5 while the frontier is only 2: seq > 2 + 1.
    h.controller.noteEvent(eventAt(5, h.clock.now()));
    await flush();

    // Immediate fetch from the current watermark, not after the quiet window.
    expect(h.fetchArgs).toEqual([{ gameId: GAME_ID, afterSeq: 2 }]);
    // After firing it re-arms a quiet timer.
    expect(h.scheduler.isArmed()).toBe(true);
    expect(h.scheduler.pendingDelay).toBe(RECHECK_INTERVAL_MS);
  });
});

/* ========================================================================== *
 * Controller: a failed fetch re-arms without applying
 * ========================================================================== */

describe("RecheckController — failed fetch re-arms without applying", () => {
  it("swallows a rejected fetch, applies nothing, and re-arms the quiet timer", async () => {
    let calls = 0;
    const h = makeHarness({
      live: true,
      lastSeq: 4,
      fetch: async () => {
        calls += 1;
        throw new Error("network down");
      },
    });

    h.controller.start();
    h.clock.advance(RECHECK_INTERVAL_MS);
    h.scheduler.fire();
    await flush();

    expect(calls).toBe(1);
    // Nothing applied on failure.
    expect(h.appliedBatches).toHaveLength(0);
    // Re-armed for another quiet window.
    expect(h.scheduler.isArmed()).toBe(true);
    expect(h.scheduler.pendingDelay).toBe(RECHECK_INTERVAL_MS);
  });
});

/* ========================================================================== *
 * Controller: stop() cancels the pending timer
 * ========================================================================== */

describe("RecheckController — stop cancels the pending timer", () => {
  it("cancels the armed timer so it never fires", async () => {
    const h = makeHarness({ live: true, lastSeq: 0 });
    h.controller.start();
    expect(h.scheduler.isArmed()).toBe(true);

    h.controller.stop();

    expect(h.scheduler.isArmed()).toBe(false);
    expect(h.scheduler.cancelCount).toBe(1);

    // Firing a now-cancelled timer does nothing (defensive).
    h.scheduler.fire();
    await flush();
    expect(h.fetchArgs).toHaveLength(0);
  });

  it("does not apply a fetch result that resolves after stop()", async () => {
    let resolveFetch: ((events: GameEvent[]) => void) | undefined;
    const h = makeHarness({
      live: true,
      lastSeq: 0,
      fetch: () =>
        new Promise<GameEvent[]>((resolve) => {
          resolveFetch = resolve;
        }),
    });

    h.controller.start();
    h.clock.advance(RECHECK_INTERVAL_MS);
    h.scheduler.fire(); // fetch is now in flight

    // Stop before the fetch resolves.
    h.controller.stop();
    resolveFetch?.([eventAt(1, h.clock.now())]);
    await flush();

    // The late result is not applied, and nothing is re-armed.
    expect(h.appliedBatches).toHaveLength(0);
    expect(h.scheduler.isArmed()).toBe(false);
  });

  it("stop() is idempotent", () => {
    const h = makeHarness({ live: true, lastSeq: 0 });
    h.controller.start();

    h.controller.stop();
    h.controller.stop();

    expect(h.scheduler.cancelCount).toBe(1);
    expect(h.scheduler.isArmed()).toBe(false);
  });
});

/* ========================================================================== *
 * No real timers leak: guard against accidental setTimeout use.
 * ========================================================================== */

describe("RecheckController — uses no real timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules via the injected scheduler only (no setTimeout)", () => {
    const h = makeHarness({ live: true, lastSeq: 0 });
    h.controller.start();

    // The injected fake recorded the timer; the real timer queue stays empty.
    expect(h.scheduler.isArmed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
