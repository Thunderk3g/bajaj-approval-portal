'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
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
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);

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
        setPending(false);
        return;
      }

      router.push(next ?? '/');
      router.refresh();
    } catch {
      setError(UNAVAILABLE_ERROR);
      setPending(false);
    }
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
        className="w-full rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>

      <p className="text-xs text-slate-500">
        Accounts are created by an administrator. There is no self sign-up.
      </p>
    </form>
  );
}
