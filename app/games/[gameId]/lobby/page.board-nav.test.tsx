// @vitest-environment jsdom
//
// Interaction test for the lobby → Game_Board navigation entry point
// (in-game-landing-wireframe Task 12.1; Requirement 1.2).
//
// R1.2: WHEN a Game_Board_Client applies a Game_Event that sets a Game's
// `lifecycle` to `live`, THE Game_Board_Client SHALL, within 5 seconds of
// applying that Game_Event, present a control that navigates from the lobby to
// the Game_Board for that Game.
//
// The lobby page realizes this by surfacing a Next.js <Link> with the accessible
// name "Go to game board" pointing at `/games/{gameId}/board` once its folded
// LobbyView reaches `lifecycle === "live"`. The lifecycle flips to `live` only
// when the page folds a `game_started` event.
//
// This test drives that fold through the SAME seam the real page uses: the
// realtime `subscribe()` delivers live events to the page's `onEvent` handler,
// each of which is folded with `applyLobbyEvent`. We capture that handler from a
// controllable `subscribe` mock, assert the board-nav control is ABSENT before
// any `game_started` event (the game is still in the lobby), then deliver a
// `game_started` event and assert the control APPEARS pointing at the board — so
// the control is a consequence of applying the event (R1.2), not merely of the
// initial render.
//
// SCOPING NOTE — DOM environment + mocked seams:
//   The project's Vitest harness defaults to the `node` environment (see
//   vitest.config.mts); this file opts into `jsdom` for THIS FILE ONLY via the
//   `@vitest-environment jsdom` docblock on line 1, mirroring the sibling lobby
//   page tests. We take the "configured" realtime path so the subscription
//   effect runs, and mock only the I/O seams:
//     - `@/lib/realtime/supabaseBrowser` so `isSupabaseConfigured()` is true and
//       the snapshot source is an empty fake (no live Supabase).
//     - `@/lib/realtime` so `subscribe()` captures the page's `onEvent` handler
//       and returns an inert subscription (no live channel).
//     - `@/lib/session/supabaseSession` so the async session bootstrap settles.
//   The pure fold (`applyLobbyEvent`/`foldLobbyEvents`) runs for real — only I/O
//   is faked.

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GameEvent } from "@/lib/events";
import { LOBBY_EVENT_TYPES } from "@/lib/lobby/events";

// --- next/navigation: route param + inert router ---------------------------

const routeParams: { gameId: string } = { gameId: "" };

vi.mock("next/navigation", () => ({
  useParams: () => routeParams,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// --- realtime seams: configured, empty snapshot ----------------------------

vi.mock("@/lib/realtime/supabaseBrowser", () => ({
  isSupabaseConfigured: () => true,
  createBrowserSupabaseClient: () => ({}) as unknown,
  supabaseRealtimeTransport: () => ({
    channel: () => ({ unsubscribe: async () => {} }),
  }),
  supabaseSnapshotSource: () => ({
    // The game starts in the lobby with no prior events folded in.
    fetchEventsAscending: async () => [] as GameEvent[],
  }),
}));

// Capture the page's live-event handler so the test can deliver a
// `game_started` event through the exact path the real page applies events on.
let deliveredOnEvent: ((event: GameEvent) => void) | null = null;

vi.mock("@/lib/realtime", () => ({
  subscribe: async (
    _gameId: string,
    opts: { handlers: { onEvent: (event: GameEvent) => void } },
  ) => {
    deliveredOnEvent = opts.handlers.onEvent;
    return {
      snapshot: { lastSeenSequence: 0 },
      close: async () => {},
    };
  },
}));

// Mock the Supabase-auth session bridge so the async identity bootstrap settles
// and the subscription effect (gated on the resolved session id) runs. The
// resolved id is written as this game's `bbb:admin` fact in beforeEach so the
// session is recognized as the Admin (a member who sees the live roster/board).
const ADMIN_SESSION_ID = "sess-board-nav-admin";

vi.mock("@/lib/session/supabaseSession", () => ({
  establishBrowserSession: vi.fn(async () => ({
    sessionId: ADMIN_SESSION_ID,
    accessToken: "test-token",
  })),
  bindRealtimeAuth: vi.fn(() => () => {}),
}));

import LobbyPage from "./page";

const GAME_ID = "game-board-nav";

/** A `game_started` event for the game under test, at the given sequence. */
function gameStartedEvent(seq: number): GameEvent {
  return {
    id: `evt-${GAME_ID}-${seq}`,
    gameId: GAME_ID,
    seq,
    eventType: LOBBY_EVENT_TYPES.gameStarted,
    actorKind: "admin",
    actorTeamId: null,
    payload: {},
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

/** Install a real, Map-backed localStorage so the page's role facts persist. */
function installMemoryLocalStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
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
    },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  routeParams.gameId = GAME_ID;
  deliveredOnEvent = null;
  installMemoryLocalStorage();
  // This session is the game's Admin (a member), so the subscription runs.
  globalThis.localStorage.setItem(`bbb:admin:${GAME_ID}`, ADMIN_SESSION_ID);
});

afterEach(() => {
  cleanup();
});

describe("Lobby → Game_Board navigation entry point (Requirement 1.2)", () => {
  it("surfaces a 'Go to game board' control pointing at the board only after folding a game_started event", async () => {
    render(<LobbyPage />);

    // The subscription effect runs once the async session bootstrap resolves;
    // wait until the page has captured the live-event handler.
    await waitFor(() => {
      expect(deliveredOnEvent).not.toBeNull();
    });

    // Before any game_started event the game is still in the lobby, so the
    // board-navigation control is absent (proves the control follows from
    // applying the event, not from the initial render).
    expect(
      screen.queryByRole("link", { name: /go to game board/i }),
    ).toBeNull();

    // Deliver a game_started event through the page's live-event handler,
    // exactly as the realtime transport would (folded via applyLobbyEvent →
    // lifecycle "live").
    act(() => {
      deliveredOnEvent?.(gameStartedEvent(1));
    });

    // Within the propagation window the lobby presents a navigate-to-board
    // control pointing at this game's Game_Board (R1.2).
    const link = await screen.findByRole("link", {
      name: /go to game board/i,
    });
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe(`/games/${GAME_ID}/board`);
  });
});
