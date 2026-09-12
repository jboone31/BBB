// @vitest-environment jsdom
//
// Property test for the SUBMITTED Join_Code normalization parity of the lobby
// page's create→join orchestration (Task 7.3; design.md §"Correctness
// Properties" Property 4; Requirements 6.2).
//
// Property 4 (design): "For any raw submitted Join_Code string, the
// Lobby_Client issues a join request ONLY WHEN isValidSubmittedCode(code) holds,
// and the code carried in that request equals normalizeSubmittedCode(code)."
//
// WHERE WE OBSERVE THE PROPERTY:
//   The cleanest, most robust place the Lobby_Client applies this parity is the
//   create→join path in `handleCreate` (app/games/[gameId]/lobby/page.tsx):
//
//       if (isValidSubmittedCode(joinCode)) {
//         const joined = await postJson(`/api/games/${newGameId}/join`, {
//           joinCode: normalizeSubmittedCode(joinCode),
//           displayName: submission.displayName,
//         });
//         ...
//       }
//       router.push(...)
//
//   The `joinCode` here is whatever `POST /api/games` returned. So by driving
//   the mocked `/api/games` response's `joinCode` with an arbitrary raw string
//   and rendering the create page (`useParams -> { gameId: 'new' }`), we observe
//   the OBSERVABLE parity through the page's own behavior:
//     - a `POST .../join` is issued IFF isValidSubmittedCode(rawCode), and
//     - when issued, the join body's `joinCode` === normalizeSubmittedCode(rawCode).
//
//   Note the guard runs `isValidSubmittedCode` / `normalizeSubmittedCode` on the
//   RAW returned code (they normalize internally), so the oracle here applies
//   those same pure functions to the same raw code — no reimplementation.
//
// SCOPING — DOM env + mocked seams (mirrors page.prefill.test.tsx):
//   The project's Vitest harness defaults to the `node` environment (see
//   vitest.config.mts). This file opts into `jsdom` for THIS FILE ONLY via the
//   `@vitest-environment jsdom` docblock on line 1. The global config is
//   untouched.
//
//   In create mode the page renders `CreateGame` and never opens a realtime
//   connection (the realtime effect early-returns for `isCreateMode`). We still
//   mock the realtime seams defensively so nothing touches live Supabase, and we
//   mock `next/navigation` so `useParams` yields the `new` create route and
//   `useRouter().push` is inert. `global.fetch` is spied to answer the three
//   POSTs `handleCreate` issues in sequence (create → bars → join).

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  isValidSubmittedCode,
  normalizeSubmittedCode,
} from "@/lib/lobby/joinCode";
import { establishBrowserSession } from "@/lib/session/supabaseSession";

// --- next/navigation: create-mode route param + inert router ---------------
//
// `useParams -> { gameId: 'new' }` puts the page in create mode so it renders
// CreateGame and runs `handleCreate` on submit. `useRouter().push` is inert (we
// do not assert navigation here). `useSearchParams` returns an empty set.

vi.mock("next/navigation", () => ({
  useParams: () => ({ gameId: "new" }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

// --- Realtime seams: create mode never subscribes, but the session bootstrap
// still runs when configured. Report configured with a NON-null client so the
// async session bootstrap resolves and sets `sessionId` — POSTs are gated on it,
// so the create→bars→join chain only fires once the session is known. The
// realtime subscription itself still short-circuits in create mode.
vi.mock("@/lib/realtime/supabaseBrowser", () => ({
  isSupabaseConfigured: () => true,
  createBrowserSupabaseClient: () => ({}) as unknown,
  supabaseRealtimeTransport: () => ({
    channel: () => ({ unsubscribe: async () => {} }),
  }),
  supabaseSnapshotSource: () => ({
    fetchEventsAscending: async () => [],
  }),
}));

vi.mock("@/lib/realtime", () => ({
  subscribe: async () => ({
    snapshot: { lastSeenSequence: 0 },
    close: async () => {},
  }),
}));

// Mock the Supabase-auth session bridge so the async identity bootstrap resolves
// a fixed session id; until it does, `postJson` refuses to fire, so the create
// form's create→bars→join chain depends on this resolving first.
vi.mock("@/lib/session/supabaseSession", () => ({
  establishBrowserSession: vi.fn(async () => ({
    sessionId: "sess-create",
    accessToken: "test-token",
  })),
  bindRealtimeAuth: vi.fn(() => () => {}),
}));

import LobbyPage from "./page";

/** Records of every POST fetch the page issued during one iteration. */
interface RecordedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

let requests: RecordedRequest[] = [];

/**
 * Install a `global.fetch` spy that answers `handleCreate`'s three sequential
 * POSTs. The `/api/games` create response carries the generated raw `joinCode`
 * under test.
 */
function installFetch(rawJoinCode: string): void {
  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      let body: Record<string, unknown> = {};
      if (init?.body != null) {
        try {
          body = JSON.parse(String(init.body)) as Record<string, unknown>;
        } catch {
          body = {};
        }
      }
      requests.push({ url, body });

      const json = ((): unknown => {
        // Order matters: `/join` and `/bars` are suffixes of longer paths.
        if (url.endsWith("/join")) {
          return { applied: true, seq: 2, playerId: "p1", created: true };
        }
        if (url.endsWith("/bars")) {
          return { applied: true };
        }
        // The create endpoint (`/api/games`).
        return {
          applied: true,
          seq: 1,
          gameId: "g1",
          joinCode: rawJoinCode,
        };
      })();

      return {
        ok: true,
        status: 200,
        json: async () => json,
      } as unknown as Response;
    },
  );
  vi.stubGlobal("fetch", fetchImpl);
}

/** The single join request issued this iteration, if any (URL ends `/join`). */
function joinRequest(): RecordedRequest | undefined {
  return requests.find((r) => r.url.endsWith("/join"));
}

beforeEach(() => {
  requests = [];
  try {
    globalThis.localStorage?.clear();
  } catch {
    // best-effort, mirrors the store under test
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Render the create page, fill the CreateGame form with a valid start/finish/
 * displayName, submit, and wait for the create→bars→join fetch chain to settle.
 */
async function submitCreateForm(): Promise<void> {
  // Defensively unmount any prior iteration's tree so queries below resolve
  // against a single render (fast-check reruns this within one test).
  cleanup();
  // The bootstrap mock accumulates calls across iterations, so gate on THIS
  // render's fresh call by capturing the count before mounting.
  const callsBefore = vi.mocked(establishBrowserSession).mock.calls.length;
  render(<LobbyPage />);

  const start = screen.getByRole("textbox", { name: /start bar/i });
  const finish = screen.getByRole("textbox", { name: /finish bar/i });
  const name = screen.getByRole("textbox", { name: /display name/i });

  fireEvent.change(start, { target: { value: "Ladybird Grove" } });
  fireEvent.change(finish, { target: { value: "New Realm Brewing" } });
  fireEvent.change(name, { target: { value: "Host" } });

  // Identity is established asynchronously now: the page gates POSTs on the
  // resolved session id, so wait for THIS render's bootstrap to settle before
  // submitting or the create→bars→join chain no-ops as `session_not_ready`.
  await waitFor(() => {
    expect(
      vi.mocked(establishBrowserSession).mock.calls.length,
    ).toBeGreaterThan(callsBefore);
  });

  fireEvent.click(screen.getByRole("button", { name: /create game/i }));

  // create (+ bars) always fire; wait until the create POST is recorded, then
  // let the async chain settle so any conditional /join has been issued.
  await waitFor(() => {
    expect(requests.some((r) => r.url.endsWith("/api/games"))).toBe(true);
    // bars always follows a successful create in this harness.
    expect(requests.some((r) => r.url.endsWith("/bars"))).toBe(true);
  });
  // Give the microtask chain (bars -> conditional join -> push) a beat to run.
  await Promise.resolve();
  await Promise.resolve();
}

describe("Lobby create→join orchestration (Requirements 6.2)", () => {
  it("Feature: lobby-host-player-and-sharing, Property 4: Submitted Join_Code normalization parity", async () => {
    // Generators cover the full submitted-code input space: fully arbitrary
    // strings (lowercase, whitespace, punctuation, empty, too-short/too-long)
    // AND a biased slice of well-formed 6–12 alphanumeric codes so valid cases
    // are hit frequently, not just by luck.
    const validCode = fc.string({
      unit: fc.constantFrom(
        ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split(
          "",
        ),
      ),
      minLength: 6,
      maxLength: 12,
    });
    const rawCode = fc.oneof(
      { weight: 3, arbitrary: fc.string() },
      { weight: 2, arbitrary: validCode },
      // valid code wrapped in whitespace / lowercased to exercise normalization
      {
        weight: 2,
        arbitrary: validCode.map((c) => `  ${c.toLowerCase()}  `),
      },
    );

    await fc.assert(
      fc.asyncProperty(rawCode, async (code) => {
        // Fresh state per run: reset recorded requests, storage, fetch, and DOM.
        requests = [];
        try {
          globalThis.localStorage?.clear();
        } catch {
          // best-effort
        }
        installFetch(code);

        await submitCreateForm();

        const oracleValid = isValidSubmittedCode(code);
        const join = joinRequest();

        // (1) A join is issued IFF the raw code is a valid submitted code.
        expect(join !== undefined).toBe(oracleValid);

        // (2) When issued, the carried code equals the normalized raw code.
        if (join !== undefined) {
          expect(join.body.joinCode).toBe(normalizeSubmittedCode(code));
        }

        // Tear down this iteration so the next render starts clean.
        cleanup();
        vi.unstubAllGlobals();
      }),
      { numRuns: 50 },
    );
  }, 30000);
});
