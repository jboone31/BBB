// @vitest-environment jsdom
//
// Property test for the Create_Game_Surface create-gate (Task 2.2).
//
// Feature: lobby-host-player-and-sharing, Property 1: Create-gate validation
// parity.
//
// Requirements 1.2, 1.3, 1.4, 1.5, 6.1 — the Create_Game_Surface issues a
// create submission IF AND ONLY IF the Start_Bar is non-empty after trim, the
// Finish_Bar is non-empty after trim and differs (case-insensitively) from the
// Start_Bar, AND `validateDisplayName(displayName).ok` holds; and whenever it
// submits, the emitted `displayName` equals the trimmed value
// `validateDisplayName(displayName).value` and the bar names are trimmed.
//
// APPROACH — component + oracle, exercising the real submit path:
//   `CreateGame` is a purely presentational client component: it owns its own
//   input state and an `attempted`-gated `validationError` memo, and calls the
//   `onCreate` callback only when that memo is null on submit. So we render it
//   with an `onCreate` spy, type each generated triple into the Start bar /
//   Finish bar / Display name inputs, submit the form, and compare the spy's
//   invocation against a pure oracle that reuses the SAME `validateDisplayName`
//   the component (and the server join route) enforces — guaranteeing client
//   feedback never diverges from the shared validator (R6.1).
//
//   The generator biases toward the whitespace/length boundaries this property
//   is about (empty, all-whitespace, 1 char, 40 chars, 41 chars, and
//   start==finish collisions) so runs land on the accept/reject edges rather
//   than wasting iterations deep inside the accept or reject regions.
//
//   Mocks are reset and the tree unmounted between iterations so each run
//   starts from a clean slate. `@vitest-environment jsdom` opts THIS FILE into a
//   DOM (the project default is `node`, see vitest.config.mts), matching the
//   other component tests.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { validateDisplayName } from "@/lib/lobby/displayName";

import CreateGame, { type CreateSubmission } from "./CreateGame";

const onCreate = vi.fn<(submission: CreateSubmission) => void>();

afterEach(() => {
  cleanup();
  onCreate.mockReset();
});

/**
 * The pure oracle for the create-gate: mirrors the component's `validationError`
 * memo (start non-empty, finish non-empty and differs case-insensitively from
 * start, name valid) using the shared `validateDisplayName`. Returns whether a
 * submission should fire.
 */
function shouldSubmit(
  startBarName: string,
  finishBarName: string,
  displayName: string,
): boolean {
  const trimmedStart = startBarName.trim();
  const trimmedFinish = finishBarName.trim();
  if (trimmedStart.length === 0) return false;
  if (trimmedFinish.length === 0) return false;
  if (trimmedStart.toLowerCase() === trimmedFinish.toLowerCase()) return false;
  return validateDisplayName(displayName).ok;
}

/**
 * A field arbitrary biased toward the whitespace/length boundaries that decide
 * the create-gate: empty, whitespace-only, single-char, exactly-40, over-40,
 * and arbitrary text. Padding some values with surrounding whitespace exercises
 * the trim-before-validate rules for both bar names and the display name.
 */
const fieldArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc.constant("   "),
  fc.constant("a"),
  fc.constant("A"),
  fc.string({ minLength: 40, maxLength: 40 }),
  fc.string({ minLength: 41, maxLength: 45 }),
  fc.string({ maxLength: 20 }),
  // Whitespace-padded variants to hit the trim boundaries.
  fc.string({ maxLength: 10 }).map((s) => `  ${s}  `),
);

describe("Feature: lobby-host-player-and-sharing, Property 1: Create-gate validation parity", () => {
  it("submits iff all three client rules pass, emitting trimmed values", () => {
    fc.assert(
      fc.property(
        fieldArb,
        fieldArb,
        fieldArb,
        (startBarName, finishBarName, displayName) => {
          onCreate.mockReset();
          const { unmount } = render(<CreateGame onCreate={onCreate} />);

          const startInput = screen.getByRole("textbox", {
            name: /start bar/i,
          }) as HTMLInputElement;
          const finishInput = screen.getByRole("textbox", {
            name: /finish bar/i,
          }) as HTMLInputElement;
          const nameInput = screen.getByRole("textbox", {
            name: /display name/i,
          }) as HTMLInputElement;
          const form = startInput.closest("form") as HTMLFormElement;

          fireEvent.change(startInput, { target: { value: startBarName } });
          fireEvent.change(finishInput, { target: { value: finishBarName } });
          fireEvent.change(nameInput, { target: { value: displayName } });
          fireEvent.submit(form);

          const expected = shouldSubmit(
            startBarName,
            finishBarName,
            displayName,
          );

          if (expected) {
            // R1.2/R1.4/R6.1: a valid triple fires exactly one submission.
            expect(onCreate).toHaveBeenCalledTimes(1);
            const submission = onCreate.mock.calls[0]?.[0] as CreateSubmission;

            const nameResult = validateDisplayName(displayName);
            // R1.5/R6.1: the emitted name is the shared validator's trimmed value.
            expect(nameResult.ok).toBe(true);
            if (nameResult.ok) {
              expect(submission.displayName).toBe(nameResult.value);
            }
            // Bar names are trimmed on emit.
            expect(submission.startBarName).toBe(startBarName.trim());
            expect(submission.finishBarName).toBe(finishBarName.trim());
          } else {
            // R1.3/R1.4: any failing rule blocks the create request entirely.
            expect(onCreate).not.toHaveBeenCalled();
          }

          unmount();
        },
      ),
      { numRuns: 100 },
    );
  });
});
