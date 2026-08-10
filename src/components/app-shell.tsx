import type { ReactNode } from 'react';
import type { SessionUser } from '@/lib/auth/rbac';
import { navForRole, ROLE_LABELS } from '@/lib/nav';
import { SignOutButton } from '@/components/sign-out-button';
import { NotificationBell } from '@/components/notifications/bell';
import { PrimaryNav, RouteCrumb } from '@/components/app-nav';

export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  const items = navForRole(user.role);

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      {/* Sticky and full-height rather than scrolling with the page: these
          screens are long tables, and a nav that leaves the viewport costs a
          scroll to the top before every move between queues. */}
      <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="border-b border-slate-200 px-4 py-3.5">
          <p className="text-[13px] font-semibold tracking-[-0.01em] text-slate-900">
            Sales Data Review
          </p>
          {/* The role, not the user. Which of six roles you are decides what
              every screen beneath is allowed to show, so it is named once here
              rather than inferred from the nav list. */}
          <p className="mt-[3px] text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-500">
            {ROLE_LABELS[user.role]}
          </p>
        </div>

        <nav aria-label="Primary" className="flex-1 overflow-y-auto p-2">
          <PrimaryNav items={items} />
        </nav>

        <div className="border-t border-slate-200 px-3.5 py-2.5">
          <p className="text-[11px] text-slate-400">Bajaj Life — internal</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-[9px] sm:px-5">
          <RouteCrumb />

          {/* The bell is mounted in the shell rather than on individual pages
              because it has to stay reachable from every route — a notification
              you only see on the dashboard is a notification you miss. It polls
              on its own; nothing here re-renders on its account. */}
          <div className="flex shrink-0 items-center gap-3">
            <NotificationBell />
            <div className="hidden max-w-[18rem] text-right leading-[1.25] sm:block">
              <p className="truncate text-[12px] font-medium text-slate-900">{user.name}</p>
              <p className="truncate text-[11px] text-slate-500">
                {user.email}
                {user.smId ? (
                  <>
                    <span aria-hidden="true" className="px-1 text-slate-300">
                      ·
                    </span>
                    <span className="font-mono">SM_ID {user.smId}</span>
                  </>
                ) : null}
              </p>
            </div>
            <SignOutButton />
          </div>
        </header>

        <nav aria-label="Primary (compact)" className="border-b border-slate-200 bg-white md:hidden">
          <div className="px-4 py-2">
            {/* The sidebar carries the role on desktop and the topbar carries
                the name; below md neither is on screen, and "which of six roles
                am I" is the first thing every one of these pages depends on. */}
            <p className="mb-1.5 truncate text-[10px] font-semibold tracking-[0.07em] text-slate-500 uppercase">
              {ROLE_LABELS[user.role]} · {user.name}
            </p>
            <PrimaryNav items={items} compact />
          </div>
        </nav>

        <main className="w-full max-w-[1500px] flex-1 px-4 pt-[22px] pb-[76px] sm:px-5">
          {children}
        </main>
      </div>
    </div>
  );
}
