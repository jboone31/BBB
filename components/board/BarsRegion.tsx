"use client";

/**
 * Bars region surface for the Game_Board (design §Components 4; Task 8.2;
 * Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 9.3).
 *
 * This presentational component renders the Bars_Region wireframe: a placeholder
 * surface for viewing bars (R3.1), a placeholder claim control whose label names
 * claiming a bar as its intended action (R3.2), and a label stating that bar
 * selection, discovery, and claiming are provided by a later feature (R3.3).
 *
 * The claim control is *inert*. Activating it flips a small piece of local
 * component state to reveal a wireframe acknowledgement identifying the action as
 * a placeholder (R3.4). It NEVER performs a `fetch`/POST, never appends a
 * Game_Event, never records a claim or alters a score, and leaves every Region
 * unchanged (R3.5) — the acknowledgement is purely local and enforces nothing.
 *
 * When the current Session is the Admin and is not a Player of the Game
 * (`adminNotPlayer`), the Region shows an indication that claiming belongs to
 * Players instead of an operable claim control (R3.6).
 *
 * Mobile-first constraint (R9.3): the claim control is at least 44×44 CSS pixels
 * (`--touch-target`). The surface is a full-width single column with inherited
 * `box-sizing: border-box`, so it fits a 320–430px viewport with no horizontal
 * overflow.
 */

import { useState } from "react";

/** Minimum touch-target size for interactive controls (R9.3). */
const TOUCH_TARGET = "44px";

export interface BarsRegionProps {
  /**
   * True when the current Session is the Admin and is *not* a Player of the
   * Game. In that case the Region shows a "claiming belongs to Players"
   * indication instead of an operable claim control (R3.6).
   */
  readonly adminNotPlayer: boolean;
}

export default function BarsRegion({
  adminNotPlayer,
}: BarsRegionProps): React.JSX.Element {
  // Local-only acknowledgement state. Activating the claim control toggles this
  // on; it drives nothing beyond showing an inert wireframe message (R3.4/R3.5).
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <section
      aria-label="Bars"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        width: "100%",
        maxWidth: "100%",
      }}
    >
      {/* Placeholder surface for viewing bars (R3.1). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "8rem",
          padding: "1rem",
          textAlign: "center",
          color: "#555",
          border: "1px dashed #888",
          borderRadius: "0.5rem",
          background: "#f5f5f5",
        }}
      >
        Bars view surface
      </div>

      {/* Label naming later-feature scope (R3.3). */}
      <p style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}>
        Bar selection, discovery, and claiming are provided by a later feature.
      </p>

      {adminNotPlayer ? (
        // Admin-and-not-a-Player: no operable claim control (R3.6).
        <p
          role="note"
          style={{
            margin: 0,
            padding: "0.6rem 0.75rem",
            fontSize: "0.95rem",
            color: "#1a1a1a",
            border: "1px solid #888",
            borderRadius: "0.5rem",
            background: "#ffffff",
          }}
        >
          Claiming belongs to Players.
        </p>
      ) : (
        <>
          {/* Placeholder claim control whose label names claiming a bar (R3.2). */}
          <button
            type="button"
            onClick={() => setAcknowledged(true)}
            style={{
              minWidth: TOUCH_TARGET,
              minHeight: TOUCH_TARGET,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0.6rem 1rem",
              fontSize: "1rem",
              fontWeight: 600,
              textAlign: "center",
              borderRadius: "0.5rem",
              border: "1px solid #1a1a1a",
              background: "#1a1a1a",
              color: "#ffffff",
              cursor: "pointer",
            }}
          >
            Claim this bar
          </button>

          {/* Inert wireframe acknowledgement shown on activation (R3.4). It
              records nothing and changes nothing (R3.5). */}
          {acknowledged ? (
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
              Placeholder: claiming a bar is a wireframe action and does nothing
              yet.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
