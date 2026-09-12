import { describe, expect, it } from "vitest";

import {
  newSessionId,
  SESSION_STORAGE_KEY,
  SessionStore,
  type StorageLike,
} from "./sessionStore";

/**
 * Unit tests for {@link SessionStore}'s absent/corrupt/unusable storage fallback
 * behavior (Task 10.3; Req 8.9). They drive injected {@link StorageLike} fakes
 * so every degrade path — absent value, empty/corrupt value, storage that throws
 * on read, storage that throws on write, and SSR (no `localStorage`) — is
 * exercised deterministically without touching a real browser storage, mirroring
 * the discipline in `lib/realtime/lastSeenStore.test.ts`.
 *
 * Requirements: 8.9.
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

describe("SessionStore — storage fallback behavior", () => {
  it("get() returns null when nothing is persisted (absent value)", () => {
    const store = new SessionStore(fakeStorage());
    expect(store.get()).toBeNull();
  });

  it("get() treats a stored empty string as absent", () => {
    const store = new SessionStore(fakeStorage({ [SESSION_STORAGE_KEY]: "" }));
    expect(store.get()).toBeNull();
  });

  it("getOrCreate() generates and persists a fresh id when absent", () => {
    const storage = fakeStorage();
    const store = new SessionStore(storage);

    const created = store.getOrCreate(() => "fresh-id");

    expect(created).toBe("fresh-id");
    expect(storage.raw.get(SESSION_STORAGE_KEY)).toBe("fresh-id");
    // Reused on the next call rather than regenerated.
    expect(store.getOrCreate(() => "other")).toBe("fresh-id");
  });

  it("get() degrades to null when storage throws on read (corrupt/unreadable)", () => {
    const throwingRead: StorageLike = {
      getItem: () => {
        throw new Error("read blocked");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    const store = new SessionStore(throwingRead);

    expect(() => store.get()).not.toThrow();
    expect(store.get()).toBeNull();
  });

  it("getOrCreate() mints a fresh id when read throws, without throwing", () => {
    const writes: string[] = [];
    const throwingRead: StorageLike = {
      getItem: () => {
        throw new Error("read blocked");
      },
      setItem: (_key, value) => {
        writes.push(value);
      },
      removeItem: () => {},
    };
    const store = new SessionStore(throwingRead);

    let result: string | undefined;
    expect(() => {
      result = store.getOrCreate(() => "minted");
    }).not.toThrow();

    expect(result).toBe("minted");
    expect(writes).toContain("minted");
  });

  it("set() swallows write errors (best-effort persistence)", () => {
    const throwingWrite: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("write blocked");
      },
      removeItem: () => {},
    };
    const store = new SessionStore(throwingWrite);

    expect(() => store.set("id")).not.toThrow();
  });

  it("getOrCreate() returns a fresh id even when the write fails", () => {
    const throwingWrite: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("write blocked");
      },
      removeItem: () => {},
    };
    const store = new SessionStore(throwingWrite);

    let result: string | undefined;
    expect(() => {
      result = store.getOrCreate(() => "id-despite-write-failure");
    }).not.toThrow();

    expect(result).toBe("id-despite-write-failure");
  });

  it("degrades to a fully in-memory store when storage is entirely unusable", () => {
    const unusable: StorageLike = {
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
    const store = new SessionStore(unusable);

    expect(store.get()).toBeNull();
    expect(() => store.set("x")).not.toThrow();
    // Read still cannot see the write (storage is unusable), so a fresh id is minted.
    expect(store.getOrCreate(() => "in-memory-id")).toBe("in-memory-id");
  });

  it("uses an in-memory fallback when no storage is injected and localStorage is absent (SSR)", () => {
    const hadLocalStorage = "localStorage" in globalThis;
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    // Ensure localStorage is absent (Node/SSR-like environment).
    delete (globalThis as { localStorage?: unknown }).localStorage;

    try {
      const store = new SessionStore();
      const id = store.getOrCreate(() => "ssr-id");

      expect(id).toBe("ssr-id");
      // Works within the process even without localStorage.
      expect(store.get()).toBe("ssr-id");
    } finally {
      if (hadLocalStorage) {
        (globalThis as { localStorage?: unknown }).localStorage = original;
      }
    }
  });

  it("falls back to in-memory when localStorage is present but unusable (private mode)", () => {
    const hadLocalStorage = "localStorage" in globalThis;
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    // Present but throws on write — the constructor probe must reject it.
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceeded / disabled");
      },
      removeItem: () => {},
    } satisfies StorageLike;

    try {
      const store = new SessionStore();
      const id = store.getOrCreate(() => "private-mode-id");

      expect(id).toBe("private-mode-id");
      // In-memory fallback still round-trips within the process.
      expect(store.get()).toBe("private-mode-id");
    } finally {
      if (hadLocalStorage) {
        (globalThis as { localStorage?: unknown }).localStorage = original;
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
    }
  });
});

describe("newSessionId", () => {
  it("returns a non-empty string", () => {
    expect(newSessionId().length).toBeGreaterThan(0);
  });

  it("returns distinct identifiers across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
    expect(ids.size).toBe(50);
  });
});
