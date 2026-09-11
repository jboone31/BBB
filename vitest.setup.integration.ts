/**
 * Vitest setup for LIVE integration runs.
 *
 * The integration suites under `supabase/__tests__/integration/` gate on real
 * Supabase credentials read from `process.env` (SUPABASE_DB_URL,
 * NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY). Unlike Next.js, Vitest does NOT auto-load
 * `.env.local`, so without this the vars are undefined and every integration
 * suite silently skips.
 *
 * This file is wired in ONLY for the `test:integration` script (see
 * package.json), so the default `npm test` run stays hermetic and offline. It
 * loads `.env.local` from the project root; existing `process.env` values win
 * (`override: false`) so CI-provided env is respected.
 */
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local", override: false });
