/**
 * Persistent `Last_Seen_Sequence` store for the realtime client (Task 13.3;
 * design.md Component 5; Req 6.6, 6.7).
 *
 * `lib/realtime/index.ts` (Task 13.2) tracks each game's `Last_Seen_Sequence`
 * in memory via the {@link LastSeenStore} seam, defaulting to
 * {@link InMemoryLastSeenStore}. That watermark is lost when the app is closed,
 * so on relaunch the client would re-fold the whole log or miss the catch-up
 * that Req 6.7 requires. This module plugs a **local-storage-backed** store into
 * that same seam so the watermark survives app open/close: the persisted value
 * seeds `Last_Seen_Sequence` on the next launch, and the resume/catch-up path
 * (Task 14) fetches exactly the events with `seq > Last_Seen_Sequence`.
 *
 * The store is deliberately defensive about its environment:
 *
 *   - **No/unavailable storage.** `localStorage` is absent during SSR and can
 *     throw in private-mode or storage-disabled browsers. The store accepts an
 *     injectable {@link StorageLike}; when none is given it uses
 *     `globalThis.localStorage` **only if it is present and actually usable**,
 *     otherwise it falls back to an in-memory map. Either way the store keeps
 *     working — persistence just degrades to process-lifetime.
 *   - **Corrupt/foreign values.** A stored value may be missing, non-numeric, or
 *     tampered with. {@link LocalStorageLastSeenStore.get} parses safely and
 *     treats anything that is not a non-negative integer as
 *     {@link NO_EVENTS_SEQ} (nothing applied).
 *   - **Monotonicity.** {@link LocalStorageLastSeenStore.set} only ever advances
 *     the watermark: a `seq` lower than (or equal to) the currently stored value
 *     is ignored, matching the "highest contiguously-applied seq" meaning of
 *     `Last_Seen_Sequence` (Req 6.6) and guarding against out-of-order or stale
 *     writes.
 *
 * This file does not touch `lib/realtime/index.ts`; it only implements the
 * `LastSeenStore` interface that module already exposes.
 *
 * Requirements: 6.6, 6.7.
 */

import type { LastSeenStore } from "@/lib/realtime";
import { NO_EVENTS_SEQ } from "@/lib/realtime/snapshot";

/**
 * The minimal slice of the DOM `Storage` API this store depends on.
 *
 * Kept to the three methods actually used so a test (or any host) can supply a
 * simple fake, and so the store never assumes more of the environment than it
 * needs. The browser `localStorage`/`sessionStorage` objects satisfy this.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Prefix for this store's keys, namespaced so it never collides with other data. */
const KEY_PREFIX = "bbb:lastSeenSeq:";

/**
 * The `localStorage` key for a game's `Last_Seen_Sequence`, namespaced under
 * {@link KEY_PREFIX} so BBB's watermark keys never collide with other keys the
 * host page may store.
 */
export function lastSeenStorageKey(gameId: string): string {
  return `${KEY_PREFIX}${gameId}`;
}

/**
 * Parse a stored watermark string into a usable `seq`.
 *
 * Any value that is not a finite, non-negative integer — `null`/missing, empty,
 * `NaN`, a float, a negative, or non-numeric junk — is treated as
 * {@link NO_EVENTS_SEQ} so a corrupt or foreign entry can never rewind or
 * poison the client.
 */
function parseStoredSeq(raw: string | null): number {
  if (raw === null || raw.trim() === "") {
    return NO_EVENTS_SEQ;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < NO_EVENTS_SEQ) {
    return NO_EVENTS_SEQ;
  }
  return parsed;
}

/**
 * Decide the backing storage for a {@link LocalStorageLastSeenStore}.
 *
 * If the caller injected a {@link StorageLike}, that is used verbatim.
 * Otherwise we probe `globalThis.localStorage`: it must exist **and** survive a
 * round-trip write/remove (private mode can expose the object but throw on
 * write). If the probe fails for any reason we fall back to an in-memory map so
 * the store still functions, just without cross-session persistence.
 */
function resolveStorage(injected?: StorageLike): StorageLike {
  if (injected !== undefined) {
    return injected;
  }

  const candidate = (globalThis as { localStorage?: StorageLike }).localStorage;

  if (candidate !== undefined && candidate !== null) {
    try {
      const probeKey = `${KEY_PREFIX}__probe__`;
      candidate.setItem(probeKey, "1");
      candidate.removeItem(probeKey);
      return candidate;
    } catch {
      // Present but unusable (private mode / storage disabled): fall through.
    }
  }

  return createInMemoryStorage();
}

/** A tiny in-memory {@link StorageLike} used as the SSR / unavailable fallback. */
function createInMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/**
 * A {@link LastSeenStore} that persists each game's `Last_Seen_Sequence` to
 * `localStorage` (or an injected {@link StorageLike}) so it survives app
 * open/close (Req 6.6, 6.7).
 *
 * Drop-in for the default {@link InMemoryLastSeenStore}: pass an instance as
 * `subscribe`'s `lastSeenStore` option and the watermark persists across
 * sessions without any change to the ordering core.
 *
 * @example
 * ```ts
 * const store = new LocalStorageLastSeenStore();
 * const sub = await subscribe(gameId, { transport, snapshotSource, lastSeenStore: store });
 * ```
 */
export class LocalStorageLastSeenStore implements LastSeenStore {
  private readonly storage: StorageLike;

  /**
   * @param storage optional backing storage. Defaults to a usable
   *   `globalThis.localStorage`, or an in-memory fallback when localStorage is
   *   absent (SSR) or unusable (private mode / disabled).
   */
  constructor(storage?: StorageLike) {
    this.storage = resolveStorage(storage);
  }

  /**
   * The persisted `Last_Seen_Sequence` for `gameId`, or {@link NO_EVENTS_SEQ}
   * when nothing valid is stored. Never throws; a read error or corrupt value
   * yields {@link NO_EVENTS_SEQ}.
   */
  get(gameId: string): number {
    try {
      return parseStoredSeq(this.storage.getItem(lastSeenStorageKey(gameId)));
    } catch {
      return NO_EVENTS_SEQ;
    }
  }

  /**
   * Persist `seq` as the `Last_Seen_Sequence` for `gameId`, but only if it
   * advances the watermark (monotonic, Req 6.6): a non-integer, negative, or
   * not-greater-than-current `seq` is ignored. Never throws; a write error is
   * swallowed so persistence failures never break event application.
   */
  set(gameId: string, seq: number): void {
    if (!Number.isInteger(seq) || seq < NO_EVENTS_SEQ) {
      return;
    }
    if (seq <= this.get(gameId)) {
      return;
    }
    try {
      this.storage.setItem(lastSeenStorageKey(gameId), String(seq));
    } catch {
      // Persistence is best-effort; a write failure must not break applying events.
    }
  }
}
