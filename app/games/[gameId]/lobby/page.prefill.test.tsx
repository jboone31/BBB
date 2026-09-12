// @vitest-environment jsdom
//
// Interaction test for the lobby join-code PREFILL PRECEDENCE (Task 9.1;
// Requirements 5.1, 5.2).
//
// The Share_Link / Join_Entry flow carries the typed code into the lobby as a
// `?code=` query param. `app/games/[gameId]/lobby/page.tsx` derives the join
// form's prefill as:
//
//     joinCodePrefill = view.joinCode ?? codeParam ?? ""
//
// and hands it to `JoinGame` as `initialJoinCode`. That derivation encodes the
// precedence this file pins down:
//
//   1. Opening `/games/{gameId}/lobby?code=ABC123` seeds JoinGame's
//      `initialJoinCode` with `ABC123` BEFORE the snapshot loads — while the
//      folded `view.joinCode` is still null (R5.2, the share-link prefill).
//   2. Once `view.joinCode` loads from the folded `game_created` event it takes
//      PRECEDENCE over `?code=` (the authoritative code wins).
//   3. With NO `?code=`, the form still prefills from `view.joinCode` once the
//      snapshot loads (existing share-link-without-code behavior, R5.2).
//
// WHY WE ASSERT ON THE PROP, NOT THE INPUT'S value:
//   The page implements prefill precedence by deriving the value it PASSES to
//   `JoinGame`'s `initialJoinCode` (design.md §"Prefill mechanism (R4.4/R5.2)":
//   "…preferring the authoritative `view.joinCode` once it arrives"). `JoinGame`
//   itself treats `initialJoinCode` as an *initial* seed for an uncontrolled
//   input (its own documented contract), so once mounted its rendered input value
//   is user-owned and does not re-seed on later prop changes. The behavior Task
//   9.1 owns — the page's precedence rule — therefore lives in what the page
//   hands `JoinGame`, so we mock `JoinGame` and capture the `initialJoinCode` it
//   receives on each phase.
//
// HOW the two phases are separated in a unit test:
//   The page loads the snapshot in an async effect (fetchEventsAscending →
//   foldLobbyEvents → setView). To observe phase (1) — the pre-snapshot render
//   where `?code=` is the only prefill source — this test hands the mocked
//   snapshot source a promise we resolve on demand. We assert the `?code=` value
//   is the seed BEFORE resolving, then resolve the fold and assert the
//   authoritative `view.joinCode` has taken over.
//
// SCOPING NOTE — DOM environment + mocked seams:
//   The project's Vitest harness defaults to the `node` environment (see
//   vitest.config.mts). This file opts into `jsdom` for THIS FILE ONLY via the
//   `@vitest-environment jsdom` docblock on line 1, mirroring the sibling
//   page.viewport.test.tsx. The global config is untouched.
//
//   To render the lobby in its UNJOINED state (so JoinGame is shown) with
//   `view.joinCode` driven from folded events, we take the "configured" realtime
//   path and mock the two realtime seams the page imports:
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
// The prefill-precedence rule under test is expressed as the value the page
// derives and passes as JoinGame's `initialJoinCode`. Mock JoinGame with a light
// stub that records the prop on every render and renders it into a stable probe
// element so each phase's seed is observable from the DOM.

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
// hold the fold open (observe the pre-snapshot `?code=` seed) and then release it
// (observe the authoritative `view.joinCode`).

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

describe("Lobby join-code prefill precedence (Requirements 5.1, 5.2)", () => {
  it("seeds JoinGame's initialJoinCode from ?code= before the snapshot resolves (R5.2)", async () => {
    // A share link / typed-code redirect: ?code=ABC123 with no folded view yet.
    searchParamsValue = new URLSearchParams({ code: "ABC123" });

    render(<LobbyPage />);

    // Before we release the snapshot fold, `view.joinCode` is still null, so the
    // ?code= carrier is the only prefill source: the seed is ABC123.
    expect(latestSeed()).toBe("ABC123");

    // Release an empty snapshot so nothing overrides ?code= — the seed persists.
    snapshotDeferred.resolve([]);
    await waitFor(() => {
      expect(latestSeed()).toBe("ABC123");
    });
  });

  it("prefers the folded view.joinCode over ?code= once the snapshot loads", async () => {
    // The link carried a code, but the authoritative game code differs; once the
    // game_created event folds in, view.joinCode must win.
    searchParamsValue = new URLSearchParams({ code: "ABC123" });

    render(<LobbyPage />);

    // Pre-snapshot: the ?code= carrier is the seed.
    expect(latestSeed()).toBe("ABC123");

    // Fold in the authoritative Join_Code.
    snapshotDeferred.resolve([gameCreatedEvent("game-abc", "REAL42")]);

    // view.joinCode takes precedence over ?code= in the derived seed.
    await waitFor(() => {
      expect(latestSeed()).toBe("REAL42");
    });
  });

  it("prefills from view.joinCode when there is no ?code= (R5.2)", async () => {
    // A bare share link (/games/{gameId}/lobby) with no query param: the form
    // still prefills once the folded view resolves the Join_Code.
    searchParamsValue = new URLSearchParams();

    render(<LobbyPage />);

    // No carrier and no folded view yet → the seed starts empty.
    expect(latestSeed()).toBe("");

    snapshotDeferred.resolve([gameCreatedEvent("game-abc", "REAL42")]);

    await waitFor(() => {
      expect(latestSeed()).toBe("REAL42");
    });
  });
});
