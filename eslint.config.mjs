import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

/**
 * ESLint flat config for the BBB web application (Requirements 2.4, 2.5).
 *
 * - `eslint-config-next/core-web-vitals`: Next.js + React + React Hooks rules,
 *   with Core Web Vitals rules escalated to errors.
 * - `eslint-config-next/typescript`: TypeScript-specific rules from
 *   typescript-eslint.
 * - `eslint-config-prettier/flat`: turns off ESLint rules that conflict with
 *   Prettier so formatting is owned solely by Prettier (Requirement 2.6).
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  // `lib/**` is framework-free domain logic (game rules, scoring, data access)
  // with no React. The `react-hooks` rules treat any `use*`-prefixed call as a
  // React Hook, but functions like `useItOrLoseItShouldComplete` are pure,
  // design-mandated domain helpers (not hooks), so those rules do not apply
  // here. Disable them for this glob only.
  {
    files: ["lib/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/exhaustive-deps": "off",
      // Allow intentionally-unused args that are part of a design-required
      // signature when they are underscore-prefixed (e.g. `_now`).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Override default ignores of eslint-config-next and skip non-source dirs.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "node_modules/**",
    "v0/**",
  ]),
]);

export default eslintConfig;
