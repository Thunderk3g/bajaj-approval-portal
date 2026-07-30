import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionAttachment, correctionRequest, salesRecord } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { submitCorrection } from '@/lib/corrections/service';
import { applyApproval } from '@/lib/approvals/apply';
import { verifyRequest } from '@/lib/verification/apply';
import { deleteStoredProofs } from '@/lib/storage/files';
import { CANONICAL_FIELDS, CATEGORY_FIELDS } from '@/lib/fields';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * The `Agent_ID` correction category.
 *
 * A category is worth its own enum value only if the enum is what pins the
 * target field, so these tests are mostly about that: that AGENT_ID reaches
 * `agent_id` and can reach nothing else, no matter what `field_name` the payload
 * carries. The rest — proof, verification, versioning — is the shared path every
 * other category already travels, asserted once here end to end so a new
 * category cannot be added that only LOOKS wired up.
 */

const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const proof = (name = 'proof.png') => ({ name, bytes: PNG });

const OWNER = 'ICCSP90766';

function sessionFor(row: {
  id: string;
  name: string;
  email: string;
  role: string;
  smId: string | null;
}): SessionUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as SessionUser['role'],
    smId: row.smId,
    isActive: true,
  };
}

async function seed(agentId: string | null = '3000000007') {
  const repRow = await makeUser({ role: 'sales', smId: OWNER, name: 'Priya Sales' });
  const verifierRow = await makeUser({ role: 'verifier', smId: null });
  const approverRow = await makeUser({ role: 'approver', smId: null });

  const [record] = await db
    .insert(salesRecord)
    .values({
      appsNo: '6167509575',
      smId: OWNER,
      smName: 'Owner Rep',
      clientName: 'Ravi Kumar',
      status: 'ISSUED',
      agentId,
    })
    .returning();

  return {
    rep: sessionFor(repRow),
    verifier: { id: verifierRow.id, email: verifierRow.email, role: 'verifier' as const },
    approver: { id: approverRow.id, email: approverRow.email, role: 'approver' as const },
    record,
  };
}

async function clearStoredProofs() {
  const rows = await db.select({ path: correctionAttachment.storedPath }).from(correctionAttachment);
  await deleteStoredProofs(rows.map((r) => r.path));
}

describe('the Agent ID field', () => {
  it('is in the canonical registry, so import and export both carry it', () => {
    // The registry is the single list the mapper scores headers against, the
    // export orders columns by and the correction forms validate against. A
    // column added to the table but not here would import as nothing, export as
    // nothing, and be uncorrectable — while the database happily held it.
    const field = CANONICAL_FIELDS.find((f) => f.key === 'agentId');
    expect(field).toBeDefined();
    // `identifier`, not `text`: the codes come out of the .xlsb as both number
    // and string in one column, and they are ten-digit numerics that Excel will
    // reformat given the chance.
    expect(field!.kind).toBe('identifier');
    // Not required: the column arrived after go-live, and a required field would
    // block the commit of every workbook that predates it.
    expect(field!.required).toBe(false);
    // The header the June workbook actually uses is `agent code`.
    expect(field!.aliases).toContain('agentcode');
    expect(field!.aliases).toContain('agentid');
    // Never a bare `agent` — it would prefix-match an `Agent Name` column.
    expect(field!.aliases).not.toContain('agent');
  });

  it('is the one field the AGENT_ID category can target', () => {
    expect(CATEGORY_FIELDS.AGENT_ID).toEqual(['agentId']);
  });
});

describe('raising an Agent ID correction', () => {
  beforeEach(truncateAll);
  afterEach(clearStoredProofs);

  it('stores the request against agent_id with the field resolved server-side', async () => {
    const { rep, record } = await seed('3000000007');

    const result = await submitCorrection(rep, {
      category: 'AGENT_ID',
      appsNo: record.appsNo,
      proposedValue: '2000003060',
      description: 'Sourced by the branch agent, not the one on the dashboard.',
      files: [proof()],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [request] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, result.data.id));

    expect(request.category).toBe('AGENT_ID');
    // Never taken from the payload — `targetFieldFor` reads CATEGORY_FIELDS.
    expect(request.fieldName).toBe('agentId');
    expect(request.fieldLabel).toBe('Agent ID');
    expect(request.originalValue).toBe('3000000007');
    expect(request.proposedValue).toBe('2000003060');
    expect(request.status).toBe('PENDING');
    // Direction belongs to MAPPING and nothing else — the
    // `correction_direction_iff_mapping` CHECK would have refused a value here.
    expect(request.direction).toBeNull();
  });

  it('needs no description, unlike an Others request', async () => {
    const { rep, record } = await seed(null);

    const result = await submitCorrection(rep, {
      category: 'AGENT_ID',
      appsNo: record.appsNo,
      proposedValue: '2000003060',
      files: [proof()],
    });

    // The category names the field, so there is nothing for a description to
    // disambiguate. `correction_others_requires_description` is scoped to
    // OTHERS precisely so a named category is not dragged into its rule.
    expect(result.ok).toBe(true);
  });

  it('still refuses a submission with no proof', async () => {
    const { rep, record } = await seed();

    const result = await submitCorrection(rep, {
      category: 'AGENT_ID',
      appsNo: record.appsNo,
      proposedValue: '2000003060',
      files: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at least one proof/i);
  });

  it('refuses a blank agent ID, including the source workbook sentinels', async () => {
    const { rep, record } = await seed();

    // `-` is the source file's way of saying "no value" — 86% of some columns.
    // Accepting it here would let a correction write the literal hyphen the
    // importer exists to turn into NULL.
    for (const blank of ['   ', '-', 'N/A']) {
      const result = await submitCorrection(rep, {
        category: 'AGENT_ID',
        appsNo: record.appsNo,
        proposedValue: blank,
        files: [proof()],
      });
      expect(result.ok).toBe(false);
    }

    expect(
      await db.select().from(correctionRequest).where(eq(correctionRequest.recordId, record.id)),
    ).toHaveLength(0);
  });

  it('refuses a value the record already holds', async () => {
    const { rep, record } = await seed('3000000007');

    const result = await submitCorrection(rep, {
      category: 'AGENT_ID',
      appsNo: record.appsNo,
      proposedValue: '3000000007',
      files: [proof()],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already holds that value/i);
  });

  it('stays bound by scope — a rep cannot correct another rep’s record', async () => {
    const { rep } = await seed();

    const [other] = await db
      .insert(salesRecord)
      .values({ appsNo: '9999999999', smId: 'C2CM21350', status: 'ISSUED' })
      .returning();

    const result = await submitCorrection(rep, {
      category: 'AGENT_ID',
      appsNo: other.appsNo,
      proposedValue: '2000003060',
      files: [proof()],
    });

    // The cross-book exception is MAPPING's alone. A new category does not
    // inherit it.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No record for application 9999999999/i);
  });
});

describe('approving an Agent ID correction', () => {
  beforeEach(truncateAll);
  afterEach(clearStoredProofs);

  it('writes agent_id and bumps the record version', async () => {
    const { rep, verifier, approver, record } = await seed('3000000007');

    const submitted = await submitCorrection(rep, {
      category: 'AGENT_ID',
      appsNo: record.appsNo,
      proposedValue: '2000003060',
      files: [proof()],
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    await verifyRequest({ requestId: submitted.data.id, actor: verifier });

    const outcome = await applyApproval({ requestId: submitted.data.id, actor: approver });

    expect(outcome.fieldName).toBe('agentId');
    expect(outcome.fieldLabel).toBe('Agent ID');
    expect(outcome.previousValue).toBe('3000000007');
    expect(outcome.newValue).toBe('2000003060');

    const [after] = await db.select().from(salesRecord).where(eq(salesRecord.id, record.id));
    expect(after.agentId).toBe('2000003060');
    expect(after.currentVersion).toBe(2);
    expect(after.hasCorrections).toBe(true);

    // The agent changed hands; the sale did not. Moving a record between reps is
    // MAPPING's job, and a category that quietly did both would reassign books
    // without either rep being told.
    expect(after.smId).toBe(OWNER);
    expect(after.smName).toBe('Owner Rep');
  });

  it('ignores a tampered field_name and still writes agent_id', async () => {
    const { rep, verifier, approver, record } = await seed('3000000007');

    const submitted = await submitCorrection(rep, {
      category: 'AGENT_ID',
      appsNo: record.appsNo,
      proposedValue: '2000003060',
      files: [proof()],
    });
    if (!submitted.ok) throw new Error(submitted.error);

    // `category` is a database enum and cannot hold anything outside its five
    // values; `field_name` is text a client wrote. Where the category pins one
    // field, the category wins — this is the whole reason AGENT_ID is an enum
    // value rather than an OTHERS request naming a field.
    await db
      .update(correctionRequest)
      .set({ fieldName: 'anp', fieldLabel: 'ANP (annualised new premium)' })
      .where(eq(correctionRequest.id, submitted.data.id));

    await verifyRequest({ requestId: submitted.data.id, actor: verifier });
    const outcome = await applyApproval({ requestId: submitted.data.id, actor: approver });

    expect(outcome.fieldName).toBe('agentId');

    const [after] = await db.select().from(salesRecord).where(eq(salesRecord.id, record.id));
    expect(after.agentId).toBe('2000003060');
    expect(after.anp).toBeNull();
  });

  it('holds the field against a second open request', async () => {
    const { rep, record } = await seed('3000000007');

    const first = await submitCorrection(rep, {
      category: 'AGENT_ID',
      appsNo: record.appsNo,
      proposedValue: '2000003060',
      files: [proof()],
    });
    expect(first.ok).toBe(true);

    const second = await submitCorrection(rep, {
      category: 'AGENT_ID',
      appsNo: record.appsNo,
      proposedValue: '59L0000000',
      files: [proof()],
    });

    // `correction_one_open_per_field` is keyed on (record_id, field_name) and
    // needed no change for the new category — which is the point of resolving
    // the field from the registry rather than letting each category invent one.
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already has an open correction/i);
  });
});
