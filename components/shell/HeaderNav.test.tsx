// @vitest-environment jsdom
//
// Component render test for the persistent branded Header_Nav (Task 2.2).
//
// The Header_Nav is a plain server component the App_Shell mounts once above
// every page's content. It has no client state or handlers, so a static render
// is enough to assert its brand row: the logo, the tagline, and the home link.
//
//   Requirement 1.2 — THE Header_Nav SHALL display the BBB logo sourced from the
//     project logo asset. We assert the logo image carries the "Beltline Bar
//     Brawl" alt text (the served copy at `/BBB_logo.png`).
//   Requirement 1.3 — THE Header_Nav SHALL display the BBB tagline text.
//   Requirement 1.4 — WHEN a user activates the Header_Nav brand link, THE
//     App_Shell SHALL navigate to the Landing_Page at `/`. We assert the brand
//     link resolves to `/`.
//
// APPROACH — component render, no page/mocks:
//   `HeaderNav` wraps its brand row in a Next.js `<Link href="/">`, which renders
//   to a plain `<a href="/">` in the DOM, so it renders directly under jsdom with
//   no router mock. `@vitest-environment jsdom` opts THIS FILE into a DOM (the
//   project default is `node`, see vitest.config.mts), matching the other
//   component tests (e.g. components/lobby/LobbyRoster.test.tsx). Plain DOM
//   assertions (no jest-dom matchers) keep the dependency surface minimal.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import HeaderNav from "./HeaderNav";

afterEach(() => {
  cleanup();
});

describe("HeaderNav renders the brand row (Requirements 1.2, 1.3, 1.4)", () => {
  it("displays the BBB logo via its alt text (R1.2)", () => {
    render(<HeaderNav />);

    // The logo is exposed to assistive tech (and tests) by its alt text; the
    // served asset lives at `/BBB_logo.png`.
    const logo = screen.getByAltText("Beltline Bar Brawl");
    expect(logo).not.toBeNull();
    expect(logo.getAttribute("src")).toBe("/BBB_logo.png");
  });

  it("displays the BBB tagline text (R1.3)", () => {
    render(<HeaderNav />);

    expect(
      screen.getByText("Race the Beltline. Claim the bars."),
    ).not.toBeNull();
  });

  it("wraps the brand row in a link that resolves to the landing page (R1.4)", () => {
    render(<HeaderNav />);

    // The whole brand row is wrapped in <Link href="/">, which renders as an
    // <a href="/">. Locate it by its accessible name (the aria-label).
    const brandLink = screen.getByRole("link", {
      name: /beltline bar brawl home/i,
    });
    expect(brandLink.getAttribute("href")).toBe("/");

    // The logo and tagline live inside that same home link.
    expect(screen.getByAltText("Beltline Bar Brawl").closest("a")).toBe(
      brandLink,
    );
    expect(
      screen.getByText("Race the Beltline. Claim the bars.").closest("a"),
    ).toBe(brandLink);
  });
});
