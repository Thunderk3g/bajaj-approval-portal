import { and, count, eq, notInArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { manpower, user } from '@/db/schema';
import { PLACEHOLDER_CODE_LIST } from '@/lib/roster/placeholders';
import { Tabs } from '@/components/ui/tabs';

/**
 * One header over Users and Hierarchy — they answer halves of one question.
 *
 * "Who is this rep and can they sign in" and "who approves their corrections"
 * were two screens an admin bounced between: an account is useless without a
 * placement, and a placement routes to nobody without an account. The counts sit
 * on the tabs because the reason to switch is usually a number — reps with no
 * login, managers with no account.
 */
export async function PeopleTabs({ current }: { current: '/admin/users' | '/admin/hierarchy' }) {
  const [[accounts], [placed]] = await Promise.all([
    db.select({ value: count() }).from(user).where(eq(user.isActive, true)),
    // Buckets excluded, as they are on the screen this counts. A badge that says
    // 219 over a tree showing 217 people reads as two rows the page failed to
    // render.
    db
      .select({ value: count() })
      .from(manpower)
      .where(
        and(eq(manpower.isOrphan, false), notInArray(manpower.smId, PLACEHOLDER_CODE_LIST)),
      ),
  ]);

  return (
    <Tabs
      current={current}
      tabs={[
        { href: '/admin/users', label: 'Accounts', count: accounts?.value ?? 0 },
        { href: '/admin/hierarchy', label: 'Hierarchy', count: placed?.value ?? 0 },
      ]}
    />
  );
}
