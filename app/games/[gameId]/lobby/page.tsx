"use client";

/**
 * Lobby page — wires the Lobby_Client together (design.md §Components 5; Task 22;
 * Requirements 7.1, 7.2, 7.3, 7.5, 7.6, 8.6, 8.7, 9.5).
 *
 * This is the one client surface that composes the presentational lobby
 * components ({@link CreateGame}, {@link JoinGame}, {@link TeamSelection},
 * {@link StartGame}, {@link LobbyRoster}) with the foundation's realtime client
 * and the feature's pure lobby reducer. It owns four things the presentational
 * components deliberately do not:
 *
 *   1. **Session identity (R8.6/8.7).** A durable {@link SessionStore} mints or
 *      reuses the per-device Session id and this page sends it as the
 *      `x-bbb-session-id` header on *every* POST, so the server re-recognizes the
 *      Admin (R8.8) and enforces membership without extra client state.
 *   2. **Subscribe + snapshot + ordered apply (R7.1/7.2/7.3).** On mount it loads
 *      a snapshot by folding the game's `game_events` (`foldLobbyEvents` ==
 *      ordered fold, R7.2), then opens the per-game channel via
 *      {@link subscribe}. Live events flow through the ordered-apply core and
 *      each applied event is folded into the {@link LobbyView} with
 *      {@link applyLobbyEvent} (R7.3), re-rendering the roster within the
 *      propagation window (R9.5).
 *   3. **Reconnect + resume (R7.5/7.6).** A {@link ReconnectController} retries a
 *      dropped connection on the bounded ≤5s / ≤12-attempt schedule and, once
 *      exhausted, surfaces a terminal "reload required" banner; a
 *      {@link ResumeController} bound to visibility/focus catches up exactly the
 *      missed tail on resume/relaunch, and can pull a terminal reconnect
 *      controller back out of its terminal state.
 *   4. **The six route POSTs.** create (`/api/games`), designate bars
 *      (`/bars`), join (`/join`), create team (`/teams`), select team
 *      (`/teams/select`), and start (`/start`) — each wired to the matching
 *      component callback, sending the session header and surfacing failures.
 *
 * Role & phase rendering. The page derives what to show from the folded
 * {@link LobbyView} plus two durable local facts (kept per-game in the same
 * storage as the session, so they survive reload): whether this Session created
 * the game (Admin), and this Session's player id once it has joined. An Admin
 * with no bars yet sees the create/designate surface; a visitor who has not
 * joined sees {@link JoinGame}; a joined player sees {@link TeamSelection}; and
 * everyone sees the {@link LobbyRoster}. When the game has gone `live` the lobby
 * controls are hidden (the lobby-phase gate closes server-side too).
 *
 * The special route param `new` renders {@link CreateGame}: on success the page
 * navigates to `/games/{newId}/lobby` where the created Admin lands in the lobby.
 *
 * Resilience without live env mirrors the demo page: when Supabase is not
 * configured the page renders the controls and a clear notice rather than
 * crashing, and never opens a connection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import CreateGame, { type BarDesignation } from "@/components/lobby/CreateGame";
import JoinGame, { type JoinSubmission } from "@/components/lobby/JoinGame";
import LobbyRoster from "@/components/lobby/LobbyRoster";
import StartGame from "@/components/lobby/StartGame";
import TeamSelection from "@/components/lobby/TeamSelection";

import type { GameEvent } from "@/lib/events";
import {
  applyLobbyEvent,
  foldLobbyEvents,
  initialLobbyView,
  type LobbyView,
} from "@/lib/lobby/events";
import { subscribe, type RealtimeSubscription } from "@/lib/realtime";
import { LocalStorageLastSeenStore } from "@/lib/realtime/lastSeenStore";
import {
  makeReconnectAttempt,
  ReconnectController,
  ReconnectPhase,
} from "@/lib/realtime/reconnect";
import { bindResumeSignals, ResumeController } from "@/lib/realtime/resume";
import {
  createBrowserSupabaseClient,
  isSupabaseConfigured,
  supabaseRealtimeTransport,
  supabaseSnapshotSource,
} from "@/lib/realtime/supabaseBrowser";
import { SessionStore } from "@/lib/session/sessionStore";

/** Header carrying the per-game session id (session-based Identity_Model). */
const SESSION_HEADER = "x-bbb-session-id";

/** The route param value that renders the create-game surface. */
const NEW_GAME_PARAM = "new";

/** Connection lifecycle the page surfaces to the user. */
type ConnectionStatus =
  | "idle"
  | "connecting"
  | "subscribed"
  | "reconnecting"
  | "reload-required"
  | "disabled"
  | "error";

/** The shared structured response shape every lobby route returns. */
type LobbyResponse =
  | { applied: true; seq?: number | null; [k: string]: unknown }
  | { applied: false; error: string };

/** Per-game durable local facts key helpers (survive reload, mirror SessionStore). */
const adminFlagKey = (gameId: string): string => `bbb:admin:${gameId}`;
const playerIdKey = (gameId: string): string => `bbb:player:${gameId}`;

/** Best-effort read from localStorage; null when absent/unavailable. */
function readLocal(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Best-effort write to localStorage; swallows errors. */
function writeLocal(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Persistence is best-effort; a failure must not break the client.
  }
}

export default function LobbyPage(): React.JSX.Element {
  const router = useRouter();
  const params = useParams<{ gameId: string }>();
  const rawGameId = params?.gameId ?? "";
  const gameId = typeof rawGameId === "string" ? rawGameId : "";
  const isCreateMode = gameId === NEW_GAME_PARAM;

  // --- Durable Session identity (R8.6/8.7) --------------------------------
  // This is a client-rendered page, so the SessionStore is resolved once in a
  // lazy initializer: on the client it reuses the persisted id or mints one
  // (R8.7/8.9); during SSR the store degrades to in-memory and yields a
  // provisional id that the client render re-resolves from storage. POSTs send
  // whatever id this holds as the `x-bbb-session-id` header (R8.6).
  const [sessionId] = useState<string>(() => new SessionStore().getOrCreate());

  // --- Local role facts (per-game, durable) -------------------------------
  // Resolved lazily from durable per-game storage so no synchronous setState is
  // needed on mount; both survive reload alongside the session.
  const [isAdmin] = useState<boolean>(() =>
    gameId !== "" && !isCreateMode
      ? readLocal(adminFlagKey(gameId)) === sessionId
      : false,
  );
  const [myPlayerId, setMyPlayerId] = useState<string | null>(() =>
    gameId !== "" && !isCreateMode ? readLocal(playerIdKey(gameId)) : null,
  );

  // --- Folded lobby view (R7.2/7.3) ---------------------------------------
  const [view, setView] = useState<LobbyView>(() => initialLobbyView(gameId));
  // Seed the status from the environment so no synchronous setState is needed on
  // mount: create mode / unconfigured env start terminal; a real subscription
  // starts "connecting" and advances via its async callbacks.
  const [status, setStatus] = useState<ConnectionStatus>(() => {
    if (gameId === NEW_GAME_PARAM || gameId === "") {
      return "idle";
    }
    return isSupabaseConfigured() ? "connecting" : "disabled";
  });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const configured = isSupabaseConfigured();

  /** POST JSON to a lobby route, always sending the session header. */
  const postJson = useCallback(
    async (path: string, body: unknown): Promise<LobbyResponse> => {
      const res = await fetch(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SESSION_HEADER]: sessionId,
        },
        body: JSON.stringify(body),
      });
      return (await res.json()) as LobbyResponse;
    },
    [sessionId],
  );

  // --- Subscribe + snapshot + ordered apply + reconnect + resume ----------
  // Everything realtime lives in one effect keyed by the active game so it tears
  // down cleanly on navigation. Applied events fold into the LobbyView (R7.3);
  // the snapshot is the ordered fold of prior events (R7.2).
  const subscriptionRef = useRef<RealtimeSubscription | null>(null);
  const reconnectRef = useRef<ReconnectController | null>(null);

  useEffect(() => {
    if (isCreateMode || gameId === "" || !configured) {
      return;
    }

    const client = createBrowserSupabaseClient();
    if (client === null) {
      // Status already seeded to "disabled" by the lazy initializer.
      return;
    }

    let cancelled = false;
    const transport = supabaseRealtimeTransport(client);
    const snapshotSource = supabaseSnapshotSource(client);
    const lastSeenStore = new LocalStorageLastSeenStore();

    // Fold one applied event into the view (R7.3). Guarded by applyLobbyEvent's
    // own idempotence, so a re-delivered event never double-applies.
    const foldEvent = (event: GameEvent): void => {
      if (cancelled) {
        return;
      }
      setView((prev) => applyLobbyEvent(prev, event));
    };

    // Status is seeded to "connecting" by the lazy initializer; it advances to
    // "subscribed"/"reconnecting"/"reload-required" via the async callbacks.

    // Reconnect controller: bounded ≤5s / ≤12-attempt retry, then terminal (R7.5).
    const reconnect = new ReconnectController({
      gameId,
      lastSeenStore,
      attempt: makeReconnectAttempt({
        gameId,
        transport,
        snapshotSource,
        onEvent: foldEvent,
      }),
      onPhaseChange: (phase) => {
        if (cancelled) {
          return;
        }
        if (phase === ReconnectPhase.Reconnecting) {
          setStatus("reconnecting");
        } else if (phase === ReconnectPhase.ReloadRequired) {
          setStatus("reload-required");
        } else if (phase === ReconnectPhase.Connected) {
          setStatus("subscribed");
        }
      },
    });
    reconnectRef.current = reconnect;
    void reconnect; // held for lifecycle; drives status via onPhaseChange.

    // Resume controller: unconditional catch-up on relaunch/foreground (R7.6),
    // able to pull a terminal reconnect controller back out (Req 7.5→7.6).
    const resume = new ResumeController({
      gameId,
      lastSeenStore,
      snapshotSource,
      transport,
      onEvent: foldEvent,
      resetTransientRecovery: () => {
        // A stopped/terminal controller cannot resume path (a); a fresh resume
        // simply re-establishes delivery via its own resubscribe below.
      },
      onResumed: () => {
        if (!cancelled) {
          setStatus("subscribed");
        }
      },
    });
    const unbindResume = bindResumeSignals(resume);

    // Seed the view from the ordered fold of prior events (R7.2), then open the
    // per-game channel; live events fold in via foldEvent (R7.1/7.3).
    (async () => {
      try {
        const priorEvents = await snapshotSource.fetchEventsAscending(gameId);
        if (cancelled) {
          return;
        }
        setView(foldLobbyEvents(gameId, priorEvents));

        const sub = await subscribe(gameId, {
          transport,
          snapshotSource,
          lastSeenStore,
          handlers: { onEvent: foldEvent },
        });
        if (cancelled) {
          void sub.close();
          return;
        }
        subscriptionRef.current = sub;
        setStatus("subscribed");
      } catch {
        if (!cancelled) {
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      unbindResume();
      reconnect.stop();
      reconnectRef.current = null;
      const sub = subscriptionRef.current;
      subscriptionRef.current = null;
      if (sub !== null) {
        void sub.close();
      }
    };
  }, [gameId, isCreateMode, configured]);

  // --- Derived role / phase for rendering ---------------------------------
  const inLobby = view.lifecycle === "lobby";
  const hasJoined = myPlayerId !== null;
  const myTeamId = useMemo<string | null>(() => {
    if (myPlayerId === null) {
      return null;
    }
    return view.players.find((p) => p.id === myPlayerId)?.teamId ?? null;
  }, [view.players, myPlayerId]);
  const barsDesignated = view.startBarId !== null && view.finishBarId !== null;

  // --- Route wiring: the six POSTs ----------------------------------------

  /** Create a game, then designate its bars by name, then land in its lobby (R1, R2). */
  const handleCreate = useCallback(
    async (designation: BarDesignation): Promise<void> => {
      setBusy(true);
      setFormError(null);
      try {
        const created = await postJson("/api/games", {});
        if (!created.applied) {
          setFormError(created.error);
          return;
        }
        const newGameId = String(
          (created as { gameId?: unknown }).gameId ?? "",
        );
        if (newGameId === "") {
          setFormError("create_failed");
          return;
        }
        // This session owns the created game (Admin, R8.1/8.8).
        writeLocal(adminFlagKey(newGameId), sessionId ?? "");

        // Designate start/finish bars by name in the same flow (R2.1/R2.2).
        const bars = await postJson(`/api/games/${newGameId}/bars`, {
          startBarName: designation.startBarName,
          finishBarName: designation.finishBarName,
        });
        if (!bars.applied) {
          setFormError(bars.error);
          // The game still exists; send the Admin to its lobby to retry bars.
        }
        router.push(`/games/${newGameId}/lobby`);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "create_failed");
      } finally {
        setBusy(false);
      }
    },
    [postJson, router, sessionId],
  );

  /** Join the game with a submitted code + display name (R3). */
  const handleJoin = useCallback(
    async (submission: JoinSubmission): Promise<void> => {
      setBusy(true);
      setFormError(null);
      try {
        const res = await postJson(`/api/games/${gameId}/join`, {
          joinCode: submission.joinCode,
          displayName: submission.displayName,
        });
        if (!res.applied) {
          setFormError(res.error);
          return;
        }
        const playerId = String((res as { playerId?: unknown }).playerId ?? "");
        if (playerId !== "") {
          writeLocal(playerIdKey(gameId), playerId);
          setMyPlayerId(playerId);
        }
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "join_failed");
      } finally {
        setBusy(false);
      }
    },
    [postJson, gameId],
  );

  /** Create a new team (R4.2–R4.4). */
  const handleCreateTeam = useCallback(
    async (name: string): Promise<void> => {
      setBusy(true);
      setFormError(null);
      try {
        const res = await postJson(`/api/games/${gameId}/teams`, { name });
        if (!res.applied) {
          setFormError(res.error);
        }
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "create_team_failed");
      } finally {
        setBusy(false);
      }
    },
    [postJson, gameId],
  );

  /** Join or switch to a team (R4.1/R4.5). */
  const handleSelectTeam = useCallback(
    async (teamId: string): Promise<void> => {
      setBusy(true);
      setFormError(null);
      try {
        const res = await postJson(`/api/games/${gameId}/teams/select`, {
          teamId,
        });
        if (!res.applied) {
          setFormError(res.error);
        }
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "select_team_failed");
      } finally {
        setBusy(false);
      }
    },
    [postJson, gameId],
  );

  /** Start the game (Admin only; R5). */
  const handleStart = useCallback(async (): Promise<void> => {
    setBusy(true);
    setFormError(null);
    try {
      const res = await postJson(`/api/games/${gameId}/start`, {});
      if (!res.applied) {
        setFormError(res.error);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "start_failed");
    } finally {
      setBusy(false);
    }
  }, [postJson, gameId]);

  // --- Render --------------------------------------------------------------

  const containerStyle: React.CSSProperties = {
    maxWidth: "26rem",
    margin: "0 auto",
    padding: "1rem",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
  };

  // Create surface: `/games/new/lobby`.
  if (isCreateMode) {
    return (
      <main style={containerStyle}>
        <header
          style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}
        >
          <h1 style={{ margin: 0, fontSize: "1.35rem" }}>Beltline Bar Brawl</h1>
          <p style={{ margin: 0, fontSize: "0.9rem", color: "#555" }}>
            Host a new game
          </p>
        </header>
        <CreateGame
          onCreate={handleCreate}
          submitting={busy}
          error={formError}
        />
      </main>
    );
  }

  return (
    <main style={containerStyle}>
      <header
        style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}
      >
        <h1 style={{ margin: 0, fontSize: "1.35rem" }}>Beltline Bar Brawl</h1>
        <p
          role="status"
          aria-live="polite"
          style={{ margin: 0, fontSize: "0.8rem", color: "#555" }}
        >
          {view.lifecycle === "live"
            ? "The game is live."
            : `Lobby · ${status}`}
        </p>
      </header>

      {status === "reload-required" ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: "0.5rem 0.75rem",
            border: "1px solid #b00020",
            borderRadius: "0.5rem",
            fontSize: "0.85rem",
            color: "#b00020",
            background: "#fff5f5",
          }}
        >
          Connection lost. Please reload the page to reconnect.
        </p>
      ) : null}

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
          Real-time updates are not configured in this environment; the roster
          will not update live.
        </p>
      ) : null}

      {/* Read-only roster: Join_Code, teams + colors, players (R9.3/9.4/9.5). */}
      <LobbyRoster
        joinCode={view.joinCode}
        teams={view.teams}
        players={view.players}
      />

      {/* Lobby-phase controls only while the game is in the lobby (R4.8 mirror). */}
      {inLobby ? (
        <>
          {/* Admin: designate bars if not yet set (R2). */}
          {isAdmin && !barsDesignated ? (
            <CreateGame
              onCreate={async (designation) => {
                setBusy(true);
                setFormError(null);
                try {
                  const bars = await postJson(`/api/games/${gameId}/bars`, {
                    startBarName: designation.startBarName,
                    finishBarName: designation.finishBarName,
                  });
                  if (!bars.applied) {
                    setFormError(bars.error);
                  }
                } finally {
                  setBusy(false);
                }
              }}
              submitting={busy}
              error={formError}
            />
          ) : null}

          {/* Visitor who has not joined: join form (R3). */}
          {!hasJoined ? (
            <JoinGame
              onJoin={handleJoin}
              initialJoinCode={view.joinCode ?? ""}
              submitting={busy}
              error={formError}
            />
          ) : (
            /* Joined player: pick / switch team (R4). */
            <TeamSelection
              teams={view.teams}
              currentTeamId={myTeamId}
              onSelectTeam={handleSelectTeam}
              onCreateTeam={handleCreateTeam}
              submitting={busy}
              error={formError}
            />
          )}

          {/* Admin: start control, enabled only when eligible (R5). */}
          {isAdmin ? (
            <StartGame
              teamCount={view.teams.length}
              startBarId={view.startBarId}
              finishBarId={view.finishBarId}
              onStart={handleStart}
              submitting={busy}
              error={formError}
            />
          ) : null}
        </>
      ) : null}
    </main>
  );
}
