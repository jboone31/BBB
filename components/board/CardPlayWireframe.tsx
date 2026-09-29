"use client";

/**
 * Card_Play_Wireframe for the Game_Board (design §Components 4; Task 9.1;
 * Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 9.4).
 *
 * This presentational component represents the future card-play flow as a
 * wireframe. It is *presented on play* — the Cards_Region renders it when a
 * Player activates a placeholder card's play control (R6.1); this component owns
 * only the transient in-flight selection/acknowledgement state and delegates the
 * real work to `onConfirm` / `onCancel`.
 *
 * Behavior it guarantees:
 *  - Targeting card ({@link PlaceholderCard.targetsTeam} `true`): it renders a
 *    target-selection control listing **every other Team** in the Game, excluding
 *    the caller's own Team (R6.2). Selecting a target reveals a wireframe
 *    confirmation naming the selected Team (R6.4).
 *  - Non-targeting card (`targetsTeam` `false`): it omits target selection
 *    entirely and shows the confirm control directly (R6.3).
 *  - Confirming a targeting card with no target selected shows a "target
 *    required" indication and does NOT complete the play (R6.5) — `onConfirm` is
 *    not called.
 *  - Confirming shows a wireframe acknowledgement and enforces nothing (R6.6);
 *    for a targeting card it hands the chosen `targetTeamId` to `onConfirm` so
 *    the page can POST, but this component alters no score, blocks no Team, and
 *    changes no Region.
 *  - Cancel dismisses via `onCancel` and leaves the Cards_Region unchanged
 *    (R6.7) — no `onConfirm`, no state written upstream.
 *
 * Mobile-first constraint (R9.4): a full-width single column with inherited
 * `box-sizing: border-box` and no fixed px width, so it fits a 320–430px
 * viewport with no horizontal scroll. Interactive controls are ≥44×44 CSS px.
 *
 * Test-friendly markers (used by the Task 9.2 property test and Task 9.4/13.2
 * component/viewport tests, none written here):
 *  - The whole wireframe is a `role="dialog"` with `aria-label="Play card"`.
 *  - Each target option is a `<button>` whose accessible name is the Team name
 *    (so the target list is enumerable by role `button` within the target
 *    group `aria-label="Choose a target team"`); the own Team is never rendered.
 *  - The confirm control's accessible name is "Confirm", cancel is "Cancel".
 *  - The "target required" message carries `role="alert"`; the naming
 *    confirmation and final acknowledgement carry `role="status"`.
 */

import { useState } from "react";

import type { BoardTeamView } from "@/lib/gameboard/events";
import type { PlaceholderCard } from "@/lib/gameboard/placeholderCards";

/** Minimum touch-target size for interactive controls (R9.4/R9.3). */
const TOUCH_TARGET = "44px";

export interface CardPlayWireframeProps {
  /** The placeholder card being played — drives targeting vs. non-targeting flow. */
  readonly card: PlaceholderCard;
  /** Every Team in the Game (the target list is derived by excluding own Team). */
  readonly teams: readonly BoardTeamView[];
  /** The caller's own Team id — excluded from the target list (R6.2). */
  readonly ownTeamId: string;
  /**
   * Called when the Player confirms the play (R6.6). For a targeting card the
   * selected `targetTeamId` is passed so the page can POST to
   * `/api/games/{gameId}/wireframe-card-play`; for a non-targeting card it is
   * `undefined`. Never called for a targeting card with no target selected (R6.5).
   */
  readonly onConfirm: (targetTeamId?: string) => void;
  /** Called when the Player cancels; the Region is left unchanged (R6.7). */
  readonly onCancel: () => void;
}

export default function CardPlayWireframe({
  card,
  teams,
  ownTeamId,
  onConfirm,
  onCancel,
}: CardPlayWireframeProps): React.JSX.Element {
  // Transient in-flight state: the chosen target (targeting cards only), whether
  // a "target required" warning is showing, and whether the play has been
  // confirmed (acknowledgement shown). All local — nothing here enforces a card
  // effect, alters a score, or blocks a Region (R6.6).
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [showTargetRequired, setShowTargetRequired] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  // The target list: every other Team, excluding the caller's own Team (R6.2).
  const targetableTeams = teams.filter((team) => team.id !== ownTeamId);

  const selectedTeam =
    selectedTargetId === null
      ? null
      : (targetableTeams.find((team) => team.id === selectedTargetId) ?? null);

  function handleSelect(teamId: string): void {
    setSelectedTargetId(teamId);
    // Selecting clears any prior "target required" warning (R6.4).
    setShowTargetRequired(false);
  }

  function handleConfirm(): void {
    if (card.targetsTeam && selectedTargetId === null) {
      // Confirming a targeting card with no target selected: warn and do NOT
      // complete the play (R6.5). onConfirm is not called.
      setShowTargetRequired(true);
      return;
    }
    // Wireframe acknowledgement + delegate to the page (R6.6). A non-targeting
    // card passes no target.
    setConfirmed(true);
    onConfirm(card.targetsTeam ? (selectedTargetId ?? undefined) : undefined);
  }

  return (
    <section
      role="dialog"
      aria-label="Play card"
      aria-modal="false"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        width: "100%",
        maxWidth: "100%",
        padding: "0.75rem",
        border: "1px solid #1a1a1a",
        borderRadius: "0.5rem",
        background: "#ffffff",
      }}
    >
      <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Play “{card.label}”</h2>

      {confirmed ? (
        // Final wireframe acknowledgement (R6.6). Enforces nothing.
        <p
          role="status"
          style={{
            margin: 0,
            padding: "0.6rem 0.75rem",
            fontSize: "0.9rem",
            color: "#1a1a1a",
            border: "1px dashed #1a1a1a",
            borderRadius: "0.5rem",
            background: "#fffbea",
          }}
        >
          Placeholder: this card play is a wireframe. It enforces no effect,
          changes no score, and blocks no team.
        </p>
      ) : (
        <>
          {card.targetsTeam ? (
            <div
              role="group"
              aria-label="Choose a target team"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
                width: "100%",
              }}
            >
              <p style={{ margin: 0, fontSize: "0.9rem", color: "#444" }}>
                Choose a target team:
              </p>
              {targetableTeams.map((team) => {
                const isSelected = team.id === selectedTargetId;
                return (
                  <button
                    key={team.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => handleSelect(team.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      width: "100%",
                      minHeight: TOUCH_TARGET,
                      padding: "0.6rem 0.75rem",
                      fontSize: "1rem",
                      textAlign: "left",
                      borderRadius: "0.5rem",
                      border: isSelected
                        ? "2px solid #1a1a1a"
                        : "1px solid #888",
                      background: isSelected ? "#eef" : "#ffffff",
                      color: "#1a1a1a",
                      cursor: "pointer",
                    }}
                  >
                    {/* Team color swatch (R4.2 parity; decorative here). */}
                    <span
                      aria-hidden="true"
                      style={{
                        display: "inline-block",
                        width: "1rem",
                        height: "1rem",
                        borderRadius: "50%",
                        background: team.color,
                        border: "1px solid #0003",
                        flex: "0 0 auto",
                      }}
                    />
                    {team.name}
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* Naming confirmation once a target is selected (R6.4). */}
          {card.targetsTeam && selectedTeam !== null ? (
            <p
              role="status"
              style={{
                margin: 0,
                padding: "0.6rem 0.75rem",
                fontSize: "0.9rem",
                color: "#1a1a1a",
                border: "1px solid #888",
                borderRadius: "0.5rem",
                background: "#f5f7ff",
              }}
            >
              Target selected: {selectedTeam.name}.
            </p>
          ) : null}

          {/* "target required" indication (R6.5). */}
          {showTargetRequired ? (
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
              A target is required before you can play this card.
            </p>
          ) : null}

          {/* Confirm + Cancel controls. For a non-targeting card the confirm
              control is shown directly with no target selection (R6.3). */}
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              gap: "0.5rem",
              width: "100%",
            }}
          >
            <button
              type="button"
              onClick={handleConfirm}
              style={{
                flex: "1 1 0",
                minWidth: TOUCH_TARGET,
                minHeight: TOUCH_TARGET,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "0.6rem 1rem",
                fontSize: "1rem",
                fontWeight: 600,
                borderRadius: "0.5rem",
                border: "1px solid #1a1a1a",
                background: "#1a1a1a",
                color: "#ffffff",
                cursor: "pointer",
              }}
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={onCancel}
              style={{
                flex: "1 1 0",
                minWidth: TOUCH_TARGET,
                minHeight: TOUCH_TARGET,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "0.6rem 1rem",
                fontSize: "1rem",
                fontWeight: 500,
                borderRadius: "0.5rem",
                border: "1px solid #888",
                background: "#ffffff",
                color: "#1a1a1a",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}
