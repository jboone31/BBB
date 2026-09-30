import { describe, expect, it } from "vitest";

import { computeShareAdjustments } from "./index";

describe("score ledger share adjustments", () => {
  it("awards 12 to the first scoring claimant", () => {
    expect(
      computeShareAdjustments({
        barKind: "scoring",
        previousClaimingTeamIds: [],
        nextClaimingTeamIds: ["t1"],
      }),
    ).toEqual([{ teamId: "t1", points: 12, category: "bar_share" }]);
  });

  it("corrects existing shares when a second team claims", () => {
    expect(
      computeShareAdjustments({
        barKind: "scoring",
        previousClaimingTeamIds: ["t1"],
        nextClaimingTeamIds: ["t1", "t2"],
      }),
    ).toEqual([
      { teamId: "t1", points: -6, category: "bar_share_correction" },
      { teamId: "t2", points: 6, category: "bar_share_correction" },
    ]);
  });

  it("reverses the active allocation when a team unclaims", () => {
    expect(
      computeShareAdjustments({
        barKind: "scoring",
        previousClaimingTeamIds: ["t1", "t2"],
        nextClaimingTeamIds: ["t1"],
      }),
    ).toEqual([
      { teamId: "t1", points: 6, category: "bar_share_correction" },
      { teamId: "t2", points: -6, category: "bar_share_correction" },
    ]);
  });

  it("keeps start bars at zero and finish bars solo", () => {
    expect(
      computeShareAdjustments({
        barKind: "start",
        previousClaimingTeamIds: [],
        nextClaimingTeamIds: ["t1"],
      }),
    ).toEqual([]);
    expect(
      computeShareAdjustments({
        barKind: "finish",
        previousClaimingTeamIds: [],
        nextClaimingTeamIds: ["t2"],
      }),
    ).toEqual([{ teamId: "t2", points: 12, category: "finish_award" }]);
  });
});
