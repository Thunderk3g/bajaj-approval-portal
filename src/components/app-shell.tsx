import type { ReactNode } from 'react';
import Link from 'next/link';
import type { SessionUser } from '@/lib/auth/rbac';
import { navForRole, ROLE_LABELS } from '@/lib/nav';
import { SignOutButton } from '@/components/sign-out-button';
import { NotificationBell } from '@/components/notifications/bell';

export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  const items = navForRole(user.role);

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white md:flex md:flex-col">
        <div className="border-b border-slate-200 px-4 py-4">
          <p className="text-sm font-semibold tracking-tight text-slate-900">Sales Data Review</p>
          <p className="mt-0.5 text-xs uppercase tracking-wide text-slate-500">
            {ROLE_LABELS[user.role]}
          </p>
        </div>

        <nav aria-label="Primary" className="flex-1 p-2">
          <ul className="space-y-0.5">
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="block rounded px-3 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <p className="border-t border-slate-200 px-4 py-3 text-xs text-slate-400">
          Bajaj Life — internal
        </p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-900">{user.name}</p>
            <p className="truncate text-xs text-slate-500">
              {user.email}
              {user.smId ? (
                <>
                  <span aria-hidden="true" className="px-1.5 text-slate-300">
                    |
                  </span>
                  <span className="font-mono">SM_ID {user.smId}</span>
                </>
              ) : null}
            </p>
          </div>
          {/* The bell is mounted in the shell rather than on individual pages
              because it has to stay reachable from every route — a notification
              you only see on the dashboard is a notification you miss. It polls
              on its own; nothing here re-renders on its account. */}
          <div className="flex shrink-0 items-center gap-2">
            <NotificationBell />
            <SignOutButton />
          </div>
        </header>

        <nav aria-label="Primary (compact)" className="border-b border-slate-200 bg-white md:hidden">
          <ul className="flex flex-wrap gap-1 px-4 py-2">
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="block rounded px-2 py-1 text-sm text-slate-700 hover:bg-slate-100"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8">
          <div className="mx-auto max-w-5xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
