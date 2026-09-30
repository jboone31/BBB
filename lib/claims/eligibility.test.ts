import { describe, expect, it } from "vitest";

import {
  ActiveClaimSet,
  evaluateClaimEligibility,
  requiredDrinkCount,
} from "./index";

describe("claim eligibility and active lifecycle", () => {
  it.each([
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 3],
  ])("rounds the half-team threshold for %i members", (members, required) => {
    expect(requiredDrinkCount(members)).toBe(required);
  });

  it("requires all members present and the rounded-up drink threshold", () => {
    expect(
      evaluateClaimEligibility({
        teamMemberCount: 3,
        finishedDrinkCount: 1,
        allMembersPresent: true,
      }),
    ).toMatchObject({
      eligible: false,
      reason: "insufficient_finished_drinks",
    });
    expect(
      evaluateClaimEligibility({
        teamMemberCount: 3,
        finishedDrinkCount: 2,
        allMembersPresent: false,
      }),
    ).toMatchObject({ eligible: false, reason: "not_all_members_present" });
    expect(
      evaluateClaimEligibility({
        teamMemberCount: 3,
        finishedDrinkCount: 2,
        allMembersPresent: true,
      }),
    ).toMatchObject({ eligible: true, requiredDrinkCount: 2 });
  });

  it("supports revoke and later reclaim while rejecting duplicate active claims", () => {
    const claims = new ActiveClaimSet();
    const key = { gameId: "g1", teamId: "t1", barId: "b1" };

    expect(claims.recordClaim(key)).toBe("accepted");
    expect(claims.recordClaim(key)).toBe("already_active");
    expect(claims.revokeClaim(key)).toBe("revoked");
    expect(claims.revokeClaim(key)).toBe("not_active");
    expect(claims.recordClaim(key)).toBe("accepted");
    expect(claims.activeTeamIds("g1", "b1")).toEqual(["t1"]);
  });
});
