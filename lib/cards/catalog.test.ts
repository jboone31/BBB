import { describe, expect, it } from "vitest";

import {
  CARD_CATALOG,
  CARD_CATALOG_MAP,
  CARD_SLUGS,
  CARD_TEXT_MAP,
  createCardCatalog,
  getCardMetadata,
  getCardText,
  isGatedCard,
  isMirrorableCard,
  type CardMetadata,
  type CardSlug,
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

describe("card text (card-behavior Task 1) — new CardText shape", () => {
  it("provides a non-empty effect and target note for every catalog slug", () => {
    expect(CARD_TEXT_MAP.size).toBe(CARD_SLUGS.length);
    for (const slug of CARD_SLUGS) {
      const text = getCardText(slug);
      expect(text.effect.trim().length).toBeGreaterThan(0);
      expect(text.targetNote.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives team-targeting cards a target toast body", () => {
    // Every card whose metadata targets a team must address that team in the
    // second person (createCardText enforces this at module load).
    for (const slug of CARD_SLUGS) {
      if (getCardMetadata(slug).targetMode === "team") {
        expect(getCardText(slug).targetToastBody).not.toBeNull();
      }
    }
    expect(getCardText("go-piss-girl").targetToastBody).not.toBeNull();
  });

  it("gives cards that take a casting input a Requires line", () => {
    // Cards whose play requires the caster to provide/do something.
    expect(getCardText("art-school-dropout").requires).not.toBeNull();
    expect(getCardText("bird-guide").requires).not.toBeNull();
    expect(getCardText("different-tastes").requires).not.toBeNull();
    // A bare team challenge with no casting input has no Requires line.
    expect(getCardText("go-piss-girl").requires).toBeNull();
  });

  it("leaves self/economy cards with no team target toast body", () => {
    for (const slug of [
      "insurance",
      "patient-investor",
      "power-hour",
    ] as const) {
      expect(getCardText(slug).targetToastBody).toBeNull();
    }
  });

  it("throws for an unknown slug", () => {
    expect(() => getCardText("not-a-card" as never)).toThrow(
      /unknown card slug/,
    );
  });
});

describe("derived card families (card-behavior R1.5, R1.6, R1.7)", () => {
  // The Gated_Card list taken verbatim from the requirements Glossary.
  const GLOSSARY_GATED: ReadonlySet<CardSlug> = new Set([
    "go-piss-girl",
    "moneybags",
    "wired",
    "art-school-dropout",
    "broad-shoulders",
    "bird-guide",
    "interested-buyer",
    "different-tastes",
    "everyones-a-critic",
    "spin-cycle",
    "dirty-bird",
    "use-it-or-lose-it",
  ]);

  it("derives the Gated_Card set equal to the Glossary list", () => {
    const derived = new Set(
      CARD_CATALOG.filter(isGatedCard).map((card) => card.slug),
    );
    expect([...derived].sort()).toEqual([...GLOSSARY_GATED].sort());
  });

  it("derives the Mirrorable set as Gated plus Pioneer and Scenic Route", () => {
    const expected = new Set<CardSlug>([
      ...GLOSSARY_GATED,
      "pioneer",
      "scenic-route",
    ]);
    const derived = new Set(
      CARD_CATALOG.filter(isMirrorableCard).map((card) => card.slug),
    );
    expect([...derived].sort()).toEqual([...expected].sort());
  });

  it("keeps Pioneer and Scenic Route mirrorable but not gated", () => {
    for (const slug of ["pioneer", "scenic-route"] as const) {
      const meta = getCardMetadata(slug);
      expect(isGatedCard(meta)).toBe(false);
      expect(isMirrorableCard(meta)).toBe(true);
    }
  });
});
