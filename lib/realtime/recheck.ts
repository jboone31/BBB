/**
 * Recheck behind Realtime for live boards (design.md "Recheck behind Realtime";
 * Req 23.6, 23.7, 23.8).
 *
 * Supabase Realtime is the fast path for delivering `game_events` to connected
 * boards, but a dropped `postgres_changes` message would otherwise leave a
 * connected-and-staying-connected board silently behind. This module is the
 * safety net that closes that gap **without** a reconnect: while a game is live,
 * it fetches every event past the board's last applied `seq` whenever one
 * Recheck_Interval (15 s) passes with no new event, so a committed event reaches
 * every connected board within the Delivery_Bound — one Recheck_Interval plus
 * fetch latency and clock-offset error (Req 23.8).
 *
 * Two recovery paths already exist and are deliberately left untouched:
 *   - transient in-app reconnect ({@link ReconnectController}, `reconnect.ts`),
 *   - resume-from-background / relaunch ({@link ResumeController}, `resume.ts`).
 * Both refetch a snapshot plus the event tail and fold it on reconnect (Req
 * 23.6). The recheck is **not** a reconnect: it is a quiet-timer poll layered on
 * top of a still-connected channel. It reuses the injectable {@link Scheduler}
 * seam from `reconnect.ts` so it is driven by a fake timer in tests.
 *
 * Design for testability. The correctness-critical decision — *when* the next
 * recheck is due given the watermark, the last applied event's server time, the
 * last fire time, whether a seq gap is pending, and whether the game is live — is
 * the standalone **pure** {@link nextRecheckAt}: it takes a {@link RecheckState}
 * snapshot and returns a server-time deadline, the sentinel `"now"` (fetch
 * immediately), or `null` (do not arm). It has no timers and no I/O, so Task 9.10
 * drives it directly. The stateful {@link RecheckController} wraps that decision
 * and performs the fetch/apply/re-arm work, keeping the {@link Scheduler} and the
 * clock injectable so the whole loop runs deterministically with no real timers.
 *
 * Server time. The quiet deadline is compared in **server time**: an event's
 * `created_at` is a server timestamp, and the controller measures "now" against
 * it through the Server_Clock_Offset the caller already derived (the board reads
 * server time as `Date.now()` + offset). The controller works entirely in that
 * server-time millisecond space — `noteEvent` records each applied event's
 * `created_at` as `lastAppliedCreatedAtMs`, the injected {@link RecheckDeps.now}
 * returns server-time "now", and {@link Scheduler} delays are the difference —
 * so no raw wall-clock values leak into the scheduling decision.
 *
 * Requirements: 23.6, 23.7, 23.8.
 */

import type { GameEvent } from "@/lib/events";
import {
  defaultScheduler,
  type CancelScheduled,
  type Scheduler,
} from "@/lib/realtime/reconnect";

/**
 * One Recheck_Interval in milliseconds: the longest a live board waits without a
 * new event before fetching events it may have missed (Req 23.7; the
 * Recheck_Interval term in requirements.md). The quiet deadline is this far past
 * the later of the last applied event's server time and the last fire.
 */
export const RECHECK_INTERVAL_MS = 15_000;

/* -------------------------------------------------------------------------- *
 * Pure scheduling decision (Task 9.10 target)
 * -------------------------------------------------------------------------- */

/**
 * The scheduling inputs {@link nextRecheckAt} needs, all in **server-time
 * milliseconds** (event `created_at` compared via the Server_Clock_Offset). This
 * is a plain snapshot with no I/O so the decision is deterministic and unit
 * testable without timers.
 */
export interface RecheckState {
  /** Whether the game is live; the recheck is armed only while live (Req 23.7). */
  readonly isLive: boolean;
  /**
   * The server-time `created_at` (ms) of the most recently *contiguously*
   * applied event, or `null` if none has been applied since the controller
   * started. `noteEvent` advances this only when the watermark moves forward
   * contiguously.
   */
  readonly lastAppliedCreatedAtMs: number | null;
  /**
   * The server-time (ms) of the last recheck fetch fired, or `null` before the
   * first fire. The quiet window is also measured from here so a fire restarts
   * the wait even when no event has been applied.
   */
  readonly lastFireMs: number | null;
  /**
   * Whether a seq gap is currently pending: an event arrived ahead of the
   * contiguous frontier (`seq > lastSeq() + 1`), so a fetch is due immediately
   * rather than after the quiet window (Req 23.7).
   */
  readonly hasSeqGap: boolean;
}

/**
 * Decide when the next recheck is due — the pure heart of the recheck loop
 * (design.md "Recheck behind Realtime"; Req 23.7, 23.8).
 *
 * Returns one of:
 *   - `null` — do **not** arm a recheck. The game is not live, so the safety net
 *     is off (Req 23.7).
 *   - `"now"` — fetch **immediately**, without waiting out the quiet window. A
 *     seq gap is pending (an event arrived ahead of the frontier), so the board
 *     is known to be missing events and should not sit idle for 15 s.
 *   - a server-time deadline (ms) — the earliest server time at which a quiet
 *     recheck should fire. It is one Recheck_Interval past the **later** of the
 *     last applied event's server time (`lastAppliedCreatedAtMs + 15 s`) and the
 *     last fire (`lastFireMs + 15 s`), so neither a freshly applied event nor a
 *     recent fetch is followed by a premature poll (Req 23.7). Before any event
 *     or fire, the window runs from the time the controller is first armed, which
 *     the caller supplies as `lastFireMs` on `start`.
 *
 * The delivery bound (Req 23.8) follows from this: because `seq` and `created_at`
 * are assigned together under the game lock, every contiguously applied earlier
 * event has `created_at <= t` for an event committed at `t`, so a dropped event
 * leaves the quiet deadline no later than `t + 15 s`; and a *later* event
 * arriving first exposes a gap and returns `"now"`. Either way the fetch returns
 * every event above the watermark, folding the dropped event within one
 * Recheck_Interval plus fetch latency and clock-offset error.
 *
 * @param state the server-time scheduling snapshot.
 * @returns `null`, `"now"`, or the server-time deadline (ms) of the next recheck.
 */
export function nextRecheckAt(state: RecheckState): number | "now" | null {
  // Armed only while the game is live (Req 23.7).
  if (!state.isLive) {
    return null;
  }

  // A pending seq gap means the board is demonstrably behind: fetch at once
  // rather than waiting out the quiet window (Req 23.7).
  if (state.hasSeqGap) {
    return "now";
  }

  // Quiet deadline: one Recheck_Interval past the later of the last applied
  // event's server time and the last fire time (whichever is later).
  const candidates: number[] = [];
  if (state.lastAppliedCreatedAtMs !== null) {
    candidates.push(state.lastAppliedCreatedAtMs);
  }
  if (state.lastFireMs !== null) {
    candidates.push(state.lastFireMs);
  }

  // With neither an applied event nor a prior fire there is no basis for a quiet
  // window; the controller seeds `lastFireMs` on `start`, so in practice at least
  // one is present. Defensively treat "no basis" as "do not arm".
  if (candidates.length === 0) {
    return null;
  }

  return Math.max(...candidates) + RECHECK_INTERVAL_MS;
}

/* -------------------------------------------------------------------------- *
 * Recheck controller dependencies
 * -------------------------------------------------------------------------- */

/**
 * The dependencies a {@link RecheckController} needs. Every external effect — the
 * catch-up fetch, the ordered/deduped apply, the watermark and liveness reads,
 * the timer, and the clock — is injected so the controller runs deterministically
 * in tests with no real timers and no live connection.
 */
export interface RecheckDeps {
  /**
   * Fetch every event for `gameId` with `seq > afterSeq`, ascending. The same
   * {@link SnapshotSource.fetchEventsAfter} the board already uses (RLS-scoped in
   * the browser). A rejection re-arms the controller without applying anything.
   */
  readonly fetchEventsAfter: (
    gameId: string,
    afterSeq: number,
  ) => Promise<GameEvent[]>;
  /**
   * Apply fetched events through the board's existing seq-ordered, de-duplicating
   * fold (`RealtimeSubscription.onEvent` driving `applyInOrder`). Re-applying an
   * already-applied event is harmless.
   */
  readonly apply: (events: readonly GameEvent[]) => void;
  /** The board projection's current watermark (highest contiguously applied seq). */
  readonly lastSeq: () => number;
  /** Whether the game is live; the recheck is armed only while this is true. */
  readonly isLive: () => boolean;
  /**
   * Timer seam from `reconnect.ts`; defaults to {@link defaultScheduler}. Tests
   * inject a fake that records the requested delay and fires on demand.
   */
  readonly scheduler?: Scheduler;
  /**
   * Returns "now" in **server-time** milliseconds (`Date.now()` plus the
   * Server_Clock_Offset). Defaults to {@link Date.now}; inject a fake clock in
   * tests so the quiet window is deterministic. Kept in the same server-time
   * space as event `created_at` so deadlines compare directly.
   */
  readonly now?: () => number;
}

/* -------------------------------------------------------------------------- *
 * Recheck controller
 * -------------------------------------------------------------------------- */

/**
 * Drives the quiet-timer recheck for a live board (design.md "Recheck behind
 * Realtime"; Req 23.7, 23.8).
 *
 * Lifecycle:
 *   - {@link start} arms the timer while the game is live, seeding the quiet
 *     window from "now" so the first poll fires one Recheck_Interval later if no
 *     event arrives;
 *   - {@link noteEvent} is called for every event the board applies (via Realtime
 *     or via a recheck fetch). On contiguous watermark progress it advances the
 *     quiet deadline (restarting the 15 s wait); a seq gap arms an immediate
 *     fetch instead;
 *   - on fire it calls {@link RecheckDeps.fetchEventsAfter} with the current
 *     watermark, applies the result through the board's ordered/deduped fold,
 *     records the fire time, and re-arms. A failed fetch re-arms without applying
 *     (Req 23.7);
 *   - {@link stop} cancels any pending timer on unmount or when the game ends.
 *
 * The controller is not a timer itself: it asks the injected {@link Scheduler} to
 * call it back after each computed delay (derived from {@link nextRecheckAt} and
 * the injected clock), so a test scheduler makes the whole loop synchronous and
 * deterministic.
 */
export class RecheckController {
  private readonly gameId: string;
  private readonly fetchEventsAfter: RecheckDeps["fetchEventsAfter"];
  private readonly apply: RecheckDeps["apply"];
  private readonly lastSeqOf: RecheckDeps["lastSeq"];
  private readonly isLiveOf: RecheckDeps["isLive"];
  private readonly scheduler: Scheduler;
  private readonly now: () => number;

  /** Whether the controller has been started and not yet stopped. */
  private running = false;
  /** Server-time (ms) of the most recent contiguously applied event. */
  private lastAppliedCreatedAtMs: number | null = null;
  /** Server-time (ms) of the last fetch fire, or of {@link start} before any fire. */
  private lastFireMs: number | null = null;
  /** Whether a seq gap is pending (an event arrived ahead of the frontier). */
  private hasSeqGap = false;
  /** Cancels a pending scheduled recheck, if any. */
  private cancelPending: CancelScheduled | undefined;

  constructor(gameId: string, deps: RecheckDeps) {
    this.gameId = gameId;
    this.fetchEventsAfter = deps.fetchEventsAfter;
    this.apply = deps.apply;
    this.lastSeqOf = deps.lastSeq;
    this.isLiveOf = deps.isLive;
    this.scheduler = deps.scheduler ?? defaultScheduler;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Arm the recheck while the game is live (Req 23.7). Seeds the quiet window
   * from the current server time so, absent any event, the first poll fires one
   * Recheck_Interval later. Idempotent: starting an already-running controller
   * simply re-arms from "now". A no-op if the game is not live.
   */
  start(): void {
    if (!this.isLiveOf()) {
      return;
    }
    this.running = true;
    // Seed the window from now so the first poll is one interval out even before
    // any event has been applied.
    this.lastFireMs = this.now();
    this.hasSeqGap = false;
    this.arm();
  }

  /**
   * Note that the board applied an event (via Realtime or a recheck fetch) and
   * restart the quiet timer (Req 23.7). Call this for every applied event.
   *
   * On **contiguous** watermark progress (`appliedSeq === lastSeq()`, i.e. the
   * event advanced the frontier without a gap) it records the event's server
   * `created_at` and re-arms the quiet window. If the applied event sits ahead of
   * the frontier (`appliedSeq > lastSeq() + 1`), a seq gap is pending and the
   * controller arms an immediate fetch instead of waiting.
   *
   * @param event the event the board just applied.
   */
  noteEvent(event: GameEvent): void {
    if (!this.running) {
      return;
    }

    const frontier = this.lastSeqOf();
    if (event.seq > frontier + 1) {
      // Arrived ahead of the contiguous frontier: a gap is pending; fetch now.
      this.hasSeqGap = true;
    } else if (event.seq === frontier) {
      // Contiguous progress: advance the quiet deadline from this event's
      // server-time created_at (Req 23.7). A seq gap, if it was pending, is
      // cleared once the frontier reaches this event.
      this.lastAppliedCreatedAtMs = parseCreatedAtMs(event.createdAt);
      this.hasSeqGap = false;
    }
    // event.seq < frontier is a stale/duplicate delivery; ignore it.

    this.arm();
  }

  /**
   * Stop the controller and cancel any pending recheck. Idempotent. Call on
   * unmount or when the game ends (the game is no longer live).
   */
  stop(): void {
    this.running = false;
    this.clearPending();
  }

  /** The pure scheduling snapshot the controller currently reflects. */
  private snapshot(): RecheckState {
    return {
      isLive: this.isLiveOf(),
      lastAppliedCreatedAtMs: this.lastAppliedCreatedAtMs,
      lastFireMs: this.lastFireMs,
      hasSeqGap: this.hasSeqGap,
    };
  }

  /**
   * (Re)schedule the next recheck from the current state via {@link nextRecheckAt}.
   * `null` disarms; `"now"` fires immediately; a deadline schedules a timer for
   * the remaining server-time delay (never negative).
   */
  private arm(): void {
    this.clearPending();
    if (!this.running) {
      return;
    }

    const due = nextRecheckAt(this.snapshot());
    if (due === null) {
      // Not live (or no basis to arm): leave the controller disarmed.
      return;
    }

    if (due === "now") {
      void this.fire();
      return;
    }

    const delay = Math.max(0, due - this.now());
    this.cancelPending = this.scheduler(() => {
      this.cancelPending = undefined;
      void this.fire();
    }, delay);
  }

  /**
   * Perform one recheck: fetch events after the current watermark, apply them
   * through the board's ordered/deduped fold, record the fire time, and re-arm
   * (Req 23.7). A failed fetch re-arms without applying — the board simply tries
   * again after the next quiet window.
   */
  private async fire(): Promise<void> {
    if (!this.running) {
      return;
    }

    // Clearing the gap before fetching means an event that arrives *during* the
    // fetch can re-flag it; the fetch itself returns everything above the
    // watermark regardless.
    this.hasSeqGap = false;

    const afterSeq = this.lastSeqOf();
    try {
      const events = await this.fetchEventsAfter(this.gameId, afterSeq);
      if (!this.running) {
        return;
      }
      this.apply(events);
    } catch {
      // Failed fetch: re-arm without applying (Req 23.7).
    }

    if (!this.running) {
      return;
    }
    // Restart the quiet window from this fire, whether it succeeded or failed.
    this.lastFireMs = this.now();
    this.arm();
  }

  private clearPending(): void {
    if (this.cancelPending) {
      this.cancelPending();
      this.cancelPending = undefined;
    }
  }
}

/**
 * Parse a `game_events.created_at` ISO-8601 server timestamp into epoch
 * milliseconds for the server-time quiet-window comparison. An unparseable value
 * yields `null` so a malformed timestamp simply does not advance the deadline
 * (the controller keeps its previous basis) rather than poisoning it with `NaN`.
 */
function parseCreatedAtMs(createdAt: string): number | null {
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? null : ms;
}
