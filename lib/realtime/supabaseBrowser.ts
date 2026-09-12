/**
 * Browser Supabase adapter for the realtime subscription client (design.md
 * Component 5 + Component 7; Task 16.2).
 *
 * `lib/realtime/index.ts` is deliberately transport-agnostic: it depends only on
 * the minimal {@link RealtimeTransport} and {@link SnapshotSource} seams so it
 * typechecks and unit-tests without any live connection. This file is the
 * concrete **browser** wiring of those seams over `@supabase/supabase-js`
 * (pinned at `2.116.0` in `package.json`), used by the F0.3 propagation demo.
 *
 * It provides:
 *
 *   - {@link createBrowserSupabaseClient} — a lazily-created singleton
 *     Supabase JS client built from the **public** env (`NEXT_PUBLIC_SUPABASE_URL`
 *     / `NEXT_PUBLIC_SUPABASE_ANON_KEY`). The anon key is always subject to RLS
 *     (Req 7.2), so the browser only ever reads what its game membership allows.
 *   - {@link supabaseRealtimeTransport} — a {@link RealtimeTransport} backed by a
 *     Supabase `postgres_changes` subscription on `game_events`, **filtered to
 *     `game_id`** so only that game's events arrive (Req 6.1, 6.3).
 *   - {@link supabaseSnapshotSource} — a {@link SnapshotSource} that reads a
 *     game's `game_events` ordered by `seq` ascending through the same client
 *     (Req 6.4), so `subscribe()` can load the initial snapshot in-browser.
 *
 * **Resilience without live env.** The demo must build and render even when no
 * Supabase env is configured (so `npm run build` succeeds without secrets). This
 * module never throws at import time and never crashes the render: env reading is
 * behind {@link readPublicSupabaseEnv}, which returns `null` when unset, and the
 * demo view checks {@link isSupabaseConfigured} to render a disabled placeholder
 * instead of constructing a client.
 *
 * Requirements: 6.1, 6.3, 6.4, 7.2.
 */

import {
  createClient,
  type SupabaseClient,
  type RealtimeChannel as SupabaseRealtimeChannel,
} from "@supabase/supabase-js";

import { type GameEvent } from "@/lib/events";
import type { RealtimeChannel, RealtimeTransport } from "@/lib/realtime";
import { type SnapshotSource } from "@/lib/realtime/snapshot";

/** The `game_events` table the realtime channel and snapshot read from. */
const GAME_EVENTS_TABLE = "game_events";

/**
 * The public Supabase configuration the browser needs. Only `NEXT_PUBLIC_*`
 * values appear here; the service-role key is server-only and never read in the
 * browser (Req 7.3).
 */
export interface PublicSupabaseEnv {
  readonly url: string;
  readonly anonKey: string;
}

/**
 * Read the public Supabase env from the browser bundle, or `null` if either
 * value is missing/blank.
 *
 * `NEXT_PUBLIC_*` variables are statically inlined by Next.js at build time, so
 * they are referenced by literal name (not dynamic indexing) to be picked up.
 * Returning `null` rather than throwing is what lets the demo build and render a
 * disabled state when env is not configured.
 */
export function readPublicSupabaseEnv(): PublicSupabaseEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (
    typeof url !== "string" ||
    url.trim().length === 0 ||
    typeof anonKey !== "string" ||
    anonKey.trim().length === 0
  ) {
    return null;
  }
  return { url: url.trim(), anonKey: anonKey.trim() };
}

/** Whether the public Supabase env is present (so a live client can be built). */
export function isSupabaseConfigured(): boolean {
  return readPublicSupabaseEnv() !== null;
}

/** Lazily-created singleton so the demo shares one client/connection. */
let cachedClient: SupabaseClient | null = null;

/**
 * Create (or return the cached) browser Supabase client from the public env.
 *
 * @returns the shared {@link SupabaseClient}, or `null` when env is not
 *   configured (so callers can render a disabled state instead of crashing).
 */
export function createBrowserSupabaseClient(): SupabaseClient | null {
  if (cachedClient !== null) {
    return cachedClient;
  }
  const env = readPublicSupabaseEnv();
  if (env === null) {
    return null;
  }
  cachedClient = createClient(env.url, env.anonKey, {
    auth: {
      // BBB identity is bridged into Supabase Anonymous Auth (see
      // lib/session/supabaseSession.ts): the browser signs in anonymously and
      // the resulting UID is the BBB session id AND the JWT `sub` that RLS
      // matches. Persist + auto-refresh the session so that anonymous identity
      // survives reload (matching the old localStorage durability) and the
      // access token stays valid; the persisted session also authorizes
      // RLS-scoped PostgREST reads automatically. The realtime socket is
      // authorized separately via `realtime.setAuth` (see bindRealtimeAuth).
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return cachedClient;
}

/**
 * The raw shape of a `game_events` row as delivered by Supabase (snake_case
 * columns matching `supabase/migrations/0003_game_events.sql`).
 */
interface GameEventRow {
  readonly id: string;
  readonly game_id: string;
  readonly seq: number | string;
  readonly event_type: string;
  readonly actor_kind: string;
  readonly actor_team_id: string | null;
  readonly payload: unknown;
  readonly created_at: string;
}

/**
 * Normalize a `game_events.payload` value into the parsed object the lobby fold
 * expects.
 *
 * The column is `jsonb`. Depending on the client/transport, PostgREST can hand
 * it back either already parsed (an object) OR as a raw JSON string — and the
 * browser observably receives a **string** here (e.g. `'{"joinCode":"ABC"}'`).
 * The pure lobby reducer (`lib/lobby/events.ts`) reads payload fields only when
 * `typeof payload === "object"`, so an unparsed string silently yields no
 * `joinCode`/`startBarId`/etc. and the folded view comes back empty. Parse a
 * string payload here (mirroring the server-side `parsePayload` in
 * `lib/events/index.ts`) so both the snapshot read and the realtime
 * `postgres_changes` path deliver a parsed object. A non-string (already parsed)
 * value passes through unchanged; an unparseable string is returned as-is.
 */
function parsePayload(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** Map a raw `game_events` row to the domain {@link GameEvent} the client uses. */
function rowToGameEvent(row: GameEventRow): GameEvent {
  return {
    id: String(row.id),
    gameId: String(row.game_id),
    seq: Number(row.seq),
    eventType: String(row.event_type),
    actorKind: row.actor_kind as GameEvent["actorKind"],
    actorTeamId: row.actor_team_id == null ? null : String(row.actor_team_id),
    payload: parsePayload(row.payload),
    createdAt: String(row.created_at),
  };
}

/**
 * A {@link RealtimeTransport} backed by a Supabase `postgres_changes`
 * subscription on `game_events`, filtered to a single `game_id`
 * (Req 6.1, 6.3).
 *
 * Each `subscribe`d channel listens for INSERTs on `game_events` where
 * `game_id=eq.<gameId>`; the filter is what enforces per-game isolation on the
 * wire. Every inserted row is mapped to a {@link GameEvent} and handed to the
 * client's `onRow`, which funnels it through the ordered-apply core.
 *
 * @param client the browser Supabase client (from
 *   {@link createBrowserSupabaseClient}).
 * @returns a transport whose channels are Supabase realtime channels.
 */
export function supabaseRealtimeTransport(
  client: SupabaseClient,
): RealtimeTransport {
  return {
    channel(
      gameId: string,
      onRow: (event: GameEvent) => void,
    ): RealtimeChannel {
      const channel: SupabaseRealtimeChannel = client
        .channel(`game_events:${gameId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: GAME_EVENTS_TABLE,
            filter: `game_id=eq.${gameId}`,
          },
          (payload) => {
            const row = payload.new as GameEventRow | undefined;
            if (row === undefined) {
              return;
            }
            onRow(rowToGameEvent(row));
          },
        );

      void channel.subscribe();

      return {
        unsubscribe: async (): Promise<void> => {
          await client.removeChannel(channel);
        },
      };
    },
  };
}

/**
 * A {@link SnapshotSource} that reads a game's `game_events` ordered by `seq`
 * ascending through the browser Supabase client (Req 6.4).
 *
 * Reads go through the anon key and are therefore subject to RLS (Req 7.2): the
 * browser only sees events for games its session is a member of.
 *
 * @param client the browser Supabase client.
 * @returns a snapshot source that `subscribe()` folds into the initial snapshot.
 */
export function supabaseSnapshotSource(client: SupabaseClient): SnapshotSource {
  return {
    async fetchEventsAscending(gameId: string): Promise<GameEvent[]> {
      const { data, error } = await client
        .from(GAME_EVENTS_TABLE)
        .select(
          "id, game_id, seq, event_type, actor_kind, actor_team_id, payload, created_at",
        )
        .eq("game_id", gameId)
        .order("seq", { ascending: true });

      if (error !== null) {
        throw new Error(
          `failed to load snapshot for game ${gameId}: ${error.message}`,
        );
      }
      return (data ?? []).map((row) => rowToGameEvent(row as GameEventRow));
    },
  };
}
