'use client';

import { useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Textarea, cx } from '@/components/ui';
import { bulkDecideAction } from '@/lib/approvals/actions';
import { bulkVerifyDecideAction } from '@/lib/verification/actions';
import type { BulkOutcome } from '@/lib/approvals/schemas';
import type { ActionResult } from '@/lib/result';

/**
 * The batch bar, wrapped around a queue table.
 *
 * It owns a `<form>` that contains the table, and reads the selection straight
 * off the checkboxes `QueueTable` rendered. That is why the table can stay a
 * Server Component: nothing about the selection is React state, so nothing about
 * the rows has to cross into the browser bundle — no row data is serialized
 * twice, and `apply.ts` (and the database client behind it) stays server-side.
 *
 * The one thing that does cross is `appsNoById`, and only for the rows a
 * checkbox was rendered for. It exists because a failure comes back keyed by
 * request id, and "3f2a…-9c1 could not be decided" is not something an approver
 * can act on; the application number is.
 */

type Stage = 'approver' | 'verifier';

type DecisionButton = {
  value: string;
  label: string;
  variant: 'primary' | 'secondary' | 'danger';
  /** Mirrors the server union: a refusal the submitter cannot read is not a decision. */
  needsRemarks: boolean;
};

/**
 * The two stages offer different decisions, and the difference is not cosmetic.
 *
 * A verifier has no terminal reject — their "no" returns the request to the rep.
 * The server schemas enforce that; this table is what keeps the button that
 * would send an invalid payload from ever being rendered.
 */
const STAGES: Record<
  Stage,
  {
    action: (formData: FormData) => Promise<ActionResult<BulkOutcome>>;
    remarksHint: string;
    decisions: DecisionButton[];
  }
> = {
  approver: {
    action: bulkDecideAction,
    remarksHint:
      'Applied to every request in the batch. Optional when approving, required when returning or rejecting.',
    decisions: [
      { value: 'APPROVE', label: 'Approve selected', variant: 'primary', needsRemarks: false },
      { value: 'RETURN', label: 'Return selected', variant: 'secondary', needsRemarks: true },
      { value: 'REJECT', label: 'Reject selected', variant: 'danger', needsRemarks: true },
    ],
  },
  verifier: {
    action: bulkVerifyDecideAction,
    remarksHint:
      'Applied to every request in the batch. Optional when verifying, required when returning.',
    decisions: [
      { value: 'VERIFY', label: 'Verify selected', variant: 'primary', needsRemarks: false },
      { value: 'RETURN', label: 'Return selected', variant: 'secondary', needsRemarks: true },
    ],
  },
};

const PAST_TENSE: Record<string, string> = {
  APPROVE: 'approved',
  REJECT: 'rejected',
  RETURN: 'returned to the submitter',
  VERIFY: 'verified',
};

export function BulkDecisions({
  stage,
  appsNoById,
  children,
}: {
  stage: Stage;
  /** Request id → Apps_No, for the rows this queue can act on. */
  appsNoById: Record<string, string>;
  children: ReactNode;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();

  const [selected, setSelected] = useState(0);
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [remarkErrors, setRemarkErrors] = useState<string[] | undefined>(undefined);
  const [report, setReport] = useState<BulkOutcome | null>(null);

  const selectableCount = Object.keys(appsNoById).length;
  const { action, decisions, remarksHint } = STAGES[stage];

  function boxes(): HTMLInputElement[] {
    const found = formRef.current?.querySelectorAll<HTMLInputElement>('input[name="requestIds"]');
    return found ? [...found] : [];
  }

  function recount() {
    setSelected(boxes().filter((box) => box.checked).length);
  }

  function setAll(checked: boolean) {
    for (const box of boxes()) box.checked = checked;
    recount();
  }

  function submit(decision: DecisionButton) {
    setError(null);
    setRemarkErrors(undefined);
    setReport(null);

    const ids = boxes()
      .filter((box) => box.checked)
      .map((box) => box.value);

    if (ids.length === 0) {
      setError('Select at least one request first.');
      return;
    }

    // Both checks are repeated on the server, which is where they are decided.
    // These only save a round trip on the two mistakes that are easy to make.
    if (decision.needsRemarks && remarks.trim() === '') {
      setRemarkErrors(['Remarks are required so the submitter knows what to change.']);
      return;
    }

    const formData = new FormData();
    for (const id of ids) formData.append('requestIds', id);
    formData.set('decision', decision.value);
    formData.set('remarks', remarks);

    startTransition(async () => {
      const result = await action(formData);

      if (!result.ok) {
        setError(result.error);
        setRemarkErrors(result.fieldErrors?.remarks);
        return;
      }

      setReport(result.data);
      setRemarks('');
      setAll(false);
      router.refresh();
    });
  }

  /**
   * Nothing on this page can be acted on — a RETURNED-scope list, or a queue the
   * last batch just emptied. The controls would offer buttons that could only
   * ever refuse.
   *
   * Gated separately from the REPORT below, and the difference matters: a batch
   * that clears the whole page drops `selectableCount` to zero on the refresh
   * that follows it. Hiding the report on the same condition would make the
   * confirmation of a successful batch vanish at exactly the moment the batch
   * succeeded most completely — and with it the failure list and the roster
   * warnings, which are the parts that still need acting on.
   */
  const hasControls = selectableCount > 0;
  if (!hasControls && !report) return <>{children}</>;

  const allSelected = selected === selectableCount;

  return (
    <form ref={formRef} onSubmit={(event) => event.preventDefault()} onChange={recount}>
      {/* A toolbar, not a form card. It sits directly above the table it acts on
          and every pixel it takes is a queue row pushed under the fold, so the
          selection, the buttons and the remarks box share one bar. */}
      <div className="mb-3 rounded-lg border border-slate-200 bg-white">
        {hasControls ? (
          <div className="space-y-2.5 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <label className="flex items-center gap-2 text-[12px] font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(event) => setAll(event.target.checked)}
                  className="size-4 accent-slate-900"
                />
                Select all {selectableCount} on this page
              </label>
              <span className="text-[12px] tabular-nums text-slate-500">{selected} selected</span>

              <div className="ml-auto flex flex-wrap gap-2">
                {decisions.map((decision) => (
                  <Button
                    key={decision.value}
                    type="button"
                    variant={decision.variant}
                    disabled={pending || selected === 0}
                    onClick={() => submit(decision)}
                  >
                    {pending ? 'Working…' : `${decision.label} (${selected})`}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 grow basis-72">
                <label htmlFor="bulkRemarks">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-500">
                    Remarks
                  </span>
                </label>
                <Textarea
                  id="bulkRemarks"
                  name="remarks"
                  value={remarks}
                  maxLength={2000}
                  disabled={pending}
                  onChange={(event) => setRemarks(event.target.value)}
                  placeholder="What did you check, or what does the submitter need to change?"
                />
                {remarkErrors?.map((message) => (
                  <p key={message} className="mt-1 text-[11px] text-red-700">
                    {message}
                  </p>
                ))}
              </div>
              <p className="min-w-0 grow basis-64 pt-4 text-[12px] leading-snug text-slate-500">
                {remarksHint} Rows this queue cannot act on carry no checkbox.
              </p>
            </div>

            {error ? <Alert tone="danger">{error}</Alert> : null}
          </div>
        ) : null}

        {report ? (
          <div
            className={cx(
              'space-y-2 px-3 py-2.5',
              hasControls ? 'border-t border-slate-200' : undefined,
            )}
          >
            <Alert
              tone={report.failed.length === 0 ? 'success' : 'warning'}
              title={`${report.applied} ${report.applied === 1 ? 'request' : 'requests'} ${
                PAST_TENSE[report.decision] ?? 'decided'
              }${report.failed.length > 0 ? `. ${report.failed.length} could not be.` : '.'}`}
            />

            {/* Named individually rather than counted. Each of these is still
                sitting in the queue and still needs a decision, and the reasons
                differ — one raced another reviewer, another has an unparseable
                value that has to go back to the rep. */}
            {report.failed.length > 0 ? (
              <Alert tone="danger" title="Left exactly as they were">
                <ul className="mt-1 list-inside list-disc">
                  {report.failed.map((failure) => (
                    <li key={failure.requestId}>
                      <span className="font-mono">
                        {appsNoById[failure.requestId] ?? failure.requestId}
                      </span>{' '}
                      — {failure.message}
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            {report.warnings.map((warning) => (
              <Alert key={warning} tone="warning">
                {warning}
              </Alert>
            ))}
          </div>
        ) : null}
      </div>

      {children}
    </form>
  );
}
