import { describe, expect, it } from "vitest";

import {
  isValidGeneratedCode,
  isValidSubmittedCode,
  normalizeSubmittedCode,
} from "./joinCode";

/**
 * Unit tests for Join_Code edge cases (Task 2.4).
 *
 * Covers the concrete boundaries of submitted-code acceptance and normalization
 * that complement the universal Properties 2 and 3.
 *
 * Requirements: 1.4, 3.3
 */
describe("isValidSubmittedCode — edge cases (R3.3)", () => {
  it("rejects the empty string", () => {
    expect(isValidSubmittedCode("")).toBe(false);
  });

  it("rejects an all-whitespace string (normalizes to empty)", () => {
    expect(isValidSubmittedCode("     ")).toBe(false);
    expect(isValidSubmittedCode("\t\n  ")).toBe(false);
  });

  it("rejects codes shorter than 6 after normalization", () => {
    expect(isValidSubmittedCode("ABC12")).toBe(false); // 5 chars
    expect(isValidSubmittedCode("  ABCD1  ")).toBe(false); // 5 after trim
  });

  it("accepts codes exactly at the 6-character lower bound", () => {
    expect(isValidSubmittedCode("ABC123")).toBe(true);
  });

  it("accepts codes exactly at the 12-character upper bound", () => {
    expect(isValidSubmittedCode("ABCDEF123456")).toBe(true);
  });

  it("rejects codes longer than 12 after normalization", () => {
    expect(isValidSubmittedCode("ABCDEF1234567")).toBe(false); // 13 chars
  });

  it("rejects codes containing non-alphanumeric characters", () => {
    expect(isValidSubmittedCode("ABC-123")).toBe(false);
    expect(isValidSubmittedCode("ABC_123")).toBe(false);
    expect(isValidSubmittedCode("ABC 123")).toBe(false); // interior space
    expect(isValidSubmittedCode("ABC!23")).toBe(false);
  });

  it("accepts a whitespace-padded but otherwise valid submission", () => {
    expect(isValidSubmittedCode("  ABC123  ")).toBe(true);
    expect(isValidSubmittedCode("\tABC123\n")).toBe(true);
  });

  it("accepts lowercase submissions (normalized to uppercase)", () => {
    expect(isValidSubmittedCode("abc123")).toBe(true);
    expect(isValidSubmittedCode("MixedCase12")).toBe(true);
  });
});

describe("normalizeSubmittedCode — round-trips (R3.3)", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeSubmittedCode("  ABC123  ")).toBe("ABC123");
    expect(normalizeSubmittedCode("\tABC123\n")).toBe("ABC123");
  });

  it("uppercases the code", () => {
    expect(normalizeSubmittedCode("abc123")).toBe("ABC123");
    expect(normalizeSubmittedCode("MixedCase")).toBe("MIXEDCASE");
  });

  it("is idempotent (normalizing an already-normalized code is a no-op)", () => {
    const once = normalizeSubmittedCode("  abc123  ");
    expect(normalizeSubmittedCode(once)).toBe(once);
  });

  it("leaves an already-normalized code unchanged", () => {
    expect(normalizeSubmittedCode("ABC123")).toBe("ABC123");
  });
});

describe("isValidGeneratedCode — edge cases (R1.4)", () => {
  it("accepts 6-, 7-, and 8-character alphanumeric codes", () => {
    expect(isValidGeneratedCode("ABC123")).toBe(true); // 6
    expect(isValidGeneratedCode("ABC1234")).toBe(true); // 7
    expect(isValidGeneratedCode("ABC12345")).toBe(true); // 8
  });

  it("rejects codes shorter than 6 or longer than 8", () => {
    expect(isValidGeneratedCode("ABC12")).toBe(false); // 5
    expect(isValidGeneratedCode("ABC123456")).toBe(false); // 9
  });

  it("rejects the empty string and non-alphanumeric characters", () => {
    expect(isValidGeneratedCode("")).toBe(false);
    expect(isValidGeneratedCode("ABC-12")).toBe(false);
    expect(isValidGeneratedCode("ABC 12")).toBe(false);
  });
});
