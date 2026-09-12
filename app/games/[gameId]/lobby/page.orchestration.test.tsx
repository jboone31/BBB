// @vitest-environment jsdom
//
// Integration tests for the Lobby page's create→bars→join orchestration
// (`handleCreate`) and the host-completion recovery handler
// (`handleHostComplete`) — Task 7.4.
//
// These exercise `app/games/[gameId]/lobby/page.tsx` (LobbyPage) end-to-end at
// the page level with the network and realtime seams faked, asserting the
// DURABLE, OBSERVABLE facts the design promises rather than internal state:
//
//   - Create→bars→join ORDERING and that the join body carries the NORMALIZED
//     Join_Code (uppercased/trimmed) + the TRIMMED Display_Name, all on the same
//     `x-bbb-session-id` header (R2.1, R2.2, R6.3).
//   - A successful host join writes `bbb:player:{gameId}` to localStorage (R2.3).
//     (myPlayerId is set in memory, but create mode navigates to
//     `/games/{newId}/lobby`; the durable localStorage write is what the
//     destination page reads on mount, so that is the fact we assert.)
//   - A join FAILURE after create issues exactly ONE `POST /api/games`, still
//     navigates to `/games/{newId}/lobby`, writes `bbb:admin:{newId}`, and leaves
//     `bbb:player:{newId}` absent (R3.1).
//   - Host-completion (R3.3): a not-yet-joined Admin (bbb:admin set, bbb:player
//     absent) with a folded `view.joinCode` completes the join by entering only a
//     name; on success `bbb:player` is written.
//
// SCOPING NOTE — DOM environment + mocked seams:
//   The project's Vitest harness defaults to the `node` environment (see
//   vitest.config.mts). This file opts into `jsdom` for THIS FILE ONLY via the
//   `@vitest-environment jsdom` docblock on line 1, mirroring the sibling
//   page.viewport.test.tsx and page.prefill.test.tsx. The global config is
//   untouched.
//
//   For the create-mode tests we take the OFFLINE realtime path
//   (`isSupabaseConfigured() === false`) so no live subscription runs — the page
//   renders the create surface and never opens a connection. For the
//   host-completion test we take the CONFIGURED path and drive `view.joinCode`
//   from a folded `game_created` event via a controllable snapshot source
//   (exactly as page.prefill.test.tsx does), because the host-completion surface
//   needs a resolved code to submit against.
//
//   `global.fetch` is spied so we can drive the sequence of route responses and
//   inspect the requests (URL, method, headers, body) the page issues.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import type { GameEvent } from "@/lib/events";
import { normalizeSubmittedCode } from "@/lib/lobby/joinCode";
import { SESSION_STORAGE_KEY } from "@/lib/session/sessionStore";

// --- next/navigation: route param + router.push capture ---------------------
//
// `useParams` drives the active game id (mutable per test: "new" for the
// create-mode tests, a real id for host-completion). `useRouter().push` is
// captured so we can assert post-create navigation. `useSearchParams` returns an
// empty set (no `?code=` prefill in these tests).

const routeParams: { gameId: string } = { gameId: "" };
const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => routeParams,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// --- realtime seams: configurable per test ---------------------------------
//
// `isSupabaseConfigured()` and the snapshot source are read through a mutable
// holder so each describe block can pick the offline (create-mode) or configured
// (host-completion) path. `createBrowserSupabaseClient` returns a stub client
// only matters when configured; `subscribe` is always inert so no live channel
// opens.

let supabaseConfigured = false;
let snapshotEvents: GameEvent[] = [];

vi.mock("@/lib/realtime/supabaseBrowser", () => ({
  isSupabaseConfigured: () => supabaseConfigured,
  createBrowserSupabaseClient: () =>
    supabaseConfigured ? ({} as unknown) : null,
  supabaseRealtimeTransport: () => ({
    channel: () => ({ unsubscribe: async () => {} }),
  }),
  supabaseSnapshotSource: () => ({
    fetchEventsAscending: async () => snapshotEvents,
  }),
}));

vi.mock("@/lib/realtime", () => ({
  subscribe: async () => ({
    snapshot: { lastSeenSequence: 0 },
    close: async () => {},
  }),
}));

import LobbyPage from "./page";

const SESSION_HEADER = "x-bbb-session-id";

/** One captured fetch call, decoded for assertions. */
interface CapturedRequest {
  url: string;
  method: string;
  sessionHeader: string | null;
  body: Record<string, unknown>;
}

let fetchSpy: MockInstance;
let captured: CapturedRequest[];

/**
 * Decode the (path, init) a page fetch was called with into a CapturedRequest.
 * The page always calls `fetch(path, { method, headers, body })` with a JSON
 * string body and a plain-object headers map.
 */
function decodeRequest(args: unknown[]): CapturedRequest {
  const url = String(args[0]);
  const init = (args[1] ?? {}) as {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
  const headers = init.headers ?? {};
  let body: Record<string, unknown> = {};
  if (typeof init.body === "string" && init.body.length > 0) {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  return {
    url,
    method: init.method ?? "GET",
    sessionHeader: headers[SESSION_HEADER] ?? null,
    body,
  };
}

/**
 * Build a JSON `Response`-like object the page's `await res.json()` accepts.
 * The page only ever reads `res.json()`, so a minimal shape suffices.
 */
function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

/**
 * Install a fetch spy whose responses are keyed by a matcher against the
 * request URL, in call order. Each entry is the payload the matching call
 * resolves its `.json()` to. Records every call into `captured`.
 */
function installFetch(
  responder: (req: CapturedRequest, callIndex: number) => unknown,
): void {
  captured = [];
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((...args: unknown[]) => {
      const req = decodeRequest(args);
      captured.push(req);
      const payload = responder(req, captured.length - 1);
      return Promise.resolve(jsonResponse(payload));
    });
}

/** Fill the CreateGame form and submit it. */
function fillAndSubmitCreate(opts: {
  start: string;
  finish: string;
  displayName: string;
}): void {
  const start = screen.getByPlaceholderText(/ladybird grove/i);
  const finish = screen.getByPlaceholderText(/new realm brewing/i);
  const name = screen.getByPlaceholderText(/captain of team/i);
  fireEvent.change(start, { target: { value: opts.start } });
  fireEvent.change(finish, { target: { value: opts.finish } });
  fireEvent.change(name, { target: { value: opts.displayName } });
  fireEvent.click(screen.getByRole("button", { name: /create game/i }));
}

/** Requests whose URL ends with the given suffix. */
function requestsTo(suffix: string): CapturedRequest[] {
  return captured.filter((r) => r.url.endsWith(suffix));
}

/**
 * Install a real, callable in-memory `localStorage` for the duration of a test.
 *
 * The project's jsdom harness exposes a `localStorage` object that supports
 * `.clear()` (used by the sibling tests) but whose `getItem`/`setItem` are not
 * callable functions here, so both the page's best-effort `readLocal`/
 * `writeLocal` (which swallow the resulting error) and our assertions would
 * silently see nothing. A plain Map-backed stub gives the page a working durable
 * store and lets us read back the facts it writes (`bbb:admin`, `bbb:player`,
 * and the SessionStore's session id). Defined non-configurably-safe so it can be
 * restored between tests.
 */
function installMemoryLocalStorage(): void {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(key, String(value));
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
    clear: (): void => {
      map.clear();
    },
    key: (index: number): string | null => [...map.keys()][index] ?? null,
    get length(): number {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  supabaseConfigured = false;
  snapshotEvents = [];
  routeParams.gameId = "";
  pushMock.mockClear();
  installMemoryLocalStorage();
});

afterEach(() => {
  fetchSpy?.mockRestore();
  cleanup();
});

describe("Lobby create→bars→join orchestration (Requirements 2.1, 2.2, 2.3, 6.3)", () => {
  it("issues create → bars → join in order, on the same session header, with a normalized code + trimmed name", async () => {
    routeParams.gameId = "new";
    // Create returns a lowercase, space-padded code so we can prove the join
    // request carries the NORMALIZED (trim+uppercase) form.
    installFetch((req) => {
      if (req.url === "/api/games") {
        return { applied: true, gameId: "game-new-1", joinCode: "  abc123  " };
      }
      if (req.url.endsWith("/bars")) {
        return { applied: true };
      }
      if (req.url.endsWith("/join")) {
        return { applied: true, playerId: "player-777" };
      }
      return { applied: true };
    });

    render(<LobbyPage />);
    fillAndSubmitCreate({
      start: "Start Bar",
      finish: "Finish Bar",
      displayName: "  Alex  ",
    });

    await waitFor(() => {
      expect(requestsTo("/join").length).toBe(1);
    });

    // Ordering (R2.1): the three POSTs appear in create → bars → join order.
    const orderedUrls = captured.map((r) => r.url);
    const createIdx = orderedUrls.indexOf("/api/games");
    const barsIdx = orderedUrls.findIndex((u) => u.endsWith("/bars"));
    const joinIdx = orderedUrls.findIndex((u) => u.endsWith("/join"));
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(barsIdx).toBeGreaterThan(createIdx);
    expect(joinIdx).toBeGreaterThan(barsIdx);

    // All three target the created game id after create.
    expect(orderedUrls[barsIdx]).toBe("/api/games/game-new-1/bars");
    expect(orderedUrls[joinIdx]).toBe("/api/games/game-new-1/join");

    // The join body carries the normalized code + trimmed name (R6.2/R2.1).
    const join = requestsTo("/join")[0];
    expect(join.body.joinCode).toBe(normalizeSubmittedCode("  abc123  "));
    expect(join.body.joinCode).toBe("ABC123");
    expect(join.body.displayName).toBe("Alex"); // trimmed by CreateGame

    // Every request carries the SAME non-empty session header (R2.2/R6.3).
    const sessionIds = captured.map((r) => r.sessionHeader);
    expect(sessionIds.every((s) => s !== null && s !== "")).toBe(true);
    expect(new Set(sessionIds).size).toBe(1);
    // And it matches the durable session store value.
    const storedSession = globalThis.localStorage.getItem(SESSION_STORAGE_KEY);
    expect(sessionIds[0]).toBe(storedSession);

    // Bars body carries the raw (un-normalized) bar names.
    const bars = requestsTo("/bars")[0];
    expect(bars.body.startBarName).toBe("Start Bar");
    expect(bars.body.finishBarName).toBe("Finish Bar");
  });

  it("writes bbb:player and navigates to the created lobby on a successful join (R2.3)", async () => {
    routeParams.gameId = "new";
    installFetch((req) => {
      if (req.url === "/api/games") {
        return { applied: true, gameId: "game-ok", joinCode: "ROOM99" };
      }
      if (req.url.endsWith("/bars")) {
        return { applied: true };
      }
      if (req.url.endsWith("/join")) {
        return { applied: true, playerId: "player-42" };
      }
      return { applied: true };
    });

    render(<LobbyPage />);
    fillAndSubmitCreate({
      start: "Alpha",
      finish: "Omega",
      displayName: "Host",
    });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/games/game-ok/lobby");
    });

    // The durable Player_Fact the destination page reads on mount is written
    // with the returned player id (R2.3).
    expect(globalThis.localStorage.getItem("bbb:player:game-ok")).toBe(
      "player-42",
    );
    // The Admin fact is written too (host owns the game).
    expect(globalThis.localStorage.getItem("bbb:admin:game-ok")).not.toBeNull();
  });

  it("on join failure after create: exactly one POST /api/games, still navigates, writes bbb:admin, leaves bbb:player absent (R3.1)", async () => {
    routeParams.gameId = "new";
    installFetch((req) => {
      if (req.url === "/api/games") {
        return { applied: true, gameId: "game-jf", joinCode: "ROOM99" };
      }
      if (req.url.endsWith("/bars")) {
        return { applied: true };
      }
      if (req.url.endsWith("/join")) {
        return { applied: false, error: "join_failed" };
      }
      return { applied: true };
    });

    render(<LobbyPage />);
    fillAndSubmitCreate({
      start: "Alpha",
      finish: "Omega",
      displayName: "Host",
    });

    // Navigation still happens once the game exists (R3.1).
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/games/game-jf/lobby");
    });

    // Exactly ONE create POST — the game is never recreated (R3.1).
    expect(
      requestsTo("/api/games").filter((r) => r.url === "/api/games").length,
    ).toBe(1);
    // The join was attempted once and failed.
    expect(requestsTo("/join").length).toBe(1);

    // Admin fact written; Player_Fact left absent so the lobby shows the
    // host-completion recovery surface (R3.1/R3.2).
    expect(globalThis.localStorage.getItem("bbb:admin:game-jf")).not.toBeNull();
    expect(globalThis.localStorage.getItem("bbb:player:game-jf")).toBeNull();
  });
});

describe("Lobby host-completion recovery (Requirement 3.3)", () => {
  it("renders HostJoinCompletion for a not-yet-joined Admin and writes bbb:player on completion", async () => {
    // Take the CONFIGURED realtime path so the snapshot folds `view.joinCode`
    // from a `game_created` event (the host-completion surface needs a resolved
    // code to submit against).
    supabaseConfigured = true;
    const gameId = "game-host";
    snapshotEvents = [
      {
        id: `evt-${gameId}-1`,
        gameId,
        seq: 1,
        eventType: "game_created",
        actorKind: "admin",
        actorTeamId: null,
        payload: { joinCode: "HOSTCODE" },
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ];
    routeParams.gameId = gameId;

    // Seed a durable session id, then mark THIS session as the game's Admin with
    // no Player_Fact — the exact "created-but-not-joined Admin" shape the render
    // selection keys on. The page mints/reuses the session via SessionStore, so
    // pre-seeding the session key guarantees isAdmin === true.
    const sessionId = "session-under-test";
    globalThis.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    globalThis.localStorage.setItem(`bbb:admin:${gameId}`, sessionId);
    // bbb:player intentionally absent.

    installFetch((req) => {
      if (req.url.endsWith("/join")) {
        return { applied: true, playerId: "host-player-1" };
      }
      return { applied: true };
    });

    render(<LobbyPage />);

    // Once the snapshot folds, the host-completion surface renders (name only,
    // no code input) because (isAdmin=true, hasJoined=false).
    const heading = await screen.findByRole("heading", {
      name: /finish joining your game/i,
    });
    expect(heading).not.toBeNull();
    // Within the host-completion surface there is exactly one text input (the
    // display name) and NO code input — scoped to its own <section> because the
    // Admin also sees the bars-designation surface (bars are not folded here).
    const hostSection = heading.closest("section");
    expect(hostSection).not.toBeNull();
    expect(
      within(hostSection as HTMLElement).getAllByRole("textbox").length,
    ).toBe(1);
    // The code-entry JoinGame is never rendered for the not-yet-joined Admin (R4).
    expect(screen.queryByRole("heading", { name: /join a game/i })).toBeNull();

    // Complete the join by entering only a name.
    fireEvent.change(screen.getByPlaceholderText(/alex/i), {
      target: { value: "  Casey  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /join game/i }));

    await waitFor(() => {
      expect(requestsTo("/join").length).toBe(1);
    });

    // The join used the folded authoritative code and the trimmed name, on the
    // Admin's session header (R3.3).
    const join = requestsTo("/join")[0];
    expect(join.url).toBe(`/api/games/${gameId}/join`);
    expect(join.body.joinCode).toBe("HOSTCODE");
    expect(join.body.displayName).toBe("Casey");
    expect(join.sessionHeader).toBe(sessionId);

    // On success the Player_Fact is written (R3.3).
    await waitFor(() => {
      expect(globalThis.localStorage.getItem(`bbb:player:${gameId}`)).toBe(
        "host-player-1",
      );
    });
  });
});
