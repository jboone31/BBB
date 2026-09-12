"use client";

/**
 * Game_Board page — wires the Game_Board_Client together (design.md §Components 3;
 * Task 11; Requirements 1.1, 1.3, 1.4, 1.5, 1.6, 2.3, 3.6, 5.4, 7.1, 7.3, 7.7,
 * 8.1, 8.2, 8.3, 8.5, 8.6, 8.7, 8.8).
 *
 * This is the one client surface that composes the presentational board
 * components ({@link RegionNav}, {@link BarsRegion}, {@link ScoreboardRegion},
 * {@link CardsRegion}, {@link CardPlayWireframe}, {@link TargetedNotification})
 * with the foundation's realtime client, the feature's pure Game_Board reducer,
 * and the access/region helpers. It mirrors the lobby page's structure exactly —
 * async Supabase-auth Session → subscribe + snapshot fold + ordered apply +
 * reconnect + resume; role derivation from durable per-game facts;
 * unconfigured-env resilience — and owns the things the presentational
 * components deliberately do not:
 *
 *   1. **Session identity (R8.x).** The per-device Session id is the Supabase
 *      Anonymous Auth UID (see {@link establishBrowserSession}): the browser
 *      signs in anonymously and that UID is BOTH the id sent as the
 *      `x-bbb-session-id` header on the one POST AND the JWT `sub` RLS matches,
 *      so RLS-scoped reads and realtime work. Establishing it is async, so the
 *      page gates the POST and the subscription on the resolved id.
 *   2. **Access gate (R1).** {@link selectBoardAccess} maps the folded lifecycle
 *      + resolved role facts to exactly one decision; only `board` renders the
 *      three Regions. `redirect-lobby` navigates to the game's lobby (R1.3).
 *   3. **Subscribe + snapshot + ordered apply (R8.1/8.2/8.3).** On mount it seeds
 *      the view by folding the game's `game_events` ({@link foldGameBoardEvents}
 *      == ordered fold, R8.2), then opens the per-game channel via
 *      {@link subscribe}. Live events fold into the {@link GameBoardView} via
 *      {@link applyGameBoardEvent} (R8.3).
 *   4. **Reconnect + resume (R8.5/8.6/8.7).** A {@link ReconnectController}
 *      retries a dropped connection on the bounded ≤5s / ≤12-attempt schedule
 *      and, once exhausted, surfaces a terminal "reload required" banner; a
 *      {@link ResumeController} bound to visibility/focus catches up the missed
 *      tail on resume/relaunch.
 *   5. **Region + card-play + notification state (R2/R6/R7).** Active-Region
 *      state via {@link selectRegion} (initial `bars`, R2.3); opening/confirming/
 *      cancelling the {@link CardPlayWireframe} (R6); and the list of
 *      {@link TargetedNotification}s derived from `view.targetedNotices` filtered
 *      to the current Team (R7.3/R7.8), each dismissable (R7.5).
 *   6. **The one POST.** `POST /api/games/{gameId}/wireframe-card-play` on
 *      confirm of a targeting card, surfacing "not delivered" on failure (R7.7).
 *
 * Role & team derivation. Two durable per-game facts (kept in the same storage
 * as the session so they survive reload) resolve the Session's role: whether it
 * created the game (Admin, `bbb:admin:{gameId}`), and its player id once it has
 * joined (`bbb:player:{gameId}`). `isAdmin` compares the admin fact to the
 * resolved session id; `isPlayer` is simply "has a player id". The
 * **admin-not-player** flag passed to the Bars/Cards Regions (R3.6/R5.4) is
 * `isAdmin && !isPlayer`. The **current Team id** is not carried by the
 * (team-agnostic) Game_Board reducer, so it is derived by folding the same
 * snapshot events with the lobby reducer ({@link foldLobbyEvents}) and reading
 * the current player's `teamId` — team membership is fixed once the Game is
 * `live`, so a single mount-time derivation is stable. It drives the target list
 * (excluding own Team, R6.2) and the notice filter (R7.3).
 *
 * Resilience without live env mirrors the lobby/demo pages: when Supabase is not
 * configured the page renders the shell and a clear notice rather than crashing,
 * and never opens a connection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import BarsRegion from "@/components/board/BarsRegion";
import CardPlayWireframe from "@/components/board/CardPlayWireframe";
import CardsRegion from "@/components/board/CardsRegion";
import RegionNav from "@/components/board/RegionNav";
import ScoreboardRegion from "@/components/board/ScoreboardRegion";
import TargetedNotification from "@/components/board/TargetedNotification";

import { selectBoardAccess } from "@/lib/gameboard/access";
import {
  applyGameBoardEvent,
  dismissTargetedNotice,
  foldGameBoardEvents,
  initialGameBoardView,
  type GameBoardView,
} from "@/lib/gameboard/events";
import {
  placeholderHand,
  type PlaceholderCard,
} from "@/lib/gameboard/placeholderCards";
import {
  INITIAL_REGION,
  type Region,
  selectRegion,
} from "@/lib/gameboard/region";

import { foldLobbyEvents } from "@/lib/lobby/events";

import type { GameEvent } from "@/lib/events";
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

/** Connection lifecycle the page surfaces to the user (mirrors the lobby). */
type ConnectionStatus =
  | "connecting"
  | "subscribed"
  | "reconnecting"
  | "reload-required"
  | "disabled"
  | "error";

/** The structured response the wireframe-card-play route returns. */
type WireframeResponse =
  | { applied: true; seq?: number | null; [k: string]: unknown }
  | { applied: false; error: string };

/** Per-game durable local facts key helpers (survive reload, mirror the lobby). */
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

export default function BoardPage(): React.JSX.Element {
  const router = useRouter();
  const params = useParams<{ gameId: string }>();
  const rawGameId = params?.gameId ?? "";
  const gameId = typeof rawGameId === "string" ? rawGameId : "";

  // --- Supabase-auth Session identity (R8.x) ------------------------------
  // BBB identity is bridged into Supabase Anonymous Auth: the browser signs in
  // anonymously and the resulting UID is BOTH the BBB session id sent as
  // `x-bbb-session-id` AND the JWT `sub` that RLS matches. Establishing the
  // session is ASYNC, so `sessionId` starts null and is filled by the bootstrap
  // effect below; until it resolves, the POST and the subscription are gated.
  const [sessionId, setSessionId] = useState<string | null>(null);

  // --- Local role facts (per-game, durable) -------------------------------
  // Recomputed once the async session resolves: `isAdmin` compares the durable
  // per-game admin flag to this session id, and `myPlayerId` is the durable
  // per-game player id. They stay null/false until the session is known.
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  // The current player's Team id, derived from the snapshot fold (see the
  // realtime effect). Drives the target list (R6.2) and notice filter (R7.3).
  const [myTeamId, setMyTeamId] = useState<string | null>(null);

  // --- Folded Game_Board view (R8.2/8.3) ----------------------------------
  const [view, setView] = useState<GameBoardView>(() =>
    initialGameBoardView(gameId),
  );
  // Whether the initial event snapshot has been fetched and folded. Until
  // this is true, view.lifecycle is still the initial "lobby" placeholder and
  // does NOT reflect the game's actual lifecycle, so the access gate must not
  // treat a "lobby" reading as authoritative (see the redirect effect below).
  // It flips true once the snapshot fold completes.
  const [viewLoaded, setViewLoaded] = useState<boolean>(false);
  // Seed the status from the environment so no synchronous setState is needed on
  // mount: unconfigured env starts terminal; a real subscription starts
  // "connecting" and advances via its async callbacks.
  const [status, setStatus] = useState<ConnectionStatus>(() => {
    if (gameId === "") {
      return "error";
    }
    return isSupabaseConfigured() ? "connecting" : "disabled";
  });

  // --- Active Region (R2.3) -----------------------------------------------
  // Initialized to the Bars_Region and transitioned by the pure `selectRegion`
  // (re-selecting the active Region is a no-op, R2.7).
  const [activeRegion, setActiveRegion] = useState<Region>(INITIAL_REGION);
  const handleSelectRegion = useCallback((target: Region): void => {
    setActiveRegion((current) => selectRegion(current, target));
  }, []);

  // --- Card-play wireframe state (R6) -------------------------------------
  const [playingCard, setPlayingCard] = useState<PlaceholderCard | null>(null);
  // Transient "not delivered" indication for a failed targeting POST (R7.7).
  const [playError, setPlayError] = useState<string | null>(null);

  const configured = isSupabaseConfigured();

  // --- Establish the Supabase-auth session (async identity bootstrap) ------
  // Sign in anonymously (or reuse the persisted anonymous session), adopt the
  // UID as the BBB session id, and derive the per-game role facts from it. This
  // must complete before the POST and before the subscription opens, so
  // `sessionId` gates both. When Supabase is not configured there is no auth to
  // establish and the page runs in its disabled (no-realtime) mode.
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
        unbindRealtimeAuth = bindRealtimeAuth(client, session.accessToken);
        setSessionId(session.sessionId);
        if (gameId !== "") {
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
  }, [configured, gameId]);

  // --- Subscribe + snapshot + ordered apply + reconnect + resume ----------
  // Everything realtime lives in one effect keyed by the active game so it tears
  // down cleanly on navigation. The snapshot is the ordered fold of prior events
  // (R8.2); applied events fold into the GameBoardView (R8.3). The same snapshot
  // is folded once with the lobby reducer to resolve the current player's Team
  // id (the Game_Board reducer is team-agnostic by design).
  const subscriptionRef = useRef<RealtimeSubscription | null>(null);
  const reconnectRef = useRef<ReconnectController | null>(null);

  useEffect(() => {
    // Wait for the async Supabase-auth session: without it the anon client
    // carries no JWT `sub`, so RLS denies every `game_events` read and the
    // snapshot/subscription would come back empty.
    if (gameId === "" || !configured || sessionId === null) {
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

    // Fold one applied event into the view (R8.3). Guarded by
    // applyGameBoardEvent's own idempotence, so a re-delivered event never
    // double-applies.
    const foldEvent = (event: GameEvent): void => {
      if (cancelled) {
        return;
      }
      setView((prev) => applyGameBoardEvent(prev, event));
    };

    // Reconnect controller: bounded ≤5s / ≤12-attempt retry, then terminal
    // "reload required" (R8.5/8.7).
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

    // Resume controller: unconditional catch-up on relaunch/foreground (R8.6),
    // able to pull a terminal reconnect controller back out.
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

    // Seed the view from the ordered fold of prior events (R8.2), then open the
    // per-game channel; live events fold in via foldEvent (R8.1/8.3). A failure
    // in either step surfaces the "live updates unavailable — reload required"
    // notice and never presents partially-applied state as live (R8.8).
    (async () => {
      try {
        const priorEvents = await snapshotSource.fetchEventsAscending(gameId);
        if (cancelled) {
          return;
        }
        setView(foldGameBoardEvents(gameId, priorEvents));
        // The snapshot has loaded and folded: view.lifecycle now reflects the
        // game's real state, so the access gate may act on it (R1.3 redirect).
        setViewLoaded(true);
        // Resolve the current player's Team id from the same snapshot using the
        // lobby reducer (which folds players + their team). Team membership is
        // fixed once the game is live, so this mount-time derivation is stable.
        const storedPlayerId = readLocal(playerIdKey(gameId));
        if (storedPlayerId !== null) {
          const lobbyView = foldLobbyEvents(gameId, priorEvents);
          const teamId =
            lobbyView.players.find((p) => p.id === storedPlayerId)?.teamId ??
            null;
          setMyTeamId(teamId);
        }

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
  }, [gameId, configured, sessionId]);

  // --- Derived role / access ----------------------------------------------
  const isPlayer = myPlayerId !== null;
  // The admin-not-player flag the Bars/Cards Regions consume (R3.6/R5.4).
  const adminNotPlayer = isAdmin && !isPlayer;
  const access = selectBoardAccess(
    view.lifecycle,
    sessionId !== null,
    isAdmin,
    isPlayer,
  );

  // Notices whose target is the current Team (R7.3/R7.8). A player with no
  // resolved Team surfaces none (the caster's own client never surfaces its own
  // play, since it is on a different Team from the target).
  const myNotices = useMemo(
    () =>
      myTeamId === null
        ? []
        : view.targetedNotices.filter(
            (notice) => notice.targetTeamId === myTeamId,
          ),
    [view.targetedNotices, myTeamId],
  );

  // The current player's placeholder hand (R5.2). Deterministic per player id.
  const hand = useMemo<PlaceholderCard[]>(
    () => (myPlayerId === null ? [] : placeholderHand(myPlayerId)),
    [myPlayerId],
  );

  // Redirect a lobby-phase visitor to the game's lobby (R1.3). Done as an effect
  // so navigation happens after render, and never renders the Regions.
  useEffect(() => {
    // Only redirect once the snapshot has loaded (viewLoaded): before that, a
    // "lobby" lifecycle is the initial placeholder, not the game's real state,
    // so redirecting on it would bounce a live-game visitor back to the lobby.
    if (viewLoaded && access === "redirect-lobby" && gameId !== "") {
      router.push(`/games/${gameId}/lobby`);
    }
  }, [viewLoaded, access, gameId, router]);

  // --- The one POST: confirm a targeting card play (R7.1/7.7) --------------
  const handleConfirmPlay = useCallback(
    async (card: PlaceholderCard, targetTeamId?: string): Promise<void> => {
      // A non-targeting card writes nothing — the wireframe acknowledgement is
      // purely local (R6.6). Only a targeting card with a chosen target POSTs.
      if (!card.targetsTeam || targetTeamId === undefined) {
        return;
      }
      setPlayError(null);
      if (sessionId === null) {
        setPlayError("not_delivered");
        return;
      }
      try {
        const res = await fetch(`/api/games/${gameId}/wireframe-card-play`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SESSION_HEADER]: sessionId,
          },
          body: JSON.stringify({ cardId: card.id, targetTeamId }),
        });
        const body = (await res.json()) as WireframeResponse;
        if (!body.applied) {
          // Any non-applied response is "not delivered" (R7.7).
          setPlayError("not_delivered");
        }
      } catch {
        setPlayError("not_delivered");
      }
    },
    [gameId, sessionId],
  );

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

  const noticeStyle: React.CSSProperties = {
    margin: 0,
    padding: "0.6rem 0.75rem",
    border: "1px solid #888",
    borderRadius: "0.5rem",
    fontSize: "0.9rem",
    background: "#f7f7f7",
  };

  // Header status line, shared across every access decision.
  const header = (
    <header
      style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}
    >
      <h1 style={{ margin: 0, fontSize: "1.35rem" }}>Beltline Bar Brawl</h1>
      <p
        role="status"
        aria-live="polite"
        style={{ margin: 0, fontSize: "0.8rem", color: "#555" }}
      >
        {`Game board · ${status}`}
      </p>
    </header>
  );

  // Loading guard: once a Session is established but before the event snapshot
  // has loaded and folded (viewLoaded), view.lifecycle is still the initial
  // "lobby" placeholder. Acting on it would render the redirect-lobby (or a
  // stale ended) branch and bounce a live-game visitor back to the lobby. So
  // while a live subscription is still resolving, show a neutral loading state
  // rather than a lifecycle-derived branch. (A snapshot/subscription failure
  // sets status to "error" and is handled by the error branch below; the
  // no-session case, where the Session itself never resolves, is unaffected
  // because it does not depend on the snapshot.)
  if (
    access !== "no-session" &&
    access !== "not-authorized" &&
    !viewLoaded &&
    status !== "error" &&
    status !== "disabled"
  ) {
    return (
      <main style={containerStyle}>
        {header}
        <p role="status" style={noticeStyle}>
          Loading the game board…
        </p>
      </main>
    );
  }

  // Access-gate branches (R1). Only the `board` decision renders the Regions.
  if (access === "no-session") {
    // No valid Session: direct the request to establish one; render no board (R1.6).
    return (
      <main style={containerStyle}>
        {header}
        <p role="status" style={noticeStyle}>
          Establishing your session… If this persists, reload the page to sign
          in.
        </p>
      </main>
    );
  }

  if (access === "not-authorized") {
    // Neither Admin nor Player of this game (R1.5).
    return (
      <main style={containerStyle}>
        {header}
        <p role="alert" style={noticeStyle}>
          You are not authorized to view this game board.
        </p>
      </main>
    );
  }

  if (access === "redirect-lobby") {
    // The game is still in its lobby; the effect above navigates there (R1.3).
    return (
      <main style={containerStyle}>
        {header}
        <p role="status" style={noticeStyle}>
          This game hasn&apos;t started yet. Taking you to the lobby…
        </p>
      </main>
    );
  }

  if (access === "ended") {
    // Ended-game indication; no Regions (R1.4).
    return (
      <main style={containerStyle}>
        {header}
        <p role="status" style={noticeStyle}>
          This game has ended.
        </p>
      </main>
    );
  }

  // access === "board": render the live Game_Board with all three Regions (R1.1).
  return (
    <main style={containerStyle}>
      {header}

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

      {status === "error" ? (
        // Subscription/snapshot failure: live updates unavailable, reload
        // required; never present partially-applied state as live (R8.8).
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
          Live updates are unavailable. Please reload the page.
        </p>
      ) : null}

      {!configured ? (
        <p style={noticeStyle}>
          Real-time updates are not configured in this environment; the board
          will not update live.
        </p>
      ) : null}

      {/* Targeted notifications for the current Team (R7.3/R7.8). Rendered above
          the Region content but inline (never modal), so they never obscure the
          Region nav (R9.5) or block any control (R7.6). Each is dismissable
          (R7.5). */}
      {myNotices.map((notice) => (
        <TargetedNotification
          key={notice.seq}
          notice={notice}
          teams={view.teams}
          onDismiss={(seq) =>
            setView((prev) => dismissTargetedNotice(prev, seq))
          }
        />
      ))}

      {/* Region navigation: three controls, active one distinguished, all always
          operable (R2.1/2.4/2.5). */}
      <RegionNav active={activeRegion} onSelect={handleSelectRegion} />

      {/* The active Region (exactly one displayed, R2.6). */}
      {activeRegion === "bars" ? (
        <BarsRegion adminNotPlayer={adminNotPlayer} />
      ) : null}
      {activeRegion === "scoreboard" ? (
        <ScoreboardRegion teams={view.teams} />
      ) : null}
      {activeRegion === "cards" ? (
        <CardsRegion
          hand={hand}
          adminNotPlayer={adminNotPlayer}
          onPlayCard={(card) => {
            setPlayError(null);
            setPlayingCard(card);
          }}
        />
      ) : null}

      {/* Card_Play_Wireframe, presented on play (R6.1). The target list excludes
          the current Team (R6.2); confirm of a targeting card POSTs the one
          event (R7.1) and surfaces "not delivered" on failure (R7.7). */}
      {playingCard !== null ? (
        <>
          <CardPlayWireframe
            card={playingCard}
            teams={view.teams}
            ownTeamId={myTeamId ?? ""}
            onConfirm={(targetTeamId) => {
              void handleConfirmPlay(playingCard, targetTeamId);
            }}
            onCancel={() => {
              setPlayError(null);
              setPlayingCard(null);
            }}
          />
          {playError !== null ? (
            <p
              role="alert"
              style={{
                margin: 0,
                padding: "0.6rem 0.75rem",
                border: "1px solid #b00020",
                borderRadius: "0.5rem",
                fontSize: "0.85rem",
                color: "#b00020",
                background: "#fff5f5",
              }}
            >
              This card play was not delivered. Please try again.
            </p>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
