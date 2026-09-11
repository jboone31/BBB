/**
 * Task 18.1 — End-to-end propagation latency (the F0.3 demonstration).
 *
 * This is an ENVIRONMENT-DEPENDENT integration test. It proves the core v0
 * problem is fixed: a persisted `Game_State_Change` reaches a *separate*
 * subscribed client within the 3-second Latency_Budget (Req 6.1, 6.2, 6.10).
 *
 * ---------------------------------------------------------------------------
 * What it does
 * ---------------------------------------------------------------------------
 *   1. Creates a real member-authenticated session via `createMemberSession()`
 *      (a throwaway Supabase Auth user administering a seeded game). The
 *      session's SERVICE-ROLE client seeds the fixture and, later, persists
 *      exactly one `game_events` row (the `Game_State_Change`), bypassing RLS.
 *   2. Opens TWO independently-subscribed subscriptions to the SAME game through
 *      the session's MEMBER-authenticated client so RLS (migration `0006`)
 *      permits realtime delivery — using the project's browser adapter
 *      (`lib/realtime/supabaseBrowser.ts`: `supabaseRealtimeTransport`,
 *      `supabaseSnapshotSource`) driven through `subscribe()` from
 *      `lib/realtime`. Both subscribers are the same member on the same game, so
 *      they share the one member client.
 *   3. Persists one event and asserts the SECOND client receives the
 *      corresponding `Game_State_Change` with commit-to-receive latency < 3000ms
 *      (Req 6.2), measured from the row's committed `created_at` to the instant
 *      the subscriber's `onEvent` fires.
 *
 * ---------------------------------------------------------------------------
 * Required environment (all must be set, or the whole suite SKIPS as a no-op)
 * ---------------------------------------------------------------------------
 *   - NEXT_PUBLIC_SUPABASE_URL        Supabase project URL (member client).
 *   - NEXT_PUBLIC_SUPABASE_ANON_KEY   Supabase anon key (member client, RLS).
 *   - SUPABASE_SERVICE_ROLE_KEY       Service-role key used to mint the test
 *                                     auth user, seed the fixture, and persist
 *                                     the event, bypassing RLS.
 *
 * The project's Postgres realtime must have `game_events` added to the
 * `supabase_realtime` publication for INSERTs to propagate (Supabase dashboard:
 * Database → Replication, or `alter publication supabase_realtime add table
 * game_events;`). The browser adapter subscribes via `postgres_changes` on
 * `game_events` filtered by `game_id`.
 *
 * ---------------------------------------------------------------------------
 * How to run
 * ---------------------------------------------------------------------------
 *   # From the project root, with the three env vars exported (e.g. a .env you
 *   # source, or inline):
 *   NEXT_PUBLIC_SUPABASE_URL=... \
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   npm test -- supabase/__tests__/integration/propagationLatency.integration.test.ts
 *
 * With no env configured (local dev / CI without secrets), the `describe.skipIf`
 * guard below makes this file a clean no-op so `npm test` still passes. It never
 * runs against a live DB unless explicitly wired.
 *
 * Validates: Requirements 6.1, 6.2, 6.10
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GameEvent } from "@/lib/events";
import { subscribe, type RealtimeSubscription } from "@/lib/realtime";
import {
  supabaseRealtimeTransport,
  supabaseSnapshotSource,
} from "@/lib/realtime/supabaseBrowser";

import { createMemberSession, type MemberSession } from "./_session";

/** The Latency_Budget from Req 6.2 / the glossary: 3 seconds. */
const LATENCY_BUDGET_MS = 3000;

/**
 * Whether the live Supabase environment is fully configured. When false, the
 * whole suite skips (no-op) so `npm test` passes without secrets.
 */
const LIVE_ENV_CONFIGURED =
  isNonEmpty(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  isNonEmpty(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) &&
  isNonEmpty(process.env.SUPABASE_SERVICE_ROLE_KEY);

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Wait up to `timeoutMs` for `predicate` to become true, polling every 25ms.
 * Used to bound the whole subscribe/deliver flow so a misconfigured project
 * fails fast rather than hanging the suite.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

// The whole suite is a no-op unless a real Supabase project is wired.
describe.skipIf(!LIVE_ENV_CONFIGURED)(
  "F0.3 end-to-end propagation latency (live Supabase)",
  () => {
    // A member-authenticated session (real Supabase Auth user who administers
    // the game), so both subscriptions pass RLS (migration 0006 / Req 7.2). The
    // session's service-role client seeds the fixture and persists the event,
    // bypassing RLS.
    let session: MemberSession;
    // Two independently-subscribed subscriptions to the SAME game. Both are the
    // same member on the same game, so they share the one member client — the
    // real app path via the project's browser adapter.
    let subA: RealtimeSubscription | null = null;
    let subB: RealtimeSubscription | null = null;

    let gameId = "";

    beforeAll(async () => {
      // Member session: creates a throwaway auth user + a game it administers,
      // and a member-authenticated Supabase client whose reads/subscriptions
      // pass RLS. The event uses an admin actor, so no team/player is needed.
      session = await createMemberSession();
      gameId = session.gameId;
    }, 30000);

    afterAll(async () => {
      // Tear down subscriptions first, then let the session clean up the game
      // (cascade removes events) and the throwaway auth user.
      await subA?.close().catch(() => undefined);
      await subB?.close().catch(() => undefined);
      await session?.cleanup();
    }, 30000);

    it(
      "delivers a persisted Game_State_Change to a separate subscribed client within 3s",
      async () => {
        // Both subscriptions run as the authenticated member so RLS (migration
        // 0006) permits realtime delivery. Each Supabase client keys realtime
        // channels by name, so two subscriptions to the SAME game must use two
        // DISTINCT clients (sharing one throws "cannot add postgres_changes
        // callbacks ... after subscribe()"). Client A reuses session.memberClient;
        // client B is a second member client carrying the same token.
        const clientA = session.memberClient;
        const clientB = session.makeMemberClient();

        const transportA = supabaseRealtimeTransport(clientA);
        const snapshotSourceA = supabaseSnapshotSource(clientA);
        const transportB = supabaseRealtimeTransport(clientB);
        const snapshotSourceB = supabaseSnapshotSource(clientB);

        // Both clients capture the first live event and the wall-clock instant
        // it was received, so we can measure commit-to-receive latency (Req 6.2).
        const receivedByB: { event: GameEvent | null; at: number } = {
          event: null,
          at: 0,
        };
        const receivedByA: { event: GameEvent | null; at: number } = {
          event: null,
          at: 0,
        };

        // Client A (the "playing" client) and Client B (the "separate" client
        // Req 6.10 requires the change to appear on). Both subscribe to the same
        // game via the real adapter path.
        subA = await subscribe(gameId, {
          transport: transportA,
          snapshotSource: snapshotSourceA,
          handlers: {
            onEvent: (event) => {
              if (receivedByA.event === null) {
                receivedByA.event = event;
                receivedByA.at = Date.now();
              }
            },
          },
        });
        subB = await subscribe(gameId, {
          transport: transportB,
          snapshotSource: snapshotSourceB,
          handlers: {
            onEvent: (event) => {
              if (receivedByB.event === null) {
                receivedByB.event = event;
                receivedByB.at = Date.now();
              }
            },
          },
        });

        // Give the Postgres-changes channels a moment to finish subscribing so
        // the INSERT below is observed live (not just via snapshot). Bounded and
        // short; the real latency assertion is measured from commit, not here.
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Persist EXACTLY ONE Game_State_Change via the service role. Returning
        // `created_at` gives us the committed timestamp to measure latency from
        // (Req 6.2: "from the time the Game_Event is committed ... to the time
        // the client receives it"). seq=1 is the first event for this fresh game.
        const { data: inserted, error: insertError } = await session.service
          .from("game_events")
          .insert({
            game_id: gameId,
            seq: 1,
            event_type: "demo_state_change",
            actor_kind: "admin",
            actor_team_id: null,
            payload: { note: "F0.3 propagation demo" },
          })
          .select("id, seq, created_at")
          .single();

        if (insertError !== null) {
          throw new Error(
            `failed to persist Game_State_Change: ${insertError.message}`,
          );
        }
        const committedAtMs = Date.parse(
          String((inserted as { created_at: string }).created_at),
        );
        const expectedSeq = Number((inserted as { seq: number }).seq);

        // Wait (bounded) for the separate client B to receive the event.
        const gotIt = await waitFor(
          () => receivedByB.event !== null,
          LATENCY_BUDGET_MS + 2000,
        );
        expect(gotIt).toBe(true);

        const eventB = receivedByB.event as GameEvent;
        // It must be the corresponding change: same game, the event we wrote.
        expect(eventB.gameId).toBe(gameId);
        expect(eventB.seq).toBe(expectedSeq);
        expect(eventB.eventType).toBe("demo_state_change");

        // Commit-to-receive latency < 3s (Req 6.2). Measured from the row's
        // committed created_at to the instant B's onEvent fired.
        const latencyMs = receivedByB.at - committedAtMs;
        expect(latencyMs).toBeLessThan(LATENCY_BUDGET_MS);

        // Sanity: the playing client also saw it (both subscribers converge).
        const bothSaw = await waitFor(
          () => receivedByA.event !== null,
          LATENCY_BUDGET_MS,
        );
        expect(bothSaw).toBe(true);
      },
      // Per-test timeout comfortably above the budget + subscribe/insert setup.
      LATENCY_BUDGET_MS + 15000,
    );
  },
);
