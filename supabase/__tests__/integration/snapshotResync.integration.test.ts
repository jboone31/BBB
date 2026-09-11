/**
 * Task 18.3 — Snapshot-on-subscribe and reconnect resync (integration).
 *
 * This is an ENVIRONMENT-DEPENDENT integration test that exercises the realtime
 * client (`lib/realtime`) against a **live** Supabase/Postgres instance. It
 * proves two design guarantees end-to-end, on the wire:
 *
 *   - **Req 6.4 — snapshot on subscribe.** When a client subscribes to a game it
 *     receives a snapshot that reflects *all* Game_Events persisted for that game
 *     before the subscription, within the 3-second Latency_Budget.
 *   - **Req 6.5 — reconnect resync.** When the connection is lost while the app
 *     is open, the client reconnects, catches up on events missed while
 *     disconnected, and re-requests a fresh snapshot.
 *
 * It does this by:
 *   1. Seeding a game (with a start bar and a team) and several prior
 *      `game_events` directly via Postgres (the `postgres` driver over
 *      `SUPABASE_DB_URL`).
 *   2. Subscribing through the browser Supabase adapter
 *      (`lib/realtime/supabaseBrowser.ts`) + `subscribe()` and asserting the
 *      returned snapshot folds in exactly the prior events, within 3s (Req 6.4).
 *   3. Persisting one more event, appending it to the live channel, then
 *      **force-dropping** the connection (closing/removing the channel) and
 *      driving the reconnect controller (`lib/realtime/reconnect.ts`) to confirm
 *      it resubscribes, catches up on the event missed while disconnected, and
 *      loads a fresh snapshot that reflects all events (Req 6.5).
 *
 * ---------------------------------------------------------------------------
 * REQUIRED ENVIRONMENT
 * ---------------------------------------------------------------------------
 * This test SKIPS cleanly (never fails) unless ALL of the following are set to
 * point at a live Supabase project with migrations 0001–0007 applied:
 *
 *   - SUPABASE_DB_URL             direct Postgres connection string used to seed
 *                                 the game and its events (e.g.
 *                                 postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres)
 *   - NEXT_PUBLIC_SUPABASE_URL    the project URL (https://<ref>.supabase.co)
 *   - NEXT_PUBLIC_SUPABASE_ANON_KEY  the anon (public) API key
 *
 * The live project must also have Realtime enabled for the `game_events` table
 * (`postgres_changes` INSERTs), and RLS configured so the anon key can read the
 * seeded game's events (or the seeded rows must be readable under the project's
 * RLS policy). Without live env the whole suite is skipped, so `npm test` still
 * passes with no backend configured.
 *
 * ---------------------------------------------------------------------------
 * HOW TO RUN
 * ---------------------------------------------------------------------------
 *   # from the project root, with a live Supabase project:
 *   SUPABASE_DB_URL=postgres://... \
 *   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key> \
 *   npx vitest run supabase/__tests__/integration/snapshotResync.integration.test.ts
 *
 * On Windows PowerShell:
 *   $env:SUPABASE_DB_URL="postgres://..."; \
 *   $env:NEXT_PUBLIC_SUPABASE_URL="https://<ref>.supabase.co"; \
 *   $env:NEXT_PUBLIC_SUPABASE_ANON_KEY="<anon-key>"; \
 *   npx vitest run supabase/__tests__/integration/snapshotResync.integration.test.ts
 *
 * The test seeds a fresh, uniquely-named game per run and cleans it up in
 * afterAll (cascade delete), so it is safe to run repeatedly against the same
 * project.
 *
 * Validates: Requirements 6.4, 6.5.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  subscribe,
  InMemoryLastSeenStore,
  type RealtimeSubscription,
} from "@/lib/realtime";
import {
  ReconnectController,
  ReconnectPhase,
  makeReconnectAttempt,
} from "@/lib/realtime/reconnect";
import {
  supabaseRealtimeTransport,
  supabaseSnapshotSource,
} from "@/lib/realtime/supabaseBrowser";
import type { GameStateSnapshot } from "@/lib/realtime/snapshot";
import type { GameEvent } from "@/lib/events";

import { createMemberSession, type MemberSession } from "./_session";

/* -------------------------------------------------------------------------- *
 * Env gating — skip cleanly when no live instance is configured
 * -------------------------------------------------------------------------- */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const LIVE_ENV_CONFIGURED = Boolean(
  SUPABASE_URL && SUPABASE_ANON_KEY && SERVICE_ROLE_KEY,
);

/** The 3-second Latency_Budget from Req 6.4. */
const LATENCY_BUDGET_MS = 3000;

/** How long to wait for a live realtime event before giving up. */
const EVENT_WAIT_MS = 5000;

/* -------------------------------------------------------------------------- *
 * Small test helpers
 * -------------------------------------------------------------------------- */

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `predicate` until it is true or `timeoutMs` elapses. Returns whether the
 * predicate became true within the budget (never throws on timeout so callers
 * can assert on the boolean and get a clear message).
 */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(pollMs);
  }
  return predicate();
}

describe.skipIf(!LIVE_ENV_CONFIGURED)(
  "snapshot-on-subscribe and reconnect resync (live Supabase) — Req 6.4, 6.5",
  () => {
    // A member-authenticated session (real Supabase Auth user who administers
    // the game), so the anon/member client's reads + subscriptions pass RLS
    // (Req 7.2). All seeding is done via the session's service-role client.
    let session: MemberSession;
    let client: SupabaseClient;

    let gameId: string;
    let teamId: string;

    // The seq values seeded before the subscription (Req 6.4 "prior events").
    const priorSeqs = [1, 2, 3];

    /** Insert one game_events row (team actor) via the RLS-bypassing service client. */
    async function seedEvent(seq: number): Promise<void> {
      const { error } = await session.service.from("game_events").insert({
        game_id: gameId,
        seq,
        event_type: "demo_event",
        actor_kind: "team",
        actor_team_id: teamId,
        payload: { seq },
      });
      if (error !== null) {
        throw new Error(`failed to seed event seq=${seq}: ${error.message}`);
      }
    }

    beforeAll(async () => {
      // Member session: creates a throwaway auth user + a game it administers,
      // and a member-authenticated Supabase client. withPlayer also creates a
      // team we can use as the event actor.
      session = await createMemberSession({ withPlayer: true });
      client = session.memberClient;
      gameId = session.gameId;

      // Fetch the team id created by the session (for the team actor on events).
      const { data: team, error: teamErr } = await session.service
        .from("teams")
        .select("id")
        .eq("game_id", gameId)
        .limit(1)
        .single();
      if (teamErr !== null || !team) {
        throw new Error(
          `failed to read seeded team: ${teamErr?.message ?? "no row"}`,
        );
      }
      teamId = String((team as { id: string }).id);

      // Seed the PRIOR events (Req 6.4): the snapshot must reflect exactly these.
      for (const seq of priorSeqs) {
        await seedEvent(seq);
      }
    }, 30000);

    afterAll(async () => {
      if (client) {
        await client.removeAllChannels();
      }
      // Cascade-deletes the game (bars/teams/players/events) and the auth user.
      await session?.cleanup();
    }, 30000);

    it("delivers a snapshot reflecting all prior events within 3s on subscribe (Req 6.4)", async () => {
      const transport = supabaseRealtimeTransport(client);
      const snapshotSource = supabaseSnapshotSource(client);

      const start = Date.now();
      let subscription: RealtimeSubscription | undefined;
      try {
        subscription = await subscribe(gameId, { transport, snapshotSource });
        const elapsed = Date.now() - start;

        // Req 6.4: snapshot within the 3s Latency_Budget.
        expect(elapsed).toBeLessThan(LATENCY_BUDGET_MS);

        const snapshot = subscription.snapshot;
        // The snapshot is the fold of all prior events with seq <= N.
        expect(snapshot.gameId).toBe(gameId);
        expect(snapshot.appliedSeqs).toEqual(priorSeqs);
        expect(snapshot.lastSeenSequence).toBe(Math.max(...priorSeqs));
        expect(snapshot.eventCount).toBe(priorSeqs.length);
      } finally {
        await subscription?.close();
      }
    }, 15000);

    it("reconnect + resync deliver a fresh snapshot after a forced connection drop (Req 6.5)", async () => {
      // Use a dedicated member client for the initial subscription: a Supabase
      // client keys realtime channels by name, and the first test in this file
      // already opened+closed `game_events:<gameId>` on session.memberClient, so
      // reusing it here races that channel's teardown and can drop live events.
      const subClient = session.makeMemberClient();
      const transport = supabaseRealtimeTransport(subClient);
      const snapshotSource = supabaseSnapshotSource(subClient);
      const lastSeenStore = new InMemoryLastSeenStore();

      // Track events applied by the live subscription (ascending seq, deduped).
      const appliedSeqs: number[] = [];

      const subscription = await subscribe(gameId, {
        transport,
        snapshotSource,
        lastSeenStore,
        handlers: {
          onEvent: (event) => appliedSeqs.push(event.seq),
        },
      });

      try {
        // Sanity: watermark seeded from the snapshot of prior events.
        expect(subscription.lastSeenSequence()).toBe(Math.max(...priorSeqs));

        // Give the realtime channel a moment to finish JOINING before we write,
        // so the INSERT below is observed live. `subscribe()` resolves once the
        // snapshot has loaded, but the underlying postgres_changes channel joins
        // asynchronously; writing too early races that join and the event is
        // missed. channelIsolation uses the same settle window.
        await delay(1_500);

        // 1. Persist a NEW event while subscribed and confirm live delivery
        //    (proves the live channel is actually flowing before we drop it).
        const liveSeq = Math.max(...priorSeqs) + 1;
        await seedEvent(liveSeq);

        const gotLive = await waitUntil(
          () => subscription.lastSeenSequence() >= liveSeq,
          EVENT_WAIT_MS,
        );
        expect(gotLive, "live event should arrive over the channel").toBe(true);
        expect(subscription.lastSeenSequence()).toBe(liveSeq);

        // 2. FORCE-DROP the connection: tear down the live channel so the
        //    subscription stops receiving events (simulates a lost connection
        //    while the app is open — Req 6.5 path (a)).
        await subscription.close();

        // 3. Persist an event that is MISSED while disconnected.
        const missedSeq = liveSeq + 1;
        await seedEvent(missedSeq);

        // 4. Drive the reconnect controller: it fetches events after
        //    Last_Seen_Sequence, resubscribes, and re-requests a snapshot.
        const caughtUpSeqs: number[] = [];
        let reconnectedSnapshot: GameStateSnapshot | undefined;

        // The reconnect resubscribes on a FRESH member client — a real reconnect
        // opens a new connection, and it avoids reopening the just-closed channel
        // name on the original client (which races the removeChannel teardown).
        const reconnectClient = session.makeMemberClient();
        const attempt = makeReconnectAttempt({
          gameId,
          transport: supabaseRealtimeTransport(reconnectClient),
          snapshotSource: supabaseSnapshotSource(reconnectClient),
          onEvent: (event: GameEvent) => caughtUpSeqs.push(event.seq),
        });

        const controller = new ReconnectController({
          gameId,
          attempt,
          lastSeenStore,
          onReconnected: (outcome) => {
            reconnectedSnapshot = outcome.snapshot;
          },
        });

        controller.connectionLost();

        const recovered = await waitUntil(
          () => controller.phase === ReconnectPhase.Connected,
          EVENT_WAIT_MS + LATENCY_BUDGET_MS,
        );
        expect(recovered, "controller should return to Connected").toBe(true);

        // Resync caught up on exactly the event missed while disconnected.
        expect(caughtUpSeqs).toContain(missedSeq);

        // A fresh snapshot was delivered on reconnect, reflecting ALL events
        // persisted so far (prior + live + missed), within the latency budget
        // (Req 6.4 re-applied on reconnect / Req 6.5 resync).
        expect(reconnectedSnapshot).toBeDefined();
        expect(reconnectedSnapshot?.gameId).toBe(gameId);
        expect(reconnectedSnapshot?.lastSeenSequence).toBe(missedSeq);
        expect(reconnectedSnapshot?.appliedSeqs).toEqual([
          ...priorSeqs,
          liveSeq,
          missedSeq,
        ]);

        controller.stop();
      } finally {
        await subscription.close();
      }
    }, 30000);
  },
);
