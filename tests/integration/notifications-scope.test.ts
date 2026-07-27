import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { notification } from '@/db/schema';
import {
  notify,
  notifyActiveApprovers,
  notifyMany,
  notifySalesForBatch,
} from '@/lib/notifications/service';
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  recentNotifications,
} from '@/lib/notifications/queries';
import { makeUser, truncateAll } from '../helpers/db';

async function idsFor(userId: string) {
  const rows = await db
    .select({ id: notification.id })
    .from(notification)
    .where(eq(notification.userId, userId));
  return rows.map((r) => r.id);
}

describe('notification ownership (spec 10)', () => {
  beforeEach(truncateAll);

  /**
   * The one test this whole slice exists to pass.
   *
   * A notification carries the title and deep link of a correction request. If
   * a mark-read could be pointed at somebody else's row, the same scoping bug
   * would let the feed be read as well as written.
   */
  it("refuses to mark another user's notification read", async () => {
    const owner = await makeUser({ role: 'sales', smId: 'C2CM21350' });
    const intruder = await makeUser({ role: 'sales', smId: 'ICCSP90766' });

    await notify({
      userId: owner.id,
      type: 'CORRECTION_APPROVED',
      title: 'Your correction was approved',
      link: '/sales/requests/abc',
    });

    const [target] = await idsFor(owner.id);

    expect(await markRead(intruder.id, target)).toBe(false);

    const [row] = await db.select().from(notification).where(eq(notification.id, target));
    expect(row.isRead).toBe(false);
    expect(row.readAt).toBeNull();

    // And the owner still can.
    expect(await markRead(owner.id, target)).toBe(true);
  });

  it('reports the same "not found" for a nonexistent id as for one that is not yours', async () => {
    const intruder = await makeUser({ role: 'sales', smId: 'ICCSP90766' });
    expect(await markRead(intruder.id, '00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('marks read idempotently without rewriting when it was first seen', async () => {
    const owner = await makeUser({ role: 'sales', smId: 'C2CM21350' });
    await notify({ userId: owner.id, type: 'EXPORT_READY', title: 'Export ready' });
    const [target] = await idsFor(owner.id);

    expect(await markRead(owner.id, target)).toBe(true);
    const [first] = await db.select().from(notification).where(eq(notification.id, target));

    expect(await markRead(owner.id, target)).toBe(true);
    const [second] = await db.select().from(notification).where(eq(notification.id, target));

    expect(second.readAt?.getTime()).toBe(first.readAt?.getTime());
  });

  it("never leaks another user's rows into the feed", async () => {
    const owner = await makeUser({ role: 'sales', smId: 'C2CM21350' });
    const other = await makeUser({ role: 'sales', smId: 'ICCSP90766' });

    await notifyMany([
      { userId: owner.id, type: 'CORRECTION_APPROVED', title: 'Mine' },
      { userId: other.id, type: 'CORRECTION_REJECTED', title: 'Theirs' },
    ]);

    const feed = await recentNotifications(owner.id);
    expect(feed.map((n) => n.title)).toEqual(['Mine']);

    const listed = await listNotifications(owner.id, { limit: 25, offset: 0 });
    expect(listed.total).toBe(1);
  });
});

describe('unread count and mark-all-read (spec 10)', () => {
  beforeEach(truncateAll);

  it("counts only this user's unread rows", async () => {
    const owner = await makeUser({ role: 'sales', smId: 'C2CM21350' });
    const other = await makeUser({ role: 'sales', smId: 'ICCSP90766' });

    await notifyMany([
      { userId: owner.id, type: 'CORRECTION_APPROVED', title: 'One' },
      { userId: owner.id, type: 'CORRECTION_REJECTED', title: 'Two' },
      { userId: owner.id, type: 'CORRECTION_RETURNED', title: 'Three' },
      { userId: other.id, type: 'BATCH_COMMITTED', title: 'Not mine' },
    ]);

    expect(await countUnread(owner.id)).toBe(3);

    const [first] = await idsFor(owner.id);
    await markRead(owner.id, first);
    expect(await countUnread(owner.id)).toBe(2);
    expect(await countUnread(other.id)).toBe(1);
  });

  it("marks all of one user's unread rows and nobody else's", async () => {
    const owner = await makeUser({ role: 'sales', smId: 'C2CM21350' });
    const other = await makeUser({ role: 'sales', smId: 'ICCSP90766' });

    await notifyMany([
      { userId: owner.id, type: 'CORRECTION_APPROVED', title: 'One' },
      { userId: owner.id, type: 'CORRECTION_REJECTED', title: 'Two' },
      { userId: other.id, type: 'BATCH_COMMITTED', title: 'Not mine' },
    ]);

    expect(await markAllRead(owner.id)).toBe(2);
    expect(await countUnread(owner.id)).toBe(0);
    expect(await countUnread(other.id)).toBe(1);

    // A second call has nothing left to do and must not claim otherwise.
    expect(await markAllRead(owner.id)).toBe(0);
  });

  it('orders the feed unread first, then newest — the index order', async () => {
    const owner = await makeUser({ role: 'sales', smId: 'C2CM21350' });

    await notify({ userId: owner.id, type: 'CORRECTION_APPROVED', title: 'Older' });
    await notify({ userId: owner.id, type: 'CORRECTION_REJECTED', title: 'Newer' });

    // Read the NEWER one: newest-first alone would still put it on top, so the
    // assertion below only passes if unread genuinely outranks recency.
    const [newer] = await db
      .select({ id: notification.id })
      .from(notification)
      .where(and(eq(notification.userId, owner.id), eq(notification.title, 'Newer')));
    await markRead(owner.id, newer.id);

    const feed = await recentNotifications(owner.id);
    expect(feed[0].title).toBe('Older');
    expect(feed[0].isRead).toBe(false);
    expect(feed[1].isRead).toBe(true);
  });

  it('paginates newest first', async () => {
    const owner = await makeUser({ role: 'sales', smId: 'C2CM21350' });

    for (let i = 0; i < 5; i += 1) {
      await notify({ userId: owner.id, type: 'BATCH_COMMITTED', title: `Item ${i}` });
    }

    const first = await listNotifications(owner.id, { limit: 2, offset: 0 });
    expect(first.total).toBe(5);
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0].title).toBe('Item 4');

    const second = await listNotifications(owner.id, { limit: 2, offset: 2 });
    expect(second.rows.map((r) => r.title)).toEqual(['Item 2', 'Item 1']);

    const unreadOnly = await listNotifications(owner.id, { limit: 25, offset: 0, unreadOnly: true });
    expect(unreadOnly.total).toBe(5);

    await markAllRead(owner.id);
    const afterRead = await listNotifications(owner.id, { limit: 25, offset: 0, unreadOnly: true });
    expect(afterRead.total).toBe(0);
  });
});

describe('fan-out to approvers (spec 10, row 1)', () => {
  beforeEach(truncateAll);

  /**
   * A deactivated approver cannot sign in, so a notification addressed to them
   * is delivered nowhere and inflates a count nobody will ever clear.
   */
  it('reaches active approvers only', async () => {
    const activeOne = await makeUser({ role: 'approver', smId: null });
    const activeTwo = await makeUser({ role: 'approver', smId: null });
    const retired = await makeUser({ role: 'approver', smId: null, isActive: false });
    const salesUser = await makeUser({ role: 'sales', smId: 'C2CM21350' });
    const admin = await makeUser({ role: 'admin', smId: null });

    const sent = await notifyActiveApprovers({
      type: 'CORRECTION_SUBMITTED',
      title: 'New correction request',
      link: '/approver/queue',
    });

    expect(sent).toBe(2);
    expect(await countUnread(activeOne.id)).toBe(1);
    expect(await countUnread(activeTwo.id)).toBe(1);
    expect(await countUnread(retired.id)).toBe(0);
    expect(await countUnread(salesUser.id)).toBe(0);
    expect(await countUnread(admin.id)).toBe(0);
  });

  it('skips a deactivated sales rep when a batch commits', async () => {
    const active = await makeUser({ role: 'sales', smId: 'C2CM21350' });
    const retired = await makeUser({ role: 'sales', smId: 'ICCSP90766', isActive: false });

    const sent = await notifySalesForBatch(
      new Map([
        ['C2CM21350', 4],
        ['ICCSP90766', 9],
      ]),
      "Jun'26",
    );

    expect(sent).toBe(1);
    expect(await countUnread(active.id)).toBe(1);
    expect(await countUnread(retired.id)).toBe(0);

    const [row] = await recentNotifications(active.id);
    expect(row.body).toContain('4');
    expect(row.link).toBe('/sales/records');
  });
});
