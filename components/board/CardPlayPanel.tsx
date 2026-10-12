"use client";

/**
 * Card_Play_Panel for the Game_Board (brawl-deck-architecture Task 8), replacing
 * the former Card_Play_Wireframe.
 *
 * Presented when a player plays a held card. It drives the real targeting flow
 * against committed state and reports the chosen target(s) to `onConfirm`, which
 * the page POSTs to the real `/cards/play` route (R3.1).
 *
 * Team targeting (R3.2/R3.3): for a team-targeting card it lists every other
 * team and GRAYS OUT + disables teams that are ineligible — the caster's own
 * team and any team already targeted by a card of the same name — using the pure
 * {@link selectTeamTargetEligibility} selector over the folded view, the same
 * rule the server enforces. A disabled team cannot be selected; its row shows
 * why.
 *
 * Bar targeting (task 9) is not handled here yet; a `bar` / `team_and_bar` card
 * is surfaced with a note that bar selection is pending.
 *
 * This component owns only transient selection/acknowledgement state and enforces
 * no card effect. Mobile-first: full-width single column, 44px touch targets.
 */

import { useState } from "react";

import {
  getCardMetadata,
  getCardText,
  type CardSlug,
} from "@/lib/cards/catalog";
import type {
  BoardCardView,
  BoardTeamView,
  GameBoardView,
} from "@/lib/gameboard/events";
import {
  selectTeamTargetEligibility,
  type TeamTargetEligibility,
} from "@/lib/gameboard/cardEligibility";

const TOUCH_TARGET = "44px";

export interface CardPlayPanelProps {
  /** The held card being played. */
  readonly card: BoardCardView;
  /** The folded board view (source for team targeting eligibility). */
  readonly view: GameBoardView;
  /** All teams in the game (defaults to `view.teams`). */
  readonly teams: readonly BoardTeamView[];
  /** The caster's own team id (excluded from the target list). */
  readonly castingTeamId: string;
  /**
   * Confirm the play. For a team-targeting card the chosen `targetTeamId` is
   * passed; for a no-target card it is undefined. Never called for a
   * team-targeting card with no eligible target selected.
   */
  readonly onConfirm: (args: { targetTeamId?: string }) => void;
  /** Cancel and dismiss, leaving the hand unchanged. */
  readonly onCancel: () => void;
  /** True while the confirm POST is in flight (disables controls). */
  readonly pending?: boolean;
}

function cardName(slug: string): string {
  try {
    return getCardMetadata(slug as CardSlug).name;
  } catch {
    return slug;
  }
}

function targetModeOf(slug: string): string {
  try {
    return getCardMetadata(slug as CardSlug).targetMode;
  } catch {
    return "none";
  }
}

function reasonLabel(reason: TeamTargetEligibility["reason"]): string {
  switch (reason) {
    case "own_team":
      return "your team";
    case "already_targeted_same_card":
      return "already targeted by this card";
    default:
      return "";
  }
}

export default function CardPlayPanel({
  card,
  view,
  teams,
  castingTeamId,
  onConfirm,
  onCancel,
  pending = false,
}: CardPlayPanelProps): React.JSX.Element {
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [showTargetRequired, setShowTargetRequired] = useState(false);

  const name = cardName(card.slug);
  const mode = targetModeOf(card.slug);
  const targetsTeam = mode === "team" || mode === "team_and_bar";
  const targetsBar = mode === "bar" || mode === "team_and_bar";

  const eligibility = selectTeamTargetEligibility(
    view,
    card.slug as CardSlug,
    castingTeamId,
    teams,
  );
  // The target list excludes the caster's own team entirely; other teams are
  // shown, with ineligible ones disabled (R3.2/R3.3).
  const targetRows = eligibility.filter((row) => row.reason !== "own_team");

  function handleConfirm(): void {
    if (targetsTeam) {
      if (selectedTargetId === null) {
        setShowTargetRequired(true);
        return;
      }
      onConfirm({ targetTeamId: selectedTargetId });
      return;
    }
    onConfirm({});
  }

  const teamById = new Map(teams.map((team) => [team.id, team]));

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
      <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Play “{name}”</h2>
      <p style={{ margin: 0, fontSize: "0.85rem", color: "#555" }}>
        {getCardText(card.slug as CardSlug).description}
      </p>

      {targetsBar ? (
        <p
          role="status"
          style={{
            margin: 0,
            padding: "0.6rem 0.75rem",
            fontSize: "0.85rem",
            color: "#444",
            border: "1px dashed #888",
            borderRadius: "0.5rem",
            background: "#f7f7f7",
          }}
        >
          Bar selection for this card is handled on the map (coming next).
        </p>
      ) : null}

      {targetsTeam ? (
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
          {targetRows.map((row) => {
            const team = teamById.get(row.teamId);
            if (team === undefined) {
              return null;
            }
            const isSelected = row.teamId === selectedTargetId;
            const disabled = !row.eligible || pending;
            return (
              <button
                key={row.teamId}
                type="button"
                aria-pressed={isSelected}
                aria-disabled={!row.eligible}
                disabled={disabled}
                title={row.eligible ? undefined : reasonLabel(row.reason)}
                onClick={() => {
                  if (!row.eligible) {
                    return;
                  }
                  setSelectedTargetId(row.teamId);
                  setShowTargetRequired(false);
                }}
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
                  border: isSelected ? "2px solid #1a1a1a" : "1px solid #888",
                  background: !row.eligible
                    ? "#eeeeee"
                    : isSelected
                      ? "#eef"
                      : "#ffffff",
                  color: row.eligible ? "#1a1a1a" : "#999",
                  cursor: row.eligible ? "pointer" : "not-allowed",
                }}
              >
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
                    opacity: row.eligible ? 1 : 0.4,
                  }}
                />
                <span style={{ flex: "1 1 auto" }}>{team.name}</span>
                {!row.eligible ? (
                  <span style={{ fontSize: "0.75rem", color: "#999" }}>
                    ({reasonLabel(row.reason)})
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

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
          Choose an eligible target team before playing this card.
        </p>
      ) : null}

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
          disabled={pending}
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
            background: pending ? "#9a9a9a" : "#1a1a1a",
            color: "#ffffff",
            cursor: pending ? "not-allowed" : "pointer",
          }}
        >
          {pending ? "Playing…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
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
            cursor: pending ? "not-allowed" : "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
