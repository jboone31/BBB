// Baseline-URL "responds" smoke test for the Deployable_Baseline home page
// (Task 19.4).
//
// Requirement 2.10: WHEN the deployed baseline is reached at its public URL, it
// SHALL return a running, non-error response and render a clear "running"
// indicator.
//
// TWO APPROACHES:
//
//   (a) ALWAYS-RUN, env-free check (the primary assertion here):
//       `app/page.tsx` is a synchronous server component with no data
//       dependencies, so on the server it renders to HTTP 200 with static
//       markup. We reproduce exactly that server render path by rendering the
//       component to a string with `react-dom/server`'s renderToStaticMarkup and
//       assert:
//         - rendering does not throw (a throw is what would turn into a 5xx
//           server-error response), and
//         - the produced markup contains the running indicator (/running/i)
//           inside a role="status" region, and
//         - the markup shows no error surface.
//       This runs in the default `node` environment (renderToStaticMarkup needs
//       no DOM), is fast, and requires no deployed URL.
//
//   (b) OPTIONAL live check, gated behind BASELINE_URL:
//       When BASELINE_URL is set, fetch it and assert an HTTP 2xx (non-error)
//       response whose body carries the running indicator. Skipped entirely when
//       BASELINE_URL is unset so the default test run stays hermetic.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("Deployable_Baseline responds (Requirement 2.10)", () => {
  describe("(a) server-render smoke check (always runs, env-free)", () => {
    it("renders to static markup without throwing", () => {
      // A throw during render is what would produce a 5xx server error at the
      // baseline URL; not throwing is the render-path proxy for a non-error
      // response.
      expect(() => renderToStaticMarkup(<HomePage />)).not.toThrow();
    });

    it("produces markup containing a running indicator", () => {
      const markup = renderToStaticMarkup(<HomePage />);

      // The clear "running" indicator required by Requirement 2.10.
      expect(markup).toMatch(/running/i);
      // The indicator is exposed as a status region (role="status").
      expect(markup).toMatch(/role="status"/);
    });

    it("shows no error surface in the rendered markup", () => {
      const markup = renderToStaticMarkup(<HomePage />);

      // A non-error response should not render error language. Guard against the
      // common error surfaces without being so broad that legitimate copy trips
      // it.
      expect(markup).not.toMatch(/\berror\b/i);
      expect(markup).not.toMatch(/something went wrong/i);
      // Non-empty body — an empty render would not be a meaningful response.
      expect(markup.trim().length).toBeGreaterThan(0);
    });
  });

  describe("(b) live baseline URL check (gated by BASELINE_URL)", () => {
    const baselineUrl = process.env.BASELINE_URL;

    it.runIf(Boolean(baselineUrl))(
      "returns a non-error HTTP response with a running indicator",
      async () => {
        // Guaranteed defined by runIf, but narrow for the type checker.
        const url = baselineUrl as string;

        const response = await fetch(url);

        // A "running, non-error response" is a 2xx status.
        expect(response.ok).toBe(true);
        expect(response.status).toBeGreaterThanOrEqual(200);
        expect(response.status).toBeLessThan(300);

        const body = await response.text();
        expect(body).toMatch(/running/i);
      },
    );
  });
});
