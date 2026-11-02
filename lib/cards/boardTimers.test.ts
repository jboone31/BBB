import { describe, expect, it } from "vitest";

import type { CancelScheduled, Scheduler } from "@/lib/realtime/reconnect";

import {
  BoardTimerController,
  effectTransitionTimes,
  nextNudgeAt,
  NUDGE_DELAY_MS,
  NUDGE_JITTER_MS,
  type BoardTimerDeps,
  type SettleNudgeResult,
} from "./boardTimers";
import type { EffectRecord } from "./effects";

/**
 * Hermetic tests for the board's toast and nudge timers and the
 * Server_Clock_Offset (card-behavior Task 12.5; Requirements 20.3a, 20.7, 20.8,
 * 20.9). The controller runs against a fake multi-timer scheduler on a virtual
 * device clock, so no real timers are involved.
 */

const T0 = Date.parse("2025-06-01T20:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function effect(overrides: Partial<EffectRecord> = {}): EffectRecord {
  return {
    effectId: "ef-1",
    slug: "crop-dusting",
    kind: "bar_lock",
    sourcePlayId: "play-1",
    sourceChallengeId: null,
    ownerTeamId: "team-a",
    targetTeamId: null,
    targetBarKey: null,
    startsAt: iso(T0 - 60_000),
    endsAt: iso(T0 + 60_000),
    params: {},
    attachedClaimId: null,
    attachedBarKey: null,
    protectedPoints: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    startAnnounced: true,
    endAnnounced: false,
    ...overrides,
  };
}

/** A virtual device clock plus a scheduler that fires due timers in order. */
function makeClock(startMs: number) {
  let now = startMs;
  let nextId = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const scheduler: Scheduler = (cb, delayMs): CancelScheduled => {
    const id = nextId++;
    timers.set(id, { at: now + delayMs, cb });
    return () => {
      timers.delete(id);
    };
  };
  return {
    scheduler,
    now: () => now,
    pending: () => [...timers.values()].map((t) => t.at - now),
    /** Advance the device clock, firing every timer that comes due. */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < dueAt) {
            dueAt = t.at;
            dueId = id;
          }
        }
        if (dueId === null) {
          break;
        }
        const timer = timers.get(dueId)!;
        timers.delete(dueId);
        now = Math.max(now, timer.at);
        timer.cb();
      }
      now = target;
    },
  };
}

/** Let resolved settle promises run their continuations. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Device clock runs 10 s behind the server. */
const SKEW_MS = 10_000;

function setup(
  effects: EffectRecord[],
  overrides: Partial<BoardTimerDeps> = {},
) {
  const clock = makeClock(T0 - SKEW_MS);
  const calls = { settle: 0, boundary: 0, offsets: [] as number[] };
  let live = true;
  const deps: BoardTimerDeps = {
    scheduler: clock.scheduler,
    deviceNow: clock.now,
    effects: () => effects,
    isLive: () => live,
    settle: async (): Promise<SettleNudgeResult | null> => {
      calls.settle += 1;
      return { serverNow: iso(clock.now() + SKEW_MS) };
    },
    onOffsetChange: (offset) => calls.offsets.push(offset),
    onBoundary: () => {
      calls.boundary += 1;
    },
    random: () => 0.5,
    ...overrides,
  };
  const controller = new BoardTimerController(deps);
  return {
    clock,
    calls,
    controller,
    setLive: (v: boolean) => {
      live = v;
    },
  };
}

describe("pure scheduling helpers", () => {
  it("lists unannounced, uncancelled start and end times", () => {
    const times = effectTransitionTimes([
      effect({ effectId: "a" }),
      effect({
        effectId: "b",
        startAnnounced: false,
        startsAt: iso(T0 + 1_000),
      }),
      effect({ effectId: "c", endAnnounced: true }),
      effect({
        effectId: "d",
        endsAt: iso(T0 + 5_000),
        cancelledAt: iso(T0),
      }),
      effect({ effectId: "e", endsAt: iso(T0 + 7_000), consumedAt: iso(T0) }),
    ]);
    expect(times).toEqual([T0 + 1_000, T0 + 60_000]);
  });

  it("nudges 3-5 s after the first unsettled boundary", () => {
    const effects = [effect()];
    expect(nextNudgeAt(effects, T0, 0)).toBe(T0 + 60_000 + NUDGE_DELAY_MS);
    expect(nextNudgeAt(effects, T0, 99_999)).toBe(
      T0 + 60_000 + NUDGE_DELAY_MS + NUDGE_JITTER_MS,
    );
    expect(nextNudgeAt(effects, T0 + 60_000, 0)).toBeNull();
  });
});

describe("BoardTimerController", () => {
  it("nudges on start and measures the offset from serverNow", async () => {
    const { calls, controller } = setup([effect()]);
    controller.start();
    await flush();
    expect(calls.settle).toBe(1);
    expect(controller.offsetMs).toBe(SKEW_MS);
    expect(calls.offsets).toEqual([SKEW_MS]);
    expect(controller.serverNowMs()).toBe(T0);
    controller.stop();
  });

  it("adjusts the offset by half the round trip", async () => {
    let resolveSettle: (r: SettleNudgeResult) => void = () => {};
    const { clock, controller } = setup([], {
      settle: () =>
        new Promise<SettleNudgeResult>((resolve) => {
          resolveSettle = resolve;
        }),
    });
    controller.start();
    clock.advance(400);
    // Server stamp taken at the round-trip midpoint (device T0 - SKEW + 200).
    resolveSettle({ serverNow: iso(T0 + 200) });
    await flush();
    expect(controller.offsetMs).toBe(SKEW_MS);
    controller.stop();
  });

  it("fires the toast timer at the boundary in server time", async () => {
    const { clock, calls, controller } = setup([effect()]);
    controller.start();
    await flush();
    clock.advance(59_999);
    expect(calls.boundary).toBe(0);
    clock.advance(1);
    expect(calls.boundary).toBe(1);
    controller.stop();
  });

  it("nudges within 5 s after a boundary and not again once settled", async () => {
    const { clock, calls, controller } = setup([effect()]);
    controller.start();
    await flush();
    expect(calls.settle).toBe(1);
    // random 0.5 -> 1 s jitter: nudge at boundary + 4 s.
    clock.advance(60_000 + 3_999);
    expect(calls.settle).toBe(1);
    clock.advance(1);
    await flush();
    expect(calls.settle).toBe(2);
    clock.advance(10 * 60_000);
    await flush();
    expect(calls.settle).toBe(2);
    controller.stop();
  });

  it("never nudges or arms timers while the game is not live", async () => {
    const { clock, calls, controller, setLive } = setup([effect()]);
    setLive(false);
    controller.start();
    await controller.nudge();
    await flush();
    expect(calls.settle).toBe(0);
    expect(clock.pending()).toEqual([]);
    controller.stop();
  });

  it("does not retry a failed nudge in a loop", async () => {
    const { clock, calls, controller } = setup([effect()], {
      settle: async () => {
        calls.settle += 1;
        return null;
      },
    });
    controller.start();
    await flush();
    clock.advance(1_000);
    await flush();
    expect(calls.settle).toBe(1);
    controller.stop();
  });

  it("reschedules after a fold adds a new boundary, and stop clears timers", async () => {
    const effects: EffectRecord[] = [];
    const { clock, calls, controller } = setup(effects);
    controller.start();
    await flush();
    expect(clock.pending()).toEqual([]);
    effects.push(effect({ endsAt: iso(T0 + 5_000) }));
    controller.reschedule();
    expect(clock.pending().sort((a, b) => a - b)).toEqual([5_000, 9_000]);
    clock.advance(5_000);
    expect(calls.boundary).toBe(1);
    controller.stop();
    expect(clock.pending()).toEqual([]);
  });
});
