import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { FIRST_SEQ, nextSeq } from "@/lib/events";

/**
 * Reference-only suite for lobby correctness Property 19 (task 19.3).
 *
 * Property 19 — Gap-free contiguous per-game sequence under serialization — is
 * stated by the lobby design as *reusing* the foundation's sequence-assignment
 * logic that is already property-tested. Every lobby route appends its single
 * event through the foundation `appendEvent` seam, which assigns each per-game
 * `seq` under a per-game `FOR UPDATE` lock (`max(seq)+1`), so the lobby layer
 * inherits the contiguous, gap-free, duplicate-free sequence guarantee verbatim
 * rather than re-deriving it. The design explicitly directs that this property
 * is NOT re-implemented here.
 *
 * This file exists so the reuse is discoverable from `lib/lobby/`: it names the
 * reused function, points at the authoritative foundation suite by exact path,
 * and confirms the import resolves (a broken re-export would fail
 * typecheck/compile here). It also asserts the cited suite still exists, so this
 * reference fails loudly if the foundation suite is renamed or moved rather than
 * silently going stale. The exhaustive coverage lives in the cited foundation
 * suite.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Property 19 — Gap-free contiguous per-game sequence under serialization
 *   Validates: Requirements 6.6
 *   Reused function: `nextSeq` (with `FIRST_SEQ`) from `lib/events`, applied by
 *   `appendEvent` under the per-game `FOR UPDATE` lock.
 *   Authoritative property suite:
 *     lib/events/seq.property.test.ts
 *       ("nextSeq — Per-game sequence is contiguous, gap-free, and matches
 *        write order (Property 7)", web-app-foundation Property 7 / Req 4.5)
 *   The lobby routes (design §Components 3) append every lobby change through
 *   `appendEvent` verbatim; the contiguous/gap-free `seq` rule under
 *   serialization (including concurrent appends and rollbacks) is proven there.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Validates: Requirements 6.6
 */

/** Repo root, two levels up from lib/lobby/. */
const REPO_ROOT = resolve(__dirname, "..", "..");

/** The reused foundation suite for the gap-free per-game sequence. */
const REUSED_SEQUENCE_SUITE = "lib/events/seq.property.test.ts";

describe("lib/lobby — reused foundation sequence suite (Property 19)", () => {
  it("Property 19: reuses lib/events/seq.property.test.ts — nextSeq is imported, not re-implemented", () => {
    // Not a re-test of the property (that lives in the cited foundation suite);
    // just a smoke assertion that the reused symbols resolve so the reference
    // stays honest if the foundation export ever changes shape.
    expect(typeof nextSeq).toBe("function");
    expect(FIRST_SEQ).toBe(1);
  });

  it("Property 19: cited foundation suite still exists (fails loudly if it moves)", () => {
    expect(existsSync(resolve(REPO_ROOT, REUSED_SEQUENCE_SUITE))).toBe(true);
  });
});
