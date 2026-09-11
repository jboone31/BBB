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
