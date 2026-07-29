'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui';
import { signIn } from '@/lib/auth/client';

/**
 * SECURITY: one message for every credential failure.
 *
 * An unknown email and a wrong password must be indistinguishable to the
 * caller. Saying "no such account" would let an unauthenticated visitor walk a
 * list of addresses and learn which ones are real staff accounts.
 */
const CREDENTIAL_ERROR = 'Incorrect email or password.';
const THROTTLED_ERROR = 'Too many sign-in attempts. Wait a minute and try again.';
const UNAVAILABLE_ERROR = 'Sign-in is unavailable right now. Try again shortly.';

export function LoginForm({ next }: { next?: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  // useTransition rather than a useState flag, matching DecisionForm.
  //
  // A successful sign-in lands on a force-dynamic dashboard that queries
  // Postgres, so most of the wait is the navigation, not the credential check. A
  // flag would have to be left switched on forever to cover that — the previous
  // version never reset it on the success path — whereas a transition stays
  // pending for exactly as long as the destination takes and clears itself on
  // failure.
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);

    startTransition(async () => {
      try {
        const result = await signIn.email({
          email: email.trim().toLowerCase(),
          password,
        });

        if (result.error) {
          // 429 is a throttle, not a credential verdict, so it reveals nothing
          // about whether the account exists. Every other failure collapses into
          // the same generic message.
          setError(result.error.status === 429 ? THROTTLED_ERROR : CREDENTIAL_ERROR);
          return;
        }

        router.push(next ?? '/');
        router.refresh();
      } catch {
        setError(UNAVAILABLE_ERROR);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div className="space-y-1.5">
        <label htmlFor="email" className="block text-sm font-medium text-slate-700">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={pending}
          className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-slate-500 focus:ring-1 focus:ring-slate-500 disabled:bg-slate-50 disabled:text-slate-500"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className="block text-sm font-medium text-slate-700">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending}
          className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500 disabled:bg-slate-50 disabled:text-slate-500"
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="inline-flex w-full items-center justify-center gap-2 rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {pending ? <Spinner /> : null}
        {pending ? 'Signing in…' : 'Sign in'}
      </button>

      {/* Outside the button: a live region nested inside it would be folded into
          the button's accessible name and read back twice. The sign-in wait runs
          past the credential check into a dashboard query, which is long enough
          that a non-sighted user is otherwise left guessing whether the form
          submitted at all. */}
      <span role="status" className="sr-only">
        {pending ? 'Signing in' : ''}
      </span>

      <p className="text-xs text-slate-500">
        Accounts are created by an administrator. There is no self sign-up.
      </p>
    </form>
  );
}
