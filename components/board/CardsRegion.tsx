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
 */

import { useState } from "react";

import {
  getCardMetadata,
  getCardText,
  type CardSlug,
} from "@/lib/cards/catalog";
import type { BoardCardView } from "@/lib/gameboard/events";

/** Minimum touch-target size for interactive controls (R6 cross-cutting). */
const TOUCH_TARGET = "44px";

/** The default maximum hand size (R2.3). */
export const MAX_HAND_SIZE = 2;

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
  /** Discard a specific held or pending card. */
  readonly onDiscardCard: (card: BoardCardView) => void;
  /** Play a specific held card (targeting flow is owned by the page). */
  readonly onPlayCard: (card: BoardCardView) => void;
  /** Disable all card actions (e.g. after the game ends). */
  readonly readOnly?: boolean;
  /** The card id currently awaiting a server response, if any (disables it). */
  readonly pendingCardId?: string | null;
}

/** The human-facing catalog name for a card slug, falling back to the slug. */
function cardName(slug: string): string {
  try {
    return getCardMetadata(slug as CardSlug).name;
  } catch {
    return slug;
  }
}

/** The player-facing description + requirement text for a card slug, if cataloged. */
function cardText(slug: string): {
  description: string;
  castingRequirement: string | null;
  targetRequirement: string | null;
} | null {
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
  readOnly = false,
  pendingCardId = null,
}: CardsRegionProps): React.JSX.Element {
  const pending = cards.filter((card) => card.state === "pending");
  const hand = cards.filter((card) => card.state === "hand");
  const handFull = hand.length >= MAX_HAND_SIZE;

  // The held card whose detail panel is open (R2.2). Toggled by selecting a
  // card's name; at most one is expanded at a time.
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
          {/* Pending draw choice (R1.1, R1.2). */}
          {pending.length > 0 ? (
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

              {handFull ? (
                // Hand-full while a draw is pending (R2.4): the kept card cannot
                // enter the hand until a slot is freed. Prompt explicitly and
                // require a play/discard of a held card first.
                <p
                  role="alert"
                  style={{
                    margin: 0,
                    padding: "0.6rem 0.75rem",
                    fontSize: "0.9rem",
                    color: "#7a1a1a",
                    border: "1px solid #7a1a1a",
                    borderRadius: "0.5rem",
                    background: "#fff0f0",
                  }}
                >
                  Your hand is full. Play or discard a held card below before
                  keeping a new one.
                </p>
              ) : null}

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
                  return (
                    <li
                      key={card.cardId}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "0.5rem",
                        padding: "0.6rem 0.75rem",
                        borderRadius: "0.5rem",
                        border: "1px solid #888",
                        background: "#ffffff",
                        width: "100%",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "1rem",
                          fontWeight: 500,
                          color: "#1a1a1a",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {name}
                      </span>
                      <button
                        type="button"
                        aria-label={`Keep ${name}`}
                        disabled={readOnly || handFull || busy}
                        onClick={() => onKeepCard(card)}
                        style={keepButtonStyle(readOnly || handFull || busy)}
                      >
                        Keep
                      </button>
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
                            gap: "0.4rem",
                            flex: "0 0 auto",
                          }}
                        >
                          <button
                            type="button"
                            aria-label={`Play ${name}`}
                            disabled={readOnly || busy}
                            onClick={() => onPlayCard(card)}
                            style={playButtonStyle(readOnly || busy)}
                          >
                            Play
                          </button>
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
                          <p
                            style={{
                              margin: 0,
                              fontSize: "0.9rem",
                              color: "#1a1a1a",
                            }}
                          >
                            {text?.description ??
                              "No description is available for this card."}
                          </p>
                          {text?.castingRequirement != null ? (
                            <p
                              style={{
                                margin: 0,
                                fontSize: "0.85rem",
                                color: "#444",
                              }}
                            >
                              <strong>To play:</strong>{" "}
                              {text.castingRequirement}
                            </p>
                          ) : null}
                          {text?.targetRequirement != null ? (
                            <p
                              style={{
                                margin: 0,
                                fontSize: "0.85rem",
                                color: "#444",
                              }}
                            >
                              <strong>Target must:</strong>{" "}
                              {text.targetRequirement}
                            </p>
                          ) : null}
                          {text != null &&
                          text.castingRequirement == null &&
                          text.targetRequirement == null ? (
                            <p
                              style={{
                                margin: 0,
                                fontSize: "0.85rem",
                                color: "#444",
                                fontStyle: "italic",
                              }}
                            >
                              No requirements — it applies on its own.
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
