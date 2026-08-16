'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { navForRole, type NavItem } from '@/lib/nav';
import { roleForPath } from '@/lib/auth/redirects';

/**
 * The two pieces of the shell that need the current route.
 *
 * Kept in their own client module rather than marking the shell 'use client':
 * AppShell wraps every page, so a boundary there would ship each route's whole
 * tree to the browser to colour one nav row.
 */

/**
 * Longest matching prefix, not the first match.
 *
 * Every role's list opens with its dashboard — `/admin`, `/sales` — which is a
 * prefix of every other entry beneath it, so a plain `startsWith` would light
 * Dashboard up on all eleven admin screens at once.
 */
function activeItem(items: NavItem[], pathname: string): NavItem | undefined {
  return items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

// `no-underline` is not cosmetic housekeeping: globals.css underlines every
// anchor, which is right for links inside prose and wrong for a nav row.
//
// No focus utilities here on purpose. globals.css already draws the ring, from
// an UNLAYERED `:where(a, button, input, …):focus-visible` rule — and unlayered
// CSS beats every Tailwind utility whatever its specificity, so a
// `focus-visible:ring-*` added here is dead weight sitting under a ring that is
// already there. Measured, not assumed: a sidebar link and a `BUTTON_BASE`
// button both compute `outline: solid 2px rgb(15,23,42)` when focused.
const ITEM = 'flex items-center gap-1.5 rounded-md text-[13px] no-underline transition-colors';
const ACTIVE = 'bg-slate-100 font-medium text-slate-900';
const IDLE = 'font-normal text-slate-600 hover:bg-slate-50 hover:text-slate-900';

export function PrimaryNav({ items, compact = false }: { items: NavItem[]; compact?: boolean }) {
  const pathname = usePathname();
  const current = activeItem(items, pathname)?.href;

  return (
    <ul className={compact ? 'flex flex-wrap gap-1' : 'flex flex-col gap-px'}>
      {items.map((item) => {
        const active = item.href === current;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`${ITEM} ${compact ? 'px-2 py-1' : 'w-full px-2.5 py-1.5'} ${
                active ? ACTIVE : IDLE
              }`}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Where you are, in the words the menu uses.
 *
 * This printed the raw pathname — `/tl/requests/3f2a8c1e-…` — which is
 * developer chrome: it names a uuid nobody typed and repeats a prefix the
 * sidebar already highlights. Kept rather than deleted because the topbar is
 * the only orientation there is below `md`, where the sidebar is off screen
 * entirely and the compact nav wraps to two rows of small type.
 *
 * The label comes from the SAME `activeItem` the sidebar highlights with, so
 * the crumb and the lit menu row can never disagree — including on a detail
 * page, where both resolve to the section the record lives in.
 */
export function RouteCrumb() {
  const pathname = usePathname();
  const role = roleForPath(pathname);
  const current = role ? activeItem(navForRole(role), pathname) : undefined;

  return (
    <span className="min-w-0 truncate text-[12px] font-medium text-slate-700">
      {current?.label ?? ''}
    </span>
  );
}
