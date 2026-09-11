import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 20.3 — structure.md consistency check.
 *
 * Requirement 2.3 demands *bidirectional* consistency between the
 * `.kiro/steering/structure.md` "Top-Level Layout" section and the real repo
 * layout:
 *
 *   (a) every directory named in structure.md's top-level layout must exist as
 *       a real directory in the repo, and
 *   (b) every actual top-level *source* directory in the repo must be listed in
 *       structure.md.
 *
 * This test parses the documented layout, enumerates the real top-level
 * directories (minus a small, explicit exclusion set of generated/tooling
 * dirs), and asserts the two sets match, with failure messages that name the
 * offending directories.
 *
 * Validates: Requirements 2.3.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// test/smoke -> test -> project root
const PROJECT_ROOT = join(HERE, "..", "..");
const STRUCTURE_MD = join(PROJECT_ROOT, ".kiro", "steering", "structure.md");

/**
 * Directories that live at the repo root but are NOT source directories and so
 * are intentionally never documented in structure.md's top-level layout:
 *
 *   - .git          version-control internals
 *   - .next         Next.js build output
 *   - node_modules  installed dependencies
 *   - out / build   build/export output
 *   - coverage      test-coverage reports
 *
 * `.kiro` is deliberately NOT excluded: it IS a documented top-level entry
 * (steering, specs, hooks), so it participates in the consistency check.
 *
 * Keep this set explicit so the check stays maintainable: if a new
 * generated/tooling directory appears at the root, add it here rather than
 * loosening the assertions.
 */
const EXCLUDED_DIRS = new Set([
  ".git",
  ".next",
  "node_modules",
  "out",
  "build",
  "coverage",
]);

/**
 * Parse the "Top-Level Layout" section of structure.md and return the set of
 * documented top-level directory names (without the trailing slash).
 *
 * The section is a fenced code block whose first line is the repo name
 * (`BBB/`) followed by two-space-indented `name/  # comment` entries, e.g.:
 *
 *   ```
 *   BBB/
 *     app/              # Next.js App Router: pages, layout, API routes
 *     .kiro/            # steering, specs, hooks
 *   ```
 *
 * We isolate that first fenced block under the "## Top-Level Layout" heading,
 * then pull the indented `name/` tokens, ignoring the root `BBB/` line.
 */
function parseDocumentedTopLevelDirs(markdown: string): Set<string> {
  const headingIndex = markdown.indexOf("## Top-Level Layout");
  if (headingIndex === -1) {
    throw new Error(
      'structure.md is missing the "## Top-Level Layout" section required by Req 2.3.',
    );
  }

  const afterHeading = markdown.slice(headingIndex);
  // Grab the first fenced code block after the heading.
  const fenceMatch = afterHeading.match(/```[^\n]*\n([\s\S]*?)```/);
  if (!fenceMatch) {
    throw new Error(
      'structure.md "Top-Level Layout" section has no fenced code block to parse.',
    );
  }

  const block = fenceMatch[1];
  const dirs = new Set<string>();
  for (const rawLine of block.split("\n")) {
    // Strip inline comments and surrounding whitespace.
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    // A directory entry ends in a slash, e.g. "app/" or ".kiro/".
    if (!line.endsWith("/")) continue;
    const name = line.slice(0, -1);
    // Skip the repo-root line itself (e.g. "BBB").
    if (name === "BBB") continue;
    // Only top-level entries: nested paths would contain a slash.
    if (name.includes("/")) continue;
    dirs.add(name);
  }

  if (dirs.size === 0) {
    throw new Error(
      "Parsed zero documented top-level directories from structure.md; the parser or the doc format may have drifted.",
    );
  }

  return dirs;
}

/** Enumerate real top-level directories in the repo, minus the exclusion set. */
async function actualTopLevelSourceDirs(): Promise<Set<string>> {
  const entries = await readdir(PROJECT_ROOT, { withFileTypes: true });
  const dirs = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    dirs.add(entry.name);
  }
  return dirs;
}

describe("structure.md top-level layout consistency (Req 2.3)", () => {
  const documented = parseDocumentedTopLevelDirs(
    readFileSync(STRUCTURE_MD, "utf8"),
  );

  it("documents at least the known foundation directories", () => {
    // Sanity check that parsing produced the expected core entries.
    for (const expected of ["app", "components", "lib", "supabase", "public"]) {
      expect(
        documented.has(expected),
        `Expected structure.md to document "${expected}/". Parsed set: ${[...documented].sort().join(", ")}`,
      ).toBe(true);
    }
  });

  it("every directory documented in structure.md exists in the repo", async () => {
    const actual = await actualTopLevelSourceDirs();
    const documentedButMissing = [...documented].filter(
      (name) => !actual.has(name),
    );
    expect(
      documentedButMissing,
      `structure.md documents directories that do not exist at the repo root: ${documentedButMissing.join(", ")}`,
    ).toEqual([]);
  });

  it("every actual top-level source directory is listed in structure.md", async () => {
    const actual = await actualTopLevelSourceDirs();
    const presentButUndocumented = [...actual].filter(
      (name) => !documented.has(name),
    );
    expect(
      presentButUndocumented,
      `Top-level source directories exist in the repo but are not documented in structure.md: ${presentButUndocumented.join(", ")}. ` +
        `Either document them under "## Top-Level Layout" or add them to EXCLUDED_DIRS if they are generated/tooling dirs.`,
    ).toEqual([]);
  });
});
