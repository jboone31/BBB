"use client";

/**
 * Join-a-game presentational component (design §Components 5; Task 21.1;
 * Requirements 9.1, 9.2).
 *
 * This is the Player's F1.2 entry surface: a mobile-first form to enter a
 * Join_Code and a display name. Like {@link CreateGame} it is intentionally
 * **presentational** — it owns only its own input state and inline validation
 * feedback and delegates submission (which POSTs to `/api/games/[gameId]/join`)
 * to an `onJoin` callback supplied by the page (Task 22). The component knows
 * nothing about sessions, routing, or how the code resolves to a game.
 *
 * Client-side feedback reuses the pure `lib/lobby` validators so the Player sees
 * the same shape rules the server enforces:
 *  - {@link isValidSubmittedCode}/{@link normalizeSubmittedCode} for the code
 *    (6–12 alphanumeric after trim + upcase — R3.1/R3.3), and
 *  - {@link validateDisplayName} for the name (trimmed 1–40 chars — R3.5/R3.6).
 * These are advisory hints only; the authoritative checks (and the game lookup)
 * run server-side.
 *
 * Mobile-first constraints (R9.1/R9.2): single-column flex layout that fits a
 * 360–430px viewport with no horizontal overflow, and controls ≥44×44 CSS px.
 */

import { useCallback, useMemo, useState } from "react";

import { validateDisplayName } from "@/lib/lobby/displayName";
import {
  isValidSubmittedCode,
  normalizeSubmittedCode,
} from "@/lib/lobby/joinCode";

/** Minimum touch-target size for interactive controls (R9.2). */
const TOUCH_TARGET = "44px";

/** The values a Player submits to join a Game. */
export interface JoinSubmission {
  /** The normalized Join_Code (trimmed + upcased). */
  readonly joinCode: string;
  /** The trimmed display name (1–40 chars). */
  readonly displayName: string;
}

export interface JoinGameProps {
  /**
   * Called when the Player submits a valid join form. The page wires this to
   * the join POST. May be async; the component reflects the in-flight state via
   * {@link submitting}.
   */
  readonly onJoin: (submission: JoinSubmission) => void | Promise<void>;
  /**
   * Optional initial Join_Code, e.g. pre-filled from a join link's code param.
   */
  readonly initialJoinCode?: string;
  /** True while the page-owned submission is in flight; disables submit. */
  readonly submitting?: boolean;
  /**
   * A submission error surfaced by the page (e.g. code not found, lobby
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

export default function JoinGame({
  onJoin,
  initialJoinCode = "",
  submitting = false,
  error = null,
}: JoinGameProps): React.JSX.Element {
  const [joinCode, setJoinCode] = useState(initialJoinCode);
  const [displayName, setDisplayName] = useState("");
  const [attempted, setAttempted] = useState(false);

  // Reuse the pure validators so the visible rules match the server's exactly.
  const validationError = useMemo<string | null>(() => {
    if (!isValidSubmittedCode(joinCode)) {
      return "Enter a 6–12 character join code.";
    }
    if (!validateDisplayName(displayName).ok) {
      return "Enter a display name (1–40 characters).";
    }
    return null;
  }, [joinCode, displayName]);

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setAttempted(true);
      if (validationError !== null || submitting) {
        return;
      }
      const nameResult = validateDisplayName(displayName);
      // Guarded by validationError above, but narrow for the type checker.
      if (!nameResult.ok) {
        return;
      }
      void onJoin({
        joinCode: normalizeSubmittedCode(joinCode),
        displayName: nameResult.value,
      });
    },
    [validationError, submitting, onJoin, joinCode, displayName],
  );

  const shownValidation = attempted ? validationError : null;

  return (
    <section
      aria-labelledby="join-game-heading"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        width: "100%",
        maxWidth: "100%",
      }}
    >
      <h2 id="join-game-heading" style={{ margin: 0, fontSize: "1.15rem" }}>
        Join a game
      </h2>
      <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.4 }}>
        Enter the join code your host shared and pick a display name your team
        will see.
      </p>

      <form
        onSubmit={handleSubmit}
        noValidate
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}
        >
          <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>Join code</span>
          <input
            type="text"
            name="joinCode"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="e.g. K7QP2M"
            autoComplete="off"
            autoCapitalize="characters"
            inputMode="text"
            disabled={submitting}
            style={{ ...inputStyle, textTransform: "uppercase" }}
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
            placeholder="e.g. Alex"
            autoComplete="off"
            maxLength={80}
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
          {submitting ? "Joining…" : "Join game"}
        </button>
      </form>
    </section>
  );
}
