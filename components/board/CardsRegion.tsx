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
 *      catalog name and a Keep action. Keeping one card discards the rest of that
 *      draw — the component only reports the chosen card to `onKeepCard`; the
 *      server (and the pure engine behind it) performs the keep/discard.
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
 * viewing team has an OPEN Use-It-or-Lose-It challenge (`hasOpenUioli`), each
 * held card gains a "Can't play, discard" honor-system control that discards the
 * card through the normal discard callback with the reason `"cannot_play"`
 * (R8.2). That control is HIDDEN while a Fairest prompt is pending for the same
 * challenge (`fairestPromptPending`), because the Fairest flow owns the decision
 * then (R9.3). A held Fairest of Them All card is never played from the hand: it
 * shows no Play button and, in its place, the note "Played from a challenge
 * prompt" (R9.11). As with everything else here, the component enforces nothing;
 * it receives these two facts as props from the folded view and reports the
 * discard intent back to the page.
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

/**
 * The discard reason recorded for the Use-It-or-Lose-It "Can't play, discard"
 * action (card-behavior R8.2). Passed through `onDiscardCard` so the page can
 * forward it as `{ reason: "cannot_play" }` to `/cards/discard`.
 */
export type DiscardReason = "cannot_play";

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
  /** Keep a specific pending card (the server discards the rest of the draw). */
  readonly onKeepCard: (card: BoardCardView) => void;
  /**
   * Discard a specific held or pending card. The optional `reason` is set to
   * `"cannot_play"` only when the player uses the Use-It-or-Lose-It "Can't play,
   * discard" action (card-behavior R8.2); the page forwards it to
   * `/cards/discard` as `{ reason: "cannot_play" }`. An ordinary hand/pending
   * discard passes no reason.
   */
  readonly onDiscardCard: (card: BoardCardView, reason?: DiscardReason) => void;
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
   * `true` when the viewing team has an OPEN Use-It-or-Lose-It challenge that
   * requires it to play or discard every card in hand (card-behavior R8.2). When
   * set, each held card shows a "Can't play, discard" control. This fact comes
   * from the folded view, not from this component.
   */
  readonly hasOpenUioli?: boolean;
  /**
   * `true` when a Fairest prompt is pending for that same Use-It-or-Lose-It
   * challenge — i.e. the team holds Fairest of Them All and an offer is pending
   * (card-behavior R9.3). While set, the "Can't play, discard" control is hidden
   * because the Fairest flow owns the decision. Also sourced from the folded
   * view.
   */
  readonly fairestPromptPending?: boolean;
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
  hasOpenUioli = false,
  fairestPromptPending = false,
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
  // The Use-It-or-Lose-It "Can't play, discard" control shows on each held card
  // only while the team has an open UIOLI challenge AND no Fairest prompt is
  // pending for it; the Fairest flow owns the decision while pending (R8.2,
  // R9.3).
  const showCannotPlayDiscard = hasOpenUioli && !fairestPromptPending;

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
                Play or discard a held card below to make room and see your new
                cards, or forfeit this draw to discard both without looking.
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
              <p style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>
                You drew {pending.length} cards — keep one.
              </p>
              <p style={{ margin: 0, fontSize: "0.8rem", color: "#555" }}>
                Keeping a card discards the other{pending.length > 2 ? "s" : ""}
                .
              </p>

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

                      {/* Use It or Lose It honor-system control (R8.2): while
                          the team has an open UIOLI challenge, each held card can
                          be discarded with the reason "cannot_play". Hidden while
                          a Fairest prompt is pending for that challenge (R9.3). */}
                      {showCannotPlayDiscard ? (
                        <button
                          type="button"
                          aria-label={`Can't play ${name}, discard`}
                          disabled={readOnly || busy}
                          onClick={() => onDiscardCard(card, "cannot_play")}
                          style={cannotPlayDiscardButtonStyle(readOnly || busy)}
                        >
                          Can&apos;t play, discard
                        </button>
                      ) : null}

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

function cannotPlayDiscardButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    alignSelf: "flex-start",
    minHeight: TOUCH_TARGET,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.6rem 0.9rem",
    fontSize: "0.9rem",
    fontWeight: 600,
    borderRadius: "0.5rem",
    border: "1px solid #7a1a1a",
    background: disabled ? "#f0e0e0" : "#fff0f0",
    color: "#7a1a1a",
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
