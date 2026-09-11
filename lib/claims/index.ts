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
