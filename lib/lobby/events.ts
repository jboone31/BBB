/**
 * Lobby event types + pure reducer (design.md Component 2).
 *
 * The Game_Setup_&_Lobby feature does not maintain a separate "current lobby
 * state" table: like the rest of the foundation, the lobby's view of the world
 * is derived by folding the append-only `game_events` log (see
 * `supabase/migrations/0003_game_events.sql`) in ascending `seq` order. This
 * module supplies two things the UI needs on top of the generic snapshot fold in
 * `lib/realtime/snapshot.ts`:
 *
 *   1. The lobby `event_type` string constants ({@link LOBBY_EVENT_TYPES}) that
 *      the create/designate/join/team/start routes append (design.md "Lobby
 *      event payloads" table).
 *   2. A pure fold ({@link applyLobbyEvent} / {@link foldLobbyEvents}) that turns
 *      a game's lobby event log into a {@link LobbyView} the Lobby_Client renders.
 *
 * It plugs into the existing snapshot fold seam: the generic realtime
 * `applyEvent` (`lib/realtime/snapshot.ts`) advances the snapshot's
 * `lastSeenSequence`; this reducer mirrors that exact idempotence guard (ignore
 * any event with `seq <= lastSeenSequence`) while additionally interpreting the
 * lobby payloads to build the domain view. Sharing the guard means re-delivery
 * from the realtime transport never double-applies an event (Req 7.3), and the
 * fold of all events with `seq <= N` equals the snapshot loaded on subscribe
 * (Req 7.2).
 *
 * The module is pure and framework-free (no I/O, no Next.js), so it is the
 * property-test target for Properties 20 and 21 (Tasks 7.2, 7.3). It reuses the
 * {@link GameEvent} shape from `lib/events` so the reducer consumes exactly the
 * rows the event backbone produces.
 *
 * Requirements: 7.2, 7.3.
 */

import type { GameEvent } from "@/lib/events";

/**
 * The lobby `event_type` string constants (design.md "Lobby event payloads").
 *
 * Each lobby mutation appends exactly one `game_event` whose `event_type` is one
 * of these literals. Keeping them in one `as const` map gives the reducer a
 * single source of truth for the strings it interprets and lets callers (the
 * routes) reference them by name rather than duplicating the raw string.
 *
 *   - `game_created`   — a Game was created; carries its Join_Code (R1.6).
 *   - `bars_designated`— start/finish bars were designated (R2.7).
 *   - `player_joined`  — a Player joined the Game (R4.6).
 *   - `team_created`   — a Team was created with a name + color (R4.6).
 *   - `team_changed`   — a Player joined/switched Teams (R4.6).
 *   - `game_started`   — the Game transitioned `lobby → live` (R5.8).
 */
export const LOBBY_EVENT_TYPES = {
  gameCreated: "game_created",
  barsDesignated: "bars_designated",
  playerJoined: "player_joined",
  teamCreated: "team_created",
  teamChanged: "team_changed",
  gameStarted: "game_started",
} as const;

/** A lobby `event_type` string (one of {@link LOBBY_EVENT_TYPES}'s values). */
export type LobbyEventType =
  (typeof LOBBY_EVENT_TYPES)[keyof typeof LOBBY_EVENT_TYPES];

/** The lifecycle phases a Game moves through (mirrors `games.lifecycle`). */
export type LobbyLifecycle = "lobby" | "live" | "ended";

/**
 * A Team as seen in the lobby view: its id, display name, assigned color, and
 * the ids of players currently on it (design.md Component 2).
 */
export interface LobbyTeamView {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  /** Ids of players currently associated with this team. */
  readonly playerIds: string[];
}

/**
 * A Player as seen in the lobby view: its id, display name, and the team it is
 * on (or `null` before it has joined any team) (design.md Component 2).
 */
export interface LobbyPlayerView {
  readonly id: string;
  readonly displayName: string;
  readonly teamId: string | null;
}

/**
 * The folded lobby state the Lobby_Client renders (design.md Component 2).
 *
 * Everything here is derived purely from the game's lobby event log:
 *
 *   - `gameId`: the game this view describes.
 *   - `lifecycle`: `lobby` until a `game_started` event flips it to `live`.
 *   - `joinCode`: set by the `game_created` event; `null` before it is folded.
 *   - `startBarId` / `finishBarId`: set by `bars_designated`; `null` until then.
 *   - `teams` / `players`: the roster built up by team/player events.
 *   - `lastSeenSequence`: the highest `seq` folded in (the same watermark the
 *     generic snapshot fold tracks). Seeds the client's `Last_Seen_Sequence` and
 *     drives the idempotence guard in {@link applyLobbyEvent}.
 */
export interface LobbyView {
  readonly gameId: string;
  readonly lifecycle: LobbyLifecycle;
  readonly joinCode: string | null;
  readonly startBarId: string | null;
  readonly finishBarId: string | null;
  readonly teams: LobbyTeamView[];
  readonly players: LobbyPlayerView[];
  readonly lastSeenSequence: number;
}

/**
 * The `lastSeenSequence` of a view with no events folded in. Per-game `seq`
 * starts at 1 (see `FIRST_SEQ` in `lib/events`), so 0 unambiguously means
 * "nothing applied yet" — matching `NO_EVENTS_SEQ` in the generic snapshot fold.
 */
export const NO_EVENTS_SEQ = 0;

/**
 * The starting lobby view for a game before any event is applied (the base case
 * of the fold; design.md Component 2).
 *
 * @param gameId the game the (empty) view describes.
 * @returns a fresh {@link LobbyView} with no events folded in.
 */
export function initialLobbyView(gameId: string): LobbyView {
  return {
    gameId,
    lifecycle: "lobby",
    joinCode: null,
    startBarId: null,
    finishBarId: null,
    teams: [],
    players: [],
    lastSeenSequence: NO_EVENTS_SEQ,
  };
}

/**
 * Pure single-event reducer: fold one lobby event into the running view
 * (design.md Component 2; Req 7.2, 7.3).
 *
 * This is the atom {@link foldLobbyEvents} is built from. It is deliberately pure
 * and total: it returns a new view and never mutates its input, so folding is
 * order-deterministic and safe to re-run (e.g. on reconnect/resume).
 *
 * The event must belong to the view's game and advance the sequence:
 *
 *   - An event from another game is rejected outright, since a lobby view is
 *     single-game (Req 7.4 isolation), mirroring `applyEvent` in
 *     `lib/realtime/snapshot.ts`.
 *   - A stale or re-delivered event (`seq <= lastSeenSequence`) is ignored and
 *     the view is returned unchanged. This is the same idempotence guard the
 *     generic snapshot fold uses, so duplicate transport deliveries never
 *     double-apply (Req 7.3).
 *
 * On a fresh, in-order event the reducer advances `lastSeenSequence` to the
 * event's `seq` and interprets the payload by `event_type`. An unrecognized
 * `event_type` still advances the watermark (so the fold stays aligned with the
 * generic snapshot) but otherwise leaves the domain fields unchanged — later
 * features can add event types without stalling the lobby fold.
 *
 * @param view the running lobby view to fold into.
 * @param event the next event to apply.
 * @returns the resulting {@link LobbyView} (a new object; `view` is not mutated).
 * @throws {RangeError} if `event.gameId` does not match `view.gameId`.
 */
export function applyLobbyEvent(view: LobbyView, event: GameEvent): LobbyView {
  if (event.gameId !== view.gameId) {
    throw new RangeError(
      `applyLobbyEvent: event for game ${event.gameId} cannot be applied to a lobby view for game ${view.gameId}`,
    );
  }

  // Ignore stale/duplicate events: a view only moves forward in seq. This keeps
  // the reducer idempotent so re-delivered events do not double-apply (Req 7.3),
  // matching the guard in lib/realtime/snapshot.applyEvent.
  if (event.seq <= view.lastSeenSequence) {
    return view;
  }

  // Advance the watermark for every fresh event, then interpret the payload.
  const advanced: LobbyView = { ...view, lastSeenSequence: event.seq };

  switch (event.eventType) {
    case LOBBY_EVENT_TYPES.gameCreated:
      return applyGameCreated(advanced, event.payload);
    case LOBBY_EVENT_TYPES.barsDesignated:
      return applyBarsDesignated(advanced, event.payload);
    case LOBBY_EVENT_TYPES.playerJoined:
      return applyPlayerJoined(advanced, event.payload);
    case LOBBY_EVENT_TYPES.teamCreated:
      return applyTeamCreated(advanced, event.payload);
    case LOBBY_EVENT_TYPES.teamChanged:
      return applyTeamChanged(advanced, event.payload);
    case LOBBY_EVENT_TYPES.gameStarted:
      return { ...advanced, lifecycle: "live" };
    default:
      // Unknown/foreign event type: the watermark has advanced so the fold stays
      // aligned with the generic snapshot, but the lobby domain fields are left
      // untouched.
      return advanced;
  }
}

/**
 * Fold a set of a game's lobby events into a {@link LobbyView} by applying them
 * in ascending `seq` order (design.md Component 2; Req 7.2).
 *
 * This is the pure core Property 20 targets: for any event log up to sequence
 * `N`, `foldLobbyEvents(events with seq <= N)` equals the view applying those
 * events one at a time in ascending `seq` order to {@link initialLobbyView}, so
 * the snapshot loaded on subscribe equals the fold. The function does not assume
 * the input is pre-sorted — it sorts a copy by `seq` ascending first — so callers
 * can pass events in any arrival order and still get the canonical fold, and
 * duplicate `seq` values are de-duplicated by {@link applyLobbyEvent}'s guard
 * (Property 21).
 *
 * All events must belong to `gameId`; a foreign-game event is a programming error
 * and surfaces via {@link applyLobbyEvent}'s guard.
 *
 * @param gameId the game whose events are being folded.
 * @param events the events to fold (any order; only `seq <= N` should be passed
 *   to reflect "state up to N").
 * @returns the folded {@link LobbyView}.
 */
export function foldLobbyEvents(
  gameId: string,
  events: readonly GameEvent[],
): LobbyView {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  return ordered.reduce(applyLobbyEvent, initialLobbyView(gameId));
}

// ---------------------------------------------------------------------------
// Payload interpreters
//
// The event `payload` is typed `unknown` on GameEvent (it round-trips through
// jsonb), so each interpreter narrows the fields it reads defensively: a missing
// or wrong-typed field leaves the corresponding view field unchanged rather than
// throwing, keeping the fold total over any stored payload.
// ---------------------------------------------------------------------------

/** Read a string field from an unknown payload, or `undefined` if absent/wrong-typed. */
function readString(payload: unknown, key: string): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Apply `game_created`: record the Join_Code (design.md payload `{ joinCode }`). */
function applyGameCreated(view: LobbyView, payload: unknown): LobbyView {
  const joinCode = readString(payload, "joinCode");
  return joinCode === undefined ? view : { ...view, joinCode };
}

/**
 * Apply `bars_designated`: record start/finish bar ids (design.md payload
 * `{ startBarId, finishBarId }`).
 */
function applyBarsDesignated(view: LobbyView, payload: unknown): LobbyView {
  const startBarId = readString(payload, "startBarId");
  const finishBarId = readString(payload, "finishBarId");
  return {
    ...view,
    startBarId: startBarId ?? view.startBarId,
    finishBarId: finishBarId ?? view.finishBarId,
  };
}

/**
 * Apply `player_joined`: add the player to the roster (design.md payload
 * `{ playerId, displayName }`). A repeat join for the same player id is a no-op
 * (the roster holds at most one entry per player), reflecting the one-player-per
 * -(game, session) invariant (R3.8).
 */
function applyPlayerJoined(view: LobbyView, payload: unknown): LobbyView {
  const id = readString(payload, "playerId");
  const displayName = readString(payload, "displayName");
  if (id === undefined || displayName === undefined) {
    return view;
  }
  if (view.players.some((player) => player.id === id)) {
    return view;
  }
  const player: LobbyPlayerView = { id, displayName, teamId: null };
  return { ...view, players: [...view.players, player] };
}

/**
 * Apply `team_created`: add the team to the roster (design.md payload
 * `{ teamId, name, color }`). A repeat create for the same team id is a no-op.
 */
function applyTeamCreated(view: LobbyView, payload: unknown): LobbyView {
  const id = readString(payload, "teamId");
  const name = readString(payload, "name");
  const color = readString(payload, "color");
  if (id === undefined || name === undefined || color === undefined) {
    return view;
  }
  if (view.teams.some((team) => team.id === id)) {
    return view;
  }
  const team: LobbyTeamView = { id, name, color, playerIds: [] };
  return { ...view, teams: [...view.teams, team] };
}

/**
 * Apply `team_changed`: move a player from one team to another (design.md
 * payload `{ playerId, fromTeamId, toTeamId }`).
 *
 * The player's `teamId` is set to `toTeamId`, and the team rosters' `playerIds`
 * are updated to reflect exactly one association: the player is removed from
 * every team it was previously listed on (including `fromTeamId`) and added to
 * `toTeamId` (R4.5 — a switch yields exactly one team association).
 */
function applyTeamChanged(view: LobbyView, payload: unknown): LobbyView {
  const playerId = readString(payload, "playerId");
  const toTeamId = readString(payload, "toTeamId");
  if (playerId === undefined || toTeamId === undefined) {
    return view;
  }

  const players = view.players.map((player) =>
    player.id === playerId ? { ...player, teamId: toTeamId } : player,
  );

  const teams = view.teams.map((team) => {
    const without = team.playerIds.filter((pid) => pid !== playerId);
    if (team.id === toTeamId) {
      return { ...team, playerIds: [...without, playerId] };
    }
    return without.length === team.playerIds.length
      ? team
      : { ...team, playerIds: without };
  });

  return { ...view, players, teams };
}
