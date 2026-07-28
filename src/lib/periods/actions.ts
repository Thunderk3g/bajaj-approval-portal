'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/rbac';
import { fail, ok, type ActionResult } from '@/lib/result';
import { closePeriod, PeriodError, reopenPeriod, type CloseOutcome } from './service';

/**
 * Period lifecycle actions — 2026-07-28 spec section 4.4.
 *
 * Admin only. Closing a period removes every rep's ability to raise new
 * corrections against that month, so it is a change to what other people can do,
 * not a preference — and `requireRole` runs here rather than relying on the
 * layout, because a Server Action is reachable without rendering one.
 */

const periodIdSchema = z.object({ periodId: z.uuid('That period identifier is not valid.') });

function parse(formData: FormData) {
  return periodIdSchema.safeParse({ periodId: formData.get('periodId') });
}

function refresh() {
  revalidatePath('/admin/periods');
  revalidatePath('/admin');
  revalidatePath('/sales');
}

export async function closePeriodAction(formData: FormData): Promise<ActionResult<CloseOutcome>> {
  const actor = await requireRole('admin');

  const parsed = parse(formData);
  if (!parsed.success) return fail('That period identifier is not valid.');

  try {
    const outcome = await closePeriod(parsed.data.periodId, actor);
    refresh();
    return ok(outcome);
  } catch (error) {
    if (error instanceof PeriodError) return fail(error.message);
    throw error;
  }
}

/**
 * Reopening exists because closing is otherwise irreversible from the rep's
 * side. A month closed a day early leaves real corrections unraisable, and
 * without this the only remedy would be a database edit — which is exactly the
 * uncontrolled, unlogged change this portal was built to replace.
 */
export async function reopenPeriodAction(
  formData: FormData,
): Promise<ActionResult<{ label: string }>> {
  const actor = await requireRole('admin');

  const parsed = parse(formData);
  if (!parsed.success) return fail('That period identifier is not valid.');

  try {
    const reopened = await reopenPeriod(parsed.data.periodId, actor);
    refresh();
    return ok({ label: reopened.label });
  } catch (error) {
    if (error instanceof PeriodError) return fail(error.message);
    throw error;
  }
}
