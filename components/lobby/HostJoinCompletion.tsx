"use client";

/**
 * Host-join-completion presentational component
 * (design §Components 2; Task 3.1; Requirements 3.2, 3.3, 4.3).
 *
 * This is the recovery/entry surface for a **not-yet-joined Admin**: a Session
 * that created a Game (holds `bbb:admin:{gameId}`) but has no Player_Fact yet —
 * either because the create-then-join sequence's join step failed (R3.1/R3.2)
 * or simply as the host's normal path to becoming a Player.
 *
 * Unlike {@link JoinGame}, this surface collects **only** a Display_Name and has
 * **no code input**: the host already owns the Game and the authoritative
 * Join_Code lives in the page's folded view (`view.joinCode`). The page attaches
 * that code when it issues the join, so this component just gathers the name and
 * calls {@link HostJoinCompletionProps.onComplete} with the trimmed, valid value.
 *
 * Like the other lobby surfaces it is intentionally **presentational** — it owns
 * only its own input state and inline validation feedback and delegates the
 * actual join POST to the page. Client-side feedback reuses the same pure
 * {@link validateDisplayName} validator the server enforces (trimmed 1–40 chars,
 * R6.1), so the host sees the same rule the Join_Service applies. This hint is
 * advisory only; the authoritative check runs server-side.
 *
 * Mobile-first constraints, consistent with the sibling lobby components: a
 * single-column flex layout that fits a 360–430px viewport with no horizontal
 * overflow, and controls ≥44×44 CSS px.
 */

import { useCallback, useMemo, useState } from "react";

import { validateDisplayName } from "@/lib/lobby/displayName";

/** Minimum touch-target size for interactive controls. */
const TOUCH_TARGET = "44px";

export interface HostJoinCompletionProps {
  /**
   * Called when the host submits a valid display name. The page attaches the
   * Join_Code (from its folded `view.joinCode`) and wires this to the join POST.
   * May be async; the component reflects the in-flight state via
   * {@link submitting}.
   */
  readonly onComplete: (displayName: string) => void | Promise<void>;
  /** True while the page-owned submission is in flight; disables submit. */
  readonly submitting?: boolean;
  /**
   * A submission error surfaced by the page (e.g. join failed). Local
   * validation errors take priority and are shown inline.
   */
  readonly error?: string | null;
}

/** Shared inline style for full-width, ≥44px-tall text inputs. */
const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: TOUCH_TARGET,
  padding: "0.6rem 0.75rem",
  fontSize: "1rem",
  borderRadius: "0.5rem",
  border: "1px solid #888",
};

export default function HostJoinCompletion({
  onComplete,
  submitting = false,
  error = null,
}: HostJoinCompletionProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState("");
  const [attempted, setAttempted] = useState(false);

  // Reuse the pure validator so the visible rule matches the server's exactly.
  const validationError = useMemo<string | null>(() => {
    if (!validateDisplayName(displayName).ok) {
      return "Enter a display name (1–40 characters).";
    }
    return null;
  }, [displayName]);

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
      void onComplete(nameResult.value);
    },
    [validationError, submitting, onComplete, displayName],
  );

  const shownValidation = attempted ? validationError : null;

  return (
    <section
      aria-labelledby="host-join-completion-heading"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        width: "100%",
        maxWidth: "100%",
      }}
    >
      <h2
        id="host-join-completion-heading"
        style={{ margin: 0, fontSize: "1.15rem" }}
      >
        Finish joining your game
      </h2>
      <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.4 }}>
        You created this game, so you already have the join code. Pick a display
        name to join as a player and choose your team.
      </p>

      <form
        onSubmit={handleSubmit}
        noValidate
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
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
