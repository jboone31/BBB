/**
 * Game_Board event types + pure reducer (design.md §Components 1, §Data Models).
 *
 * Like the lobby (`lib/lobby/events.ts`), the Game_Board does not maintain a
 * separate "current state" table: its view of the world is derived by folding the
 * append-only `game_events` log (see `supabase/migrations/0003_game_events.sql`)
 * in ascending `seq` order. This module supplies:
 *
 *   1. The Game_Board `event_type` string constants ({@link GAME_BOARD_EVENT_TYPES})
 *      the board interprets — a superset of the lobby types it needs plus the one
 *      new `wireframe_card_played` type this feature writes.
 *   2. A pure fold ({@link applyGameBoardEvent} / {@link foldGameBoardEvents}) that
 *      turns a game's event log into a {@link GameBoardView} the Game_Board_Client
 *      renders, plus {@link dismissTargetedNotice} for the notification dismissal
 *      (R7.5).
 *
 * It mirrors the lobby reducer's idempotence guard (ignore any event with
 * `seq <= lastSeenSequence`) and single-game isolation (reject a foreign
 * `gameId`), so re-delivery from the realtime transport never double-applies an
 * event (R8.3) and a board view only ever folds its own game's events (R8.4).
 *
 * The module is pure and framework-free (no I/O, no Next.js) so it is the
 * property-test target for Properties 4, 5, 9, and 10. It reuses the
 * {@link GameEvent} shape from `lib/events` so the reducer consumes exactly the
 * rows the event backbone produces.
 *
 * Requirements: 1.4, 4.1, 4.2, 7.5, 7.8, 8.2, 8.3, 8.4.
 */

import type { GameEvent } from "@/lib/events";
import type {
  AwardRecord,
  ChallengeRecord,
  ChallengeStatus,
  FairestOfferRecord,
  FairestOfferStatus,
} from "@/lib/cards/behaviorState";
import type { EffectKind, EffectRecord } from "@/lib/cards/effects";
import type { CastingParams } from "@/lib/cards/inputs";
import type { CardSlug } from "@/lib/cards/catalog";

/**
 * The Game_Board `event_type` string constants (design.md §Components 1).
 *
 * A superset of the lobby event types the board needs to fold (`game_created` /
 * `team_created` for scoreboard Team identities/colors, `game_started` /
 * `game_ended` for the lifecycle gate) plus the one new type this feature writes:
 *
 *   - `game_created`         — a Game was created (carries Team-less game facts).
 *   - `team_created`         — a Team was created with a name + color (R4.1, R4.2).
 *   - `player_joined`        — a Player joined the Game (R4.4).
 *   - `team_changed`         — a Player joined or switched Teams (R4.4).
 *   - `player_left`          — a Player left the Game (R4.4).
 *   - `game_started`         — the Game transitioned `lobby → live`.
 *   - `game_ended`           — the Game transitioned to `ended` (R1.4).
 *   - `wireframe_card_played`— a wireframe targeting card play; folded into a
 *     {@link TargetedNotice} for the target Team (R7).
 */
export const GAME_BOARD_EVENT_TYPES = {
  gameCreated: "game_created",
  barsDesignated: "bars_designated",
  teamCreated: "team_created",
  playerJoined: "player_joined",
  teamChanged: "team_changed",
  playerLeft: "player_left",
  gameStarted: "game_started",
  gameEnded: "game_ended",
  deckSeeded: "deck_seeded",
  cardsDrawn: "cards_drawn",
  cardKept: "card_kept",
  cardDiscarded: "card_discarded",
  cardPlayed: "card_played",
  challengeIssued: "challenge_issued",
  challengeConfirmed: "challenge_confirmed",
  challengeRejected: "challenge_rejected",
  effectCreated: "effect_created",
  effectActivated: "effect_activated",
  effectExpired: "effect_expired",
  claimBlocked: "claim_blocked",
  claimRecorded: "claim_recorded",
  claimRemoved: "claim_removed",
  scoreAwarded: "score_awarded",
  scoreModifierApplied: "score_modifier_applied",
  notificationCreated: "notification_created",
  wireframeCardPlayed: "wireframe_card_played",
  // Card-behavior mutation events carrying embedded records (design.md §Projection
  // Changes). Each one also runs applyRecordSections, upserting the challenge,
  // offer, effect, and award records it embeds by id.
  challengeResolved: "challenge_resolved",
  fairestDecided: "fairest_decided",
  happyHourBonusClaimed: "happy_hour_bonus_claimed",
  hostOverrideApplied: "host_override_applied",
} as const;

/** A Game_Board `event_type` string (one of {@link GAME_BOARD_EVENT_TYPES}'s values). */
export type GameBoardEventType =
  (typeof GAME_BOARD_EVENT_TYPES)[keyof typeof GAME_BOARD_EVENT_TYPES];

/** The lifecycle phases a Game moves through (mirrors `games.lifecycle`). */
export type GameBoardLifecycle = "lobby" | "live" | "ended";

/**
 * A Team as seen on the Game_Board: its id, display name, and assigned color
 * (design.md §Components 1). Drives the Scoreboard_Region rows (R4.1, R4.2) and
 * the Card_Play_Wireframe target list (R6.2).
 */
export interface BoardTeamView {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

/** A Player as seen on the Game_Board scoreboard roster. */
export interface BoardPlayerView {
  readonly id: string;
  readonly displayName: string;
  readonly teamId: string | null;
}

/**
 * One pending targeted notification folded from a `wireframe_card_played` event
 * (design.md §Components 1; R7).
 */
export interface TargetedNotice {
  /** The event `seq` that produced it — the stable identity for de-dup + dismissal. */
  readonly seq: number;
  readonly castingTeamId: string;
  readonly targetTeamId: string;
  readonly cardId: string;
}

export type BoardCardState =
  "deck" | "pending" | "hand" | "played" | "discarded";

export interface BoardCardView {
  readonly cardId: string;
  readonly teamId: string;
  readonly slug: string;
  readonly state: BoardCardState;
}

/**
 * One recorded `card_played` targeting fact (brawl-deck-architecture Task 8).
 *
 * Folded from each `card_played` event so eligibility selectors can enforce
 * "no team targeted by a card of the same name more than once" (R3.3) and show
 * ineligible targets grayed out (R3.2). `targetTeamId` / `targetBarId` are null
 * for a play that did not target that dimension (e.g. a self/none card).
 */
export interface BoardCardPlayView {
  /** The event `seq` that recorded the play — its stable identity for de-dup. */
  readonly seq: number;
  readonly slug: string;
  readonly castingTeamId: string;
  readonly targetTeamId: string | null;
  readonly targetBarId: string | null;
}

export interface BoardChallengeView {
  readonly challengeId: string;
  readonly sourcePlayId: string;
  readonly casterTeamId: string;
  readonly targetTeamId: string;
  readonly status: string;
  readonly blocksClaims: boolean;
}

export interface BoardEffectView {
  readonly effectId: string;
  readonly sourcePlayId: string;
  readonly effectType: string;
  readonly ownerTeamId: string | null;
  readonly targetTeamId: string | null;
  readonly targetBarId: string | null;
  readonly active: boolean;
}

export interface BoardNotificationView {
  readonly notificationId: string;
  readonly sourcePlayId: string | null;
  readonly audience: string;
  readonly teamId: string | null;
  readonly display: Readonly<Record<string, unknown>>;
}

export interface BoardClaimView {
  readonly claimId: string;
  readonly barId: string;
  readonly teamId: string;
}

export interface BoardScoreEntryView {
  readonly entryId: string;
  readonly teamId: string;
  readonly category: string;
  readonly points: number;
  readonly sourceId: string | null;
}

// ---------------------------------------------------------------------------
// Card-behavior projection slice (design.md §Projection Changes).
//
// `GameBoardView.cardBehavior` is the time-independent fold of the card-behavior
// events: the embedded challenge / offer / effect / award records (upserted by
// id, a later seq replacing an earlier one), the card plays, and a seq-ordered,
// deduped list of toast descriptors. Time is only an input to selectors
// (lib/gameboard/cardBehavior.ts, task 9.2), so the fold stays deterministic and
// snapshot-equivalent.
// ---------------------------------------------------------------------------

/**
 * One recorded `card_played` fact in the card-behavior slice: the slug, caster,
 * optional team / bar target, validated casting params, and the event `seq` /
 * `createdAt` for ordering. Keyed by `playId` in {@link CardBehaviorView.plays}.
 */
export interface PlayView {
  readonly playId: string;
  readonly slug: CardSlug;
  readonly casterTeamId: string;
  readonly targetTeamId: string | null;
  readonly barKey: string | null;
  readonly params: CastingParams;
  readonly seq: number;
  readonly createdAt: string;
}

/**
 * A toast descriptor folded from a toast-producing card-behavior event
 * (design.md §Projection Changes). Descriptors are seq-ordered and deduped by
 * {@link ToastEvent.id}; `deriveToasts` (task 9.4) renders them per viewer. The
 * fold stores the audience-independent facts only — the subject the toast is
 * about and the source event — so selectors route and template them.
 *
 * Effect transition events (`effect_activated` / `effect_expired`) push no toast
 * events; their boundary toasts come from `deriveBoundaryToasts` (task 9.7).
 */
export interface ToastEvent {
  /** Stable identity: `${seq}:${kind}:${subjectId}`, deduped across folds. */
  readonly id: string;
  readonly seq: number;
  readonly kind: ToastEventKind;
  /** The record the toast is about (playId, challengeId, offerId, or effectId). */
  readonly subjectId: string;
}

/**
 * The kinds of toast-producing card-behavior event the fold records. `deriveToasts`
 * maps each to the per-viewer toast copy; the projection stays audience-agnostic.
 */
export type ToastEventKind =
  | "play" // card_played
  | "challenge_resolved" // challenge_resolved
  | "fairest_decided" // fairest_decided (mirror / mirror_others)
  | "bonus_claimed" // happy_hour_bonus_claimed
  | "host_override" // host_override_applied
  | "payout"; // score_awarded patient_investor_award

/**
 * The time-independent card-behavior fold (design.md §Projection Changes).
 *
 *   - `plays`: `card_played` facts keyed by `playId`.
 *   - `challenges` / `offers` / `effects` / `awards`: the embedded records,
 *     upserted by id (a later seq replaces an earlier one).
 *   - `toastEvents`: seq-ordered, deduped toast descriptors (no effect-transition
 *     toasts; boundary toasts are derived separately).
 */
export interface CardBehaviorView {
  readonly plays: Readonly<Record<string, PlayView>>;
  readonly challenges: Readonly<Record<string, ChallengeRecord>>;
  readonly offers: Readonly<Record<string, FairestOfferRecord>>;
  readonly effects: Readonly<Record<string, EffectRecord>>;
  readonly awards: Readonly<Record<string, AwardRecord>>;
  readonly toastEvents: readonly ToastEvent[];
}

/** The empty card-behavior slice (the base case of the fold). */
export function initialCardBehaviorView(): CardBehaviorView {
  return {
    plays: {},
    challenges: {},
    offers: {},
    effects: {},
    awards: {},
    toastEvents: [],
  };
}

/**
 * The folded Game_Board state the Game_Board_Client renders (design.md
 * §Components 1, §Data Models).
 *
 * Everything here is derived purely from the game's event log:
 *
 *   - `gameId`: the game this view describes.
 *   - `lifecycle`: `lobby` until `game_started` flips it to `live`, then `ended`
 *     on `game_ended` — drives the access gate (R1).
 *   - `teams`: the Team roster (id, name, color) built from `game_created` /
 *     `team_created`; the scoreboard rows + target list.
 *   - `players`: the current player roster, updated by membership events and
 *     rendered under the assigned Team on the scoreboard.
 *   - `targetedNotices`: one notice per `wireframe_card_played` event (R7.8);
 *     folded for all teams, filtered to the viewing Team by the client (R7.3).
 *   - `lastSeenSequence`: the highest `seq` folded in — the idempotence watermark
 *     (mirrors the lobby/realtime guard).
 */
export interface GameBoardView {
  readonly gameId: string;
  readonly lifecycle: GameBoardLifecycle;
  readonly joinCode: string | null;
  /**
   * The board-facing key of the game's start bar (a candidate slug), or null
   * until a `bars_designated` event carries it. Excludes the start bar from
   * Voted Off the Island targeting (design.md section 9) and classifies it as a
   * `start` bar in the selector context.
   */
  readonly startBarKey: string | null;
  /**
   * The board-facing key of the game's finish bar (a candidate slug), or null
   * until a `bars_designated` event carries it. Excludes the finish bar from
   * every bar-target card and supplies the finish coordinates the Cancel Culture
   * radius rule needs.
   */
  readonly finishBarKey: string | null;
  readonly teams: BoardTeamView[];
  readonly players: BoardPlayerView[];
  /** Notices whose `targetTeamId` is the viewing team; one per targeting event (R7.8). */
  readonly targetedNotices: TargetedNotice[];
  readonly cards: BoardCardView[];
  /** Recorded card-play targeting facts, in `seq` order (R3.3 eligibility). */
  readonly cardPlays: BoardCardPlayView[];
  readonly activeChallenges: BoardChallengeView[];
  readonly activeEffects: BoardEffectView[];
  readonly activeRestrictions: BoardEffectView[];
  readonly notifications: BoardNotificationView[];
  readonly activeClaims: BoardClaimView[];
  readonly scoreEntries: BoardScoreEntryView[];
  /**
   * The card-behavior fold (design.md §Projection Changes): embedded challenge /
   * offer / effect / award records, card plays, and toast descriptors. The
   * `activeChallenges` / `activeEffects` / `activeRestrictions` / `notifications`
   * fields above remain as deprecated read-only aliases for the legacy wireframe
   * events until their selectors move onto this slice (task 9.2).
   */
  readonly cardBehavior: CardBehaviorView;
  readonly lastSeenSequence: number;
}

/**
 * The `lastSeenSequence` of a view with no events folded in. Per-game `seq`
 * starts at 1 (see `FIRST_SEQ` in `lib/events`), so 0 unambiguously means
 * "nothing applied yet" — matching `NO_EVENTS_SEQ` in the generic snapshot fold.
 */
export const NO_EVENTS_SEQ = 0;

/**
 * The starting Game_Board view for a game before any event is applied (the base
 * case of the fold; design.md §Components 1).
 *
 * @param gameId the game the (empty) view describes.
 * @returns a fresh {@link GameBoardView} with no events folded in.
 */
export function initialGameBoardView(gameId: string): GameBoardView {
  return {
    gameId,
    lifecycle: "lobby",
    joinCode: null,
    startBarKey: null,
    finishBarKey: null,
    teams: [],
    players: [],
    targetedNotices: [],
    cards: [],
    cardPlays: [],
    activeChallenges: [],
    activeEffects: [],
    activeRestrictions: [],
    notifications: [],
    activeClaims: [],
    scoreEntries: [],
    cardBehavior: initialCardBehaviorView(),
    lastSeenSequence: NO_EVENTS_SEQ,
  };
}

/**
 * Pure single-event reducer: fold one event into the running Game_Board view
 * (design.md §Components 1; R8.3, R8.4). Idempotent (ignores
 * `seq <= lastSeenSequence`) and single-game (rejects a foreign `gameId`).
 *
 * @param view the running Game_Board view to fold into.
 * @param event the next event to apply.
 * @returns the resulting {@link GameBoardView} (a new object; `view` is not mutated).
 * @throws {RangeError} if `event.gameId` does not match `view.gameId`.
 */
export function applyGameBoardEvent(
  view: GameBoardView,
  event: GameEvent,
): GameBoardView {
  if (event.gameId !== view.gameId) {
    throw new RangeError(
      `applyGameBoardEvent: event for game ${event.gameId} cannot be applied to a Game_Board view for game ${view.gameId}`,
    );
  }

  // Ignore stale/duplicate events: a view only moves forward in seq. This keeps
  // the reducer idempotent so re-delivered events do not double-apply (R8.3),
  // matching the guard in lib/lobby/events.applyLobbyEvent.
  if (event.seq <= view.lastSeenSequence) {
    return view;
  }

  // Advance the watermark for every fresh event, then interpret the payload.
  const advanced: GameBoardView = { ...view, lastSeenSequence: event.seq };

  // Run the type-specific handler first, then fold the embedded card-behavior
  // record sections (challenges, offers, effects, awards, scoreEntries,
  // removedClaims) for every event (design.md §Projection Changes). The record
  // fold is keyed on camelCase record ids the routes embed, so legacy wireframe
  // events (which carry none) leave `cardBehavior` untouched.
  const interpreted = interpret();
  return applyRecordSections(interpreted, event);

  function interpret(): GameBoardView {
    switch (event.eventType) {
      case GAME_BOARD_EVENT_TYPES.gameCreated:
        return applyGameCreated(advanced, event.payload);
      case GAME_BOARD_EVENT_TYPES.barsDesignated:
        return applyBarsDesignated(advanced, event.payload);
      case GAME_BOARD_EVENT_TYPES.teamCreated:
        return applyTeamFromPayload(advanced, event.payload);
      case GAME_BOARD_EVENT_TYPES.playerJoined:
        return applyPlayerJoined(advanced, event.payload);
      case GAME_BOARD_EVENT_TYPES.teamChanged:
        return applyTeamChanged(advanced, event.payload);
      case GAME_BOARD_EVENT_TYPES.playerLeft:
        return applyPlayerLeft(advanced, event.payload);
      case GAME_BOARD_EVENT_TYPES.gameStarted:
        return { ...advanced, lifecycle: "live" };
      case GAME_BOARD_EVENT_TYPES.gameEnded:
        return applyGameEnded(advanced, event);
      case GAME_BOARD_EVENT_TYPES.deckSeeded:
      case GAME_BOARD_EVENT_TYPES.cardsDrawn:
      case GAME_BOARD_EVENT_TYPES.cardKept:
      case GAME_BOARD_EVENT_TYPES.cardDiscarded:
        return applyCardInventoryEvent(advanced, event);
      case GAME_BOARD_EVENT_TYPES.cardPlayed:
        // A play updates the card inventory AND records a targeting fact so
        // eligibility selectors can enforce the same-name-once rule (R3.3),
        // records a PlayView, and pushes a `play` toast event.
        return applyCardPlayed(applyCardInventoryEvent(advanced, event), event);
      case GAME_BOARD_EVENT_TYPES.challengeIssued:
        return applyChallengeIssued(advanced, event.payload);
      case GAME_BOARD_EVENT_TYPES.challengeConfirmed:
      case GAME_BOARD_EVENT_TYPES.challengeRejected:
        return applyChallengeResolved(advanced, event.payload);
      case GAME_BOARD_EVENT_TYPES.effectCreated:
        return applyEffectCreated(advanced, event.payload);
      case GAME_BOARD_EVENT_TYPES.effectActivated:
      case GAME_BOARD_EVENT_TYPES.effectExpired:
        // New card-behavior transition events carry an embedded effect record
        // (no legacy `effectType`): `applyRecordSections` upserts it, and
        // `applyEffectTransition` sets its startAnnounced / endAnnounced flag.
        // They push no toast events. Legacy wireframe effect payloads
        // (`effectType` + `sourcePlayId`, no `effects` array) still fold through
        // the deprecated aliases below.
        return applyEffectTransition(
          event.eventType === GAME_BOARD_EVENT_TYPES.effectActivated
            ? applyEffectCreated(advanced, event.payload)
            : removeExpiredEffect(advanced, event.payload),
          event,
        );
      case GAME_BOARD_EVENT_TYPES.notificationCreated:
        return applyNotificationCreated(advanced, event.payload);
      case GAME_BOARD_EVENT_TYPES.scoreAwarded:
        // A patient_investor_award entry also pushes a payout toast event.
        return applyScorePayoutToast(
          applyScoreEntry(advanced, event.payload),
          event,
        );
      case GAME_BOARD_EVENT_TYPES.scoreModifierApplied:
        return applyScoreEntry(advanced, event.payload);
      case GAME_BOARD_EVENT_TYPES.claimBlocked:
        return advanced;
      case GAME_BOARD_EVENT_TYPES.claimRecorded:
        return applyClaimRecorded(advanced, event.payload);
      case GAME_BOARD_EVENT_TYPES.claimRemoved:
        return applyClaimRemoved(advanced, event.payload);
      case GAME_BOARD_EVENT_TYPES.challengeResolved:
        return pushToastEvent(
          advanced,
          event,
          "challenge_resolved",
          "challengeId",
        );
      case GAME_BOARD_EVENT_TYPES.fairestDecided:
        // A Fairest decision moves the Fairest card to `played`, so it also folds
        // through the inventory handler for its `cards` section (design.md).
        return pushToastEvent(
          applyCardInventoryEvent(advanced, event),
          event,
          "fairest_decided",
          "offerId",
        );
      case GAME_BOARD_EVENT_TYPES.happyHourBonusClaimed:
        return pushToastEventFirstKey(advanced, event, "bonus_claimed", [
          "barKey",
          "effectId",
        ]);
      case GAME_BOARD_EVENT_TYPES.hostOverrideApplied:
        // A host override targets either a challenge (clear/reset) or an effect
        // (end early); key the toast on whichever id the payload carries.
        return pushToastEventFirstKey(advanced, event, "host_override", [
          "challengeId",
          "effectId",
        ]);
      case GAME_BOARD_EVENT_TYPES.wireframeCardPlayed:
        return applyWireframeCardPlayed(advanced, event);
      default:
        // Unknown/foreign event type: the watermark has advanced so the fold
        // stays aligned with the generic snapshot, but the board domain fields
        // are left untouched. `applyRecordSections` still runs so any embedded
        // records are folded.
        return advanced;
    }
  }

  function applyGameCreated(
    view: GameBoardView,
    payload: unknown,
  ): GameBoardView {
    const joinCode = readString(payload, "joinCode");
    return joinCode === undefined ? view : { ...view, joinCode };
  }

  /**
   * Fold `bars_designated`: record the board-facing start/finish bar keys
   * (candidate slugs) the bars route resolves alongside the raw bar uuids. The
   * board keys bars by candidate slug, so the raw `startBarId` / `finishBarId`
   * uuids in the payload are ignored here; only `startBarKey` / `finishBarKey`
   * feed the eligibility selectors. Each side only changes when its key is
   * present, so re-designating one side leaves the other untouched.
   */
  function applyBarsDesignated(
    view: GameBoardView,
    payload: unknown,
  ): GameBoardView {
    const startBarKey = readString(payload, "startBarKey");
    const finishBarKey = readString(payload, "finishBarKey");
    if (startBarKey === undefined && finishBarKey === undefined) {
      return view;
    }
    return {
      ...view,
      startBarKey: startBarKey ?? view.startBarKey,
      finishBarKey: finishBarKey ?? view.finishBarKey,
    };
  }
}

function applyPlayerJoined(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const playerId = readString(payload, "playerId");
  const displayName = readString(payload, "displayName");
  if (playerId === undefined || displayName === undefined) {
    return view;
  }
  if (view.players.some((player) => player.id === playerId)) {
    return view;
  }
  return {
    ...view,
    players: [...view.players, { id: playerId, displayName, teamId: null }],
  };
}

function applyTeamChanged(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const playerId = readString(payload, "playerId");
  const toTeamId = readString(payload, "toTeamId");
  if (
    playerId === undefined ||
    toTeamId === undefined ||
    !view.teams.some((team) => team.id === toTeamId)
  ) {
    return view;
  }
  return {
    ...view,
    players: view.players.map((player) =>
      player.id === playerId ? { ...player, teamId: toTeamId } : player,
    ),
  };
}

function applyPlayerLeft(view: GameBoardView, payload: unknown): GameBoardView {
  const playerId = readString(payload, "playerId");
  if (playerId === undefined) {
    return view;
  }
  const players = view.players.filter((player) => player.id !== playerId);
  return players.length === view.players.length ? view : { ...view, players };
}

/**
 * Fold a set of a game's events into a {@link GameBoardView} by applying them in
 * ascending `seq` order (design.md §Components 1; R8.2).
 *
 * @param gameId the game whose events are being folded.
 * @param events the events to fold (any arrival order; duplicates tolerated).
 * @returns the folded {@link GameBoardView}.
 */
export function foldGameBoardEvents(
  gameId: string,
  events: readonly GameEvent[],
): GameBoardView {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  return ordered.reduce(applyGameBoardEvent, initialGameBoardView(gameId));
}

/**
 * Remove a folded notice by its producing event `seq`, leaving all other notices
 * unchanged (design.md §Components 1; R7.5 dismissal).
 *
 * @param view the current Game_Board view.
 * @param seq the producing event `seq` of the notice to dismiss.
 * @returns a new {@link GameBoardView} without the named notice.
 */
export function dismissTargetedNotice(
  view: GameBoardView,
  seq: number,
): GameBoardView {
  const remaining = view.targetedNotices.filter((notice) => notice.seq !== seq);
  // Nothing matched: return the view unchanged so dismissal of an absent notice
  // is a no-op rather than allocating an equivalent view.
  if (remaining.length === view.targetedNotices.length) {
    return view;
  }
  return { ...view, targetedNotices: remaining };
}

/** Return active claims grouped by bar, preserving event order within each bar. */
export function selectActiveClaimsByBar(
  view: GameBoardView,
): Readonly<Record<string, readonly BoardClaimView[]>> {
  const grouped: Record<string, BoardClaimView[]> = {};
  for (const claim of view.activeClaims) {
    (grouped[claim.barId] ??= []).push(claim);
  }
  return grouped;
}

/** Return the map-compatible active claimant team ids grouped by bar. */
export function selectClaimState(
  view: GameBoardView,
): Readonly<Record<string, readonly string[]>> {
  const grouped = selectActiveClaimsByBar(view);
  return Object.fromEntries(
    Object.entries(grouped).map(([barId, claims]) => [
      barId,
      claims.map((claim) => claim.teamId),
    ]),
  );
}

/** Return deterministic signed score totals keyed by team id. */
export function selectScoreTotals(
  view: GameBoardView,
): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const entry of view.scoreEntries) {
    totals[entry.teamId] = (totals[entry.teamId] ?? 0) + entry.points;
  }
  return totals;
}

/** Return active claimed-bar counts keyed by team id. */
export function selectClaimedBarCounts(
  view: GameBoardView,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const claim of view.activeClaims) {
    counts[claim.teamId] = (counts[claim.teamId] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Payload interpreters
//
// The event `payload` is typed `unknown` on GameEvent (it round-trips through
// jsonb), so each interpreter narrows the fields it reads defensively: a missing
// or wrong-typed field leaves the corresponding view field unchanged rather than
// throwing, keeping the fold total over any stored payload. This mirrors the
// lobby reducer's defensive payload reads (lib/lobby/events.ts).
// ---------------------------------------------------------------------------

/** Read a string field from an unknown payload, or `undefined` if absent/wrong-typed. */
function readString(payload: unknown, key: string): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(payload: unknown, key: string): number | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readBoolean(payload: unknown, key: string): boolean | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function readRecords(payload: unknown, key: string): Record<string, unknown>[] {
  if (payload === null || typeof payload !== "object") {
    return [];
  }
  const value = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
}

function readRecord(payload: unknown): Record<string, unknown> | undefined {
  return payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function cardFromRecord(
  record: Record<string, unknown>,
  fallbackState: BoardCardState,
): BoardCardView | undefined {
  const cardId = typeof record.cardId === "string" ? record.cardId : undefined;
  const teamId = typeof record.teamId === "string" ? record.teamId : undefined;
  const slug = typeof record.slug === "string" ? record.slug : undefined;
  const state = typeof record.state === "string" ? record.state : fallbackState;
  if (
    cardId === undefined ||
    teamId === undefined ||
    slug === undefined ||
    !["deck", "pending", "hand", "played", "discarded"].includes(state)
  ) {
    return undefined;
  }
  return { cardId, teamId, slug, state: state as BoardCardState };
}

function upsertCard(
  cards: readonly BoardCardView[],
  card: BoardCardView,
): BoardCardView[] {
  const withoutCard = cards.filter((entry) => entry.cardId !== card.cardId);
  return [...withoutCard, card];
}

function applyCardInventoryEvent(
  view: GameBoardView,
  event: GameEvent,
): GameBoardView {
  const fallbackState: BoardCardState =
    event.eventType === GAME_BOARD_EVENT_TYPES.cardsDrawn
      ? "pending"
      : event.eventType === GAME_BOARD_EVENT_TYPES.cardKept
        ? "hand"
        : event.eventType === GAME_BOARD_EVENT_TYPES.cardDiscarded
          ? "discarded"
          : event.eventType === GAME_BOARD_EVENT_TYPES.cardPlayed
            ? "played"
            : "deck";
  const payloadRecord = readRecord(event.payload);
  const records = readRecords(event.payload, "cards");
  if (records.length === 0 && payloadRecord !== undefined) {
    records.push(payloadRecord);
  }
  const cards = records
    .map((record) => cardFromRecord(record, fallbackState))
    .filter((card): card is BoardCardView => card !== undefined)
    .reduce(upsertCard, view.cards);
  return cards.length === view.cards.length &&
    cards.every((card, index) => card === view.cards[index])
    ? view
    : { ...view, cards };
}

/**
 * Fold a `card_played` event's targeting fact into {@link GameBoardView.cardPlays}
 * (R3.3). The slug is read from the play payload (`slug`) or, failing that, from
 * the first card record in `cards`. A play missing a slug records nothing (the
 * inventory fold still applies). De-duped by event `seq`.
 */
function applyCardPlayed(view: GameBoardView, event: GameEvent): GameBoardView {
  const payload = readRecord(event.payload);
  const slug =
    readString(event.payload, "slug") ??
    (readRecords(event.payload, "cards")[0]?.slug as string | undefined);
  if (payload === undefined || typeof slug !== "string") {
    return view;
  }
  if (view.cardPlays.some((play) => play.seq === event.seq)) {
    return view;
  }
  const castingTeamId =
    readString(event.payload, "castingTeamId") ??
    readString(event.payload, "teamId");
  if (castingTeamId === undefined) {
    return view;
  }
  const play: BoardCardPlayView = {
    seq: event.seq,
    slug,
    castingTeamId,
    targetTeamId: readString(event.payload, "targetTeamId") ?? null,
    targetBarId: readString(event.payload, "targetBarId") ?? null,
  };
  const withLegacyPlay: GameBoardView = {
    ...view,
    cardPlays: [...view.cardPlays, play],
  };

  // Record the card-behavior PlayView (keyed by playId) and a `play` toast
  // descriptor. A play missing a `playId` records neither (the legacy cardPlays
  // fact above still applies).
  const playId = readString(event.payload, "playId");
  if (playId === undefined) {
    return withLegacyPlay;
  }
  const playView: PlayView = {
    playId,
    slug: slug as CardSlug,
    casterTeamId: castingTeamId,
    targetTeamId: readString(event.payload, "targetTeamId") ?? null,
    barKey:
      readString(event.payload, "barKey") ??
      readString(event.payload, "targetBarKey") ??
      null,
    params: readCastingParams(event.payload),
    seq: event.seq,
    createdAt: event.createdAt,
  };
  const plays = { ...withLegacyPlay.cardBehavior.plays, [playId]: playView };
  const withPlay: GameBoardView = {
    ...withLegacyPlay,
    cardBehavior: { ...withLegacyPlay.cardBehavior, plays },
  };
  return pushToastEvent(withPlay, event, "play", "playId");
}

function applyChallengeIssued(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const challengeId = readString(payload, "challengeId");
  const sourcePlayId = readString(payload, "sourcePlayId");
  const casterTeamId = readString(payload, "casterTeamId");
  const targetTeamId = readString(payload, "targetTeamId");
  if (
    challengeId === undefined ||
    sourcePlayId === undefined ||
    casterTeamId === undefined ||
    targetTeamId === undefined
  ) {
    return view;
  }
  if (
    view.activeChallenges.some(
      (challenge) => challenge.challengeId === challengeId,
    )
  ) {
    return view;
  }
  const challenge: BoardChallengeView = {
    challengeId,
    sourcePlayId,
    casterTeamId,
    targetTeamId,
    status: readString(payload, "status") ?? "awaiting_confirmation",
    blocksClaims: readBoolean(payload, "blocksClaims") ?? true,
  };
  return { ...view, activeChallenges: [...view.activeChallenges, challenge] };
}

function applyChallengeResolved(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const challengeId = readString(payload, "challengeId");
  if (challengeId === undefined) {
    return view;
  }
  return {
    ...view,
    activeChallenges: view.activeChallenges.filter(
      (challenge) => challenge.challengeId !== challengeId,
    ),
  };
}

function applyEffectCreated(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const effectId = readString(payload, "effectId");
  const sourcePlayId = readString(payload, "sourcePlayId");
  const effectType = readString(payload, "effectType");
  if (
    effectId === undefined ||
    sourcePlayId === undefined ||
    effectType === undefined
  ) {
    return view;
  }
  const effect: BoardEffectView = {
    effectId,
    sourcePlayId,
    effectType,
    ownerTeamId: readString(payload, "ownerTeamId") ?? null,
    targetTeamId: readString(payload, "targetTeamId") ?? null,
    targetBarId: readString(payload, "targetBarId") ?? null,
    active: readBoolean(payload, "active") ?? true,
  };
  const effects = view.activeEffects.filter(
    (entry) => entry.effectId !== effectId,
  );
  const activeEffects = [...effects, effect];
  const activeRestrictions = activeEffects.filter(isRestrictionEffect);
  return { ...view, activeEffects, activeRestrictions };
}

function isRestrictionEffect(effect: BoardEffectView): boolean {
  return /block|restriction|lock/i.test(effect.effectType);
}

function removeExpiredEffect(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const id = readString(payload, "effectId");
  if (id === undefined) {
    return view;
  }
  return {
    ...view,
    activeEffects: view.activeEffects.filter((entry) => entry.effectId !== id),
    activeRestrictions: view.activeRestrictions.filter(
      (entry) => entry.effectId !== id,
    ),
  };
}

function applyNotificationCreated(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const notificationId = readString(payload, "notificationId");
  const audience = readString(payload, "audience");
  if (notificationId === undefined || audience === undefined) {
    return view;
  }
  if (
    view.notifications.some(
      (notification) => notification.notificationId === notificationId,
    )
  ) {
    return view;
  }
  const display = readRecord(payload)?.display;
  const notification: BoardNotificationView = {
    notificationId,
    sourcePlayId: readString(payload, "sourcePlayId") ?? null,
    audience,
    teamId: readString(payload, "teamId") ?? null,
    display:
      display !== null && typeof display === "object" && !Array.isArray(display)
        ? (display as Readonly<Record<string, unknown>>)
        : {},
  };
  return { ...view, notifications: [...view.notifications, notification] };
}

function applyClaimRecorded(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const claimId = readString(payload, "claimId");
  const barId = readString(payload, "barId");
  const teamId = readString(payload, "teamId");
  if (claimId === undefined || barId === undefined || teamId === undefined) {
    return view;
  }
  if (view.activeClaims.some((claim) => claim.claimId === claimId)) {
    return view;
  }
  const claim: BoardClaimView = { claimId, barId, teamId };
  return { ...view, activeClaims: [...view.activeClaims, claim] };
}

function applyClaimRemoved(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const claimId = readString(payload, "claimId");
  if (claimId === undefined) {
    return view;
  }
  const activeClaims = view.activeClaims.filter(
    (claim) => claim.claimId !== claimId,
  );
  return activeClaims.length === view.activeClaims.length
    ? view
    : { ...view, activeClaims };
}

function applyScoreEntry(view: GameBoardView, payload: unknown): GameBoardView {
  const entryId = readString(payload, "entryId");
  const teamId = readString(payload, "teamId");
  const category = readString(payload, "category");
  const points = readNumber(payload, "points");
  if (
    entryId === undefined ||
    teamId === undefined ||
    category === undefined ||
    points === undefined
  ) {
    return view;
  }
  if (view.scoreEntries.some((entry) => entry.entryId === entryId)) {
    return view;
  }
  const entry: BoardScoreEntryView = {
    entryId,
    teamId,
    category,
    points,
    sourceId:
      readString(payload, "sourceId") ??
      readString(payload, "sourceClaimId") ??
      null,
  };
  return { ...view, scoreEntries: [...view.scoreEntries, entry] };
}

// ---------------------------------------------------------------------------
// Card-behavior record sections (design.md §Projection Changes).
//
// `applyRecordSections` runs after every event's type-specific handler. It
// upserts the embedded `challenges`, `offers` (`fairestOffers`), `effects`, and
// `awards` records by id — a later seq replaces an earlier one, so re-delivery
// and snapshot/tail splits converge — folds the `scoreEntries` section through
// the existing `applyScoreEntry` (deduped by `entryId`), and applies the
// `removedClaims` section through `applyClaimRemoved`. Records are keyed by the
// camelCase ids the routes embed; an event carrying none (every legacy wireframe
// event) leaves the slice untouched.
// ---------------------------------------------------------------------------

/** The embedded-record array field names, each keyed by the record's id field. */
const RECORD_SECTIONS: readonly {
  readonly field: string;
  readonly slot: "challenges" | "offers" | "effects" | "awards";
  readonly idKey: string;
}[] = [
  { field: "challenges", slot: "challenges", idKey: "challengeId" },
  { field: "fairestOffers", slot: "offers", idKey: "offerId" },
  { field: "offers", slot: "offers", idKey: "offerId" },
  { field: "effects", slot: "effects", idKey: "effectId" },
  { field: "awards", slot: "awards", idKey: "awardId" },
];

function applyRecordSections(
  view: GameBoardView,
  event: GameEvent,
): GameBoardView {
  let cardBehavior = view.cardBehavior;

  for (const section of RECORD_SECTIONS) {
    const records = readRecords(event.payload, section.field);
    for (const record of records) {
      const id =
        typeof record[section.idKey] === "string"
          ? (record[section.idKey] as string)
          : undefined;
      if (id === undefined) {
        continue;
      }
      cardBehavior = upsertRecord(cardBehavior, section.slot, id, record);
    }
  }

  let next: GameBoardView =
    cardBehavior === view.cardBehavior ? view : { ...view, cardBehavior };

  // Fold embedded ledger entries through the existing score fold (deduped by
  // entryId) and remove any embedded claim removals.
  for (const entry of readRecords(event.payload, "scoreEntries")) {
    next = applyScoreEntry(next, entry);
  }
  for (const removed of readRecords(event.payload, "removedClaims")) {
    next = applyClaimRemoved(next, removed);
  }

  return next;
}

/** Upsert one embedded record into the named card-behavior slot by id. */
function upsertRecord(
  view: CardBehaviorView,
  slot: "challenges" | "offers" | "effects" | "awards",
  id: string,
  record: Record<string, unknown>,
): CardBehaviorView {
  switch (slot) {
    case "challenges":
      return {
        ...view,
        challenges: { ...view.challenges, [id]: challengeFromRecord(record) },
      };
    case "offers":
      return {
        ...view,
        offers: { ...view.offers, [id]: offerFromRecord(record) },
      };
    case "effects":
      return {
        ...view,
        effects: { ...view.effects, [id]: effectFromRecord(record) },
      };
    case "awards":
      return {
        ...view,
        awards: { ...view.awards, [id]: awardFromRecord(record) },
      };
  }
}

/**
 * Set a card-behavior effect's `startAnnounced` / `endAnnounced` flag from an
 * `effect_activated` / `effect_expired` transition event (design.md). The
 * effect record itself was already upserted by `applyRecordSections`; this only
 * flips the announced flag so `deriveBoundaryToasts` can use it as its event
 * fallback. Transition events push no toast events. A payload with no `effectId`
 * (legacy wireframe effect) is a no-op here.
 */
function applyEffectTransition(
  view: GameBoardView,
  event: GameEvent,
): GameBoardView {
  const effectId = readString(event.payload, "effectId");
  if (effectId === undefined) {
    return view;
  }
  const existing = view.cardBehavior.effects[effectId];
  if (existing === undefined) {
    return view;
  }
  const activated = event.eventType === GAME_BOARD_EVENT_TYPES.effectActivated;
  const updated: EffectRecord = activated
    ? { ...existing, startAnnounced: true }
    : { ...existing, endAnnounced: true };
  return {
    ...view,
    cardBehavior: {
      ...view.cardBehavior,
      effects: { ...view.cardBehavior.effects, [effectId]: updated },
    },
  };
}

/**
 * `game_ended`: flip the lifecycle and, matching the server, mark every
 * uncancelled card-behavior effect cancelled at the event time with reason
 * `game_ended`, and drop pending toast descriptors (the board is read-only once
 * ended, design.md §Projection Changes).
 */
function applyGameEnded(view: GameBoardView, event: GameEvent): GameBoardView {
  const endedAt = event.createdAt;
  const entries = Object.entries(view.cardBehavior.effects);
  let changed = false;
  const effects: Record<string, EffectRecord> = {};
  for (const [id, effect] of entries) {
    if (effect.cancelledAt === null && effect.consumedAt === null) {
      effects[id] = {
        ...effect,
        cancelledAt: endedAt,
        cancelReason: "game_ended",
      };
      changed = true;
    } else {
      effects[id] = effect;
    }
  }
  return {
    ...view,
    lifecycle: "ended",
    cardBehavior: changed
      ? { ...view.cardBehavior, effects }
      : view.cardBehavior,
  };
}

/** Push a payout toast event for a `patient_investor_award` ledger entry. */
function applyScorePayoutToast(
  view: GameBoardView,
  event: GameEvent,
): GameBoardView {
  if (readString(event.payload, "category") !== "patient_investor_award") {
    return view;
  }
  const entryId = readString(event.payload, "entryId");
  if (entryId === undefined) {
    return view;
  }
  return pushToastEventWithSubject(view, event, "payout", entryId);
}

/**
 * Push one deduped, seq-ordered {@link ToastEvent} onto the card-behavior slice,
 * reading the subject id from `payload[subjectKey]`. A missing subject records no
 * toast. Deduped by the toast `id` (`${seq}:${kind}:${subjectId}`), so a
 * re-delivered event or a snapshot/tail overlap never adds a second descriptor.
 */
function pushToastEvent(
  view: GameBoardView,
  event: GameEvent,
  kind: ToastEventKind,
  subjectKey: string,
): GameBoardView {
  const subjectId = readString(event.payload, subjectKey);
  if (subjectId === undefined) {
    return view;
  }
  return pushToastEventWithSubject(view, event, kind, subjectId);
}

/** Push a toast event keyed on the first present id among `subjectKeys`. */
function pushToastEventFirstKey(
  view: GameBoardView,
  event: GameEvent,
  kind: ToastEventKind,
  subjectKeys: readonly string[],
): GameBoardView {
  for (const key of subjectKeys) {
    const subjectId = readString(event.payload, key);
    if (subjectId !== undefined) {
      return pushToastEventWithSubject(view, event, kind, subjectId);
    }
  }
  return view;
}

function pushToastEventWithSubject(
  view: GameBoardView,
  event: GameEvent,
  kind: ToastEventKind,
  subjectId: string,
): GameBoardView {
  const id = `${event.seq}:${kind}:${subjectId}`;
  if (view.cardBehavior.toastEvents.some((toast) => toast.id === id)) {
    return view;
  }
  const toast: ToastEvent = { id, seq: event.seq, kind, subjectId };
  return {
    ...view,
    cardBehavior: {
      ...view.cardBehavior,
      toastEvents: [...view.cardBehavior.toastEvents, toast],
    },
  };
}

// ---------------------------------------------------------------------------
// Embedded-record parsers.
//
// The routes embed the planners' camelCase record objects straight into the
// event payload (jsonb round-trip), so each parser narrows the id and
// structural fields it needs and coerces the rest with the record's declared
// default, keeping the fold total over any stored payload.
// ---------------------------------------------------------------------------

function strField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function strOrNullField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function numOrNullField(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolField(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function objField(
  record: Record<string, unknown>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = record[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

/** Read a validated {@link CastingParams} value from a payload, defaulting to `none`. */
function readCastingParams(payload: unknown): CastingParams {
  const record = readRecord(payload);
  const params = record?.params;
  return params !== null && typeof params === "object" && !Array.isArray(params)
    ? (params as CastingParams)
    : { kind: "none" };
}

function challengeFromRecord(record: Record<string, unknown>): ChallengeRecord {
  return {
    challengeId: strField(record, "challengeId"),
    slug: strField(record, "slug") as CardSlug,
    sourcePlayId: strField(record, "sourcePlayId"),
    casterTeamId: strField(record, "casterTeamId"),
    targetTeamId: strField(record, "targetTeamId"),
    params:
      record.params !== null &&
      typeof record.params === "object" &&
      !Array.isArray(record.params)
        ? (record.params as CastingParams)
        : { kind: "none" },
    mirroredFromChallengeId: strOrNullField(record, "mirroredFromChallengeId"),
    mirroredFromPlayId: strOrNullField(record, "mirroredFromPlayId"),
    status: strField(record, "status") as ChallengeStatus,
    createdAt: strField(record, "createdAt"),
    resolvedAt: strOrNullField(record, "resolvedAt"),
    resolvedByTeamId: strOrNullField(record, "resolvedByTeamId"),
    resolvedBySessionId: strOrNullField(record, "resolvedBySessionId"),
    resolvedByKind: strOrNullField(
      record,
      "resolvedByKind",
    ) as ChallengeRecord["resolvedByKind"],
    failureEffectId: strOrNullField(record, "failureEffectId"),
  };
}

function offerFromRecord(record: Record<string, unknown>): FairestOfferRecord {
  return {
    offerId: strField(record, "offerId"),
    sourcePlayId: strField(record, "sourcePlayId"),
    slug: strField(record, "slug") as CardSlug,
    holderTeamId: strField(record, "holderTeamId"),
    originalCasterTeamId: strField(record, "originalCasterTeamId"),
    challengeId: strOrNullField(record, "challengeId"),
    restrictionEffectId: strOrNullField(record, "restrictionEffectId"),
    status: strField(record, "status") as FairestOfferStatus,
    decidedAt: strOrNullField(record, "decidedAt"),
    mirroredChallengeId: strOrNullField(record, "mirroredChallengeId"),
    mirroredEffectId: strOrNullField(record, "mirroredEffectId"),
  };
}

function effectFromRecord(record: Record<string, unknown>): EffectRecord {
  return {
    effectId: strField(record, "effectId"),
    slug: strField(record, "slug") as CardSlug,
    kind: strField(record, "kind") as EffectKind,
    sourcePlayId: strOrNullField(record, "sourcePlayId"),
    sourceChallengeId: strOrNullField(record, "sourceChallengeId"),
    ownerTeamId: strOrNullField(record, "ownerTeamId"),
    targetTeamId: strOrNullField(record, "targetTeamId"),
    targetBarKey: strOrNullField(record, "targetBarKey"),
    startsAt: strField(record, "startsAt"),
    endsAt: strOrNullField(record, "endsAt"),
    params: objField(record, "params"),
    attachedClaimId: strOrNullField(record, "attachedClaimId"),
    attachedBarKey: strOrNullField(record, "attachedBarKey"),
    protectedPoints: numOrNullField(record, "protectedPoints"),
    consumedAt: strOrNullField(record, "consumedAt"),
    cancelledAt: strOrNullField(record, "cancelledAt"),
    cancelReason: strOrNullField(
      record,
      "cancelReason",
    ) as EffectRecord["cancelReason"],
    startAnnounced: boolField(record, "startAnnounced"),
    endAnnounced: boolField(record, "endAnnounced"),
  };
}

function awardFromRecord(record: Record<string, unknown>): AwardRecord {
  return {
    awardId: strField(record, "awardId"),
    effectId: strField(record, "effectId"),
    teamId: strField(record, "teamId"),
    kind: strField(record, "kind") as AwardRecord["kind"],
    claimId: strOrNullField(record, "claimId"),
    ledgerEntryId: strField(record, "ledgerEntryId"),
    reversedAt: strOrNullField(record, "reversedAt"),
    reversalLedgerEntryId: strOrNullField(record, "reversalLedgerEntryId"),
    createdAt: strField(record, "createdAt"),
  };
}

/**
 * Fold a `game_created` / `team_created` event into the Team roster
 * (design.md §Components 1; R4.1, R4.2).
 *
 * Both event types carry the same `{ teamId, name, color }` Team-identifying
 * payload the lobby routes append, so the scoreboard has real Team
 * identities/colors to render. A payload missing any of those fields (e.g. a
 * `game_created` event that carries only game-level facts) adds no Team, and a
 * repeat for the same team id is a no-op.
 */
function applyTeamFromPayload(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const id = readString(payload, "teamId");
  const name = readString(payload, "name");
  const color = readString(payload, "color");
  if (id === undefined || name === undefined || color === undefined) {
    return view;
  }
  if (view.teams.some((team) => team.id === id)) {
    return view;
  }
  const team: BoardTeamView = { id, name, color };
  return { ...view, teams: [...view.teams, team] };
}

/**
 * Fold a `wireframe_card_played` event into a {@link TargetedNotice}
 * (design.md §Components 1; R7.8).
 *
 * The notice's identity is the producing event `seq` (stable for de-dup +
 * dismissal). Because the reducer is fed only the game's own events and the
 * idempotence guard drops any `seq <= lastSeenSequence`, each targeting event
 * yields exactly one notice and re-delivery never duplicates it. Notices are
 * folded for all teams; the client filters to the current Team when deciding
 * what to present (R7.3). A payload missing any of the required ids adds no
 * notice.
 */
function applyWireframeCardPlayed(
  view: GameBoardView,
  event: GameEvent,
): GameBoardView {
  const castingTeamId = readString(event.payload, "castingTeamId");
  const targetTeamId = readString(event.payload, "targetTeamId");
  const cardId = readString(event.payload, "cardId");
  if (
    castingTeamId === undefined ||
    targetTeamId === undefined ||
    cardId === undefined
  ) {
    return view;
  }
  const notice: TargetedNotice = {
    seq: event.seq,
    castingTeamId,
    targetTeamId,
    cardId,
  };
  return { ...view, targetedNotices: [...view.targetedNotices, notice] };
}
