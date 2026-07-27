'use client';

import { useActionState } from 'react';
import { setUserActiveAction } from '@/lib/users/actions';
import { Button } from '@/components/ui';

/**
 * Deactivate / reactivate for one row.
 *
 * There is no delete button and there will not be one. Audit rows reference
 * `user.id` with ON DELETE RESTRICT (section 4.2), so a hard delete would fail
 * at the database anyway — but the reason it is absent from the UI is that
 * deactivation is the correct operation: it revokes access on the very next
 * request while leaving every historical line attributable.
 */
export function UserRowActions({
  userId,
  isActive,
  isSelf,
}: {
  userId: string;
  isActive: boolean;
  isSelf: boolean;
}) {
  const [state, formAction, pending] = useActionState(setUserActiveAction, null);

  // An admin deactivating themselves is locked out on the next request with no
  // way back in — the control is not rendered rather than rendered and refused,
  // so it never looks like an option. The Server Action refuses it too; this is
  // only the polite half.
  if (isSelf && isActive) {
    return <span className="text-xs text-slate-400">your account</span>;
  }

  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="intent" value={isActive ? 'deactivate' : 'activate'} />
      <Button
        type="submit"
        variant={isActive ? 'danger' : 'secondary'}
        disabled={pending}
        className="px-2.5 py-1.5 text-xs"
      >
        {pending ? '…' : isActive ? 'Deactivate' : 'Reactivate'}
      </Button>
      {state && !state.ok ? <span className="text-xs text-red-700">{state.error}</span> : null}
    </form>
  );
}
