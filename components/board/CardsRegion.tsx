"use client";

/**
 * Cards_Region surface for the Game_Board (brawl-deck-architecture Tasks 6, 7).
 *
 * Renders the current team's REAL hand and pending draw, derived from the folded
 * game-event projection (`GameBoardView.cards`), replacing the former wireframe
 * placeholder hand (R2.1).
 *
 * Two states it owns:
 *
 *   1. **Pending draw (R1.1, R1.2).** When the team has drawn cards awaiting a
 *      choice (`state === "pending"`), it presents each drawn card with its real
 *      catalog name and a Keep action. For an ordinary draw, keeping one card
 *      discards the rest of that draw; for a Power Hour draw (`pendingMode:
 *      "keep_all"`) keeping one discards nothing — the others stay pending until
 *      the team makes room or forfeits (R17.2). The component only reports the
 *      chosen card to `onKeepCard`; the server (and the pure engine behind it)
 *      performs the keep/discard. The reveal copy branches on `pendingMode` so
 *      it never claims the other card is discarded when Power Hour keeps it.
 *   2. **Hand (R2.3).** The team's held cards (`state === "hand"`, at most two)
 *      are listed, each with a Play control reported via `onPlayCard`.
 *
 * Hand-full resolution (R2.4): if a draw is pending while the hand is already at
 * the maximum size, the new card cannot enter the hand until an existing one is
 * played or discarded. The component surfaces that explicitly and offers a
 * Discard control on each held card so the player can free a slot first.
 *
 * This component renders no card effect and enforces nothing: it reports the
 * player's intent (keep / discard / play) to callbacks the page wires to the
 * real card routes. The event log remains the single source of truth; this is a
 * pure projection of `cards` plus transient disabled/pending affordances.
 *
 * Admin-not-player: a hand belongs to players, so an admin who is not a player
 * sees an explanation and no controls (R5.4 parity with the prior wireframe).
 *
 * Mobile-first (R6 cross-cutting): single-column, `box-sizing: border-box`, and
 * every interactive control is at least 44×44 CSS pixels.
 *
 * Use It or Lose It + Fairest (card-behavior R8.2, R9.3, R9.11). When the
 * viewing team has an OPEN Use-It-or-Lose-It challenge it must play or discard
 * every held card (R8.2). No dedicated "Can't play, discard" control is shown:
 * the ordinary Discard button on each held card already does exactly that, and
 * the server freezes the discard while a Fairest prompt is pending for the
 * challenge (`checkCannotPlayDiscard`, R9.3) — so the honor-system freeze holds
 * without a second button. A held Fairest of Them All card is never played from
 * the hand: it shows no Play button and, in its place, the note "Played from a
 * challenge prompt" (R9.11). As with everything else here, the component
 * enforces nothing; it reports the discard intent back to the page.
 */

import { useState } from "react";

import {
  getCardMetadata,
  getCardText,
  type CardSlug,
  type CardText,
} from "@/lib/cards/catalog";
import type { BoardCardView } from "@/lib/gameboard/events";

/** Minimum touch-target size for interactive controls (R6 cross-cutting). */
const TOUCH_TARGET = "44px";

/** The default maximum hand size (R2.3). */
export const MAX_HAND_SIZE = 2;

/** The catalog slug for Fairest of Them All (card-behavior R9.11). */
const FAIREST_SLUG: CardSlug = "fairest-of-them-all";

export interface CardsRegionProps {
  /**
   * The current team's cards from the folded projection (R2.1). The component
   * selects the `pending` and `hand` subsets itself; `deck` / `played` /
   * `discarded` cards are not shown here.
   */
  readonly cards: readonly BoardCardView[];
  /**
   * `true` when the current session is the admin and is not a player of the
   * game; a hand belongs to players, so no hand is shown (R5.4).
   */
  readonly adminNotPlayer: boolean;
  /**
   * Keep a specific pending card. For an ordinary draw (`pendingMode:
   * "choose_one"`) the server discards the rest of the draw; for a Power Hour
   * draw (`pendingMode: "keep_all"`) nothing is discarded — the others stay
   * pending until the team makes room or forfeits (R17.2).
   */
  readonly onKeepCard: (card: BoardCardView) => void;
  /**
   * Discard a specific held or pending card. While the team has an open Use It
   * or Lose It challenge, the ordinary Discard button satisfies the "play or
   * discard every card" rule (R8.2); the server freezes it when a Fairest prompt
   * is pending for that challenge (R9.3).
   */
  readonly onDiscardCard: (card: BoardCardView) => void;
  /** Play a specific held card (targeting flow is owned by the page). */
  readonly onPlayCard: (card: BoardCardView) => void;
  /**
   * Forfeit the entire pending draw (R2.4 hand-full flow): discard both drawn
   * cards without keeping either. Offered when the hand is full so the player
   * can drop the draw instead of freeing a slot.
   */
  readonly onForfeitDraw: () => void;
  /** Disable all card actions (e.g. after the game ends). */
  readonly readOnly?: boolean;
  /** The card id currently awaiting a server response, if any (disables it). */
  readonly pendingCardId?: string | null;
  /**
   * How the current pending draw resolves (R17.2). `"keep_all"` is a Power Hour
   * draw: keeping a card discards nothing; every other drawn card stays waiting
   * until the team frees a slot (plays or discards a held card) or forfeits.
   * `"choose_one"` (the default) is an ordinary draw: keeping one discards the
   * rest. Drives the reveal copy so it never tells the player the other card is
   * discarded when, under Power Hour, it is kept.
   */
  readonly pendingMode?: "choose_one" | "keep_all";
}

/** The human-facing catalog name for a card slug, falling back to the slug. */
function cardName(slug: string): string {
  try {
    return getCardMetadata(slug as CardSlug).name;
  } catch {
    return slug;
  }
}

/** The player-facing text for a card slug, if cataloged. */
function cardText(slug: string): CardText | null {
  try {
    return getCardText(slug as CardSlug);
  } catch {
    return null;
  }
}

export default function CardsRegion({
  cards,
  adminNotPlayer,
  onKeepCard,
  onDiscardCard,
  onPlayCard,
  onForfeitDraw,
  readOnly = false,
  pendingCardId = null,
  pendingMode = "choose_one",
}: CardsRegionProps): React.JSX.Element {
  const pending = cards.filter((card) => card.state === "pending");
  const hand = cards.filter((card) => card.state === "hand");
  const handFull = hand.length >= MAX_HAND_SIZE;
  // A draw is awaiting a choice whenever cards are pending.
  const hasPendingDraw = pending.length > 0;
  // While the hand is full, a pending draw's cards stay HIDDEN until the player
  // frees a slot or forfeits (R2.4): the prompt to play/discard/forfeit comes
  // BEFORE the two newly drawn cards are revealed.
  const revealPending = hasPendingDraw && !handFull;
  // The card whose detail panel is open (R2.2) — a held card or a revealed
  // pending card. Toggled by selecting a card's name; at most one at a time.
  const [inspectedCardId, setInspectedCardId] = useState<string | null>(null);

  return (
    <section
      aria-label="Cards region"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        width: "100%",
        maxWidth: "100%",
      }}
    >
      {adminNotPlayer ? (
        <p
          style={{
            margin: 0,
            padding: "1rem",
            borderRadius: "0.5rem",
            border: "1px dashed #888",
            background: "#f5f5f5",
            color: "#1a1a1a",
            textAlign: "center",
          }}
        >
          A hand belongs to Players. As the Admin, you do not hold a hand of
          cards.
        </p>
      ) : (
        <>
          {/* Hand-full gate (R2.4): when a draw is pending but the hand is
              full, the two drawn cards are NOT yet revealed. The player must
              first make room by playing/discarding a held card below, or
              forfeit the draw outright. The reveal + keep UI appears only once a
              slot is free. */}
          {hasPendingDraw && !revealPending ? (
            <div
              role="group"
              aria-label="Make room before seeing your drawn cards"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
                width: "100%",
                padding: "0.75rem",
                border: "1px solid #7a1a1a",
                borderRadius: "0.5rem",
                background: "#fff0f0",
              }}
            >
              <p
                role="alert"
                style={{
                  margin: 0,
                  fontSize: "0.95rem",
                  fontWeight: 600,
                  color: "#7a1a1a",
                }}
              >
                You drew {pending.length} cards, but your hand is full.
              </p>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "#555" }}>
                {pendingMode === "keep_all"
                  ? "Power Hour lets you keep both. Play or discard a held card below to make room and see your new cards (one at a time), or forfeit this draw to discard them without looking."
                  : "Play or discard a held card below to make room and see your new cards, or forfeit this draw to discard both without looking."}
              </p>
              <button
                type="button"
                aria-label="Forfeit this draw"
                disabled={readOnly || pendingCardId !== null}
                onClick={onForfeitDraw}
                style={forfeitButtonStyle(readOnly || pendingCardId !== null)}
              >
                Forfeit draw
              </button>
            </div>
          ) : null}

          {/* Pending draw choice, revealed once the hand has room (R1.1, R1.2,
              R2.2): each drawn card shows its name AND its effect/requirement
              text so the player knows what they are choosing before keeping. */}
          {revealPending ? (
            <div
              role="group"
              aria-label="Choose a card to keep"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
                width: "100%",
                padding: "0.75rem",
                border: "1px solid #1a1a1a",
                borderRadius: "0.5rem",
                background: "#fffbea",
              }}
            >
              {pendingMode === "keep_all" ? (
                <>
                  <p
                    style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}
                  >
                    Power Hour: you keep both cards.
                  </p>
                  <p style={{ margin: 0, fontSize: "0.8rem", color: "#555" }}>
                    Keep one now — nothing is discarded. The other
                    {pending.length > 2 ? "s" : ""} stay
                    {pending.length > 2 ? "" : "s"} waiting until you make room
                    (play or discard a held card), or forfeit the draw.
                  </p>
                </>
              ) : (
                <>
                  <p
                    style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}
                  >
                    You drew {pending.length} cards — keep one.
                  </p>
                  <p style={{ margin: 0, fontSize: "0.8rem", color: "#555" }}>
                    Keeping a card discards the other
                    {pending.length > 2 ? "s" : ""}.
                  </p>
                </>
              )}

              <ul
                aria-label="Drawn cards"
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                  width: "100%",
                }}
              >
                {pending.map((card) => {
                  const name = cardName(card.slug);
                  const busy = pendingCardId === card.cardId;
                  const text = cardText(card.slug);
                  return (
                    <li
                      key={card.cardId}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.5rem",
                        padding: "0.6rem 0.75rem",
                        borderRadius: "0.5rem",
                        border: "1px solid #888",
                        background: "#ffffff",
                        width: "100%",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "0.5rem",
                          width: "100%",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "1rem",
                            fontWeight: 600,
                            color: "#1a1a1a",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {name}
                        </span>
                        <button
                          type="button"
                          aria-label={`Keep ${name}`}
                          disabled={readOnly || busy}
                          onClick={() => onKeepCard(card)}
                          style={keepButtonStyle(readOnly || busy)}
                        >
                          Keep
                        </button>
                      </div>

                      {/* Card requirement + effect + target text shown inline
                          at choice time (R2.2) so the keep decision is informed:
                          Requires (when present), then Effect, then Target
                          note. */}
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.3rem",
                        }}
                      >
                        {text?.requires != null ? (
                          <p
                            style={{
                              margin: 0,
                              fontSize: "0.8rem",
                              color: "#555",
                            }}
                          >
                            <strong>Requires:</strong> {text.requires}
                          </p>
                        ) : null}
                        <p
                          style={{
                            margin: 0,
                            fontSize: "0.85rem",
                            color: "#333",
                          }}
                        >
                          {text?.effect ??
                            "No description is available for this card."}
                        </p>
                        {text != null ? (
                          <p
                            style={{
                              margin: 0,
                              fontSize: "0.8rem",
                              color: "#555",
                            }}
                          >
                            <strong>Target:</strong> {text.targetNote}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {/* The team's held hand (R2.3). */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              width: "100%",
            }}
          >
            <p style={{ margin: 0, fontSize: "0.9rem", color: "#444" }}>
              Your hand ({hand.length}/{MAX_HAND_SIZE})
            </p>
            {hand.length === 0 ? (
              <p
                style={{
                  margin: 0,
                  padding: "0.75rem",
                  borderRadius: "0.5rem",
                  border: "1px dashed #888",
                  background: "#fafafa",
                  color: "#555",
                  fontSize: "0.9rem",
                  textAlign: "center",
                }}
              >
                You have no cards in hand. Claim a bar to draw cards.
              </p>
            ) : (
              <ul
                aria-label="Your hand"
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                  width: "100%",
                }}
              >
                {hand.map((card) => {
                  const name = cardName(card.slug);
                  const busy = pendingCardId === card.cardId;
                  const expanded = inspectedCardId === card.cardId;
                  const detailId = `card-detail-${card.cardId}`;
                  const text = expanded ? cardText(card.slug) : null;
                  // Fairest of Them All is never played from the hand: it is
                  // played from a challenge prompt, so it shows no Play button
                  // and a note in its place (R9.11).
                  const isFairest = card.slug === FAIREST_SLUG;
                  return (
                    <li
                      key={card.cardId}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.5rem",
                        padding: "0.6rem 0.75rem",
                        borderRadius: "0.5rem",
                        border: "1px solid #888",
                        background: "#ffffff",
                        width: "100%",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "0.5rem",
                          width: "100%",
                        }}
                      >
                        {/* The card name is the inspect toggle (R2.2): selecting
                            it expands/collapses the card's detail panel. */}
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={detailId}
                          aria-label={`${name} details`}
                          onClick={() =>
                            setInspectedCardId((current) =>
                              current === card.cardId ? null : card.cardId,
                            )
                          }
                          style={{
                            flex: "1 1 auto",
                            minHeight: TOUCH_TARGET,
                            display: "flex",
                            alignItems: "center",
                            gap: "0.4rem",
                            padding: "0.3rem 0.4rem",
                            fontSize: "1rem",
                            fontWeight: 500,
                            textAlign: "left",
                            color: "#1a1a1a",
                            background: "transparent",
                            border: "none",
                            borderRadius: "0.4rem",
                            cursor: "pointer",
                            overflowWrap: "anywhere",
                          }}
                        >
                          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                          {name}
                        </button>
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.4rem",
                            flex: "0 0 auto",
                          }}
                        >
                          {isFairest ? (
                            // Fairest shows no Play button; the note stands in
                            // its place to explain how it is played (R9.11).
                            <span
                              style={{
                                fontSize: "0.8rem",
                                fontStyle: "italic",
                                color: "#555",
                                textAlign: "right",
                                maxWidth: "9rem",
                              }}
                            >
                              Played from a challenge prompt
                            </span>
                          ) : (
                            <button
                              type="button"
                              aria-label={`Play ${name}`}
                              disabled={readOnly || busy}
                              onClick={() => onPlayCard(card)}
                              style={playButtonStyle(readOnly || busy)}
                            >
                              Play
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label={`Discard ${name}`}
                            disabled={readOnly || busy}
                            onClick={() => onDiscardCard(card)}
                            style={discardButtonStyle(readOnly || busy)}
                          >
                            Discard
                          </button>
                        </span>
                      </div>

                      {/* Use It or Lose It honor-system flow (R8.2): while the
                          team has an open UIOLI challenge it must play or discard
                          every held card. No separate "Can't play, discard"
                          control is needed — the ordinary Discard button above
                          already discards the card, and the server freezes that
                          discard while a Fairest prompt is pending for the
                          challenge (checkCannotPlayDiscard, R9.3). */}

                      {/* Card detail panel: real catalog effect + playing
                          requirement text (R2.2). */}
                      {expanded ? (
                        <div
                          id={detailId}
                          role="group"
                          aria-label={`${name} details`}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "0.4rem",
                            padding: "0.5rem 0.6rem",
                            borderRadius: "0.4rem",
                            background: "#f5f7ff",
                            border: "1px solid #ccd4ee",
                          }}
                        >
                          {/* Inspection order (R2.2): Requires (when present),
                              then Effect, then Target note. */}
                          {text?.requires != null ? (
                            <p
                              style={{
                                margin: 0,
                                fontSize: "0.85rem",
                                color: "#444",
                              }}
                            >
                              <strong>Requires:</strong> {text.requires}
                            </p>
                          ) : null}
                          <p
                            style={{
                              margin: 0,
                              fontSize: "0.9rem",
                              color: "#1a1a1a",
                            }}
                          >
                            {text?.effect ??
                              "No description is available for this card."}
                          </p>
                          {text != null ? (
                            <p
                              style={{
                                margin: 0,
                                fontSize: "0.85rem",
                                color: "#444",
                              }}
                            >
                              <strong>Target:</strong> {text.targetNote}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function keepButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    flex: "0 0 auto",
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.6rem 0.9rem",
    fontSize: "1rem",
    fontWeight: 600,
    borderRadius: "0.5rem",
    border: "2px solid #1a1a1a",
    background: disabled ? "#9a9a9a" : "#1a1a1a",
    color: "#ffffff",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function playButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.6rem 0.9rem",
    fontSize: "1rem",
    fontWeight: 600,
    borderRadius: "0.5rem",
    border: "2px solid #1a1a1a",
    background: disabled ? "#9a9a9a" : "#1a1a1a",
    color: "#ffffff",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function discardButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.6rem 0.9rem",
    fontSize: "1rem",
    fontWeight: 500,
    borderRadius: "0.5rem",
    border: "1px solid #888",
    background: disabled ? "#f0f0f0" : "#ffffff",
    color: "#1a1a1a",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function forfeitButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    alignSelf: "flex-start",
    minHeight: TOUCH_TARGET,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.6rem 0.9rem",
    fontSize: "0.95rem",
    fontWeight: 600,
    borderRadius: "0.5rem",
    border: "1px solid #7a1a1a",
    background: disabled ? "#e5b5b5" : "#7a1a1a",
    color: "#ffffff",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
