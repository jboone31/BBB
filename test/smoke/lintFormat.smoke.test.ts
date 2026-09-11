import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 19.1 — Lint and format-check smoke checks.
 *
 * These smoke tests run the project's configured lint and format-check tools
 * as child processes and assert they exit cleanly:
 *
 *   * ESLint over the repo  -> exit code 0 (zero lint errors), mirrors `npm run lint`
 *   * Prettier `--check .`  -> exit code 0 (zero formatting violations), mirrors
 *     `npm run format:check`
 *
 * The tools are launched with the current Node binary (`process.execPath`)
 * against each package's resolved JS entry point. This is fully cross-platform
 * (no shell, no reliance on `npm`/`.cmd` shims) and avoids Node's DEP0190
 * warning about unescaped shell arguments. Running ESLint/Prettier over the
 * whole repo is comparatively heavy, so each case gets a generous per-test
 * timeout.
 *
 * Validates: Requirements 2.5, 2.6.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// test/smoke -> test -> project root
const PROJECT_ROOT = join(HERE, "..", "..");

const require = createRequire(import.meta.url);
// Resolve each tool's package directory so we can point Node at its CLI entry.
const ESLINT_BIN = join(
  dirname(require.resolve("eslint/package.json")),
  "bin",
  "eslint.js",
);
const PRETTIER_BIN = require.resolve("prettier/bin/prettier.cjs");

// ESLint/Prettier over the whole repo can take a while on a cold start; give
// each child process a wide margin under the per-test timeout.
const PROCESS_TIMEOUT_MS = 110_000;
const TEST_TIMEOUT_MS = 120_000;

function runTool(
  bin: string,
  args: string[],
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("lint and format-check smoke checks", () => {
  it(
    "reports zero lint errors (eslint .)",
    () => {
      const { status, stdout, stderr } = runTool(ESLINT_BIN, ["."]);
      expect(
        status,
        `Expected lint to exit 0.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      ).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports zero formatting violations (prettier --check .)",
    () => {
      const { status, stdout, stderr } = runTool(PRETTIER_BIN, [
        "--check",
        ".",
      ]);
      expect(
        status,
        `Expected format-check to exit 0.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      ).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
