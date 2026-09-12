/**
 * Durable client-side Session identifier store for the Lobby_Client (design.md
 * Component 4; Req 8.6, 8.7, 8.9).
 *
 * BBB uses session-based identity rather than accounts: an Admin is the session
 * that created a game, a Player is a session that joined one. The session
 * identifier is sent as `x-bbb-session-id` on every request, and when it equals
 * a game's `admin_session_id` the server re-recognizes the admin (Req 8.8) with
 * no extra client state. For that to survive the app being closed and reopened
 * on the same device+browser (Req 8.6/8.7), the identifier must live in durable
 * client storage.
 *
 * This module deliberately mirrors {@link LocalStorageLastSeenStore} almost
 * exactly — same {@link StorageLike} seam, same probe-and-fallback constructor,
 * same never-throw discipline — because it has the same defensive requirements:
 *
 *   - **No/unavailable storage.** `localStorage` is absent during SSR and can
 *     throw in private-mode or storage-disabled browsers. The store accepts an
 *     injectable {@link StorageLike}; when none is given it uses
 *     `globalThis.localStorage` **only if it is present and actually usable**,
 *     otherwise it falls back to an in-memory map. Persistence then degrades to
 *     process-lifetime (a new session per launch, Req 8.9) but the app keeps
 *     working.
 *   - **Absent/unreadable values.** A read may find nothing or throw. {@link
 *     SessionStore.get} returns `null` in both cases (Req 8.7/8.9) so the caller
 *     can establish a fresh session rather than crash.
 *   - **Best-effort writes.** {@link SessionStore.set} swallows write errors
 *     (Req 8.6): a persistence failure must never break the client.
 *
 * Requirements: 8.6, 8.7, 8.9.
 */

/**
 * The minimal slice of the DOM `Storage` API this store depends on.
 *
 * Kept to the three methods actually used so a test (or any host) can supply a
 * simple fake, and so the store never assumes more of the environment than it
 * needs. The browser `localStorage`/`sessionStorage` objects satisfy this. Same
 * shape as `lib/realtime/lastSeenStore.ts`.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The `localStorage` key for the persisted Session identifier, namespaced so it
 * never collides with other keys the host page may store.
 */
export const SESSION_STORAGE_KEY = "bbb:sessionId";

/**
 * Decide the backing storage for a {@link SessionStore}.
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
      const probeKey = `${SESSION_STORAGE_KEY}:__probe__`;
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
 * Generate a new Session identifier.
 *
 * Prefers `crypto.randomUUID()` (available in modern browsers and Node 19+),
 * falling back to a random string when `crypto` is absent or the call throws so
 * a session can always be minted. Never throws.
 */
export function newSessionId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (cryptoObj !== undefined && typeof cryptoObj.randomUUID === "function") {
    try {
      return cryptoObj.randomUUID();
    } catch {
      // Fall through to the non-crypto fallback below.
    }
  }
  // Fallback: not cryptographically strong, but sufficient to distinguish
  // sessions when a UUID source is unavailable.
  const rand = () => Math.random().toString(16).slice(2).padStart(13, "0");
  return `${Date.now().toString(16)}-${rand()}-${rand()}`;
}

/**
 * A durable store for the Lobby_Client's Session identifier, backed by
 * `localStorage` (or an injected {@link StorageLike}) so it survives the app
 * being closed and reopened on the same device+browser (Req 8.6, 8.7).
 *
 * Mirrors {@link LocalStorageLastSeenStore}: same seam, same probe-and-fallback,
 * same never-throw discipline. When storage is unusable it degrades to
 * in-memory, yielding a new session per launch (Req 8.9) without breaking the
 * client.
 *
 * @example
 * ```ts
 * const store = new SessionStore();
 * const sessionId = store.getOrCreate(); // reuse persisted, or mint + persist
 * // send sessionId as the x-bbb-session-id header on requests
 * ```
 */
export class SessionStore {
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
   * The persisted Session identifier, or `null` when absent or unreadable
   * (Req 8.7/8.9). Never throws; a read error yields `null`. A stored empty
   * string is treated as absent.
   */
  get(): string | null {
    try {
      const raw = this.storage.getItem(SESSION_STORAGE_KEY);
      if (raw === null || raw === "") {
        return null;
      }
      return raw;
    } catch {
      return null;
    }
  }

  /**
   * Persist `sessionId` as the durable Session identifier (Req 8.6). Best-effort:
   * never throws; a write error is swallowed so persistence failures never break
   * the client.
   */
  set(sessionId: string): void {
    try {
      this.storage.setItem(SESSION_STORAGE_KEY, sessionId);
    } catch {
      // Persistence is best-effort; a write failure must not break the client.
    }
  }

  /**
   * Return the persisted Session identifier, reusing it when present (Req 8.7),
   * or generating a new one via `generate` and persisting it when absent or
   * unreadable (Req 8.6, 8.9). This is the entry point the client calls on load.
   *
   * @param generate id generator; defaults to {@link newSessionId}.
   */
  getOrCreate(generate: () => string = newSessionId): string {
    const existing = this.get();
    if (existing !== null) {
      return existing;
    }
    const created = generate();
    this.set(created);
    return created;
  }
}
