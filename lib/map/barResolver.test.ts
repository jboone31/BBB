import { beforeEach, describe, expect, it } from "vitest";

import type { QueryRunner, SqlRow } from "@/lib/events";
import { CANDIDATE_BARS, slug } from "@/lib/map/bars";

import { resolveGameBar, type ResolvedBar } from "./barResolver";

/**
 * A tiny in-memory stand-in for the `games` + `bars` tables wired to the same
 * SQL shapes `barResolver` issues. It keeps `npm test` hermetic (no live
 * Supabase) while exercising real matching and the materialize-on-first-touch
 * insert.
 */
interface FakeBarRow {
  id: string;
  name: string;
  location: string | null;
}

class FakeDb implements QueryRunner {
  private nextId = 1;

  constructor(
    private readonly game: {
      exists: boolean;
      startBarId: string | null;
      finishBarId: string | null;
    },
    private readonly bars: FakeBarRow[],
  ) {}

  insertedBars(): readonly FakeBarRow[] {
    return this.bars;
  }

  async query(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: SqlRow[] }> {
    const text = sql.toLowerCase().trim();

    if (text.startsWith("select start_bar_id, finish_bar_id")) {
      if (!this.game.exists) return { rows: [] };
      return {
        rows: [
          {
            start_bar_id: this.game.startBarId,
            finish_bar_id: this.game.finishBarId,
          },
        ],
      };
    }

    if (
      text.startsWith("select id, name, location") &&
      text.includes("from bars")
    ) {
      return { rows: this.bars.map((bar) => ({ ...bar })) };
    }

    if (text.startsWith("insert into bars")) {
      const row: FakeBarRow = {
        id: `inserted-${this.nextId++}`,
        name: String(params[1]),
        location: params[2] == null ? null : String(params[2]),
      };
      this.bars.push(row);
      return { rows: [{ ...row }] };
    }

    return { rows: [] };
  }
}

const GAME_ID = "game-1";

describe("resolveGameBar", () => {
  let parkTavern: (typeof CANDIDATE_BARS)[number];

  beforeEach(() => {
    parkTavern = CANDIDATE_BARS[0];
  });

  it("matches an existing bar by uuid and parses its stored location", async () => {
    const db = new FakeDb(
      { exists: true, startBarId: null, finishBarId: null },
      [{ id: "bar-uuid-1", name: "Some Bar", location: "33.5,-84.2" }],
    );

    const resolved = await resolveGameBar(db, GAME_ID, "bar-uuid-1");

    expect(resolved).toEqual<ResolvedBar>({
      barId: "bar-uuid-1",
      barKey: "bar-uuid-1", // not a candidate name -> key is the uuid
      name: "Some Bar",
      coords: { lat: 33.5, lng: -84.2 },
      kind: "scoring",
    });
  });

  it("matches an existing bar by candidate slug and keys it by slug", async () => {
    const db = new FakeDb(
      { exists: true, startBarId: null, finishBarId: null },
      [{ id: "bar-uuid-2", name: parkTavern.name, location: null }],
    );

    const resolved = await resolveGameBar(db, GAME_ID, parkTavern.id);

    expect(resolved?.barId).toBe("bar-uuid-2");
    expect(resolved?.barKey).toBe(parkTavern.id);
    expect(resolved?.name).toBe(parkTavern.name);
    // location is null, so coords fall back to the candidate catalog.
    expect(resolved?.coords).toEqual({
      lat: parkTavern.lat,
      lng: parkTavern.lng,
    });
  });

  it("classifies start and finish bars by the game's designations", async () => {
    const db = new FakeDb(
      { exists: true, startBarId: "bar-start", finishBarId: "bar-finish" },
      [
        { id: "bar-start", name: "Start", location: null },
        { id: "bar-finish", name: "Finish", location: null },
      ],
    );

    expect((await resolveGameBar(db, GAME_ID, "bar-start"))?.kind).toBe(
      "start",
    );
    expect((await resolveGameBar(db, GAME_ID, "bar-finish"))?.kind).toBe(
      "finish",
    );
  });

  it("materializes a candidate bar on first touch and returns its row", async () => {
    const db = new FakeDb(
      { exists: true, startBarId: null, finishBarId: null },
      [],
    );

    const resolved = await resolveGameBar(db, GAME_ID, parkTavern.id);

    expect(resolved?.barKey).toBe(parkTavern.id);
    expect(resolved?.name).toBe(parkTavern.name);
    expect(resolved?.coords).toEqual({
      lat: parkTavern.lat,
      lng: parkTavern.lng,
    });
    expect(resolved?.kind).toBe("scoring");
    // A row was inserted with the "lat,lng" location string.
    const inserted = db.insertedBars();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].name).toBe(parkTavern.name);
    expect(inserted[0].location).toBe(`${parkTavern.lat},${parkTavern.lng}`);
  });

  it("returns null for a key that is neither an existing bar nor a candidate", async () => {
    const db = new FakeDb(
      { exists: true, startBarId: null, finishBarId: null },
      [{ id: "bar-uuid-3", name: "Other", location: null }],
    );

    expect(await resolveGameBar(db, GAME_ID, "not-a-real-bar")).toBeNull();
    // Nothing was materialized for an unknown key.
    expect(db.insertedBars()).toHaveLength(1);
  });

  it("returns null when the game does not exist", async () => {
    const db = new FakeDb(
      { exists: false, startBarId: null, finishBarId: null },
      [],
    );

    expect(await resolveGameBar(db, GAME_ID, parkTavern.id)).toBeNull();
  });

  it("prefers the stored location over the candidate catalog", async () => {
    const db = new FakeDb(
      { exists: true, startBarId: null, finishBarId: null },
      [{ id: "bar-uuid-4", name: parkTavern.name, location: "1,2" }],
    );

    const resolved = await resolveGameBar(db, GAME_ID, parkTavern.id);

    expect(resolved?.coords).toEqual({ lat: 1, lng: 2 });
  });

  it("yields null coords when neither location nor catalog resolves", async () => {
    const db = new FakeDb(
      { exists: true, startBarId: null, finishBarId: null },
      [{ id: "bar-uuid-5", name: "Nowhere Bar", location: "garbage" }],
    );

    const resolved = await resolveGameBar(db, GAME_ID, "bar-uuid-5");

    expect(resolved?.coords).toBeNull();
  });

  it("every candidate slug round-trips through slug(name)", () => {
    // Guards the barKey contract: a materialized candidate always keys back to
    // its map slug.
    for (const bar of CANDIDATE_BARS) {
      expect(slug(bar.name)).toBe(bar.id);
    }
  });
});
