"use client";

/**
 * End-to-end propagation demo view (design.md Component 7; Task 16.2; Req 6.10).
 *
 * This client component is the F0.3 demonstration: it proves that a
 * `Game_State_Change` persisted on one client reaches a *separate* subscribed
 * client in near real time. It does two things:
 *
 *   1. **Subscribes** to a game via `lib/realtime` {@link subscribe} over the
 *      browser Supabase adapter (`lib/realtime/supabaseBrowser`). Every event
 *      that arrives on the per-game `Real_Time_Channel` (Req 6.1) is rendered in
 *      arrival order with its `seq`, `event_type`, and `payload` — so a viewer on
 *      a second device watches events land live (Req 6.10).
 *   2. Offers a **trigger** button that POSTs to `/api/demo-mutation`, which
 *      atomically writes a domain row plus exactly one `game_event` and returns
 *      its `seq` (Task 10.1). Firing it here, and watching it appear in another
 *      browser tab/device subscribed to the same game, is the demonstration.
 *
 * **Resilient without live env.** The demo must build and render even when no
 * Supabase env is configured (so `npm run build` works without secrets). When
 * {@link isSupabaseConfigured} is false the component renders a clear disabled
 * placeholder and never constructs a client or opens a connection — it does not
 * crash. Runtime/subscription errors are caught and surfaced as a status message
 * rather than thrown.
 *
 * Requirements: 6.10 (and, via the client it drives, 6.1, 6.3, 6.4, 6.6, 6.9).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { GameEvent } from "@/lib/events";
import { subscribe, type RealtimeSubscription } from "@/lib/realtime";
import {
  createBrowserSupabaseClient,
  isSupabaseConfigured,
  supabaseRealtimeTransport,
  supabaseSnapshotSource,
} from "@/lib/realtime/supabaseBrowser";

/** Connection lifecycle the demo surfaces to the viewer. */
type ConnectionStatus =
  "idle" | "connecting" | "subscribed" | "disabled" | "error";

/** A received event plus a client-side arrival timestamp for the feed. */
interface ReceivedEvent {
  readonly event: GameEvent;
  readonly receivedAt: number;
}

/** Result of firing the demo mutation. */
type TriggerState =
  | { readonly kind: "idle" }
  | { readonly kind: "posting" }
  | { readonly kind: "ok"; readonly seq: number }
  | { readonly kind: "error"; readonly message: string };

/** Header the demo mutation route expects for session-based membership auth. */
const SESSION_HEADER = "x-bbb-session-id";

/** Compact JSON preview of an event payload for the feed. */
function payloadPreview(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

export interface PropagationDemoProps {
  /**
   * The game to subscribe to and target with the demo mutation. Optional so the
   * page can render the control even before a game id is known; when absent the
   * subscription waits and the trigger is disabled.
   */
  readonly gameId?: string;
  /**
   * The per-game session id sent with the demo mutation (session-based
   * Identity_Model). When absent, the trigger is disabled with a hint.
   */
  readonly sessionId?: string;
}

export default function PropagationDemo({
  gameId,
  sessionId,
}: PropagationDemoProps): React.JSX.Element {
  const configured = isSupabaseConfigured();
  const hasGameId = gameId !== undefined && gameId.trim().length > 0;
  // Whether the effect will run a live subscription for the current inputs.
  const willSubscribe = configured && hasGameId;

  // `connection` holds only the *live* subscription outcome the async flow
  // reports. The displayed status is derived (below) so the effect never needs a
  // synchronous setState for the disabled/idle/connecting cases.
  const [connection, setConnection] = useState<{
    readonly status: ConnectionStatus;
    readonly detail: string;
  } | null>(null);
  const [events, setEvents] = useState<ReceivedEvent[]>([]);
  const [trigger, setTrigger] = useState<TriggerState>({ kind: "idle" });

  const subscriptionRef = useRef<RealtimeSubscription | null>(null);

  // Subscribe when we have a game id and Supabase is configured. Everything is
  // guarded so an unconfigured/missing-env build renders a placeholder instead
  // of crashing. Only the async subscription callbacks call setState, so the
  // effect body itself performs no synchronous state update.
  useEffect(() => {
    if (!willSubscribe || gameId === undefined) {
      return;
    }

    const client = createBrowserSupabaseClient();
    if (client === null) {
      return;
    }

    let cancelled = false;
    const transport = supabaseRealtimeTransport(client);
    const snapshotSource = supabaseSnapshotSource(client);

    subscribe(gameId, {
      transport,
      snapshotSource,
      handlers: {
        onEvent: (event) => {
          if (cancelled) {
            return;
          }
          setEvents((prev) => [...prev, { event, receivedAt: Date.now() }]);
        },
      },
    })
      .then((sub) => {
        if (cancelled) {
          void sub.close();
          return;
        }
        subscriptionRef.current = sub;
        setConnection({ status: "subscribed", detail: "" });
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setConnection({
          status: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
      setEvents([]);
      setConnection(null);
      const sub = subscriptionRef.current;
      subscriptionRef.current = null;
      if (sub !== null) {
        void sub.close();
      }
    };
  }, [willSubscribe, gameId]);

  // Derive the displayed status. When a live subscription is in flight we show
  // its reported outcome (or "connecting" until it resolves); otherwise we show
  // the static disabled/idle reason from the current inputs.
  const status: ConnectionStatus = !configured
    ? "disabled"
    : !hasGameId
      ? "idle"
      : (connection?.status ?? "connecting");
  const statusDetail =
    connection?.detail ??
    (configured && !hasGameId ? "Provide a game id to subscribe." : "");

  const canTrigger =
    configured &&
    gameId !== undefined &&
    gameId.trim().length > 0 &&
    sessionId !== undefined &&
    sessionId.trim().length > 0 &&
    trigger.kind !== "posting";

  const fireMutation = useCallback(async () => {
    if (gameId === undefined || sessionId === undefined) {
      return;
    }
    setTrigger({ kind: "posting" });
    try {
      const res = await fetch("/api/demo-mutation", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SESSION_HEADER]: sessionId,
        },
        body: JSON.stringify({ gameId, note: "demo propagation" }),
      });
      const body = (await res.json()) as
        { applied: true; seq: number } | { applied: false; error: string };
      if (res.ok && body.applied) {
        setTrigger({ kind: "ok", seq: body.seq });
      } else {
        const message = !body.applied ? body.error : `HTTP ${res.status}`;
        setTrigger({ kind: "error", message });
      }
    } catch (err: unknown) {
      setTrigger({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [gameId, sessionId]);

  return (
    <section
      aria-labelledby="propagation-demo-heading"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        maxWidth: "100%",
      }}
    >
      <h2
        id="propagation-demo-heading"
        style={{ margin: 0, fontSize: "1.1rem" }}
      >
        Real-time propagation demo
      </h2>

      <p style={{ margin: 0, fontSize: "0.85rem", lineHeight: 1.4 }}>
        Open this page on a second device or tab subscribed to the same game.
        Trigger a state change on one, and watch the event arrive on the other.
      </p>

      <p
        role="status"
        aria-live="polite"
        style={{ margin: 0, fontSize: "0.85rem" }}
      >
        Status: <strong>{status}</strong>
        {statusDetail !== "" ? ` — ${statusDetail}` : ""}
      </p>

      {!configured ? (
        <p
          style={{
            margin: 0,
            padding: "0.5rem 0.75rem",
            border: "1px solid #ccc",
            borderRadius: "0.5rem",
            fontSize: "0.85rem",
            background: "#f7f7f7",
          }}
        >
          Supabase is not configured in this environment. Set
          <code> NEXT_PUBLIC_SUPABASE_URL </code> and
          <code> NEXT_PUBLIC_SUPABASE_ANON_KEY </code> to enable the live demo.
        </p>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
        <button
          type="button"
          onClick={() => {
            void fireMutation();
          }}
          disabled={!canTrigger}
          style={{
            padding: "0.6rem 0.75rem",
            fontSize: "0.95rem",
            borderRadius: "0.5rem",
            border: "1px solid #444",
            cursor: canTrigger ? "pointer" : "not-allowed",
          }}
        >
          {trigger.kind === "posting"
            ? "Triggering…"
            : "Trigger a Game State Change"}
        </button>
        {!canTrigger && configured ? (
          <span style={{ fontSize: "0.75rem", color: "#666" }}>
            Provide a game id and session id to enable triggering.
          </span>
        ) : null}
        {trigger.kind === "ok" ? (
          <span style={{ fontSize: "0.8rem", color: "#0a7d28" }}>
            Persisted event #{trigger.seq}. It should appear below on any
            subscribed client.
          </span>
        ) : null}
        {trigger.kind === "error" ? (
          <span style={{ fontSize: "0.8rem", color: "#b00020" }}>
            Mutation failed: {trigger.message}
          </span>
        ) : null}
      </div>

      <div>
        <h3 style={{ margin: "0 0 0.35rem", fontSize: "0.95rem" }}>
          Received events ({events.length})
        </h3>
        {events.length === 0 ? (
          <p style={{ margin: 0, fontSize: "0.8rem", color: "#666" }}>
            No events received yet.
          </p>
        ) : (
          <ol
            style={{
              margin: 0,
              paddingLeft: "1.1rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.4rem",
            }}
          >
            {events.map((received) => (
              <li
                key={received.event.id}
                style={{ fontSize: "0.8rem", wordBreak: "break-word" }}
              >
                <strong>seq {received.event.seq}</strong> ·{" "}
                <code>{received.event.eventType}</code>
                <br />
                <span style={{ color: "#444" }}>
                  {payloadPreview(received.event.payload)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
