import type { Role } from '@/lib/auth/rbac';

export type NavItem = { href: string; label: string };

/**
 * Prefixes a URL the framework will not rewrite for us.
 *
 * `basePath` is applied to `next/link`, `next/navigation` and every emitted
 * asset URL — but NOT to a string handed to `fetch`, nor to a plain `<a href>`
 * or `<img src>`. Those three are exactly where the portal reaches its own Route
 * Handlers, so on the VM, where the app is served under `/reconciliation`, an
 * unprefixed `/api/...` leaves this application entirely: `shared-nginx` has no
 * such location, the request falls through to the platform's landing SPA, and
 * the only symptom is that SPA's router logging `No routes matched location
 * /api/exports/<id>/download`. Nothing in this app's log at all.
 *
 * Read straight off `process.env` on every call rather than hoisted to a
 * constant: `NEXT_PUBLIC_` values are substituted textually into the client
 * bundle at build time, and only a direct property access is substituted.
 */
export function apiPath(path: string): string {
  return `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}${path}`;
}

/**
 * Sidebar navigation per role.
 *
 * Every href here must live under that role's own prefix — a link is only a
 * hint, the page behind it re-checks with requireRole, so a stray cross-role
 * entry would render a dead link that ends at /forbidden. tests/lib/nav.test.ts
 * asserts that structurally rather than by eyeballing the list.
 */
const NAV: Record<Role, readonly NavItem[]> = {
  admin: [
    { href: '/admin', label: 'Dashboard' },
    { href: '/admin/uploads', label: 'Uploads' },
    { href: '/admin/records', label: 'Records' },
    { href: '/admin/leads', label: 'Leads' },
    { href: '/admin/corrections', label: 'Corrections' },
    { href: '/admin/exports', label: 'Exports' },
    { href: '/admin/periods', label: 'Periods' },
    { href: '/admin/workflows', label: 'Approval chains' },
    // Hierarchy is reached by a tab on this screen rather than its own nav
    // entry: the two are halves of one question, and an account and a placement
    // are each useless without the other.
    { href: '/admin/users', label: 'People' },
    { href: '/admin/audit', label: 'Audit log' },
  ],
  sales: [
    { href: '/sales', label: 'Dashboard' },
    { href: '/sales/records', label: 'My records' },
    { href: '/sales/leads', label: 'My leads' },
    { href: '/sales/requests', label: 'My requests' },
  ],
  approver: [
    { href: '/approver', label: 'Dashboard' },
    { href: '/approver/queue', label: 'Approval queue' },
    { href: '/approver/history', label: 'History' },
  ],
  verifier: [
    { href: '/verifier', label: 'Dashboard' },
    { href: '/verifier/queue', label: 'Verification queue' },
    { href: '/verifier/history', label: 'History' },
  ],
  // "Raise a request" sits with the team rather than with the approvals: a
  // manager raising one is acting for their people, not deciding on them.
  tl: [
    { href: '/tl', label: 'Dashboard' },
    { href: '/tl/queue', label: 'My approvals' },
    { href: '/tl/team', label: 'My team' },
    { href: '/tl/requests/new', label: 'Raise a request' },
  ],
  acm: [
    { href: '/acm', label: 'Dashboard' },
    { href: '/acm/queue', label: 'My approvals' },
    { href: '/acm/team', label: 'My teams' },
    { href: '/acm/requests/new', label: 'Raise a request' },
  ],
};

export function navForRole(role: Role): NavItem[] {
  return NAV[role].map((item) => ({ ...item }));
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  sales: 'Sales',
  approver: 'Approver',
  verifier: 'Verifier',
  tl: 'Team leader',
  // "ACM" is what the business says; `manpower.ccm_id` is where it resolves from.
  // The label follows the people, not the column — see the 2026-08-06 spec §2.
  acm: 'Area manager',
};
