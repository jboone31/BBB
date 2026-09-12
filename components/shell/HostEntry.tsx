/**
 * Host_Entry control (design §Components 5; Task 6; Requirements 3.1, 3.2, 7.3).
 *
 * The Landing_Page control that sends a prospective Admin to the existing
 * create-game surface at `/games/new/lobby`. This is the simplest correct
 * implementation: a styled Next.js `<Link>` presented as a button. It needs no
 * client state or handlers, so it stays a plain (server-renderable) component —
 * `<Link>` handles the client-side navigation on its own.
 *
 * Requirement mapping:
 *  - R3.1: labeled to indicate hosting a game ("Host a game").
 *  - R3.2: navigates to the create-game surface at `/games/new/lobby`.
 *  - R7.3: presents a touch target of at least 44×44 CSS pixels.
 *
 * Styling mirrors the lobby components' primary-button convention (dark brand
 * fill, white text, rounded, full-width, ≥44px tall) so the entry point reads
 * as the same family of controls across the app.
 */

import Link from "next/link";

/** Minimum touch-target size for interactive controls (R7.3). */
const TOUCH_TARGET = "44px";

export default function HostEntry(): React.JSX.Element {
  return (
    <Link
      href="/games/new/lobby"
      role="button"
      style={{
        // R7.3: a ≥ 44×44 CSS px touch target. minWidth/minHeight guarantee the
        // floor even before padding; the flex centering keeps the label centered.
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        maxWidth: "100%",
        minWidth: TOUCH_TARGET,
        minHeight: TOUCH_TARGET,
        padding: "0.7rem 1rem",
        fontSize: "1rem",
        fontWeight: 600,
        // Brand styling consistent with the lobby primary buttons.
        borderRadius: "0.5rem",
        border: "1px solid #444",
        background: "#1a1a1a",
        color: "#ffffff",
        textDecoration: "none",
        cursor: "pointer",
      }}
    >
      Host a game
    </Link>
  );
}
