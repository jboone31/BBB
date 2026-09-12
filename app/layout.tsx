import type { Metadata, Viewport } from "next";
import HeaderNav from "@/components/shell/HeaderNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Beltline Bar Brawl",
  description:
    "The Beltline Bar Brawl — a competitive team bar-crawl game along the Atlanta Beltline.",
};

// Mobile-first: lock the layout viewport to the device width so content fits
// 320–375px screens without horizontal scrolling (Requirement 2.11).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <HeaderNav />
        {children}
      </body>
    </html>
  );
}
