'use client';

import { createAuthClient } from 'better-auth/react';

/**
 * The auth client posts to the SAME ORIGIN the page was served from, never to a
 * host baked in at build time.
 *
 * `NEXT_PUBLIC_APP_URL` used to supply this and it was wrong twice over. Next
 * inlines every `NEXT_PUBLIC_` value at BUILD time, and the Dockerfile passes no
 * such build arg — so the published bundle carried the `http://localhost:3000`
 * fallback and every browser dutifully posted the login there, where it was
 * blocked by our own `connect-src 'self'` (next.config.ts). Setting the variable
 * in docker-compose could not have fixed it: by then the value is a string
 * constant in the JavaScript.
 *
 * Adding it as a build arg would only have moved the problem. The portal answers
 * on more than one hostname — the VM's `10.3.5.99` and the marketing domain in
 * front of it — and a bundle can only be baked with one of them. Anything other
 * than the origin the user actually typed is a cross-origin request that CSP
 * blocks. Reading it from `window` costs nothing and is right on all of them.
 *
 * `/api/auth` is spelled out rather than left to Better Auth's default. Its
 * `withPath()` (node_modules/better-auth/dist/utils/url.mjs) appends the default
 * ONLY when the base URL has no path of its own — and ours always does once
 * `basePath` is set. A bare `origin + basePath` would therefore resolve to
 * `/reconciliation/sign-in/email` and 404, which is the same silent-looking
 * failure in a different place.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// Better Auth parses this eagerly and throws on a URL with no protocol, so the
// server pass over this module needs a syntactically valid placeholder. Nothing
// is ever fetched through it: this client's requests all originate in a browser.
const origin = typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin;

export const authClient = createAuthClient({
  baseURL: `${origin}${basePath}/api/auth`,
});

export const { signIn, signOut, useSession } = authClient;
