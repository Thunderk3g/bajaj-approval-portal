'use client';

import { useActionState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { createFirstAdminAction } from './actions';
import type { SetupFormState } from './first-admin';

/**
 * The password rule is passed in rather than imported.
 *
 * `first-admin.ts` reaches the database and Better Auth; importing a constant
 * from it here would drag both into the browser bundle for the sake of the
 * number 12.
 */
export function SetupForm({ minPasswordLength }: { minPasswordLength: number }) {
  const [state, formAction, pending] = useActionState<SetupFormState, FormData>(
    createFirstAdminAction,
    null,
  );

  const fieldErrors = state?.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <Field label="Full name" htmlFor="name" required error={fieldErrors.name}>
        <Input id="name" name="name" autoComplete="name" required disabled={pending} />
      </Field>

      <Field label="Email" htmlFor="email" required error={fieldErrors.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          disabled={pending}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        required
        hint={`At least ${minPasswordLength} characters.`}
        error={fieldErrors.password}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={minPasswordLength}
          required
          disabled={pending}
        />
      </Field>

      <Field
        label="Confirm password"
        htmlFor="confirmPassword"
        required
        error={fieldErrors.confirmPassword}
      >
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          disabled={pending}
        />
      </Field>

      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Creating the account…' : 'Create administrator'}
      </Button>
    </form>
  );
}
