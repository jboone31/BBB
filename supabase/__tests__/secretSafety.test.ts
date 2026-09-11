import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 19.5 — Secret-safety checks.
 *
 * Three independent, environment-free static checks over the committed repository:
 *
 *   1. (Req 7.1) `.gitignore` excludes every `.env*` file while explicitly keeping
 *      the committed `.env.example`. We assert this two ways: by parsing the
 *      `.gitignore` rules (a `.env*` ignore + a `!.env.example` negation), and —
 *      when git is available — by shelling out to `git check-ignore` to confirm
 *      real files (`.env`, `.env.local`) are ignored and `.env.example` is NOT.
 *   2. (Req 7.3) The Supabase service-role key stays server-only: no `'use client'`
 *      component and nothing under `components/` may reference
 *      `SUPABASE_SERVICE_ROLE_KEY`, and the server-only DB module opts into
 *      `import "server-only"`.
 *   3. (Req 7.4) A lightweight secret scan over tracked source files reports no
 *      findings against a small set of high-signal patterns.
 *
 * These are text/config assertions, so no live Supabase or Postgres is needed.
 *
 * Validates: Requirements 7.1, 7.3, 7.4.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// supabase/__tests__ -> supabase -> project root
const PROJECT_ROOT = join(HERE, "..", "..");

function readRepoFile(...parts: string[]): string {
  return readFileSync(join(PROJECT_ROOT, ...parts), "utf8");
}

/** Whether the `git` CLI is usable in this environment (optional stricter checks). */
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return true iff `git check-ignore <path>` reports the path as ignored.
 * `git check-ignore` exits 0 (ignored) or 1 (not ignored); other codes throw.
 */
function isGitIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--quiet", path], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true; // exit 0 -> ignored
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 1) {
      return false; // exit 1 -> not ignored
    }
    throw err; // any other failure is a real error
  }
}

// ---------------------------------------------------------------------------
// 1. (Req 7.1) .gitignore excludes .env* but keeps .env.example
// ---------------------------------------------------------------------------

describe("secret-safety: .gitignore env rules (Req 7.1)", () => {
  const gitignore = readRepoFile(".gitignore");
  const rules = gitignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  it("ignores all .env* files via a `.env*` rule", () => {
    expect(rules).toContain(".env*");
  });

  it("keeps the committed example via a `!.env.example` negation", () => {
    expect(rules).toContain("!.env.example");
  });

  it("orders the negation after the ignore rule so it takes effect", () => {
    const ignoreIdx = rules.indexOf(".env*");
    const negateIdx = rules.indexOf("!.env.example");
    expect(ignoreIdx).toBeGreaterThanOrEqual(0);
    expect(negateIdx).toBeGreaterThan(ignoreIdx);
  });

  it("does not ignore .env.example outright", () => {
    // A bare `.env.example` ignore rule (without the leading `!`) would drop the
    // committed template — guard against that regression.
    expect(rules).not.toContain(".env.example");
  });

  // Stronger, git-backed confirmation when the CLI is present. Skipped cleanly
  // in environments without git rather than failing.
  const git = gitAvailable();
  it.runIf(git)(
    "git treats real .env files as ignored and .env.example as tracked",
    () => {
      expect(isGitIgnored(".env")).toBe(true);
      expect(isGitIgnored(".env.local")).toBe(true);
      expect(isGitIgnored(".env.production")).toBe(true);
      expect(isGitIgnored(".env.example")).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// 2. (Req 7.3) Service-role key stays server-only
// ---------------------------------------------------------------------------

const SERVICE_ROLE_KEY_NAME = "SUPABASE_SERVICE_ROLE_KEY";

/** Directories to skip entirely when walking the repo for source files. */
const WALK_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".next",
  "out",
  "build",
  "v0",
  ".git",
  "coverage",
]);

/** Source extensions we scan for both the server-only and secret checks. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function hasSourceExtension(file: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext));
}

/** Recursively collect source files under `dir` (relative paths from root). */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (!WALK_EXCLUDE_DIRS.has(entry.name)) {
          walk(abs);
        }
      } else if (entry.isFile() && hasSourceExtension(entry.name)) {
        out.push(relative(PROJECT_ROOT, abs));
      }
    }
  };
  walk(join(PROJECT_ROOT, dir));
  return out;
}

/** A file is a client component iff it declares `"use client"` / `'use client'`. */
function isUseClientFile(relPath: string): boolean {
  const content = readFileSync(join(PROJECT_ROOT, relPath), "utf8");
  return /^\s*["']use client["'];?/m.test(content);
}

describe("secret-safety: service-role key stays server-only (Req 7.3)", () => {
  it("no file under components/ references the service-role key", () => {
    const offenders = collectSourceFiles("components").filter((rel) =>
      readFileSync(join(PROJECT_ROOT, rel), "utf8").includes(
        SERVICE_ROLE_KEY_NAME,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("no 'use client' file (app/, components/, lib/) references the service-role key", () => {
    const clientFiles = ["app", "components", "lib"]
      .flatMap((dir) => collectSourceFiles(dir))
      .filter(isUseClientFile);

    // Sanity: the demo view is a known client component, so the scan is finding
    // real client files rather than silently matching nothing.
    expect(
      clientFiles.some(
        (f) => f.split(sep).join("/") === "components/PropagationDemo.tsx",
      ),
    ).toBe(true);

    const offenders = clientFiles.filter((rel) =>
      readFileSync(join(PROJECT_ROOT, rel), "utf8").includes(
        SERVICE_ROLE_KEY_NAME,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("the browser Supabase adapter uses only NEXT_PUBLIC_* keys", () => {
    const adapter = readRepoFile("lib", "realtime", "supabaseBrowser.ts");
    // It reads the public URL + anon key...
    expect(adapter).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(adapter).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    // ...and never the service-role key.
    expect(adapter).not.toContain(SERVICE_ROLE_KEY_NAME);
  });

  it('the server-only DB module opts into `import "server-only"`', () => {
    const serverDb = readRepoFile("lib", "db", "server.ts");
    expect(serverDb).toMatch(/import\s+["']server-only["'];?/);
  });

  it("only the env definition and server-only/test modules may name the service-role key", () => {
    const files = ["app", "components", "lib"].flatMap((dir) =>
      collectSourceFiles(dir),
    );
    const referencing = files
      .filter((rel) =>
        readFileSync(join(PROJECT_ROOT, rel), "utf8").includes(
          SERVICE_ROLE_KEY_NAME,
        ),
      )
      .map((rel) => rel.split(sep).join("/"));

    for (const rel of referencing) {
      const allowed =
        rel === "lib/env/index.ts" || // the definition
        rel.endsWith(".test.ts") || // tests (e.g. env.property.test.ts)
        rel.endsWith(".test.tsx");
      expect(allowed, `unexpected service-role reference in ${rel}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. (Req 7.4) Lightweight secret scan — zero findings
// ---------------------------------------------------------------------------

/**
 * High-signal secret patterns. These are intentionally narrow to avoid false
 * positives on placeholder/example values and env-var *names*:
 *
 *   - privateKeyHeader: a PEM private-key block header, e.g.
 *     `-----BEGIN RSA PRIVATE KEY-----`. Extremely unlikely outside a real key.
 *   - supabaseServiceRoleJwt: a JWT (`eyJ...`) whose decoded payload contains the
 *     Supabase `"role":"service_role"` claim. We match a base64url JWT whose
 *     middle segment decodes to that claim, so an env-var *name* or placeholder
 *     never trips it.
 *   - awsAccessKeyId: an AWS access-key id (`AKIA` + 16 uppercase alphanumerics).
 *   - genericAssignedSecret: a long, high-entropy value assigned to an obviously
 *     secret-named variable in code (not `.env.example`, which is excluded), e.g.
 *     `serviceRoleKey = "abc...40+chars"`. Kept conservative (40+ chars, quoted).
 */
interface SecretPattern {
  readonly name: string;
  readonly test: (text: string) => boolean;
}

/** Decode a base64url segment to a UTF-8 string, or "" on failure. */
function decodeBase64Url(segment: string): string {
  try {
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "PEM private key header",
    test: (text) => /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text),
  },
  {
    name: "Supabase service_role JWT",
    test: (text) => {
      // JWT: three base64url segments separated by dots, first starts `eyJ`.
      const jwtRe = /\beyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\b/g;
      for (const m of text.matchAll(jwtRe)) {
        const payload = decodeBase64Url(m[1]);
        if (/["']role["']\s*:\s*["']service_role["']/.test(payload)) {
          return true;
        }
      }
      return false;
    },
  },
  {
    name: "AWS access key id",
    test: (text) => /\bAKIA[0-9A-Z]{16}\b/.test(text),
  },
  {
    name: "hardcoded high-entropy secret assignment",
    test: (text) =>
      // e.g. serviceRoleKey = "40+ char high-entropy quoted literal"
      /(?:service[_-]?role|secret|password|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9+/_-]{40,}["']/i.test(
        text,
      ),
  },
];

/**
 * Files/globs excluded from the secret scan. `.env*` is excluded (those are
 * git-ignored, not committed — and never contain real secrets in the repo), as
 * is the giant lockfile which contains long integrity hashes (not secrets).
 */
function isExcludedFromScan(relPath: string): boolean {
  const base = relPath.split(sep).pop() ?? relPath;
  if (base.startsWith(".env")) {
    return true;
  }
  if (
    base === "package-lock.json" ||
    base === "yarn.lock" ||
    base === "pnpm-lock.yaml"
  ) {
    return true;
  }
  // The scanner defines the secret patterns as literal strings/regexes, so it
  // would match itself. A scanner never scans its own rule definitions.
  if (base === "secretSafety.test.ts") {
    return true;
  }
  return false;
}

/** Collect all tracked source-ish files across the repo for the secret scan. */
function collectScanTargets(): string[] {
  const roots = ["app", "components", "lib", "supabase", "public"];
  const files: string[] = [];
  for (const root of roots) {
    files.push(...collectSourceFilesAnyText(root));
  }
  // Top-level config files worth scanning.
  for (const top of [
    "next.config.ts",
    "vitest.config.mts",
    "eslint.config.mjs",
    "instrumentation.ts",
    "package.json",
    "tsconfig.json",
  ]) {
    try {
      statSync(join(PROJECT_ROOT, top));
      files.push(top);
    } catch {
      // not present — skip
    }
  }
  return files.filter((rel) => !isExcludedFromScan(rel));
}

/** Like collectSourceFiles but includes json/sql/md/css text files too. */
function collectSourceFilesAnyText(dir: string): string[] {
  const textExts = [
    ...SOURCE_EXTENSIONS,
    ".json",
    ".sql",
    ".md",
    ".css",
    ".txt",
    ".env",
  ];
  const out: string[] = [];
  const walk = (absDir: string): void => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (!WALK_EXCLUDE_DIRS.has(entry.name)) {
          walk(abs);
        }
      } else if (
        entry.isFile() &&
        textExts.some((ext) => entry.name.endsWith(ext))
      ) {
        out.push(relative(PROJECT_ROOT, abs));
      }
    }
  };
  walk(join(PROJECT_ROOT, dir));
  return out;
}

describe("secret-safety: repository secret scan reports no findings (Req 7.4)", () => {
  const targets = collectScanTargets();

  it("scans a non-trivial set of committed source files", () => {
    // Guard against the walk silently matching nothing (which would make the
    // zero-findings assertion vacuous).
    expect(targets.length).toBeGreaterThan(5);
  });

  it("finds no high-signal secrets in any scanned file", () => {
    const findings: string[] = [];
    for (const rel of targets) {
      const content = readFileSync(join(PROJECT_ROOT, rel), "utf8");
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(content)) {
          findings.push(`${rel.split(sep).join("/")}: ${pattern.name}`);
        }
      }
    }
    expect(findings).toEqual([]);
  });
});
