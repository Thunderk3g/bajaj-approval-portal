import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import type { Role } from '@/lib/auth/rbac';
import { apiPath, navForRole } from '@/lib/nav';
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
        '/admin/workflows',
        '/admin/users',
        '/admin/performance',
        '/admin/mapping',
        '/admin/audit',
      ],
      sales: [
        '/sales',
        '/sales/records',
        '/sales/pool',
        '/sales/leads',
        '/sales/requests',
        '/sales/performance',
      ],
      approver: ['/approver', '/approver/queue', '/approver/history'],
      verifier: ['/verifier', '/verifier/queue', '/verifier/history'],
      tl: [
        '/tl',
        '/tl/queue',
        '/tl/requests',
        '/tl/requests/team',
        '/tl/requests/new',
        '/tl/records',
        '/tl/pool',
        '/tl/team',
        '/tl/performance',
        '/tl/mapping',
      ],
      acm: [
        '/acm',
        '/acm/queue',
        '/acm/requests',
        '/acm/requests/team',
        '/acm/requests/new',
        '/acm/records',
        '/acm/pool',
        '/acm/team',
        '/acm/performance',
        '/acm/mapping',
      ],
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

describe('apiPath', () => {
  const original = process.env.NEXT_PUBLIC_BASE_PATH;

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
    else process.env.NEXT_PUBLIC_BASE_PATH = original;
  });

  it('leaves the path alone when the app is served at the root', () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    expect(apiPath('/api/notifications')).toBe('/api/notifications');
  });

  it('prefixes the mount the app is served under', () => {
    process.env.NEXT_PUBLIC_BASE_PATH = '/reconciliation';
    expect(apiPath('/api/exports/abc/download')).toBe('/reconciliation/api/exports/abc/download');
  });

  /**
   * The reason this is a source scan and not six assertions.
   *
   * `basePath` rewrites next/link and every emitted asset URL, so the bug is
   * invisible in development, where the base path is empty — and invisible in a
   * unit test, which renders no attributes. It surfaces only on the VM, as the
   * platform landing SPA answering `/api/...` with HTML and logging "No routes
   * matched location". Six call sites had it at once for exactly that reason.
   *
   * The rule it enforces is therefore uniform, with no exceptions to remember:
   * a `/api/...` URL in a component goes through `apiPath`, whether it is a
   * fetch, an href or an img src. That is also why the one proof link that used
   * next/link (which would have been correct, and would have double-prefixed if
   * wrapped) is now a plain anchor.
   */
  it('is used by every /api URL under src, with none left raw', () => {
    const root = join(process.cwd(), 'src');
    const offenders: string[] = [];

    for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!/\.tsx?$/.test(entry)) continue;
      // Route Handlers ARE /api/...; they define the paths rather than call them.
      if (entry.startsWith(`app${sep}api${sep}`)) continue;

      const source = readFileSync(join(root, entry), 'utf8');

      // href/src as a literal, and fetch of a literal. `apiPath('/api/...')`
      // does not match either: the quote is preceded by `apiPath(`.
      const raw = /(?:href|src)=\{?['"`]\/api\/|fetch\(\s*['"`]\/api\//g;
      for (const match of source.matchAll(raw)) {
        const upto = source.slice(0, match.index);
        offenders.push(`src/${entry}:${upto.split('\n').length} — ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
