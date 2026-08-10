'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { createUserAction } from '@/lib/users/actions';
import { ROLES, ROLE_DESCRIPTIONS, type UserRole } from '@/lib/users/schema';
import { ROLE_LABELS } from '@/lib/nav';
import { Alert, Button, Field, Input, Select } from '@/components/ui';

/**
 * Account creation — the only way an account comes into existence besides the
 * first-admin CLI. There is no public sign-up (spec section 4.2), so this form
 * is the whole provisioning story.
 */

export type CreateUserDefaults = {
  name?: string;
  smId?: string;
  tlCode?: string;
  acmCode?: string;
  role?: string;
  /** True when the prefilled SM_ID appears in transaction data but not the roster. */
  orphan?: boolean;
  /** Where the roster already places the prefilled SM_ID, so the form can show it. */
  placement?: { tlId: string | null; acmId: string | null } | null;
};

export function CreateUserForm({ defaults }: { defaults: CreateUserDefaults }) {
  const [state, formAction, pending] = useActionState(createUserAction, null);
  const [role, setRole] = useState(defaults.role ?? 'sales');
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the form only on success. Keeping the values after a failure is the
  // difference between fixing one field and retyping the whole account.
  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      {defaults.orphan ? (
        <Alert tone="warning" title="This SM_ID is not on the roster">
          {defaults.smId} appears in imported records but has no Manpower entry. Creating the
          account is allowed — it is flagged in the audit log for review rather than assumed to be a
          mistake.
        </Alert>
      ) : null}

      {state?.ok ? (
        <Alert tone="success" title="Account created">
          {state.data.email} can sign in with the password you set. There is no password-reset
          email, so pass it on securely.
        </Alert>
      ) : null}

      {state && !state.ok ? (
        <Alert tone="danger" title="Could not create the account">
          {state.error}
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" htmlFor="name" required error={errors.name}>
          <Input id="name" name="name" defaultValue={defaults.name ?? ''} required autoComplete="off" />
        </Field>

        <Field label="Email" htmlFor="email" required error={errors.email}>
          <Input id="email" name="email" type="email" required autoComplete="off" />
        </Field>

        <Field
          label="Initial password"
          htmlFor="password"
          required
          hint="At least 12 characters."
          error={errors.password}
        >
          <Input id="password" name="password" type="password" required autoComplete="new-password" />
        </Field>

        <Field
          label="Role"
          htmlFor="role"
          required
          // Verifier and approver are indistinguishable from their names alone,
          // and picking the wrong one produces an account that signs in to an
          // empty queue with nothing to say why.
          hint={ROLE_DESCRIPTIONS[role as UserRole]}
          error={errors.role}
        >
          <Select
            id="role"
            name="role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>

        {/*
          One scope field per role, and only the one that role actually reads.
          A code on the wrong field is the subtler failure than a missing one —
          the row looks scoped without being scoped — so the others are not merely
          disabled, they are absent, and the server refuses them either way.
        */}
        {role === 'sales' ? (
          <Field
            label="SM_ID"
            htmlFor="smId"
            required
            hint="Scopes this account to one rep’s records. Stored uppercase."
            error={errors.smId}
          >
            <Input
              id="smId"
              name="smId"
              defaultValue={defaults.smId ?? ''}
              required
              autoComplete="off"
              className="font-mono uppercase"
            />
          </Field>
        ) : null}

        {role === 'tl' ? (
          <Field
            label="TL code"
            htmlFor="tlCode"
            required
            hint="The code the Manpower sheet carries for this team leader. It is what resolves their reps and their approval steps."
            error={errors.tlCode}
          >
            <Input
              id="tlCode"
              name="tlCode"
              defaultValue={defaults.tlCode ?? ''}
              required
              autoComplete="off"
              className="font-mono uppercase"
            />
          </Field>
        ) : null}

        {role === 'acm' ? (
          <Field
            label="ACM code"
            htmlFor="acmCode"
            required
            hint="The CCM code the Manpower sheet carries for this area manager — ACM and CCM are the same rung."
            error={errors.acmCode}
          >
            <Input
              id="acmCode"
              name="acmCode"
              defaultValue={defaults.acmCode ?? ''}
              required
              autoComplete="off"
              className="font-mono uppercase"
            />
          </Field>
        ) : null}
      </div>

      {/*
        The placement this account will have, shown before it is saved.
        A rep is only reachable by their TL and ACM if the roster places them
        there, and an account created with a code the roster does not know is a
        login whose approval steps resolve to nobody — visible here rather than
        discovered when the first request fails to route.
      */}
      {role === 'sales' && defaults.placement ? (
        <Alert tone={defaults.placement.tlId ? 'info' : 'warning'}>
          {defaults.placement.tlId ? (
            <>
              The roster places {defaults.smId} under{' '}
              <strong className="font-mono">{defaults.placement.tlId}</strong>
              {defaults.placement.acmId ? (
                <>
                  {' '}
                  → <strong className="font-mono">{defaults.placement.acmId}</strong>
                </>
              ) : (
                <> — but that team leader has no area manager on the roster.</>
              )}
              . Their mapping corrections will route through them.
            </>
          ) : (
            <>
              The roster places {defaults.smId} under no team leader, so their mapping corrections
              will skip the team-leader and area-manager steps. Import an up-to-date Manpower sheet
              to fix it.
            </>
          )}
        </Alert>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create account'}
      </Button>
    </form>
  );
}
