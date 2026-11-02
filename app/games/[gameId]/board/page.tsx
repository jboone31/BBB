"use client";

/**
 * Game_Board page — wires the Game_Board_Client together (design.md §Components 3;
 * Task 11; Requirements 1.1, 1.3, 1.4, 1.5, 1.6, 2.3, 3.6, 5.4, 7.1, 7.3, 7.7,
 * 8.1, 8.2, 8.3, 8.5, 8.6, 8.7, 8.8).
 *
 * This is the one client surface that composes the presentational board
 * components ({@link RegionNav}, {@link MapRegion}, {@link ScoreboardRegion},
 * {@link CardsRegion}, {@link CardPlayPanel}, {@link TargetedNotification})
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
 *   5. **Region + card-play + notification state.** Active-Region state via
 *      {@link selectRegion} (initial `bars`); the draw-choice / hand / play flow
 *      through the {@link CardsRegion} + {@link CardPlayPanel} against the real
 *      card routes (draw-on-claim, keep, discard, play with team/bar targeting
 *      and eligibility graying); and the list of {@link TargetedNotification}s
 *      derived from `view.targetedNotices` filtered to the current Team, each
 *      dismissable.
 *   6. **Card mutations.** POSTs to `/cards/{keep,discard,play,inject}` and the
 *      claim route, surfacing explicit errors on failure.
 *   7. **Card behavior (card-behavior task 10.6).** Renders the
 *      {@link ToastStack} (event toasts with their pending actions plus
 *      Boundary_Toasts, from `lib/gameboard/boardWiring.ts`), passes the map
 *      overlays, claim-block pre-check, and Happy Hour bonus bars to the
 *      Map_Region, and the Use-It-or-Lose-It hand state to the Cards_Region.
 *      Every event source funnels through one ordered apply gate, and a
 *      {@link RecheckController} runs while the game is live so a dropped
 *      Realtime event is fetched within one Recheck_Interval (Req 23.7, 23.8).
 *   8. **Board timers (card-behavior task 12.5).** A
 *      {@link BoardTimerController} calls the Settle_Nudge on mount, reconnect,
 *      and 3-5 s after each known effect boundary while live, measures the
 *      Server_Clock_Offset from every response, and wakes at each
 *      Boundary_Toast to re-derive the toasts. Every time-based selector and
 *      the {@link EffectsStrip} countdowns use offset-corrected server time
 *      (Req 3.7, 20.3a, 20.7-20.12).
 *
 * Role & team derivation. Two durable per-game facts (kept in the same storage
 * as the session so they survive reload) resolve the Session's role: whether it
 * created the game (Admin, `bbb:admin:{gameId}`), and its player id once it has
 * joined (`bbb:player:{gameId}`). `isAdmin` compares the admin fact to the
 * resolved session id; `isPlayer` is simply "has a player id". The
 * **admin-not-player** flag passed to the Cards_Region (R5.4) is
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

import CardPlayPanel, {
  type CardPlayServerError,
  type PlayTargets,
} from "@/components/board/CardPlayPanel";
import CardsRegion, {
  type DiscardReason,
} from "@/components/board/CardsRegion";
import MapRegion, {
  type ClaimAction,
  type ClaimAttestation,
} from "@/components/board/MapRegion";
import RegionNav from "@/components/board/RegionNav";
import ScoreboardRegion from "@/components/board/ScoreboardRegion";
import TargetedNotification from "@/components/board/TargetedNotification";
import ToastStack, { type PostAction } from "@/components/board/ToastStack";
import HostCardPanel from "@/components/board/HostCardPanel";
import EffectsStrip from "@/components/board/EffectsStrip";

import { selectBoardAccess } from "@/lib/gameboard/access";
import {
  applyGameBoardEvent,
  dismissTargetedNotice,
  foldGameBoardEvents,
  initialGameBoardView,
  selectClaimedBarCounts,
  selectClaimState,
  selectScoreTotals,
  type BoardCardView,
  type GameBoardView,
} from "@/lib/gameboard/events";
import {
  selectBonusClaimable,
  selectClaimBlocksForBar,
  selectMapOverlays,
  selectHostItems,
  selectOpenChallengesFor,
} from "@/lib/gameboard/cardBehavior";
import {
  buildCardTargetContext,
  buildSelectorContext,
  composeBoardToasts,
  mirrorIsLegalInView,
  readDismissalRecord,
  withDismissed,
  writeDismissalRecord,
} from "@/lib/gameboard/boardWiring";
import {
  boundaryToastId,
  deriveBoundaryToasts,
} from "@/lib/cards/boundaryToasts";
import type { ToastDismissalRecord } from "@/lib/cards/toasts";
import { BoardTimerController } from "@/lib/cards/boardTimers";
import { serverNow } from "@/lib/cards/clockOffset";
import type { EffectRecord } from "@/lib/cards/effects";
import type { FairestOfferRecord } from "@/lib/cards/behaviorState";
import type { ClaimBlock } from "@/lib/claims/blocks";
import {
  INITIAL_REGION,
  type Region,
  selectRegion,
} from "@/lib/gameboard/region";

import { foldLobbyEvents } from "@/lib/lobby/events";
import { CANDIDATE_BARS } from "@/lib/map/bars";
import { WIREFRAME_TEAMS } from "@/lib/map/claims";
import { CARD_SLUGS, getCardMetadata } from "@/lib/cards/catalog";
import { isDevCardInjectionEnabled } from "@/lib/config/devFlags";

import type { GameEvent } from "@/lib/events";
import {
  applyInOrder,
  initialOrderedApplyState,
  subscribe,
  type OrderedApplyState,
  type RealtimeSubscription,
} from "@/lib/realtime";
import { LocalStorageLastSeenStore } from "@/lib/realtime/lastSeenStore";
import {
  makeReconnectAttempt,
  ReconnectController,
  ReconnectPhase,
  type Scheduler,
} from "@/lib/realtime/reconnect";
import { RecheckController } from "@/lib/realtime/recheck";
import type { SnapshotSource } from "@/lib/realtime/snapshot";
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

/** The structured response the card-play route returns. */
type PlayResponse =
  | { applied: true; seq?: number | null; [k: string]: unknown }
  | { applied: false; error: string; details?: unknown };

type ClaimResponse =
  | { applied: true; seq?: number | null; result?: unknown }
  | { applied: false; error: string; details?: unknown };

type EndGameResponse =
  { applied: true; seq: number } | { applied: false; error: string };
type LeaveGameResponse =
  { applied: true; seq: number } | { applied: false; error: string };

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

/**
 * Timer seam for the {@link RecheckController}. Passed explicitly (rather than
 * relying on the module default) so the controller always has a real timer.
 */
const browserScheduler: Scheduler = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

/**
 * How often the board refreshes its server-time reading while live, so the
 * time-based selectors (claim blocks, map overlays, bonus windows, and
 * Boundary_Toasts) move on even when no event arrives.
 */
const BOARD_CLOCK_TICK_MS = 5_000;

/**
 * The blocking cards from a `blocked` claim rejection (`details.blocks`), or
 * null when the rejection is not a block with a usable list.
 */
function readBlockedDetails(
  error: string,
  details: unknown,
): readonly ClaimBlock[] | null {
  if (error !== "blocked" || typeof details !== "object" || details === null) {
    return null;
  }
  const blocks = (details as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return null;
  }
  return blocks as ClaimBlock[];
}

/** Empty dismissal record used before the snapshot seeds the real one. */
const EMPTY_DISMISSAL: ToastDismissalRecord = { floorSeq: -1, dismissed: [] };

/** A stable empty list, so memoized props do not change identity needlessly. */
const NO_TEAM_BLOCKS: Readonly<Record<string, readonly ClaimBlock[]>> = {};

/**
 * Build the ToastStack poster: the same Fairest-offer and challenge-resolve
 * routes the stack's default poster uses, with the session header attached.
 */
function makeToastPoster(sessionId: string | null): PostAction {
  return async (action, gameId) => {
    if (sessionId === null) {
      return { applied: false, error: "missing_session" };
    }
    const base = `/api/games/${encodeURIComponent(gameId)}`;
    let url: string;
    let body: unknown;
    switch (action.kind) {
      case "fairest_play":
      case "fairest_decline":
        url = `${base}/fairest-offers/${encodeURIComponent(action.offerId)}`;
        body = {
          decision: action.kind === "fairest_play" ? "play" : "decline",
        };
        break;
      case "mark_complete":
      case "we_failed":
        url = `${base}/challenges/${encodeURIComponent(action.challengeId)}/resolve`;
        body = {
          outcome: action.kind === "mark_complete" ? "completed" : "failed",
        };
        break;
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SESSION_HEADER]: sessionId,
        },
        body: JSON.stringify(body),
      });
      return (await res.json()) as {
        applied: boolean;
        error?: string;
        details?: { reason?: string } | null;
      };
    } catch {
      return { applied: false, error: "unavailable" };
    }
  };
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
  const [playerResolvedInSnapshot, setPlayerResolvedInSnapshot] =
    useState(false);
  // The current player's Team id, derived from the snapshot fold (see the
  // realtime effect). Drives the target list (R6.2) and notice filter (R7.3).
  const [myTeamId, setMyTeamId] = useState<string | null>(null);

  // --- Folded Game_Board view (R8.2/8.3) ----------------------------------
  const [view, setView] = useState<GameBoardView>(() =>
    initialGameBoardView(gameId),
  );

  // --- Ordered apply gate + recheck (Req 23.6, 23.7, 23.8) -----------------
  // Every event source (the initial subscription, reconnect/resume catch-up and
  // channels, the recheck fetch, and the post-claim refresh) funnels through
  // `ingestRef.current`, which applies events in contiguous seq order through
  // `applyInOrder`, folds them into the view, and notes each applied event on
  // the RecheckController. Its watermark is the recheck's `lastSeq`.
  const orderRef = useRef<OrderedApplyState>(initialOrderedApplyState());
  const ingestRef = useRef<((event: GameEvent) => void) | null>(null);
  const recheckRef = useRef<RecheckController | null>(null);
  const snapshotSourceRef = useRef<SnapshotSource | null>(null);
  const lifecycleRef = useRef<GameBoardView["lifecycle"]>(view.lifecycle);

  // Device-clock reading for the time-based card-behavior selectors. Refreshed
  // on every applied event, on each toast-timer fire, on `visibilitychange`, and
  // on a coarse tick while live. Selectors never read it directly: they use
  // `serverNowMs`, the reading corrected by the Server_Clock_Offset measured
  // from each Settle_Nudge response (Req 20.7, 20.9).
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [offsetMs, setOffsetMs] = useState<number>(0);
  // Mirrors `offsetMs` so a re-created timer controller keeps the last offset.
  const offsetRef = useRef<number>(0);
  const serverNowMs = serverNow(nowMs, offsetMs);
  // Board toast + nudge timers (Req 20.3a, 20.8), owned by a controller that
  // also tracks the offset. Held in a ref so reconnect/resume and folds reach it.
  const boardTimersRef = useRef<BoardTimerController | null>(null);

  // Per-game toast dismissal record `{ floorSeq, dismissed }`, seeded when the
  // snapshot loads (floorSeq = snapshot watermark on this device's first load).
  const [dismissal, setDismissal] =
    useState<ToastDismissalRecord>(EMPTY_DISMISSAL);
  // Boundary_Toast ids already shown by this board session (20.11, 20.12).
  const [sessionShown, setSessionShown] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Server-reported claim blocks for the bar of the last `blocked` claim (4.5).
  const [serverClaimBlocks, setServerClaimBlocks] = useState<{
    barId: string;
    blocks: readonly ClaimBlock[];
  } | null>(null);
  // A server rejection of the last play, shown inline in the play panel.
  const [playServerError, setPlayServerError] =
    useState<CardPlayServerError | null>(null);
  const refreshRoster = useCallback(async (): Promise<void> => {
    if (sessionId === null) {
      return;
    }
    const response = await fetch(`/api/games/${gameId}/teams`, {
      headers: { "x-bbb-session-id": sessionId },
    });
    if (!response.ok) {
      throw new Error("roster_could_not_be_loaded");
    }
    const payload = (await response.json()) as {
      teams?: GameBoardView["teams"];
      players?: GameBoardView["players"];
    };
    if (!Array.isArray(payload.teams) || !Array.isArray(payload.players)) {
      throw new Error("roster_could_not_be_loaded");
    }
    setView((current) => ({
      ...current,
      teams: payload.teams ?? current.teams,
      players: payload.players ?? current.players,
    }));
    if (myPlayerId !== null) {
      const currentPlayer = payload.players.find(
        (player) => player.id === myPlayerId,
      );
      setPlayerResolvedInSnapshot(currentPlayer !== undefined);
      setMyTeamId(currentPlayer?.teamId ?? null);
    }
  }, [gameId, myPlayerId, sessionId]);
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
  // Initialized to the Map_Region and transitioned by the pure `selectRegion`
  // (re-selecting the active Region is a no-op, R2.7).
  const [activeRegion, setActiveRegion] = useState<Region>(INITIAL_REGION);
  const handleSelectRegion = useCallback((target: Region): void => {
    setActiveRegion((current) => selectRegion(current, target));
  }, []);

  // --- Card-play state (Task 8) -------------------------------------------
  const [playingCard, setPlayingCard] = useState<BoardCardView | null>(null);
  const [playPending, setPlayPending] = useState(false);
  // Transient "not delivered" indication for a failed play POST.
  const [playError, setPlayError] = useState<string | null>(null);
  const [pendingClaimBarId, setPendingClaimBarId] = useState<string | null>(
    null,
  );
  const [claimMutationError, setClaimMutationError] = useState<{
    barId: string;
    message: string;
  } | null>(null);
  const [endGameDialogOpen, setEndGameDialogOpen] = useState(false);
  const [endGamePending, setEndGamePending] = useState(false);
  const [endGameError, setEndGameError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [leavePending, setLeavePending] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

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

    snapshotSourceRef.current = snapshotSource;

    // Fold events into the view in contiguous seq order (R8.3; Req 23.2). Every
    // source funnels through here: the ordered gate de-duplicates re-deliveries
    // and buffers out-of-order arrivals until the gap fills, so the view never
    // skips a seq. An arrival ahead of the frontier is noted on the recheck
    // first, which fetches the gap at once (Req 23.7); each applied event is then
    // noted so the quiet timer restarts.
    const foldEvent = (event: GameEvent): void => {
      if (cancelled || event.gameId !== gameId) {
        return;
      }
      const before = orderRef.current;
      if (event.seq > before.lastSeenSequence + 1) {
        recheckRef.current?.noteEvent(event);
      }
      const result = applyInOrder(orderRef.current, event);
      orderRef.current = result.state;
      if (result.applied.length === 0) {
        return;
      }
      const applied = result.applied;
      setView((prev) => applied.reduce(applyGameBoardEvent, prev));
      setNowMs(Date.now());
      for (const appliedEvent of applied) {
        recheckRef.current?.noteEvent(appliedEvent);
      }
    };
    ingestRef.current = foldEvent;

    const handleChannelStatus = (channelStatus: string): void => {
      if (cancelled) {
        return;
      }
      if (
        channelStatus === "CHANNEL_ERROR" ||
        channelStatus === "TIMED_OUT" ||
        channelStatus === "CLOSED"
      ) {
        reconnectRef.current?.connectionLost();
      }
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
        onChannelStatus: handleChannelStatus,
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
          // Settle_Nudge on reconnect (Req 20.8).
          void boardTimersRef.current?.nudge();
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
      onChannelStatus: handleChannelStatus,
      resetTransientRecovery: () => {
        // A stopped/terminal controller cannot resume path (a); a fresh resume
        // simply re-establishes delivery via its own resubscribe below.
      },
      onResumed: () => {
        if (!cancelled) {
          setStatus("subscribed");
          // A resume re-establishes delivery, so it nudges too (Req 20.8).
          void boardTimersRef.current?.nudge();
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
        const sub = await subscribe(gameId, {
          transport,
          snapshotSource,
          lastSeenStore,
          handlers: {
            onEvent: foldEvent,
            onChannelStatus: handleChannelStatus,
            onSnapshotEvents: (snapshotEvents) => {
              if (cancelled) {
                return;
              }
              const snapshotView = foldGameBoardEvents(gameId, snapshotEvents);
              setView(snapshotView);
              setNowMs(Date.now());
              // Seed the ordered gate from the snapshot watermark so live and
              // recheck events continue from it.
              if (
                snapshotView.lastSeenSequence >
                orderRef.current.lastSeenSequence
              ) {
                orderRef.current = initialOrderedApplyState(
                  snapshotView.lastSeenSequence,
                );
              }
              // Seed the toast dismissal record: reuse this device's stored
              // record, or start one whose floor is this first-load watermark
              // so historical informational toasts are not replayed.
              const storedDismissal = readDismissalRecord(gameId);
              const seededDismissal = storedDismissal ?? {
                floorSeq: snapshotView.lastSeenSequence,
                dismissed: [],
              };
              if (storedDismissal === null) {
                writeDismissalRecord(gameId, seededDismissal);
              }
              setDismissal(seededDismissal);
              setViewLoaded(true);
              const storedPlayerId = readLocal(playerIdKey(gameId));
              if (storedPlayerId !== null) {
                const lobbyView = foldLobbyEvents(gameId, snapshotEvents);
                setPlayerResolvedInSnapshot(
                  lobbyView.players.some((p) => p.id === storedPlayerId),
                );
                const teamId =
                  lobbyView.players.find((p) => p.id === storedPlayerId)
                    ?.teamId ?? null;
                setMyTeamId(teamId);
              }
              if (
                snapshotEvents.some((event) =>
                  ["player_joined", "team_changed", "player_left"].includes(
                    event.eventType,
                  ),
                )
              ) {
                void refreshRoster().catch(() => {
                  if (!cancelled) {
                    setStatus("error");
                  }
                });
              }
            },
          },
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
      if (ingestRef.current === foldEvent) {
        ingestRef.current = null;
      }
      if (snapshotSourceRef.current === snapshotSource) {
        snapshotSourceRef.current = null;
      }
      unbindResume();
      reconnect.stop();
      reconnectRef.current = null;
      const sub = subscriptionRef.current;
      subscriptionRef.current = null;
      if (sub !== null) {
        void sub.close();
      }
    };
  }, [gameId, configured, sessionId, refreshRoster]);

  // --- Recheck behind Realtime (Req 23.7, 23.8) ---------------------------
  // While the game is live, a RecheckController fetches every event above the
  // ordered gate's watermark whenever one Recheck_Interval passes with no new
  // event (or at once on a seq gap), and applies them through the same gate.
  // It is stopped on unmount and as soon as the game is no longer live. The
  // ReconnectController / ResumeController snapshot-plus-tail refetch above is
  // unchanged (Req 23.6); the recheck is not a reconnect.
  const isLive = view.lifecycle === "live";
  useEffect(() => {
    lifecycleRef.current = view.lifecycle;
  }, [view.lifecycle]);

  useEffect(() => {
    if (!isLive || !viewLoaded || !configured || gameId === "") {
      return;
    }
    const source = snapshotSourceRef.current;
    if (source === null) {
      return;
    }
    const controller = new RecheckController(gameId, {
      fetchEventsAfter: (id, afterSeq) => source.fetchEventsAfter(id, afterSeq),
      apply: (events) => {
        const ordered = [...events].sort((a, b) => a.seq - b.seq);
        for (const event of ordered) {
          ingestRef.current?.(event);
        }
      },
      lastSeq: () => orderRef.current.lastSeenSequence,
      isLive: () => lifecycleRef.current === "live",
      scheduler: browserScheduler,
    });
    recheckRef.current = controller;
    controller.start();
    return () => {
      controller.stop();
      if (recheckRef.current === controller) {
        recheckRef.current = null;
      }
    };
  }, [configured, gameId, isLive, viewLoaded]);

  // Coarse server-time tick while live so timed blocks, overlays, bonus windows,
  // and Boundary_Toasts advance without a new event.
  useEffect(() => {
    if (!isLive) {
      return;
    }
    const handle = setInterval(() => setNowMs(Date.now()), BOARD_CLOCK_TICK_MS);
    return () => clearInterval(handle);
  }, [isLive]);

  // --- Board timers + Server_Clock_Offset (Req 20.3a, 20.7-20.12) ---------
  // While live, a BoardTimerController nudges `/effects/settle` on mount (and on
  // reconnect/resume, above), re-measures the offset from every response, and
  // runs the toast timer (re-derive Boundary_Toasts at the next boundary) and
  // the nudge timer (3-5 s after each known boundary). Nothing server-side backs
  // the nudge (Req 20.3d). Stopped on unmount and as soon as the game ends.
  const timedEffects = useMemo<readonly EffectRecord[]>(
    () => Object.values(view.cardBehavior.effects),
    [view.cardBehavior.effects],
  );
  const timedEffectsRef = useRef<readonly EffectRecord[]>(timedEffects);
  useEffect(() => {
    timedEffectsRef.current = timedEffects;
    // Reschedule after each fold that changes the effect set.
    boardTimersRef.current?.reschedule();
  }, [timedEffects]);

  useEffect(() => {
    if (!isLive || !viewLoaded || sessionId === null || gameId === "") {
      return;
    }
    const controller = new BoardTimerController({
      scheduler: browserScheduler,
      deviceNow: () => Date.now(),
      effects: () => timedEffectsRef.current,
      isLive: () => lifecycleRef.current === "live",
      settle: async () => {
        try {
          const res = await fetch(
            `/api/games/${encodeURIComponent(gameId)}/effects/settle`,
            { method: "POST", headers: { [SESSION_HEADER]: sessionId } },
          );
          const body = (await res.json()) as {
            applied?: boolean;
            result?: { serverNow?: unknown };
          };
          return body.applied === true &&
            typeof body.result?.serverNow === "string"
            ? { serverNow: body.result.serverNow }
            : null;
        } catch {
          return null;
        }
      },
      onOffsetChange: (offset) => {
        offsetRef.current = offset;
        setOffsetMs(offset);
        setNowMs(Date.now());
      },
      onBoundary: () => setNowMs(Date.now()),
      initialOffsetMs: offsetRef.current,
    });
    boardTimersRef.current = controller;
    controller.start();

    const onVisibility = (): void => {
      setNowMs(Date.now());
      controller.reschedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      controller.stop();
      if (boardTimersRef.current === controller) {
        boardTimersRef.current = null;
      }
    };
  }, [gameId, isLive, sessionId, viewLoaded]);

  // --- Derived role / access ----------------------------------------------
  const isPlayer = myPlayerId !== null;
  // The admin-not-player flag the Cards_Region consumes (R5.4).
  const adminNotPlayer = isAdmin && !isPlayer;
  const access = selectBoardAccess(
    view.lifecycle,
    sessionId !== null,
    isAdmin,
    isPlayer,
  );
  const needsTeamSelection =
    viewLoaded &&
    isPlayer &&
    myTeamId === null &&
    playerResolvedInSnapshot &&
    view.teams.length > 0 &&
    access === "board";

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

  // The current team's real cards from the folded projection (R2.1). The
  // Cards_Region selects its pending/hand subsets. A player with no resolved
  // team (or the admin-not-player) has none.
  const myCards = useMemo(
    () =>
      myTeamId === null
        ? []
        : view.cards.filter((card) => card.teamId === myTeamId),
    [view.cards, myTeamId],
  );
  // Whether the current team has an unresolved pending draw (cards drawn but not
  // yet kept/discarded/forfeited). While true, the board forces the Cards region
  // and blocks other actions so the choice cannot be missed (UAT: the draw
  // choice must not be easy to skip).
  const hasPendingDraw = useMemo(
    () => myCards.some((card) => card.state === "pending"),
    [myCards],
  );
  // The card id awaiting a keep/discard server response (disables that card).
  const [cardMutationPending, setCardMutationPending] = useState<string | null>(
    null,
  );
  const [cardMutationError, setCardMutationError] = useState<string | null>(
    null,
  );

  // Teams shown on the Map_Region so any team's claim can be colored. Prefer the
  // game's real folded Teams; fall back to the wireframe teams when the game
  // exposes none (e.g. no realtime backend configured) so the map's claim/split
  // interaction still works as a wireframe.
  const mapTeams = view.teams.length > 0 ? view.teams : WIREFRAME_TEAMS;
  // The one Team this client may claim/unclaim bars for: your own Team (R: you
  // can only claim for the team you are on). When the current player's Team is
  // known, that is it; otherwise (wireframe/demo with no resolved Team) default
  // to the first available Team so the map stays operable as a wireframe.
  const ownTeamId = myTeamId ?? mapTeams[0]?.id ?? "";
  const claimState = useMemo(() => selectClaimState(view), [view]);
  const scoreTotals = useMemo(() => selectScoreTotals(view), [view]);
  const claimedBarCounts = useMemo(() => selectClaimedBarCounts(view), [view]);

  // --- Card-behavior wiring (Req 3.9, 4.5, 13.4) ---------------------------
  const selectorCtx = useMemo(() => buildSelectorContext(view), [view]);

  // Claim-block pre-check for the own team on every candidate bar, unioned with
  // the server's blocks from the last `blocked` claim response (4.5, 3.10).
  const claimBlocksByBar = useMemo(() => {
    if (myTeamId === null) {
      return NO_TEAM_BLOCKS;
    }
    const byBar: Record<string, readonly ClaimBlock[]> = {};
    for (const barKey of selectorCtx.bars.keys()) {
      const blocks = selectClaimBlocksForBar(
        view.cardBehavior,
        selectorCtx,
        myTeamId,
        barKey,
        serverNowMs,
      );
      if (blocks.length > 0) {
        byBar[barKey] = blocks;
      }
    }
    if (serverClaimBlocks !== null && serverClaimBlocks.blocks.length > 0) {
      const existing = byBar[serverClaimBlocks.barId] ?? [];
      byBar[serverClaimBlocks.barId] =
        existing.length > 0 ? existing : serverClaimBlocks.blocks;
    }
    return byBar;
  }, [
    myTeamId,
    serverNowMs,
    selectorCtx,
    serverClaimBlocks,
    view.cardBehavior,
  ]);

  const mapOverlays = useMemo(
    () =>
      myTeamId === null
        ? []
        : selectMapOverlays(
            view.cardBehavior,
            selectorCtx,
            myTeamId,
            serverNowMs,
          ),
    [myTeamId, serverNowMs, selectorCtx, view.cardBehavior],
  );

  const bonusClaimableBarIds = useMemo(
    () =>
      myTeamId === null
        ? []
        : selectBonusClaimable(view.cardBehavior, myTeamId, serverNowMs),
    [myTeamId, serverNowMs, view.cardBehavior],
  );

  // Host_Card_Panel rows (21.10, 21.11): only computed for the host of a live game.
  const hostItems = useMemo(
    () =>
      isAdmin && isLive ? selectHostItems(view.cardBehavior, serverNowMs) : [],
    [isAdmin, isLive, serverNowMs, view.cardBehavior],
  );

  // Use It or Lose It hand state for the Cards_Region (8.2, 9.3).
  const uioliState = useMemo(() => {
    if (myTeamId === null) {
      return { hasOpenUioli: false, fairestPromptPending: false };
    }
    const open = selectOpenChallengesFor(view.cardBehavior, myTeamId).filter(
      (challenge) => challenge.slug === "use-it-or-lose-it",
    );
    const openIds = new Set(open.map((challenge) => challenge.challengeId));
    const fairestPromptPending = Object.values(view.cardBehavior.offers).some(
      (offer) =>
        offer.status === "pending" &&
        offer.holderTeamId === myTeamId &&
        offer.challengeId !== null &&
        openIds.has(offer.challengeId),
    );
    return { hasOpenUioli: open.length > 0, fairestPromptPending };
  }, [myTeamId, view.cardBehavior]);

  // Boundary_Toasts (3.7, 20.3a, 20.10-20.12): the local toast timer advances
  // `serverNowMs` (offset-corrected), with the folded announced flags as the
  // transition-event fallback. The first derive after a reload is the
  // missed-boundary catch-up; after game end, `deriveBoundaryToasts` keeps only
  // ids already in this session's `sessionShown`.
  const boundaryToasts = useMemo(() => {
    const effects = Object.values(view.cardBehavior.effects);
    const playSeqByEffect = new Map<string, number>();
    const announced = new Set<string>();
    for (const effect of effects) {
      const play =
        effect.sourcePlayId === null
          ? undefined
          : view.cardBehavior.plays[effect.sourcePlayId];
      if (play !== undefined) {
        playSeqByEffect.set(effect.effectId, play.seq);
      }
      if (effect.startAnnounced) {
        announced.add(boundaryToastId(effect.effectId, "start"));
      }
      if (effect.endAnnounced) {
        announced.add(boundaryToastId(effect.effectId, "end"));
      }
    }
    return deriveBoundaryToasts({
      effects,
      playSeqByEffect,
      lifecycle: view.lifecycle,
      serverNowMs,
      announced,
      sessionShown,
      dismissal,
    });
  }, [dismissal, serverNowMs, sessionShown, view.cardBehavior, view.lifecycle]);

  // Record newly shown Boundary_Toast ids for this session (adjusting state
  // while rendering; guarded so it settles after one extra render).
  const unseenBoundaryIds = boundaryToasts
    .map((toast) => toast.id)
    .filter((id) => !sessionShown.has(id));
  if (unseenBoundaryIds.length > 0) {
    setSessionShown((prev) => new Set([...prev, ...unseenBoundaryIds]));
  }

  const boardToasts = useMemo(
    () =>
      composeBoardToasts({
        view,
        viewerTeamId: myTeamId,
        boundaryToasts,
        dismissal,
      }),
    [boundaryToasts, dismissal, myTeamId, view],
  );

  // Targeting facts for the Card_Play_Panel so it can gray out Pioneer/Scenic
  // targets left with no Legal_Next_Bar (Req 10.12, 22.5).
  const cardTargetCtx = useMemo(
    () => buildCardTargetContext(view, selectorCtx, serverNowMs),
    [serverNowMs, selectorCtx, view],
  );

  const isMirrorLegal = useCallback(
    (offer: FairestOfferRecord): boolean =>
      mirrorIsLegalInView(view, selectorCtx, offer, serverNowMs),
    [serverNowMs, selectorCtx, view],
  );

  const handleDismissToast = useCallback(
    (toastId: string): void => {
      setDismissal((current) => {
        const next = withDismissed(current, toastId);
        if (next !== current) {
          writeDismissalRecord(gameId, next);
        }
        return next;
      });
    },
    [gameId],
  );

  const toastPoster = useMemo(() => makeToastPoster(sessionId), [sessionId]);

  // Redirect a lobby-phase visitor to the game's lobby (R1.3). Done as an effect
  // so navigation happens after render, and never renders the Regions.
  useEffect(() => {
    // Only redirect once the snapshot has loaded (viewLoaded): before that, a
    // "lobby" lifecycle is the initial placeholder, not the game's real state,
    // so redirecting on it would bounce a live-game visitor back to the lobby.
    if (
      viewLoaded &&
      gameId !== "" &&
      (access === "redirect-lobby" || needsTeamSelection)
    ) {
      router.push(`/games/${gameId}/lobby`);
    }
  }, [viewLoaded, access, needsTeamSelection, gameId, router]);

  // --- The one POST: confirm a targeting card play (R7.1/7.7) --------------
  // --- Play a card (brawl-deck-architecture Task 8) -----------------------
  // POST the real card_played to /cards/play with the chosen target(s). On
  // success the card leaves the hand and the target team's clients see the play
  // via realtime (R3.1/R3.7); on failure an explicit "not delivered" shows and
  // the hand is unchanged.
  const handleConfirmPlay = useCallback(
    async (card: BoardCardView, targets: PlayTargets): Promise<void> => {
      if (view.lifecycle === "ended" || playPending) {
        return;
      }
      setPlayError(null);
      setPlayServerError(null);
      if (sessionId === null) {
        setPlayError("not_delivered");
        return;
      }
      setPlayPending(true);
      try {
        const res = await fetch(`/api/games/${gameId}/cards/play`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SESSION_HEADER]: sessionId,
          },
          body: JSON.stringify({
            cardId: card.cardId,
            targetTeamId: targets.targetTeamId,
            targetBarId: targets.targetBarId,
            params: targets.params,
          }),
        });
        const body = (await res.json()) as PlayResponse;
        if (!body.applied) {
          // A Pioneer / Scenic `no_legal_next_bar` (or another reasoned
          // `invalid_input`) is shown inline in the panel; anything else is
          // the generic "not delivered" notice.
          const details = body.details as
            { reason?: unknown; rules?: unknown } | null | undefined;
          if (
            body.error === "invalid_input" &&
            details !== null &&
            details !== undefined &&
            typeof details.reason === "string"
          ) {
            setPlayServerError({
              reason: details.reason,
              rules: Array.isArray(details.rules)
                ? (details.rules as CardPlayServerError["rules"])
                : undefined,
            });
          } else {
            setPlayError("not_delivered");
          }
        } else {
          setPlayingCard(null);
        }
      } catch {
        setPlayError("not_delivered");
      } finally {
        setPlayPending(false);
      }
    },
    [gameId, playPending, sessionId, view.lifecycle],
  );

  // --- Keep / discard a card (brawl-deck-architecture Tasks 5, 6) ----------
  // Resolve a pending draw (keep) or free a slot (discard) by POSTing to the
  // real card routes. Realtime folds the resulting card_kept / card_discarded
  // event back into view.cards, so the projection updates without local hand
  // state. A failed update surfaces an explicit error and never looks applied.
  const handleCardMutation = useCallback(
    async (
      action: "keep" | "discard",
      cardId: string,
      reason?: DiscardReason,
    ): Promise<void> => {
      if (
        sessionId === null ||
        cardMutationPending !== null ||
        view.lifecycle === "ended"
      ) {
        return;
      }
      setCardMutationError(null);
      setCardMutationPending(cardId);
      try {
        const response = await fetch(`/api/games/${gameId}/cards/${action}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SESSION_HEADER]: sessionId,
          },
          body: JSON.stringify(
            reason === undefined ? { cardId } : { cardId, reason },
          ),
        });
        const body = (await response.json()) as
          { applied: true; seq?: number } | { applied: false; error: string };
        if (!body.applied) {
          setCardMutationError(
            action === "keep"
              ? "The card could not be kept. Please try again."
              : "The card could not be discarded. Please try again.",
          );
        }
      } catch {
        setCardMutationError(
          action === "keep"
            ? "The card could not be kept. Please try again."
            : "The card could not be discarded. Please try again.",
        );
      } finally {
        setCardMutationPending(null);
      }
    },
    [cardMutationPending, gameId, sessionId, view.lifecycle],
  );

  // --- Forfeit a pending draw (UAT hand-full flow; R2.4) -------------------
  // Discard both drawn cards without keeping either by POSTing to the forfeit
  // route. Realtime folds the resulting card_discarded event back into
  // view.cards, clearing the pending draw. Shares the card-mutation pending/error
  // state so it is serialized with keep/discard.
  const handleForfeitDraw = useCallback(async (): Promise<void> => {
    if (
      sessionId === null ||
      cardMutationPending !== null ||
      view.lifecycle === "ended"
    ) {
      return;
    }
    setCardMutationError(null);
    setCardMutationPending("forfeit");
    try {
      const response = await fetch(`/api/games/${gameId}/cards/forfeit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SESSION_HEADER]: sessionId,
        },
      });
      const body = (await response.json()) as
        { applied: true; seq?: number } | { applied: false; error: string };
      if (!body.applied) {
        setCardMutationError(
          "The draw could not be forfeited. Please try again.",
        );
      }
    } catch {
      setCardMutationError(
        "The draw could not be forfeited. Please try again.",
      );
    } finally {
      setCardMutationPending(null);
    }
  }, [cardMutationPending, gameId, sessionId, view.lifecycle]);

  // --- Dev-only: inject a card into hand (Task 10; R5.2) -------------------
  // Only reachable when the committed DEV_CARD_INJECTION flag is on; the server
  // enforces the flag too (R5.3), so this is a convenience, not the gate.
  const [injectSlug, setInjectSlug] = useState<string>(CARD_SLUGS[0]);
  const [injectPending, setInjectPending] = useState(false);
  const handleInjectCard = useCallback(async (): Promise<void> => {
    if (sessionId === null || injectPending) {
      return;
    }
    setCardMutationError(null);
    setInjectPending(true);
    try {
      const response = await fetch(`/api/games/${gameId}/cards/inject`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SESSION_HEADER]: sessionId,
        },
        body: JSON.stringify({ slug: injectSlug }),
      });
      const body = (await response.json()) as
        { applied: true; seq?: number } | { applied: false; error: string };
      if (!body.applied) {
        setCardMutationError("The card could not be injected (dev).");
      }
    } catch {
      setCardMutationError("The card could not be injected (dev).");
    } finally {
      setInjectPending(false);
    }
  }, [gameId, injectPending, injectSlug, sessionId]);

  const handleClaimMutation = useCallback(
    async (
      barId: string,
      action: ClaimAction | "bonus",
      attestation: ClaimAttestation,
    ): Promise<void> => {
      if (sessionId === null || pendingClaimBarId !== null) {
        return;
      }
      setClaimMutationError(null);
      setServerClaimBlocks(null);
      setPendingClaimBarId(barId);
      try {
        const response = await fetch(`/api/games/${gameId}/claims`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SESSION_HEADER]: sessionId,
          },
          body: JSON.stringify(
            action === "bonus"
              ? { action, barId }
              : { action, barId, ...attestation },
          ),
        });
        const body = (await response.json()) as ClaimResponse;
        if (!body.applied) {
          const blocks = readBlockedDetails(body.error, body.details);
          if (blocks !== null) {
            // A `blocked` claim shows the standard claim-blocked message with
            // the blocking cards in the bar popup (4.5, 3.10).
            setServerClaimBlocks({ barId, blocks });
            return;
          }
          setClaimMutationError({
            barId,
            message:
              body.error === "claim_ineligible"
                ? "Claim requirements were not met."
                : body.error === "claim_duplicate"
                  ? "Your team already claims this bar."
                  : body.error === "claim_not_active"
                    ? "Your team no longer claims this bar."
                    : action === "bonus"
                      ? "The bonus could not be claimed. Please try again."
                      : "The claim was not saved. Please try again.",
          });
        } else {
          const client = createBrowserSupabaseClient();
          if (client !== null) {
            try {
              const events =
                await supabaseSnapshotSource(client).fetchEventsAscending(
                  gameId,
                );
              const ingest = ingestRef.current;
              if (ingest !== null) {
                // Reconcile through the ordered gate so the recheck watermark
                // and the view stay consistent.
                for (const event of events) {
                  ingest(event);
                }
              } else {
                const refreshedView = foldGameBoardEvents(gameId, events);
                setView((current) =>
                  refreshedView.lastSeenSequence >= current.lastSeenSequence
                    ? refreshedView
                    : current,
                );
              }
            } catch {
              // Realtime remains the primary update path if reconciliation fails.
            }
          }
        }
      } catch {
        setClaimMutationError({
          barId,
          message: "The claim was not saved. Please try again.",
        });
      } finally {
        setPendingClaimBarId(null);
      }
    },
    [gameId, pendingClaimBarId, sessionId],
  );

  // Happy Hour Bonus_Claim from the bar popup (13.4): the claim route with
  // `action: "bonus"`, sharing the claim pending/error state.
  const handleBonusClaim = useCallback(
    (barId: string): Promise<void> =>
      handleClaimMutation(barId, "bonus", {
        allMembersPresent: true,
        finishedDrinkCount: 0,
      }),
    [handleClaimMutation],
  );

  const handleEndGame = useCallback(async (): Promise<void> => {
    if (
      !isAdmin ||
      view.lifecycle !== "live" ||
      sessionId === null ||
      endGamePending
    ) {
      return;
    }

    setEndGameError(null);
    setEndGamePending(true);
    try {
      const response = await fetch(`/api/games/${gameId}/end`, {
        method: "POST",
        headers: { [SESSION_HEADER]: sessionId },
      });
      const body = (await response.json()) as EndGameResponse;
      if (!body.applied) {
        setEndGameError(
          body.error.includes("cannot be ended")
            ? "The game could not be ended because its state has changed."
            : "The game could not be ended. Please try again.",
        );
        return;
      }

      setEndGameDialogOpen(false);
      setView((current) => ({ ...current, lifecycle: "ended" }));
    } catch {
      setEndGameError("The game could not be ended. Please try again.");
    } finally {
      setEndGamePending(false);
    }
  }, [endGamePending, gameId, isAdmin, sessionId, view.lifecycle]);

  const readOnly = view.lifecycle === "ended";

  // Forced draw-resolution workflow (UAT): while a live game has an unresolved
  // pending draw, the board is pinned to the Cards region until the player
  // resolves the draw. This is derived (not stored) so there is no setState in
  // an effect: `effectiveRegion` overrides the user's selection while locked,
  // and the region nav disables the other controls (below). Combined with the
  // claim guard, this makes the "keep one of two" choice impossible to miss.
  const drawLocked = hasPendingDraw && !readOnly;
  const effectiveRegion: Region = drawLocked ? "cards" : activeRegion;

  const handleLeaveGame = useCallback(async (): Promise<void> => {
    if (leavePending || sessionId === null) {
      return;
    }
    if (readOnly) {
      router.push("/");
      return;
    }
    setLeaveError(null);
    setLeavePending(true);
    try {
      const response = await fetch(
        isAdmin ? `/api/games/${gameId}/end` : `/api/games/${gameId}/leave`,
        {
          method: "POST",
          headers: { [SESSION_HEADER]: sessionId },
        },
      );
      const body = (await response.json()) as LeaveGameResponse;
      if (!body.applied) {
        setLeaveError("You could not leave the game. Please try again.");
        return;
      }
      setLeaveDialogOpen(false);
      setMenuOpen(false);
      router.push("/");
    } catch {
      setLeaveError("You could not leave the game. Please try again.");
    } finally {
      setLeavePending(false);
    }
  }, [gameId, isAdmin, leavePending, readOnly, router, sessionId]);

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
    <header style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.35rem", flex: "1 1 auto" }}>
          Beltline Bar Brawl
        </h1>
        <button
          type="button"
          aria-label="Open game menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          style={{ minWidth: "44px", minHeight: "44px", fontSize: "1.25rem" }}
        >
          ☰
        </button>
      </div>
      <div
        aria-label="Game join code"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
          minWidth: 0,
          fontSize: "0.9rem",
        }}
      >
        <span>Join code:</span>
        <strong
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            letterSpacing: "0.08em",
          }}
        >
          {view.joinCode ?? "Unavailable"}
        </strong>
      </div>
      <p
        role="status"
        aria-live="polite"
        style={{ margin: 0, fontSize: "0.8rem", color: "#555" }}
      >
        {`Game board · ${status}`}
      </p>
      {menuOpen ? (
        <div
          role="menu"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            width: "100%",
            maxWidth: "26rem",
            boxSizing: "border-box",
            padding: "0.6rem",
            border: "1px solid #888",
            borderRadius: "0.5rem",
            background: "#fff",
          }}
        >
          {isAdmin && !readOnly ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setEndGameError(null);
                setEndGameDialogOpen(true);
                setMenuOpen(false);
              }}
              disabled={endGamePending}
              style={{
                minHeight: "44px",
                textAlign: "left",
                border: "1px solid #b00020",
                color: "#ffffff",
                background: "#b00020",
                fontWeight: 700,
              }}
            >
              End Game
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (readOnly) {
                router.push("/");
                return;
              }
              setLeaveError(null);
              setLeaveDialogOpen(true);
              setMenuOpen(false);
            }}
            style={{
              minHeight: "44px",
              textAlign: "left",
              border: "1px solid #b00020",
              background: "#b00020",
              color: "#ffffff",
              fontWeight: 700,
            }}
          >
            Leave Game
          </button>
          {endGameError !== null ? (
            <p role="alert" style={{ margin: 0, color: "#b00020" }}>
              {endGameError}
            </p>
          ) : null}
        </div>
      ) : null}
      {leaveDialogOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="leave-game-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "grid",
            placeItems: "center",
            padding: "1rem",
            background: "rgba(0, 0, 0, 0.45)",
          }}
        >
          <section
            style={{
              width: "100%",
              maxWidth: "24rem",
              padding: "1rem",
              background: "#fff",
              borderRadius: "0.75rem",
            }}
          >
            <h2 id="leave-game-title">Leave game?</h2>
            <p>
              {isAdmin
                ? "Leaving will end the game for everyone and show the final scores."
                : "You will leave this game and disappear from your team roster. The game will continue for everyone else."}
            </p>
            {leaveError !== null ? <p role="alert">{leaveError}</p> : null}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "0.5rem",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setLeaveDialogOpen(false);
                  setLeaveError(null);
                }}
                disabled={leavePending}
                style={{ minHeight: "44px" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleLeaveGame()}
                disabled={leavePending}
                style={{ minHeight: "44px" }}
              >
                {leavePending ? "Leaving…" : "Leave Game"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
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

  // Both live and ended games render the board. Ended games remain available
  // for final map/score inspection, but gameplay mutations are read-only.
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
      {readOnly ? (
        <p role="status" style={noticeStyle}>
          This game has ended. The map and scoreboard are available in read-only
          mode.
        </p>
      ) : null}

      {endGameDialogOpen && isAdmin && !readOnly ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="end-game-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "grid",
            placeItems: "center",
            padding: "1rem",
            background: "rgba(0, 0, 0, 0.45)",
          }}
        >
          <section
            style={{
              width: "100%",
              maxWidth: "24rem",
              padding: "1rem",
              borderRadius: "0.75rem",
              background: "#ffffff",
              boxSizing: "border-box",
            }}
          >
            <h2 id="end-game-title" style={{ marginTop: 0 }}>
              End game?
            </h2>
            <p>
              Ending the game will stop gameplay for everyone and show the final
              scores. This cannot be undone.
            </p>
            {endGameError !== null ? (
              <p role="alert" style={{ color: "#b00020" }}>
                {endGameError}
              </p>
            ) : null}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "0.5rem",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setEndGameDialogOpen(false);
                  setEndGameError(null);
                }}
                disabled={endGamePending}
                style={{ minHeight: "44px", padding: "0.5rem 0.75rem" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleEndGame();
                }}
                disabled={endGamePending}
                style={{
                  minHeight: "44px",
                  padding: "0.5rem 0.75rem",
                  border: "1px solid #b00020",
                  borderRadius: "0.5rem",
                  background: "#b00020",
                  color: "#ffffff",
                  fontWeight: 700,
                }}
              >
                {endGamePending ? "Ending…" : "End Game"}
              </button>
            </div>
          </section>
        </div>
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

      {/* Card-behavior toasts (3.x): event toasts for this viewer with their
          pending actions, plus Boundary_Toasts, inline and non-modal. */}
      <ToastStack
        gameId={gameId}
        toasts={boardToasts}
        teams={view.teams}
        offers={view.cardBehavior.offers}
        isMirrorLegal={isMirrorLegal}
        onDismiss={handleDismissToast}
        postAction={toastPoster}
      />

      {/* Effects_Strip (20.7): pending/active timed effects with countdowns
          from server time (device clock corrected by the offset). */}
      <EffectsStrip
        effects={timedEffects}
        offsetMs={offsetMs}
        teams={view.teams}
      />

      {/* Region navigation: three controls, active one distinguished. While a
          draw is unresolved the nav is locked to the Cards region (UAT forced
          draw-resolution workflow). */}
      <RegionNav
        active={effectiveRegion}
        onSelect={handleSelectRegion}
        lockToCards={drawLocked}
      />

      {drawLocked ? (
        <p
          role="status"
          aria-live="polite"
          style={{
            margin: 0,
            padding: "0.6rem 0.75rem",
            border: "1px solid #1a1a1a",
            borderRadius: "0.5rem",
            fontSize: "0.85rem",
            background: "#fffbea",
            color: "#1a1a1a",
          }}
        >
          You drew cards. Keep one (or resolve the draw) below before doing
          anything else.
        </p>
      ) : null}

      {/* The active Region (exactly one displayed, R2.6). While a draw is
          unresolved this is pinned to the Cards region (effectiveRegion). */}
      {effectiveRegion === "map" ? (
        <MapRegion
          teams={mapTeams}
          claims={claimState}
          ownTeamId={ownTeamId}
          onMutate={handleClaimMutation}
          pendingBarId={pendingClaimBarId}
          mutationError={claimMutationError}
          readOnly={readOnly || drawLocked}
          claimBlocksByBar={claimBlocksByBar}
          bonusClaimableBarIds={bonusClaimableBarIds}
          onBonusClaim={handleBonusClaim}
          overlays={mapOverlays}
        />
      ) : null}
      {effectiveRegion === "scoreboard" ? (
        <ScoreboardRegion
          teams={view.teams}
          players={view.players}
          scoreTotals={scoreTotals}
          claimedBarCounts={claimedBarCounts}
        />
      ) : null}
      {effectiveRegion === "cards" ? (
        <>
          <CardsRegion
            cards={myCards}
            adminNotPlayer={adminNotPlayer}
            onKeepCard={(card) => {
              void handleCardMutation("keep", card.cardId);
            }}
            onDiscardCard={(card, reason) => {
              void handleCardMutation("discard", card.cardId, reason);
            }}
            onForfeitDraw={() => {
              void handleForfeitDraw();
            }}
            onPlayCard={(card) => {
              if (readOnly) {
                return;
              }
              setPlayError(null);
              setPlayServerError(null);
              setPlayingCard(card);
            }}
            readOnly={readOnly}
            pendingCardId={cardMutationPending}
            hasOpenUioli={uioliState.hasOpenUioli}
            fairestPromptPending={uioliState.fairestPromptPending}
          />
          {cardMutationError !== null ? (
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
              {cardMutationError}
            </p>
          ) : null}

          {/* Dev-only card injection (Task 10; R5.2). Rendered only when the
              committed DEV_CARD_INJECTION flag is on; the server enforces the
              flag independently (R5.3). */}
          {isDevCardInjectionEnabled() && !adminNotPlayer && !readOnly ? (
            <div
              aria-label="Dev: add card to hand"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.4rem",
                padding: "0.6rem",
                border: "1px dashed #9333ea",
                borderRadius: "0.5rem",
                background: "#faf5ff",
              }}
            >
              <p
                style={{
                  margin: 0,
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  color: "#6b21a8",
                }}
              >
                DEV: add a card to your hand (ignores hand limit)
              </p>
              <div style={{ display: "flex", gap: "0.4rem", width: "100%" }}>
                <select
                  aria-label="Card to inject"
                  value={injectSlug}
                  onChange={(e) => setInjectSlug(e.target.value)}
                  style={{
                    flex: "1 1 auto",
                    minHeight: "44px",
                    fontSize: "0.9rem",
                    borderRadius: "0.4rem",
                    border: "1px solid #888",
                    padding: "0 0.5rem",
                  }}
                >
                  {CARD_SLUGS.map((slug) => (
                    <option key={slug} value={slug}>
                      {getCardMetadata(slug).name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void handleInjectCard()}
                  disabled={injectPending}
                  style={{
                    minHeight: "44px",
                    minWidth: "44px",
                    padding: "0 0.9rem",
                    fontSize: "0.9rem",
                    fontWeight: 600,
                    borderRadius: "0.4rem",
                    border: "1px solid #6b21a8",
                    background: injectPending ? "#c4a3e0" : "#9333ea",
                    color: "#ffffff",
                    cursor: injectPending ? "not-allowed" : "pointer",
                  }}
                >
                  {injectPending ? "Adding…" : "Add card"}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {/* Card_Play_Panel, presented on play (R3.1). The target list excludes
          the caster's own team and grays out ineligible teams (R3.2/R3.3);
          confirm POSTs the real card_played and surfaces "not delivered" on
          failure. */}
      {playingCard !== null && !readOnly ? (
        <>
          <CardPlayPanel
            card={playingCard}
            view={view}
            teams={view.teams}
            castingTeamId={myTeamId ?? ""}
            bars={CANDIDATE_BARS}
            claims={claimState}
            finishBarId={null}
            targetContext={cardTargetCtx}
            pending={playPending}
            serverError={playServerError}
            onConfirm={(targets) => {
              void handleConfirmPlay(playingCard, targets);
            }}
            onCancel={() => {
              setPlayError(null);
              setPlayServerError(null);
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

      {/* Host_Card_Panel (21.10, 21.11): host-only while the game is live. */}
      {isAdmin && isLive ? (
        <HostCardPanel
          gameId={gameId}
          sessionId={sessionId}
          items={hostItems}
          teams={view.teams}
        />
      ) : null}
    </main>
  );
}
