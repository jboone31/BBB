import type { NextConfig } from "next";

/**
 * Next.js configuration for the BBB web application.
 *
 * The app runs on the Node.js runtime and is deployed to Vercel (the locked
 * hosting target from the Hosting_Decision_Record). Server routes that perform
 * Game_State_Change mutations use the Node.js runtime so they can hold the
 * server-only Supabase service-role key and run inside a single transaction.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Allow cross-origin access to dev resources (the client JS/HMR bundle) from
  // other devices on the LAN during `next dev` — e.g. testing the join flow on a
  // phone at http://<lan-ip>:3000. Without this, Next.js blocks the dev bundle
  // cross-origin, the client never hydrates, and forms fall back to a native GET
  // submission (you land back on `/?joinCode=…` instead of the lobby). Dev-only;
  // has no effect on the production build.
  allowedDevOrigins: ["192.168.86.226"],
};

export default nextConfig;
