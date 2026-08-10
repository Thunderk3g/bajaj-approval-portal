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

/**
 * The path shared-nginx routes to this app under, or '' for a root deployment.
 *
 * Set from the environment rather than hardcoded so the same image runs both
 * locally at `/` and on the VM at `/reconciliation`. It has to be a build-time
 * constant: Next bakes `basePath` into every emitted route and asset URL, so a
 * value read at runtime would produce a bundle whose links point somewhere the
 * server does not serve.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const nextConfig: NextConfig = {
  ...(basePath ? { basePath } : {}),
  /**
   * Emits `.next/standalone` — a self-contained server with only the modules it
   * actually reached, rather than the whole node_modules tree.
   *
   * This matters specifically on the VM: images are built where the SheetJS CDN
   * is reachable and then moved, because `cdn.sheetjs.com` is not on the
   * outbound whitelist. A smaller artefact is a smaller thing to move.
   */
  output: 'standalone',
  experimental: {
    serverActions: {
      /**
       * Transport ceiling for Server Action bodies. Next defaults to 1 MB,
       * which rejects the two flows this application exists for: the source
       * workbook is 9.14 MB (spec section 13) and a correction may carry five
       * 10 MB proof documents (section 4.4).
       *
       * Derived from the limits the application itself enforces, and it must
       * stay just above both — never below:
       *   - MAX_UPLOAD_BYTES        60 MB   src/lib/import/actions.ts
       *   - MAX_PROOF_BYTES × 5     50 MB   src/lib/storage/files.ts
       * 64 MB clears the larger of the two with room for multipart overhead.
       *
       * This is a ceiling, not the control. The size and magic-byte checks in
       * those two modules are what actually accept or refuse a file, and they
       * return a message naming the offending file and its size. A framework
       * limit set below them would pre-empt those checks with an opaque
       * failure the user cannot act on — which is exactly the bug this fixes.
       */
      bodySizeLimit: '64mb',
    },
    /**
     * Separate ceiling from serverActions.bodySizeLimit above, and just as real:
     * `src/middleware.ts` matches /admin/:path*, so every upload and proof POST
     * passes through it, and Next caps a body read there at 10 MB by default
     * regardless of the Server Action limit. Same 64 MB reasoning as above.
     */
    middlewareClientMaxBodySize: '64mb',
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
