import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

/**
 * IBM Plex is the right voice here: it was drawn for enterprise and technical
 * documents, it reads as institutional rather than startup, and the Sans and
 * Mono are designed as siblings — so a money column set in Mono sits on the
 * same rhythm as the Sans label above it.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ITC Guard — know what your GST credit is really worth",
  description:
    "Reconciles your purchase register against GSTR-2B, prices the input tax credit genuinely at risk, and tells your AP desk who to pay and who to hold.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Never disable zoom — finance staff read dense numeric tables and many of
  // them pinch to enlarge.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
