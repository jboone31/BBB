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
 *   1. **Session identity (R8.6/8.7).** The per-device Session id is the Supabase
 *      Anonymous Auth UID (see {@link establishBrowserSession}): the browser
 *      signs in anonymously and that UID is BOTH the id sent as the
 *      `x-bbb-session-id` header on *every* POST (so the server re-recognizes the
 *      Admin, R8.8) AND the JWT `sub` that RLS matches, so RLS-scoped reads and
 *      realtime work. Establishing it is async, so the page gates POSTs and the
 *      subscription on the resolved session id.
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
 * with no bars yet sees the create/designate surface. The single lobby-entry
 * surface is then chosen exhaustively by {@link selectLobbyEntry} over those two
 * facts: a joined player sees {@link TeamSelection}; a host who created the game
 * but has no player row yet sees the name-only {@link HostJoinCompletion}
 * surface (the created-but-not-joined recovery/entry case); and any other
 * visitor sees {@link JoinGame}. Everyone sees the {@link LobbyRoster}. When the
 * game has gone `live` the lobby controls are hidden (the lobby-phase gate
 * closes server-side too).
 *
 * The special route param `new` renders {@link CreateGame}: on success the page
 * navigates to `/games/{newId}/lobby` where the created Admin lands in the lobby.
 *
 * Resilience without live env mirrors the demo page: when Supabase is not
 * configured the page renders the controls and a clear notice rather than
 * crashing, and never opens a connection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";

import CreateGame, {
  type CreateSubmission,
} from "@/components/lobby/CreateGame";
import HostJoinCompletion from "@/components/lobby/HostJoinCompletion";
import JoinGame, { type JoinSubmission } from "@/components/lobby/JoinGame";
import LobbyRoster from "@/components/lobby/LobbyRoster";
import StartGame from "@/components/lobby/StartGame";
import TeamSelection from "@/components/lobby/TeamSelection";

import { selectLobbyEntry } from "./selectLobbyEntry";

import type { GameEvent } from "@/lib/events";
import {
  applyLobbyEvent,
  foldLobbyEvents,
  initialLobbyView,
  type LobbyView,
} from "@/lib/lobby/events";
import {
  isValidSubmittedCode,
  normalizeSubmittedCode,
} from "@/lib/lobby/joinCode";
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
import {
  bindRealtimeAuth,
  establishBrowserSession,
} from "@/lib/session/supabaseSession";

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
  const searchParams = useSearchParams();
  // Share_Link / Join_Entry prefill carrier (R4.4/R5.2): the code typed on the
  // landing page (or embedded in a share link) arrives as `?code=`. It seeds the
  // join form before the snapshot resolves; the authoritative `view.joinCode`
  // takes precedence once folded (see the prefill derivation below).
  const codeParam = searchParams?.get("code") ?? null;
  const rawGameId = params?.gameId ?? "";
  const gameId = typeof rawGameId === "string" ? rawGameId : "";
  const isCreateMode = gameId === NEW_GAME_PARAM;

  // --- Supabase-auth Session identity (R8.6/8.7) --------------------------
  // BBB identity is bridged into Supabase Anonymous Auth: the browser signs in
  // anonymously and the resulting UID is BOTH the BBB session id sent as
  // `x-bbb-session-id` AND the JWT `sub` that RLS matches, so RLS-scoped reads
  // and realtime work. Establishing the session is ASYNC (a sign-in), so
  // `sessionId` starts null and is filled by the bootstrap effect below; the
  // persisted, auto-refreshed anonymous session keeps the identity stable across
  // reloads (R8.6/8.7). Until it resolves, POSTs and the subscription are gated.
  const [sessionId, setSessionId] = useState<string | null>(null);

  // --- Local role facts (per-game, durable) -------------------------------
  // Both are recomputed once the async session resolves (see the bootstrap
  // effect): `isAdmin` compares the durable per-game admin flag to this
  // session id, and `myPlayerId` is the durable per-game player id. They stay
  // null/false until the session is known.
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);

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

  /**
   * POST JSON to a lobby route, always sending the session header. The session
   * is established asynchronously (Supabase anonymous auth), so this refuses to
   * fire until the session id is known — every write must carry the same id the
   * server persists to `admin_session_id`/`session_id` and that RLS matches.
   */
  const postJson = useCallback(
    async (path: string, body: unknown): Promise<LobbyResponse> => {
      if (sessionId === null) {
        return { applied: false, error: "session_not_ready" };
      }
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

  // --- Establish the Supabase-auth session (async identity bootstrap) ------
  // Sign in anonymously (or reuse the persisted anonymous session), adopt the
  // UID as the BBB session id, and derive the per-game role facts from it. This
  // must complete before any create/join write and before the subscription
  // opens, so `sessionId` gates both. When Supabase is not configured there is
  // no auth to establish and the page runs in its disabled (no-realtime) mode.
  useEffect(() => {
    if (!configured) {
      return;
    }
    const client = createBrowserSupabaseClient();
    if (client === null) {
      return;
    }

    let cancelled = false;
    let unbindRealtimeAuth: (() => void) | null = null;
    (async () => {
      try {
        const session = await establishBrowserSession(client);
        if (cancelled) {
          return;
        }
        // Authorize the realtime socket with the access token and keep it fresh
        // on refresh (PostgREST reads are authorized by the persisted session).
        unbindRealtimeAuth = bindRealtimeAuth(client, session.accessToken);
        setSessionId(session.sessionId);
        // Recompute the durable per-game role facts against the resolved id.
        if (gameId !== "" && !isCreateMode) {
          setIsAdmin(readLocal(adminFlagKey(gameId)) === session.sessionId);
          setMyPlayerId(readLocal(playerIdKey(gameId)));
        }
      } catch {
        if (!cancelled) {
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (unbindRealtimeAuth !== null) {
        unbindRealtimeAuth();
      }
    };
  }, [configured, gameId, isCreateMode]);

  // --- Subscribe + snapshot + ordered apply + reconnect + resume ----------
  // Everything realtime lives in one effect keyed by the active game so it tears
  // down cleanly on navigation. Applied events fold into the LobbyView (R7.3);
  // the snapshot is the ordered fold of prior events (R7.2).
  const subscriptionRef = useRef<RealtimeSubscription | null>(null);
  const reconnectRef = useRef<ReconnectController | null>(null);

  useEffect(() => {
    // Wait for the async Supabase-auth session: without it the anon client
    // carries no JWT `sub`, so RLS denies every `game_events` read and the
    // snapshot/subscription would come back empty.
    if (isCreateMode || gameId === "" || !configured || sessionId === null) {
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
    // `myPlayerId` is a dependency so that when a visitor joins (becoming a
    // member), the effect tears down and re-runs: the pre-join snapshot read was
    // RLS-denied (empty), so we must re-read once membership is established to
    // populate the join code, teams, and roster (R7.2). `isAdmin` likewise, so a
    // host who completes their join re-reads.
  }, [gameId, isCreateMode, configured, sessionId, myPlayerId, isAdmin]);

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

  // Join-form prefill precedence (R4.4/R5.1/R5.2): prefer the authoritative
  // folded `view.joinCode` once the snapshot resolves it; until then fall back
  // to the `?code=` carried by a Join_Entry submission or share link. A
  // Share_Link with no `?code=` still prefills from `view.joinCode` (existing
  // behavior) once it loads.
  const joinCodePrefill = view.joinCode ?? codeParam ?? "";

  // --- Route wiring: the six POSTs ----------------------------------------

  /**
   * Create a game, designate its bars, join the host as a Player, then land in
   * its lobby — all on the same `x-bbb-session-id` header (R2.1/2.2/2.3, R3.1,
   * R6.2/6.3/6.4).
   *
   * The three writes run in sequence and never re-issue `POST /api/games`: a
   * failure at bars or join stops the chain but still navigates to the created
   * lobby (the game exists), where the Admin can recover. On a successful join
   * the host becomes a Player (`bbb:player` written, `myPlayerId` set); on join
   * failure `bbb:player` is left unset and the lobby's host-completion path
   * (Task 7.2) lets the Admin retry.
   */
  const handleCreate = useCallback(
    async (submission: CreateSubmission): Promise<void> => {
      setBusy(true);
      setFormError(null);
      try {
        // 1. Create the game (single POST; never retried below, R6.4).
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
        const joinCode = String(
          (created as { joinCode?: unknown }).joinCode ?? "",
        );

        // 2. Designate start/finish bars by name in the same flow (R2.1/R2.2).
        const bars = await postJson(`/api/games/${newGameId}/bars`, {
          startBarName: submission.startBarName,
          finishBarName: submission.finishBarName,
        });
        if (!bars.applied) {
          setFormError(bars.error);
          // The game still exists; send the Admin to its lobby to retry bars.
          router.push(`/games/${newGameId}/lobby`);
          return;
        }

        // 3. Join the host as a Player with the returned code + Display_Name
        //    (R2.3/R3.1/R6.2/R6.3). Guard the code's shape before submitting;
        //    if it is somehow invalid, skip the join and still navigate.
        if (isValidSubmittedCode(joinCode)) {
          const joined = await postJson(`/api/games/${newGameId}/join`, {
            joinCode: normalizeSubmittedCode(joinCode),
            displayName: submission.displayName,
          });
          if (joined.applied) {
            const playerId = String(
              (joined as { playerId?: unknown }).playerId ?? "",
            );
            if (playerId !== "") {
              writeLocal(playerIdKey(newGameId), playerId);
              setMyPlayerId(playerId);
            }
          } else {
            // Leave `bbb:player` unset; recovery handled in the lobby (Task 7.2).
            setFormError(joined.error);
          }
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

  /**
   * Complete the host's join into the game they created (R3.2/R3.3). The Admin
   * already owns the authoritative Join_Code (folded into `view.joinCode`), so
   * this collects only a Display_Name and joins the *current* game with that
   * code — no code entry needed. On success it writes `bbb:player` and sets
   * `myPlayerId`, moving the Admin onto the team-selection surface.
   */
  const handleHostComplete = useCallback(
    async (displayName: string): Promise<void> => {
      // The host owns the code; if the folded view hasn't resolved it, there is
      // nothing to join with — surface the failure and issue no request.
      if (view.joinCode === null) {
        setFormError("join_failed");
        return;
      }
      setBusy(true);
      setFormError(null);
      try {
        const res = await postJson(`/api/games/${gameId}/join`, {
          joinCode: view.joinCode,
          displayName,
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
    [postJson, gameId, view.joinCode],
  );

  /**
   * Complete a code-arriving visitor's join (name-only). A visitor who reached
   * this lobby via a resolved Join_Code (`?code=`) already has the code, so we
   * ask only for a Display_Name and join with the code they arrived with —
   * rather than the full code-entry form. This differs from
   * {@link handleHostComplete} in the code source: a not-yet-joined visitor is
   * not a member, so RLS prevents them from reading `view.joinCode`; the
   * `codeParam` they carried is the authoritative code for the join.
   */
  const handleCodeComplete = useCallback(
    async (displayName: string): Promise<void> => {
      if (codeParam === null || !isValidSubmittedCode(codeParam)) {
        setFormError("join_failed");
        return;
      }
      setBusy(true);
      setFormError(null);
      try {
        const res = await postJson(`/api/games/${gameId}/join`, {
          joinCode: normalizeSubmittedCode(codeParam),
          displayName,
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
    [postJson, gameId, codeParam],
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

      {/* Read-only roster: Join_Code, teams + colors, players (R9.3/9.4/9.5).
          Only members (the admin, or a joined player) can read the game's events
          under RLS, so the roster is shown only once this session is a member.
          A not-yet-joined visitor sees just the join prompt below; the roster
          populates after they join (the subscription re-reads on membership). */}
      {isAdmin || hasJoined ? (
        <LobbyRoster
          gameId={gameId}
          joinCode={view.joinCode}
          teams={view.teams}
          players={view.players}
        />
      ) : null}

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

          {/* Exhaustive lobby-entry selection over (isAdmin, hasJoined):
              joined → team selection (R4); not-yet-joined Admin → host
              completion (R3.2/R3.3); everyone else → join form (R3). */}
          {(() => {
            const hasResolvedCode =
              codeParam !== null && isValidSubmittedCode(codeParam);
            switch (selectLobbyEntry(isAdmin, hasJoined, hasResolvedCode)) {
              case "team":
                return (
                  <TeamSelection
                    teams={view.teams}
                    currentTeamId={myTeamId}
                    onSelectTeam={handleSelectTeam}
                    onCreateTeam={handleCreateTeam}
                    submitting={busy}
                    error={formError}
                  />
                );
              case "host-complete":
                return (
                  <HostJoinCompletion
                    onComplete={handleHostComplete}
                    submitting={busy}
                    error={formError}
                  />
                );
              case "code-complete":
                // A code-arriving visitor already has the code: ask only for a
                // display name, then join with the code they arrived with.
                return (
                  <HostJoinCompletion
                    onComplete={handleCodeComplete}
                    submitting={busy}
                    error={formError}
                    heading="Join this game"
                    description="You're in the right place. Pick a display name to join and choose your team."
                  />
                );
              case "join":
                return (
                  <JoinGame
                    onJoin={handleJoin}
                    initialJoinCode={joinCodePrefill}
                    submitting={busy}
                    error={formError}
                  />
                );
            }
          })()}

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

      {/* Lobby → Game_Board navigation entry point (in-game-landing-wireframe
          R1.2). Once this lobby page folds a `game_started` event the lifecycle
          becomes "live" and the lobby controls above disappear; here we surface
          a control that navigates to this Game's Game_Board within the
          propagation window. This is purely additive — it changes no other lobby
          behavior. The `game_started` fold is owned by the lobby feature; this
          only consumes the resulting `live` state. */}
      {view.lifecycle === "live" ? (
        <Link
          href={`/games/${gameId}/board`}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "44px",
            padding: "0.75rem 1rem",
            border: "1px solid #0b57d0",
            borderRadius: "0.5rem",
            fontSize: "1rem",
            fontWeight: 600,
            textAlign: "center",
            textDecoration: "none",
            color: "#fff",
            background: "#0b57d0",
            boxSizing: "border-box",
          }}
        >
          Go to game board
        </Link>
      ) : null}
    </main>
  );
}
