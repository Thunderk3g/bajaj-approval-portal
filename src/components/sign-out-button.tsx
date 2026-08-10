'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui';
import { signOut } from '@/lib/auth/client';

export function SignOutButton() {
  const router = useRouter();

  // useTransition rather than a useState flag, matching DecisionForm.
  //
  // The slow half of signing out is not the request, it is the navigation to
  // /login that follows it. A plain flag can only cover the await, so the button
  // goes idle again while the browser is still on a shell that looks signed in —
  // which invites a second click that races the first. A transition stays
  // pending until the destination has actually rendered.
  const [pending, startTransition] = useTransition();

  function onClick() {
    if (pending) return;

    startTransition(async () => {
      try {
        await signOut();
      } finally {
        // Leave for the login page either way: a failed sign-out must not strand
        // the user on a shell that still looks authenticated.
        router.push('/login');
        router.refresh();
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        aria-busy={pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-[5px] text-[12px] font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:text-slate-400"
      >
        {pending ? <Spinner /> : null}
        {pending ? 'Signing out…' : 'Sign out'}
      </button>

      {/* Outside the button on purpose: a live region nested inside it would be
          folded into the button's own accessible name, so the control would read
          as "Signing out… Signing out…". */}
      <span role="status" className="sr-only">
        {pending ? 'Signing out' : ''}
      </span>
    </>
  );
}
