/**
 * Resume-from-background / relaunch re-initialization for the realtime
 * subscription client — recovery **path (b)** of design.md Component 5
 * (Req 6.7, 6.8).
 *
 * This is the recovery path that applies when the app **returns from the
 * background or is relaunched after being closed**, as opposed to path (a)
 * (transient in-app connection loss, `lib/realtime/reconnect.ts`), which retries
 * on a bounded budget and can end in a terminal "reload required" state.
 *
 * The two paths differ in one crucial way. Path (a) is *bounded*: after
 * `MAX_RECONNECT_ATTEMPTS` failures it gives up and surfaces a terminal state.
 * Path (b) is *unconditional*: whenever the app resumes it **always**
 * re-initializes, regardless of any prior retry budget, and it **never** lands
 * in a terminal "reload required" state — resume always recovers (Req 6.8).
 * Because `Last_Seen_Sequence` is persisted client-side (Task 13.3) and the
 * per-game sequence is gap-free (Req 4.5), a game can be closed for an
 * arbitrarily long time and still be caught up **exactly** on resume — no missed
 * and no duplicated events.
 *
 * The re-initialization performed on every resume (Req 6.7, mirroring Req 6.4):
 *
 *   1. read the persisted `Last_Seen_Sequence` `L` for the game;
 *   2. **fetch every `Game_Event` with `seq > L`** and apply it in ascending
 *      `seq` order (catch-up for everything missed while backgrounded/closed);
 *   3. **resubscribe** to the per-game `Real_Time_Channel`;
 *   4. **load a current snapshot** (Req 6.4).
 *
 * Design for testability. The re-initialization work is the standalone,
 * dependency-injected {@link resumeReinitialize} routine — a fake event source
 * plus an in-memory transport drive it with no DOM, no timers, and no live
 * connection, which is exactly what Property 12 (Task 14.4) needs to assert that
 * catch-up delivers precisely the events with `seq > L`, ascending, no gaps or
 * dupes, independent of any retry-budget state. The environment binding — which
 * browser signals count as "resumed" — is a **separate** concern: the
 * {@link ResumeController} exposes {@link ResumeController.onResume} directly
 * (callable by tests and by any host) and {@link bindResumeSignals} wires it to
 * `visibilitychange` / `focus` / `pageshow` through an **injectable** registrar,
 * so nothing here depends on a real `document`/`window`.
 *
 * **Overriding a terminal path (a).** Path (a) may already have exhausted its
 * budget and gone terminal ("reload required") before the user backgrounds and
 * returns. Resume must be able to pull that controller back out of the terminal
 * state into reconnecting/resynchronizing (Req 6.8). Rather than reach into
 * `ReconnectController`'s internals (this module deliberately does not import or
 * edit `reconnect.ts`), resume takes an optional {@link ResetTransientRecovery}
 * hook the caller wires to whatever "reset path (a) back to reconnecting" means
 * for its controller. Resume invokes it **before** re-initializing, so a
 * previously-terminal controller is reset on every resume.
 *
 * **Scope.** This module implements path (b) only. It does **not** edit
 * `lib/realtime/index.ts` (`subscribe`/`onEvent`) or `lib/realtime/reconnect.ts`
 * (path (a)); it composes with them through the injectable contracts they
 * already export ({@link LastSeenStore}, {@link RealtimeTransport},
 * {@link SnapshotSource}) so it never depends on their wiring.
 *
 * Requirements: 6.7, 6.8.
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
 * Resume re-initialization routine (dependency-injected — Property 12 target)
 * -------------------------------------------------------------------------- */

/**
 * A hook the caller wires to reset a terminal transient-recovery (path (a))
 * controller back into a reconnecting/resynchronizing state (Req 6.8).
 *
 * Path (a) can end in a terminal "reload required" state after exhausting its
 * retry budget. Resume must never be blocked by that: it calls this hook before
 * re-initializing so the controller is pulled back out of the terminal state.
 * The concrete controller decides what "reset" means (e.g. transition its phase
 * back to reconnecting); this module stays decoupled from it. Optional — omit it
 * when there is no path-(a) controller to coordinate with.
 */
export type ResetTransientRecovery = () => void;

/**
 * The dependencies {@link resumeReinitialize} needs. Every external effect — the
 * watermark read, the catch-up fetch, event application, resubscription, and the
 * optional path-(a) reset — is injected so the routine is deterministic and
 * testable with no DOM, no timers, and no live connection (Property 12).
 */
export interface ResumeDeps {
  /** The game being re-initialized. */
  readonly gameId: string;
  /**
   * Where to read the persisted `Last_Seen_Sequence` `L` from (Req 6.6, 6.7).
   * Plug in the persistent {@link LocalStorageLastSeenStore} (Task 13.3) so the
   * watermark survives app open/close; catch-up then fetches exactly `seq > L`.
   */
  readonly lastSeenStore: LastSeenStore;
  /**
   * Fetches the game's events (ascending by `seq`) for catch-up and loads the
   * snapshot. The same {@link SnapshotSource} the snapshot loader uses.
   */
  readonly snapshotSource: SnapshotSource;
  /** Opens a fresh per-game channel (the resubscribe step). */
  readonly transport: RealtimeTransport;
  /**
   * Applies each caught-up event, in ascending `seq` order. Wire this to the
   * subscription's ordered-apply entry point (`RealtimeSubscription.onEvent`);
   * it de-duplicates and orders, so re-delivering an already-applied event is
   * harmless.
   */
  readonly onEvent: (event: GameEvent) => void;
  /**
   * Optional: reset a terminal path-(a) controller back to reconnecting before
   * re-initializing (Req 6.8). See {@link ResetTransientRecovery}.
   */
  readonly resetTransientRecovery?: ResetTransientRecovery;
}

/** What a successful {@link resumeReinitialize} yields. */
export interface ResumeOutcome {
  /**
   * The reopened per-game channel; the caller owns closing the previous channel
   * and this one.
   */
  readonly channel: RealtimeChannel;
  /** The snapshot loaded on resume (Req 6.4). */
  readonly snapshot: GameStateSnapshot;
  /**
   * The events delivered to `onEvent` during catch-up (those with `seq > L`),
   * in the ascending `seq` order they were applied. This is the observable
   * record Property 12 checks against "events with `seq > L`".
   */
  readonly caughtUp: readonly GameEvent[];
}

/**
 * Re-initialize the client on resume-from-background or relaunch — the pure work
 * of recovery path (b) (design.md Component 5; Req 6.7, 6.8).
 *
 * This **always** runs to completion regardless of any prior path-(a) retry
 * budget or terminal state, and it **never** enters a terminal "reload required"
 * state — it either recovers or throws for the caller to retry on the next
 * resume signal. Steps, in order:
 *
 *   1. optionally reset a terminal path-(a) controller (Req 6.8) so it is no
 *      longer stuck at "reload required";
 *   2. read the persisted `Last_Seen_Sequence` `L` (Req 6.6, 6.7);
 *   3. fetch the game's events and apply, in ascending `seq` order, exactly
 *      those with `seq > L` via `onEvent` — the catch-up for everything missed
 *      while away (Req 6.7). Events at or below `L` are skipped here (and the
 *      ordered-apply core would de-duplicate them anyway);
 *   4. resubscribe to the per-game channel (Req 6.7);
 *   5. load a current snapshot (Req 6.4).
 *
 * The catch-up filter (`seq > L`) plus the gap-free per-game sequence (Req 4.5)
 * is what makes resume exact over any absence: every persisted event above the
 * watermark is delivered once, in order, and nothing below it is re-delivered.
 *
 * @param deps the game id, watermark store, snapshot source, transport, event
 *   sink, and optional path-(a) reset hook.
 * @returns the reopened channel, the loaded snapshot, and the caught-up events.
 */
export async function resumeReinitialize(
  deps: ResumeDeps,
): Promise<ResumeOutcome> {
  const {
    gameId,
    lastSeenStore,
    snapshotSource,
    transport,
    onEvent,
    resetTransientRecovery,
  } = deps;

  // 1. Pull any terminal path-(a) controller back to reconnecting (Req 6.8).
  //    Resume is unconditional: it must not be gated by path (a)'s budget.
  resetTransientRecovery?.();

  // 2. Read the persisted watermark L (Req 6.6, 6.7). Independent of path (a).
  const lastSeen = lastSeenStore.get(gameId) ?? NO_EVENTS_SEQ;

  // 3. Catch up: apply every event with seq > L, in ascending seq order
  //    (Req 6.7). fetchEventsAscending returns them ordered; filter the tail.
  const events = await snapshotSource.fetchEventsAscending(gameId);
  const caughtUp: GameEvent[] = [];
  for (const event of events) {
    if (event.gameId === gameId && event.seq > lastSeen) {
      onEvent(event);
      caughtUp.push(event);
    }
  }

  // 4. Resubscribe to the per-game channel (Req 6.7), funneling rows into onEvent.
  const channel = await transport.channel(gameId, onEvent);

  // 5. Load a current snapshot (Req 6.4).
  const snapshot = await loadSnapshot(gameId, snapshotSource);

  return { channel, snapshot, caughtUp };
}

/* -------------------------------------------------------------------------- *
 * Resume controller (exposes onResume; never goes terminal)
 * -------------------------------------------------------------------------- */

/** Options for a {@link ResumeController}: the resume work plus optional hooks. */
export interface ResumeControllerOptions extends ResumeDeps {
  /** Notified after a successful resume re-initialization, with its outcome. */
  readonly onResumed?: (outcome: ResumeOutcome) => void;
  /**
   * Notified if a resume re-initialization attempt throws (e.g. the network is
   * still unreachable). Resume never goes terminal: the controller simply stays
   * ready to run again on the next resume signal. Optional — omit to ignore.
   */
  readonly onResumeError?: (error: unknown) => void;
}

/**
 * Drives resume-from-background / relaunch recovery (path (b); Req 6.7, 6.8).
 *
 * Unlike the transient {@link ReconnectController} (path (a)), this controller
 * has **no retry budget and no terminal state**. Each call to
 * {@link ResumeController.onResume} runs a full re-initialization
 * ({@link resumeReinitialize}) and the controller is immediately ready to do so
 * again on the next resume signal — it can never reach a "reload required"
 * state (Req 6.8).
 *
 * {@link ResumeController.onResume} is exposed directly so Property 12 (Task
 * 14.4) and any host can invoke it without a DOM; {@link bindResumeSignals}
 * wires it to browser visibility/foreground signals separately.
 *
 * Overlapping resume signals (e.g. `focus` immediately after `visibilitychange`)
 * are coalesced: while a re-initialization is in flight, further `onResume`
 * calls await and reuse the same run rather than launching redundant catch-ups.
 */
export class ResumeController {
  private readonly options: ResumeControllerOptions;
  /** The in-flight re-initialization, if any (for coalescing overlapping signals). */
  private inFlight: Promise<ResumeOutcome | undefined> | undefined;

  constructor(options: ResumeControllerOptions) {
    this.options = options;
  }

  /**
   * Re-initialize on resume: always runs the full catch-up + resubscribe +
   * snapshot flow, regardless of any prior path-(a) budget, and never goes
   * terminal (Req 6.7, 6.8).
   *
   * If a re-initialization is already in flight (a burst of resume signals),
   * this awaits and reuses it instead of starting a second one. On success it
   * notifies `onResumed`; on failure it notifies `onResumeError` and resolves to
   * `undefined` — the controller stays ready for the next resume.
   *
   * @returns the {@link ResumeOutcome} on success, or `undefined` if the attempt
   *   failed (the controller remains usable; a later resume can succeed).
   */
  onResume(): Promise<ResumeOutcome | undefined> {
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    const run = this.runResume();
    this.inFlight = run;
    // Clear the in-flight marker once settled so the next signal starts fresh.
    void run.finally(() => {
      if (this.inFlight === run) {
        this.inFlight = undefined;
      }
    });
    return run;
  }

  private async runResume(): Promise<ResumeOutcome | undefined> {
    try {
      const outcome = await resumeReinitialize(this.options);
      this.options.onResumed?.(outcome);
      return outcome;
    } catch (error) {
      // Resume never goes terminal: report and stay ready for the next signal.
      this.options.onResumeError?.(error);
      return undefined;
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Resume-signal binding (injectable registrar; no real DOM required)
 * -------------------------------------------------------------------------- */

/**
 * A minimal `addEventListener`-like registrar for one event target, injected so
 * {@link bindResumeSignals} typechecks and is testable without a real
 * `document`/`window`.
 *
 * The browser `document` and `window` satisfy this shape. A test supplies a fake
 * that records handlers and can invoke them on demand to simulate a
 * background/foreground cycle.
 */
export interface EventTargetLike {
  addEventListener(type: string, listener: (event?: unknown) => void): void;
  removeEventListener(type: string, listener: (event?: unknown) => void): void;
}

/** Options for {@link bindResumeSignals}. */
export interface BindResumeSignalsOptions {
  /**
   * The document-like target for the `visibilitychange` signal. Defaults to the
   * ambient `document` when present (browser); omit/undefined in non-DOM hosts.
   */
  readonly documentTarget?: EventTargetLike;
  /**
   * The window-like target for `focus` / `pageshow` signals. Defaults to the
   * ambient `window` when present (browser); omit/undefined in non-DOM hosts.
   */
  readonly windowTarget?: EventTargetLike;
  /**
   * A guard for the `visibilitychange` signal: resume only fires when the page
   * has become visible. Defaults to reading the ambient
   * `document.visibilityState === "visible"`. Injectable for tests. When no
   * document visibility is available it defaults to firing (treat the signal as
   * a foreground).
   */
  readonly isVisible?: () => boolean;
}

/** Tears down a {@link bindResumeSignals} binding: removes every listener. Idempotent. */
export type UnbindResumeSignals = () => void;

/**
 * Read the ambient DOM globals without assuming they exist (SSR / tests). Kept
 * narrow so this module never declares a hard dependency on the DOM lib.
 */
function ambient(): {
  document?: EventTargetLike & { visibilityState?: string };
  window?: EventTargetLike;
} {
  const g = globalThis as {
    document?: EventTargetLike & { visibilityState?: string };
    window?: EventTargetLike;
  };
  return { document: g.document, window: g.window };
}

/**
 * Bind a controller's {@link ResumeController.onResume} to
 * resume/visibility/foreground signals (design.md Component 5; Req 6.7).
 *
 * Registers, when a target is available:
 *
 *   - `visibilitychange` on the document target — fires resume when the page
 *     becomes visible again (guarded by {@link BindResumeSignalsOptions.isVisible});
 *   - `focus` and `pageshow` on the window target — cover foreground/relaunch and
 *     bfcache restore, which do not always emit `visibilitychange`.
 *
 * The environment is injectable: pass explicit `documentTarget`/`windowTarget`
 * (a test's fakes) or rely on the ambient `document`/`window` when present. In a
 * non-DOM host with no targets, this is a no-op that returns a no-op unbinder, so
 * it typechecks and runs anywhere.
 *
 * @param controller the {@link ResumeController} whose `onResume` to trigger.
 * @param options optional injectable targets and visibility guard.
 * @returns an {@link UnbindResumeSignals} that removes every registered listener.
 */
export function bindResumeSignals(
  controller: Pick<ResumeController, "onResume">,
  options: BindResumeSignalsOptions = {},
): UnbindResumeSignals {
  const env = ambient();
  const documentTarget = options.documentTarget ?? env.document;
  const windowTarget = options.windowTarget ?? env.window;

  const isVisible =
    options.isVisible ??
    (() => {
      const doc = env.document;
      // No visibility info available: treat the signal as a foreground.
      if (doc?.visibilityState === undefined) {
        return true;
      }
      return doc.visibilityState === "visible";
    });

  const removers: Array<() => void> = [];

  const fire = (): void => {
    void controller.onResume();
  };

  if (documentTarget !== undefined) {
    const onVisibility = (): void => {
      if (isVisible()) {
        fire();
      }
    };
    documentTarget.addEventListener("visibilitychange", onVisibility);
    removers.push(() =>
      documentTarget.removeEventListener("visibilitychange", onVisibility),
    );
  }

  if (windowTarget !== undefined) {
    const onForeground = (): void => {
      fire();
    };
    for (const type of ["focus", "pageshow"] as const) {
      windowTarget.addEventListener(type, onForeground);
      removers.push(() => windowTarget.removeEventListener(type, onForeground));
    }
  }

  let unbound = false;
  return () => {
    if (unbound) {
      return;
    }
    unbound = true;
    for (const remove of removers) {
      remove();
    }
  };
}
