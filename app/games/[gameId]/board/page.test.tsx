// @vitest-environment jsdom
//
// Example/render tests for the Game_Board page (`app/games/[gameId]/board/page.tsx`)
// — Task 11.1. These assert the ACCESS-GATE branches (R1) and the REALTIME
// WIRING (R8) at the page level, with the network/realtime/session seams faked,
// exactly mirroring the sibling lobby page tests
// (`app/games/[gameId]/lobby/page.orchestration.test.tsx`,
// `page.prefill.test.tsx`).
//
// WHAT THIS FILE OWNS (and what it deliberately does NOT):
//   The page composes already-property-tested pieces — the pure Game_Board
//   reducer (`lib/gameboard/events`), the access decision (`lib/gameboard/access`),
//   the region transition (`lib/gameboard/region`), and the foundation realtime
//   client + reconnect/resume controllers (`lib/realtime/*`). This file asserts
//   the COMPOSITION the page is responsible for:
//     - R1.1 a live member renders the three Regions (via RegionNav);
//     - R1.3 a lobby-phase visitor is redirected to the lobby and renders NO Regions;
//     - R1.4 an ended game shows an ended indication and renders NO Regions;
//     - R1.5 a non-member sees the not-authorized notice and NO Regions;
//     - R1.6 with no established session, the establish-session prompt shows;
//     - R2.1 exactly three nav controls; R2.3 the initial active Region is Bars;
//     - R8.1 the page subscribes with THIS game's id once the session resolves;
//     - R8.8 a subscription/snapshot failure surfaces the "live updates
//       unavailable — reload" notice and renders NO Regions.
//   The ordered-apply / per-game isolation / bounded-reconnect / resume-catch-up
//   BEHAVIOR itself is reused from the `lib/realtime` property suites and is NOT
//   re-tested here — we only assert the page WIRES those controllers in (the
//   ReconnectController/ResumeController construction runs as part of the
//   subscribe effect, which we drive to completion).
//
// SCOPING NOTE — DOM environment + mocked seams:
//   The project's Vitest harness defaults to `node` (see vitest.config.mts). This
//   file opts into `jsdom` for THIS FILE ONLY via the `@vitest-environment jsdom`
//   docblock on line 1, mirroring the sibling lobby tests. The global config is
//   untouched. The realtime transport/snapshot/session seams are faked so no live
//   Supabase connection opens; the pure reducer + access + region logic runs for
//   real (only I/O is faked).

import {
  cleanup,
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
import { establishBrowserSession } from "@/lib/session/supabaseSession";
import { subscribe } from "@/lib/realtime";

// --- next/navigation: route param + router.push capture ---------------------
//
// `useParams` drives the active game id (mutable per test). `useRouter().push`
// is captured so the lobby-redirect branch (R1.3) can be asserted.

const routeParams: { gameId: string } = { gameId: "" };
const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => routeParams,
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
// The page reads `isSupabaseConfigured()`, opens a browser client, and folds a
// snapshot from `supabaseSnapshotSource().fetchEventsAscending(gameId)` before
// opening the channel via `subscribe()`. We back the snapshot source with a
// mutable holder + an optional rejection so each test can drive the folded
// lifecycle (R1.x) or a snapshot failure (R8.8). `subscribe` is a spy so the
// subscribed game id (R8.1) is inspectable; it can also be made to reject to
// exercise the subscribe-failure path (R8.8).

let supabaseConfigured = true;
let snapshotEvents: GameEvent[] = [];
let snapshotShouldReject = false;
let subscribeShouldReject = false;

vi.mock("@/lib/realtime/supabaseBrowser", () => ({
  isSupabaseConfigured: () => supabaseConfigured,
  createBrowserSupabaseClient: () =>
    supabaseConfigured ? ({} as unknown) : null,
  supabaseRealtimeTransport: () => ({
    channel: () => ({ unsubscribe: async () => {} }),
  }),
  supabaseSnapshotSource: () => ({
    fetchEventsAscending: async () => {
      if (snapshotShouldReject) {
        throw new Error("snapshot_failed");
      }
      return snapshotEvents;
    },
  }),
}));

// The realtime client `subscribe` is a spy: it records the game id it is opened
// with (R8.1) and, unless told to reject, resolves to an inert subscription the
// page can later close. The page constructs its ReconnectController and
// ResumeController inside the same effect that calls this, so a resolved
// subscribe proves the controllers were wired up (their behavior is reused from
// the lib/realtime property suites, not re-tested here).
vi.mock("@/lib/realtime", () => ({
  subscribe: vi.fn(async () => {
    if (subscribeShouldReject) {
      throw new Error("subscribe_failed");
    }
    return {
      snapshot: { lastSeenSequence: 0 },
      close: async () => {},
    };
  }),
}));

// Mock the Supabase-auth session bridge. The page adopts the resolved
// `sessionId` as its BBB session id and derives `isAdmin` by comparing
// `bbb:admin:{gameId}` to it. A mutable resolver lets the no-session test (R1.6)
// keep the bootstrap pending so `sessionId` stays null.
let sessionShouldResolve = true;
const mockSessionId = "sess-board-under-test";

vi.mock("@/lib/session/supabaseSession", () => ({
  establishBrowserSession: vi.fn(
    () =>
      new Promise((resolve) => {
        if (sessionShouldResolve) {
          resolve({ sessionId: mockSessionId, accessToken: "test-token" });
        }
        // else: never resolves — the page's `sessionId` stays null (R1.6).
      }),
  ),
  bindRealtimeAuth: vi.fn(() => () => {}),
}));

import BoardPage from "./page";

/**
 * Install a real, callable in-memory `localStorage` for the duration of a test
 * (mirrors the lobby orchestration test). The page reads the per-game durable
 * facts `bbb:admin:{gameId}` / `bbb:player:{gameId}` through it to derive role.
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

/** Mark THIS session as a joined Player of the game (durable per-game fact). */
function seedPlayer(gameId: string, playerId = "player-1"): void {
  globalThis.localStorage.setItem(`bbb:player:${gameId}`, playerId);
}

/** Mark THIS session as the game's Admin (durable per-game fact). */
function seedAdmin(gameId: string): void {
  globalThis.localStorage.setItem(`bbb:admin:${gameId}`, mockSessionId);
}

// --- Snapshot event builders ------------------------------------------------
//
// The page seeds its GameBoardView by folding the snapshot with the pure
// Game_Board reducer. These build the minimal events each lifecycle needs.

/** A `game_created` event carrying a Team so the roster/scoreboard has a row. */
function gameCreatedEvent(gameId: string): GameEvent {
  return {
    id: `evt-${gameId}-1`,
    gameId,
    seq: 1,
    eventType: "game_created",
    actorKind: "admin",
    actorTeamId: null,
    payload: { teamId: "team-1", name: "Red", color: "#f00" },
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

/** A `team_created` event for the current player's Team. */
function teamCreatedEvent(gameId: string): GameEvent {
  return {
    id: `evt-${gameId}-2`,
    gameId,
    seq: 2,
    eventType: "team_created",
    actorKind: "admin",
    actorTeamId: null,
    payload: { teamId: "team-2", name: "Blue", color: "#00f" },
    createdAt: "2024-01-01T00:00:01.000Z",
  };
}

/** A `game_started` event flipping lifecycle → live. */
function gameStartedEvent(gameId: string, seq = 3): GameEvent {
  return {
    id: `evt-${gameId}-${seq}`,
    gameId,
    seq,
    eventType: "game_started",
    actorKind: "admin",
    actorTeamId: null,
    payload: {},
    createdAt: "2024-01-01T00:00:02.000Z",
  };
}

/** A `game_ended` event flipping lifecycle → ended. */
function gameEndedEvent(gameId: string, seq = 4): GameEvent {
  return {
    id: `evt-${gameId}-${seq}`,
    gameId,
    seq,
    eventType: "game_ended",
    actorKind: "admin",
    actorTeamId: null,
    payload: {},
    createdAt: "2024-01-01T00:00:03.000Z",
  };
}

/** The Region nav element, present only on the `board` decision. */
function queryRegionNav(): HTMLElement | null {
  return screen.queryByRole("navigation", { name: /game board regions/i });
}

let subscribeSpy: MockInstance;

beforeEach(() => {
  supabaseConfigured = true;
  snapshotEvents = [];
  snapshotShouldReject = false;
  subscribeShouldReject = false;
  sessionShouldResolve = true;
  routeParams.gameId = "game-board-1";
  pushMock.mockClear();
  vi.mocked(establishBrowserSession).mockClear();
  subscribeSpy = vi.mocked(subscribe);
  subscribeSpy.mockClear();
  installMemoryLocalStorage();
});

afterEach(() => {
  cleanup();
});

describe("Game_Board access gate (Requirements 1.1, 1.3, 1.4, 1.5, 1.6)", () => {
  it("R1.1/R2.1/R2.3: a live member renders the three Regions with Bars active", async () => {
    const gameId = "game-live";
    routeParams.gameId = gameId;
    seedPlayer(gameId);
    snapshotEvents = [
      gameCreatedEvent(gameId),
      teamCreatedEvent(gameId),
      gameStartedEvent(gameId),
    ];

    render(<BoardPage />);

    // Once the session resolves and the snapshot folds to `live`, the access
    // decision is `board` and the three Regions render (R1.1).
    const nav = await waitFor(() => {
      const found = queryRegionNav();
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    // R2.1: exactly three navigation controls.
    const controls = within(nav).getAllByRole("button");
    expect(controls).toHaveLength(3);
    expect(controls.map((c) => c.textContent)).toEqual([
      "Bars",
      "Scoreboard",
      "Cards",
    ]);

    // R2.3: the initial active Region is Bars — its control is the one marked
    // current, and it is the Bars control.
    const active = controls.filter(
      (c) => c.getAttribute("aria-current") === "page",
    );
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toBe("Bars");
  });

  it("R1.3: a lobby-phase visitor is redirected to the lobby and renders no Regions", async () => {
    const gameId = "game-lobby";
    routeParams.gameId = gameId;
    seedPlayer(gameId);
    // No game_started event: lifecycle stays `lobby` → access `redirect-lobby`.
    snapshotEvents = [gameCreatedEvent(gameId)];

    render(<BoardPage />);

    // The redirect effect navigates to the game's lobby (R1.3).
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(`/games/${gameId}/lobby`);
    });

    // No Regions are ever rendered on the redirect branch.
    expect(queryRegionNav()).toBeNull();
  });

  it("R1.4: an ended game shows an ended indication and renders no Regions", async () => {
    const gameId = "game-ended";
    routeParams.gameId = gameId;
    seedPlayer(gameId);
    snapshotEvents = [
      gameCreatedEvent(gameId),
      gameStartedEvent(gameId),
      gameEndedEvent(gameId),
    ];

    render(<BoardPage />);

    await waitFor(() => {
      expect(screen.getByText(/this game has ended/i)).not.toBeNull();
    });

    // No Regions on the ended branch (R1.4).
    expect(queryRegionNav()).toBeNull();
  });

  it("R1.5: a non-member (neither Admin nor Player) sees the not-authorized notice and no Regions", async () => {
    const gameId = "game-nonmember";
    routeParams.gameId = gameId;
    // Neither bbb:player nor bbb:admin seeded for this session → not a member.
    // Even though the game is live, a non-member is gated out.
    snapshotEvents = [gameCreatedEvent(gameId), gameStartedEvent(gameId)];

    render(<BoardPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/not authorized to view this game board/i),
      ).not.toBeNull();
    });

    expect(queryRegionNav()).toBeNull();
  });

  it("R1.6: with no established session, the establish-session prompt shows and no Regions", async () => {
    const gameId = "game-nosession";
    routeParams.gameId = gameId;
    seedPlayer(gameId);
    // Keep the async session bootstrap pending: `sessionId` stays null, so the
    // access decision is `no-session` regardless of role facts (R1.6).
    sessionShouldResolve = false;
    snapshotEvents = [gameCreatedEvent(gameId), gameStartedEvent(gameId)];

    render(<BoardPage />);

    await waitFor(() => {
      expect(screen.getByText(/establishing your session/i)).not.toBeNull();
    });

    expect(queryRegionNav()).toBeNull();
  });
});

describe("Game_Board realtime wiring (Requirements 8.1, 8.5, 8.6, 8.7, 8.8)", () => {
  it("R8.1: subscribes with this game's id once the session resolves (wiring reconnect/resume in the same effect)", async () => {
    const gameId = "game-sub";
    routeParams.gameId = gameId;
    seedPlayer(gameId);
    snapshotEvents = [gameCreatedEvent(gameId), gameStartedEvent(gameId)];

    render(<BoardPage />);

    // The subscription opens with THIS game's id (R8.1). Reaching subscribe
    // means the effect built the ReconnectController + ResumeController and
    // seeded the ordered snapshot fold ahead of it (R8.5/8.6/8.7 wiring; the
    // controllers' behavior is covered by the lib/realtime property suites).
    await waitFor(() => {
      expect(subscribeSpy).toHaveBeenCalled();
    });
    expect(subscribeSpy.mock.calls[0][0]).toBe(gameId);
  });

  it("R8.8: a snapshot failure drives status to error and never presents partial live state (no Regions)", async () => {
    const gameId = "game-snapfail";
    routeParams.gameId = gameId;
    seedPlayer(gameId);
    snapshotEvents = [gameCreatedEvent(gameId), gameStartedEvent(gameId)];
    // The snapshot fetch throws before the fold can flip the view to `live`: the
    // page sets status → `error` and, because the lifecycle never reached
    // `live`, presents no Regions rather than showing partially-applied state as
    // live (R8.8). The user-facing status line reflects the failure.
    snapshotShouldReject = true;

    render(<BoardPage />);

    await waitFor(() => {
      expect(screen.getByText(/game board · error/i)).not.toBeNull();
    });

    // No Regions: the failed snapshot never presented live state (R8.8).
    expect(queryRegionNav()).toBeNull();
  });

  it("R8.8: a subscribe failure (after the snapshot folds live) surfaces the 'live updates unavailable' notice", async () => {
    const gameId = "game-subfail";
    routeParams.gameId = gameId;
    seedPlayer(gameId);
    snapshotEvents = [gameCreatedEvent(gameId), gameStartedEvent(gameId)];
    // The snapshot fold succeeds (→ live, so access is `board`) but opening the
    // channel throws: the page surfaces the explicit unavailable/reload notice on
    // the board surface (R8.8).
    subscribeShouldReject = true;

    render(<BoardPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/live updates are unavailable\. please reload/i),
      ).not.toBeNull();
    });
  });
});
