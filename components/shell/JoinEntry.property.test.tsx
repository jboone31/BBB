// @vitest-environment jsdom
//
// Property test for the Join_Entry malformed-code short-circuit (Task 7.2).
//
// Feature: app-shell-navigation, Property 4: Malformed codes never trigger a
// resolution request.
//
// Requirement 4.2 — WHEN a user submits a Join_Code whose normalized value is
// not 6–12 alphanumeric characters, THE Join_Entry SHALL display an
// invalid-code message and SHALL NOT issue a resolution request.
//
// APPROACH — component + mocked boundaries, exercising the real submit path:
//   `JoinEntry` is a client component that calls `next/navigation`'s useRouter
//   (which throws outside a router context) and the global `fetch` (the
//   Resolution_Service). We mock both: useRouter via `vi.mock` so the component
//   renders in jsdom, and `fetch` via a `vi.fn` so we can assert it is NEVER
//   called on a malformed submission.
//
//   For each generated raw input whose normalized value fails
//   `isValidSubmittedCode`, we type it into the code input, submit the form, and
//   assert (a) the invalid-code alert is shown and (b) `fetch` was never called.
//   We reset the fetch mock and unmount the tree between iterations so each run
//   starts from a clean slate. The generator filters arbitrary strings down to
//   exactly the malformed space this property is about, so we never waste runs
//   on well-formed codes (which would take the network path).
//
//   `@vitest-environment jsdom` opts THIS FILE into a DOM (the project default
//   is `node`, see vitest.config.mts), matching the other component tests.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

// next/navigation's useRouter throws outside a router context, so mock it. The
// component only calls `router.push` on a *successful* resolution, which the
// malformed-code path never reaches — but the hook is invoked on every render.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import {
  isValidSubmittedCode,
  normalizeSubmittedCode,
} from "@/lib/lobby/joinCode";

import JoinEntry from "./JoinEntry";

// The mocked Resolution_Service transport. Property 4 asserts this is never
// reached for a malformed code, so any invocation is a failure.
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  // A malformed submission must short-circuit before touching fetch; if the
  // component ever did call it, this resolved value keeps the test from hanging
  // while still recording the (failing) invocation.
  fetchMock.mockResolvedValue({
    ok: false,
    status: 404,
    json: async () => ({ resolved: false }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Raw inputs whose *normalized* value is not 6–12 alphanumeric — the exact
 * malformed space Property 4 covers. We start from arbitrary unicode strings
 * (so casing, whitespace, symbols, and out-of-range lengths are all in play)
 * and keep only those the shared validator rejects, reusing the same
 * `isValidSubmittedCode` the component and server enforce.
 */
const malformedRawArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 20 })
  .filter((raw) => !isValidSubmittedCode(raw));

describe("Feature: app-shell-navigation, Property 4: Malformed codes never trigger a resolution request", () => {
  it("shows an invalid-code message and never calls fetch for any malformed code", () => {
    fc.assert(
      fc.property(malformedRawArb, (raw) => {
        // Sanity: the generator only yields codes the shared validator rejects.
        expect(isValidSubmittedCode(raw)).toBe(false);
        expect(/^[A-Za-z0-9]{6,12}$/.test(normalizeSubmittedCode(raw))).toBe(
          false,
        );

        fetchMock.mockClear();
        const { unmount } = render(<JoinEntry />);

        const input = screen.getByRole("textbox") as HTMLInputElement;
        const form = input.closest("form") as HTMLFormElement;

        // Type the raw (malformed) code and submit the form.
        fireEvent.change(input, { target: { value: raw } });
        fireEvent.submit(form);

        // R4.2a: an invalid-code message is shown to the Player.
        const alert = screen.getByRole("alert");
        expect(alert.textContent ?? "").toMatch(/join code/i);

        // R4.2b: no resolution request was issued.
        expect(fetchMock).not.toHaveBeenCalled();

        unmount();
      }),
      { numRuns: 100 },
    );
  });
});
