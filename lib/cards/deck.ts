import { CARD_SLUGS, type CardSlug } from "./catalog";
import { seededShuffle } from "./rng";

export type CardInstanceState =
  "deck" | "pending" | "hand" | "played" | "discarded";

export interface CardInstance {
  readonly id: string;
  readonly slug: CardSlug;
  readonly state: CardInstanceState;
  readonly position: number;
}

export interface DeckState {
  readonly teamId: string;
  readonly cards: readonly CardInstance[];
  readonly drawnBarIds: readonly string[];
  readonly pendingBarId: string | null;
  /**
   * How a pending draw must be resolved (R17.2):
   * - `"choose_one"` (the default): a normal draw reveals two cards; the team
   *   keeps one and the rest are discarded on keep.
   * - `"keep_all"`: a Power Hour (`drawOverride`) draw with a full-enough hand
   *   that both cards cannot go straight in. Every pending card is kept — the
   *   team moves them into the hand one at a time (freeing slots as needed) and
   *   nothing is auto-discarded by keeping.
   *
   * It is only meaningful while `pendingBarId !== null`; with no pending draw it
   * carries the mode the next resolution will use and is reset to `"choose_one"`
   * once a draw resolves.
   */
  readonly pendingMode: "choose_one" | "keep_all";
}

export type DeckRejection =
  | "finish_bar"
  | "duplicate_bar_draw"
  | "hand_full"
  | "pending_draw"
  | "deck_exhausted"
  | "card_not_pending"
  | "card_not_in_hand"
  | "unknown_card";

export type DeckResult =
  | {
      readonly ok: true;
      readonly state: DeckState;
      readonly cardIds?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly state: DeckState;
      readonly reason: DeckRejection;
    };

function replaceCard(
  cards: readonly CardInstance[],
  cardId: string,
  state: CardInstanceState,
): CardInstance[] {
  return cards.map((card) => (card.id === cardId ? { ...card, state } : card));
}

function cardIds(
  cards: readonly CardInstance[],
  state: CardInstanceState,
): string[] {
  return cards.filter((card) => card.state === state).map((card) => card.id);
}

/** The maximum number of cards a team may hold in hand at once (R2.3). */
export const MAX_HAND = 2;

/** Options controlling how {@link seedDeck} orders the freshly seeded deck. */
export interface SeedDeckOptions {
  /**
   * When provided, the deck's draw order is a deterministic Fisher–Yates
   * shuffle of {@link slugs} keyed by this seed, so each team gets its own
   * unpredictable-but-reproducible order (a reload re-derives the SAME order).
   * When omitted, the deck keeps the catalog order — the stable default the
   * engine's property tests rely on. The server derives the seed from the
   * per-game global seed and the team id (`"${gameSeed}:${teamId}"`) so every
   * team in a game shuffles differently and every game shuffles differently.
   */
  readonly shuffleSeed?: string;
  /** The slug roster to seed from; defaults to the full catalog order. */
  readonly slugs?: readonly CardSlug[];
}

export function seedDeck(
  teamId: string,
  options: SeedDeckOptions = {},
): DeckState {
  const baseSlugs = options.slugs ?? CARD_SLUGS;
  const ordered =
    options.shuffleSeed === undefined
      ? baseSlugs
      : seededShuffle(baseSlugs, options.shuffleSeed);
  const cards = ordered.map((slug, position) => ({
    id: `${teamId}:${slug}`,
    slug,
    state: "deck" as const,
    position,
  }));
  return {
    teamId,
    cards,
    drawnBarIds: [],
    pendingBarId: null,
    pendingMode: "choose_one",
  };
}

export function drawForBar(
  state: DeckState,
  barId: string,
  options: {
    readonly finishBar?: boolean;
    readonly drawOverride?: boolean;
  } = {},
): DeckResult {
  if (options.finishBar === true) {
    return { ok: false, state, reason: "finish_bar" };
  }
  if (state.drawnBarIds.includes(barId)) {
    return { ok: false, state, reason: "duplicate_bar_draw" };
  }
  if (state.pendingBarId !== null) {
    return { ok: false, state, reason: "pending_draw" };
  }

  const handCount = cardIds(state.cards, "hand").length;

  const available = state.cards
    .filter((card) => card.state === "deck")
    .sort((left, right) => left.position - right.position);
  if (available.length === 0) {
    return { ok: false, state, reason: "deck_exhausted" };
  }

  // A draw ALWAYS reveals its cards into `pending`, even when the hand is full.
  // The hand-full case is handled at RESOLUTION time: `keepCard` refuses to
  // overflow the hand, so the player must first free a slot (play/discard a held
  // card) or forfeit the draw. This replaces the old pre-reveal `hand_full`
  // rejection, which silently dropped the draw and left the player with no way
  // to recover it (the once-per-bar rule blocked a re-draw).
  //
  // Power Hour (`drawOverride`) is the one case that keeps BOTH cards instead of
  // discarding one on keep (R17.2). When the hand has room for every drawn card
  // they go straight in with no choice; otherwise they reveal as `pending` with
  // `pendingMode: "keep_all"`, and the team moves each kept card into the hand
  // after freeing a slot (nothing is auto-discarded by keeping). A normal draw
  // stays `"choose_one"`: keep one, discard the rest.
  const drawCount = Math.min(2, available.length);
  const drawOverride = options.drawOverride === true;
  const keepBothDirectly = drawOverride && handCount + drawCount <= MAX_HAND;
  const pendingMode: DeckState["pendingMode"] = drawOverride
    ? "keep_all"
    : "choose_one";

  const selected = available.slice(0, drawCount);
  const nextCards = selected.reduce(
    (cards, card) =>
      replaceCard(cards, card.id, keepBothDirectly ? "hand" : "pending"),
    state.cards,
  );
  return {
    ok: true,
    state: {
      ...state,
      cards: nextCards,
      drawnBarIds: [...state.drawnBarIds, barId],
      pendingBarId: keepBothDirectly ? null : barId,
      pendingMode: keepBothDirectly ? "choose_one" : pendingMode,
    },
    cardIds: selected.map((card) => card.id),
  };
}

export function keepCard(state: DeckState, cardId: string): DeckResult {
  if (state.pendingBarId === null) {
    return { ok: false, state, reason: "pending_draw" };
  }
  const card = state.cards.find((candidate) => candidate.id === cardId);
  if (card === undefined || card.state !== "pending") {
    return { ok: false, state, reason: "card_not_pending" };
  }
  // Keeping a card moves it into the hand; refuse if the hand has no room
  // (R2.4). The player must first free a slot by playing/discarding a held card
  // or forfeit the whole draw. A draw can reach `pending` with a full hand now,
  // so this guard is what actually enforces the two-card limit at keep time.
  if (cardIds(state.cards, "hand").length >= MAX_HAND) {
    return { ok: false, state, reason: "hand_full" };
  }

  if (state.pendingMode === "keep_all") {
    // Power Hour keeps EVERY pending card (R17.2): keeping moves only the chosen
    // card into the hand and discards nothing. Any remaining pending card stays
    // pending, so the team keeps them one at a time (freeing slots as needed).
    // The draw only resolves once nothing remains pending.
    const nextCards = replaceCard(state.cards, cardId, "hand");
    const stillPending = nextCards.some((entry) => entry.state === "pending");
    return {
      ok: true,
      state: {
        ...state,
        cards: nextCards,
        pendingBarId: stillPending ? state.pendingBarId : null,
        pendingMode: stillPending ? state.pendingMode : "choose_one",
      },
    };
  }

  const pending = cardIds(state.cards, "pending");
  const nextCards = pending.reduce(
    (cards, pendingId) =>
      replaceCard(
        cards,
        pendingId,
        pendingId === cardId ? "hand" : "discarded",
      ),
    state.cards,
  );
  return {
    ok: true,
    state: {
      ...state,
      cards: nextCards,
      pendingBarId: null,
      pendingMode: "choose_one",
    },
  };
}

export function discardCard(state: DeckState, cardId: string): DeckResult {
  const card = state.cards.find((candidate) => candidate.id === cardId);
  if (card === undefined) {
    return { ok: false, state, reason: "unknown_card" };
  }
  if (card.state !== "pending" && card.state !== "hand") {
    return { ok: false, state, reason: "card_not_in_hand" };
  }
  if (card.state === "pending") {
    if (state.pendingMode === "keep_all") {
      // Power Hour: discarding a pending card removes ONLY that card and never
      // promotes another into the hand (every surviving pending card is still
      // meant to be kept, R17.2). Any remaining pending card keeps the draw
      // open; the draw resolves once nothing remains pending.
      const discarded = replaceCard(state.cards, cardId, "discarded");
      const stillPending = discarded.some((entry) => entry.state === "pending");
      return {
        ok: true,
        state: {
          ...state,
          cards: discarded,
          pendingBarId: stillPending ? state.pendingBarId : null,
          pendingMode: stillPending ? state.pendingMode : "choose_one",
        },
      };
    }

    const remainingPending = state.cards.filter(
      (candidate) => candidate.state === "pending" && candidate.id !== cardId,
    );
    const discarded = replaceCard(state.cards, cardId, "discarded");
    // Promote the remaining pending card(s) into the hand to resolve the draw —
    // but only while the hand has room (R2.4). With a full hand, discarding one
    // pending card leaves the other(s) pending: the player still has to free a
    // slot or keep/forfeit, so the draw stays open rather than overflowing the
    // hand. The draw is only resolved (pendingBarId cleared) once nothing stays
    // pending.
    let handRoom = MAX_HAND - cardIds(state.cards, "hand").length;
    const resolved = remainingPending.reduce((cards, pending) => {
      if (handRoom <= 0) {
        return cards;
      }
      handRoom -= 1;
      return replaceCard(cards, pending.id, "hand");
    }, discarded);
    const stillPending = resolved.some((entry) => entry.state === "pending");
    return {
      ok: true,
      state: {
        ...state,
        cards: resolved,
        pendingBarId: stillPending ? state.pendingBarId : null,
        pendingMode: stillPending ? state.pendingMode : "choose_one",
      },
    };
  }
  const nextState = {
    ...state,
    cards: replaceCard(state.cards, cardId, "discarded"),
  };
  return { ok: true, state: nextState };
}

/**
 * Forfeit the current pending draw (R2.4 hand-full flow): discard EVERY pending
 * card and clear the pending bar, keeping the hand untouched. This is the
 * explicit "I don't want either of these" escape a player uses when the hand is
 * full and they would rather not free a slot. Rejected when there is no pending
 * draw to forfeit.
 *
 * The forfeited cards are gone for the rest of the game (same as a discard), and
 * the bar remains recorded in `drawnBarIds`, so the once-per-bar rule still
 * holds — a forfeited bar cannot be re-drawn.
 */
export function forfeitDraw(state: DeckState): DeckResult {
  if (state.pendingBarId === null) {
    return { ok: false, state, reason: "pending_draw" };
  }
  const pending = cardIds(state.cards, "pending");
  const nextCards = pending.reduce(
    (cards, pendingId) => replaceCard(cards, pendingId, "discarded"),
    state.cards,
  );
  return {
    ok: true,
    state: {
      ...state,
      cards: nextCards,
      pendingBarId: null,
      pendingMode: "choose_one",
    },
  };
}

export function playCard(state: DeckState, cardId: string): DeckResult {
  const card = state.cards.find((candidate) => candidate.id === cardId);
  if (card === undefined) {
    return { ok: false, state, reason: "unknown_card" };
  }
  if (card.state !== "hand") {
    return { ok: false, state, reason: "card_not_in_hand" };
  }
  return {
    ok: true,
    state: { ...state, cards: replaceCard(state.cards, cardId, "played") },
  };
}
