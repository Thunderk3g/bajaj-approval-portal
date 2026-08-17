'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { manpower, manpowerOverride } from '@/db/schema';
import { requireRole } from '@/lib/auth/rbac';
import { writeAudit } from '@/lib/audit/log';
import { fail, ok, type ActionResult } from '@/lib/result';

/**
 * Editing the reporting line — 2026-08-06 spec section 5.
 *
 * Writes to `manpower_override`, never to `manpower`. The sheet keeps saying
 * whatever it says; an override sits on top and wins at resolution time. That
 * separation is what lets a re-import refresh the roster without silently
 * undoing an administrator's fix, and lets the screen show both values and the
 * drift between them.
 *
 * Admin only, and `requireRole` runs in each action rather than relying on the
 * layout: a Server Action is a POST endpoint reachable without rendering the page
 * that guards it, and this changes who approves other people's work.
 */

const SM_CODE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

const code = (label: string) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => SM_CODE.test(v), { message: `${label} is not a valid code.` });

function refresh() {
  revalidatePath('/admin/hierarchy');
  revalidatePath('/admin/users');
  revalidatePath('/tl/team');
  revalidatePath('/acm/team');
}

/** The CCM a TL currently sits under, by the effective hierarchy. */
async function ccmOfTl(tlId: string): Promise<string | null> {
  const [row] = await db
    .select({ ccmId: sql<string | null>`coalesce(${manpowerOverride.ccmId}, ${manpower.ccmId})` })
    .from(manpower)
    .leftJoin(manpowerOverride, eq(manpowerOverride.smId, manpower.smId))
    .where(sql`coalesce(${manpowerOverride.tlId}, ${manpower.tlId}) = ${tlId}`)
    .limit(1);

  return row?.ccmId ?? null;
}

/* ------------------------------------------------------ move one rep */

const moveSmSchema = z.object({
  smId: code('SM_ID'),
  tlId: code('TL code'),
});

/**
 * Moves one rep under a different team leader.
 *
 * The rep's ACM moves with them, and is NOT asked for. A team leader belongs to
 * exactly one cluster head — verified across the whole July roster, where all 27
 * TLs sit under a single CCM each — so the ACM follows from the TL, and letting
 * an admin pick the two independently would allow a rep placed under a TL whose
 * own ACM is somebody else. That combination has no meaning in the source data
 * and would route the two mapping approvals to people who do not work together.
 */
export async function moveRepToTeamAction(
  raw: z.infer<typeof moveSmSchema>,
): Promise<ActionResult<{ smId: string; tlId: string; acmId: string | null }>> {
  const actor = await requireRole('admin');

  const parsed = moveSmSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'That move is not valid.');

  const { smId, tlId } = parsed.data;

  const [rep] = await db.select().from(manpower).where(eq(manpower.smId, smId)).limit(1);
  if (!rep) return fail(`${smId} is not on the roster, so there is nothing to move.`);

  const acmId = await ccmOfTl(tlId);
  if (!acmId) {
    return fail(
      `${tlId} does not appear on the roster as anybody's team leader, so there is no area manager to place ${smId} under.`,
    );
  }

  const [before] = await db
    .select()
    .from(manpowerOverride)
    .where(eq(manpowerOverride.smId, smId))
    .limit(1);

  await db.transaction(async (tx) => {
    await tx
      .insert(manpowerOverride)
      .values({ smId, tlId, ccmId: acmId, overriddenBy: actor.id, overriddenAt: new Date() })
      .onConflictDoUpdate({
        target: manpowerOverride.smId,
        set: { tlId, ccmId: acmId, overriddenBy: actor.id, overriddenAt: new Date() },
      });

    await writeAudit(
      {
        actor,
        action: 'HIERARCHY_REASSIGN',
        entityType: 'manpower_override',
        entityId: smId,
        before: before
          ? { tlId: before.tlId, ccmId: before.ccmId }
          : { tlId: rep.tlId, ccmId: rep.ccmId, source: 'sheet' },
        after: { tlId, ccmId: acmId },
        metadata: { smId, sheetTlId: rep.tlId, sheetCcmId: rep.ccmId },
      },
      tx,
    );
  });

  refresh();
  return ok({ smId, tlId, acmId });
}

/* --------------------------------------------- move a whole team */

const moveTlSchema = z.object({
  tlId: code('TL code'),
  acmId: code('ACM code'),
});

/**
 * Moves a team leader under a different area manager — and their whole team
 * with them.
 *
 * This is the operation the business actually described: a TL does not move
 * alone, because every rep beneath them reports upward through them. The roster
 * has no row for a TL on their own — a TL exists only as the `TL_ID` on their
 * reps' rows — so "the TL moved" is expressed as an override on each of those
 * reps, which is exactly what the resolver reads.
 *
 * The reps keep their team leader and change only their area manager. Anything
 * else would be a different operation wearing this one's name.
 */
export async function moveTeamToManagerAction(
  raw: z.infer<typeof moveTlSchema>,
): Promise<ActionResult<{ tlId: string; acmId: string; moved: number }>> {
  const actor = await requireRole('admin');

  const parsed = moveTlSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'That move is not valid.');

  const { tlId, acmId } = parsed.data;

  // Every rep whose EFFECTIVE team leader is this one — including reps an earlier
  // override moved into the team, who would otherwise be left behind.
  const members = await db
    .select({
      smId: manpower.smId,
      sheetTlId: manpower.tlId,
      sheetCcmId: manpower.ccmId,
      effectiveTlId: sql<string | null>`coalesce(${manpowerOverride.tlId}, ${manpower.tlId})`,
    })
    .from(manpower)
    .leftJoin(manpowerOverride, eq(manpowerOverride.smId, manpower.smId))
    .where(sql`coalesce(${manpowerOverride.tlId}, ${manpower.tlId}) = ${tlId}`);

  if (members.length === 0) {
    return fail(`No reps currently report to ${tlId}, so there is no team to move.`);
  }

  await db.transaction(async (tx) => {
    for (const member of members) {
      await tx
        .insert(manpowerOverride)
        .values({
          smId: member.smId,
          tlId,
          ccmId: acmId,
          overriddenBy: actor.id,
          overriddenAt: new Date(),
        })
        .onConflictDoUpdate({
          target: manpowerOverride.smId,
          set: { tlId, ccmId: acmId, overriddenBy: actor.id, overriddenAt: new Date() },
        });
    }

    // One audit row for the whole move, not one per rep. The act was "this team
    // changed hands"; a hundred rows saying the same thing at the same second
    // would bury it.
    await writeAudit(
      {
        actor,
        action: 'HIERARCHY_REASSIGN',
        entityType: 'manpower_override',
        entityId: tlId,
        before: { acmId: await ccmOfTl(tlId) },
        after: { acmId },
        metadata: {
          scope: 'team',
          tlId,
          movedReps: members.length,
          smIds: members.map((m) => m.smId),
        },
      },
      tx,
    );
  });

  refresh();
  return ok({ tlId, acmId, moved: members.length });
}

/* ---------------------------------------------------- release back */

const clearSchema = z.object({ smId: code('SM_ID') });

/**
 * Drops an override so the rep goes back to whatever the sheet says.
 *
 * Deleting the row rather than nulling its columns: an override that overrides
 * nothing still shadows the sheet in every drift comparison, and the CHECK
 * constraint refuses a row with both sides empty anyway.
 */
export async function clearRepOverrideAction(
  raw: z.infer<typeof clearSchema>,
): Promise<ActionResult<{ smId: string }>> {
  const actor = await requireRole('admin');

  const parsed = clearSchema.safeParse(raw);
  if (!parsed.success) return fail('That code is not valid.');

  const { smId } = parsed.data;

  const [before] = await db
    .select()
    .from(manpowerOverride)
    .where(eq(manpowerOverride.smId, smId))
    .limit(1);

  if (!before) return fail(`${smId} has no override to clear — it already follows the sheet.`);

  const [sheet] = await db.select().from(manpower).where(eq(manpower.smId, smId)).limit(1);

  await db.transaction(async (tx) => {
    await tx.delete(manpowerOverride).where(eq(manpowerOverride.smId, smId));
    await writeAudit(
      {
        actor,
        action: 'HIERARCHY_OVERRIDE_REVERT',
        entityType: 'manpower_override',
        entityId: smId,
        before: { tlId: before.tlId, ccmId: before.ccmId },
        after: { tlId: sheet?.tlId ?? null, ccmId: sheet?.ccmId ?? null, source: 'sheet' },
        metadata: { smId },
      },
      tx,
    );
  });

  refresh();
  return ok({ smId });
}

/*
 * The two reads that used to live here — `loadHierarchyTree` and
 * `loadUnplacedReps` — now live in ./queries.ts, and the move IS the fix.
 *
 * `'use server'` at the top of this file makes EVERY export a POST-invokable
 * endpoint with a stable action id. Every mutation here opens with
 * `requireRole('admin')`; those two reads opened with nothing, so the entire
 * company org chart — every rep, team leader and area manager, with names,
 * locations and reporting lines — sat in the public action namespace behind no
 * check at all. Adding a role guard would have closed it; taking them out of the
 * namespace means there is no endpoint to guard. A read that only a server
 * component calls has no business being an action.
 */
