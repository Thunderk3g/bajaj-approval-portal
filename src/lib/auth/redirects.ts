import type { Role } from './rbac';

/**
 * The single source of truth for which URL space belongs to which role.
 *
 * Everything that answers "where does this user go?" or "who owns this path?"
 * derives from this map, so a new role or a moved section cannot drift between
 * the navigation, the guards and the post-login redirect.
 */
export const ROLE_PREFIXES: Record<Role, string> = {
  admin: '/admin',
  sales: '/sales',
  approver: '/approver',
};

/** Landing page for a role immediately after sign-in. */
export function dashboardPathForRole(role: Role): string {
  return ROLE_PREFIXES[role];
}

/**
 * Which role owns `pathname`, or null if the path is outside every role space.
 *
 * The match is deliberately NOT a bare `startsWith`: `/administration` starts
 * with `/admin` and `/salesforce` starts with `/sales`, so a naive prefix test
 * would hand unrelated routes to the wrong role. A prefix only matches on an
 * exact path or on a `/`-delimited segment boundary.
 */
export function roleForPath(pathname: string): Role | null {
  if (!pathname.startsWith('/')) return null;

  // Ignore anything after the path itself; a query or fragment must not be
  // able to smuggle a segment boundary into the comparison.
  const path = pathname.split(/[?#]/, 1)[0];

  for (const role of Object.keys(ROLE_PREFIXES) as Role[]) {
    const prefix = ROLE_PREFIXES[role];
    if (path === prefix || path.startsWith(`${prefix}/`)) return role;
  }
  return null;
}

/**
 * Sanitises a `?next=` value before it is used as a redirect target.
 *
 * Only same-origin, path-absolute values survive. Anything else — an absolute
 * URL, a protocol-relative `//host`, a backslash variant that some clients
 * normalise to `//` — is discarded, so a crafted login link cannot bounce a
 * freshly authenticated user onto an attacker's page.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith('/')) return null;
  if (next.startsWith('//') || next.startsWith('/\\')) return null;
  return next;
}
