import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { GameEvent } from "@/lib/events";

import {
  applyGameBoardEvent,
  foldGameBoardEvents,
  GAME_BOARD_EVENT_TYPES,
  initialGameBoardView,
  selectScoreTotals,
  type GameBoardView,
} from "./events";

/**
 * Feature: card-behavior, Property 23: Projection fold is idempotent, isolated,
 * and snapshot-equivalent.
 *
 * Validates: Requirements 23.1, 23.2, 23.3, 23.4, 23.5
 *
 * The board keeps no "current state" table: the `GameBoardView` the client
 * renders — including the new `cardBehavior` slice (plays, challenges, offers,
 * effects, awards, seq-ordered deduped toast descriptors) — is derived by
 * folding the append-only `game_events` log (design.md §Projection Changes,
 * task 9.1). These properties pin the guarantees the board, snapshot load, and
 * reconnect/recheck all rely on, over arbitrary sequences of the new
 * record-bearing event types with duplicates and snapshot splits:
 *
 *   - Idempotence (23.2): folding with arbitrary duplicate deliveries equals
 *     folding each event once; embedded records upsert by id so a later seq
 *     replaces an earlier one and a lower seq is ignored; toast descriptors stay
 *     seq-ordered and deduped by id.
 *   - Snapshot/reconnect equivalence (23.1): folding the full log equals folding
 *     any snapshot prefix and then the remaining tail, in any arrival order —
 *     covering challenges, offers, effects, awards, claims, scores, and toasts.
 *   - Single-game isolation (23.5): events for another game are rejected
 *     (`RangeError`), never folded in.
 *   - Score consistency (23.4): each team's score equals the sum of its ledger
 *     entries, however the embedded `scoreEntries` arrive.
 *   - Effect transitions (20.6): `effect_activated` / `effect_expired` flip the
 *     embedded effect's `startAnnounced` / `endAnnounced` flag and push no toast.
 *
 * The suite drives the pure, framework-free reducer in `./events`, so no live
 * database or transport is involved, mirroring `events.property.test.ts`.
 */

const idArb = (prefix: string): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 7 }).map((n) => `${prefix}-${n}`);

const teamIdArb = idArb("team");
const barKeyArb = idArb("bar");

/** ISO timestamp derived from a seq, so every record has a deterministic time. */
function isoAt(seq: number): string {
  return new Date(seq * 1000).toISOString();
}

/** An embedded challenge record, parameterized by id and resolution status. */
function challengeRecord(
  challengeId: string,
  status: "open" | "completed" | "failed" | "cleared_by_host",
): Record<string, unknown> {
  return {
    challengeId,
    slug: "go-piss-girl",
    sourcePlayId: "play-seed",
    casterTeamId: "team-0",
    targetTeamId: "team-1",
    params: { kind: "none" },
    mirroredFromChallengeId: null,
    mirroredFromPlayId: null,
    status,
    createdAt: isoAt(1),
    resolvedAt: status === "open" ? null : isoAt(2),
    resolvedByTeamId: status === "open" ? null : "team-1",
    resolvedBySessionId: null,
    resolvedByKind: status === "open" ? null : "team",
    failureEffectId: null,
  };
}

/** An embedded Fairest-offer record. */
function offerRecord(
  offerId: string,
  status: "pending" | "played" | "declined" | "void",
): Record<string, unknown> {
  return {
    offerId,
    sourcePlayId: "play-seed",
    slug: "pioneer",
    holderTeamId: "team-1",
    originalCasterTeamId: "team-0",
    challengeId: null,
    restrictionEffectId: "effect-r",
    status,
    decidedAt: status === "pending" ? null : isoAt(2),
    mirroredChallengeId: null,
    mirroredEffectId: null,
  };
}

/** An embedded effect record (announced flags folded from transition events). */
function effectRecord(
  effectId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    effectId,
    slug: "cancel-culture",
    kind: "radius_lock",
    sourcePlayId: "play-seed",
    sourceChallengeId: null,
    ownerTeamId: "team-0",
    targetTeamId: null,
    targetBarKey: "bar-0",
    startsAt: isoAt(5),
    endsAt: isoAt(20),
    params: { radiusMiles: 0.25 },
    attachedClaimId: null,
    attachedBarKey: null,
    protectedPoints: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    startAnnounced: false,
    endAnnounced: false,
    ...overrides,
  };
}

/**
 * A record-bearing card-behavior event "spec" (type + payload) before it is
 * stamped with a seq. Payloads follow the shapes the routes embed, so the fold's
 * record sections, score fold, claim removals, toast descriptors, and transition
 * flags are all exercised.
 */
const behaviorSpecArb: fc.Arbitrary<{ eventType: string; payload: unknown }> =
  fc.oneof(
    // card_played — records a PlayView + play toast, and may embed a challenge,
    // offer, effect, or ledger/claim sections.
    fc
      .record({
        playId: idArb("play"),
        caster: teamIdArb,
        target: teamIdArb,
        barKey: barKeyArb,
        challengeId: idArb("challenge"),
        hasChallenge: fc.boolean(),
        effectId: idArb("effect"),
        hasEffect: fc.boolean(),
        awardId: idArb("award"),
        entryId: idArb("ledger"),
        awardTeam: teamIdArb,
        points: fc.integer({ min: -12, max: 12 }),
        hasAward: fc.boolean(),
      })
      .map((r) => ({
        eventType: GAME_BOARD_EVENT_TYPES.cardPlayed,
        payload: {
          playId: r.playId,
          slug: "go-piss-girl",
          castingTeamId: r.caster,
          targetTeamId: r.target,
          barKey: r.barKey,
          ...(r.hasChallenge
            ? { challenges: [challengeRecord(r.challengeId, "open")] }
            : {}),
          ...(r.hasEffect ? { effects: [effectRecord(r.effectId)] } : {}),
          ...(r.hasAward
            ? {
                awards: [
                  {
                    awardId: r.awardId,
                    effectId: r.effectId,
                    teamId: r.awardTeam,
                    kind: "happy_hour_bonus",
                    claimId: null,
                    ledgerEntryId: r.entryId,
                    reversedAt: null,
                    reversalLedgerEntryId: null,
                    createdAt: isoAt(1),
                  },
                ],
                scoreEntries: [
                  {
                    entryId: r.entryId,
                    teamId: r.awardTeam,
                    category: "happy_hour_bonus",
                    points: r.points,
                  },
                ],
              }
            : {}),
        },
      })),
    // challenge_resolved — upserts the challenge to a resolved status and pushes
    // a challenge_resolved toast.
    fc
      .record({
        challengeId: idArb("challenge"),
        status: fc.constantFrom(
          "completed" as const,
          "failed" as const,
          "cleared_by_host" as const,
        ),
      })
      .map((r) => ({
        eventType: GAME_BOARD_EVENT_TYPES.challengeResolved,
        payload: {
          challengeId: r.challengeId,
          challenges: [challengeRecord(r.challengeId, r.status)],
        },
      })),
    // fairest_decided — upserts the offer + routes a Fairest card through the
    // inventory fold and pushes a fairest_decided toast.
    fc
      .record({
        offerId: idArb("offer"),
        status: fc.constantFrom("played" as const, "declined" as const),
      })
      .map((r) => ({
        eventType: GAME_BOARD_EVENT_TYPES.fairestDecided,
        payload: {
          offerId: r.offerId,
          offers: [offerRecord(r.offerId, r.status)],
        },
      })),
    // happy_hour_bonus_claimed — a bonus award + ledger entry + a bonus toast.
    fc
      .record({
        barKey: barKeyArb,
        awardId: idArb("award"),
        entryId: idArb("ledger"),
        team: teamIdArb,
        points: fc.integer({ min: 0, max: 5 }),
      })
      .map((r) => ({
        eventType: GAME_BOARD_EVENT_TYPES.happyHourBonusClaimed,
        payload: {
          barKey: r.barKey,
          awards: [
            {
              awardId: r.awardId,
              effectId: "effect-hh",
              teamId: r.team,
              kind: "happy_hour_bonus",
              claimId: null,
              ledgerEntryId: r.entryId,
              reversedAt: null,
              reversalLedgerEntryId: null,
              createdAt: isoAt(1),
            },
          ],
          scoreEntries: [
            {
              entryId: r.entryId,
              teamId: r.team,
              category: "happy_hour_bonus",
              points: r.points,
            },
          ],
        },
      })),
    // claim_recorded — a plain claim that a later voted-off removal can revoke.
    fc
      .record({
        claimId: idArb("claim"),
        team: teamIdArb,
        barId: barKeyArb,
        entryId: idArb("ledger"),
        points: fc.integer({ min: 0, max: 12 }),
      })
      .map((r) => ({
        eventType: GAME_BOARD_EVENT_TYPES.claimRecorded,
        payload: {
          claimId: r.claimId,
          teamId: r.team,
          barId: r.barId,
          scoreEntries: [
            {
              entryId: r.entryId,
              teamId: r.team,
              category: "bar_share",
              points: r.points,
            },
          ],
        },
      })),
    // claim_removed — removes a claim through the embedded removedClaims section.
    fc.record({ claimId: idArb("claim") }).map((r) => ({
      eventType: GAME_BOARD_EVENT_TYPES.claimRemoved,
      payload: { claimId: r.claimId, removedClaims: [{ claimId: r.claimId }] },
    })),
    // score_awarded — a patient_investor_award pushes a payout toast; a plain
    // category does not.
    fc
      .record({
        entryId: idArb("ledger"),
        team: teamIdArb,
        points: fc.integer({ min: -12, max: 12 }),
        patient: fc.boolean(),
      })
      .map((r) => ({
        eventType: GAME_BOARD_EVENT_TYPES.scoreAwarded,
        payload: {
          entryId: r.entryId,
          teamId: r.team,
          category: r.patient ? "patient_investor_award" : "bar_share",
          points: r.points,
        },
      })),
  );

/**
 * Build a contiguous card-behavior event log for `gameId`: events with seqs
 * 1..count in ascending order. Lifecycle framing (`game_started`) is prepended
 * so the view is live, and an effect is seeded up front so the transition events
 * that follow have a record to flip.
 */
function behaviorLogArb(gameId: string): fc.Arbitrary<GameEvent[]> {
  return fc
    .array(behaviorSpecArb, { minLength: 0, maxLength: 30 })
    .chain((specs) =>
      // Optionally fold in effect transition events against a seeded effect, to
      // exercise the announced-flag flips (which must push no toast).
      fc
        .array(
          fc.record({
            activate: fc.boolean(),
            position: fc.integer({ min: 0, max: 40 }),
          }),
          { maxLength: 6 },
        )
        .map((transitions) => {
          const SEED_EFFECT = "effect-seed";
          const prefix: { eventType: string; payload: unknown }[] = [
            { eventType: GAME_BOARD_EVENT_TYPES.gameStarted, payload: {} },
            {
              eventType: GAME_BOARD_EVENT_TYPES.cardPlayed,
              payload: {
                playId: "play-seed",
                slug: "cancel-culture",
                castingTeamId: "team-0",
                barKey: "bar-0",
                effects: [effectRecord(SEED_EFFECT)],
              },
            },
          ];
          const body = [...prefix, ...specs];
          // Splice the transition events into the body at their requested spots.
          const withTransitions = [...body];
          for (const t of transitions) {
            const pos = Math.min(t.position, withTransitions.length);
            withTransitions.splice(pos, 0, {
              eventType: t.activate
                ? GAME_BOARD_EVENT_TYPES.effectActivated
                : GAME_BOARD_EVENT_TYPES.effectExpired,
              payload: {
                effectId: SEED_EFFECT,
                effects: [
                  effectRecord(SEED_EFFECT, {
                    startAnnounced: t.activate,
                    endAnnounced: !t.activate,
                  }),
                ],
              },
            });
          }
          return withTransitions.map((spec, index): GameEvent => ({
            id: `${gameId}-e${index + 1}`,
            gameId,
            seq: index + 1,
            eventType: spec.eventType,
            actorKind: "system",
            actorTeamId: null,
            payload: spec.payload,
            createdAt: isoAt(index + 1),
          }));
        }),
    );
}

/** Shuffle a copy of `events` by pairing each with a random sort key. */
function shuffleBy<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items
    .map((item, i) => ({ item, k: keys[i] ?? i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.item);
}

/** The sum of a team's ledger entries, straight from the raw events. */
function expectedTotalsFromEvents(
  events: readonly GameEvent[],
): Record<string, number> {
  const seen = new Set<string>();
  const totals: Record<string, number> = {};
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const payload = event.payload as Record<string, unknown>;
    const sections: Record<string, unknown>[] = [];
    if (Array.isArray(payload.scoreEntries)) {
      sections.push(...(payload.scoreEntries as Record<string, unknown>[]));
    }
    // Top-level score entries (score_awarded).
    if (typeof payload.entryId === "string") {
      sections.push(payload);
    }
    for (const entry of sections) {
      const entryId = entry.entryId;
      const teamId = entry.teamId;
      const points = entry.points;
      if (
        typeof entryId !== "string" ||
        typeof teamId !== "string" ||
        typeof points !== "number" ||
        seen.has(entryId)
      ) {
        continue;
      }
      seen.add(entryId);
      totals[teamId] = (totals[teamId] ?? 0) + points;
    }
  }
  return totals;
}

describe("card-behavior fold — idempotent, isolated, snapshot-equivalent (Property 23)", () => {
  it("fold is order-independent, duplicate-tolerant, and equals the ascending reference fold", () => {
    fc.assert(
      fc.property(
        fc
          .uuid()
          .chain((gameId) =>
            behaviorLogArb(gameId).map((events) => ({ gameId, events })),
          ),
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 150 }),
        fc.array(fc.integer({ min: 0, max: 60 }), { maxLength: 60 }),
        ({ gameId, events }, keys, dupIndices) => {
          const m = events.length;

          // Reference: a plain ascending left-fold applying each event once.
          const ascending = [...events].sort((a, b) => a.seq - b.seq);
          const expected = ascending.reduce(
            applyGameBoardEvent,
            initialGameBoardView(gameId),
          );

          // 23.1: foldGameBoardEvents equals the ascending reference fold.
          const view = foldGameBoardEvents(gameId, events);
          expect(view).toEqual(expected);

          // 23.2: duplicates in any arrival order never double-apply. Each
          // embedded record is upserted by id (a later seq replaces an earlier
          // one; a lower seq re-delivery is ignored), so the folded slice is
          // identical whatever order the duplicates arrive in.
          const dupes = dupIndices
            .map((i) => (m === 0 ? undefined : events[i % m]))
            .filter((e): e is GameEvent => e !== undefined);
          const arrivals = shuffleBy([...events, ...dupes], keys);
          const foldedFromArrivals = foldGameBoardEvents(gameId, arrivals);
          expect(foldedFromArrivals).toEqual(view);

          // Toast descriptors are seq-ordered and deduped by id.
          const toasts = view.cardBehavior.toastEvents;
          const seqs = toasts.map((t) => t.seq);
          expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
          expect(new Set(toasts.map((t) => t.id)).size).toBe(toasts.length);

          // 23.4: each team's score equals the sum of its ledger entries.
          expect(selectScoreTotals(view)).toEqual(
            expectedTotalsFromEvents(events),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("snapshot prefix + tail folds equal folding the full log at every split", () => {
    fc.assert(
      fc.property(
        fc
          .uuid()
          .chain((gameId) =>
            behaviorLogArb(gameId).map((events) => ({ gameId, events })),
          ),
        fc.integer({ min: 0, max: 60 }),
        ({ gameId, events }, splitSeed) => {
          const full = foldGameBoardEvents(gameId, events);
          const split =
            events.length === 0 ? 0 : splitSeed % (events.length + 1);

          // Fold the snapshot prefix, then fold the remaining tail onto it. The
          // result must equal folding the full log — the snapshot/reconnect
          // equivalence the board, snapshot load, and recheck tail all rely on.
          const prefix = events.slice(0, split);
          const tail = events.slice(split);
          const snapshot = foldGameBoardEvents(gameId, prefix);
          const resumed = tail.reduce(applyGameBoardEvent, snapshot);
          expect(resumed).toEqual(full);

          // A tail re-delivered with the prefix overlapping (snapshot + full
          // tail, as a reconnect refetch does) still converges.
          const overlapResumed = events.reduce(applyGameBoardEvent, snapshot);
          expect(overlapResumed).toEqual(full);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("a later-seq record replaces an earlier one; a lower-seq re-delivery is ignored", () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.constantFrom(
          "completed" as const,
          "failed" as const,
          "cleared_by_host" as const,
        ),
        (gameId, resolvedStatus) => {
          const challengeId = "challenge-upsert";
          const open = {
            id: `${gameId}-e1`,
            gameId,
            seq: 1,
            eventType: GAME_BOARD_EVENT_TYPES.cardPlayed,
            actorKind: "system" as const,
            actorTeamId: null,
            payload: {
              playId: "play-seed",
              slug: "go-piss-girl",
              castingTeamId: "team-0",
              targetTeamId: "team-1",
              challenges: [challengeRecord(challengeId, "open")],
            },
            createdAt: isoAt(1),
          };
          const resolved: GameEvent = {
            id: `${gameId}-e2`,
            gameId,
            seq: 2,
            eventType: GAME_BOARD_EVENT_TYPES.challengeResolved,
            actorKind: "system",
            actorTeamId: null,
            payload: {
              challengeId,
              challenges: [challengeRecord(challengeId, resolvedStatus)],
            },
            createdAt: isoAt(2),
          };

          // A later seq replaces the earlier record.
          const forward = foldGameBoardEvents(gameId, [open, resolved]);
          expect(forward.cardBehavior.challenges[challengeId]?.status).toBe(
            resolvedStatus,
          );

          // Re-delivering the earlier (lower-seq) event is ignored: the resolved
          // status stands and nothing regresses to "open".
          const withStale = applyGameBoardEvent(forward, open);
          expect(withStale).toBe(forward);
          expect(withStale.cardBehavior.challenges[challengeId]?.status).toBe(
            resolvedStatus,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("effect transition events flip announced flags and push no toast", () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        (gameId, activations) => {
          const effectId = "effect-seed";
          const seed: GameEvent = {
            id: `${gameId}-e1`,
            gameId,
            seq: 1,
            eventType: GAME_BOARD_EVENT_TYPES.cardPlayed,
            actorKind: "system",
            actorTeamId: null,
            payload: {
              playId: "play-seed",
              slug: "cancel-culture",
              castingTeamId: "team-0",
              barKey: "bar-0",
              effects: [effectRecord(effectId)],
            },
            createdAt: isoAt(1),
          };
          // The server appends a transition event carrying the effect's full,
          // current record, so the embedded flags accumulate: once started, the
          // expiry event's record still has startAnnounced true. Fold that
          // cumulative shape so the test reflects how the pipeline writes it.
          let started = false;
          let ended = false;
          const transitions = activations.map((activate, index): GameEvent => {
            if (activate) {
              started = true;
            } else {
              ended = true;
            }
            return {
              id: `${gameId}-t${index + 2}`,
              gameId,
              seq: index + 2,
              eventType: activate
                ? GAME_BOARD_EVENT_TYPES.effectActivated
                : GAME_BOARD_EVENT_TYPES.effectExpired,
              actorKind: "system",
              actorTeamId: null,
              payload: {
                effectId,
                effects: [
                  effectRecord(effectId, {
                    startAnnounced: started,
                    endAnnounced: ended,
                  }),
                ],
              },
              createdAt: isoAt(index + 2),
            };
          });

          const view = foldGameBoardEvents(gameId, [seed, ...transitions]);
          const effect = view.cardBehavior.effects[effectId];
          // Each transition flips exactly its own announced flag, and the
          // cumulative record keeps earlier flips set.
          expect(effect?.startAnnounced).toBe(activations.includes(true));
          expect(effect?.endAnnounced).toBe(activations.includes(false));

          // Transition events contribute no toast: only the seeding card_played
          // toast is present.
          expect(view.cardBehavior.toastEvents).toEqual([
            {
              id: "1:play:play-seed",
              seq: 1,
              kind: "play",
              subjectId: "play-seed",
            },
          ]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects any event whose gameId differs from the view's gameId (isolation)", () => {
    fc.assert(
      fc.property(
        fc
          .tuple(fc.uuid(), fc.uuid())
          .filter(([view, foreign]) => view !== foreign),
        fc.integer({ min: 1, max: 1000 }),
        ([viewGameId, foreignGameId], foreignSeq) => {
          const view: GameBoardView = foldGameBoardEvents(viewGameId, [
            {
              id: `${viewGameId}-e1`,
              gameId: viewGameId,
              seq: 1,
              eventType: GAME_BOARD_EVENT_TYPES.cardPlayed,
              actorKind: "system",
              actorTeamId: null,
              payload: {
                playId: "play-seed",
                slug: "go-piss-girl",
                castingTeamId: "team-0",
                targetTeamId: "team-1",
                challenges: [challengeRecord("challenge-0", "open")],
              },
              createdAt: isoAt(1),
            },
          ]);

          const foreign: GameEvent = {
            id: `${foreignGameId}-e${foreignSeq}`,
            gameId: foreignGameId,
            seq: foreignSeq,
            eventType: GAME_BOARD_EVENT_TYPES.challengeResolved,
            actorKind: "system",
            actorTeamId: null,
            payload: {
              challengeId: "challenge-0",
              challenges: [challengeRecord("challenge-0", "completed")],
            },
            createdAt: isoAt(foreignSeq),
          };

          const before = structuredClone(view);
          expect(() => applyGameBoardEvent(view, foreign)).toThrow(RangeError);
          // The rejected foreign event never mutates the view's slice.
          expect(view).toEqual(before);
        },
      ),
      { numRuns: 100 },
    );
  });
});
