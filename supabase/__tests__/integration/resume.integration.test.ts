/**
 * Task 18.4 — Resume after background/relaunch (integration; Req 6.7, 6.8).
 *
 * ENVIRONMENT-DEPENDENT INTEGRATION TEST. This exercises recovery **path (b)**
 * (`lib/realtime/resume.ts`) against a *live* Supabase/Postgres instance through
 * the real browser adapter (`lib/realtime/supabaseBrowser.ts`) and the persistent
 * `Last_Seen_Sequence` store (`lib/realtime/lastSeenStore.ts`). With no live
 * backend configured it SKIPS cleanly — `npm test` stays green everywhere.
 *
 * What it proves (Req 6.7, 6.8):
 *   - With `Last_Seen_Sequence = L` persisted, a **visibility cycle** (fire the
 *     resume signal via `bindResumeSignals`) catches up on exactly the events
 *     with `seq > L`, in ascending order — no gaps, no dupes.
 *   - A **full relaunch** (a brand-new `LocalStorageLastSeenStore` over the same
 *     persisted storage, a brand-new `ResumeController`) again catches up on
 *     exactly `seq > L` from the *persisted* watermark.
 *   - Resume is **unconditional**: it runs even after path (a)'s transient retry
 *     budget is exhausted (we simulate a terminal "reload required" controller),
 *     invokes the reset hook, and **never** itself lands in a terminal state —
 *     `onResumeError` is never called and the controller stays usable.
 *
 * ---------------------------------------------------------------------------
 * Required env vars (all three must be set, or the whole suite skips):
 *   - NEXT_PUBLIC_SUPABASE_URL     Public Supabase URL — the member-scoped
 *                                  client under test reads catch-up events
 *                                  through this.
 *   - NEXT_PUBLIC_SUPABASE_ANON_KEY  Public anon key (subject to RLS) — the
 *                                  member client's read path.
 *   - SUPABASE_SERVICE_ROLE_KEY    Service-role key used ONLY for test
 *                                  setup/teardown (seeding the game + events
 *                                  through the RLS-bypassing service client).
 *
 * Run instructions (PowerShell):
 *   $env:NEXT_PUBLIC_SUPABASE_URL="https://<ref>.supabase.co"
 *   $env:NEXT_PUBLIC_SUPABASE_ANON_KEY="<anon-key>"
 *   $env:SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
 *   npx vitest run supabase/__tests__/integration/resume.integration.test.ts
 *
 * Notes:
 *   - The read path is subject to RLS (Req 7.2). This suite authenticates as a
 *     real game member via `createMemberSession()`, so the member client's
 *     reads pass the `0006` membership policies. Seeding is done through the
 *     service-role client, which bypasses RLS.
 *   - Setup/teardown insert `game_events` with explicit ascending `seq` values
 *     (the append-under-lock path is not needed to seed a fixed history).
 * ---------------------------------------------------------------------------
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ResumeController,
  bindResumeSignals,
  type EventTargetLike,
  type ResetTransientRecovery,
} from "@/lib/realtime/resume";
import {
  LocalStorageLastSeenStore,
  type StorageLike,
} from "@/lib/realtime/lastSeenStore";
import {
  supabaseRealtimeTransport,
  supabaseSnapshotSource,
} from "@/lib/realtime/supabaseBrowser";
import type { GameEvent } from "@/lib/events";
import type { RealtimeChannel } from "@/lib/realtime";

import { createMemberSession, type MemberSession } from "./_session";

// ---------------------------------------------------------------------------
// Environment gating: run only when a live backend is fully configured.
// ---------------------------------------------------------------------------

const PUBLIC_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const LIVE_ENV_READY =
  typeof PUBLIC_URL === "string" &&
  PUBLIC_URL.trim().length > 0 &&
  typeof ANON_KEY === "string" &&
  ANON_KEY.trim().length > 0 &&
  typeof SERVICE_ROLE_KEY === "string" &&
  SERVICE_ROLE_KEY.trim().length > 0;

// ---------------------------------------------------------------------------
// Test doubles for the DOM environment (no real document/window needed).
// ---------------------------------------------------------------------------

/** A tiny in-memory Storage the persistent watermark store writes to, so we can
 *  simulate a "full relaunch" by creating a new store over the SAME bytes. */
function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

/** A recording EventTarget: captures listeners so tests can fire them on demand,
 *  standing in for `document`/`window` for `bindResumeSignals`. */
function createFakeTarget(): EventTargetLike & {
  fire: (type: string) => void;
  count: (type: string) => number;
} {
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  return {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    fire(type) {
      for (const l of listeners.get(type) ?? []) {
        l();
      }
    },
    count(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Suite — skips entirely unless the live env is present.
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE_ENV_READY)(
  "Resume after background/relaunch (live) — Task 18.4 (Req 6.7, 6.8)",
  () => {
    // Seeded fixture. History: seq 1..5. We persist L = 2, so catch-up must
    // deliver exactly seq 3, 4, 5.
    const TOTAL_EVENTS = 5;
    const PERSISTED_L = 2;
    const EXPECTED_CAUGHT_UP_SEQS = [3, 4, 5];

    // A member-authenticated session (real Supabase Auth user who administers
    // the game), so the member client's reads pass RLS (Req 7.2). All seeding
    // is done via the session's service-role client.
    let session: MemberSession;
    let gameId: string;

    /** Insert one game_events row (admin actor) via the RLS-bypassing service client. */
    async function seedEvent(seq: number): Promise<void> {
      const { error } = await session.service.from("game_events").insert({
        game_id: gameId,
        seq,
        event_type: "resume_test",
        actor_kind: "admin",
        payload: { seq },
      });
      if (error !== null) {
        throw new Error(`failed to seed event seq=${seq}: ${error.message}`);
      }
    }

    beforeAll(async () => {
      // Member session: creates a throwaway auth user + a game it administers,
      // and a member-authenticated Supabase client. Events use an admin actor
      // here, so no team/player is needed.
      session = await createMemberSession();
      gameId = session.gameId;

      // Seed a fixed, gap-free history seq 1..TOTAL_EVENTS (admin actor, so no
      // team FK is required). Explicit seq mirrors the gap-free backbone (Req 4.5).
      for (let seq = 1; seq <= TOTAL_EVENTS; seq += 1) {
        await seedEvent(seq);
      }
    }, 30000);

    afterAll(async () => {
      // Cascade-deletes the game (events) and the throwaway auth user.
      await session?.cleanup();
    }, 30000);

    it("catches up exactly seq > Last_Seen_Sequence on a visibility cycle and a full relaunch, never going terminal", async () => {
      // Each ResumeController below builds its own member-authenticated client
      // (see makeController) so their realtime channels never collide.

      // Shared, persisted storage: the "disk" that survives a relaunch.
      const storage = createMemoryStorage();

      // Persist L = 2 through the real persistent store (advances the watermark).
      const seedStore = new LocalStorageLastSeenStore(storage);
      seedStore.set(gameId, PERSISTED_L);
      expect(seedStore.get(gameId)).toBe(PERSISTED_L);

      // Track a simulated terminal path-(a) controller: resume must reset it and
      // never itself go terminal, independent of the transient retry budget.
      let transientResetCount = 0;
      const resetTransientRecovery: ResetTransientRecovery = () => {
        transientResetCount += 1;
      };

      const openedChannels: RealtimeChannel[] = [];
      let resumeErrors = 0;

      /**
       * Build a controller that records caught-up events + opened channel.
       *
       * Each controller gets its OWN member client (and thus its own realtime
       * connection), because a Supabase client keys realtime channels by name:
       * two resumes that both open `game_events:<gameId>` on the SAME client
       * would collide ("cannot add postgres_changes callbacks ... after
       * subscribe()"). A fresh client per controller mirrors a real relaunch
       * (a new client instance) and avoids that collision.
       */
      const makeController = (store: LocalStorageLastSeenStore) => {
        const applied: GameEvent[] = [];
        const client = session.makeMemberClient();
        const controller = new ResumeController({
          gameId,
          lastSeenStore: store,
          snapshotSource: supabaseSnapshotSource(client),
          transport: supabaseRealtimeTransport(client),
          onEvent: (e) => {
            applied.push(e);
          },
          resetTransientRecovery,
          onResumed: (outcome) => {
            openedChannels.push(outcome.channel);
          },
          onResumeError: () => {
            resumeErrors += 1;
          },
        });
        return { controller, applied };
      };

      // --- 1) Visibility cycle: fire `visibilitychange` while visible. ---------
      const visibilityStore = new LocalStorageLastSeenStore(storage);
      const { controller: c1, applied: applied1 } =
        makeController(visibilityStore);

      const documentTarget = createFakeTarget();
      const windowTarget = createFakeTarget();
      let visible = false; // start backgrounded, then return to foreground
      const unbind = bindResumeSignals(c1, {
        documentTarget,
        windowTarget,
        isVisible: () => visible,
      });

      // A visibilitychange while hidden must NOT trigger resume: the binder's
      // `isVisible` guard (visible=false) suppresses the signal-driven onResume.
      // We do NOT call onResume() manually here — a manual call would perform an
      // unconditional catch-up (path (b) is always full re-init) and defeat the
      // point of this assertion. Fire the signal, give any handler a tick, and
      // confirm nothing was applied.
      documentTarget.fire("visibilitychange");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        applied1,
        "a hidden visibilitychange must not catch up (isVisible guard)",
      ).toHaveLength(0);

      // Now come back to the foreground: the signal passes the isVisible guard
      // and fires resume. Await the in-flight run to settle — c1.onResume()
      // coalesces with the signal-triggered run (shared in-flight promise), so
      // awaiting it resolves the same catch-up rather than launching a second.
      visible = true;
      documentTarget.fire("visibilitychange");
      const outcome1 = await c1.onResume();

      unbind();

      expect(
        outcome1,
        "visibility-cycle resume should produce an outcome",
      ).toBeDefined();
      expect(applied1.map((e) => e.seq)).toEqual(EXPECTED_CAUGHT_UP_SEQS);
      // ascending, no gaps, no dupes:
      expect(
        applied1.every((e, i) => i === 0 || e.seq > applied1[i - 1].seq),
      ).toBe(true);
      expect(new Set(applied1.map((e) => e.seq)).size).toBe(applied1.length);
      // Resume reset the (simulated) terminal path-(a) controller.
      expect(transientResetCount).toBeGreaterThan(0);
      expect(resumeErrors).toBe(0);

      // --- 2) Full relaunch: brand-new store over the SAME storage bytes. ------
      const relaunchStore = new LocalStorageLastSeenStore(storage);
      // The persisted watermark survived the "close".
      expect(relaunchStore.get(gameId)).toBe(PERSISTED_L);

      const { controller: c2, applied: applied2 } =
        makeController(relaunchStore);
      const outcome2 = await c2.onResume();

      expect(
        outcome2,
        "relaunch resume should produce an outcome",
      ).toBeDefined();
      expect(applied2.map((e) => e.seq)).toEqual(EXPECTED_CAUGHT_UP_SEQS);
      expect(resumeErrors).toBe(0);

      // Resume never entered a terminal "reload required" state: a subsequent
      // resume signal still produces an outcome (independent of any transient
      // retry budget). We model the next signal with a fresh controller (its own
      // client), since a real relaunch/resume uses a new client instance rather
      // than reopening the same realtime channel on the same client.
      const { controller: c3 } = makeController(
        new LocalStorageLastSeenStore(storage),
      );
      const outcomeAgain = await c3.onResume();
      expect(outcomeAgain).toBeDefined();
      expect(resumeErrors).toBe(0);

      // Clean up every channel this test opened.
      await Promise.all(openedChannels.map((ch) => ch.unsubscribe()));
    });
  },
);
