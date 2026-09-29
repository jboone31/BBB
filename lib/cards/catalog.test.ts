import { describe, expect, it } from "vitest";

import {
  CARD_CATALOG,
  CARD_CATALOG_MAP,
  CARD_SLUGS,
  createCardCatalog,
  getCardMetadata,
  type CardMetadata,
} from "./catalog";

describe("card catalog metadata", () => {
  it("contains every finalized v1 card exactly once", () => {
    expect(CARD_CATALOG).toHaveLength(23);
    expect(CARD_CATALOG_MAP.size).toBe(23);
    expect(new Set(CARD_CATALOG.map((card) => card.slug)).size).toBe(23);
    expect([...CARD_CATALOG_MAP.keys()]).toEqual([...CARD_SLUGS]);
  });

  it("expresses the distinct targeting modes and card inputs", () => {
    expect(getCardMetadata("go-piss-girl").targetMode).toBe("team");
    expect(getCardMetadata("crop-dusting").targetMode).toBe("bar");
    expect(getCardMetadata("insurance").targetMode).toBe("self");
    expect(getCardMetadata("power-hour").targetMode).toBe("none");
    expect(getCardMetadata("voted-off-the-island").targetMode).toBe(
      "team_and_bar",
    );
    expect(getCardMetadata("fairest-of-them-all").targetMode).toBe("reactive");
    expect(getCardMetadata("art-school-dropout").castingInput).toBe("colors");
    expect(getCardMetadata("bird-guide").castingInput).toBe("duration_seconds");
  });

  it("records timer and domain metadata needed by later phases", () => {
    expect(getCardMetadata("crop-dusting").timerSeconds).toBe(900);
    expect(getCardMetadata("happy-hour").timerSeconds).toBe(3600);
    expect(getCardMetadata("power-hour").timerSeconds).toBe(1200);
    expect(getCardMetadata("power-hour").affectedDomains).toContain(
      "inventory",
    );
    expect(getCardMetadata("insurance").affectedDomains).toContain("scores");
    expect(getCardMetadata("go-piss-girl").resolution).toBe(
      "manual_confirmation",
    );
  });

  it("rejects duplicate slugs", () => {
    const card = CARD_CATALOG[0];
    expect(() => createCardCatalog([card, card])).toThrow(
      `duplicate card slug: ${card.slug}`,
    );
  });

  it.each([
    ["non-positive timer", { timerSeconds: 0 }],
    ["fractional timer", { timerSeconds: 1.5 }],
    [
      "reactive mode without reactive flag",
      { targetMode: "reactive", reactive: false },
    ],
    [
      "reactive flag without reactive mode",
      { targetMode: "team", reactive: true },
    ],
    ["empty audiences", { audiences: [] }],
  ])("rejects %s", (_label, overrides) => {
    const invalid = {
      ...CARD_CATALOG[0],
      ...overrides,
    } as CardMetadata;
    expect(() => createCardCatalog([invalid])).toThrow();
  });
});
