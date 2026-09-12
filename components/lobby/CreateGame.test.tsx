// @vitest-environment jsdom
//
// Example / interaction tests for the Create_Game_Surface's Display_Name field
// (Task 2.3; Requirements 1.1, 1.3, 1.5).
//
// `CreateGame` is a presentational component: it owns its own form input state
// and client-side validation feedback, and delegates the actual create/join
// orchestration to the page via the `onCreate` callback. These tests exercise
// that props-in / callback-out contract directly, without the page:
//
//   R1.1 — the surface presents a Display_Name input alongside Start_Bar and
//          Finish_Bar.
//   R1.3 — submitting with an invalid Display_Name (empty, or empty after
//          trimming) while start/finish are valid blocks submission, issues no
//          create request (`onCreate` is never called), and shows the inline
//          validation message identifying the name as invalid.
//   R1.5 — a fully valid submission calls `onCreate` with the trimmed
//          startBarName, finishBarName, and displayName.
//
// APPROACH — render the real component, drive it via Testing Library, and spy
// on `onCreate`. `@vitest-environment jsdom` opts this file into a DOM (the
// project default is `node`); plain DOM assertions (no jest-dom matchers) keep
// the dependency surface minimal, matching the sibling lobby/shell tests.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CreateGame from "./CreateGame";

/** Grab the three text inputs and the submit button from the rendered form. */
function controls() {
  const start = screen.getByRole("textbox", {
    name: /start bar/i,
  }) as HTMLInputElement;
  const finish = screen.getByRole("textbox", {
    name: /finish bar/i,
  }) as HTMLInputElement;
  const displayName = screen.getByRole("textbox", {
    name: /display name/i,
  }) as HTMLInputElement;
  const submit = screen.getByRole("button", {
    name: /create game|creating/i,
  }) as HTMLButtonElement;
  return { start, finish, displayName, submit };
}

/** Fill the three fields, then click submit. */
function fillAndSubmit(values: {
  start: string;
  finish: string;
  displayName: string;
}) {
  const c = controls();
  fireEvent.change(c.start, { target: { value: values.start } });
  fireEvent.change(c.finish, { target: { value: values.finish } });
  fireEvent.change(c.displayName, { target: { value: values.displayName } });
  fireEvent.click(c.submit);
  return c;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CreateGame renders a Display_Name input (R1.1)", () => {
  it("presents a Display_Name field alongside Start_Bar and Finish_Bar", () => {
    render(<CreateGame onCreate={vi.fn()} />);

    const { start, finish, displayName } = controls();
    // All three inputs are present on the create surface.
    expect(start).not.toBeNull();
    expect(finish).not.toBeNull();
    expect(displayName).not.toBeNull();
    // The Display_Name input is its own distinct control.
    expect(displayName).not.toBe(start);
    expect(displayName).not.toBe(finish);
  });
});

describe("CreateGame blocks submission on an invalid Display_Name (R1.3)", () => {
  it("does not call onCreate and shows the inline message when the name is empty", () => {
    const onCreate = vi.fn();
    render(<CreateGame onCreate={onCreate} />);

    // Start/finish are valid and distinct; the display name is empty.
    fillAndSubmit({
      start: "Ladybird Grove",
      finish: "New Realm Brewing",
      displayName: "",
    });

    // No create request is issued (R1.3).
    expect(onCreate).not.toHaveBeenCalled();

    // The inline validation message identifies the Display_Name as invalid.
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/display name/i);
  });

  it("does not call onCreate when the name is only whitespace (empty after trim)", () => {
    const onCreate = vi.fn();
    render(<CreateGame onCreate={onCreate} />);

    // A whitespace-only name trims to empty, so it is invalid (R1.3).
    fillAndSubmit({
      start: "Ladybird Grove",
      finish: "New Realm Brewing",
      displayName: "     ",
    });

    expect(onCreate).not.toHaveBeenCalled();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/display name/i);
  });
});

describe("CreateGame emits a valid submission with trimmed values (R1.5)", () => {
  it("calls onCreate with the trimmed start, finish, and display name", () => {
    const onCreate = vi.fn();
    render(<CreateGame onCreate={onCreate} />);

    // Surround each field with whitespace to prove the emitted values are
    // trimmed.
    fillAndSubmit({
      start: "  Ladybird Grove  ",
      finish: "  New Realm Brewing  ",
      displayName: "  Captain Ladybird  ",
    });

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({
      startBarName: "Ladybird Grove",
      finishBarName: "New Realm Brewing",
      displayName: "Captain Ladybird",
    });

    // A valid submission shows no inline validation message.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
