/**
 * Landing_Page (design §Components 4; Task 8; Requirements 2.1, 2.2, 2.3, 2.4).
 *
 * Replaces the foundation "baseline is running" splash (R2.4) with the branded
 * mobile-first home page. It is a static server component with no data
 * dependency, so requesting `/` renders synchronously and responds HTTP 200
 * (R2.3). It presents the BBB branding (logo, tagline, brand colors — R2.2) and
 * the two entry points, Host_Entry and Join_Entry (R2.1), reused verbatim from
 * `components/shell`.
 *
 * The persistent Header_Nav (mounted once by the App_Shell in the root layout)
 * already shows the logo on every route; this landing hero reinforces the brand
 * identity for a first-time visitor and frames the two choices.
 *
 * Layout is a single mobile-first column: no fixed widths, `maxWidth: 100%`, and
 * a centered content column that scales down to a 320–430px viewport without
 * horizontal scroll. The final shell/landing CSS (`box-sizing`, overflow guards,
 * the shared touch-target rules) is owned by Task 10 in `globals.css`; the inline
 * layout here already avoids fixed widths so the page fits narrow viewports on
 * its own. The entry controls carry their own ≥44px touch targets.
 */

import HostEntry from "@/components/shell/HostEntry";
import JoinEntry from "@/components/shell/JoinEntry";

/** The BBB tagline shown in the landing hero (R2.2). */
const TAGLINE = "Race the Beltline. Claim the bars.";

export default function HomePage(): React.JSX.Element {
  return (
    <main
      style={{
        // R7.1 (finalized in Task 10): mobile-first single column, fluid width,
        // no fixed widths so the landing never forces horizontal scrolling on a
        // 320–430px viewport. Centered and capped for comfortable reading on
        // larger screens.
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
        width: "100%",
        maxWidth: "480px",
        margin: "0 auto",
        padding: "1.5rem 1rem 2rem",
        boxSizing: "border-box",
      }}
    >
      {/* R2.2: brand hero — logo, tagline, and brand colors. */}
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "0.75rem",
          textAlign: "center",
          color: "#1a1a1a",
        }}
      >
        <img
          src="/BBB_logo.png"
          alt="Beltline Bar Brawl"
          width={120}
          height={120}
          style={{ height: "auto", maxWidth: "60%" }}
        />
        <h1 style={{ margin: 0, fontSize: "1.6rem", lineHeight: 1.2 }}>
          Beltline Bar Brawl
        </h1>
        <p style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>
          {TAGLINE}
        </p>
      </section>

      {/* R2.1: the two entry points. */}
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          width: "100%",
          maxWidth: "100%",
        }}
      >
        <HostEntry />
      </section>

      <JoinEntry />
    </main>
  );
}
