import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  formatClockTime,
  formatDuration,
  parseDuration,
  remainingMs,
} from "./templates";
import { measureOffset } from "./clockOffset";

/**
 * Feature: card-behavior, Property 3: Duration and time formatting.
 *
 * Covers the four pure time/duration helpers the timed-effect toasts rely on,
 * plus the single-round-trip clock-offset estimator:
 *
 *   - `formatDuration(s)` renders a non-negative integer number of seconds as
 *     `m:ss` (minutes with no leading zero, seconds always two digits), so the
 *     output always matches `^\d+:\d{2}$`, and it round-trips through
 *     `parseDuration` for every non-negative integer `s`
 *     (`parseDuration(formatDuration(s)) === s`). Negative or fractional inputs
 *     are clamped to a non-negative integer first.
 *   - `parseDuration` returns `null` on anything that is not exactly `m:ss`
 *     with a two-digit seconds field in [0, 59].
 *   - `formatClockTime(iso)` renders any ISO instant as `h:mm AM/PM`, matching
 *     `^\d{1,2}:\d{2} (AM|PM)$`.
 *   - `remainingMs(end, now)` equals `max(0, parse(end) − now)`, clamped at 0.
 *   - `measureOffset(sentAt, receivedAt, serverIso)` assumes the server read its
 *     clock at the round-trip midpoint: when the server stamp is taken exactly
 *     at the midpoint it returns the true offset, and for ANY true server-read
 *     instant inside the round trip `[sentAt, receivedAt]` the estimate's error
 *     `|measured − trueOffset|` is at most half the round-trip duration.
 *
 * Everything here is hermetic: `formatClockTime` is pinned to an explicit time
 * zone so the `h:mm AM/PM` assertions never depend on the machine's zone, and
 * no clock is read (all instants are generated).
 *
 * Validates: Requirements 3.6, 20.7, 20.9
 */

describe("Duration and time formatting (Property 3)", () => {
  // -------------------------------------------------------------------------
  // formatDuration / parseDuration
  // -------------------------------------------------------------------------

  it("formatDuration renders m:ss and round-trips through parseDuration for non-negative integer seconds (3.6)", () => {
    fc.assert(
      fc.property(fc.nat({ max: 7200 }), (seconds) => {
        const formatted = formatDuration(seconds);
        // m:ss — minutes with no leading zero, seconds always two digits.
        expect(formatted).toMatch(/^\d+:\d{2}$/);
        // The seconds field is always in [0, 59].
        const secondsField = formatted.split(":")[1];
        expect(Number.parseInt(secondsField, 10)).toBeLessThan(60);
        // Round trip is lossless for every non-negative integer.
        expect(parseDuration(formatted)).toBe(seconds);
      }),
      { numRuns: 500 },
    );
  });

  it("formatDuration clamps negative and fractional inputs to a non-negative integer (3.6)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -10000, max: 10000, noNaN: true }),
        (value) => {
          const expected = Math.max(0, Math.floor(value));
          const formatted = formatDuration(value);
          expect(formatted).toMatch(/^\d+:\d{2}$/);
          // Clamped output equals formatting the clamped integer directly.
          expect(formatted).toBe(formatDuration(expected));
          expect(parseDuration(formatted)).toBe(expected);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("parseDuration returns null on malformed input (3.6)", () => {
    // A grab bag of shapes that are NOT exactly `m:ss` with two-digit seconds
    // in [0, 59]: missing colon, signs, whitespace, three-digit or
    // out-of-range seconds, single-digit seconds, empty, non-numeric.
    const malformed = [
      "",
      "90",
      "1:5",
      "1:60",
      "1:99",
      "1:100",
      "1:005",
      "-1:30",
      "+1:30",
      " 1:30",
      "1:30 ",
      "1: 30",
      "1 :30",
      "1.5:30",
      "a:bb",
      "1:3a",
      "::",
      "1:30:00",
      "1:-5",
    ];
    for (const text of malformed) {
      expect(parseDuration(text)).toBeNull();
    }
  });

  it("parseDuration rejects seconds fields that are not two digits in [0,59] (3.6)", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 999 }),
        fc.integer({ min: 60, max: 99 }),
        (minutes, badSeconds) => {
          // badSeconds is a two-digit value in [60, 99]: well-formed shape but
          // an out-of-range seconds component, so it must parse to null.
          const text = `${minutes}:${badSeconds}`;
          expect(parseDuration(text)).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });

  // -------------------------------------------------------------------------
  // formatClockTime
  // -------------------------------------------------------------------------

  it("formatClockTime renders any ISO instant as h:mm AM/PM (20.7)", () => {
    // Epoch milliseconds across a wide range; converted to ISO and formatted in
    // a fixed zone so the assertion is hermetic.
    fc.assert(
      fc.property(
        fc.integer({ min: -62135596800000, max: 253402300799000 }),
        fc.constantFrom(
          "America/New_York",
          "UTC",
          "Asia/Kolkata",
          "Pacific/Chatham",
        ),
        (epochMs, timeZone) => {
          const iso = new Date(epochMs).toISOString();
          const rendered = formatClockTime(iso, timeZone);
          expect(rendered).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
          // The hour is a 12-hour clock value in [1, 12].
          const hour = Number.parseInt(rendered.split(":")[0], 10);
          expect(hour).toBeGreaterThanOrEqual(1);
          expect(hour).toBeLessThanOrEqual(12);
        },
      ),
      { numRuns: 500 },
    );
  });

  // -------------------------------------------------------------------------
  // remainingMs
  // -------------------------------------------------------------------------

  it("remainingMs equals max(0, end − now) and is clamped at 0 (20.7)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 253402300799000 }),
        fc.integer({ min: 0, max: 253402300799000 }),
        (endMs, nowMs) => {
          const endIso = new Date(endMs).toISOString();
          const expected = Math.max(0, endMs - nowMs);
          const actual = remainingMs(endIso, nowMs);
          expect(actual).toBe(expected);
          expect(actual).toBeGreaterThanOrEqual(0);
          // Any time now is at or past end, the countdown reads exactly zero.
          if (nowMs >= endMs) {
            expect(actual).toBe(0);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  // -------------------------------------------------------------------------
  // measureOffset
  // -------------------------------------------------------------------------

  it("measureOffset returns the true offset when the server stamp is at the round-trip midpoint (20.9)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000_000_000 }),
        // Even round trips so the midpoint lands on a whole millisecond; an odd
        // round trip puts the midpoint on a half-ms that the millisecond-
        // resolution ISO stamp cannot represent, which is a stamp-resolution
        // artifact rather than a property of measureOffset.
        fc.integer({ min: 0, max: 30_000 }).map((half) => half * 2),
        fc.integer({ min: -86_400_000, max: 86_400_000 }),
        (sentAtMs, roundTripMs, trueOffsetMs) => {
          const receivedAtMs = sentAtMs + roundTripMs;
          // The server reads its clock at the midpoint of the round trip.
          const midpointDeviceMs = sentAtMs + roundTripMs / 2;
          const serverStampMs = midpointDeviceMs + trueOffsetMs;
          const serverNowIso = new Date(serverStampMs).toISOString();

          const measured = measureOffset(sentAtMs, receivedAtMs, serverNowIso);
          // The ISO round trip is integer-millisecond exact over this range, so
          // the midpoint-case estimate recovers the true offset exactly.
          expect(measured).toBe(trueOffsetMs);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("measureOffset error is at most half the round trip for any server read inside [sentAt, receivedAt] (20.9)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000_000_000 }),
        fc.integer({ min: 0, max: 60_000 }),
        fc.integer({ min: -86_400_000, max: 86_400_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (sentAtMs, roundTripMs, trueOffsetMs, readFraction) => {
          const receivedAtMs = sentAtMs + roundTripMs;
          // The true server-read instant is somewhere inside the round trip:
          // trueReadDeviceMs = sentAt + readFraction * roundTrip, with
          // readFraction in [0, 1]. Snap to an integer ms so the ISO stamp is
          // exact.
          const trueReadDeviceMs = Math.round(
            sentAtMs + readFraction * roundTripMs,
          );
          const serverStampMs = trueReadDeviceMs + trueOffsetMs;
          const serverNowIso = new Date(serverStampMs).toISOString();

          const measured = measureOffset(sentAtMs, receivedAtMs, serverNowIso);
          const error = Math.abs(measured - trueOffsetMs);
          // The midpoint assumption is off from the true read instant by at
          // most half the round trip, plus at most 1ms of integer-rounding
          // slack from snapping the read instant.
          expect(error).toBeLessThanOrEqual(roundTripMs / 2 + 1);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
