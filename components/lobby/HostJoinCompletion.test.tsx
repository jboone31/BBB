// @vitest-environment jsdom
//
// Interaction / example tests for the HostJoinCompletion surface
// (Task 3.2; Requirements 3.2, 3.3, 4.3).
//
// HostJoinCompletion is the name-only recovery/entry surface for a not-yet-joined
// Admin. Unlike JoinGame it has NO code input — the host already owns the game and
// the page supplies the Join_Code from its folded view. These example tests pin
// the presentational contract the page relies on:
//
//   R4.3 — the surface collects ONLY a Display_Name (no code input): the one and
//          only textbox is the display name.
//   R3.2 — an invalid (empty) name blocks submission: inline feedback appears and
//          onComplete is never called.
//   R3.3 — a valid submit calls onComplete with the TRIMMED display name so the
//          value handed to the join matches what the Join_Service re-validates.
//   (in-flight) — while a submission is in flight the submit control is disabled.
//
// APPROACH — render the real component, drive it via Testing Library, and spy on
// the single impure edge (`onComplete`). No router/fetch/clipboard needed: this
// component delegates the actual join POST to the page. `@vitest-environment
// jsdom` opts this file into a DOM (the project default is `node`).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import HostJoinCompletion from "./HostJoinCompletion";

/** Grab the display-name input and submit button from the rendered surface. */
function controls() {
  const input = screen.getByRole("textbox", {
    name: /display name/i,
  }) as HTMLInputElement;
  const submit = screen.getByRole("button", {
    name: /join game|joining/i,
  }) as HTMLButtonElement;
  return { input, submit };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("HostJoinCompletion collects only a display name (R4.3)", () => {
  it("renders exactly one textbox and it is the display-name field", () => {
    render(<HostJoinCompletion onComplete={vi.fn()} />);

    // There is no code input: the sole textbox on the surface is the name field.
    const textboxes = screen.getAllByRole("textbox");
    expect(textboxes).toHaveLength(1);

    const { input } = controls();
    expect(textboxes[0]).toBe(input);
    expect(input.name).toBe("displayName");
  });
});

describe("HostJoinCompletion blocks an invalid (empty) name (R3.2)", () => {
  it("shows inline feedback and does not call onComplete on an empty name", () => {
    const onComplete = vi.fn();
    render(<HostJoinCompletion onComplete={onComplete} />);

    const { submit } = controls();
    // No feedback before an attempt.
    expect(screen.queryByRole("alert")).toBeNull();

    // Submit with the field left empty (all-whitespace also fails).
    fireEvent.click(submit);

    // An inline validation message identifies the invalid name…
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/display name/i);
    // …and no join is attempted.
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not call onComplete when the name is only whitespace", () => {
    const onComplete = vi.fn();
    render(<HostJoinCompletion onComplete={onComplete} />);

    const { input, submit } = controls();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(submit);

    expect(screen.getByRole("alert")).not.toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("HostJoinCompletion submits the trimmed name (R3.3)", () => {
  it("calls onComplete with the trimmed display name on a valid submit", () => {
    const onComplete = vi.fn();
    render(<HostJoinCompletion onComplete={onComplete} />);

    const { input, submit } = controls();
    // Surrounding whitespace must be trimmed to match validateDisplayName.value.
    fireEvent.change(input, { target: { value: "  Alex  " } });
    fireEvent.click(submit);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("Alex");
    // A valid submit shows no validation error.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("HostJoinCompletion disables submit while submitting", () => {
  it("disables the submit control when submitting is true", () => {
    const onComplete = vi.fn();
    render(<HostJoinCompletion onComplete={onComplete} submitting={true} />);

    const { input, submit } = controls();
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toMatch(/joining/i);

    // A click while submitting issues no join.
    fireEvent.change(input, { target: { value: "Alex" } });
    fireEvent.click(submit);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
