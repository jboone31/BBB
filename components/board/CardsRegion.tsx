"use client";

/**
 * Cards_Region surface for the Game_Board (design §Components 4; Task 8.5;
 * Requirements 5.1, 5.2, 5.3, 5.4).
 *
 * This presentational component renders the current Player's placeholder hand as
 * a wireframe (R5.1). It draws no real cards and owns no hand state: the hand is
 * a stable, deterministic list of 1–8 {@link PlaceholderCard}s produced by
 * {@link placeholderHand} (seeded by the Player id), each rendered as a card with
 * its own play control (R5.2). Activating a play control simply reports the card
 * to the `onPlayCard` callback the page (Task 11) wires to the Card_Play_Wireframe
 * (Task 9.1); this component neither plays nor enforces anything.
 *
 * A "later feature" label makes clear that real card draw and hand contents are
 * provided by a future feature (R5.3).
 *
 * When the current Session is the Admin and is *not* a Player of the Game, there
 * is no hand to show — a hand belongs to Players. In that case the component
 * renders an explanatory indication instead of a hand and offers no play controls
 * (R5.4).
 *
 * Mobile-first constraints (R9): a single-column layout that fits a 320–430px
 * viewport with no horizontal overflow (inherited `box-sizing: border-box`), and
 * every play control is at least 44×44 CSS pixels.
 */

import type { PlaceholderCard } from "@/lib/gameboard/placeholderCards";

/** Minimum touch-target size for interactive controls (R9.3). */
const TOUCH_TARGET = "44px";

export interface CardsRegionProps {
  /**
   * The current Player's placeholder hand of 1–8 cards (R5.2). Precomputed by the
   * page via `placeholderHand(playerId)` so the surface is stable across renders.
   * Ignored when {@link CardsRegionProps.adminNotPlayer} is `true`.
   */
  readonly hand: readonly PlaceholderCard[];
  /**
   * `true` when the current Session is the Admin and is not a Player of the Game.
   * In that case the Region shows an indication that a hand belongs to Players
   * instead of rendering a hand (R5.4).
   */
  readonly adminNotPlayer: boolean;
  /**
   * Called when the Player activates a card's play control (R5.2). The page wires
   * this to the Card_Play_Wireframe; this component only reports the chosen card.
   */
  readonly onPlayCard: (card: PlaceholderCard) => void;
}

export default function CardsRegion({
  hand,
  adminNotPlayer,
  onPlayCard,
}: CardsRegionProps): React.JSX.Element {
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
      {/* "later feature" label — real card draw and hand contents are owned by a
          future feature (R5.3). Always shown so the wireframe is self-describing. */}
      <p
        style={{
          margin: 0,
          fontSize: "0.85rem",
          fontStyle: "italic",
          color: "#666",
        }}
      >
        Card draw and hand contents are provided by a later feature.
      </p>

      {adminNotPlayer ? (
        // The Admin (when not also a Player) has no hand: a hand belongs to
        // Players (R5.4). Show an indication instead of a hand, with no play
        // controls.
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
        // The Player's placeholder hand surface (R5.1): 1–8 cards, each with its
        // own play control (R5.2).
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
          {hand.map((card) => (
            <li
              key={card.id}
              style={{
                display: "flex",
                flexDirection: "row",
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
                {card.label}
              </span>
              <button
                type="button"
                aria-label={`Play ${card.label}`}
                onClick={() => onPlayCard(card)}
                style={{
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
                  background: "#1a1a1a",
                  color: "#ffffff",
                  cursor: "pointer",
                }}
              >
                Play
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
