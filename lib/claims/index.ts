/**
 * Pure model of the claims uniqueness rule for the Beltline Bar Brawl v1 ruleset.
 *
 * A claim is identified by the triple (game_id, team_id, bar_id). The database
 * enforces this with a `unique (game_id, team_id, bar_id)` constraint on the
 * `claims` table (see `supabase/migrations/0002_claims.sql`), which encodes the
 * v1 "no re-claiming" rule: a team cannot claim the same bar twice within the
 * same game (Requirement 3.9).
 *
 * This module is a framework-free, deterministic model of that constraint so it
 * can be property-tested in isolation. The real database constraint is exercised
 * separately by the integration tests (Task 18). The model is intentionally
 * minimal: it records claim keys and reports whether each attempt is the first
 * occurrence (accepted) or a repeat (rejected), while guaranteeing the stored
 * count for any key never exceeds one.
 */

/** A claim's identity: a claim belongs to one game, one team, and one bar. */
export interface ClaimKey {
  readonly gameId: string;
  readonly teamId: string;
  readonly barId: string;
}

/** The outcome of attempting to record a claim. */
export type ClaimOutcome = "accepted" | "rejected";

/**
 * Serialize a {@link ClaimKey} into a canonical string usable as a map key.
 *
 * Components are joined with a NUL separator (a character that cannot appear in
 * a UUID) so distinct triples never collide — e.g. `("a", "b", "c")` and
 * `("ab", "", "c")` map to different keys.
 */
function serializeKey(key: ClaimKey): string {
  return `${key.gameId}\u0000${key.teamId}\u0000${key.barId}`;
}

/**
 * A pure, in-memory model of the unique-claim constraint.
 *
 * Records claim keys and mirrors the database's `unique (game_id, team_id,
 * bar_id)` behavior: the first attempt for a key is accepted and stored; any
 * subsequent attempt for the same key is rejected and does not change what is
 * stored. Consequently the stored count for any key is always exactly one once
 * it has been claimed, and zero before that.
 */
export class ClaimSet {
  private readonly counts = new Map<string, number>();

  /**
   * Attempt to record a claim for the given key.
   *
   * @returns `"accepted"` if this is the first claim for the key (the key is now
   *   stored with a count of exactly 1); `"rejected"` if the key was already
   *   claimed (the stored count is left unchanged at 1).
   */
  recordClaim(key: ClaimKey): ClaimOutcome {
    const serialized = serializeKey(key);

    if (this.counts.has(serialized)) {
      // Repeat claim: rejected, stored count stays exactly 1 (no re-claiming).
      return "rejected";
    }

    this.counts.set(serialized, 1);
    return "accepted";
  }

  /**
   * The number of stored claims for a key: 1 once claimed, 0 otherwise.
   *
   * By construction this never exceeds 1, which is the model's expression of the
   * "no duplicate claim" guarantee.
   */
  countFor(key: ClaimKey): number {
    return this.counts.get(serializeKey(key)) ?? 0;
  }

  /** Whether a claim for the given key has been recorded. */
  hasClaim(key: ClaimKey): boolean {
    return this.counts.has(serializeKey(key));
  }

  /** The number of distinct claim keys currently stored. */
  get size(): number {
    return this.counts.size;
  }
}

/**
 * Convenience free function mirroring {@link ClaimSet.recordClaim} for callers
 * that hold their own {@link ClaimSet}.
 */
export function recordClaim(claims: ClaimSet, key: ClaimKey): ClaimOutcome {
  return claims.recordClaim(key);
}

/** The result of evaluating the trusted claim-time eligibility attestation. */
export type ClaimEligibility =
  | {
      readonly eligible: true;
      readonly requiredDrinkCount: number;
    }
  | {
      readonly eligible: false;
      readonly reason:
        | "no_team_members"
        | "not_all_members_present"
        | "insufficient_finished_drinks";
      readonly requiredDrinkCount: number;
    };

/** Return the rounded-up half-team drink threshold. */
export function requiredDrinkCount(teamMemberCount: number): number {
  if (!Number.isInteger(teamMemberCount) || teamMemberCount < 0) {
    throw new RangeError(
      `teamMemberCount must be a non-negative integer, got ${teamMemberCount}`,
    );
  }
  return Math.ceil(teamMemberCount / 2);
}

/**
 * Evaluate the MVP honor-system claim attestation.
 *
 * The caller supplies the current assigned-member count, the number of members
 * attested to have finished a drink, and the all-present attestation. The
 * server remains responsible for deriving the member count from durable rows.
 */
export function evaluateClaimEligibility(input: {
  readonly teamMemberCount: number;
  readonly finishedDrinkCount: number;
  readonly allMembersPresent: boolean;
}): ClaimEligibility {
  const required = requiredDrinkCount(input.teamMemberCount);

  if (required === 0) {
    return {
      eligible: false,
      reason: "no_team_members",
      requiredDrinkCount: required,
    };
  }

  if (!input.allMembersPresent) {
    return {
      eligible: false,
      reason: "not_all_members_present",
      requiredDrinkCount: required,
    };
  }

  if (
    !Number.isInteger(input.finishedDrinkCount) ||
    input.finishedDrinkCount < required
  ) {
    return {
      eligible: false,
      reason: "insufficient_finished_drinks",
      requiredDrinkCount: required,
    };
  }

  return { eligible: true, requiredDrinkCount: required };
}

/** Result of changing the current active claim set. */
export type ActiveClaimOutcome =
  "accepted" | "already_active" | "revoked" | "not_active";

/**
 * Pure model of the active-claim partial unique index.
 *
 * Revocation removes a key from the active set but does not prevent a later
 * claim, matching the durable history plus partial unique index in migration
 * 0010.
 */
export class ActiveClaimSet {
  private readonly activeKeys = new Set<string>();

  recordClaim(key: ClaimKey): ActiveClaimOutcome {
    const serialized = serializeKey(key);
    if (this.activeKeys.has(serialized)) {
      return "already_active";
    }
    this.activeKeys.add(serialized);
    return "accepted";
  }

  revokeClaim(key: ClaimKey): ActiveClaimOutcome {
    const serialized = serializeKey(key);
    if (!this.activeKeys.delete(serialized)) {
      return "not_active";
    }
    return "revoked";
  }

  hasActiveClaim(key: ClaimKey): boolean {
    return this.activeKeys.has(serializeKey(key));
  }

  activeTeamIds(gameId: string, barId: string): string[] {
    const prefix = `${gameId}\u0000`;
    const suffix = `\u0000${barId}`;
    return [...this.activeKeys]
      .filter((key) => key.startsWith(prefix) && key.endsWith(suffix))
      .map((key) => key.slice(prefix.length, -suffix.length));
  }
}
