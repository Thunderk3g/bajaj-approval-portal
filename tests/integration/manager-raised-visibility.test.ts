/**
 * A manager-raised request, from the REP's side — `docs/ui-flows.md` §7.
 *
 * `manager-raises.test.ts` covers the write: a TL or an ACM may raise against
 * their team's records, and the row records the manager in `submitted_by` and
 * the rep's code in `sm_id`. This file covers everything that happens after —
 * whether the rep can see it, what they may do with it, and who is told as it
 * climbs the chain.
 *
 * The shape of the thing being tested is an asymmetry: reads widen to the book,
 * writes stay on the submitter. Both halves are asserted, because either one
 * alone is a bug — a rep who cannot see a request raised for them is the reported
 * defect, and a rep who can resubmit one is a hole in the ownership rule.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, manpower, notification, salesRecord } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import {
  countMyRequestsByStatus,
  getMyRequest,
  listCounterpartyRequests,
  listMyRequests,
} from '@/lib/corrections/queries';
import { submitCorrection, withdrawCorrection } from '@/lib/corrections/service';
import { decideStage } from '@/lib/workflows';

import { makeUser, truncateAll } from '../helpers/db';

const MINE = 'ICCSP90766';
const ALSO_MINE = 'ICCSP90767';
const THEIRS = 'C2CM21350';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const proof = () => ({ name: 'mandate.png', bytes: new Uint8Array(PNG) });

let tl: SessionUser;
let rep: SessionUser;
let neighbour: SessionUser;
let stranger: SessionUser;
let verifier: SessionUser;
let approver: SessionUser;

const session = (
  row: { id: string; email: string; name: string; smId: string | null },
  role: SessionUser['role'],
  extra: Partial<SessionUser> = {},
): SessionUser => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role,
  smId: row.smId,
  isActive: true,
  ...extra,
});

async function makeRecord(smId: string, appsNo: string) {
  const [row] = await db
    .insert(salesRecord)
    .values({ appsNo, smId, smName: 'Somebody', status: 'ISSUED', autopay: 'No', extra: {} })
    .returning();
  return row;
}

/** Every notification row this person holds, newest last. */
async function inboxOf(user: SessionUser, type?: string) {
  const where = type
    ? and(eq(notification.userId, user.id), eq(notification.type, type))
    : eq(notification.userId, user.id);
  return db.select().from(notification).where(where).orderBy(notification.createdAt);
}

const autopayBy = (actor: SessionUser, appsNo: string) =>
  submitCorrection(actor, {
    category: 'AUTOPAY',
    appsNo,
    proposedValue: 'Yes',
    description: 'Mandate is registered — bank confirmation attached.',
    files: [proof()],
  });

beforeEach(async () => {
  await truncateAll();

  await db.insert(manpower).values([
    { smId: MINE, smName: 'Rep One', tlId: 'TL001', ccmId: 'CCM001' },
    { smId: ALSO_MINE, smName: 'Rep Two', tlId: 'TL001', ccmId: 'CCM001' },
    { smId: THEIRS, smName: 'Other Rep', tlId: 'TL002', ccmId: 'CCM002' },
  ]);

  tl = session(
    await makeUser({ role: 'tl', smId: null, tlCode: 'TL001', name: 'Sunil P' }),
    'tl',
    { tlCode: 'TL001' },
  );
  rep = session(await makeUser({ role: 'sales', smId: MINE, name: 'Rep One' }), 'sales');
  neighbour = session(
    await makeUser({ role: 'sales', smId: ALSO_MINE, name: 'Rep Two' }),
    'sales',
  );
  stranger = session(await makeUser({ role: 'sales', smId: THEIRS, name: 'Other Rep' }), 'sales');
  verifier = session(await makeUser({ role: 'verifier', smId: null, name: 'Vidya V' }), 'verifier');
  approver = session(await makeUser({ role: 'approver', smId: null, name: 'Anand A' }), 'approver');
});

/* ------------------------------------------------------- read yes, write no */

describe('a rep and the request their team leader raised for them', () => {
  it('appears in the rep’s own list, naming the manager who raised it', async () => {
    const record = await makeRecord(MINE, '6167509571');
    const raised = await autopayBy(tl, record.appsNo);
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;

    const { rows, total } = await listMyRequests(rep, { offset: 0, limit: 25 });

    expect(total).toBe(1);
    expect(rows[0].id).toBe(raised.data.id);
    // The two columns the screen distinguishes on: it is the rep's book, and it
    // is somebody else's hand. A list showing only the first would leave the rep
    // wondering why they cannot resubmit their own request.
    expect(rows[0].smId).toBe(MINE);
    expect(rows[0].submittedBy).toBe(tl.id);
    expect(rows[0].submitterName).toBe('Sunil P');
    expect(rows[0].smName).toBe('Rep One');
  });

  it('opens on the detail screen, carrying the raiser’s name', async () => {
    const record = await makeRecord(MINE, '6167509572');
    const raised = await autopayBy(tl, record.appsNo);
    if (!raised.ok) return;

    const detail = await getMyRequest(rep, raised.data.id);

    expect(detail).not.toBeNull();
    expect(detail?.request.submittedBy).toBe(tl.id);
    expect(detail?.submitterName).toBe('Sunil P');
  });

  it('counts towards the rep’s status tallies, so the dashboard agrees with the list', async () => {
    const record = await makeRecord(MINE, '6167509573');
    await autopayBy(tl, record.appsNo);

    expect(await countMyRequestsByStatus(rep)).toEqual({ PENDING: 1 });
  });

  it('refuses the rep every WRITE, while the manager keeps them', async () => {
    const record = await makeRecord(MINE, '6167509574');
    const raised = await autopayBy(tl, record.appsNo);
    if (!raised.ok) return;

    // `loadOwnRequest` is still keyed on submitted_by, so the rep is answered
    // exactly as they would be for a request that does not exist — the widened
    // read must not become a widened write.
    const refused = await withdrawCorrection(rep, { requestId: raised.data.id });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatch(/does not exist/i);

    const [untouched] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, raised.data.id));
    expect(untouched.status).toBe('PENDING');

    // …and the manager who raised it still can.
    const allowed = await withdrawCorrection(tl, { requestId: raised.data.id });
    expect(allowed.ok).toBe(true);
  });
});

/* ------------------------------------------------------------ the boundary */

describe('the widened predicate does not leak across books', () => {
  it('shows a rep nothing from another rep’s book, however it was raised', async () => {
    const record = await makeRecord(ALSO_MINE, '6167509575');
    const raised = await autopayBy(tl, record.appsNo);
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;

    // Same team, same TL, same manager's hand — and still not this rep's book.
    // If `sm_id = actor.smId` were ever loosened to "my team", this is the
    // assertion that fails.
    expect(await listMyRequests(rep, { offset: 0, limit: 25 })).toEqual({ rows: [], total: 0 });
    expect(await getMyRequest(rep, raised.data.id)).toBeNull();
    expect(await countMyRequestsByStatus(rep)).toEqual({});

    // A rep in another cluster entirely sees nothing either.
    expect(await getMyRequest(stranger, raised.data.id)).toBeNull();

    // And the rep it IS about sees it, so the check above is testing the
    // boundary rather than a query that returns nothing to anybody.
    const theirs = await listMyRequests(neighbour, { offset: 0, limit: 25 });
    expect(theirs.total).toBe(1);
  });

  it('leaves a manager seeing only what they raised, which is what /tl/requests lists', async () => {
    const mineToRaise = await makeRecord(MINE, '6167509576');
    const repsOwn = await makeRecord(ALSO_MINE, '6167509577');

    const byManager = await autopayBy(tl, mineToRaise.appsNo);
    const byRep = await autopayBy(neighbour, repsOwn.appsNo);
    expect(byManager.ok && byRep.ok).toBe(true);
    if (!byManager.ok || !byRep.ok) return;

    const { rows, total } = await listMyRequests(tl, { offset: 0, limit: 25 });

    // The rep's own request is in this manager's TEAM but not on their desk.
    // `/tl/requests` answers "what did I send off", not "what is my team doing".
    expect(total).toBe(1);
    expect(rows[0].id).toBe(byManager.data.id);
    expect(rows[0].smId).toBe(MINE);
  });

  it('filters a manager’s list by status like the rep’s does', async () => {
    const record = await makeRecord(MINE, '6167509578');
    await autopayBy(tl, record.appsNo);

    expect((await listMyRequests(tl, { offset: 0, limit: 25, status: 'PENDING' })).total).toBe(1);
    expect((await listMyRequests(tl, { offset: 0, limit: 25, status: 'APPROVED' })).total).toBe(0);
  });
});

/* --------------------------------------------------------- notification fan */

describe('the rep is told at every step, exactly once', () => {
  it('tells them at submission who raised it and what changes', async () => {
    const record = await makeRecord(MINE, '6167509579');
    const raised = await autopayBy(tl, record.appsNo);
    if (!raised.ok) return;

    const rows = await inboxOf(rep, 'CORRECTION_RAISED_FOR_YOU');

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain('Sunil P');
    expect(rows[0].title).toContain(record.appsNo);
    expect(rows[0].body).toContain('No');
    expect(rows[0].body).toContain('Yes');
    expect(rows[0].link).toBe(`/sales/requests/${raised.data.id}`);

    // The manager gets no "raised for you" row about their own hand.
    expect(await inboxOf(tl, 'CORRECTION_RAISED_FOR_YOU')).toHaveLength(0);
  });

  it('tells both of them on advance, on return and on final approval', async () => {
    const record = await makeRecord(MINE, '6167509580');
    const raised = await autopayBy(tl, record.appsNo);
    if (!raised.ok) return;
    const id = raised.data.id;

    /* advance — the verifier passes it to the approver */
    await decideStage({ requestId: id, actor: verifier, decision: 'ADVANCE' });

    expect(await inboxOf(rep, 'CORRECTION_VERIFIED')).toHaveLength(1);
    expect(await inboxOf(tl, 'CORRECTION_VERIFIED')).toHaveLength(1);

    /* return — the approver sends it back */
    await decideStage({
      requestId: id,
      actor: approver,
      decision: 'RETURN',
      remarks: 'Attach the bank letter, not the screenshot.',
    });

    const repReturned = await inboxOf(rep, 'CORRECTION_RETURNED');
    const tlReturned = await inboxOf(tl, 'CORRECTION_RETURNED');
    expect(repReturned).toHaveLength(1);
    expect(tlReturned).toHaveLength(1);
    // The rep is told they cannot answer it; the manager is not told that.
    expect(repReturned[0].body).toMatch(/only they can answer it/i);
    expect(tlReturned[0].body).toBe('Attach the bank letter, not the screenshot.');
  });

  it('tells both of them when it is finally approved, one row each', async () => {
    const record = await makeRecord(MINE, '6167509581');
    const raised = await autopayBy(tl, record.appsNo);
    if (!raised.ok) return;
    const id = raised.data.id;

    await decideStage({ requestId: id, actor: verifier, decision: 'ADVANCE' });
    const applied = await decideStage({ requestId: id, actor: approver, decision: 'ADVANCE' });
    expect(applied.kind).toBe('APPLIED');

    expect(await inboxOf(rep, 'CORRECTION_APPROVED')).toHaveLength(1);
    expect(await inboxOf(tl, 'CORRECTION_APPROVED')).toHaveLength(1);
  });

  it('never sends a rep who raised their own request two rows for one event', async () => {
    const record = await makeRecord(MINE, '6167509582');
    const raised = await autopayBy(rep, record.appsNo);
    if (!raised.ok) return;
    const id = raised.data.id;

    // Submitter and owner are the same account, so the fan-out must collapse.
    expect(await inboxOf(rep, 'CORRECTION_RAISED_FOR_YOU')).toHaveLength(0);

    await decideStage({ requestId: id, actor: verifier, decision: 'ADVANCE' });
    expect(await inboxOf(rep, 'CORRECTION_VERIFIED')).toHaveLength(1);

    await decideStage({ requestId: id, actor: approver, decision: 'ADVANCE' });
    expect(await inboxOf(rep, 'CORRECTION_APPROVED')).toHaveLength(1);
  });

  it('says nothing to a book with no portal account rather than refusing the raise', async () => {
    // ALSO_MINE is on the roster but has no login here.
    await db.delete(notification);
    const unaccounted = 'ICCSP90768';
    await db.insert(manpower).values({
      smId: unaccounted,
      smName: 'Rep Three',
      tlId: 'TL001',
      ccmId: 'CCM001',
    });
    const record = await makeRecord(unaccounted, '6167509583');

    const raised = await autopayBy(tl, record.appsNo);

    expect(raised.ok).toBe(true);
    expect(await db.select().from(notification).where(eq(notification.type, 'CORRECTION_RAISED_FOR_YOU'))).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------- links */

describe('notification links land on the recipient’s own role prefix', () => {
  it('sends the manager to /tl and the rep to /sales for the same event', async () => {
    const record = await makeRecord(MINE, '6167509584');
    const raised = await autopayBy(tl, record.appsNo);
    if (!raised.ok) return;
    const id = raised.data.id;

    await decideStage({ requestId: id, actor: verifier, decision: 'ADVANCE' });

    // The bug this replaces: every decision notification hardcoded
    // /sales/requests/<id>, which a TL cannot open — requireSalesActor throws
    // FORBIDDEN — so a manager could not reach their own request from the row
    // telling them it had moved.
    const [managerRow] = await inboxOf(tl, 'CORRECTION_VERIFIED');
    const [repRow] = await inboxOf(rep, 'CORRECTION_VERIFIED');

    expect(managerRow.link).toBe(`/tl/requests/${id}`);
    expect(repRow.link).toBe(`/sales/requests/${id}`);
  });

  it('sends a rep who raised their own request to /sales, as before', async () => {
    const record = await makeRecord(MINE, '6167509585');
    const raised = await autopayBy(rep, record.appsNo);
    if (!raised.ok) return;

    await decideStage({ requestId: raised.data.id, actor: verifier, decision: 'ADVANCE' });

    const [row] = await inboxOf(rep, 'CORRECTION_VERIFIED');
    expect(row.link).toBe(`/sales/requests/${raised.data.id}`);
  });
});

/* --------------------------------------------------------- no double-counting */

describe('a manager-raised mapping claim is listed once, not twice', () => {
  it('shows in the rep’s own list and not also as something done to them', async () => {
    const record = await makeRecord(THEIRS, '6167509586');

    const claim = await submitCorrection(tl, {
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      appsNo: record.appsNo,
      proposedValue: MINE,
      files: [proof()],
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    // Both queries match this row on sm_id now, so without the exclusion the
    // rep would read their own claim twice — once as theirs, once as a
    // reassignment being done to them.
    const mine = await listMyRequests(rep, { offset: 0, limit: 25 });
    expect(mine.total).toBe(1);
    expect(await listCounterpartyRequests(rep)).toHaveLength(0);

    // The rep on the other side still sees it, which is what that card is for.
    const other = await listCounterpartyRequests(stranger);
    expect(other).toHaveLength(1);
    expect(other[0].role).toBe('LOSING');
  });
});
