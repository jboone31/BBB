import { describe, expect, it } from "vitest";

import { NO_EVENTS_SEQ } from "@/lib/realtime/snapshot";
import {
  lastSeenStorageKey,
  LocalStorageLastSeenStore,
  type StorageLike,
} from "./lastSeenStore";

/**
 * Unit tests for the persistent `Last_Seen_Sequence` store (Task 13.3; Req 6.6,
 * 6.7). They drive a fake {@link StorageLike} so no real `localStorage` is
 * needed and every branch (persistence, corrupt values, monotonicity, and
 * unavailable/throwing storage) is exercised deterministically.
 */

/** A controllable in-memory {@link StorageLike} for the tests. */
function fakeStorage(initial?: Record<string, string>): StorageLike & {
  raw: Map<string, string>;
} {
  const raw = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    raw,
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => {
      raw.set(key, value);
    },
    removeItem: (key) => {
      raw.delete(key);
    },
  };
}

const GAME = "game-1";

describe("LocalStorageLastSeenStore", () => {
  it("persists a set watermark under a namespaced key and reads it back", () => {
    const storage = fakeStorage();
    const store = new LocalStorageLastSeenStore(storage);

    store.set(GAME, 7);

    expect(store.get(GAME)).toBe(7);
    expect(storage.raw.get(lastSeenStorageKey(GAME))).toBe("7");
    expect(lastSeenStorageKey(GAME)).toBe("bbb:lastSeenSeq:game-1");
  });

  it("survives a new store instance over the same storage (app open/close)", () => {
    const storage = fakeStorage();
    new LocalStorageLastSeenStore(storage).set(GAME, 42);

    // Simulate relaunch: a fresh store over the same persisted storage.
    const reopened = new LocalStorageLastSeenStore(storage);
    expect(reopened.get(GAME)).toBe(42);
  });

  it("returns NO_EVENTS_SEQ when nothing is stored", () => {
    const store = new LocalStorageLastSeenStore(fakeStorage());
    expect(store.get(GAME)).toBe(NO_EVENTS_SEQ);
  });

  it.each([["not-a-number"], [""], ["   "], ["3.5"], ["-1"], ["NaN"]])(
    "treats invalid stored value %j as NO_EVENTS_SEQ",
    (value) => {
      const storage = fakeStorage({ [lastSeenStorageKey(GAME)]: value });
      const store = new LocalStorageLastSeenStore(storage);
      expect(store.get(GAME)).toBe(NO_EVENTS_SEQ);
    },
  );

  it("only persists a higher seq (monotonic)", () => {
    const storage = fakeStorage();
    const store = new LocalStorageLastSeenStore(storage);

    store.set(GAME, 10);
    store.set(GAME, 5); // lower — ignored
    store.set(GAME, 10); // equal — ignored
    expect(store.get(GAME)).toBe(10);

    store.set(GAME, 11); // higher — accepted
    expect(store.get(GAME)).toBe(11);
  });

  it("ignores non-integer / negative seq writes", () => {
    const storage = fakeStorage();
    const store = new LocalStorageLastSeenStore(storage);

    store.set(GAME, 3.5);
    store.set(GAME, -2);
    store.set(GAME, Number.NaN);

    expect(store.get(GAME)).toBe(NO_EVENTS_SEQ);
    expect(storage.raw.size).toBe(0);
  });

  it("keeps watermarks isolated per game", () => {
    const store = new LocalStorageLastSeenStore(fakeStorage());
    store.set("game-a", 4);
    store.set("game-b", 9);

    expect(store.get("game-a")).toBe(4);
    expect(store.get("game-b")).toBe(9);
  });

  it("falls back gracefully when storage throws on read and write", () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const store = new LocalStorageLastSeenStore(throwing);

    // Neither call throws; get degrades to NO_EVENTS_SEQ.
    expect(() => store.set(GAME, 5)).not.toThrow();
    expect(store.get(GAME)).toBe(NO_EVENTS_SEQ);
  });

  it("uses an in-memory fallback when no storage is injected and localStorage is absent", () => {
    const hadLocalStorage = "localStorage" in globalThis;
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    // Ensure localStorage is absent (Node/SSR-like environment).
    delete (globalThis as { localStorage?: unknown }).localStorage;

    try {
      const store = new LocalStorageLastSeenStore();
      store.set(GAME, 8);
      // Works within the process even without localStorage.
      expect(store.get(GAME)).toBe(8);
    } finally {
      if (hadLocalStorage) {
        (globalThis as { localStorage?: unknown }).localStorage = original;
      }
    }
  });
});
