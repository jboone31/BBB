"use client";

/**
 * Team-selection presentational component (design §Components 5; Task 21.2;
 * Requirements 9.1, 9.2).
 *
 * This is the Player's F1.3 surface for picking a side: it lists the Game's
 * current Teams (each with its assigned color swatch), lets the Player
 * **join or switch** to any Team, and — while the Game still has room — lets
 * them **create a new Team**. Like its sibling entry components
 * ({@link CreateGame}, {@link JoinGame}) it is intentionally **presentational**:
 * it owns only its own create-team input state and inline validation feedback,
 * and delegates the mutations to `onSelectTeam` / `onCreateTeam` callbacks the
 * page (Task 22) wires to POST `/api/games/[gameId]/teams/select` and POST
 * `/api/games/[gameId]/teams`. The component knows nothing about sessions,
 * routing, or how a Team id resolves to a persisted row.
 *
 * Client-side feedback reuses the pure `lib/lobby` helpers so the Player sees
 * the same rules the server enforces:
 *  - {@link validateTeamName} for the new-team name (trimmed 1–100 chars —
 *    R4.4/R4.7), and
 *  - {@link TEAM_COLORS} to preview the color the next Team will be assigned
 *    (first free palette entry — R4.4), disabling create at {@link MAX_TEAMS}
 *    teams (R4.2/R4.3).
 * These are advisory hints only; the authoritative checks run server-side.
 *
 * Mobile-first constraints (R9.1/R9.2): single-column flex layout that fits a
 * 360–430px viewport with no horizontal overflow (controls are full width with
 * inherited `box-sizing: border-box`), and every interactive control is at
 * least 44×44 CSS pixels (`--touch-target`).
 */

import { useCallback, useMemo, useState } from "react";

import { MAX_TEAMS } from "@/lib/gameend";
import type { LobbyTeamView } from "@/lib/lobby/events";
import { TEAM_COLORS, validateTeamName } from "@/lib/lobby/team";

/** Minimum touch-target size for interactive controls (R9.2). */
const TOUCH_TARGET = "44px";

export interface TeamSelectionProps {
  /** The current Teams, each with its color and player ids (R9.4). */
  readonly teams: readonly LobbyTeamView[];
  /**
   * The Team the requesting Player is currently on, or `null` while teamless
   * (a valid lobby state per R3.9). Used to mark the active Team and to avoid
   * re-submitting a no-op selection.
   */
  readonly currentTeamId?: string | null;
  /**
   * Called when the Player joins or switches to a Team. The page wires this to
   * the team-select POST. May be async; the component reflects the in-flight
   * state via {@link submitting}.
   */
  readonly onSelectTeam: (teamId: string) => void | Promise<void>;
  /**
   * Called when the Player creates a new Team with a valid name. The page wires
   * this to the create-team POST. May be async.
   */
  readonly onCreateTeam: (name: string) => void | Promise<void>;
  /** True while a page-owned submission is in flight; disables all controls. */
  readonly submitting?: boolean;
  /**
   * A submission error surfaced by the page (e.g. team limit reached, lobby
   * closed). Local validation errors take priority and are shown inline.
   */
  readonly error?: string | null;
}

/** Shared inline style for full-width, ≥44px-tall text inputs (R9.1/R9.2). */
const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: TOUCH_TARGET,
  padding: "0.6rem 0.75rem",
  fontSize: "1rem",
  borderRadius: "0.5rem",
  border: "1px solid #888",
};

export default function TeamSelection({
  teams,
  currentTeamId = null,
  onSelectTeam,
  onCreateTeam,
  submitting = false,
  error = null,
}: TeamSelectionProps): React.JSX.Element {
  const [teamName, setTeamName] = useState("");
  const [attempted, setAttempted] = useState(false);

  // Create is gated on the team-count bound (R4.2/R4.3): once the Game holds
  // MAX_TEAMS teams no further team may be created.
  const atTeamLimit = teams.length >= MAX_TEAMS;

  // Preview the color the next Team will be assigned — the first palette entry
  // not already in use (R4.4) — so the Player sees the same choice the server
  // will make. `undefined` only when the palette is exhausted, which coincides
  // with `atTeamLimit`.
  const nextColor = useMemo<string | undefined>(() => {
    const usedColors = teams.map((team) => team.color);
    return TEAM_COLORS.find((color) => !usedColors.includes(color));
  }, [teams]);

  // Reuse the pure validator so the visible rule matches the server's exactly.
  const validationError = useMemo<string | null>(() => {
    if (atTeamLimit) {
      return `The game is full at ${MAX_TEAMS} teams.`;
    }
    if (!validateTeamName(teamName).ok) {
      return "Enter a team name (1–100 characters).";
    }
    return null;
  }, [atTeamLimit, teamName]);

  const handleCreate = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setAttempted(true);
      if (validationError !== null || submitting) {
        return;
      }
      const nameResult = validateTeamName(teamName);
      // Guarded by validationError above, but narrow for the type checker.
      if (!nameResult.ok) {
        return;
      }
      void onCreateTeam(nameResult.value);
    },
    [validationError, submitting, onCreateTeam, teamName],
  );

  const handleSelect = useCallback(
    (teamId: string) => {
      // No-op when already on this team or a submission is in flight.
      if (submitting || teamId === currentTeamId) {
        return;
      }
      void onSelectTeam(teamId);
    },
    [submitting, currentTeamId, onSelectTeam],
  );

  const shownValidation = attempted ? validationError : null;

  return (
    <section
      aria-labelledby="team-selection-heading"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        width: "100%",
        maxWidth: "100%",
      }}
    >
      <h2
        id="team-selection-heading"
        style={{ margin: 0, fontSize: "1.15rem" }}
      >
        Pick your team
      </h2>
      <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.4 }}>
        Join a team below, or create a new one. You can switch teams any time
        before the game starts.
      </p>

      {/* Existing teams: join / switch (R4.1, R4.5) */}
      {teams.length === 0 ? (
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}>
          No teams yet — create the first one below.
        </p>
      ) : (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          {teams.map((team) => {
            const isCurrent = team.id === currentTeamId;
            return (
              <li key={team.id}>
                <button
                  type="button"
                  onClick={() => handleSelect(team.id)}
                  disabled={submitting || isCurrent}
                  aria-pressed={isCurrent}
                  style={{
                    width: "100%",
                    minHeight: TOUCH_TARGET,
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                    padding: "0.6rem 0.75rem",
                    fontSize: "1rem",
                    textAlign: "left",
                    borderRadius: "0.5rem",
                    border: isCurrent ? "2px solid #1a1a1a" : "1px solid #888",
                    background: isCurrent ? "#f0f0f0" : "#ffffff",
                    color: "#1a1a1a",
                    cursor: submitting || isCurrent ? "not-allowed" : "pointer",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      flex: "0 0 auto",
                      width: "1rem",
                      height: "1rem",
                      borderRadius: "50%",
                      background: team.color,
                      border: "1px solid rgba(0, 0, 0, 0.2)",
                    }}
                  />
                  <span style={{ flex: "1 1 auto", wordBreak: "break-word" }}>
                    {team.name}
                  </span>
                  <span style={{ flex: "0 0 auto", fontSize: "0.8rem" }}>
                    {isCurrent
                      ? "Your team"
                      : `${team.playerIds.length} ${
                          team.playerIds.length === 1 ? "player" : "players"
                        }`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Create a new team (R4.2, R4.3, R4.4, R4.7) */}
      <form
        onSubmit={handleCreate}
        noValidate
        style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
      >
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}
        >
          <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>
            New team name
          </span>
          <input
            type="text"
            name="teamName"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            placeholder="e.g. The Hop Hunters"
            autoComplete="off"
            maxLength={200}
            disabled={submitting || atTeamLimit}
            style={inputStyle}
          />
        </label>

        {shownValidation !== null ? (
          <p
            role="alert"
            style={{ margin: 0, fontSize: "0.85rem", color: "#b00020" }}
          >
            {shownValidation}
          </p>
        ) : null}

        {error !== null && error !== "" ? (
          <p
            role="alert"
            aria-live="assertive"
            style={{ margin: 0, fontSize: "0.85rem", color: "#b00020" }}
          >
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting || atTeamLimit}
          style={{
            width: "100%",
            minHeight: TOUCH_TARGET,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
            padding: "0.7rem 1rem",
            fontSize: "1rem",
            fontWeight: 600,
            borderRadius: "0.5rem",
            border: "1px solid #444",
            background: submitting || atTeamLimit ? "#e5e5e5" : "#1a1a1a",
            color: submitting || atTeamLimit ? "#666" : "#ffffff",
            cursor: submitting || atTeamLimit ? "not-allowed" : "pointer",
          }}
        >
          {/* Preview the color the new team will get (R4.4). */}
          {nextColor !== undefined && !atTeamLimit ? (
            <span
              aria-hidden="true"
              style={{
                flex: "0 0 auto",
                width: "0.9rem",
                height: "0.9rem",
                borderRadius: "50%",
                background: nextColor,
                border: "1px solid rgba(255, 255, 255, 0.6)",
              }}
            />
          ) : null}
          <span>
            {atTeamLimit
              ? `Team limit reached (${MAX_TEAMS})`
              : submitting
                ? "Creating…"
                : "Create team"}
          </span>
        </button>
      </form>
    </section>
  );
}
