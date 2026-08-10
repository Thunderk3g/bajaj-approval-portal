'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavItem } from '@/lib/nav';

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
function activeHref(items: NavItem[], pathname: string): string | undefined {
  return items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

// `no-underline` is not cosmetic housekeeping: globals.css underlines every
// anchor, which is right for links inside prose and wrong for a nav row.
const ITEM = 'flex items-center gap-1.5 rounded-md text-[13px] no-underline transition-colors';
const ACTIVE = 'bg-slate-100 font-medium text-slate-900';
const IDLE = 'font-normal text-slate-600 hover:bg-slate-50 hover:text-slate-900';

export function PrimaryNav({ items, compact = false }: { items: NavItem[]; compact?: boolean }) {
  const pathname = usePathname();
  const current = activeHref(items, pathname);

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

/** The route itself, monospaced, as the topbar's only left-hand content. */
export function RouteCrumb() {
  const pathname = usePathname();
  return <span className="min-w-0 truncate font-mono text-[12px] text-slate-500">{pathname}</span>;
}
