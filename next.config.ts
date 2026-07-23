import type { NextConfig } from 'next';

/**
 * Baseline browser-side hardening, applied to every response.
 *
 * 'unsafe-inline' is present for scripts because Next.js inlines its bootstrap
 * and flight payload; removing it requires per-request nonces threaded through
 * middleware, which is a separate change. Everything else is locked down:
 * no framing, no plugins, no cross-origin form posts, no third-party origins
 * for scripts, styles, fonts or XHR.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
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
