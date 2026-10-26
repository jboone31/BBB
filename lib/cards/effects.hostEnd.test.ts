import { describe, expect, it } from "vitest";

import {
  planHostEffectEnd,
  type EffectKind,
  type EffectRecord,
  type HostEffectEndState,
} from "./effects";

/**
 * Unit tests for `planHostEffectEnd` (card-behavior Task 11.2, design.md
 * section 6, Requirements 21.4-21.6, 21.11).
 *
 * The planner decides, purely, what a host early-end of one effect must write:
 *
 * - every end sets `cancelledAt = now`, `cancelReason = "host"`;
 * - a Party Crasher `phantom_share` reconciles its bar *without* the phantom;
 * - an Insurance `score_protection` releases itself and reconciles its attached
 *   bar *without* the floor;
 * - a Pioneer / Scenic Route `next_claim_restriction` is simply cancelled, so
 *   `evaluateClaimBlocks` and `hasLegalNextBar` stop applying it — no bar
 *   reconcile, no protection release (21.11);
 * - awards already in the ledger are left untouched (the plan never names an
 *   award);
 * - an already ended / consumed / cancelled effect rejects with
 *   `already_resolved`, and an unknown id with `not_found`.
 */

const BASE_MS = Date.parse("2025-06-01T18:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const NOW = iso(BASE_MS);

/** Build a full {@link EffectRecord}, overriding only the fields a case cares about. */
function effect(
  overrides: Partial<EffectRecord> & { kind: EffectKind },
): EffectRecord {
  return {
    effectId: "e1",
    slug: "party-crasher",
    sourcePlayId: "p1",
    sourceChallengeId: null,
    ownerTeamId: null,
    targetTeamId: null,
    targetBarKey: null,
    startsAt: iso(BASE_MS - 60_000),
    endsAt: null,
    params: {},
    attachedClaimId: null,
    attachedBarKey: null,
    protectedPoints: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    startAnnounced: true,
    endAnnounced: false,
    ...overrides,
  };
}

function stateOf(effects: readonly EffectRecord[]): HostEffectEndState {
  return { lifecycle: "live", effects };
}

describe("planHostEffectEnd", () => {
  it("cancels a Party Crasher and reconciles its bar without the phantom", () => {
    const e = effect({
      effectId: "pc",
      kind: "phantom_share",
      slug: "party-crasher",
      targetBarKey: "bar-7",
    });
    const result = planHostEffectEnd(stateOf([e]), "pc", NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.effectId).toBe("pc");
    expect(result.plan.cancelledAt).toBe(NOW);
    expect(result.plan.cancelReason).toBe("host");
    // The phantom bar is reconciled; no protection is released.
    expect(result.plan.reconcileBars).toEqual(["bar-7"]);
    expect(result.plan.releaseProtections).toEqual([]);
  });

  it("releases an attached Insurance and reconciles its attached bar", () => {
    const e = effect({
      effectId: "ins",
      kind: "score_protection",
      slug: "insurance",
      ownerTeamId: "team-a",
      attachedClaimId: "claim-1",
      attachedBarKey: "bar-3",
      protectedPoints: 6,
    });
    const result = planHostEffectEnd(stateOf([e]), "ins", NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The protection releases itself, then its attached bar reconciles so the
    // floor it enforced is removed.
    expect(result.plan.releaseProtections).toEqual(["ins"]);
    expect(result.plan.reconcileBars).toEqual(["bar-3"]);
    expect(result.plan.cancelReason).toBe("host");
  });

  it("falls back to the target bar for an unattached Insurance", () => {
    const e = effect({
      effectId: "ins",
      kind: "score_protection",
      slug: "insurance",
      ownerTeamId: "team-a",
      attachedClaimId: null,
      attachedBarKey: null,
      targetBarKey: "bar-9",
      protectedPoints: null,
    });
    const result = planHostEffectEnd(stateOf([e]), "ins", NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.releaseProtections).toEqual(["ins"]);
    expect(result.plan.reconcileBars).toEqual(["bar-9"]);
  });

  it("just cancels a Pioneer next_claim_restriction (no reconcile, no release)", () => {
    const e = effect({
      effectId: "pio",
      kind: "next_claim_restriction",
      slug: "pioneer",
      targetTeamId: "team-b",
      params: { rule: "pioneer" },
    });
    const result = planHostEffectEnd(stateOf([e]), "pio", NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Cancelling the row is enough for evaluateClaimBlocks / hasLegalNextBar to
    // stop applying it; nothing is scored (21.11).
    expect(result.plan.cancelledAt).toBe(NOW);
    expect(result.plan.cancelReason).toBe("host");
    expect(result.plan.reconcileBars).toEqual([]);
    expect(result.plan.releaseProtections).toEqual([]);
  });

  it("just cancels a Scenic Route next_claim_restriction", () => {
    const e = effect({
      effectId: "scn",
      kind: "next_claim_restriction",
      slug: "scenic-route",
      targetTeamId: "team-c",
      params: { rule: "scenic" },
    });
    const result = planHostEffectEnd(stateOf([e]), "scn", NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.reconcileBars).toEqual([]);
    expect(result.plan.releaseProtections).toEqual([]);
  });

  it("rejects an already-cancelled effect with already_resolved and writes nothing", () => {
    const e = effect({
      effectId: "pc",
      kind: "phantom_share",
      targetBarKey: "bar-7",
      cancelledAt: iso(BASE_MS - 30_000),
      cancelReason: "host",
    });
    const result = planHostEffectEnd(stateOf([e]), "pc", NOW);

    expect(result).toEqual({ ok: false, error: "already_resolved" });
  });

  it("rejects a consumed effect with already_resolved", () => {
    const e = effect({
      effectId: "ins",
      kind: "score_protection",
      consumedAt: iso(BASE_MS - 30_000),
    });
    const result = planHostEffectEnd(stateOf([e]), "ins", NOW);

    expect(result).toEqual({ ok: false, error: "already_resolved" });
  });

  it("rejects an effect already past its natural end with already_resolved", () => {
    const e = effect({
      effectId: "cd",
      kind: "bar_lock",
      slug: "crop-dusting",
      targetBarKey: "bar-2",
      startsAt: iso(BASE_MS - 20 * 60_000),
      endsAt: iso(BASE_MS - 60_000), // ended one minute ago
    });
    const result = planHostEffectEnd(stateOf([e]), "cd", NOW);

    expect(result).toEqual({ ok: false, error: "already_resolved" });
  });

  it("ends a still-running timed bar_lock with no score side effects", () => {
    const e = effect({
      effectId: "cd",
      kind: "bar_lock",
      slug: "crop-dusting",
      targetBarKey: "bar-2",
      startsAt: iso(BASE_MS - 60_000),
      endsAt: iso(BASE_MS + 14 * 60_000), // still active
    });
    const result = planHostEffectEnd(stateOf([e]), "cd", NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.cancelReason).toBe("host");
    expect(result.plan.reconcileBars).toEqual([]);
    expect(result.plan.releaseProtections).toEqual([]);
  });

  it("rejects an unknown effect id with not_found", () => {
    const result = planHostEffectEnd(stateOf([]), "missing", NOW);
    expect(result).toEqual({ ok: false, error: "not_found" });
  });
});
