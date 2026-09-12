"use client";

/**
 * Create-a-game presentational component (design §Components 5; Task 21.1;
 * Requirements 9.1, 9.2).
 *
 * This is the Admin's F1.1 entry surface: a mobile-first form to create a Game
 * and designate its Start_Bar and Finish_Bar by name. It is intentionally
 * **presentational** — it owns only its own form input state and client-side
 * validation feedback, and delegates the actual submission (which POSTs to
 * `/api/games` then `/api/games/[gameId]/bars`) to callbacks supplied by the
 * page (Task 22). This keeps the component free of network/session concerns so
 * it renders and tests in isolation.
 *
 * Mobile-first constraints (R9.1/R9.2): a single-column flex layout that fits a
 * 360–430px viewport without horizontal overflow (inputs/buttons are full width
 * with `box-sizing: border-box`, inherited from globals.css), and every
 * interactive control is at least 44×44 CSS pixels (`--touch-target`).
 *
 * The component reuses the pure `lib/lobby` validators for inline feedback so
 * the client shows the same accept/reject decision the server enforces
 * (`validateBarDesignation` for start ≠ finish is a server concern; here we
 * mirror the visible rules — non-empty bar names and start ≠ finish).
 */

import { useCallback, useMemo, useState } from "react";

import { validateDisplayName } from "@/lib/lobby/displayName";

/** Minimum touch-target size for interactive controls (R9.2). */
const TOUCH_TARGET = "44px";

/**
 * What the Admin submits when creating a Game (was: `BarDesignation`).
 *
 * Carries the designated bar names plus the Admin's Display_Name so the page
 * can create the Game, designate its bars, and immediately join the host as a
 * Player (Requirements 1.1–1.5).
 */
export interface CreateSubmission {
  /** The Start_Bar name (worth 0 points). Trimmed, non-empty. */
  readonly startBarName: string;
  /** The Finish_Bar name (claiming it ends the Game). Must differ from start. */
  readonly finishBarName: string;
  /** The Admin's Display_Name, trimmed to 1–40 chars (`validateDisplayName`). */
  readonly displayName: string;
}

export interface CreateGameProps {
  /**
   * Called when the Admin submits a valid create-game form. The page wires this
   * to the create + bar-designation + host-join POSTs. May be async; the
   * component reflects the in-flight state via {@link submitting}.
   */
  readonly onCreate: (submission: CreateSubmission) => void | Promise<void>;
  /**
   * True while the page-owned submission is in flight; disables the submit
   * control and shows a busy label so the Admin cannot double-submit.
   */
  readonly submitting?: boolean;
  /**
   * A submission error surfaced by the page (e.g. the create request failed).
   * Rendered as an assertive status message; local validation errors take
   * priority and are shown inline instead.
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

export default function CreateGame({
  onCreate,
  submitting = false,
  error = null,
}: CreateGameProps): React.JSX.Element {
  const [startBarName, setStartBarName] = useState("");
  const [finishBarName, setFinishBarName] = useState("");
  const [displayName, setDisplayName] = useState("");
  // Only surface validation messages after a submit attempt, so the form does
  // not scold the Admin before they have had a chance to fill it in.
  const [attempted, setAttempted] = useState(false);

  const trimmedStart = startBarName.trim();
  const trimmedFinish = finishBarName.trim();

  // Mirror the visible server rules for inline feedback: both bars are required,
  // the Finish_Bar must differ from the Start_Bar (R2.3 as the Admin sees it),
  // and the Display_Name must satisfy `validateDisplayName` so client feedback
  // matches the join route's enforced range (R1.2–R1.4, R6.1). The
  // authoritative checks still run server-side.
  const validationError = useMemo<string | null>(() => {
    if (trimmedStart.length === 0) {
      return "Enter a start bar name.";
    }
    if (trimmedFinish.length === 0) {
      return "Enter a finish bar name.";
    }
    if (trimmedStart.toLowerCase() === trimmedFinish.toLowerCase()) {
      return "The start and finish bars must be different.";
    }
    if (!validateDisplayName(displayName).ok) {
      return "Enter a display name (1–40 characters).";
    }
    return null;
  }, [trimmedStart, trimmedFinish, displayName]);

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setAttempted(true);
      if (validationError !== null || submitting) {
        return;
      }
      // Emit the trimmed Display_Name (R1.5); `validationError` already
      // guarantees the name is valid here.
      const nameResult = validateDisplayName(displayName);
      void onCreate({
        startBarName: trimmedStart,
        finishBarName: trimmedFinish,
        displayName: nameResult.ok ? nameResult.value : displayName.trim(),
      });
    },
    [
      validationError,
      submitting,
      onCreate,
      trimmedStart,
      trimmedFinish,
      displayName,
    ],
  );

  const shownValidation = attempted ? validationError : null;

  return (
    <section
      aria-labelledby="create-game-heading"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        width: "100%",
        maxWidth: "100%",
      }}
    >
      <h2 id="create-game-heading" style={{ margin: 0, fontSize: "1.15rem" }}>
        Create a game
      </h2>
      <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.4 }}>
        Set the start bar and finish bar for your Beltline Bar Brawl. You get a
        join code to share once the game is created.
      </p>

      <form
        onSubmit={handleSubmit}
        noValidate
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}
        >
          <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>Start bar</span>
          <input
            type="text"
            name="startBarName"
            value={startBarName}
            onChange={(e) => setStartBarName(e.target.value)}
            placeholder="e.g. Ladybird Grove"
            autoComplete="off"
            disabled={submitting}
            style={inputStyle}
          />
        </label>

        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}
        >
          <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>
            Finish bar
          </span>
          <input
            type="text"
            name="finishBarName"
            value={finishBarName}
            onChange={(e) => setFinishBarName(e.target.value)}
            placeholder="e.g. New Realm Brewing"
            autoComplete="off"
            disabled={submitting}
            style={inputStyle}
          />
        </label>

        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}
        >
          <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>
            Display name
          </span>
          <input
            type="text"
            name="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Captain of Team Ladybird"
            autoComplete="off"
            maxLength={40}
            disabled={submitting}
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
          disabled={submitting}
          style={{
            width: "100%",
            minHeight: TOUCH_TARGET,
            padding: "0.7rem 1rem",
            fontSize: "1rem",
            fontWeight: 600,
            borderRadius: "0.5rem",
            border: "1px solid #444",
            background: submitting ? "#e5e5e5" : "#1a1a1a",
            color: submitting ? "#666" : "#ffffff",
            cursor: submitting ? "not-allowed" : "pointer",
          }}
        >
          {submitting ? "Creating…" : "Create game"}
        </button>
      </form>
    </section>
  );
}
