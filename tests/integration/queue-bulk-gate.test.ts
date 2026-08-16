import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  correctionRequest,
  correctionRequestStage,
  salesRecord,
  salesRecordVersion,
} from '@/db/schema';
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

    // The open rung. `MINE` selects on this and nothing else, so a seed without
    // it would make every stage-scoped assertion below vacuously empty.
    //
    // Deliberately the reviewer's OWN role at every status, including RETURNED:
    // that is the combination a status gate could never express and the one the
    // old per-row `status === homeStatus` filter got wrong in both directions.
    await db.insert(correctionRequestStage).values({
      requestId: request.id,
      sequence: 0,
      stageKey: role === 'approver' ? 'APPROVER' : 'V1',
      resolverKey: 'ROLE',
      resolverConfig: { role },
      canReject: role === 'approver',
      status: 'ACTIVE',
    });

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

  it('checkboxes every row of the MINE scope, and the bar names the same ones', async () => {
    // The positive half. Every row here is at this approver's own rung — which
    // is exactly what `MINE` selects for — so all of them are batchable
    // regardless of the coarse status they happen to carry.
    const seeded = await seedQueue(['PENDING', 'VERIFIED', 'RETURNED', 'VERIFIED'], 'approver');
    const everything = [...seeded.values()].flat();

    const { barIds, boxIds } = await renderQueue('@/app/approver/queue/page', { scope: 'MINE' });

    expect(new Set(boxIds)).toEqual(new Set(barIds));
    expect(new Set(boxIds)).toEqual(new Set(everything));
    expect(boxIds).toHaveLength(4);
  });

  it('checkboxes and the batch bar name the same requests', async () => {
    // Scope OPEN, which deliberately mixes rungs. Selection is now a property of
    // the SCOPE rather than of each row's status — only `MINE` is guaranteed to
    // contain rungs the viewer may decide — so the correct answer here is that
    // nothing is selectable at all, and the two predicates must agree on that
    // just as strictly as they agreed on a subset before.
    const seeded = await seedQueue(['PENDING', 'VERIFIED', 'RETURNED', 'VERIFIED'], 'approver');

    const { barIds, boxIds } = await renderQueue('@/app/approver/queue/page', { scope: 'OPEN' });

    expect(new Set(boxIds)).toEqual(new Set(barIds));
    expect(boxIds).toEqual([]);

    // Stated separately, so this case cannot pass by seeding an empty queue:
    // the mixed list really was mixed.
    expect(seeded.get(APPROVABLE_STATUS)).toHaveLength(2);
  });

  it('offers no checkbox on a request parked at somebody else s rung', async () => {
    const seeded = await seedQueue(['PENDING'], 'approver');

    const { boxIds } = await renderQueue('@/app/approver/queue/page', { scope: 'OPEN' });

    // Batched, every one of these would come back refused by the engine — the
    // absent checkbox says so before the click rather than after it.
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

describe('the verifier queue batches on its own open rung', () => {
  beforeEach(async () => {
    await truncateAll();
    session.user = null;
  });

  /**
   * The case the old status gate got wrong, now asserted from the other side.
   *
   * Every request here is seeded with an ACTIVE verifier rung, and one of them
   * carries status VERIFIED — the shape a three-rung chain produces once the
   * first verification passes and a SECOND verification step opens. The old
   * filter (`status === 'PENDING'`) refused that row a checkbox and, before the
   * queue itself was fixed, refused to list it at all: a rung open, decidable by
   * this very person, and offered by no screen in the product.
   */
  it('offers checkboxes for every rung that is open to it, whatever the status says', async () => {
    const seeded = await seedQueue(['PENDING', 'VERIFIED', 'PENDING'], 'verifier');
    const everything = [...seeded.values()].flat();

    const { barIds, boxIds } = await renderQueue('@/app/verifier/queue/page', { scope: 'MINE' });

    expect(new Set(boxIds)).toEqual(new Set(barIds));
    expect(new Set(boxIds)).toEqual(new Set(everything));
    expect(boxIds).toContain(seeded.get('VERIFIED')![0]);
  });

  it('offers no checkbox in a scope that mixes other people rungs', async () => {
    await seedQueue(['PENDING', 'VERIFIED', 'PENDING'], 'verifier');

    const { barIds, boxIds } = await renderQueue('@/app/verifier/queue/page', { scope: 'OPEN' });

    expect(boxIds).toEqual([]);
    expect(barIds).toEqual([]);
  });
});
