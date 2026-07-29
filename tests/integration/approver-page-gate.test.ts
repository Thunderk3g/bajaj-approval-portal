import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { correctionRequest, correctionStatusEnum, salesRecord, salesRecordVersion } from '@/db/schema';
import { APPROVABLE_STATUS } from '@/lib/approvals/apply';
import type { SessionUser } from '@/lib/auth/rbac';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * The approver's decision screen renders its form for exactly one status.
 *
 * This file exists because its absence shipped a bug. The decision form was
 * gated on `status === 'PENDING'`, which was right until the verifier stage
 * landed and wrong from that same commit onward: after it, an approvable request
 * is VERIFIED, so the one state where approval is legal was the one state that
 * rendered "this request cannot be decided again". An approver had no approve
 * button precisely when the request was ready for them.
 *
 * The whole suite stayed green through that, and the reason is worth stating,
 * because it is the thing this file fixes rather than the bug itself. The DOMAIN
 * gate was never wrong — `decideWithin` locks on
 * `WHERE status = APPROVABLE_STATUS` and `verification-flow.test.ts` covers it
 * thoroughly. Only the screen disagreed with it, and nothing anywhere looked at
 * the screen. A gate asserted on one side of a boundary is not asserted.
 *
 * So these tests deliberately do NOT re-test the domain rule. They test that the
 * page agrees with it, for every status the enum can hold — including the ones
 * added after the page was written, which is the case that broke.
 */

const session = vi.hoisted(() => ({ user: null as SessionUser | null }));

/**
 * Only the session SOURCE is faked, so the page's own `requireRole('approver')`
 * runs for real. Stubbing `requireRole` would move the rule into the mock.
 */
vi.mock('@/lib/auth/server', () => ({
  auth: {
    api: {
      getSession: async () => (session.user ? { user: session.user } : null),
    },
  },
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
}));

const OWNER = 'ICCS427343';

/**
 * Walks a rendered element tree for a component, by identity rather than by name.
 *
 * By identity because a name match would keep passing if the page swapped
 * `DecisionForm` for a lookalike, and because minified names are not stable. The
 * tree is small — one page — so the recursion is cheap.
 */
function contains(node: unknown, component: unknown): boolean {
  if (node === null || node === undefined || typeof node === 'boolean') return false;
  if (Array.isArray(node)) return node.some((child) => contains(child, component));
  if (typeof node !== 'object') return false;

  const element = node as ReactElement<{ children?: unknown }>;
  if (element.type === component) return true;

  const props = (element.props ?? {}) as Record<string, unknown>;
  return Object.values(props).some((value) => contains(value, component));
}

/** Every string the tree carries, flattened — for asserting on wording. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node !== 'object') return '';

  const props = ((node as ReactElement).props ?? {}) as Record<string, unknown>;
  return Object.values(props).map(textOf).join(' ');
}

async function seed(status: (typeof correctionStatusEnum.enumValues)[number]) {
  const rep = await makeUser({ role: 'sales', smId: OWNER, name: 'Shikha Singh' });
  const approver = await makeUser({ role: 'approver', smId: null, name: 'Anand Approver' });

  session.user = {
    id: approver.id,
    email: approver.email,
    role: 'approver',
    smId: null,
    isActive: true,
    name: approver.name,
  } as SessionUser;

  const [record] = await db
    .insert(salesRecord)
    .values({ appsNo: '6167509575', smId: OWNER, clientName: 'Meera Nair', autopay: 'Yes' })
    .returning();

  await db.insert(salesRecordVersion).values({
    recordId: record.id,
    version: 1,
    data: record as unknown as Record<string, unknown>,
    changeType: 'IMPORT',
  });

  const [request] = await db
    .insert(correctionRequest)
    .values({
      recordId: record.id,
      submittedBy: rep.id,
      smId: OWNER,
      appsNo: record.appsNo,
      // AUTOPAY rather than OTHERS: it resolves to a real field on
      // `sales_record`, so `previewTarget` produces a comparison instead of the
      // "cannot be applied as it stands" banner, and the page under test is the
      // ordinary one rather than an error path.
      category: 'AUTOPAY',
      fieldName: 'autopay',
      fieldLabel: 'AutoPay',
      originalValue: 'Yes',
      proposedValue: 'No',
      description: 'Mandate was cancelled by the customer.',
      status,
    })
    .returning();

  return request.id;
}

async function render(requestId: string) {
  const { default: RequestDecisionPage } = await import('@/app/approver/requests/[id]/page');
  return RequestDecisionPage({ params: Promise.resolve({ id: requestId }) });
}

describe('the approver decision screen', () => {
  beforeEach(async () => {
    await truncateAll();
    session.user = null;
  });

  it('offers the decision form for a verified request', async () => {
    const { DecisionForm } = await import('@/components/approvals/decision-form');
    const tree = await render(await seed(APPROVABLE_STATUS));

    expect(contains(tree, DecisionForm)).toBe(true);
  });

  /**
   * The regression itself, stated as its own case rather than left implicit in
   * the sweep below. PENDING is not "already decided" — it is waiting on the
   * verifier — and telling an approver otherwise about a request that will
   * shortly be theirs is the specific wrong sentence that was on screen.
   */
  it('tells the approver a pending request is still with the verifier, not that it is closed', async () => {
    const { DecisionForm } = await import('@/components/approvals/decision-form');
    const tree = await render(await seed('PENDING'));
    const text = textOf(tree);

    expect(contains(tree, DecisionForm)).toBe(false);
    expect(text).toContain('verifier');
    expect(text).not.toContain('cannot be decided again');
  });

  /**
   * Driven off the enum, not off a list written here.
   *
   * A hand-written list is exactly what failed the first time: the page's status
   * literal was correct on the day it was written and nobody revisited it when
   * the enum grew. Iterating `correctionStatusEnum.enumValues` means a status
   * added tomorrow arrives in this test on its own, and has to be classified
   * deliberately rather than by omission.
   */
  for (const status of correctionStatusEnum.enumValues) {
    if (status === APPROVABLE_STATUS) continue;

    it(`refuses to offer the decision form for a ${status} request`, async () => {
      const { DecisionForm } = await import('@/components/approvals/decision-form');
      const tree = await render(await seed(status));

      expect(contains(tree, DecisionForm)).toBe(false);
    });
  }

  it('gates on the same constant the database locks on', async () => {
    // Not tautological: it pins the direction of the dependency. The page imports
    // APPROVABLE_STATUS from the module that owns the lock predicate, so the two
    // cannot drift. If someone replaces that import with a literal, the tests
    // above keep passing today and silently stop tracking the gate tomorrow.
    const pageSource = await import('node:fs/promises').then((fs) =>
      fs.readFile('src/app/approver/requests/[id]/page.tsx', 'utf8'),
    );

    expect(pageSource).toContain('APPROVABLE_STATUS');
    expect(pageSource).not.toMatch(/const isOpen = request\.status === '/);
  });
});
