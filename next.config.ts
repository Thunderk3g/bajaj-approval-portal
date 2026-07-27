import type { NextConfig } from 'next';

/**
 * Baseline browser-side hardening, applied to every response.
 *
 * 'unsafe-inline' is present for scripts because Next.js inlines its bootstrap
 * and flight payload; removing it requires per-request nonces threaded through
 * middleware, which is a separate change. Everything else is locked down:
 * no framing, no plugins, no cross-origin form posts, no third-party origins
 * for scripts, styles, fonts or XHR.
 *
 * 'unsafe-eval' is added for the dev server ONLY: Next's React Refresh / HMR
 * runtime compiles modules with eval(), which the strict policy forbids, so the
 * client bundle throws on load. The production header never carries it — the
 * ternary below keeps that guarantee in one place rather than trusting a build
 * step to strip it out.
 */
const isDev = process.env.NODE_ENV === 'development';

const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Content-Security-Policy', value: CSP },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
