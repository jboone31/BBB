/**
 * Transient in-app reconnect for the realtime subscription client — recovery
 * **path (a)** of design.md Component 5 (Req 6.5).
 *
 * This is the recovery path that applies when the connection drops **while the
 * app is actively open** (as opposed to path (b), resume-from-background /
 * relaunch, which is Task 14.2 and lives elsewhere). On such a transient loss the
 * client does not immediately give up or force a reload: it retries the
 * connection on a bounded schedule, and only surfaces a terminal
 * "reload required" state once that schedule is exhausted.
 *
 * The policy, straight from the design:
 *
 *   - retry at intervals **≤ 5s** ({@link MAX_RECONNECT_DELAY_MS});
 *   - at most **12 attempts** ({@link MAX_RECONNECT_ATTEMPTS});
 *   - each attempt **fetches events after `Last_Seen_Sequence`**, **resubscribes**
 *     to the per-game channel, and **re-requests a snapshot** (Req 6.4/6.5);
 *   - only **after exhausting all 12 attempts** does the client enter a terminal
 *     {@link ReconnectPhase.ReloadRequired} state, rather than silently
 *     diverging.
 *
 * Design for testability. The correctness-critical, pure part — *how long to wait
 * before attempt `i`, and when to stop* — is the standalone {@link reconnectDelay}
 * schedule, which Property 11 (Task 14.3) exercises directly: for any attempt
 * index `i` the delay is ≤ 5000ms, and no attempt is scheduled once `i > 12`.
 * The stateful {@link ReconnectController} wraps that schedule and drives the
 * fetch/resubscribe/snapshot work, but keeps the **transport** and the **timer**
 * injectable so it runs deterministically in tests with a fake scheduler and an
 * in-memory transport — no real timers and no live connection required.
 *
 * **Scope.** This module implements path (a) only. It deliberately does *not*
 * touch `lib/realtime/index.ts` (`subscribe`/`onEvent`, Task 13.2) and does *not*
 * implement `onResume()` / resume-relaunch catch-up (path (b), Task 14.2). It
 * reuses the ordering/watermark contracts (`LastSeenStore`) and the snapshot
 * loader via injectable dependencies so it composes with the existing client
 * without importing its wiring.
 *
 * Requirements: 6.5.
 */

import type { GameEvent } from "@/lib/events";
import {
  loadSnapshot,
  NO_EVENTS_SEQ,
  type GameStateSnapshot,
  type SnapshotSource,
} from "@/lib/realtime/snapshot";
import type {
  LastSeenStore,
  RealtimeChannel,
  RealtimeTransport,
} from "@/lib/realtime";

/* -------------------------------------------------------------------------- *
 * Reconnect schedule (pure — Property 11 target)
 * -------------------------------------------------------------------------- */

/**
 * The maximum number of reconnect attempts on the transient in-app loss path
 * (design.md path (a); Req 6.5). After this many failed attempts the client
 * stops retrying and enters the terminal {@link ReconnectPhase.ReloadRequired}
 * state.
 */
export const MAX_RECONNECT_ATTEMPTS = 12;

/**
 * The upper bound (inclusive) on the delay before any single reconnect attempt,
 * in milliseconds — "intervals ≤ 5s" from design.md path (a) (Req 6.5). Every
 * value {@link reconnectDelay} returns for a valid attempt index is at most this.
 */
export const MAX_RECONNECT_DELAY_MS = 5000;

/**
 * A sentinel {@link reconnectDelay} returns to mean "do not schedule another
 * attempt": the retry budget of {@link MAX_RECONNECT_ATTEMPTS} is exhausted.
 * Distinguished from a real (non-negative) delay by being negative.
 */
export const NO_RECONNECT = -1;

/**
 * The delay, in milliseconds, to wait before reconnect attempt number
 * `attemptIndex` — the pure heart of recovery path (a) and the target of
 * Property 11 (design.md; Req 6.5).
 *
 * Attempts are **1-indexed**: `attemptIndex === 1` is the first retry after the
 * connection drops, `attemptIndex === 12` is the last permitted retry. The
 * schedule guarantees, for every input:
 *
 *   - **bounded delay** — the returned delay is `0 <= delay <= `
 *     {@link MAX_RECONNECT_DELAY_MS} (never exceeds 5000ms), for every valid
 *     attempt index;
 *   - **bounded count** — once `attemptIndex > `{@link MAX_RECONNECT_ATTEMPTS}
 *     (12), it returns {@link NO_RECONNECT} to signal that no further attempt is
 *     scheduled; the controller then goes terminal.
 *
 * The concrete curve is a capped exponential backoff (roughly
 * `500ms * 2^(i-1)`), clamped to {@link MAX_RECONNECT_DELAY_MS}. The backoff
 * shape is an implementation detail; the *bounds* above are the contract
 * Property 11 checks. Because the delay is clamped, later attempts simply sit at
 * the 5000ms ceiling rather than growing unbounded.
 *
 * @param attemptIndex the 1-indexed attempt number (may be any integer; values
 *   `< 1` or `> `{@link MAX_RECONNECT_ATTEMPTS} yield {@link NO_RECONNECT}).
 * @returns the delay in ms before that attempt (`0..`
 *   {@link MAX_RECONNECT_DELAY_MS}), or {@link NO_RECONNECT} if no attempt should
 *   be scheduled.
 */
export function reconnectDelay(attemptIndex: number): number {
  if (!Number.isInteger(attemptIndex) || attemptIndex < 1) {
    return NO_RECONNECT;
  }
  if (attemptIndex > MAX_RECONNECT_ATTEMPTS) {
    return NO_RECONNECT;
  }

  // Capped exponential backoff: 500, 1000, 2000, 4000, then clamped at 5000.
  const base = 500 * 2 ** (attemptIndex - 1);
  return Math.min(base, MAX_RECONNECT_DELAY_MS);
}

/* -------------------------------------------------------------------------- *
 * Injectable timer seam
 * -------------------------------------------------------------------------- */

/**
 * A cancellation handle for a scheduled reconnect attempt: calling it prevents a
 * still-pending attempt from firing (e.g. because the caller stopped the
 * controller or the connection recovered another way).
 */
export type CancelScheduled = () => void;

/**
 * A minimal `setTimeout`-like scheduler, injected so the controller is
 * deterministic and testable without real timers.
 *
 * The production wiring passes an adapter over the global `setTimeout` /
 * `clearTimeout`; tests pass a fake that records the requested `delayMs` and
 * fires callbacks on demand, so the schedule can be verified without waiting.
 *
 * @param callback the function to invoke once `delayMs` has elapsed.
 * @param delayMs how long to wait before invoking `callback`.
 * @returns a {@link CancelScheduled} that cancels the pending callback.
 */
export type Scheduler = (
  callback: () => void,
  delayMs: number,
) => CancelScheduled;

/**
 * The default {@link Scheduler} over the ambient `setTimeout`/`clearTimeout`.
 * Used when a caller does not inject one; tests should inject a fake instead.
 */
export const defaultScheduler: Scheduler = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

/* -------------------------------------------------------------------------- *
 * Reconnect controller
 * -------------------------------------------------------------------------- */

/**
 * The lifecycle phases of the transient reconnect controller (design.md path
 * (a); Req 6.5).
 */
export enum ReconnectPhase {
  /** Connected and healthy; no reconnect in progress. */
  Connected = "connected",
  /**
   * The connection dropped and the controller is retrying on the
   * {@link reconnectDelay} schedule (at most {@link MAX_RECONNECT_ATTEMPTS}
   * attempts).
   */
  Reconnecting = "reconnecting",
  /**
   * All {@link MAX_RECONNECT_ATTEMPTS} attempts have failed. This is the
   * terminal state the design calls "connection lost — reload": the client
   * surfaces it to the user rather than silently diverging. Path (b)
   * (resume/relaunch) can still recover from a backgrounded app, but path (a)
   * does not retry further from here.
   */
  ReloadRequired = "reload-required",
  /** The controller was stopped by the caller; no further attempts occur. */
  Stopped = "stopped",
}

/**
 * A single reconnect attempt's unit of work: fetch the events missed since
 * `lastSeenSequence`, resubscribe to the per-game channel, and re-request a
 * snapshot (design.md path (a); Req 6.4/6.5).
 *
 * This is injectable so the controller can be exercised without a live
 * connection: a caller wires a real implementation over {@link subscribe} /
 * {@link loadSnapshot} / a Supabase channel, while tests provide a fake that
 * resolves or rejects on demand to drive the schedule deterministically.
 */
export interface ReconnectAttempt {
  /**
   * Perform one reconnect. Implementations MUST, in effect:
   *   1. fetch every `Game_Event` with `seq > lastSeenSequence` and apply it in
   *      order (catch-up for what was missed while disconnected);
   *   2. resubscribe to the game's `Real_Time_Channel`;
   *   3. re-request a snapshot (Req 6.4).
   *
   * @param lastSeenSequence the highest contiguously-applied `seq` before the
   *   drop; the fetch resumes strictly after it.
   * @returns the reopened channel and the reloaded snapshot on success.
   * @throws if the connection still cannot be re-established (the controller
   *   then schedules the next attempt, or goes terminal if exhausted).
   */
  reconnect(lastSeenSequence: number): Promise<ReconnectOutcome>;
}

/** What a successful {@link ReconnectAttempt.reconnect} yields. */
export interface ReconnectOutcome {
  /** The reopened per-game channel; the controller owns closing it. */
  readonly channel: RealtimeChannel;
  /** The snapshot reloaded on reconnect (Req 6.4). */
  readonly snapshot: GameStateSnapshot;
}

/**
 * The dependencies a {@link ReconnectController} needs. Every external effect —
 * timing, the reconnect work, and the watermark read — is injected so the
 * controller is deterministic and testable with no real timers or live
 * connection.
 */
export interface ReconnectControllerOptions {
  /** The game whose connection is being recovered. */
  readonly gameId: string;
  /** How to perform one reconnect attempt (fetch + resubscribe + snapshot). */
  readonly attempt: ReconnectAttempt;
  /**
   * Where to read the current `Last_Seen_Sequence` from (Req 6.6). Each attempt
   * reads it fresh so a late-applied event before the drop is not re-fetched.
   */
  readonly lastSeenStore: LastSeenStore;
  /** Timer seam; defaults to {@link defaultScheduler}. */
  readonly scheduler?: Scheduler;
  /** Notified whenever {@link ReconnectController.phase} changes. */
  readonly onPhaseChange?: (phase: ReconnectPhase) => void;
  /** Notified after a successful reconnect, with the reloaded snapshot. */
  readonly onReconnected?: (outcome: ReconnectOutcome) => void;
}

/**
 * Drives transient in-app reconnection (recovery path (a); Req 6.5).
 *
 * Lifecycle:
 *   - starts {@link ReconnectPhase.Connected};
 *   - on {@link connectionLost} it enters {@link ReconnectPhase.Reconnecting}
 *     and schedules attempt 1 after `reconnectDelay(1)`;
 *   - each attempt reads the current `Last_Seen_Sequence` and calls
 *     {@link ReconnectAttempt.reconnect}. On success it returns to
 *     {@link ReconnectPhase.Connected} and notifies `onReconnected`; on failure
 *     it schedules the next attempt after `reconnectDelay(nextIndex)`;
 *   - once {@link MAX_RECONNECT_ATTEMPTS} attempts have failed (i.e.
 *     `reconnectDelay` returns {@link NO_RECONNECT}), it enters the terminal
 *     {@link ReconnectPhase.ReloadRequired} state and stops.
 *
 * The controller is not a timer itself: it asks the injected {@link Scheduler}
 * to call it back after each computed delay, so a test scheduler makes the whole
 * sequence synchronous and deterministic.
 */
export class ReconnectController {
  private readonly gameId: string;
  private readonly attempt: ReconnectAttempt;
  private readonly lastSeenStore: LastSeenStore;
  private readonly scheduler: Scheduler;
  private readonly onPhaseChange?: (phase: ReconnectPhase) => void;
  private readonly onReconnected?: (outcome: ReconnectOutcome) => void;

  private currentPhase: ReconnectPhase = ReconnectPhase.Connected;
  /** The number of attempts already made in the current disconnected run. */
  private attemptsMade = 0;
  /** Cancels a pending scheduled attempt, if any. */
  private cancelPending: CancelScheduled | undefined;

  constructor(options: ReconnectControllerOptions) {
    this.gameId = options.gameId;
    this.attempt = options.attempt;
    this.lastSeenStore = options.lastSeenStore;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onPhaseChange = options.onPhaseChange;
    this.onReconnected = options.onReconnected;
  }

  /** The controller's current lifecycle phase. */
  get phase(): ReconnectPhase {
    return this.currentPhase;
  }

  /** How many attempts have been made in the current disconnected run. */
  get attemptCount(): number {
    return this.attemptsMade;
  }

  /**
   * Signal that the connection was lost while the app is open (design.md path
   * (a); Req 6.5). Begins retrying on the {@link reconnectDelay} schedule.
   *
   * No-op unless the controller is {@link ReconnectPhase.Connected}: a loss
   * reported while already reconnecting, terminal, or stopped does not restart
   * or reset the retry budget.
   */
  connectionLost(): void {
    if (this.currentPhase !== ReconnectPhase.Connected) {
      return;
    }
    this.attemptsMade = 0;
    this.setPhase(ReconnectPhase.Reconnecting);
    this.scheduleNext();
  }

  /**
   * Stop the controller and cancel any pending attempt. Idempotent. After this
   * the controller performs no further reconnects (it does not go terminal —
   * stopping is a deliberate teardown, e.g. the subscription was closed).
   */
  stop(): void {
    if (this.currentPhase === ReconnectPhase.Stopped) {
      return;
    }
    this.clearPending();
    this.setPhase(ReconnectPhase.Stopped);
  }

  /**
   * Schedule the next reconnect attempt using {@link reconnectDelay}. If the
   * retry budget is exhausted (delay is {@link NO_RECONNECT}), go terminal.
   */
  private scheduleNext(): void {
    const nextIndex = this.attemptsMade + 1;
    const delay = reconnectDelay(nextIndex);

    if (delay === NO_RECONNECT) {
      // All MAX_RECONNECT_ATTEMPTS have failed: terminal "reload required".
      this.clearPending();
      this.setPhase(ReconnectPhase.ReloadRequired);
      return;
    }

    this.clearPending();
    this.cancelPending = this.scheduler(() => {
      this.cancelPending = undefined;
      void this.runAttempt(nextIndex);
    }, delay);
  }

  /**
   * Run one reconnect attempt: read the current watermark, perform the
   * fetch/resubscribe/snapshot work, and either return to
   * {@link ReconnectPhase.Connected} on success or schedule the next attempt on
   * failure. Guards against firing after the controller was stopped or already
   * recovered.
   */
  private async runAttempt(attemptIndex: number): Promise<void> {
    if (this.currentPhase !== ReconnectPhase.Reconnecting) {
      return;
    }
    this.attemptsMade = attemptIndex;

    const lastSeen = this.lastSeenStore.get(this.gameId) ?? NO_EVENTS_SEQ;

    try {
      const outcome = await this.attempt.reconnect(lastSeen);
      // A stop() (or another terminal transition) may have raced the await.
      if (this.currentPhase !== ReconnectPhase.Reconnecting) {
        void closeChannelQuietly(outcome.channel);
        return;
      }
      this.setPhase(ReconnectPhase.Connected);
      this.onReconnected?.(outcome);
    } catch {
      // Attempt failed: schedule the next one (or go terminal if exhausted).
      if (this.currentPhase === ReconnectPhase.Reconnecting) {
        this.scheduleNext();
      }
    }
  }

  private clearPending(): void {
    if (this.cancelPending) {
      this.cancelPending();
      this.cancelPending = undefined;
    }
  }

  private setPhase(phase: ReconnectPhase): void {
    if (this.currentPhase === phase) {
      return;
    }
    this.currentPhase = phase;
    this.onPhaseChange?.(phase);
  }
}

/** Close a channel, swallowing any error (used on a raced/late reconnect). */
function closeChannelQuietly(channel: RealtimeChannel): Promise<void> {
  return Promise.resolve(channel.unsubscribe()).catch(() => undefined);
}

/* -------------------------------------------------------------------------- *
 * Default reconnect-attempt wiring (fetch after Last_Seen_Sequence + snapshot)
 * -------------------------------------------------------------------------- */

/**
 * Dependencies for {@link makeReconnectAttempt}, the default
 * {@link ReconnectAttempt} that performs the design's path-(a) unit of work:
 * fetch events after `Last_Seen_Sequence`, resubscribe, and re-request a
 * snapshot. All are injectable so this composes without a live connection.
 */
export interface ReconnectAttemptDeps {
  /** The game being recovered. */
  readonly gameId: string;
  /** Opens a fresh per-game channel (resubscribe step). */
  readonly transport: RealtimeTransport;
  /** Loads the snapshot / fetches events (snapshot + catch-up steps). */
  readonly snapshotSource: SnapshotSource;
  /**
   * Applies each event missed since `Last_Seen_Sequence`, in ascending `seq`
   * order. Wired to the subscription's ordered-apply entry point.
   */
  readonly onEvent: (event: GameEvent) => void;
}

/**
 * Build the default {@link ReconnectAttempt} for recovery path (a): on each
 * attempt, fetch every event with `seq > lastSeenSequence` (applying them in
 * order via `onEvent`), resubscribe to the per-game channel, and re-request a
 * snapshot (design.md path (a); Req 6.4/6.5).
 *
 * The fetch reuses the same {@link SnapshotSource} the snapshot loader uses:
 * `fetchEventsAscending` returns the game's events in `seq` order, and this
 * filters to `seq > lastSeenSequence` so only the missed tail is re-applied
 * (duplicates are harmless, but this avoids re-delivering the already-applied
 * prefix). The snapshot is then reloaded via {@link loadSnapshot} (Req 6.4).
 *
 * Kept as a thin factory (rather than folded into the controller) so the
 * controller's scheduling logic stays free of transport/snapshot concerns and is
 * testable with a trivial fake {@link ReconnectAttempt}.
 *
 * @param deps the transport, snapshot source, game id, and event sink.
 * @returns a {@link ReconnectAttempt} the {@link ReconnectController} can drive.
 */
export function makeReconnectAttempt(
  deps: ReconnectAttemptDeps,
): ReconnectAttempt {
  const { gameId, transport, snapshotSource, onEvent } = deps;
  return {
    async reconnect(lastSeenSequence: number): Promise<ReconnectOutcome> {
      // 1. Catch up on events missed while disconnected: seq > Last_Seen_Sequence.
      const events = await snapshotSource.fetchEventsAscending(gameId);
      for (const event of events) {
        if (event.seq > lastSeenSequence) {
          onEvent(event);
        }
      }

      // 2. Resubscribe to the per-game channel (funneling rows into onEvent).
      const channel = await transport.channel(gameId, onEvent);

      // 3. Re-request a current snapshot (Req 6.4).
      const snapshot = await loadSnapshot(gameId, snapshotSource);

      return { channel, snapshot };
    },
  };
}
