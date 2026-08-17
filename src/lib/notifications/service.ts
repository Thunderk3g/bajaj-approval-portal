import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { notification, user } from '@/db/schema';
import type { DbTransaction } from '@/lib/audit/log';
import type { Role } from '@/lib/auth/rbac';

/**
 * Notification writes — spec section 10.
 *
 * Every function takes an optional transaction handle and every caller that is
 * already inside one must pass it. A notification that says "your correction was
 * approved" for an approval that rolled back is worse than no notification: the
 * submitter goes looking for a change that does not exist, and the discrepancy
 * is invisible from the record itself.
 *
 * Delivery is in-app only. Email and SMTP are explicitly out of scope
 * (spec section 2) — they would add credentials and a delivery failure mode the
 * closed loop does not need.
 */

export const NOTIFICATION_TYPES = [
  'CORRECTION_SUBMITTED',
  'CORRECTION_RESUBMITTED',
  /** Passed verification — this is what puts a request in the approver's queue. */
  'CORRECTION_VERIFIED',
  /**
   * Distinct from CORRECTION_RETURNED so the rep's inbox says which stage sent
   * it back. The fix differs: a verifier usually wants clearer proof, an
   * approver usually disputes the value itself.
   */
  'CORRECTION_RETURNED_BY_VERIFIER',
  'CORRECTION_APPROVED',
  'CORRECTION_REJECTED',
  'CORRECTION_RETURNED',
  'MAPPING_GAINED',
  /**
   * Raised at SUBMISSION to the rep on the other side — 2026-07-29 spec section 6.
   *
   * `MAPPING_LOST`/`MAPPING_GAINED` above announce a reassignment that has
   * already been applied. These two announce one that has been PROPOSED, which
   * is the only point at which the counterparty can still act on it. Distinct
   * types because the reading differs: one is a sale you hold being asked for,
   * the other is a sale arriving in your book.
   */
  'MAPPING_CLAIM_RAISED',
  'MAPPING_TRANSFER_PROPOSED',
  'MAPPING_LOST',
  /**
   * A TL or an ACM raised a correction against a rep's book — `docs/ui-flows.md`
   * §7, "raise on behalf of a rep".
   *
   * The rep is told, not asked. `submitted_by` is the manager and stays that
   * way: only they can resubmit or withdraw it, so the body has to say who
   * raised it or the rep opens a read-only screen with no explanation of why.
   */
  'CORRECTION_RAISED_FOR_YOU',
  'BATCH_COMMITTED',
  'EXPORT_READY',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationInput = {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  /** Deep link to the request or record the notification is about. */
  link?: string | null;
};

export async function notify(input: NotificationInput, tx?: DbTransaction): Promise<void> {
  await notifyMany([input], tx);
}

export async function notifyMany(inputs: NotificationInput[], tx?: DbTransaction): Promise<void> {
  if (inputs.length === 0) return;
  const executor = tx ?? db;
  await executor.insert(notification).values(
    inputs.map((i) => ({
      userId: i.userId,
      type: i.type,
      title: i.title,
      body: i.body ?? null,
      link: i.link ?? null,
    })),
  );
}

/**
 * Fans a notification out to every active holder of a reviewing role.
 *
 * Filtered on `isActive` so a deactivated reviewer's unread count does not grow
 * forever behind an account nobody can sign into.
 *
 * The return value is the recipient count and callers are expected to use it.
 * Zero is the failure that matters here: with the two-stage flow of the
 * 2026-07-28 spec, a submission that reaches no verifier sits in a queue nobody
 * is subscribed to, and the rep sees a request that looks submitted and never
 * moves. Silence is indistinguishable from success unless somebody counts.
 */
async function notifyActiveRole(
  role: 'approver' | 'verifier',
  input: Omit<NotificationInput, 'userId'>,
  tx?: DbTransaction,
): Promise<number> {
  const executor = tx ?? db;

  const recipients = await executor
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.role, role), eq(user.isActive, true)));

  await notifyMany(
    recipients.map((r) => ({ ...input, userId: r.id })),
    tx,
  );

  return recipients.length;
}

/** Spec section 10, row 1 — now reached only after verification. */
export async function notifyActiveApprovers(
  input: Omit<NotificationInput, 'userId'>,
  tx?: DbTransaction,
): Promise<number> {
  return notifyActiveRole('approver', input, tx);
}

/**
 * Notifies the sales users whose SM_ID appears in a committed batch, one row
 * each, carrying their own gap count — spec section 10, row 4.
 *
 * `gapCountBySmId` is computed by the caller because it already holds the
 * committed rows; recomputing it here would mean a second pass over the batch.
 */
export async function notifySalesForBatch(
  gapCountBySmId: Map<string, number>,
  batchLabel: string,
  tx?: DbTransaction,
): Promise<number> {
  if (gapCountBySmId.size === 0) return 0;
  const executor = tx ?? db;

  const smIds = [...gapCountBySmId.keys()];
  const recipients = await executor
    .select({ id: user.id, smId: user.smId })
    .from(user)
    .where(and(eq(user.role, 'sales'), eq(user.isActive, true), inArray(user.smId, smIds)));

  const rows: NotificationInput[] = [];
  for (const r of recipients) {
    if (!r.smId) continue;
    const gaps = gapCountBySmId.get(r.smId) ?? 0;
    rows.push({
      userId: r.id,
      type: 'BATCH_COMMITTED',
      title: `New records imported (${batchLabel})`,
      body:
        gaps > 0
          ? `${gaps} of your records are missing a field that needs reconciling.`
          : 'None of your new records have missing fields.',
      link: '/sales/records',
    });
  }

  await notifyMany(rows, tx);
  return rows.length;
}

/**
 * Resolves the active sales account that owns an SM_ID, for the mapping-claim
 * notifications of spec section 7.2 — where BOTH the gaining and the losing rep
 * must hear about the reassignment.
 *
 * The losing rep is notified, not consulted. A record silently vanishing from
 * one rep's list would otherwise be indistinguishable from data loss.
 */
export async function findSalesUserBySmId(
  smId: string,
  tx?: DbTransaction,
): Promise<{ id: string; name: string; email: string } | null> {
  const executor = tx ?? db;
  const [row] = await executor
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(and(eq(user.role, 'sales'), eq(user.isActive, true), eq(user.smId, smId.toUpperCase())))
    .limit(1);
  return row ?? null;
}

/**
 * One place that knows a record's URL differs per role.
 *
 * Only sales has its own record space. A verifier or approver reaches a record
 * through the admin route, which their global read scope already permits — so
 * adding /verifier/records would be a second URL onto the same query with the
 * same authorization, i.e. a second thing to keep in step for no gain.
 */
export function recordLink(appsNo: string, role: Role): string {
  return role === 'sales' ? `/sales/records/${appsNo}` : `/admin/records/${appsNo}`;
}

/**
 * Where a correction request lives, per role — the same idea as `recordLink`.
 *
 * Every decision notification used to hardcode `/sales/requests/${id}`, which is
 * correct only while the submitter is a rep. A TL or an ACM following one landed
 * on a page guarded by `requireSalesActor()`, which throws FORBIDDEN — so a
 * manager could not open their own request from the notification telling them it
 * had moved. Building the path from the RECIPIENT's role is the fix, and it has
 * to be one function because there were three call sites and they had all drifted
 * to the same wrong answer.
 *
 * `admin` goes to /admin/corrections: it is the only request screen an
 * administrator can reach, and an unroutable rung already falls to them there.
 */
const REQUEST_PREFIX: Record<Role, string> = {
  sales: '/sales/requests',
  tl: '/tl/requests',
  acm: '/acm/requests',
  verifier: '/verifier/requests',
  approver: '/approver/requests',
  admin: '/admin/corrections',
};

export function requestLink(requestId: string, role: Role): string {
  return `${REQUEST_PREFIX[role]}/${requestId}`;
}

export type RequestRecipient = {
  userId: string;
  name: string;
  role: Role;
  /** Already resolved against this recipient's own role prefix. */
  link: string;
  /** The account that raised it. */
  isSubmitter: boolean;
  /** The rep whose book it concerns. Both are true when the rep raised it themselves. */
  isOwner: boolean;
};

/**
 * Everyone who should hear about a request moving: whoever raised it, and the
 * rep whose book it is about.
 *
 * One function rather than a fan-out at each call site, and it de-duplicates by
 * construction — a rep who raised their own request appears once, flagged as
 * both. That is the same guarantee `notifySubmitterOfApproval`'s Map gives, kept
 * in one place instead of reinvented per event.
 *
 * A missing sales account for `smId` yields no row rather than an error. An
 * SM_ID with no login is normal in this data and never blocks anything — the
 * same rule `applyCorrectionToRecord` follows when it warns instead of refusing.
 */
export async function requestRecipients(
  request: { id: string; submittedBy: string; smId: string },
  tx?: DbTransaction,
): Promise<RequestRecipient[]> {
  const executor = tx ?? db;

  const [submitter, owner] = await Promise.all([
    executor
      .select({ id: user.id, name: user.name, role: user.role })
      .from(user)
      .where(eq(user.id, request.submittedBy))
      .limit(1)
      .then((rows) => rows[0]),
    findSalesUserBySmId(request.smId, tx),
  ]);

  const out: RequestRecipient[] = [];

  if (submitter) {
    out.push({
      userId: submitter.id,
      name: submitter.name,
      role: submitter.role,
      link: requestLink(request.id, submitter.role),
      isSubmitter: true,
      isOwner: owner?.id === submitter.id,
    });
  }

  if (owner && owner.id !== request.submittedBy) {
    out.push({
      userId: owner.id,
      name: owner.name,
      role: 'sales',
      link: requestLink(request.id, 'sales'),
      isSubmitter: false,
      isOwner: true,
    });
  }

  return out;
}
