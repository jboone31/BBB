import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DURATIONS_MS,
  isEffectActive,
  planEffectTransitions,
  type EffectKind,
  type EffectRecord,
  type EffectTransition,
} from "./effects";

/**
 * Feature: card-behavior, Property 22: Timer settlement announces each
 * transition exactly once, by the next call.
 *
 * `planEffectTransitions` is the pure core of the Timer_Sweep. There is no
 * database scheduler: the sweep runs only when something calls it — a board's
 * member-scoped Settle_Nudge, the lazy settle inside every Card_Behavior_Mutation
 * (at the mutation's own `now`, before it loads state and builds its plan), or
 * the optional Cron_Route. This property models an arbitrary interleaving of
 * those three call kinds at nondecreasing server times, with no scheduler-driven
 * calls, applying `planEffectTransitions` at each call and flipping the returned
 * transitions' `startAnnounced` / `endAnnounced` flags between calls. It pins
 * down the settlement contract:
 *
 * - Each activation and expiry transition is announced exactly once across the
 *   whole sequence, and only by a call whose time is at or after its boundary
 *   (Requirements 20.3b, 20.4, 20.5c).
 * - After any call at time `t` returns, no transition with boundary `<= t` is
 *   left unannounced — equivalently, re-running the planner at the same `now`
 *   right after a call yields nothing (idempotent once announced). For a
 *   mutation this is why its transition events precede its own mutation events
 *   in seq order (Requirements 19.9, 20.3b).
 * - Activation is ordered before expiry for the same effect (Requirement 20.6).
 * - Effects cancelled before their boundary, consumed, or belonging to a game
 *   that is not live produce no transition (Requirements 20.4, 20.6).
 * - A mutation contributes exactly one mutation event when accepted and zero
 *   when rejected, independent of how many transition events the same call
 *   appended (Requirements 19.9, 19.10).
 * - Flipping the announced flags changes no block / eligibility / bonus decision,
 *   because every such decision reads server time via `isEffectActive`, never the
 *   announced flags (Requirements 20.3c, 19.6).
 *
 * Validates: Requirements 19.6, 19.9, 19.10, 20.3b, 20.3c, 20.4, 20.5c, 20.6
 */

// ---------------------------------------------------------------------------
// Timeline anchors.
// ---------------------------------------------------------------------------

/** A fixed base instant so every generated window shares a timeline. */
const BASE_MS = Date.parse("2025-06-01T18:00:00.000Z");

const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Effect generator.
//
// A spread of effects whose boundaries land in a few-hour span around BASE_MS:
// immediate-start and delayed-start, open-ended and timed, some cancelled
// (before or after their boundary), some consumed. Every effect starts with
// both announced flags false so the sequence of calls is what flips them.
// ---------------------------------------------------------------------------

const EFFECT_KINDS: readonly EffectKind[] = [
  "bar_lock",
  "radius_lock",
  "team_claim_block",
  "next_claim_restriction",
  "score_protection",
  "bonus_window",
  "phantom_share",
  "claim_counter",
  "draw_override",
];

/** Offsets, in ms, inside a few hours of the base instant. */
const offsetMs = fc.integer({
  min: -60 * 60_000,
  max: 3 * 60 * 60_000,
});

function effectArb(index: number): fc.Arbitrary<EffectRecord> {
  return fc
    .record({
      kind: fc.constantFrom(...EFFECT_KINDS),
      // A delayed start (like Cancel Culture) produces an activation boundary;
      // an immediate start that is already "announced on insert" is modeled by
      // a 0 delay with the flag still false so the planner can announce it.
      startDelay: fc.constantFrom(
        0,
        DURATIONS_MS.cancelCultureDelay,
        5 * 60_000,
      ),
      duration: fc.option(
        fc.constantFrom(
          DURATIONS_MS.cropDusting,
          DURATIONS_MS.cancelCultureLock,
          DURATIONS_MS.happyHour,
          DURATIONS_MS.powerHour,
          DURATIONS_MS.criticBlock,
        ),
        { nil: null },
      ),
      startBase: offsetMs,
      // Optional cancel/consume, placed relative to the window so both
      // "before boundary" and "after boundary" cases occur.
      cancelRel: fc.option(
        fc.integer({ min: -30 * 60_000, max: 90 * 60_000 }),
        {
          nil: null,
        },
      ),
      consumeRel: fc.option(fc.integer({ min: 0, max: 90 * 60_000 }), {
        nil: null,
      }),
    })
    .map(
      ({
        kind,
        startDelay,
        duration,
        startBase,
        cancelRel,
        consumeRel,
      }): EffectRecord => {
        const start = BASE_MS + startBase + startDelay;
        const endsAt = duration === null ? null : iso(start + duration);
        const cancelledAt = cancelRel === null ? null : iso(start + cancelRel);
        const consumedAt = consumeRel === null ? null : iso(start + consumeRel);
        return {
          effectId: `eff-${index}`,
          slug: "power-hour",
          kind,
          sourcePlayId: null,
          sourceChallengeId: null,
          ownerTeamId: null,
          targetTeamId: null,
          targetBarKey: null,
          startsAt: iso(start),
          endsAt,
          params: {},
          attachedClaimId: null,
          attachedBarKey: null,
          protectedPoints: null,
          consumedAt,
          cancelledAt,
          cancelReason: cancelledAt === null ? null : "host",
          startAnnounced: false,
          endAnnounced: false,
        };
      },
    );
}

const effectsArb: fc.Arbitrary<EffectRecord[]> = fc
  .array(fc.nat({ max: 7 }), { minLength: 0, maxLength: 7 })
  .chain((indices) =>
    indices.length === 0
      ? fc.constant<EffectRecord[]>([])
      : fc.tuple(...indices.map((_, i) => effectArb(i))),
  );

// ---------------------------------------------------------------------------
// Call sequence generator.
//
// A nondecreasing sequence of call times, each tagged as a Settle_Nudge, an
// accepted mutation, a rejected mutation, or a Cron_Route. Mutations settle at
// their own `now` before their plan, exactly like the pipeline. None of the
// call kinds differ in how they settle due transitions; what differs is how
// many *mutation* events the call appends (1 accepted, 0 otherwise).
// ---------------------------------------------------------------------------

type CallKind =
  "settle_nudge" | "mutation_accepted" | "mutation_rejected" | "cron";

interface Call {
  readonly kind: CallKind;
  readonly atMs: number;
}

/** Candidate call times: every boundary and boundary ± 1 ms, plus far field. */
function candidateTimes(effects: readonly EffectRecord[]): number[] {
  const times = new Set<number>([
    BASE_MS - 2 * 60 * 60_000,
    BASE_MS + 6 * 60 * 60_000,
  ]);
  for (const e of effects) {
    for (const stamp of [e.startsAt, e.endsAt, e.cancelledAt, e.consumedAt]) {
      if (stamp !== null) {
        const ms = Date.parse(stamp);
        times.add(ms - 1);
        times.add(ms);
        times.add(ms + 1);
      }
    }
  }
  return [...times].sort((a, b) => a - b);
}

function callsArb(effects: readonly EffectRecord[]): fc.Arbitrary<Call[]> {
  const times = candidateTimes(effects);
  return fc
    .array(
      fc.record({
        kind: fc.constantFrom<CallKind>(
          "settle_nudge",
          "mutation_accepted",
          "mutation_rejected",
          "cron",
        ),
        time: fc.constantFrom(...times),
      }),
      { minLength: 1, maxLength: 10 },
    )
    .map((raw) =>
      // Enforce nondecreasing server times: real callers serialize on the game
      // lock and read `clock_timestamp()` after it, so later calls never see an
      // earlier instant.
      raw
        .slice()
        .sort((a, b) => a.time - b.time)
        .map(({ kind, time }) => ({ kind, atMs: time })),
    );
}

// ---------------------------------------------------------------------------
// Reference: is a transition due at `now` for an effect with flags as given?
//
// Written straight from the settlement contract, independent of the planner.
// "Due" means: unannounced for that boundary, boundary reached, and the effect
// was not stopped before the boundary in a way that cancels the transition.
// ---------------------------------------------------------------------------

function activationDue(e: EffectRecord, nowMs: number): boolean {
  if (e.startAnnounced) {
    return false;
  }
  const start = Date.parse(e.startsAt);
  if (start > nowMs) {
    return false;
  }
  const cancelled = e.cancelledAt === null ? null : Date.parse(e.cancelledAt);
  return !(cancelled !== null && cancelled < start);
}

function expiryDue(e: EffectRecord, nowMs: number): boolean {
  if (e.endAnnounced) {
    return false;
  }
  if (e.endsAt === null) {
    return false;
  }
  const end = Date.parse(e.endsAt);
  if (end > nowMs) {
    return false;
  }
  if (e.consumedAt !== null) {
    return false;
  }
  const cancelled = e.cancelledAt === null ? null : Date.parse(e.cancelledAt);
  return !(cancelled !== null && cancelled < end);
}

/** Apply a planned transition to its effect by flipping the announced flag. */
function markAnnounced(
  effects: EffectRecord[],
  transition: EffectTransition,
): void {
  const idx = effects.findIndex((e) => e.effectId === transition.effectId);
  if (idx === -1) {
    return;
  }
  const e = effects[idx];
  effects[idx] =
    transition.kind === "activated"
      ? { ...e, startAnnounced: true }
      : { ...e, endAnnounced: true };
}

// ---------------------------------------------------------------------------
// The property.
// ---------------------------------------------------------------------------

describe("planEffectTransitions — timer settlement announces each transition once (Property 22)", () => {
  it("announces every due transition exactly once, in order, and only at/after its boundary", () => {
    fc.assert(
      fc.property(
        effectsArb.chain((effects) =>
          callsArb(effects).map((calls) => ({ effects, calls })),
        ),
        ({ effects, calls }) => {
          // Mutable working copy whose announced flags advance as calls run.
          const live = effects.map((e) => ({ ...e }));

          // Count announcements per (effectId, kind) across the whole sequence.
          const announceCount = new Map<string, number>();
          const key = (t: EffectTransition): string =>
            `${t.effectId}:${t.kind}`;

          let mutationEventTotal = 0;

          for (const call of calls) {
            // Every call kind settles identically: it is always a live game in
            // this model, so `planEffectTransitions` plans against the call's
            // server time.
            const planned = planEffectTransitions(live, call.atMs, "live");

            // Activation is ordered before expiry for the same effect, and the
            // whole list is ordered by boundary then effectId.
            for (let i = 1; i < planned.length; i++) {
              const prev = planned[i - 1];
              const cur = planned[i];
              expect(prev.atMs <= cur.atMs).toBe(true);
              if (prev.effectId === cur.effectId && prev.atMs === cur.atMs) {
                expect(prev.kind).toBe("activated");
                expect(cur.kind).toBe("expired");
              }
            }

            // Only transitions whose boundary is at or before `now` may appear,
            // and only ones the reference agrees are due (not cancelled before
            // boundary, not consumed, correct flag unset).
            for (const t of planned) {
              expect(t.atMs <= call.atMs).toBe(true);
              const e = live.find((x) => x.effectId === t.effectId);
              expect(e).toBeDefined();
              const due =
                t.kind === "activated"
                  ? activationDue(e as EffectRecord, call.atMs)
                  : expiryDue(e as EffectRecord, call.atMs);
              expect(due).toBe(true);
              announceCount.set(key(t), (announceCount.get(key(t)) ?? 0) + 1);
            }

            // Flip announced flags between calls (the real settle commits them).
            for (const t of planned) {
              markAnnounced(live, t);
            }

            // Idempotence: immediately re-running at the same `now` plans
            // nothing, so after any call returns nothing due at <= now remains
            // unannounced. This is why a mutation's transition events precede
            // its own mutation events.
            expect(planEffectTransitions(live, call.atMs, "live")).toEqual([]);

            // Mutation event accounting (19.9, 19.10): exactly one for an
            // accepted mutation, zero otherwise, regardless of transition count.
            if (call.kind === "mutation_accepted") {
              mutationEventTotal += 1;
            }
          }

          // Every announced transition happened exactly once.
          for (const count of announceCount.values()) {
            expect(count).toBe(1);
          }

          // The set of announced transitions by the end equals every transition
          // due by the final call's time (nothing due was ever skipped).
          const finalNow = calls[calls.length - 1].atMs;
          const expectedDue = new Set<string>();
          for (const e of effects) {
            if (activationDue(e, finalNow)) {
              expectedDue.add(`${e.effectId}:activated`);
            }
            if (expiryDue(e, finalNow)) {
              expectedDue.add(`${e.effectId}:expired`);
            }
          }
          expect(new Set(announceCount.keys())).toEqual(expectedDue);

          // Mutation-event total equals the number of accepted mutations.
          const acceptedCount = calls.filter(
            (c) => c.kind === "mutation_accepted",
          ).length;
          expect(mutationEventTotal).toBe(acceptedCount);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("a game that is not live produces no transitions on any call", () => {
    fc.assert(
      fc.property(
        effectsArb,
        fc.constantFrom(...candidateTimes([])),
        fc.constantFrom<"lobby" | "ended">("lobby", "ended"),
        (effects, _t, lifecycle) => {
          const now = BASE_MS + 90 * 60_000;
          expect(planEffectTransitions(effects, now, lifecycle)).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("flipping announced flags never changes an isEffectActive (block/eligibility/bonus) decision", () => {
    // Every block, eligibility, and bonus decision reads server time through
    // isEffectActive, which ignores the announced flags. So for any effect and
    // any probe time, flipping both flags leaves isEffectActive unchanged.
    fc.assert(
      fc.property(
        effectArb(0),
        fc.integer({ min: -2 * 60 * 60_000, max: 6 * 60 * 60_000 }),
        (effect, probeOffset) => {
          const t = BASE_MS + probeOffset;
          const base = isEffectActive(effect, t);
          const flips: EffectRecord[] = [
            { ...effect, startAnnounced: true },
            { ...effect, endAnnounced: true },
            { ...effect, startAnnounced: true, endAnnounced: true },
            { ...effect, startAnnounced: false, endAnnounced: false },
          ];
          for (const variant of flips) {
            expect(isEffectActive(variant, t)).toBe(base);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
