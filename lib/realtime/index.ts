/**
 * Realtime subscription client for the BBB web-app foundation (design.md
 * Component 5).
 *
 * When a client wants to follow a game it does two things in one flow:
 *
 *   1. **Subscribe** to the game's `Real_Time_Channel` — a per-game stream of
 *      `game_events` rows filtered by `game_id` (Supabase Postgres-changes) —
 *      so every future `Game_State_Change` is pushed to it (Req 6.1), and only
 *      for *its* game (Req 6.3 isolation).
 *   2. **Load a snapshot** of the state persisted before it subscribed, folded
 *      from the event log (Req 6.4). That work already lives in
 *      {@link ./snapshot}; this module reuses {@link loadSnapshot} rather than
 *      recomputing state.
 *
 * From then on, live events arrive via {@link RealtimeSubscription.onEvent}.
 * The transport can deliver events out of order or more than once, so `onEvent`
 * does not blindly apply what it receives. It keeps a `Last_Seen_Sequence` (the
 * highest **contiguously** applied `seq`, Req 6.6) and:
 *
 *   - **de-duplicates** events at or below `Last_Seen_Sequence` (already
 *     applied) — Req 6.9;
 *   - **applies in ascending `seq`** the moment the contiguous next `seq`
 *     arrives — Req 6.9;
 *   - **buffers/reorders** any event that arrives ahead of the next expected
 *     `seq`, then drains the buffer as the gap fills.
 *
 * The ordering rules are the tricky, correctness-critical part, so they live in
 * a **pure** core, {@link applyInOrder} / {@link OrderedApplyState}, with no
 * transport or I/O. Tasks 13.4 (snapshot fold) and 13.5 (ordered apply) drive
 * that core directly; this module wires it to a live channel.
 *
 * **Injectable transport.** This file must typecheck and be testable without the
 * concrete `@supabase/supabase-js` wiring, so it depends only on a *minimal*
 * transport contract it defines here — {@link RealtimeTransport} and
 * {@link RealtimeChannel} — plus the injectable {@link SnapshotSource} the
 * snapshot loader already uses. A caller (or Task 14 / the demo page) supplies a
 * concrete adapter that opens a Supabase channel filtered to `game_id`; tests
 * supply an in-memory fake. No live connection is required here.
 *
 * **Scope.** `Last_Seen_Sequence` is tracked **in memory** by this client. The
 * client-side persistence (local storage) that lets it survive app open/close is
 * Task 13.3 — this module exposes a small {@link LastSeenStore} seam so that
 * store can be plugged in without changing the ordering core. Reconnect/resume
 * (`onResume`, transient retry, catch-up) are Task 14 and are intentionally *not*
 * implemented here.
 *
 * Requirements: 6.1, 6.3, 6.4, 6.6, 6.9.
 */

import type { GameEvent } from "@/lib/events";
import {
  loadSnapshot,
  NO_EVENTS_SEQ,
  type GameStateSnapshot,
  type SnapshotSource,
} from "@/lib/realtime/snapshot";

import type { QueryRunner } from "@/lib/events";

/* -------------------------------------------------------------------------- *
 * Pure ordered-apply core (Req 6.6, 6.9)
 * -------------------------------------------------------------------------- */

/**
 * The ordering state a client keeps while consuming a game's live event stream
 * (design.md Component 5; Req 6.6, 6.9).
 *
 * The transport may deliver events out of order and may re-deliver them, so the
 * client cannot simply apply what arrives. It tracks:
 *
 *   - `lastSeenSequence`: the highest `seq` that has been applied **with no gap
 *     below it** — i.e. events `1..lastSeenSequence` have all been applied. This
 *     is the `Last_Seen_Sequence` of Req 6.6 and the watermark used for
 *     catch-up/resume (Task 14). It starts at {@link NO_EVENTS_SEQ} (0) when no
 *     event has been applied.
 *   - `buffer`: events that arrived **ahead** of the next expected `seq`
 *     (`seq > lastSeenSequence + 1`), held until the gap fills. Keyed by `seq`
 *     so a re-delivered future event overwrites rather than duplicates.
 *
 * The state is immutable: {@link applyInOrder} returns a new state and never
 * mutates its input, so the core is deterministic and safe to re-run.
 */
export interface OrderedApplyState {
  /** Highest contiguously-applied `seq` (Req 6.6); {@link NO_EVENTS_SEQ} if none. */
  readonly lastSeenSequence: number;
  /**
   * Events received ahead of the contiguous frontier, keyed by `seq`, awaiting
   * the events that precede them. De-duplicated by construction (one entry per
   * `seq`).
   */
  readonly buffer: ReadonlyMap<number, GameEvent>;
}

/**
 * A fresh ordering state for a game that has applied no events yet, or one
 * seeded from a snapshot's `Last_Seen_Sequence`.
 *
 * Seeding from a snapshot (Req 6.4 → 6.6) means the first live events the client
 * applies are exactly those with `seq > snapshot.lastSeenSequence`; anything at
 * or below is treated as already-applied and de-duplicated.
 *
 * @param lastSeenSequence the highest already-applied `seq`; defaults to
 *   {@link NO_EVENTS_SEQ} (nothing applied). Typically `snapshot.lastSeenSequence`.
 * @returns an ordering state with an empty buffer.
 */
export function initialOrderedApplyState(
  lastSeenSequence: number = NO_EVENTS_SEQ,
): OrderedApplyState {
  return { lastSeenSequence, buffer: new Map() };
}

/** The outcome of folding one arriving event into an {@link OrderedApplyState}. */
export interface OrderedApplyResult {
  /** The resulting ordering state (new object; the input is never mutated). */
  readonly state: OrderedApplyState;
  /**
   * The events that became applicable as a result of this arrival, in the exact
   * ascending `seq` order they were applied. Empty when the arrival was a
   * duplicate or was buffered as an out-of-order future event.
   */
  readonly applied: readonly GameEvent[];
}

/**
 * Fold one arriving event into the ordering state, applying it (and any buffered
 * successors) in ascending `seq` order (design.md Component 5; Req 6.6, 6.9).
 *
 * This is the pure heart of the realtime client and the target of Property 13
 * (Task 13.5). The rules, given the next expected `seq`
 * `expected = lastSeenSequence + 1`:
 *
 *   - **Duplicate / stale** (`event.seq <= lastSeenSequence`): already applied;
 *     ignore it (de-dup, Req 6.9). State unchanged, nothing applied.
 *   - **Next in line** (`event.seq === expected`): apply it, then drain the
 *     buffer for `expected+1, expected+2, ...` as long as they are present,
 *     advancing `lastSeenSequence` to the highest contiguous `seq` (Req 6.6).
 *     The `applied` list is that contiguous run, ascending.
 *   - **Future / out-of-order** (`event.seq > expected`): buffer it keyed by
 *     `seq` (re-delivery overwrites, so no duplicate) and apply nothing yet; it
 *     is applied later once the gap fills.
 *
 * Because application only ever advances the contiguous frontier and drains an
 * ordered buffer, the sequence of events this function reports as `applied`
 * across a stream — regardless of arrival order or duplicates — is exactly the
 * persisted order with no gaps and no duplicates (Req 6.9).
 *
 * This core does not itself run feature reducers; it decides *what* to apply and
 * *in what order*. The subscriber composes it with a per-event side effect (a
 * handler, or `applyEvent` from {@link ./snapshot}).
 *
 * @param state the current ordering state.
 * @param event the arriving event (any `seq`, possibly a duplicate or ahead).
 * @returns the new state and the events that became applicable, ascending.
 * @throws {RangeError} if `event.seq` is not a positive integer.
 */
export function applyInOrder(
  state: OrderedApplyState,
  event: GameEvent,
): OrderedApplyResult {
  if (!Number.isInteger(event.seq) || event.seq < 1) {
    throw new RangeError(
      `applyInOrder: event.seq must be a positive integer, got ${event.seq}`,
    );
  }

  // Duplicate / already-applied: de-duplicate (Req 6.9).
  if (event.seq <= state.lastSeenSequence) {
    return { state, applied: [] };
  }

  const expected = state.lastSeenSequence + 1;

  // Future / out-of-order arrival: buffer, keyed by seq so a re-delivery of the
  // same future event overwrites rather than duplicates. Nothing applied yet.
  if (event.seq > expected) {
    const buffer = new Map(state.buffer);
    buffer.set(event.seq, event);
    return {
      state: { lastSeenSequence: state.lastSeenSequence, buffer },
      applied: [],
    };
  }

  // event.seq === expected: apply it, then drain the buffer contiguously.
  const buffer = new Map(state.buffer);
  const applied: GameEvent[] = [event];
  let seq = event.seq;

  for (;;) {
    const next = buffer.get(seq + 1);
    if (next === undefined) {
      break;
    }
    buffer.delete(seq + 1);
    applied.push(next);
    seq += 1;
  }

  return {
    state: { lastSeenSequence: seq, buffer },
    applied,
  };
}

/* -------------------------------------------------------------------------- *
 * Last_Seen_Sequence store seam (Task 13.3 plugs in here)
 * -------------------------------------------------------------------------- */

/**
 * The persistence seam for `Last_Seen_Sequence` (Req 6.6).
 *
 * This module tracks the watermark **in memory** (the default
 * {@link InMemoryLastSeenStore}). Task 13.3 will provide a local-storage-backed
 * implementation so the watermark survives app open/close and enables catch-up
 * on relaunch (Req 6.7); it plugs in here without touching the ordering core.
 */
export interface LastSeenStore {
  /** The persisted `Last_Seen_Sequence` for `gameId`, or {@link NO_EVENTS_SEQ}. */
  get(gameId: string): number;
  /** Record `seq` as the `Last_Seen_Sequence` for `gameId`. */
  set(gameId: string, seq: number): void;
}

/**
 * The default in-memory {@link LastSeenStore}. Holds the watermark only for the
 * lifetime of the process; it does **not** survive app open/close (that is
 * Task 13.3's local-storage store).
 */
export class InMemoryLastSeenStore implements LastSeenStore {
  private readonly seqByGame = new Map<string, number>();

  get(gameId: string): number {
    return this.seqByGame.get(gameId) ?? NO_EVENTS_SEQ;
  }

  set(gameId: string, seq: number): void {
    this.seqByGame.set(gameId, seq);
  }
}

/* -------------------------------------------------------------------------- *
 * Injectable realtime transport (kept minimal so no live connection is needed)
 * -------------------------------------------------------------------------- */

/**
 * A subscribed per-game channel: the transport's handle for one game's live
 * event stream. Closing it stops delivery and releases the underlying
 * connection resources.
 */
export interface RealtimeChannel {
  /** Stop receiving events and release the channel. Idempotent. */
  unsubscribe(): Promise<void> | void;
}

/**
 * The minimal realtime transport this client needs (design.md Component 5).
 *
 * Modeling only "open a per-game channel that pushes new `game_events` rows"
 * keeps the client decoupled from `@supabase/supabase-js`, so it typechecks and
 * is testable with an in-memory fake and no live connection. A concrete adapter
 * (Task 14 / the demo page) implements this over a Supabase Postgres-changes
 * subscription on `game_events` **filtered to `game_id`** — the filter is what
 * gives per-game isolation (Req 6.3). If you wire a concrete adapter you may add
 * `@supabase/supabase-js` as a pinned dependency, but this interface is the
 * seam so nothing here depends on it.
 */
export interface RealtimeTransport {
  /**
   * Open a channel for `gameId` that invokes `onRow` for every newly persisted
   * `game_events` row **for that game only** (Req 6.1, 6.3). Implementations
   * MUST filter to `game_id === gameId` (e.g. the Postgres-changes `filter`
   * option) so no other game's events are delivered.
   *
   * @param gameId the game to subscribe to.
   * @param onRow invoked with each arriving event.
   * @returns the channel handle used to {@link RealtimeChannel.unsubscribe}.
   */
  channel(
    gameId: string,
    onRow: (event: GameEvent) => void,
  ): RealtimeChannel | Promise<RealtimeChannel>;
}

/* -------------------------------------------------------------------------- *
 * subscribe / onEvent
 * -------------------------------------------------------------------------- */

/**
 * Caller-supplied hooks invoked as the subscription runs.
 *
 * All are optional so a caller can observe only what it cares about. Handlers
 * run for events **in applied (ascending `seq`) order**, never for duplicates or
 * still-buffered out-of-order arrivals — so a handler sees exactly the persisted
 * order (Req 6.9).
 */
export interface SubscriptionHandlers {
  /**
   * Called once the initial snapshot has loaded (Req 6.4), before any live event
   * is applied. Seeds the caller's view of state persisted before subscription.
   */
  onSnapshot?: (snapshot: GameStateSnapshot) => void;
  /**
   * Called for each event as it is applied, in ascending `seq` order (Req 6.9).
   * Not called for de-duplicated or buffered (not-yet-applicable) arrivals.
   */
  onEvent?: (event: GameEvent) => void;
  /**
   * Called whenever `Last_Seen_Sequence` advances (Req 6.6), with the new
   * highest contiguously-applied `seq`. Useful for persistence (Task 13.3).
   */
  onLastSeenSequence?: (seq: number) => void;
}

/** Options for {@link subscribe}. */
export interface SubscribeOptions {
  /** The realtime transport that opens the per-game channel (injectable). */
  readonly transport: RealtimeTransport;
  /**
   * How to load the initial snapshot: a {@link SnapshotSource} or a
   * {@link QueryRunner} (both accepted by {@link loadSnapshot}).
   */
  readonly snapshotSource: SnapshotSource | QueryRunner;
  /** Lifecycle hooks (all optional). */
  readonly handlers?: SubscriptionHandlers;
  /**
   * Where to read/record `Last_Seen_Sequence`. Defaults to a fresh
   * {@link InMemoryLastSeenStore}; Task 13.3 supplies a persistent one.
   */
  readonly lastSeenStore?: LastSeenStore;
}

/**
 * A live per-game subscription: the object {@link subscribe} returns.
 *
 * It owns the ordering state and exposes {@link onEvent} (the entry point the
 * transport's row callback funnels into) plus a read of the current watermark
 * and a {@link close} to tear down.
 */
export interface RealtimeSubscription {
  /** The game this subscription follows. */
  readonly gameId: string;
  /** The snapshot loaded on subscribe (Req 6.4). */
  readonly snapshot: GameStateSnapshot;
  /**
   * Feed one arriving event through the ordered-apply core (Req 6.6, 6.9).
   *
   * Applies the event (and any buffered successors) in ascending `seq` order,
   * de-duplicates already-applied `seq`s, buffers out-of-order arrivals, and
   * advances `Last_Seen_Sequence`. Invokes `handlers.onEvent` for each applied
   * event and `handlers.onLastSeenSequence` when the watermark advances.
   */
  onEvent(event: GameEvent): void;
  /** The current `Last_Seen_Sequence` (highest contiguously-applied seq). */
  lastSeenSequence(): number;
  /** Unsubscribe from the channel and release resources. Idempotent. */
  close(): Promise<void>;
}

/**
 * Subscribe to a game's realtime channel and load its initial snapshot in one
 * flow (design.md Component 5; Req 6.1, 6.3, 6.4, 6.6, 6.9).
 *
 * Flow:
 *   1. Load the snapshot of state persisted before subscribing (Req 6.4) via
 *      {@link loadSnapshot}, and seed the ordering watermark from it (Req 6.6).
 *   2. Open the per-game channel through the injected transport, **filtered to
 *      `gameId`** so only this game's events arrive (Req 6.1, 6.3). Every
 *      arriving row is funneled into {@link RealtimeSubscription.onEvent}.
 *
 * The snapshot is loaded before the channel is opened so the returned
 * subscription already reflects prior state; live events then advance it in
 * order. Any events the transport happens to deliver at or below the snapshot's
 * `seq` are de-duplicated by the ordering core.
 *
 * @param gameId the game to follow.
 * @param options transport, snapshot source, handlers, and optional store.
 * @returns a {@link RealtimeSubscription} carrying the snapshot and `onEvent`.
 */
export async function subscribe(
  gameId: string,
  options: SubscribeOptions,
): Promise<RealtimeSubscription> {
  const { transport, snapshotSource, handlers } = options;
  const store = options.lastSeenStore ?? new InMemoryLastSeenStore();

  // 1. Snapshot first (Req 6.4), seed the watermark from it (Req 6.6).
  const snapshot = await loadSnapshot(gameId, snapshotSource);
  const seed = Math.max(store.get(gameId), snapshot.lastSeenSequence);
  store.set(gameId, seed);
  let state = initialOrderedApplyState(seed);
  handlers?.onSnapshot?.(snapshot);

  // The entry point the transport's row callback and external callers share.
  const onEvent = (event: GameEvent): void => {
    if (event.gameId !== gameId) {
      // Isolation guard (Req 6.3): a correctly-filtered channel never delivers
      // another game's events; drop defensively if one slips through.
      return;
    }

    const result = applyInOrder(state, event);
    state = result.state;

    for (const applied of result.applied) {
      handlers?.onEvent?.(applied);
    }

    if (result.applied.length > 0) {
      store.set(gameId, state.lastSeenSequence);
      handlers?.onLastSeenSequence?.(state.lastSeenSequence);
    }
  };

  // 2. Open the per-game channel (Req 6.1, 6.3), funneling rows into onEvent.
  const channel = await transport.channel(gameId, onEvent);

  let closed = false;
  return {
    gameId,
    snapshot,
    onEvent,
    lastSeenSequence: () => state.lastSeenSequence,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await channel.unsubscribe();
    },
  };
}
