import { describe, it, expect } from 'vitest';
import type { Role } from '@/lib/auth/rbac';
import { navForRole } from '@/lib/nav';
import { ROLE_PREFIXES, dashboardPathForRole, roleForPath } from '@/lib/auth/redirects';

// Derived from the role map rather than hand-listed. A hand-written list goes
// stale the moment a role is added — every loop below keeps passing while
// silently never exercising the new role's menu.
const ROLES = Object.keys(ROLE_PREFIXES) as Role[];

describe('navForRole', () => {
  it('gives every role a non-empty menu', () => {
    for (const role of ROLES) {
      expect(navForRole(role).length).toBeGreaterThan(0);
    }
  });

  it('starts every menu at that role dashboard', () => {
    for (const role of ROLES) {
      expect(navForRole(role)[0]).toEqual({ href: dashboardPathForRole(role), label: 'Dashboard' });
    }
  });

  it('only ever links inside the linking role own URL space', () => {
    // Structural, not a hard-coded list: a stray /admin/... entry dropped into
    // the sales menu fails here, because the guard on that page would send the
    // sales user to /forbidden.
    for (const role of ROLES) {
      for (const item of navForRole(role)) {
        expect(roleForPath(item.href), `${role} menu links to ${item.href}`).toBe(role);
      }
    }
  });

  it('has unique hrefs and non-empty labels within a menu', () => {
    for (const role of ROLES) {
      const items = navForRole(role);
      expect(new Set(items.map((i) => i.href)).size).toBe(items.length);
      for (const item of items) {
        expect(item.label.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('exposes the expected sections for each role', () => {
    // Spelled out, unlike the structural checks above: this is where a section
    // quietly dropped, renamed or reordered becomes a failing diff.
    const expected: Record<Role, string[]> = {
      admin: [
        '/admin',
        '/admin/uploads',
        '/admin/records',
        '/admin/leads',
        '/admin/corrections',
        '/admin/exports',
        '/admin/periods',
        '/admin/users',
        '/admin/audit',
      ],
      sales: ['/sales', '/sales/records', '/sales/leads', '/sales/requests'],
      approver: ['/approver', '/approver/queue', '/approver/history'],
      verifier: ['/verifier', '/verifier/queue', '/verifier/history'],
    };

    // Record<Role, …> catches a missing role at compile time, which this suite
    // never runs; asserting it here catches the same gap where it does run.
    expect(Object.keys(expected).sort()).toEqual([...ROLES].sort());

    for (const role of ROLES) {
      expect(navForRole(role).map((i) => i.href), `${role} menu`).toEqual(expected[role]);
    }
  });

  it('does not let a caller mutate the shared menu definition', () => {
    const first = navForRole('sales');
    first[0].href = '/admin';
    expect(navForRole('sales')[0].href).toBe('/sales');
  });
});
