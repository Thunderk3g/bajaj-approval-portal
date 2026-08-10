import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import './globals.css';

/**
 * IBM Plex, self-hosted through next/font.
 *
 * `next/font` downloads the files at build time and serves them from this
 * origin, which matters here beyond performance: the CSP in next.config.ts
 * allows `font-src 'self'` only, so a `<link>` to fonts.googleapis.com would be
 * blocked and every screen would silently fall back to the system stack.
 *
 * Plex Mono is not decoration. Apps_No, SM_ID, TL and CCM codes are identifiers
 * that get compared by eye down a column, and a proportional face makes
 * `ICCSP90766` and `ICCSP90765` look alike.
 */
const sans = IBM_Plex_Sans({
  variable: '--font-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Sales Data Review Portal',
  description:
    'Reconciliation of monthly sales data: imports, corrections and their approval chains.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable} antialiased`}>{children}</body>
    </html>
  );
}
