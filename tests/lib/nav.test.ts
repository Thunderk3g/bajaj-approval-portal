import { describe, it, expect } from 'vitest';
import type { Role } from '@/lib/auth/rbac';
import { navForRole } from '@/lib/nav';
import { dashboardPathForRole, roleForPath } from '@/lib/auth/redirects';

const ROLES: Role[] = ['admin', 'sales', 'approver'];

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
    expect(navForRole('admin').map((i) => i.href)).toEqual([
      '/admin',
      '/admin/uploads',
      '/admin/records',
      '/admin/corrections',
      '/admin/exports',
      '/admin/users',
      '/admin/audit',
    ]);
    expect(navForRole('sales').map((i) => i.href)).toEqual([
      '/sales',
      '/sales/records',
      '/sales/requests',
    ]);
    expect(navForRole('approver').map((i) => i.href)).toEqual([
      '/approver',
      '/approver/queue',
      '/approver/history',
    ]);
  });

  it('does not let a caller mutate the shared menu definition', () => {
    const first = navForRole('sales');
    first[0].href = '/admin';
    expect(navForRole('sales')[0].href).toBe('/sales');
  });
});
