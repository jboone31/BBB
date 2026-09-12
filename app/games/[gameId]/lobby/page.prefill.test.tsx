// @vitest-environment jsdom
//
// Interaction test for the lobby join surfaces driven by the `?code=` carrier
// and the join-code PREFILL PRECEDENCE (Task 9.1; Requirements 5.1, 5.2).
//
// The Share_Link / Join_Entry flow carries the typed code into the lobby as a
// `?code=` query param. The lobby page now derives BOTH which surface to show
// and (for the bare-visitor JoinGame path) that surface's prefill:
//
//   - WHEN `?code=` is present AND passes isValidSubmittedCode, the visitor
//     arrived with a resolved code. A not-yet-joined, non-admin visitor is
//     shown the NAME-ONLY code-complete surface (the reused HostJoinCompletion)
//     with heading "Join this game" — NOT the full JoinGame code-entry form.
//     They already have the code, so there is nothing to prefill and no code
//     input to seed.
//   - WHEN there is NO `?code=`, a bare `/games/{gameId}/lobby` visitor is shown
//     the full JoinGame form. Its `initialJoinCode` still follows the prefill
//     precedence the page derives:
//
//         joinCodePrefill = view.joinCode ?? codeParam ?? ""
//
//     With no `?code=` carrier, the form prefills from the authoritative
//     `view.joinCode` once the folded `game_created` event resolves it (R5.2,
//     the share-link-without-code behavior).
//
// WHY WE ASSERT ON THE PROP, NOT THE INPUT'S value (for the JoinGame path):
//   The page implements prefill precedence by deriving the value it PASSES to
//   `JoinGame`'s `initialJoinCode` (design.md §"Prefill mechanism (R4.4/R5.2)":
//   "…preferring the authoritative `view.joinCode` once it arrives"). `JoinGame`
//   itself treats `initialJoinCode` as an *initial* seed for an uncontrolled
//   input (its own documented contract), so once mounted its rendered input value
//   is user-owned and does not re-seed on later prop changes. The behavior Task
//   9.1 owns — the page's precedence rule — therefore lives in what the page
//   hands `JoinGame`, so we mock `JoinGame` and capture the `initialJoinCode` it
//   receives on each phase. The code-arriving surface renders the real
//   HostJoinCompletion, so we assert directly on its name-only shape.
//
// HOW the snapshot phases are separated in a unit test:
//   The page loads the snapshot in an async effect (fetchEventsAscending →
//   foldLobbyEvents → setView). This test hands the mocked snapshot source a
//   promise we resolve on demand, so we can observe the pre-snapshot render and
//   then release the fold and observe the authoritative `view.joinCode`.
//
// SCOPING NOTE — DOM environment + mocked seams:
//   The project's Vitest harness defaults to the `node` environment (see
//   vitest.config.mts). This file opts into `jsdom` for THIS FILE ONLY via the
//   `@vitest-environment jsdom` docblock on line 1, mirroring the sibling
//   page.viewport.test.tsx. The global config is untouched.
//
//   To render the lobby in its UNJOINED state with `view.joinCode` driven from
//   folded events, we take the "configured" realtime path and mock the two
//   realtime seams the page imports:
//     - `@/lib/realtime/supabaseBrowser` so `isSupabaseConfigured()` is true and
//       the snapshot source is our controllable fake (no live Supabase).
//     - `@/lib/realtime` so `subscribe()` is an inert no-op (no live channel).
//   The pure fold (`foldLobbyEvents`) is exercised for real — only I/O is faked.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GameEvent } from "@/lib/events";
import type { JoinGameProps } from "@/components/lobby/JoinGame";

// --- next/navigation: route param + router + the ?code= carrier ------------
//
// `useSearchParams()` is what the page reads the `?code=` prefill from; a
// mutable holder lets each test set the query string under test. `useParams`
// drives the active game id; `useRouter` is inert here (no navigation asserted).

const routeParams: { gameId: string } = { gameId: "" };
let searchParamsValue = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useParams: () => routeParams,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => searchParamsValue,
}));

// --- Capture what the page hands JoinGame ----------------------------------
//
// For the bare-visitor (no `?code=`) path, the prefill-precedence rule under
// test is expressed as the value the page derives and passes as JoinGame's
// `initialJoinCode`. Mock JoinGame with a light stub that records the prop on
// every render and renders it into a stable probe element so each phase's seed
// is observable from the DOM. (The code-arriving path renders the real
// HostJoinCompletion, unmocked.)

const initialJoinCodeRenders: string[] = [];

vi.mock("@/components/lobby/JoinGame", () => ({
  __esModule: true,
  default: (props: JoinGameProps) => {
    const seed = props.initialJoinCode ?? "";
    initialJoinCodeRenders.push(seed);
    return <div data-testid="join-game-stub" data-initial-join-code={seed} />;
  },
}));

/** The most recent `initialJoinCode` the page handed JoinGame. */
function latestSeed(): string {
  const stub = screen.getByTestId("join-game-stub");
  return stub.getAttribute("data-initial-join-code") ?? "";
}

// --- Controllable snapshot source ------------------------------------------
//
// The page calls `snapshotSource.fetchEventsAscending(gameId)` once on mount and
// folds the result into `view`. We back it with a deferred promise so a test can
// hold the fold open and then release it.

let snapshotDeferred: {
  promise: Promise<GameEvent[]>;
  resolve: (events: GameEvent[]) => void;
};

function makeDeferredSnapshot(): typeof snapshotDeferred {
  let resolve!: (events: GameEvent[]) => void;
  const promise = new Promise<GameEvent[]>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Mock the browser Supabase adapter: report configured, hand back a stub client,
// and provide our controllable snapshot source. The transport is never exercised
// because we also stub `subscribe` below.
vi.mock("@/lib/realtime/supabaseBrowser", () => ({
  isSupabaseConfigured: () => true,
  createBrowserSupabaseClient: () => ({}) as unknown,
  supabaseRealtimeTransport: () => ({
    channel: () => ({ unsubscribe: async () => {} }),
  }),
  supabaseSnapshotSource: () => ({
    fetchEventsAscending: () => snapshotDeferred.promise,
  }),
}));

// Mock the transport-agnostic realtime client so `subscribe()` opens no channel;
// it resolves to an inert subscription the page can later close.
vi.mock("@/lib/realtime", () => ({
  subscribe: async () => ({
    snapshot: { lastSeenSequence: 0 },
    close: async () => {},
  }),
}));

// Mock the Supabase-auth session bridge: the page bootstraps its session id
// asynchronously (anonymous sign-in) before the subscription effect runs — which
// is now gated on the resolved session id. Resolve a fixed id so the bootstrap
// settles and the snapshot fold effect can run. This id is NOT written as any
// game's `bbb:admin` flag, so the visitor is a non-admin (they land on the
// code-complete / join surfaces rather than the host surface).
vi.mock("@/lib/session/supabaseSession", () => ({
  establishBrowserSession: vi.fn(async () => ({
    sessionId: "sess-prefill-visitor",
    accessToken: "test-token",
  })),
  bindRealtimeAuth: vi.fn(() => () => {}),
}));

import LobbyPage from "./page";

/** A folded `game_created` event carrying the authoritative Join_Code. */
function gameCreatedEvent(gameId: string, joinCode: string): GameEvent {
  return {
    id: `evt-${gameId}-1`,
    gameId,
    seq: 1,
    eventType: "game_created",
    actorKind: "admin",
    actorTeamId: null,
    payload: { joinCode },
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  routeParams.gameId = "game-abc";
  searchParamsValue = new URLSearchParams();
  snapshotDeferred = makeDeferredSnapshot();
  initialJoinCodeRenders.length = 0;
  try {
    globalThis.localStorage?.clear();
  } catch {
    // storage is best-effort in the store under test too.
  }
});

afterEach(() => {
  cleanup();
});

describe("Lobby code-arriving visitor shows the name-only surface (Requirements 4.3, 5.1, 5.2)", () => {
  it("renders the name-only code-complete surface (not JoinGame) when arriving with a valid ?code=", async () => {
    // A share link / typed-code redirect: ?code=ABC123, visitor not joined and
    // not the admin. The resolved code means we ask only for a display name.
    searchParamsValue = new URLSearchParams({ code: "ABC123" });

    render(<LobbyPage />);

    // The code-complete surface uses the reused HostJoinCompletion with the
    // visitor wording — assert its heading is present.
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /join this game/i }),
      ).not.toBeNull();
    });

    // It is name-only: exactly one textbox, and it is the display-name field —
    // there is NO join-code input to prefill.
    const textboxes = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(textboxes).toHaveLength(1);
    expect(textboxes[0].name).toBe("displayName");

    // The full JoinGame code-entry form is NOT rendered on this path.
    expect(screen.queryByTestId("join-game-stub")).toBeNull();
  });

  it("still shows the name-only surface after the snapshot folds (view.joinCode is not exposed pre-join)", async () => {
    // The link carried a code; even once a game_created event folds in, a
    // not-yet-joined visitor stays on the name-only code-complete surface (they
    // are not a member, so the authoritative code is not surfaced to them here).
    searchParamsValue = new URLSearchParams({ code: "ABC123" });

    render(<LobbyPage />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /join this game/i }),
      ).not.toBeNull();
    });

    snapshotDeferred.resolve([gameCreatedEvent("game-abc", "REAL42")]);

    // The surface stays name-only; JoinGame never renders on the code path.
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /join this game/i }),
      ).not.toBeNull();
    });
    expect(screen.queryByTestId("join-game-stub")).toBeNull();
    const textboxes = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(textboxes).toHaveLength(1);
    expect(textboxes[0].name).toBe("displayName");
  });
});

describe("Lobby join-code prefill precedence for the bare visitor (Requirements 5.1, 5.2)", () => {
  it("shows JoinGame and prefills from view.joinCode when there is no ?code= (R5.2)", async () => {
    // A bare share link (/games/{gameId}/lobby) with no query param: the visitor
    // sees the full JoinGame form and it prefills once the folded view resolves
    // the authoritative Join_Code.
    searchParamsValue = new URLSearchParams();

    render(<LobbyPage />);

    // With no ?code= the bare visitor lands on the full JoinGame form.
    await waitFor(() => {
      expect(screen.queryByTestId("join-game-stub")).not.toBeNull();
    });

    // No carrier and no folded view yet → the seed starts empty.
    expect(latestSeed()).toBe("");

    snapshotDeferred.resolve([gameCreatedEvent("game-abc", "REAL42")]);

    // Once the game_created event folds in, view.joinCode drives the prefill.
    await waitFor(() => {
      expect(latestSeed()).toBe("REAL42");
    });
  });
});
