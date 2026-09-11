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
};

export default nextConfig;
