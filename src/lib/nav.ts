import type { Role } from '@/lib/auth/rbac';

export type NavItem = { href: string; label: string };

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
    { href: '/admin/corrections', label: 'Corrections' },
    { href: '/admin/exports', label: 'Exports' },
    { href: '/admin/users', label: 'Users' },
    { href: '/admin/audit', label: 'Audit log' },
  ],
  sales: [
    { href: '/sales', label: 'Dashboard' },
    { href: '/sales/records', label: 'My records' },
    { href: '/sales/requests', label: 'My requests' },
  ],
  approver: [
    { href: '/approver', label: 'Dashboard' },
    { href: '/approver/queue', label: 'Pending queue' },
    { href: '/approver/history', label: 'History' },
  ],
};

export function navForRole(role: Role): NavItem[] {
  return NAV[role].map((item) => ({ ...item }));
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  sales: 'Sales',
  approver: 'Approver',
};
