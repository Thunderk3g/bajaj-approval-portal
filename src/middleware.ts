import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

/**
 * SECURITY: this middleware is NOT the authorization boundary.
 *
 * It performs an OPTIMISTIC cookie-presence check only — no session lookup, no
 * signature verification, no role check — purely so a signed-out visitor lands
 * on the login page instead of a flash of shell. A forged or expired cookie
 * gets past it by design.
 *
 * Every protected page re-checks the real session server-side via requireRole()
 * against the database, and that check is what actually grants access. Never
 * move an authorization decision into this file: middleware cannot see the
 * user's role or active flag from a cookie alone.
 */
export function middleware(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);

  if (!sessionCookie) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/sales/:path*', '/approver/:path*'],
};
