import { describe, it, expect } from 'vitest';
import type { Role } from '@/lib/auth/rbac';
import {
  ROLE_PREFIXES,
  dashboardPathForRole,
  roleForPath,
  safeNextPath,
} from '@/lib/auth/redirects';

const ROLES: Role[] = ['admin', 'sales', 'approver'];

describe('dashboardPathForRole', () => {
  it('sends each role to its own prefix', () => {
    expect(dashboardPathForRole('admin')).toBe('/admin');
    expect(dashboardPathForRole('sales')).toBe('/sales');
    expect(dashboardPathForRole('approver')).toBe('/approver');
  });

  it('returns a path that maps back to the same role', () => {
    for (const role of ROLES) {
      expect(roleForPath(dashboardPathForRole(role))).toBe(role);
    }
  });
});

describe('roleForPath', () => {
  it('matches a role prefix exactly', () => {
    for (const role of ROLES) {
      expect(roleForPath(ROLE_PREFIXES[role])).toBe(role);
    }
  });

  it('matches nested paths under a role prefix', () => {
    expect(roleForPath('/admin/users')).toBe('admin');
    expect(roleForPath('/admin/uploads/42/rows')).toBe('admin');
    expect(roleForPath('/sales/records')).toBe('sales');
    expect(roleForPath('/approver/queue')).toBe('approver');
  });

  it('does not treat a longer word as a role prefix', () => {
    // A naive startsWith would hand these to admin/sales and let an unrelated
    // route inherit that role's guard decisions.
    expect(roleForPath('/administration')).toBeNull();
    expect(roleForPath('/salesforce')).toBeNull();
    expect(roleForPath('/approvers')).toBeNull();
    expect(roleForPath('/admin-tools')).toBeNull();
    expect(roleForPath('/sales-report/2024')).toBeNull();
  });

  it('returns null for paths outside every role space', () => {
    expect(roleForPath('/')).toBeNull();
    expect(roleForPath('/login')).toBeNull();
    expect(roleForPath('/forbidden')).toBeNull();
    expect(roleForPath('/api/health')).toBeNull();
  });

  it('does not match a role prefix in a later segment', () => {
    expect(roleForPath('/app/admin')).toBeNull();
    expect(roleForPath('/x/sales/records')).toBeNull();
  });

  it('returns null for a value that is not a path', () => {
    expect(roleForPath('admin')).toBeNull();
    expect(roleForPath('')).toBeNull();
    expect(roleForPath('https://evil.example/admin')).toBeNull();
  });

  it('ignores a query string or fragment when matching', () => {
    expect(roleForPath('/admin?tab=users')).toBe('admin');
    expect(roleForPath('/admin#top')).toBe('admin');
    expect(roleForPath('/administration?x=/admin/')).toBeNull();
  });
});

describe('safeNextPath', () => {
  it('keeps a same-origin absolute path', () => {
    expect(safeNextPath('/admin/uploads')).toBe('/admin/uploads');
    expect(safeNextPath('/sales/records?page=2')).toBe('/sales/records?page=2');
  });

  it('rejects anything that could leave the origin', () => {
    expect(safeNextPath('https://evil.example/admin')).toBeNull();
    expect(safeNextPath('//evil.example/admin')).toBeNull();
    expect(safeNextPath('/\\evil.example')).toBeNull();
    expect(safeNextPath('javascript:alert(1)')).toBeNull();
  });

  it('returns null for a missing value', () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath('')).toBeNull();
  });
});
