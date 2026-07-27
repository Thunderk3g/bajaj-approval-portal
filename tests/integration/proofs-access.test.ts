import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog, correctionAttachment, salesRecord } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { deleteStoredProofs } from '@/lib/storage/files';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * `GET /api/proofs/[attachmentId]` — spec section 4.4.
 *
 * The session is the only thing stubbed. Everything else is real: a real
 * submission writes a real file to `storage/proofs/`, and the route reads it
 * back through the same authorization it uses in production.
 */
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));

vi.mock('@/lib/auth/rbac', () => ({
  requireSession: async () => {
    if (!session.user) throw new Error('UNAUTHENTICATED');
    return session.user;
  },
}));

const { GET } = await import('@/app/api/proofs/[attachmentId]/route');
const { submitCorrection } = await import('@/lib/corrections/service');

const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const OWNER_SM_ID = 'ICCSP90766';

function sessionFor(row: { id: string; name: string; email: string; role: string; smId: string | null }): SessionUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as SessionUser['role'],
    smId: row.smId,
    isActive: true,
  };
}

function get(attachmentId: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/proofs/${attachmentId}`), {
    params: Promise.resolve({ attachmentId }),
  });
}

/** Submits a real correction and returns the id of the proof it uploaded. */
async function seedAttachment(name = 'bank-mandate.png') {
  const submitter = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));

  await db.insert(salesRecord).values({
    appsNo: '6167509575',
    smId: OWNER_SM_ID,
    status: 'ISSUED',
  });

  session.user = submitter;
  const result = await submitCorrection(submitter, {
    category: 'AUTOPAY',
    appsNo: '6167509575',
    proposedValue: 'Yes',
    files: [{ name, bytes: PNG }],
  });
  if (!result.ok) throw new Error(result.error);

  const [attachment] = await db
    .select()
    .from(correctionAttachment)
    .where(eq(correctionAttachment.requestId, result.data.id));

  return { submitter, attachment };
}

describe('proof access control (spec 4.4)', () => {
  beforeEach(async () => {
    await truncateAll();
    session.user = null;
  });

  afterEach(async () => {
    const rows = await db.select({ path: correctionAttachment.storedPath }).from(correctionAttachment);
    await deleteStoredProofs(rows.map((r) => r.path));
  });

  it('serves the proof to the sales user who submitted it', async () => {
    const { submitter, attachment } = await seedAttachment();
    session.user = submitter;

    const response = await get(attachment.id);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it('serves it to an approver and to an admin', async () => {
    const { attachment } = await seedAttachment();

    for (const role of ['approver', 'admin'] as const) {
      session.user = sessionFor(await makeUser({ role, smId: null }));
      const response = await get(attachment.id);
      expect(response.status, role).toBe(200);
    }
  });

  it('returns 404 — not 403 — to a sales user who is not the submitter', async () => {
    // THE test for this route. A 403 would confirm the attachment exists, which
    // tells someone who guessed an id that the id was worth attacking. The same
    // 404 is returned for "no such attachment", "not yours" and "not signed in",
    // so the response carries no information about which it was.
    const { attachment } = await seedAttachment();
    session.user = sessionFor(await makeUser({ role: 'sales', smId: 'C2CM21350' }));

    const response = await get(attachment.id);

    expect(response.status).toBe(404);
    expect(response.status).not.toBe(403);
  });

  it('answers a real id and an unknown id identically', async () => {
    const { attachment } = await seedAttachment();
    session.user = sessionFor(await makeUser({ role: 'sales', smId: 'C2CM21350' }));

    const real = await get(attachment.id);
    const unknown = await get(randomUUID());
    const malformed = await get('not-a-uuid');

    expect([real.status, unknown.status, malformed.status]).toEqual([404, 404, 404]);
    expect(await real.text()).toBe(await unknown.text());
  });

  it('returns 404 with no session at all', async () => {
    const { attachment } = await seedAttachment();
    session.user = null;

    expect((await get(attachment.id)).status).toBe(404);
  });

  it('does not audit a view it refused', async () => {
    const { attachment } = await seedAttachment();
    session.user = sessionFor(await makeUser({ role: 'sales', smId: 'C2CM21350' }));

    await get(attachment.id);

    const views = await db.select().from(auditLog).where(eq(auditLog.action, 'ATTACHMENT_VIEW'));
    expect(views).toHaveLength(0);
  });
});

describe('proof response hardening (spec 4.4, 4.5)', () => {
  beforeEach(async () => {
    await truncateAll();
    session.user = null;
  });

  afterEach(async () => {
    const rows = await db.select({ path: correctionAttachment.storedPath }).from(correctionAttachment);
    await deleteStoredProofs(rows.map((r) => r.path));
  });

  it('sends nosniff and a CSP that permits nothing', async () => {
    const { submitter, attachment } = await seedAttachment();
    session.user = submitter;

    const response = await get(attachment.id);

    // Together these mean a file that somehow got past magic-byte validation
    // still cannot execute in the origin that is displaying it.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(response.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('sends a content-disposition carrying the original name', async () => {
    const { submitter, attachment } = await seedAttachment('bank mandate.png');
    session.user = submitter;

    const disposition = (await get(attachment.id)).headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^inline;/);
    expect(disposition).toContain('bank mandate.png');
  });

  it('writes an ATTACHMENT_VIEW audit row for every single view', async () => {
    const { submitter, attachment } = await seedAttachment();
    session.user = submitter;

    await get(attachment.id);
    await get(attachment.id);
    session.user = sessionFor(await makeUser({ role: 'approver', smId: null }));
    await get(attachment.id);

    const views = await db.select().from(auditLog).where(eq(auditLog.action, 'ATTACHMENT_VIEW'));
    // Three views, three rows — not one row per attachment. Customer documents
    // are exactly the thing you have to be able to say who looked at, and when.
    expect(views).toHaveLength(3);
    expect(views.map((v) => v.actorRole)).toEqual(['sales', 'sales', 'approver']);
    expect(views.every((v) => v.entityId === attachment.id)).toBe(true);
  });

  it('returns 404 when the row exists but the file is gone', async () => {
    const { submitter, attachment } = await seedAttachment();
    await deleteStoredProofs([attachment.storedPath]);
    session.user = submitter;

    expect((await get(attachment.id)).status).toBe(404);
  });
});
