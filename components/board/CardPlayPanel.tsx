"use client";

/**
 * Card_Play_Panel for the Game_Board (brawl-deck-architecture Tasks 8, 9),
 * replacing the former Card_Play_Wireframe.
 *
 * Presented when a player plays a held card. It drives the real targeting flow
 * against committed state and reports the chosen target(s) to `onConfirm`, which
 * the page POSTs to the real `/cards/play` route (R3.1).
 *
 * Targeting modes:
 *   - **team** (R3.2/R3.3): lists every other team and GRAYS OUT + disables the
 *     caster's own team and any team already targeted by a card of the same
 *     name, using {@link selectTeamTargetEligibility}.
 *   - **bar** (R3.4/R3.5): shows the current state of the map's bars (name +
 *     who claims it) and grays out + disables ineligible bars (the finish bar,
 *     or a bar already targeted by the same card) via
 *     {@link selectBarTargetEligibility}.
 *   - **team_and_bar** (R3.6): prompts for the BAR first, then the TEAM.
 *   - **none / self**: no target step; confirm directly.
 *
 * The same eligibility selectors drive the server's enforcement, so what the UI
 * grays out is exactly what the route rejects. This component owns only transient
 * selection state and enforces no card effect. Mobile-first: full-width single
 * column, 44px touch targets.
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
  selectBarTargetEligibility,
  selectTeamTargetEligibility,
  type BarTargetEligibility,
  type TeamTargetEligibility,
} from "@/lib/gameboard/cardEligibility";
import type { ClaimState } from "@/lib/map/claims";

const TOUCH_TARGET = "44px";

/** A selectable bar for the bar-targeting step (the map's candidate bars). */
export interface PlayTargetBar {
  readonly id: string;
  readonly name: string;
}

/** The target(s) a confirmed play carries. */
export interface PlayTargets {
  readonly targetTeamId?: string;
  readonly targetBarId?: string;
}

export interface CardPlayPanelProps {
  /** The held card being played. */
  readonly card: BoardCardView;
  /** The folded board view (source for targeting eligibility). */
  readonly view: GameBoardView;
  /** All teams in the game (defaults to `view.teams`). */
  readonly teams: readonly BoardTeamView[];
  /** The caster's own team id (excluded from the team target list). */
  readonly castingTeamId: string;
  /** Candidate bars for bar-targeting cards (the map's bars). */
  readonly bars?: readonly PlayTargetBar[];
  /** Current claim state (bar id -> claiming team ids), to show map state. */
  readonly claims?: ClaimState;
  /** The finish bar id, excluded from bar targeting (R3.5), or null if unknown. */
  readonly finishBarId?: string | null;
  /**
   * Confirm the play with the chosen target(s). Never called while a required
   * target is unselected.
   */
  readonly onConfirm: (targets: PlayTargets) => void;
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

function teamReasonLabel(reason: TeamTargetEligibility["reason"]): string {
  switch (reason) {
    case "own_team":
      return "your team";
    case "already_targeted_same_card":
      return "already targeted by this card";
    default:
      return "";
  }
}

function barReasonLabel(reason: BarTargetEligibility["reason"]): string {
  switch (reason) {
    case "finish_bar":
      return "finish bar";
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
  bars = [],
  claims = {},
  finishBarId = null,
  onConfirm,
  onCancel,
  pending = false,
}: CardPlayPanelProps): React.JSX.Element {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedBarId, setSelectedBarId] = useState<string | null>(null);
  const [showRequired, setShowRequired] = useState(false);

  const name = cardName(card.slug);
  const mode = targetModeOf(card.slug);
  const targetsTeam = mode === "team" || mode === "team_and_bar";
  const targetsBar = mode === "bar" || mode === "team_and_bar";

  // team_and_bar is ordered: the BAR must be chosen before the TEAM step is
  // revealed (R3.6). For a bar-only or team-only card the single step shows.
  const barStepActive = targetsBar;
  const teamStepActive = targetsTeam && (!targetsBar || selectedBarId !== null);

  const teamRows = selectTeamTargetEligibility(
    view,
    card.slug as CardSlug,
    castingTeamId,
    teams,
  ).filter((row) => row.reason !== "own_team");

  const barRows = selectBarTargetEligibility(
    view,
    card.slug as CardSlug,
    bars.map((bar) => bar.id),
    finishBarId,
  );
  const barById = new Map(bars.map((bar) => [bar.id, bar]));
  const teamById = new Map(teams.map((team) => [team.id, team]));

  function handleConfirm(): void {
    if (targetsBar && selectedBarId === null) {
      setShowRequired(true);
      return;
    }
    if (targetsTeam && selectedTeamId === null) {
      setShowRequired(true);
      return;
    }
    onConfirm({
      targetBarId: targetsBar ? (selectedBarId ?? undefined) : undefined,
      targetTeamId: targetsTeam ? (selectedTeamId ?? undefined) : undefined,
    });
  }

  function claimSummary(barId: string): string {
    const claimers = claims[barId] ?? [];
    if (claimers.length === 0) {
      return "unclaimed";
    }
    const names = claimers.map((id) => teamById.get(id)?.name ?? id).join(", ");
    return `claimed by ${names}`;
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
      <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Play “{name}”</h2>
      <p style={{ margin: 0, fontSize: "0.85rem", color: "#555" }}>
        {getCardText(card.slug as CardSlug).description}
      </p>

      {/* Bar step (shown first for team_and_bar, R3.6). */}
      {barStepActive ? (
        <div
          role="group"
          aria-label="Choose a target bar"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            width: "100%",
          }}
        >
          <p style={{ margin: 0, fontSize: "0.9rem", color: "#444" }}>
            Choose a target bar:
          </p>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.4rem",
              maxHeight: "14rem",
              overflowY: "auto",
            }}
          >
            {barRows.map((row) => {
              const bar = barById.get(row.barId);
              if (bar === undefined) {
                return null;
              }
              const isSelected = row.barId === selectedBarId;
              const disabled = !row.eligible || pending;
              return (
                <li key={row.barId}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-disabled={!row.eligible}
                    disabled={disabled}
                    title={
                      row.eligible ? undefined : barReasonLabel(row.reason)
                    }
                    onClick={() => {
                      if (!row.eligible) {
                        return;
                      }
                      setSelectedBarId(row.barId);
                      // Choosing a different bar re-opens the team step cleanly.
                      setShowRequired(false);
                    }}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: "0.1rem",
                      width: "100%",
                      minHeight: TOUCH_TARGET,
                      padding: "0.5rem 0.6rem",
                      fontSize: "0.95rem",
                      textAlign: "left",
                      borderRadius: "0.5rem",
                      border: isSelected
                        ? "2px solid #1a1a1a"
                        : "1px solid #888",
                      background: !row.eligible
                        ? "#eeeeee"
                        : isSelected
                          ? "#eef"
                          : "#ffffff",
                      color: row.eligible ? "#1a1a1a" : "#999",
                      cursor: row.eligible ? "pointer" : "not-allowed",
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>
                      {bar.name}
                      {!row.eligible ? (
                        <span style={{ fontSize: "0.75rem", color: "#999" }}>
                          {" "}
                          ({barReasonLabel(row.reason)})
                        </span>
                      ) : null}
                    </span>
                    <span style={{ fontSize: "0.75rem", color: "#777" }}>
                      {claimSummary(row.barId)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Team step (revealed after the bar for team_and_bar, R3.6). */}
      {teamStepActive ? (
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
          {teamRows.map((row) => {
            const team = teamById.get(row.teamId);
            if (team === undefined) {
              return null;
            }
            const isSelected = row.teamId === selectedTeamId;
            const disabled = !row.eligible || pending;
            return (
              <button
                key={row.teamId}
                type="button"
                aria-pressed={isSelected}
                aria-disabled={!row.eligible}
                disabled={disabled}
                title={row.eligible ? undefined : teamReasonLabel(row.reason)}
                onClick={() => {
                  if (!row.eligible) {
                    return;
                  }
                  setSelectedTeamId(row.teamId);
                  setShowRequired(false);
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
                    ({teamReasonLabel(row.reason)})
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {showRequired ? (
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
          {targetsBar && selectedBarId === null
            ? "Choose an eligible target bar before playing this card."
            : "Choose an eligible target team before playing this card."}
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
