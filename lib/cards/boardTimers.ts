/**
 * Board timers and the Server_Clock_Offset (card-behavior Task 12.5; design.md
 * "Server clock offset"; Requirements 3.7, 20.3a, 20.3d, 20.7, 20.8, 20.9,
 * 20.10, 20.11, 20.12).
 *
 * A connected board runs two timers, both against server time
 * (`serverNow(deviceNow, offset)`):
 *
 *   - **Toast timer** at `nextBoundaryAfter(effects, serverNow).atMs`. When it
 *     fires, the board re-derives its Boundary_Toasts (`deriveBoundaryToasts`),
 *     so a boundary toast appears within 2 s of the boundary (20.3a).
 *   - **Nudge timer** at each known Effect start or end time that still needs a
 *     transition event, plus {@link NUDGE_DELAY_MS} and a random
 *     0-{@link NUDGE_JITTER_MS} jitter, so the Settle_Nudge runs within 5 s of
 *     the boundary (20.8). The board also nudges on mount and on reconnect.
 *
 * Every Settle_Nudge response carries `serverNow`; the controller re-measures
 * the offset from it with {@link measureOffset} (20.9) and reschedules both
 * timers. Both timers also reschedule after each fold, each fire, and on
 * `visibilitychange` (the board calls {@link BoardTimerController.reschedule}).
 * Neither timer runs while the game is not live. Nothing server-side backs the
 * nudge, so a game with no connected board gets no timing guarantee (20.3d).
 *
 * The scheduling decisions ({@link effectTransitionTimes},
 * {@link nextNudgeAt}) are pure; the controller takes an injectable
 * {@link Scheduler}, device clock, and random source so it can be tested with a
 * fake scheduler.
 */

import type { Scheduler } from "@/lib/realtime/reconnect";

import { measureOffset, serverNow } from "./clockOffset";
import { nextBoundaryAfter, type EffectRecord } from "./effects";

/** The fixed delay after a boundary before the board nudges (20.8). */
export const NUDGE_DELAY_MS = 3_000;
/** The upper bound of the random jitter added to {@link NUDGE_DELAY_MS}. */
export const NUDGE_JITTER_MS = 2_000;

/** Parse an ISO timestamp to epoch ms, or `null` when absent/invalid. */
function parseMs(iso: string | null): number | null {
  if (iso === null) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The known Effect start and end times that still need a transition event,
 * ascending and deduplicated. Mirrors the due conditions of
 * `planEffectTransitions` without the "already due" check: a start counts while
 * `!startAnnounced` and the effect was not cancelled before it; an end counts
 * while `!endAnnounced`, the effect was not consumed, and it was not cancelled
 * before its end.
 */
export function effectTransitionTimes(
  effects: readonly EffectRecord[],
): number[] {
  const times = new Set<number>();
  for (const e of effects) {
    const cancelled = parseMs(e.cancelledAt);
    const start = parseMs(e.startsAt);
    if (
      !e.startAnnounced &&
      start !== null &&
      !(cancelled !== null && cancelled < start)
    ) {
      times.add(start);
    }
    const end = parseMs(e.endsAt);
    if (
      !e.endAnnounced &&
      end !== null &&
      parseMs(e.consumedAt) === null &&
      !(cancelled !== null && cancelled < end)
    ) {
      times.add(end);
    }
  }
  return [...times].sort((a, b) => a - b);
}

/** Clamp a jitter draw into `[0, NUDGE_JITTER_MS]`. */
function clampJitter(jitterMs: number): number {
  if (!Number.isFinite(jitterMs) || jitterMs < 0) {
    return 0;
  }
  return Math.min(jitterMs, NUDGE_JITTER_MS);
}

/**
 * The first known transition time strictly after `settledThroughMs` (the
 * server time through which the last Settle_Nudge already settled), or `null`.
 */
export function nextUnsettledBoundary(
  effects: readonly EffectRecord[],
  settledThroughMs: number,
): number | null {
  for (const t of effectTransitionTimes(effects)) {
    if (t > settledThroughMs) {
      return t;
    }
  }
  return null;
}

/**
 * When the next Settle_Nudge should fire, in server time: the first unsettled
 * boundary plus {@link NUDGE_DELAY_MS} plus the (clamped) jitter, so it always
 * lands 3-5 s after the boundary. `null` when nothing remains to settle.
 */
export function nextNudgeAt(
  effects: readonly EffectRecord[],
  settledThroughMs: number,
  jitterMs: number,
): number | null {
  const boundary = nextUnsettledBoundary(effects, settledThroughMs);
  if (boundary === null) {
    return null;
  }
  return boundary + NUDGE_DELAY_MS + clampJitter(jitterMs);
}

/** The part of a Settle_Nudge response the timers need. */
export interface SettleNudgeResult {
  /** `result.serverNow` from the settle route (ISO). */
  readonly serverNow: string;
}

export interface BoardTimerDeps {
  /** Timer seam (fake in tests). */
  readonly scheduler: Scheduler;
  /** Device clock (`Date.now` in the browser). */
  readonly deviceNow: () => number;
  /** The folded timed Effects (read fresh on every reschedule). */
  readonly effects: () => readonly EffectRecord[];
  /** Whether the game is currently live; no timer runs otherwise. */
  readonly isLive: () => boolean;
  /**
   * POST `/effects/settle`; resolves to the response's `serverNow`, or `null`
   * when the call failed or was rejected.
   */
  readonly settle: () => Promise<SettleNudgeResult | null>;
  /** Called whenever a Settle_Nudge response changes the offset. */
  readonly onOffsetChange: (offsetMs: number) => void;
  /** Called when the toast timer fires: re-derive the Boundary_Toasts. */
  readonly onBoundary: () => void;
  /** Random source in `[0, 1)` for the nudge jitter (default `Math.random`). */
  readonly random?: () => number;
  /** Starting offset (e.g. from an earlier controller); default 0. */
  readonly initialOffsetMs?: number;
}

/**
 * Owns the Server_Clock_Offset and the board's toast and nudge timers. Call
 * {@link start} while the game is live (it nudges at once, the "on mount"
 * nudge), {@link nudge} on reconnect, {@link reschedule} after each fold and on
 * `visibilitychange`, and {@link stop} on unmount or game end.
 */
export class BoardTimerController {
  private readonly deps: BoardTimerDeps;
  private offset: number;
  private running = false;
  private inFlight = false;
  private queued = false;
  /** Server time through which the last Settle_Nudge settled. */
  private settledThroughMs = Number.NEGATIVE_INFINITY;
  /** The jitter drawn for the boundary the nudge timer currently targets. */
  private jitter: { readonly boundaryMs: number; readonly ms: number } | null =
    null;
  private cancelToast: (() => void) | null = null;
  private cancelNudge: (() => void) | null = null;

  constructor(deps: BoardTimerDeps) {
    this.deps = deps;
    this.offset = deps.initialOffsetMs ?? 0;
  }

  /** The current Server_Clock_Offset in ms (`serverTime − deviceTime`). */
  get offsetMs(): number {
    return this.offset;
  }

  /** Corrected device time: `serverNow(deviceNow(), offset)`. */
  serverNowMs(): number {
    return serverNow(this.deps.deviceNow(), this.offset);
  }

  /** Start the timers and nudge at once (the "on mount" nudge, 20.8). */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.nudge();
    this.reschedule();
  }

  /** Stop both timers; in-flight responses are ignored. */
  stop(): void {
    this.running = false;
    this.queued = false;
    this.clearTimers();
  }

  /**
   * Call the Settle_Nudge now (mount, reconnect, or nudge timer). Never runs
   * while stopped or not live. A call made while one is in flight is coalesced
   * into a single follow-up call.
   */
  async nudge(): Promise<void> {
    if (!this.running || !this.deps.isLive()) {
      return;
    }
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    this.inFlight = true;
    this.clearNudgeTimer();
    const sentAt = this.deps.deviceNow();
    const sentServerMs = serverNow(sentAt, this.offset);
    let result: SettleNudgeResult | null;
    try {
      result = await this.deps.settle();
    } catch {
      result = null;
    }
    const receivedAt = this.deps.deviceNow();
    this.inFlight = false;
    if (!this.running) {
      return;
    }

    const serverMs =
      result === null ? Number.NaN : Date.parse(result.serverNow);
    if (result !== null && !Number.isNaN(serverMs)) {
      const offset = measureOffset(sentAt, receivedAt, result.serverNow);
      this.settledThroughMs = Math.max(this.settledThroughMs, serverMs);
      if (offset !== this.offset) {
        this.offset = offset;
        this.deps.onOffsetChange(offset);
      }
    } else {
      // A failed nudge does not retry in a loop: the boundaries it covered are
      // left to the next mutation's lazy settle or the next known boundary.
      this.settledThroughMs = Math.max(this.settledThroughMs, sentServerMs);
    }

    if (this.queued) {
      this.queued = false;
      void this.nudge();
    }
    this.reschedule();
  }

  /**
   * Re-arm both timers from the current effects and server time. Call after
   * each fold, each fire, each offset change, and on `visibilitychange`.
   */
  reschedule(): void {
    this.clearTimers();
    if (!this.running || !this.deps.isLive()) {
      return;
    }
    const effects = this.deps.effects();
    const now = this.serverNowMs();

    // Toast timer: wake at the next Boundary_Toast and re-derive (20.3a).
    const boundary = nextBoundaryAfter(effects, now);
    if (boundary !== null) {
      this.cancelToast = this.deps.scheduler(
        () => {
          this.cancelToast = null;
          this.deps.onBoundary();
          this.reschedule();
        },
        Math.max(0, boundary.atMs - now),
      );
    }

    // Nudge timer: 3 s + 0-2 s after the next unsettled boundary (20.8). Not
    // armed while a nudge is in flight; its response reschedules.
    if (this.inFlight) {
      return;
    }
    const target = nextUnsettledBoundary(effects, this.settledThroughMs);
    if (target === null) {
      this.jitter = null;
      return;
    }
    if (this.jitter === null || this.jitter.boundaryMs !== target) {
      const random = this.deps.random ?? Math.random;
      this.jitter = { boundaryMs: target, ms: random() * NUDGE_JITTER_MS };
    }
    const fireAt = target + NUDGE_DELAY_MS + clampJitter(this.jitter.ms);
    this.cancelNudge = this.deps.scheduler(
      () => {
        this.cancelNudge = null;
        void this.nudge();
      },
      Math.max(0, fireAt - now),
    );
  }

  private clearNudgeTimer(): void {
    if (this.cancelNudge !== null) {
      this.cancelNudge();
      this.cancelNudge = null;
    }
  }

  private clearTimers(): void {
    if (this.cancelToast !== null) {
      this.cancelToast();
      this.cancelToast = null;
    }
    this.clearNudgeTimer();
  }
}
