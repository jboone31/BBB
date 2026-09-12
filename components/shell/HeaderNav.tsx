/**
 * Header_Nav (design §Components 3; Task 2.1; Requirements 1.2, 1.3, 1.4, 1.6).
 *
 * The small persistent header the App_Shell renders above every page's content
 * (mounted once in the root layout). It is a plain server component — no client
 * state or handlers — with the whole brand row wrapped in a Next.js `<Link>` so
 * activating it navigates home. `<Link>` handles the client-side navigation on
 * its own, so no `"use client"` is needed.
 *
 * Requirement mapping:
 *  - R1.2: renders the BBB logo from the served asset path `/BBB_logo.png`
 *          (the project logo relocated into `public/` so Next.js serves it).
 *  - R1.3: renders the BBB tagline text.
 *  - R1.4: the brand row is wrapped in `<Link href="/">`, so activating it
 *          navigates to the Landing_Page at `/`.
 *  - R1.6: applies the BBB brand colors to the header background and text.
 *
 * Brand styling mirrors HostEntry / the lobby primary-button convention (dark
 * brand fill `#1a1a1a`, white text) so the shell reads as the same family of
 * surfaces across the app. The logo carries explicit `width`/`height` so the
 * browser reserves space and the header does not shift as the image loads
 * (avoids cumulative layout shift). Mobile-first fit at 320–430px (R7.2) is
 * finalized with the shell CSS in Task 10; the inline layout here already uses a
 * flex row with `maxWidth: 100%` and a wrapping/ellipsized tagline so it does
 * not force horizontal scroll on its own.
 */

import Link from "next/link";

/**
 * Intrinsic logo dimensions used to reserve layout space (avoids layout shift).
 * The rendered size is capped by CSS (`max-width: 100%`, `height: auto`) so the
 * logo scales down on narrow viewports without distorting.
 */
const LOGO_WIDTH = 40;
const LOGO_HEIGHT = 40;

/** The BBB tagline shown beside the logo (R1.3). */
const TAGLINE = "Race the Beltline. Claim the bars.";

export default function HeaderNav(): React.JSX.Element {
  return (
    <header
      style={{
        // R1.6: BBB brand colors on background and text.
        background: "#1a1a1a",
        color: "#ffffff",
        // R7.2 (finalized in Task 10): fluid, full-width, no fixed widths so the
        // header never forces horizontal scrolling on a 320–430px viewport.
        width: "100%",
        maxWidth: "100%",
        padding: "0.6rem 1rem",
      }}
    >
      <Link
        href="/"
        aria-label="Beltline Bar Brawl home"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.6rem",
          // Inherit the header's brand text color; strip the default underline.
          color: "inherit",
          textDecoration: "none",
          maxWidth: "100%",
        }}
      >
        <img
          src="/BBB_logo.png"
          alt="Beltline Bar Brawl"
          width={LOGO_WIDTH}
          height={LOGO_HEIGHT}
          style={{
            // Cap the rendered size on narrow screens while preserving aspect
            // ratio; the width/height attrs above still reserve the space.
            flex: "0 0 auto",
            height: "auto",
            maxWidth: "100%",
          }}
        />
        <span
          style={{
            // Let the tagline shrink/wrap rather than push the header wide.
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontWeight: 600,
          }}
        >
          {TAGLINE}
        </span>
      </Link>
    </header>
  );
}
