import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  SESSION_STORAGE_KEY,
  SessionStore,
  type StorageLike,
} from "./sessionStore";

/**
 * Feature: game-setup-lobby, Property 25: Durable session persistence and
 * fallback.
 *
 * For any session identifier:
 *   - `set(id)` followed by `get()` returns that identifier;
 *   - `getOrCreate` returns an already-persisted identifier without generating a
 *     new one (the injected generator is never called);
 *   - when the persisted identifier is absent or unreadable (missing, corrupt,
 *     or storage unusable), `getOrCreate` generates and best-effort-persists a
 *     new identifier without throwing, degrading to in-memory when storage is
 *     unusable.
 *
 * These are exercised against injected {@link StorageLike} fakes so every branch
 * (working storage, throwing-on-read, throwing-on-write) is deterministic and no
 * real `localStorage` is needed, following the edge-case discipline in
 * `lib/realtime/lastSeenStore`.
 *
 * **Validates: Requirements 8.6, 8.7, 8.9**
 */

/** A controllable in-memory {@link StorageLike} backed by an inspectable map. */
function workingStorage(initial?: Record<string, string>): StorageLike & {
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

/** Storage whose read throws; writes are recorded so degrade-to-fresh is visible. */
function throwsOnRead(): StorageLike & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    getItem: () => {
      throw new Error("read blocked");
    },
    setItem: (_key, value) => {
      writes.push(value);
    },
    removeItem: () => {},
  };
}

/** Storage that is entirely unusable: every method throws (private mode / disabled). */
function unusableStorage(): StorageLike {
  return {
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
}

/** Non-empty session identifiers (the store treats "" as absent). */
const sessionId = fc.string({ minLength: 1 }).filter((s) => s !== "");

describe("SessionStore — Property 25: durable session persistence and fallback", () => {
  it("set(id) then get() returns id (round-trip persistence)", () => {
    fc.assert(
      fc.property(sessionId, (id) => {
        const storage = workingStorage();
        const store = new SessionStore(storage);

        store.set(id);

        expect(store.get()).toBe(id);
        expect(storage.raw.get(SESSION_STORAGE_KEY)).toBe(id);
      }),
      { numRuns: 100 },
    );
  });

  it("getOrCreate returns an already-persisted id without generating a new one", () => {
    fc.assert(
      fc.property(sessionId, (id) => {
        const storage = workingStorage({ [SESSION_STORAGE_KEY]: id });
        const store = new SessionStore(storage);
        let generatedCount = 0;
        const generate = () => {
          generatedCount += 1;
          return "should-not-be-used";
        };

        const result = store.getOrCreate(generate);

        expect(result).toBe(id);
        expect(generatedCount).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it("survives a fresh store over the same storage (app close/reopen)", () => {
    fc.assert(
      fc.property(sessionId, (id) => {
        const storage = workingStorage();
        new SessionStore(storage).set(id);

        // Simulate relaunch: a new store instance over the same persisted storage.
        const reopened = new SessionStore(storage);
        expect(reopened.get()).toBe(id);
        expect(reopened.getOrCreate(() => "unused")).toBe(id);
      }),
      { numRuns: 100 },
    );
  });

  it("when absent, getOrCreate generates, persists, and reuses without throwing", () => {
    fc.assert(
      fc.property(sessionId, (id) => {
        const storage = workingStorage(); // empty — nothing persisted
        const store = new SessionStore(storage);

        let created: string | undefined;
        const generate = () => {
          created = id;
          return id;
        };

        const result = store.getOrCreate(generate);

        expect(result).toBe(id);
        expect(created).toBe(id);
        // Best-effort persisted, and reused on the next call without regenerating.
        expect(storage.raw.get(SESSION_STORAGE_KEY)).toBe(id);
        expect(store.getOrCreate(() => "unused")).toBe(id);
      }),
      { numRuns: 100 },
    );
  });

  it("when the persisted value is corrupt/unreadable (read throws), getOrCreate mints a fresh id without throwing", () => {
    fc.assert(
      fc.property(sessionId, (id) => {
        const storage = throwsOnRead();
        const store = new SessionStore(storage);

        // get() degrades to null on a read error.
        expect(store.get()).toBeNull();

        let result: string | undefined;
        expect(() => {
          result = store.getOrCreate(() => id);
        }).not.toThrow();

        expect(result).toBe(id);
        // Write path is reachable and best-effort-persisted.
        expect(storage.writes).toContain(id);
      }),
      { numRuns: 100 },
    );
  });

  it("when storage is unusable (all methods throw), getOrCreate degrades to in-memory without throwing", () => {
    fc.assert(
      fc.property(sessionId, (id) => {
        const store = new SessionStore(unusableStorage());

        expect(store.get()).toBeNull();

        let result: string | undefined;
        expect(() => {
          result = store.getOrCreate(() => id);
          store.set(id);
        }).not.toThrow();

        expect(result).toBe(id);
      }),
      { numRuns: 100 },
    );
  });
});
