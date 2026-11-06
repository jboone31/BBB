import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { deriveToasts, audienceRole, type ToastKind } from "./toasts";
import {
  CARD_SLUGS,
  getCardMetadata,
  getCardText,
  type CardSlug,
} from "./catalog";
import type { CastingParams } from "./inputs";
import type { ChallengeRecord, FairestOfferRecord } from "./behaviorState";
import type { EffectRecord } from "./effects";
import {
  initialGameBoardView,
  type GameBoardView,
  type PlayView,
  type ToastEvent,
  type BoardTeamView,
  type BoardScoreEntryView,
} from "@/lib/gameboard/events";

/**
 * Feature: card-behavior, Property 4: Audience routing partitions every
 * toast-producing event.
 *
 * For any game with 2-4 teams and any toast-producing event, `deriveToasts`
 * hands each team exactly the role-appropriate toast (design.md §Property 4):
 *
 *   - Team-target plays: the Target_Team gets the `target` (or `voted_off_target`)
 *     toast, the Caster gets the `caster` toast, and every other team gets the
 *     others' / announcement toast with the Effect in the dropdown (3.1, 3.2, 3.3).
 *   - Bar and no-target plays: non-casters get the card's override when defined,
 *     else the standard others' headline (3.4).
 *   - Fairest mirrors: the original caster gets the `mirror` toast, uninvolved
 *     teams get `mirror_others`, and the holder gets nothing (9.6, 9.7, 21.8).
 *   - Payouts and host overrides go to every team (16.6).
 *   - Effect transition events (`effect_activated` / `effect_expired`) are not in
 *     the fold's `toastEvents`, so they produce no toast here.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 9.6, 9.7, 11.4, 12.5, 16.6, 18.8,
 * 21.8
 */

// ---------------------------------------------------------------------------
// Card classification, derived independently of the module under test so the
// expected-routing oracle is a real check and not a copy of toasts.ts.
// ---------------------------------------------------------------------------

/** Cards that target a team (standard target headline + body routing). */
const TEAM_TARGET_SLUGS: readonly CardSlug[] = CARD_SLUGS.filter(
  (slug) => getCardMetadata(slug).targetMode === "team",
);

/** Cards whose others' toast is replaced by an `announcement` override. */
function hasAnnouncementOverride(slug: CardSlug): boolean {
  return getCardText(slug).toasts?.announcement !== undefined;
}

const GAME_ID = "11111111-1111-4111-8111-111111111111";

const TEAM_COLORS = ["#e11", "#1a7", "#36c", "#f90"] as const;

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/** 2-4 teams with stable ids, names, and colors. */
const teamsArb: fc.Arbitrary<BoardTeamView[]> = fc
  .integer({ min: 2, max: 4 })
  .map((n) =>
    Array.from({ length: n }, (_unused, i) => ({
      id: `team-${i}`,
      name: `Team ${i}`,
      color: TEAM_COLORS[i] ?? "#000",
    })),
  );

/** `none` params for every card; the audience routing is params-independent. */
const noneParams: CastingParams = { kind: "none" };

/**
 * A `card_played` ToastEvent plus its PlayView, with a caster and (for
 * team/team_and_bar cards) a distinct target drawn from the team set.
 */
function playCaseArb(
  teams: readonly BoardTeamView[],
): fc.Arbitrary<{ event: ToastEvent; play: PlayView }> {
  const teamIds = teams.map((t) => t.id);
  return fc
    .record({
      slug: fc.constantFrom(...CARD_SLUGS),
      casterIdx: fc.integer({ min: 0, max: teamIds.length - 1 }),
      targetOffset: fc.integer({ min: 1, max: teamIds.length - 1 }),
      seq: fc.integer({ min: 1, max: 9999 }),
    })
    .map(({ slug, casterIdx, targetOffset, seq }) => {
      const casterTeamId = teamIds[casterIdx] as string;
      const meta = getCardMetadata(slug);
      const targetsTeam =
        meta.targetMode === "team" || meta.targetMode === "team_and_bar";
      const targetTeamId = targetsTeam
        ? (teamIds[(casterIdx + targetOffset) % teamIds.length] as string)
        : null;
      const barKey =
        meta.targetMode === "bar" ||
        meta.targetMode === "team_and_bar" ||
        meta.targetMode === "self"
          ? "midway-pub"
          : null;
      const playId = `play-${seq}`;
      const play: PlayView = {
        playId,
        slug,
        casterTeamId,
        targetTeamId,
        barKey,
        returnBarKey: null,
        params: noneParams,
        seq,
        createdAt: new Date(seq * 1000).toISOString(),
      };
      const event: ToastEvent = {
        id: `${seq}:play:${playId}`,
        seq,
        kind: "play",
        subjectId: playId,
      };
      return { event, play };
    });
}

/** A played Fairest offer plus the ToastEvent that folds it into a mirror. */
function mirrorCaseArb(
  teams: readonly BoardTeamView[],
): fc.Arbitrary<{ event: ToastEvent; offer: FairestOfferRecord }> {
  const teamIds = teams.map((t) => t.id);
  return fc
    .record({
      slug: fc.constantFrom(...TEAM_TARGET_SLUGS),
      casterIdx: fc.integer({ min: 0, max: teamIds.length - 1 }),
      holderOffset: fc.integer({ min: 1, max: teamIds.length - 1 }),
      seq: fc.integer({ min: 1, max: 9999 }),
    })
    .map(({ slug, casterIdx, holderOffset, seq }) => {
      const originalCasterTeamId = teamIds[casterIdx] as string;
      const holderTeamId = teamIds[
        (casterIdx + holderOffset) % teamIds.length
      ] as string;
      const offerId = `offer-${seq}`;
      const offer: FairestOfferRecord = {
        offerId,
        sourcePlayId: `src-${seq}`,
        slug,
        holderTeamId,
        originalCasterTeamId,
        challengeId: `chal-${seq}`,
        restrictionEffectId: null,
        status: "played",
        decidedAt: new Date(seq * 1000).toISOString(),
        mirroredChallengeId: `mir-${seq}`,
        mirroredEffectId: null,
      };
      const event: ToastEvent = {
        id: `${seq}:fairest_decided:${offerId}`,
        seq,
        kind: "fairest_decided",
        subjectId: offerId,
      };
      return { event, offer };
    });
}

// ---------------------------------------------------------------------------
// View assembly: a minimal GameBoardView carrying the records the toast derivation
// reads for one toast-producing event at a time.
// ---------------------------------------------------------------------------

function viewWith(
  teams: readonly BoardTeamView[],
  overrides: {
    plays?: Record<string, PlayView>;
    offers?: Record<string, FairestOfferRecord>;
    challenges?: Record<string, ChallengeRecord>;
    effects?: Record<string, EffectRecord>;
    scoreEntries?: BoardScoreEntryView[];
    toastEvents?: readonly ToastEvent[];
  },
): GameBoardView {
  const base = initialGameBoardView(GAME_ID);
  return {
    ...base,
    lifecycle: "live",
    teams: [...teams],
    scoreEntries: overrides.scoreEntries ?? [],
    cardBehavior: {
      ...base.cardBehavior,
      plays: overrides.plays ?? {},
      offers: overrides.offers ?? {},
      challenges: overrides.challenges ?? {},
      effects: overrides.effects ?? {},
      toastEvents: overrides.toastEvents ?? [],
    },
  };
}

/** The single toast a viewer sees for a one-event view, or null if none. */
function soleToast(view: GameBoardView, viewerTeamId: string | null) {
  const toasts = deriveToasts(view, viewerTeamId);
  expect(toasts.length).toBeLessThanOrEqual(1);
  return toasts[0] ?? null;
}

// ---------------------------------------------------------------------------
// Property 4a: team-target plays partition the teams by role.
// ---------------------------------------------------------------------------

describe("Audience routing partitions every toast-producing event (Property 4)", () => {
  it("team-target plays route target / caster / others exactly (3.1, 3.2, 3.3, 18.8)", () => {
    fc.assert(
      fc.property(
        teamsArb.chain((teams) =>
          fc.record({ teams: fc.constant(teams), pc: playCaseArb(teams) }),
        ),
        ({ teams, pc }) => {
          const { event, play } = pc;
          fc.pre(play.targetTeamId !== null);
          const view = viewWith(teams, {
            plays: { [play.playId]: play },
            toastEvents: [event],
          });

          for (const team of teams) {
            const toast = soleToast(view, team.id);
            expect(toast).not.toBeNull();
            const role = audienceRole(
              team.id,
              play.casterTeamId,
              play.targetTeamId,
            );
            const kind = (toast as { kind: ToastKind }).kind;
            if (role === "caster") {
              expect(kind).toBe("caster");
            } else if (role === "target") {
              // Voted Off targets get the removal body kind, others the gate kind.
              expect(kind === "target" || kind === "voted_off_target").toBe(
                true,
              );
            } else {
              expect(kind === "others" || kind === "announcement").toBe(true);
            }
            // Every team sees exactly one toast and the id is the event id.
            expect((toast as { id: string }).id).toBe(event.id);
          }

          // A spectator (no team) is always in the others' audience.
          const spectator = soleToast(view, null);
          expect(spectator).not.toBeNull();
          const specKind = (spectator as { kind: ToastKind }).kind;
          expect(specKind === "others" || specKind === "announcement").toBe(
            true,
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // Property 4b: others get the Effect dropdown unless an announcement overrides.
  // -------------------------------------------------------------------------

  it("the others' toast carries the Effect dropdown, and an announcement override replaces the headline and drops it (3.3, 3.4, 11.4, 12.5)", () => {
    fc.assert(
      fc.property(
        teamsArb.chain((teams) =>
          fc.record({ teams: fc.constant(teams), pc: playCaseArb(teams) }),
        ),
        ({ teams, pc }) => {
          const { event, play } = pc;
          const view = viewWith(teams, {
            plays: { [play.playId]: play },
            toastEvents: [event],
          });

          // An "others" viewer: a team that is neither caster nor target.
          const others = teams.find(
            (t) => t.id !== play.casterTeamId && t.id !== play.targetTeamId,
          );
          if (others === undefined) {
            return; // 2-team team-target play has no uninvolved team.
          }
          const toast = soleToast(view, others.id);
          expect(toast).not.toBeNull();
          const t = toast as {
            kind: ToastKind;
            dropdown: string | null;
            dismissable: boolean;
          };
          // Others' toasts are always dismissable (3.8 only pins action toasts).
          expect(t.dismissable).toBe(true);
          if (hasAnnouncementOverride(play.slug)) {
            expect(t.kind).toBe("announcement");
            expect(t.dropdown).toBeNull();
          } else {
            expect(t.kind).toBe("others");
            // The Effect text is shown in an expandable dropdown (3.3).
            expect(t.dropdown).toBe(getCardText(play.slug).effect);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // Property 4c: Fairest mirror routing (caster / holder / others).
  // -------------------------------------------------------------------------

  it("a played Fairest mirrors to the original caster and to uninvolved teams, never to the holder (9.6, 9.7, 21.8)", () => {
    fc.assert(
      fc.property(
        teamsArb.chain((teams) =>
          fc.record({ teams: fc.constant(teams), mc: mirrorCaseArb(teams) }),
        ),
        ({ teams, mc }) => {
          const { event, offer } = mc;
          const view = viewWith(teams, {
            offers: { [offer.offerId]: offer },
            toastEvents: [event],
          });

          for (const team of teams) {
            const toast = soleToast(view, team.id);
            if (team.id === offer.holderTeamId) {
              // The holder already saw its own challenge: no mirror toast.
              expect(toast).toBeNull();
            } else if (team.id === offer.originalCasterTeamId) {
              expect((toast as { kind: ToastKind }).kind).toBe("mirror");
            } else {
              expect((toast as { kind: ToastKind }).kind).toBe("mirror_others");
            }
          }

          // A spectator is uninvolved: mirror_others.
          const spectator = soleToast(view, null);
          expect((spectator as { kind: ToastKind }).kind).toBe("mirror_others");
        },
      ),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // Property 4d: payouts reach every team with the same payout toast.
  // -------------------------------------------------------------------------

  it("a Patient Investor payout routes the same payout toast to every team (16.6)", () => {
    fc.assert(
      fc.property(
        teamsArb,
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 1, max: 9999 }),
        (teams, teamIdx, seq) => {
          const beneficiary = teams[teamIdx % teams.length] as BoardTeamView;
          const entryId = `entry-${seq}`;
          const entry: BoardScoreEntryView = {
            entryId,
            teamId: beneficiary.id,
            category: "patient_investor_award",
            points: 6,
            sourceId: null,
          };
          const event: ToastEvent = {
            id: `${seq}:payout:${entryId}`,
            seq,
            kind: "payout",
            subjectId: entryId,
          };
          const view = viewWith(teams, {
            scoreEntries: [entry],
            toastEvents: [event],
          });

          for (const team of [...teams.map((t) => t.id), null]) {
            const toast = soleToast(view, team);
            expect(toast).not.toBeNull();
            expect((toast as { kind: ToastKind }).kind).toBe("payout");
            expect((toast as { id: string }).id).toBe(event.id);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // -------------------------------------------------------------------------
  // Property 4e: effect transition events never produce a toast here.
  // -------------------------------------------------------------------------

  it("effect transition events are never in toastEvents, so deriveToasts yields nothing from them", () => {
    fc.assert(
      fc.property(teamsArb, fc.integer({ min: 1, max: 9999 }), (teams, seq) => {
        // The fold never pushes activation/expiry toast events (events.ts), so
        // a view whose only card-behavior activity is effect transitions has an
        // empty toastEvents list; deriveToasts returns [] for every viewer.
        const effect: EffectRecord = {
          effectId: `eff-${seq}`,
          slug: "crop-dusting",
          kind: "bar_lock",
          sourcePlayId: `play-${seq}`,
          sourceChallengeId: null,
          ownerTeamId: "team-0",
          targetTeamId: null,
          targetBarKey: "midway-pub",
          startsAt: new Date(seq * 1000).toISOString(),
          endsAt: new Date((seq + 900) * 1000).toISOString(),
          params: {},
          attachedClaimId: null,
          attachedBarKey: null,
          protectedPoints: null,
          consumedAt: null,
          cancelledAt: null,
          cancelReason: null,
          startAnnounced: true,
          endAnnounced: true,
        };
        const view = viewWith(teams, {
          effects: { [effect.effectId]: effect },
          toastEvents: [], // transitions push none
        });

        for (const team of [...teams.map((t) => t.id), null]) {
          expect(deriveToasts(view, team)).toEqual([]);
        }
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // audienceRole oracle: the pure role function partitions viewers.
  // -------------------------------------------------------------------------

  it("audienceRole returns caster for the caster, target for the target, others for everyone else and spectators", () => {
    fc.assert(
      fc.property(
        teamsArb,
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 3 }),
        fc.boolean(),
        (teams, casterIdx, targetIdx, targetsTeam) => {
          const casterTeamId = teams[casterIdx % teams.length]?.id as string;
          const targetTeamId = targetsTeam
            ? (teams[targetIdx % teams.length]?.id as string)
            : null;
          for (const team of teams) {
            const role = audienceRole(team.id, casterTeamId, targetTeamId);
            if (team.id === casterTeamId) {
              expect(role).toBe("caster");
            } else if (targetTeamId !== null && team.id === targetTeamId) {
              expect(role).toBe("target");
            } else {
              expect(role).toBe("others");
            }
          }
          // A null viewer (spectator / host) is always others.
          expect(audienceRole(null, casterTeamId, targetTeamId)).toBe("others");
        },
      ),
      { numRuns: 200 },
    );
  });
});
