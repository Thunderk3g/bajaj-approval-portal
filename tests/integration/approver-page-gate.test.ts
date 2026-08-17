import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  correctionRequest,
  correctionRequestStage,
  correctionStatusEnum,
  salesRecord,
  salesRecordVersion,
} from '@/db/schema';
import { APPROVABLE_STATUS } from '@/lib/approvals/apply';
import type { SessionUser } from '@/lib/auth/rbac';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * The approver's decision screen renders its form when its own rung is open.
 *
 * This file exists because its absence shipped a bug, and it has now caught the
 * SECOND instance of the same one. The form was first gated on
 * `status === 'PENDING'`, which the verifier stage broke; then on
 * `status === APPROVABLE_STATUS` (VERIFIED), which the N-stage engine broke the
 * same way, because `advance` sets VERIFIED after ANY non-final rung passes. On
 * a five-rung mapping chain a request parked with a team leader is VERIFIED, so
 * the screen offered an approve button that `assertMayDecide` then refused.
 *
 * A status can no longer answer "is this mine". The gate is the ACTIVE row in
 * `correction_request_stage`, and these tests seed that row explicitly — which
 * is why every case below says which rung is open rather than which status the
 * request holds.
 *
 * The whole suite stayed green through that, and the reason is worth stating,
 * because it is the thing this file fixes rather than the bug itself. The DOMAIN
 * gate was never wrong — `decideStageWithin` takes the request row `FOR UPDATE`
 * and then asks `assertMayDecide` about the ACTIVE stage, and
 * `verification-flow.test.ts` covers it thoroughly. Only the screen disagreed
 * with it, and nothing anywhere looked at the screen. A gate asserted on one
 * side of a boundary is not asserted.
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

async function seed(
  status: (typeof correctionStatusEnum.enumValues)[number],
  openStage: 'APPROVER' | 'V1' | null = 'APPROVER',
) {
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
      totalStages: 2,
    })
    .returning();

  // The open rung, which is now the whole gate. `null` means no stage is open —
  // a decided or withdrawn request — and is the shape the sweep below uses.
  if (openStage) {
    await db.insert(correctionRequestStage).values({
      requestId: request.id,
      sequence: openStage === 'APPROVER' ? 1 : 0,
      stageKey: openStage,
      resolverKey: 'ROLE',
      resolverConfig: { role: openStage === 'APPROVER' ? 'approver' : 'verifier' },
      canReject: openStage === 'APPROVER',
      status: 'ACTIVE',
    });
  }

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

  it('offers the decision form when the approver rung is the open one', async () => {
    const { DecisionForm } = await import('@/components/approvals/decision-form');
    const tree = await render(await seed(APPROVABLE_STATUS, 'APPROVER'));

    expect(contains(tree, DecisionForm)).toBe(true);
  });

  /**
   * The regression itself, stated as its own case rather than left implicit in
   * the sweep below. PENDING is not "already decided" — it is waiting on the
   * verifier — and telling an approver otherwise about a request that will
   * shortly be theirs is the specific wrong sentence that was on screen.
   */
  it('tells the approver an earlier rung is open, not that the request is closed', async () => {
    const { DecisionForm } = await import('@/components/approvals/decision-form');
    const tree = await render(await seed('PENDING', 'V1'));
    const text = textOf(tree);

    expect(contains(tree, DecisionForm)).toBe(false);
    // Names the rung that is actually open, so the approver knows who to chase.
    expect(text).toContain('V1');
    expect(text).not.toContain('cannot be decided again');
  });

  /**
   * The case a STATUS gate could not express at all, and the reason it had to
   * go: VERIFIED with somebody else's rung open. Under the old gate this
   * rendered the approve button, and the engine refused the click.
   */
  it('refuses the form for a VERIFIED request whose open rung belongs to someone else', async () => {
    const { DecisionForm } = await import('@/components/approvals/decision-form');
    const tree = await render(await seed(APPROVABLE_STATUS, 'V1'));

    expect(contains(tree, DecisionForm)).toBe(false);
    expect(textOf(tree)).toContain('V1');
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
    it(`refuses to offer the decision form for a ${status} request with no open rung`, async () => {
      const { DecisionForm } = await import('@/components/approvals/decision-form');
      const tree = await render(await seed(status, null));

      expect(contains(tree, DecisionForm)).toBe(false);
    });
  }

  it('reads the open rung rather than any status literal', async () => {
    // Not tautological: it pins the direction of the dependency. Twice now the
    // page has been gated on a status that was correct the day it was written
    // and quietly wrong a release later. Asking the stage table is the only form
    // of this gate that cannot go stale, so the source is asserted to keep
    // asking it — a literal creeping back in would leave every case above green
    // while the screen stopped tracking the engine again.
    const pageSource = await import('node:fs/promises').then((fs) =>
      fs.readFile('src/app/approver/requests/[id]/page.tsx', 'utf8'),
    );

    expect(pageSource).toContain('openStageFor');
    expect(pageSource).not.toMatch(/const isOpen = request\.status/);
  });
});
