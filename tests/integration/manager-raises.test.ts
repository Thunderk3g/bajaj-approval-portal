/**
 * A manager raising a correction for one of their people — 2026-08-06 spec §5.
 *
 * A team leader and an area manager already read every record beneath them and
 * decide the requests raised against those records. What they could not do was
 * raise one: the submit path asked whether the actor WAS the rep, so a manager
 * who spotted a wrong AutoPay flag had to telephone somebody and dictate it.
 *
 * The boundary is the interesting half. "For their people" has to mean exactly
 * the set `scopedRecordCondition` already grants them — one rep further and a
 * manager could edit a book they cannot even see.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, manpower, salesRecord } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { submitCorrection } from '@/lib/corrections/service';
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
let acm: SessionUser;

async function makeRecord(smId: string, appsNo: string) {
  const [row] = await db
    .insert(salesRecord)
    .values({ appsNo, smId, smName: 'Somebody', status: 'ISSUED', autopay: 'No', extra: {} })
    .returning();
  return row;
}

beforeEach(async () => {
  await truncateAll();

  await db.insert(manpower).values([
    { smId: MINE, smName: 'Rep One', tlId: 'TL001', ccmId: 'CCM001' },
    { smId: ALSO_MINE, smName: 'Rep Two', tlId: 'TL001', ccmId: 'CCM001' },
    // Another team, another cluster: outside both managers below.
    { smId: THEIRS, smName: 'Other Rep', tlId: 'TL002', ccmId: 'CCM002' },
  ]);

  const tlRow = await makeUser({ role: 'tl', smId: null, tlCode: 'TL001', name: 'Sunil P' });
  const acmRow = await makeUser({
    role: 'acm',
    smId: null,
    acmCode: 'CCM001',
    email: 'acm.ccm001@bajajlife.com',
    name: 'Sagar Chavan',
  });

  tl = { id: tlRow.id, email: tlRow.email, name: tlRow.name, role: 'tl', smId: null, tlCode: 'TL001', isActive: true };
  acm = {
    id: acmRow.id,
    email: acmRow.email,
    name: acmRow.name,
    role: 'acm',
    smId: null,
    acmCode: 'CCM001',
    isActive: true,
  };
});

describe('a team leader raising for their team', () => {
  it('raises a correction that belongs to the rep, not to the manager', async () => {
    const record = await makeRecord(MINE, '6167509571');

    const result = await submitCorrection(tl, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      description: 'Mandate is registered — bank confirmation attached.',
      files: [proof()],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, result.data.id));

    // The book is the rep's; the hand that raised it is the manager's. Both
    // facts are recorded, and the queue keys on the first.
    expect(row.smId).toBe(MINE);
    expect(row.submittedBy).toBe(tl.id);
    expect(row.status).toBe('PENDING');
  });

  it('refuses a record belonging to another team', async () => {
    const record = await makeRecord(THEIRS, '6167509572');

    const result = await submitCorrection(tl, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/is in your team/i);
    expect(await db.select().from(correctionRequest)).toHaveLength(0);
  });

  it('claims a sale from another book INTO one of their reps, and only theirs', async () => {
    const record = await makeRecord(THEIRS, '6167509573');

    const mine = await submitCorrection(tl, {
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      appsNo: record.appsNo,
      proposedValue: ALSO_MINE,
      files: [proof()],
    });

    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    const [row] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, mine.data.id));
    // The claimant is the rep named, so the request lands in their book.
    expect(row.smId).toBe(ALSO_MINE);
    expect(row.counterpartySmId).toBe(THEIRS);

    // A second claim naming somebody outside the team is the whole boundary.
    const other = await makeRecord(MINE, '6167509574');
    const refused = await submitCorrection(tl, {
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      appsNo: other.appsNo,
      proposedValue: THEIRS,
      files: [proof()],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatch(/one of your reps/i);
  });

  it('transfers one of their reps sales out, resolving the record inside the team', async () => {
    const record = await makeRecord(MINE, '6167509575');

    const result = await submitCorrection(tl, {
      category: 'MAPPING',
      direction: 'TRANSFER_OUT',
      appsNo: record.appsNo,
      proposedValue: THEIRS,
      files: [proof()],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, result.data.id));
    expect(row.smId).toBe(MINE);
    expect(row.counterpartySmId).toBe(THEIRS);
  });
});

describe('an area manager raising for their cluster', () => {
  it('reaches every team beneath them', async () => {
    const record = await makeRecord(ALSO_MINE, '6167509576');

    const result = await submitCorrection(acm, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });

    expect(result.ok).toBe(true);
  });

  it('stops at the edge of the cluster', async () => {
    const record = await makeRecord(THEIRS, '6167509577');

    const result = await submitCorrection(acm, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });

    expect(result.ok).toBe(false);
  });

  it('refuses a manager account whose code the roster places nobody under', async () => {
    const stranded: SessionUser = { ...acm, acmCode: 'CCM999' };
    const record = await makeRecord(MINE, '6167509578');

    const result = await submitCorrection(stranded, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/places nobody under CCM999/i);
  });
});
