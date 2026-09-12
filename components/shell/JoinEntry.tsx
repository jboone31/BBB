"use client";

/**
 * Join_Entry control (design §Components 6; Task 7.1; Requirements 4.1–4.6, 7.3).
 *
 * The Landing_Page area where a Player submits a Join_Code to reach a Game's
 * lobby. Unlike {@link HostEntry} (a plain link) this control owns transient
 * view state and talks to the network, so it is a client component: it holds the
 * raw code input, guards against double-submits while a request is in flight,
 * calls the read-only Resolution_Service, and navigates to the resolved lobby.
 *
 * Client-side shape validation reuses the pure `lib/lobby` validators so the
 * Player sees the same 6–12-alphanumeric rule the server enforces; the server
 * remains authoritative. Requirement mapping:
 *  - R4.1: renders a code text input and a submit control.
 *  - R4.2: a code whose normalized value is not 6–12 alphanumeric shows an
 *    invalid-code message and issues NO resolution request.
 *  - R4.3: a well-formed code is normalized and sent to the Resolution_Service.
 *  - R4.4: on a matching id, navigates to `/games/{gameId}/lobby` carrying the
 *    normalized code as `?code=` so the lobby can prefill it.
 *  - R4.5: a not-found result (404) shows a uniform code-not-recognized message.
 *  - R4.6: the submit control is disabled while a request is in flight.
 *  - R7.3: the submit control presents a ≥ 44×44 CSS px touch target.
 *
 * A thrown fetch (network failure) is treated as the same uniform
 * code-not-recognized outcome as a 404 — the caller cannot tell a miss from a
 * transport error — and the submit control is always re-enabled in `finally`.
 *
 * Styling mirrors the lobby/`HostEntry` primary-control convention (dark brand
 * fill, white text, rounded, full-width, ≥44px tall) so the entry point reads as
 * the same family of controls across the app.
 */

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import {
  isValidSubmittedCode,
  normalizeSubmittedCode,
} from "@/lib/lobby/joinCode";

/** Minimum touch-target size for interactive controls (R7.3). */
const TOUCH_TARGET = "44px";

/** Shown when the entered code fails the 6–12-alphanumeric shape check (R4.2). */
const INVALID_CODE_MESSAGE = "Enter a 6–12 character join code.";

/**
 * Shown for every unsuccessful resolution — a not-found result or a transport
 * failure (R4.5). The message is uniform so it never distinguishes a malformed
 * code, an unmatched code, or an ended-game code from one another.
 */
const NOT_RECOGNIZED_MESSAGE =
  "We couldn't find a game for that code. Double-check it and try again.";

/** Shared inline style for the full-width, ≥44px-tall code input (R7.3). */
const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: TOUCH_TARGET,
  padding: "0.6rem 0.75rem",
  fontSize: "1rem",
  borderRadius: "0.5rem",
  border: "1px solid #888",
  textTransform: "uppercase",
};

export default function JoinEntry(): React.JSX.Element {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      // Guard against re-entry while a request is already in flight (R4.6).
      if (submitting) {
        return;
      }

      const raw = code;
      // R4.2: reject bad shape client-side and issue NO resolution request.
      if (!isValidSubmittedCode(raw)) {
        setError(INVALID_CODE_MESSAGE);
        return;
      }

      // R4.3: send the normalized (trimmed + uppercased) code to the service.
      const normalized = normalizeSubmittedCode(raw);
      setError(null);
      setSubmitting(true);
      try {
        const res = await fetch("/api/games/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ joinCode: normalized }),
        });
        if (res.ok) {
          // R4.4: route to the resolved lobby, carrying the code so the lobby
          // can prefill the join form before its snapshot loads.
          const { gameId } = (await res.json()) as { gameId: string };
          router.push(
            `/games/${gameId}/lobby?code=${encodeURIComponent(normalized)}`,
          );
        } else {
          // R4.5: a not-found result (404) shows the uniform message.
          setError(NOT_RECOGNIZED_MESSAGE);
        }
      } catch {
        // A network/transport failure is treated as the same uniform miss.
        setError(NOT_RECOGNIZED_MESSAGE);
      } finally {
        // R4.6: always re-enable the submit control.
        setSubmitting(false);
      }
    },
    [code, submitting, router],
  );

  return (
    <section
      aria-labelledby="join-entry-heading"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        width: "100%",
        maxWidth: "100%",
      }}
    >
      <h2 id="join-entry-heading" style={{ margin: 0, fontSize: "1.15rem" }}>
        Join a game
      </h2>
      <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.4 }}>
        Enter the join code your host shared to reach your game&rsquo;s lobby.
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
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. K7QP2M"
            autoComplete="off"
            autoCapitalize="characters"
            inputMode="text"
            disabled={submitting}
            style={inputStyle}
          />
        </label>

        {error !== null ? (
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
            // R7.3: a ≥ 44×44 CSS px touch target.
            width: "100%",
            maxWidth: "100%",
            minWidth: TOUCH_TARGET,
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
          {submitting ? "Finding your game…" : "Join game"}
        </button>
      </form>
    </section>
  );
}
