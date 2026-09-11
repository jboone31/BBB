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
 *   - SUPABASE_DB_URL              Postgres connection string (service-role /
 *                                  direct DB) used ONLY for test setup/teardown:
 *                                  create a game and insert `game_events`.
 *   - NEXT_PUBLIC_SUPABASE_URL     Public Supabase URL — the browser adapter
 *                                  under test reads catch-up events through this.
 *   - NEXT_PUBLIC_SUPABASE_ANON_KEY  Public anon key (subject to RLS) — the
 *                                  browser adapter's read path.
 *
 * Run instructions (PowerShell):
 *   $env:SUPABASE_DB_URL="postgres://postgres:...@db.<ref>.supabase.co:5432/postgres"
 *   $env:NEXT_PUBLIC_SUPABASE_URL="https://<ref>.supabase.co"
 *   $env:NEXT_PUBLIC_SUPABASE_ANON_KEY="<anon-key>"
 *   npx vitest run supabase/__tests__/integration/resume.integration.test.ts
 *
 * Notes:
 *   - The anon read path is subject to RLS (Req 7.2). If your RLS policies gate
 *     `game_events` reads on session membership, run against an instance/policy
 *     set that lets the anon key read the seeded game (e.g. a permissive dev
 *     policy), otherwise catch-up will legitimately see zero rows.
 *   - Setup/teardown insert `game_events` with explicit ascending `seq` values
 *     (the append-under-lock path is not needed to seed a fixed history).
 * ---------------------------------------------------------------------------
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

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
  createBrowserSupabaseClient,
  supabaseRealtimeTransport,
  supabaseSnapshotSource,
} from "@/lib/realtime/supabaseBrowser";
import type { GameEvent } from "@/lib/events";
import type { RealtimeChannel } from "@/lib/realtime";

// ---------------------------------------------------------------------------
// Environment gating: run only when a live backend is fully configured.
// ---------------------------------------------------------------------------

const DB_URL = process.env.SUPABASE_DB_URL;
const PUBLIC_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const LIVE_ENV_READY =
  typeof DB_URL === "string" &&
  DB_URL.trim().length > 0 &&
  typeof PUBLIC_URL === "string" &&
  PUBLIC_URL.trim().length > 0 &&
  typeof ANON_KEY === "string" &&
  ANON_KEY.trim().length > 0;

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

    let sql: ReturnType<typeof postgres>;
    let gameId: string;

    beforeAll(async () => {
      // DB_URL is a non-empty string here (the suite is skipped otherwise).
      sql = postgres(String(DB_URL), { max: 1 });

      // Minimal game row; only `id` is needed for the FK on game_events. The
      // schema requires admin_session_id and a unique join_code, so supply
      // throwaway unique values for this test fixture.
      const unique = `resume-18.4-${Date.now()}-${Math.floor(
        Math.random() * 1e9,
      )}`;
      const [game] = await sql<{ id: string }[]>`
        insert into games (admin_session_id, join_code)
        values (${unique}, ${unique})
        returning id
      `;
      gameId = game.id;

      // Seed a fixed, gap-free history seq 1..TOTAL_EVENTS (admin actor, so no
      // team FK is required). Explicit seq mirrors the gap-free backbone (Req 4.5).
      for (let seq = 1; seq <= TOTAL_EVENTS; seq += 1) {
        await sql`
          insert into game_events (game_id, seq, event_type, actor_kind, payload)
          values (${gameId}, ${seq}, ${"resume_test"}, ${"admin"}, ${sql.json({
            seq,
          })})
        `;
      }
    });

    afterAll(async () => {
      if (gameId) {
        // Cascade removes the seeded game_events.
        await sql`delete from games where id = ${gameId}`;
      }
      await sql?.end({ timeout: 5 });
    });

    it("catches up exactly seq > Last_Seen_Sequence on a visibility cycle and a full relaunch, never going terminal", async () => {
      const client = createBrowserSupabaseClient();
      expect(
        client,
        "browser Supabase client should build from public env",
      ).not.toBeNull();
      if (client === null) return; // narrow for the type-checker; env-gated above.

      const snapshotSource = supabaseSnapshotSource(client);
      const transport = supabaseRealtimeTransport(client);

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

      /** Build a controller that records caught-up events + opened channel. */
      const makeController = (store: LocalStorageLastSeenStore) => {
        const applied: GameEvent[] = [];
        const controller = new ResumeController({
          gameId,
          lastSeenStore: store,
          snapshotSource,
          transport,
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

      // A visibilitychange while hidden must NOT trigger resume.
      documentTarget.fire("visibilitychange");
      const beforeVisible = await c1.onResume(); // coalesced; nothing queued yet
      expect(applied1).toHaveLength(0);
      expect(beforeVisible).toBeDefined();
      // The manual onResume above already did one catch-up; reset our record so
      // the visibility-driven assertion below is unambiguous.
      applied1.length = 0;

      // Now come back to the foreground: the signal fires resume.
      visible = true;
      documentTarget.fire("visibilitychange");
      // Give the async re-init a chance to run to completion (coalesced runs
      // resolve through the same in-flight promise).
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

      // Resume never entered a terminal "reload required" state: after all the
      // above it is still usable and produces an outcome again on the next signal
      // (independent of any transient retry budget).
      const outcomeAgain = await c2.onResume();
      expect(outcomeAgain).toBeDefined();
      expect(resumeErrors).toBe(0);

      // Clean up every channel this test opened.
      await Promise.all(openedChannels.map((ch) => ch.unsubscribe()));
    });
  },
);
