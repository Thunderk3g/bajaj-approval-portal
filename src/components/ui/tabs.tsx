import Link from 'next/link';
import { cx } from './index';

/**
 * Tabs that are links, not state.
 *
 * Each tab is a real URL, so a deep link, a refresh and the back button all land
 * where the reader expects, and each panel stays a Server Component that fetches
 * only its own data. A client-side tab switcher would have to load every panel's
 * data on every visit to be able to swap between them without a round trip —
 * here, opening Users does not query the hierarchy tree.
 */
export function Tabs({
  tabs,
  current,
}: {
  tabs: Array<{ href: string; label: string; count?: number }>;
  current: string;
}) {
  return (
    <div className="mb-4 border-b border-slate-200">
      <nav className="-mb-px flex gap-1" aria-label="Sections">
        {tabs.map((tab) => {
          const active = tab.href === current;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] no-underline transition-colors',
                active
                  ? 'border-slate-900 font-medium text-slate-900'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800',
              )}
            >
              {tab.label}
              {typeof tab.count === 'number' ? (
                <span
                  className={cx(
                    'rounded px-1 py-px text-[11px] tabular-nums',
                    active ? 'bg-slate-100 text-slate-700' : 'bg-slate-100 text-slate-500',
                  )}
                >
                  {tab.count}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
