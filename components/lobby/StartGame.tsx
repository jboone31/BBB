"use client";

/**
 * Start-game presentational component (design §Components 5; Task 21.2;
 * Requirements 9.1, 9.2).
 *
 * This is the Admin's control to flip a Game from `lobby` to `live`. Like its
 * sibling lobby components it is intentionally **presentational**: it holds no
 * state, performs no I/O, and delegates the transition to an `onStart` callback
 * the page (Task 22) wires to POST `/api/games/[gameId]/start`. The button is
 * **enabled only when the Game is eligible to start**, mirroring the two server
 * preconditions so the Admin sees the same accept/reject decision the server
 * enforces:
 *
 *  - {@link canStartGame} on the Team count — 2–4 Teams, counting **teams only**
 *    (teamless Players are excluded, R5.9/R5.10; the count is `teams.length`),
 *    and
 *  - {@link bothBarsDesignated} — both the Start_Bar and Finish_Bar must be
 *    designated (R5.5).
 *
 * When ineligible, the button is disabled and a short reason explains what is
 * still needed, so the Admin knows why they cannot start yet. The eligibility
 * check here is advisory; the authoritative gates run server-side inside the
 * start transaction.
 *
 * Mobile-first constraints (R9.1/R9.2): single-column full-width layout that
 * fits a 360–430px viewport with no horizontal overflow, and the start control
 * is at least 44×44 CSS pixels (`--touch-target`).
 */

import { bothBarsDesignated } from "@/lib/lobby/gate";
import { canStartGame, MAX_TEAMS, MIN_TEAMS } from "@/lib/gameend";

/** Minimum touch-target size for interactive controls (R9.2). */
const TOUCH_TARGET = "44px";

export interface StartGameProps {
  /**
   * The number of Teams currently in the Game — counts **teams only**, not
   * teamless Players (R5.9/R5.10). Typically `teams.length` from the lobby view.
   */
  readonly teamCount: number;
  /** The Game's designated Start_Bar id, or `null` when undesignated (R5.5). */
  readonly startBarId: string | null;
  /** The Game's designated Finish_Bar id, or `null` when undesignated (R5.5). */
  readonly finishBarId: string | null;
  /**
   * Called when the Admin starts an eligible Game. The page wires this to the
   * start POST. May be async; the component reflects the in-flight state via
   * {@link submitting}.
   */
  readonly onStart: () => void | Promise<void>;
  /** True while the page-owned start is in flight; disables the control. */
  readonly submitting?: boolean;
  /**
   * A submission error surfaced by the page (e.g. the start request failed).
   * Rendered as an assertive status message below the control.
   */
  readonly error?: string | null;
}

export default function StartGame({
  teamCount,
  startBarId,
  finishBarId,
  onStart,
  submitting = false,
  error = null,
}: StartGameProps): React.JSX.Element {
  // Mirror the two server preconditions for enable/disable (R5.5, R5.9/R5.10).
  const teamsOk = canStartGame(teamCount);
  const barsOk = bothBarsDesignated(startBarId, finishBarId);
  const eligible = teamsOk && barsOk;
  const disabled = submitting || !eligible;

  // Explain the first unmet precondition so the Admin knows what to fix.
  const ineligibleReason: string | null = eligible
    ? null
    : !teamsOk
      ? teamCount < MIN_TEAMS
        ? `Need at least ${MIN_TEAMS} teams to start (currently ${teamCount}).`
        : `Too many teams — the game allows up to ${MAX_TEAMS} (currently ${teamCount}).`
      : "Designate both a start bar and a finish bar to start.";

  const handleClick = (): void => {
    if (disabled) {
      return;
    }
    void onStart();
  };

  return (
    <section
      aria-labelledby="start-game-heading"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        width: "100%",
        maxWidth: "100%",
      }}
    >
      <h2 id="start-game-heading" style={{ margin: 0, fontSize: "1.15rem" }}>
        Start the game
      </h2>

      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        style={{
          width: "100%",
          minHeight: TOUCH_TARGET,
          padding: "0.7rem 1rem",
          fontSize: "1rem",
          fontWeight: 600,
          borderRadius: "0.5rem",
          border: "1px solid #444",
          background: disabled ? "#e5e5e5" : "#1a1a1a",
          color: disabled ? "#666" : "#ffffff",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        {submitting ? "Starting…" : "Start game"}
      </button>

      {ineligibleReason !== null ? (
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}>
          {ineligibleReason}
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
    </section>
  );
}
