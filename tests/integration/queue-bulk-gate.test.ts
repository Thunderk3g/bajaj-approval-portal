import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { correctionRequest, salesRecord, salesRecordVersion } from '@/db/schema';
import { APPROVABLE_STATUS } from '@/lib/approvals/apply';
import type { SessionUser } from '@/lib/auth/rbac';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * The batch bar and the checkboxes must describe the SAME rows.
 *
 * Two places decide which requests a queue can act on, and they are in different
 * files: the page builds `appsNoById` by filtering on the queue's home status,
 * and `QueueTable` renders a checkbox on that same predicate. Nothing in the
 * type system ties them together. Drifted apart, the failures are quiet and
 * opposite — a bar that says "select all 12" over 8 checkboxes, or checkboxes on
 * rows every decision will refuse — and both look like a working screen.
 *
 * Written in the spirit of `approver-page-gate.test.ts`: the domain rule is
 * tested elsewhere and is not re-tested here. What is asserted is that the
 * SCREEN agrees with it, because a gate asserted on one side of a boundary is
 * not asserted.
 */

const session = vi.hoisted(() => ({ user: null as SessionUser | null }));

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

/** The first element of a given component type anywhere in the tree. */
function findElement(node: unknown, component: unknown): ReactElement | null {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, component);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  const element = node as ReactElement;
  if (element.type === component) return element;

  const props = (element.props ?? {}) as Record<string, unknown>;
  for (const value of Object.values(props)) {
    const found = findElement(value, component);
    if (found) return found;
  }
  return null;
}

/** Every `<input name="requestIds">` value in a tree, in document order. */
function checkboxValues(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (Array.isArray(node)) return node.flatMap(checkboxValues);
  if (typeof node !== 'object') return [];

  const element = node as ReactElement;
  const props = (element.props ?? {}) as Record<string, unknown>;

  if (element.type === 'input' && props.name === 'requestIds' && props.type === 'checkbox') {
    return [String(props.value)];
  }

  return Object.values(props).flatMap(checkboxValues);
}

async function seedQueue(statuses: Array<'PENDING' | 'VERIFIED' | 'RETURNED'>, role: 'approver' | 'verifier') {
  const rep = await makeUser({ role: 'sales', smId: OWNER, name: 'Shikha Singh' });
  const reviewer = await makeUser({ role, smId: null, name: `Test ${role}` });

  session.user = {
    id: reviewer.id,
    email: reviewer.email,
    role,
    smId: null,
    isActive: true,
    name: reviewer.name,
  } as SessionUser;

  const byStatus = new Map<string, string[]>();

  for (const [i, status] of statuses.entries()) {
    const [record] = await db
      .insert(salesRecord)
      .values({
        appsNo: `61675095${String(i).padStart(2, '0')}`,
        smId: OWNER,
        clientName: `Client ${i}`,
        autopay: 'Yes',
      })
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
        category: 'AUTOPAY',
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        originalValue: 'Yes',
        proposedValue: 'No',
        status,
      })
      .returning();

    byStatus.set(status, [...(byStatus.get(status) ?? []), request.id]);
  }

  return byStatus;
}

/**
 * Renders the page, then invokes the `QueueTable` element it produced.
 *
 * A page returns unrendered child elements, so the checkboxes do not exist until
 * the table function is called with the props the page chose. Calling it here —
 * rather than asserting on the props the page passed — is what makes this a test
 * of the two predicates AGREEING rather than a restatement of one of them.
 */
async function renderQueue(path: string, params: Record<string, string>) {
  const { default: Page } = await import(path);
  const { BulkDecisions } = await import('@/components/approvals/bulk-decisions');
  const { QueueTable } = await import('@/components/approvals/queue-table');

  const tree = await Page({ searchParams: Promise.resolve(params) });
  const bar = findElement(tree, BulkDecisions);
  const table = findElement(tree, QueueTable);

  const barIds = bar
    ? Object.keys((bar.props as { appsNoById: Record<string, string> }).appsNoById)
    : [];

  const boxIds = table
    ? checkboxValues(QueueTable((table.props ?? {}) as Parameters<typeof QueueTable>[0]))
    : [];

  return { bar, table, barIds, boxIds };
}

describe('the approver queue offers batching for exactly the rows it can decide', () => {
  beforeEach(async () => {
    await truncateAll();
    session.user = null;
  });

  it('checkboxes and the batch bar name the same requests', async () => {
    // Scope OPEN, so the list deliberately MIXES all three open statuses. This
    // is the only scope where the two predicates can disagree observably, which
    // is why it is the one under test.
    const seeded = await seedQueue(['PENDING', 'VERIFIED', 'RETURNED', 'VERIFIED'], 'approver');

    const { barIds, boxIds } = await renderQueue('@/app/approver/queue/page', { scope: 'OPEN' });

    const decidable = seeded.get(APPROVABLE_STATUS)!;
    expect(new Set(boxIds)).toEqual(new Set(decidable));
    expect(new Set(barIds)).toEqual(new Set(decidable));

    // Stated separately from the two set comparisons above. Those could both
    // hold against a future edit that changed one predicate and the seed
    // together; this says the mixed list really was mixed.
    expect(boxIds).toHaveLength(2);
  });

  it('offers no checkbox on a request still with the verifier', async () => {
    const seeded = await seedQueue(['PENDING'], 'approver');

    const { boxIds } = await renderQueue('@/app/approver/queue/page', { scope: 'OPEN' });

    // A PENDING row is upstream of the approver. Batched, every one of them
    // would come back refused by the verifier gate — the absent checkbox says so
    // before the click rather than after it.
    expect(boxIds).toEqual([]);
    expect(seeded.get('PENDING')).toHaveLength(1);
  });

  it('drops the bar entirely when nothing on the page is actionable', async () => {
    await seedQueue(['RETURNED', 'RETURNED'], 'approver');

    const { bar, boxIds } = await renderQueue('@/app/approver/queue/page', { scope: 'RETURNED' });

    // The element is still in the tree; what it must not do is render a bar of
    // buttons that could only ever refuse. `BulkDecisions` returns its children
    // bare when the map is empty, which is what the empty map here drives.
    expect(bar).not.toBeNull();
    expect(Object.keys((bar!.props as { appsNoById: Record<string, string> }).appsNoById)).toEqual(
      [],
    );
    expect(boxIds).toEqual([]);
  });
});

describe('the verifier queue batches on its own home status', () => {
  beforeEach(async () => {
    await truncateAll();
    session.user = null;
  });

  it('offers checkboxes for PENDING, not for what it has already passed on', async () => {
    const seeded = await seedQueue(['PENDING', 'VERIFIED', 'PENDING'], 'verifier');

    const { barIds, boxIds } = await renderQueue('@/app/verifier/queue/page', { scope: 'OPEN' });

    // The two stages work on different statuses, and the shared table takes that
    // as a prop. A verifier batching VERIFIED rows would be trying to re-verify
    // work already sitting with an approver.
    const mine = seeded.get('PENDING')!;
    expect(new Set(boxIds)).toEqual(new Set(mine));
    expect(new Set(barIds)).toEqual(new Set(mine));
    expect(boxIds).not.toContain(seeded.get('VERIFIED')![0]);
  });
});
