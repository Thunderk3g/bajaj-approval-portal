'use client';

import { useActionState, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { removeUserAction, setUserActiveAction } from '@/lib/users/actions';
import { FORCE_REMOVE_PHRASE } from '@/lib/users/force-confirm';
import { Button, Input } from '@/components/ui';

/**
 * Deactivate / reactivate / remove for one row.
 *
 * Deactivation stays the default and the safe answer: it revokes access on the
 * very next request while leaving every historical line attributable. Removal
 * sits beside it rather than replacing it, because "this account should not
 * exist" and "this person should not have access" are different statements and
 * the screen used to be able to make only the second one.
 *
 * Removal is not always possible, and the reason is deliberate — `audit_log`
 * references `user.id` with ON DELETE RESTRICT, so an account that has done
 * anything auditable is deactivated instead and this control says so. Past that
 * there is a force, and it is offered only AFTER the attempt has come back
 * deactivated: nobody reaches it without first reading why the ordinary removal
 * did not happen.
 */
export function UserRowActions({
  userId,
  email,
  isActive,
  isSelf,
}: {
  userId: string;
  email: string;
  isActive: boolean;
  isSelf: boolean;
}) {
  const [state, formAction, pending] = useActionState(setUserActiveAction, null);

  // An admin deactivating themselves is locked out on the next request with no
  // way back in — the control is not rendered rather than rendered and refused,
  // so it never looks like an option. The Server Action refuses it too; this is
  // only the polite half. Removal is refused for the same reason and by the same
  // rule, which is why the whole cell goes.
  if (isSelf && isActive) {
    return <span className="text-xs text-slate-400">your account</span>;
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
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

      {isSelf ? null : <RemoveAccount userId={userId} email={email} />}
    </div>
  );
}

/**
 * The removal half, kept separate because it is a small state machine and the
 * activate half is a plain form post.
 *
 * `removeUsers` reports rather than throws: an account it could not delete comes
 * back `ok` with a reason attached, so this reads the outcome groups instead of
 * `result.ok` to decide what happened.
 */
function RemoveAccount({ userId, email }: { userId: string; email: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  /** Set when the server came back "deactivated instead", i.e. the force applies. */
  const [blocked, setBlocked] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [phrase, setPhrase] = useState('');

  function reset() {
    setConfirming(false);
    setForcing(false);
    setBlocked(false);
    setPhrase('');
    setMessage(null);
  }

  function submit() {
    setMessage(null);
    startTransition(async () => {
      const result = await removeUserAction({
        userId,
        force: forcing || undefined,
        confirm: forcing ? phrase.trim() : undefined,
      });

      if (!result.ok) {
        setMessage(result.error);
        return;
      }

      const [deactivated] = result.data.deactivated;
      if (deactivated) {
        setMessage(`Deactivated instead — ${deactivated.reason}.`);
        setBlocked(true);
        router.refresh();
        return;
      }

      const [skipped] = result.data.skipped;
      if (skipped) {
        // No force is offered for this one. The reference holding the row is a
        // NOT NULL column on work the account did, and detaching it is not a
        // thing the database can be asked to do.
        setMessage(`Not removed — ${skipped.reason}`);
        setBlocked(false);
        router.refresh();
        return;
      }

      reset();
      router.refresh();
    });
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-start gap-1">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="text-xs font-medium text-red-700 underline underline-offset-2 hover:text-red-900"
        >
          Remove
        </button>
        {message ? <span className="max-w-[16rem] text-xs text-slate-600">{message}</span> : null}
      </div>
    );
  }

  return (
    <div className="max-w-[18rem] space-y-2 rounded-md border border-red-200 bg-red-50 p-2">
      <p className="text-xs leading-relaxed text-red-900">
        Remove <span className="font-medium">{email}</span>? The account and its sessions go. If it
        has done anything auditable it is deactivated instead — the audit trail references it.
      </p>

      {message ? <p className="text-xs leading-relaxed text-red-900">{message}</p> : null}

      {/* Offered only once the server has said "deactivated instead". Beside the
          ordinary Remove it would read as a second way to do the same thing. */}
      {blocked && !forcing ? (
        <button
          type="button"
          onClick={() => setForcing(true)}
          className="text-xs font-medium text-red-700 underline underline-offset-2 hover:text-red-900"
        >
          Force remove
        </button>
      ) : null}

      {forcing ? (
        <label className="block text-xs font-medium text-red-900">
          Every audit entry this account is the actor of is <strong>deleted</strong> — what it did,
          when, and to which record, gone for good and not recoverable. Type {FORCE_REMOVE_PHRASE}{' '}
          to confirm.
          <Input
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            className="mt-1 w-full border-red-300 font-mono text-xs uppercase focus:border-red-500 focus:ring-red-500"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="danger"
          onClick={submit}
          disabled={pending}
          className="px-2.5 py-1.5 text-xs"
        >
          {pending ? '…' : forcing ? 'Purge and delete' : 'Remove'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={reset}
          disabled={pending}
          className="px-2.5 py-1.5 text-xs"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
